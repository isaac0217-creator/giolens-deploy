/**
 * GioLens — Agente Desarrollador · graph.js
 * Rol: Orquesta los 3 flujos del Desarrollador (analyze_qa_failure / generate_fix /
 *      create_pull_request). JS plano por ahora; cuando LangGraph esté
 *      instalado migra a StateGraph.
 *
 * Flujos:
 *   - analyzeQAFailure({ qaIssue })
 *   - generateFix({ filePath, currentContent, diagnosis, rootCause })
 *   - createPullRequestStub({ branchName, baseBranch, fixPayload, qaIssueRef })
 *
 * Cada flujo:
 *   1. callClaude (modelo Opus 4.5 — diferencia entre código limpio y código roto).
 *   2. Parsea JSON estricto.
 *   3. Publica draft al bus vía saveDraft* (status='draft' / 'open').
 *   4. Solicita aprobación humana (requestApproval) — stub auto-aprueba Fase 1.
 *   5. Trackea costo (track).
 *
 * RESTRICCIONES DURAS (no romper):
 *   - NO escribe a disco. NO hace git push. NO crea PR real en GitHub.
 *   - PRs son STUB con pr_url='stub://...' hasta Fase 4+.
 *   - Si toca SENSITIVE_PATHS → requires_human=true (override del modelo).
 *
 * TODO Fase 2: migrar a LangGraph StateGraph.
 * TODO Fase 2: cuando exista Inngest, envolver cada flujo en inngest.createFunction.
 * TODO Fase 4: createPullRequestReal con GitHub API + branch protection.
 * TODO: persistir runs en Supabase (agent_runs).
 */

import { callClaude } from '../_shared/anthropic.js';
import { publish } from '../_shared/bus.js';
import { track } from '../_shared/cost-tracker.js';
import { requestApproval } from '../_shared/approval.js';
import { SYSTEM_PROMPT } from './prompt.js';
import {
  LLM_INVOCABLE_TOOLS,
  saveDraftFix,
  saveDraftPR,
  isSensitivePath,
  drainProposedPatches,
} from './tools.js';

const MODEL = 'claude-opus-4-5'; // §15: Opus 4.5 — diferencia entre código limpio y código que se rompe
const AGENT = 'desarrollador';

const VALID_ROOT_CAUSES = new Set([
  'regex_mismatch',
  'off_by_one',
  'null_dereference',
  'schema_mismatch',
  'timezone',
  'race_condition',
  'api_contract',
  'env_missing',
  'other',
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parsea JSON tolerante a wrappers de texto. Igual patrón que creativo/optimizacion.
 */
function parseModelJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  try {
    return JSON.parse(rawText);
  } catch (_) { /* sigue */ }
  const match = rawText.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) { /* sigue */ }
  }
  return null;
}

/**
 * Extrae text block de una respuesta de callClaude (soporta ambos shapes).
 */
function extractText(response) {
  if (!response) return '';
  if (typeof response.text === 'string') return response.text;
  if (Array.isArray(response.content)) {
    const t = response.content.find((b) => b.type === 'text');
    if (t?.text) return t.text;
  }
  return '';
}

/**
 * Calcula costo en USD para Opus 4.5 (fallback heurístico si la respuesta no lo trae).
 * Opus 4.5: $15/MTok input, $75/MTok output (precio público al 2026-05).
 */
function calcUsd(response) {
  if (typeof response?.cost_usd === 'number') return response.cost_usd;
  if (typeof response?.usd === 'number') return response.usd;
  const usage = response?.usage;
  if (!usage) return 0;
  return (Number(usage.input_tokens || 0) * 15 + Number(usage.output_tokens || 0) * 75) / 1_000_000;
}

/**
 * Calcula si una lista de archivos toca zonas sensibles.
 */
function anySensitive(files) {
  if (!Array.isArray(files)) return false;
  return files.some((f) => isSensitivePath(f));
}

// ─── Flujo (1): analyze_qa_failure ──────────────────────────────────────────
/**
 * Recibe un issue estructurado del agente QA y emite diagnóstico + sugerencias.
 *
 * @param {object} args
 * @param {object} args.qaIssue  - { test_name, expected, actual, error_trace, severity }
 * @returns {Promise<{diagnosis: object|null, cost_usd:number, latency_ms:number, error:string|null, proposed_patches_count:number}>}
 */
