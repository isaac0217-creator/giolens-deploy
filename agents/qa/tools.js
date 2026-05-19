/**
 * GioLens — Agente QA · tools.js
 * Rol: Tools permitidas al QA. TODAS son read-only o sandbox.
 *
 * Reglas inamovibles:
 *   - Cero acceso a APIs de producción (Meta, Wapify reales).
 *   - sandbox_call SIEMPRE inyecta dry_run=true en payload.
 *   - publish_report SOLO emite al bus en memoria — nunca escribe BD.
 *
 * Definiciones (TOOL_DEFINITIONS) se pasan a Anthropic como `tools`.
 * Implementaciones (TOOL_HANDLERS) las invoca graph.js al resolver tool_use.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { publish } from '../_shared/bus.js';
import { runEval, loadGolden } from '../../evals/harness.js';
import { getMotorAdapter } from '../../evals/runners/motor-runner.js';
import { getAnalistaAdapter } from '../../evals/runners/agente-runner.js';
import { readSnapshot } from './runners/regression.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GOLDEN_DIR = path.resolve(__dirname, '..', '..', 'evals', 'golden');

// ─── Definiciones (schema Anthropic Tool Use) ─────────────────────────────
export const TOOL_DEFINITIONS = [
  {
    name: 'load_eval_suite',
    description:
      'Carga un golden suite desde /evals/golden/. Devuelve el JSON parseado con { motor, cases[] }. Solo lectura.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            "Nombre del golden sin extensión. Ej: 'motor-justin-holbrook', 'agente-analista'.",
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'run_eval',
    description:
      'Ejecuta los casos de un golden suite contra el adapter correspondiente (motor o agente) usando harness.js. Determinista en modo mock. Devuelve { motor, total, passed, failed, details[] }.',
    input_schema: {
      type: 'object',
      properties: {
        motor: {
          type: 'string',
          description:
            "Identificador del motor o agente. Motores: 'justin-holbrook', 'giosports', 'spy-z87', 'dama-luxury', 'giovision' o IDs de pipeline. Agentes: 'analista'.",
        },
        suite: {
          type: 'string',
          description:
            "Opcional. Nombre del golden si difiere del motor (ej. 'agente-analista').",
        },
      },
      required: ['motor'],
    },
  },
  {
    name: 'sandbox_call',
    description:
      'Ejecuta una llamada a API en modo dry-run. Nunca golpea producción. Útil para validar payloads antes de promoción. Inyecta { dry_run: true } al payload.',
    input_schema: {
      type: 'object',
      properties: {
        api: {
          type: 'string',
          description:
            "Identificador de la API a simular. Ej: 'meta_ads', 'wapify', 'webhook'.",
        },
        payload: {
          type: 'object',
          description: 'Payload original que se enviaría en producción.',
        },
      },
      required: ['api', 'payload'],
    },
  },
  {
    name: 'read_snapshot',
    description:
      'Lee un snapshot previo de regression para un motor + caseId. Si no existe devuelve null (primer run).',
    input_schema: {
      type: 'object',
      properties: {
        motor: { type: 'string' },
        case_id: { type: 'string' },
      },
      required: ['motor', 'case_id'],
    },
  },
  {
    name: 'publish_report',
    description:
      'Publica el reporte QA al bus interno (type=qa_report). NO escribe BD ni envía a humanos directamente.',
    input_schema: {
      type: 'object',
      properties: {
        report: {
          type: 'object',
          description: 'Objeto { findings, summary, cost_usd?, latency_ms? }.',
        },
      },
      required: ['report'],
    },
  },
];

// ─── Implementaciones ─────────────────────────────────────────────────────

/**
 * Resuelve el adapter (motor o agente) para un identificador.
 * Acepta IDs de pipeline, slugs de motor o nombres de agente.
 */
function resolveAdapter(motor) {
  // Agentes Fase 3
  if (motor === 'analista' || motor === 'agente-analista') {
    return getAnalistaAdapter();
  }
  // Motores (slug o pipeline_id)
  return getMotorAdapter(motor);
}

/**
 * load_eval_suite — lee /evals/golden/{name}.json.
 */
export async function load_eval_suite({ name }) {
  if (!name || typeof name !== 'string') {
    throw new Error('load_eval_suite: name requerido');
  }
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  if (!existsSync(file)) {
    throw new Error(`Golden no encontrado: ${name}.json`);
  }
  return loadGolden(file);
}

/**
 * run_eval — corre los casos del golden contra el adapter.
 * Devuelve resultado normalizado del harness.
 */
export async function run_eval({ motor, suite }) {
  if (!motor) throw new Error('run_eval: motor requerido');

  const suiteName = suite || _defaultSuiteName(motor);
  const golden = await load_eval_suite({ name: suiteName });
  const adapter = resolveAdapter(motor);
  return runEval(adapter, golden);
}

/**
 * sandbox_call — inyecta dry_run=true y NUNCA toca red.
 * Devuelve un "preview" del payload que se enviaría.
 *
 * TODO Fase 2: cuando exista un sandbox real (réplicas locales de Meta/Wapify
 * con fixtures), enchufar aquí. Por ahora solo retorna el payload anotado.
 */
export async function sandbox_call({ api, payload }) {
  if (!api) throw new Error('sandbox_call: api requerido');
  const safePayload = { ...(payload || {}), dry_run: true };
  return {
    api,
    mode: 'dry_run',
    payload: safePayload,
    note: 'sandbox_call no ejecutó tráfico real — preview only',
    ts: new Date().toISOString(),
  };
}

/**
 * read_snapshot — delega al runner de regression.
 */
export async function read_snapshot({ motor, case_id }) {
  return readSnapshot(motor, case_id);
}

/**
 * publish_report — emite al bus, NO escribe BD.
 */
export async function publish_report({ report }) {
  if (!report || typeof report !== 'object') {
    throw new Error('publish_report: report requerido');
  }
  await publish({
    type: 'qa_report',
    from_agent: 'qa',
    to_agent: 'orquestador',
    payload: { report },
  });
  return { published: true };
}

// ─── Mapa nombre → handler (graph.js lo usa al resolver tool_use) ─────────
export const TOOL_HANDLERS = {
  load_eval_suite,
  run_eval,
  sandbox_call,
  read_snapshot,
  publish_report,
};

// ─── Helpers ──────────────────────────────────────────────────────────────
function _defaultSuiteName(motor) {
  // Mapa de IDs de pipeline a nombres de golden de motor.
  const MAP = {
    '216977': 'motor-justin-holbrook',
    '755062': 'motor-giosports',
    '252999': 'motor-spy-z87',
    '94103': 'motor-dama-luxury',
    '273944': 'motor-giovision',
    'justin-holbrook': 'motor-justin-holbrook',
    giosports: 'motor-giosports',
    'spy-z87': 'motor-spy-z87',
    'dama-luxury': 'motor-dama-luxury',
    giovision: 'motor-giovision',
    analista: 'agente-analista',
    'agente-analista': 'agente-analista',
  };
  return MAP[motor] || `motor-${motor}`;
}

export default TOOL_DEFINITIONS;
