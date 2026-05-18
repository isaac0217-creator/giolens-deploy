/**
 * GioLens — Agente Desarrollador · tools.js
 * Rol: Declara tools (formato Anthropic Tool Use) que el Desarrollador puede
 *      invocar + handlers JS que graph.js usa para publicar drafts al bus.
 *
 * Política de drafts (§15 v12 GIOCORE):
 *   - Todo save_draft_* publica al bus con status='draft' y requires_approval=true.
 *   - Nada se escribe a disco. Nada se sube a GitHub. Nada se mergea a main.
 *   - El PR es STUB (pr_url: 'stub://...') hasta Fase 4+.
 *
 * Tools expuestas al LLM (subset de TOOL_DEFINITIONS):
 *   - read_repo_file: solo lectura.
 *   - propose_patch:  registra patch en draft (NO escribe a disco).
 *
 * Tools internas (NO expuestas al modelo):
 *   - saveDraftFix, saveDraftPR: las invoca graph.js tras parsear JSON.
 *
 * TODO Fase 2: read_repo_file lee de disco local; cuando exista Supabase
 *              `repo_snapshots`, leer snapshot inmutable de la rama base.
 * TODO Fase 4: propose_patch + create_pull_request_real → integración GitHub API
 *              con token de bot y branch protegida (main no aceptable).
 */

import { readFileSync } from 'node:fs';
import { resolve, normalize, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish } from '../_shared/bus.js';

const AGENT_NAME = 'desarrollador';

// Raíz del repo: 2 niveles arriba de /agents/desarrollador/tools.js
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__filename, '..', '..', '..');

// Buffer in-memory de patches propuestos por el LLM (sólo para inspección/test).
// graph.js lo limpia al inicio de cada flujo.
const _draftPatchBuffer = [];

// Rutas sensibles donde requires_human SIEMPRE debe ser true.
export const SENSITIVE_PATHS = [
  'agents/_shared/',
  'api/webhook.js',
  '.env',
  'package.json',
  'vercel.json',
];

/**
 * Verifica si una ruta toca zonas sensibles del repo.
 * @param {string} path  - ruta relativa al repo
 * @returns {boolean}
 */
export function isSensitivePath(path) {
  if (!path || typeof path !== 'string') return false;
  const norm = path.replace(/^[./\\]+/, '');
  return SENSITIVE_PATHS.some((p) => norm.startsWith(p) || norm.includes(`/${p}`));
}

// ─── Tool: read_repo_file ───────────────────────────────────────────────────
/**
 * Lee un archivo del repo (solo lectura). Acepta path relativo al root.
 * Falla si el path escapa del repo (defense in depth contra path traversal).
 *
 * @param {object} args
 * @param {string} args.path  - ruta relativa al root (ej. 'agents/analista/graph.js')
 * @returns {Promise<{path:string, content:string|null, error:string|null, sensitive:boolean}>}
 */
export async function readRepoFile({ path } = {}) {
  if (!path || typeof path !== 'string') {
    return { path: String(path || ''), content: null, error: 'path required', sensitive: false };
  }

  // Resolver y validar que cae dentro del repo
  const abs = isAbsolute(path) ? normalize(path) : normalize(resolve(REPO_ROOT, path));
  const rootWithSep = REPO_ROOT.endsWith(sep) ? REPO_ROOT : REPO_ROOT + sep;
  if (!abs.startsWith(rootWithSep) && abs !== REPO_ROOT) {
    return { path, content: null, error: 'path escapes repo root', sensitive: false };
  }

  try {
    const content = readFileSync(abs, 'utf8');
    return {
      path,
      content,
      error: null,
      sensitive: isSensitivePath(path),
    };
  } catch (err) {
    return { path, content: null, error: err.message, sensitive: isSensitivePath(path) };
  }
}

// ─── Tool: propose_patch ────────────────────────────────────────────────────
/**
 * Registra un patch propuesto en el buffer in-memory. NO escribe a disco.
 *
 * @param {object} args
 * @param {string} args.file
 * @param {string} args.old
 * @param {string} args.new
 * @returns {Promise<{ok:boolean, file:string, sensitive:boolean, error?:string}>}
 */
export async function proposePatch({ file, old: oldText, new: newText } = {}) {
  if (!file || typeof file !== 'string') {
    return { ok: false, file: String(file || ''), sensitive: false, error: 'file required' };
  }
  if (typeof oldText !== 'string' || typeof newText !== 'string') {
    return { ok: false, file, sensitive: isSensitivePath(file), error: 'old and new must be strings' };
  }
  _draftPatchBuffer.push({ file, old: oldText, new: newText, at: new Date().toISOString() });
  return { ok: true, file, sensitive: isSensitivePath(file) };
}