export async function analyzeQAFailure({ qaIssue } = {}) {
  const t0 = Date.now();
  if (!qaIssue || typeof qaIssue !== 'object') {
    throw new Error('analyzeQAFailure: qaIssue requerido (objeto)');
  }
  if (!qaIssue.test_name) {
    throw new Error('analyzeQAFailure: qaIssue.test_name requerido');
  }

  // Limpia el buffer de patches antes de invocar al modelo
  drainProposedPatches();

  const userMessage = [
    `Task: analyze_qa_failure`,
    `QA issue:`,
    JSON.stringify(qaIssue, null, 2),
    '',
    'Emite el JSON estricto según el formato del system prompt (task="analyze_qa_failure").',
    'Si tu confianza < 0.6 o tocarías rutas sensibles → requires_human=true.',
  ].join('\n');

  const response = await callClaude({
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    tools: LLM_INVOCABLE_TOOLS,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 2048,
  });

  const parsed = parseModelJson(extractText(response));
  let diagnosis = null;
  let error = null;

  if (
    parsed &&
    parsed.task === 'analyze_qa_failure' &&
    typeof parsed.diagnosis === 'string' &&
    typeof parsed.root_cause === 'string' &&
    Array.isArray(parsed.suggested_files) &&
    Array.isArray(parsed.suggested_patches)
  ) {
    // Normaliza
    parsed.confidence = Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0.5;
    if (!VALID_ROOT_CAUSES.has(parsed.root_cause)) {
      parsed.root_cause = 'other';
    }
    // Override defensivo: si toca sensibles o confianza baja o severity crítica → human
    const sensitiveTouch = anySensitive(parsed.suggested_files);
    const severityCritical = qaIssue.severity === 'critical';
    parsed.requires_human = Boolean(
      parsed.requires_human || sensitiveTouch || severityCritical || parsed.confidence < 0.6,
    );

    // Publica el diagnóstico al bus como evento (informativo, no draft mutable).
    publish({
      from_agent: AGENT,
      to_agent:   'qa', // QA es el principal interesado, pero todo el bus lo ve
      type:       'qa_failure_diagnosis',
      payload:    parsed,
      requires_ack: parsed.requires_human,
      context_refs: [`test:${qaIssue.test_name}`, ...parsed.suggested_files.map((f) => `file:${f}`)],
    });

    diagnosis = parsed;
  } else {
    error = 'parse_failed_or_invalid_shape';
  }

  const cost_usd = calcUsd(response);
  track(AGENT, response?.usage || null, MODEL);

  // Drena los patches que el LLM pudo haber dejado vía propose_patch durante el razonamiento.
  const proposedPatches = drainProposedPatches();

  return {
    diagnosis,
    cost_usd,
    latency_ms: Date.now() - t0,
    error,
    proposed_patches_count: proposedPatches.length,
  };
}

// ─── Flujo (2): generate_fix ────────────────────────────────────────────────
/**
 * Recibe un archivo + diagnóstico y emite un patch atómico como draft.
 *
 * @param {object} args
 * @param {string} args.filePath
 * @param {string} [args.currentContent='']  - contenido del archivo afectado
 * @param {string} args.diagnosis
 * @param {string} args.rootCause
 * @returns {Promise<{draft:object|null, approval:object, cost_usd:number, latency_ms:number, error:string|null}>}
 */
export async function generateFix({ filePath, currentContent = '', diagnosis, rootCause } = {}) {
  const t0 = Date.now();
  if (!filePath) throw new Error('generateFix: filePath requerido');
  if (!diagnosis) throw new Error('generateFix: diagnosis requerido');
  if (!rootCause) throw new Error('generateFix: rootCause requerido');

  drainProposedPatches();

  const userMessage = [
    `Task: generate_fix`,
    `file_path: ${filePath}`,
    `root_cause: ${rootCause}`,
    `diagnosis: ${diagnosis}`,
    '',
    `current_content (primeros 4000 chars):`,
    String(currentContent || '').slice(0, 4000),
    '',
    'Emite el JSON estricto (task="generate_fix") con un único patch atómico.',
    'status SIEMPRE "draft", requires_approval SIEMPRE true.',
  ].join('\n');

  const response = await callClaude({
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    tools: LLM_INVOCABLE_TOOLS,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 2048,
  });

  const parsed = parseModelJson(extractText(response));
  let draft = null;
  let error = null;

  if (
    parsed &&
    parsed.task === 'generate_fix' &&
    parsed.patch &&
    typeof parsed.patch.old === 'string' &&
    typeof parsed.patch.new === 'string' &&
    Array.isArray(parsed.tests_to_add)
  ) {
    // Enforce defaults / overrides
    parsed.file_path = String(parsed.file_path || filePath);
    parsed.status = 'draft';
    parsed.requires_approval = true;
    parsed.sensitive = isSensitivePath(parsed.file_path);

    saveDraftFix(parsed);
    draft = parsed;
  } else {
    error = 'parse_failed_or_invalid_shape';
  }

  const cost_usd = calcUsd(response);
  track(AGENT, response?.usage || null, MODEL);

  // Aprobación humana (stub auto-aprueba Fase 1, pero rutas sensibles igual marcan)
  const approval = draft
    ? await requestApproval({
        decision_id: `desarrollador-fix-${filePath.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}`,
        agent: AGENT,
        action: 'apply_code_patch',
        rationale: `Fix para ${filePath} — root_cause: ${rootCause}`,
        evidence: {
          diagnosis,
          patch_old_preview: draft.patch.old.slice(0, 160),
          patch_new_preview: draft.patch.new.slice(0, 160),
          tests_added: draft.tests_to_add.length,
          sensitive: draft.sensitive,
        },
      })
    : { approved: false, by: 'system', at: new Date().toISOString(), note: 'draft inválido, sin aprobación' };

  return { draft, approval, cost_usd, latency_ms: Date.now() - t0, error };
}

// ─── Flujo (3): create_pull_request (STUB) ──────────────────────────────────
/**
 * Empaca un fix payload en un PR-like stub. NO crea PR real en GitHub.
 *
 * @param {object} args
 * @param {string} args.branchName    - ej. 'fix/regex-cpr-26may'
 * @param {string} [args.baseBranch='main']
 * @param {object} args.fixPayload    - output de generateFix
 * @param {string} [args.qaIssueRef]  - test_name o decision_id del issue QA original
 * @returns {Promise<{draft:object|null, approval:object, cost_usd:number, latency_ms:number, error:string|null}>}
 */
export async function createPullRequestStub({
  branchName,
  baseBranch = 'main',
  fixPayload,
  qaIssueRef,
} = {}) {
  const t0 = Date.now();
  if (!branchName) throw new Error('createPullRequestStub: branchName requerido');
  if (!fixPayload || typeof fixPayload !== 'object') {
    throw new Error('createPullRequestStub: fixPayload requerido (objeto)');
  }

  drainProposedPatches();

  const userMessage = [
    `Task: create_pull_request`,
    `branch_name: ${branchName}`,
    `base_branch: ${baseBranch}`,
    `qa_issue_ref: ${qaIssueRef || 'none'}`,
    '',
    `fix_payload:`,
    JSON.stringify(fixPayload, null, 2),
    '',
    'Emite el JSON estricto (task="create_pull_request"). pr_url DEBE empezar con "stub://".',
    'title ≤72 chars. body_markdown con 6 secciones (Resumen, Causa raíz, Cambios, Cómo probar, Rollback, Riesgo).',
  ].join('\n');

  const response = await callClaude({
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    tools: LLM_INVOCABLE_TOOLS,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 2048,
  });

  const parsed = parseModelJson(extractText(response));
  let draft = null;
  let error = null;

  if (
    parsed &&
    parsed.task === 'create_pull_request' &&
    typeof parsed.title === 'string' &&
    typeof parsed.body_markdown === 'string' &&
    Array.isArray(parsed.files_changed)
  ) {
    // Enforce defaults / overrides
    if (!parsed.pr_url || !String(parsed.pr_url).startsWith('stub://')) {
      parsed.pr_url = `stub://giocore/pulls/draft-${Date.now()}`;
    }
    parsed.status = parsed.status || 'open';
    parsed.reviewers = Array.isArray(parsed.reviewers) && parsed.reviewers.length > 0
      ? parsed.reviewers
      : ['isaac'];
    parsed.base_branch = baseBranch;
    parsed.branch_name = branchName;
    parsed.qa_issue_ref = qaIssueRef || null;
    parsed.sensitive = anySensitive(parsed.files_changed);

    // Recortar título si excedió 72 chars (defensa de la regla)
    if (parsed.title.length > 72) {
      parsed.title = parsed.title.slice(0, 69) + '...';
    }

    saveDraftPR(parsed);
    draft = parsed;
  } else {
    error = 'parse_failed_or_invalid_shape';
  }

  const cost_usd = calcUsd(response);
  track(AGENT, response?.usage || null, MODEL);

  const approval = draft
    ? await requestApproval({
        decision_id: `desarrollador-pr-${branchName.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}`,
        agent: AGENT,
        action: 'create_pull_request_stub',
        rationale: `PR stub para ${branchName} → ${baseBranch}`,
        evidence: {
          files_changed: draft.files_changed,
          sensitive: draft.sensitive,
          qa_issue_ref: qaIssueRef || null,
        },
      })
    : { approved: false, by: 'system', at: new Date().toISOString(), note: 'draft inválido' };

  return { draft, approval, cost_usd, latency_ms: Date.now() - t0, error };
}

// ─── Re-export por conveniencia ─────────────────────────────────────────────
export { publish }; // exportado solo para tests/observabilidad
export const __test__ = { parseModelJson, extractText, calcUsd, anySensitive };