/**
 * Devuelve los patches en buffer y los limpia. Para uso de graph.js / tests.
 */
export function drainProposedPatches() {
  const out = _draftPatchBuffer.slice();
  _draftPatchBuffer.length = 0;
  return out;
}

// ─── save_draft_fix ─────────────────────────────────────────────────────────
/**
 * Persiste el fix payload como draft en el bus. Toda mutación de código
 * queda con status='draft' y requires_approval=true.
 *
 * @param {object} payload  - JSON validado del modelo (task='generate_fix')
 * @returns {object} mensaje publicado
 */
export function saveDraftFix(payload) {
  if (!payload || payload.task !== 'generate_fix') {
    throw new Error('[saveDraftFix] payload.task must be "generate_fix"');
  }
  if (!payload.file_path) {
    throw new Error('[saveDraftFix] payload.file_path required');
  }
  const enforced = { ...payload, status: 'draft', requires_approval: true };
  return publish({
    from_agent: AGENT_NAME,
    to_agent:   '*',
    type:       'draft.fix',
    payload:    enforced,
    requires_ack: true,
    context_refs: [`file:${payload.file_path}`],
  });
}

// ─── save_draft_pr ──────────────────────────────────────────────────────────
/**
 * Persiste el PR stub como draft en el bus. NO crea PR real en GitHub.
 *
 * @param {object} payload  - JSON validado del modelo (task='create_pull_request')
 * @returns {object} mensaje publicado
 */
export function saveDraftPR(payload) {
  if (!payload || payload.task !== 'create_pull_request') {
    throw new Error('[saveDraftPR] payload.task must be "create_pull_request"');
  }
  if (!payload.pr_url || !payload.pr_url.startsWith('stub://')) {
    throw new Error('[saveDraftPR] payload.pr_url must start with "stub://" (Fase 1)');
  }
  const enforced = { ...payload, status: payload.status || 'open' };
  return publish({
    from_agent: AGENT_NAME,
    to_agent:   '*',
    type:       'draft.pull_request',
    payload:    enforced,
    requires_ack: true,
    context_refs: [payload.pr_url, ...(Array.isArray(payload.files_changed) ? payload.files_changed.map((f) => `file:${f}`) : [])],
  });
}

// ─── Definiciones Anthropic Tool Use ────────────────────────────────────────
export const TOOL_DEFINITIONS = [
  {
    name: 'read_repo_file',
    description:
      'Lee el contenido de un archivo del repo GioLens. Solo lectura. Usar cuando el contexto recibido no es suficiente y necesitas inspeccionar el código actual antes de proponer un parche.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Ruta relativa al root del repo. Ej: "agents/analista/graph.js", "api/webhook.js". No usar rutas absolutas ni "..".',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'propose_patch',
    description:
      'Registra un parche propuesto (old → new) en el buffer de borrador. NO escribe a disco, NO mergea. Se usa para dejar evidencia antes de emitir el JSON final del task.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Ruta relativa al root del repo.' },
        old:  { type: 'string', description: 'Fragmento exacto a buscar y reemplazar.' },
        new:  { type: 'string', description: 'Fragmento de reemplazo.' },
      },
      required: ['file', 'old', 'new'],
    },
  },
  // Las siguientes se declaran para que el modelo conozca su existencia, pero
  // el system prompt prohíbe llamarlas. La invocación real va por graph.js.
  {
    name: 'save_draft_fix',
    description:
      'EMITE draft.fix al bus. NO invocar desde el modelo — graph.js lo hace tras parsear tu JSON de task=generate_fix.',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
      },
      required: ['task'],
    },
  },
  {
    name: 'save_draft_pr',
    description:
      'EMITE draft.pull_request al bus. NO invocar desde el modelo — graph.js lo hace tras parsear tu JSON de task=create_pull_request.',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
      },
      required: ['task'],
    },
  },
];

// Mapa nombre → implementación para resolver tool_use del modelo.
export const TOOL_HANDLERS = {
  read_repo_file: readRepoFile,
  propose_patch:  proposePatch,
  // save_draft_* NO se exponen al modelo — los invoca graph.js.
};

// Tools que el LLM puede invocar (subset de TOOL_DEFINITIONS):
// solo read-only + propose_*. save_draft_* quedan fuera del whitelist.
export const LLM_INVOCABLE_TOOLS = TOOL_DEFINITIONS.filter((t) =>
  ['read_repo_file', 'propose_patch'].includes(t.name),
);

export default TOOL_DEFINITIONS;
