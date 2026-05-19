/**
 * GioLens — Agente Optimizacion · tools.js
 * Rol: Declara las tools (formato Anthropic Tool Use) que el Optimizacion
 *      puede invocar. Mezcla lectura (read_*) + mutacion controlada (propose_*,
 *      apply_*, pause_*). Toda mutacion pasa por approval + rollback registry.
 *
 * IMPORTANTE: las tools apply_budget_change y pause_adset son STUBS — solo
 * deben invocarse desde executeApprovedProposal (graph.js), nunca por el modelo
 * directamente. Se declaran aqui para que el modelo conozca su existencia y
 * pueda razonar sobre ellas, pero el system prompt prohibe invocarlas.
 */

import readKpis from '../_shared/tools/read-kpis.js';
import readPipeline from '../_shared/tools/read-pipeline.js';
import proposeBudgetChange from '../_shared/tools/propose-budget-change.js';
import { publish } from '../_shared/bus.js';
import { requestApproval } from '../_shared/approval.js';
import { registerRollback } from '../_shared/rollback.js';

// ────────────────────────────────────────────────────────────────────────────
// Tool definitions (Anthropic Tool Use schema)
// ────────────────────────────────────────────────────────────────────────────
export const TOOL_DEFINITIONS = [
  {
    name: 'read_kpis',
    description:
      'Lee snapshots de Meta Ads para un pipeline en un periodo dado. Solo lectura. Usar antes de proponer cambios.',
    input_schema: {
      type: 'object',
      properties: {
        pipeline_id: {
          type: 'string',
          description: 'ID del pipeline GioLens. Uno de: 216977, 755062, 252999, 94103, 273944.',
        },
        period: {
          type: 'string',
          description: "Periodo a leer. Ej: 'last_24h', 'last_7d', 'last_30d'.",
        },
      },
      required: ['pipeline_id', 'period'],
    },
  },
  {
    name: 'read_pipeline',
    description:
      'Lee el estado actual del pipeline en CRM Wapify: leads por etapa, estancados, tiempo por etapa. Solo lectura.',
    input_schema: {
      type: 'object',
      properties: {
        pipeline_id: {
          type: 'string',
          description: 'ID del pipeline GioLens.',
        },
      },
      required: ['pipeline_id'],
    },
  },
  {
    name: 'propose_budget_change',
    description:
      'Emite una PROPUESTA de cambio de daily_budget al bus. NO ejecuta. Otro flujo (executeApprovedProposal) la dispara tras approval.',
    input_schema: {
      type: 'object',
      properties: {
        pipeline_id:     { type: 'string' },
        adset_id:        { type: 'string', description: 'Adset Meta a modificar.' },
        current_budget:  { type: 'number', description: 'Daily budget actual en USD.' },
        proposed_budget: { type: 'number', description: 'Daily budget propuesto en USD.' },
        rationale:       { type: 'string', description: 'Justificacion basada en KPIs.' },
        estimated_delta_usd: {
          type: 'object',
          description: 'Impacto economico estimado (delta H2). value=USD absoluto, period=ventana, confidence=0..1.',
          properties: {
            value:      { type: 'number', description: 'Impacto economico absoluto en USD.' },
            period:     { type: 'string', description: "'7d' | '14d' | '30d'. Default '7d'." },
            confidence: { type: 'number', description: 'Confianza 0..1.' },
          },
        },
      },
      required: ['adset_id', 'proposed_budget', 'rationale'],
    },
  },
  // Las siguientes se declaran pero el system prompt prohibe llamarlas
  // directamente desde el LLM. Sirven para que el modelo razone sobre el
  // dominio. La ejecucion real va por executeApprovedProposal en graph.js.
  {
    name: 'apply_budget_change',
    description:
      'EJECUTA un cambio de daily_budget Meta. NO invocar desde el modelo. Requiere approval previo y registro de rollback.',
    input_schema: {
      type: 'object',
      properties: {
        adset_id:        { type: 'string' },
        previous_budget: { type: 'number' },
        new_budget:      { type: 'number' },
        decision_id:     { type: 'string' },
      },
      required: ['adset_id', 'new_budget'],
    },
  },
  {
    name: 'pause_adset',
    description:
      'Pausa un adset Meta. NO invocar desde el modelo. Requiere approval previo y registro de rollback.',
    input_schema: {
      type: 'object',
      properties: {
        adset_id:    { type: 'string' },
        reason:      { type: 'string' },
        decision_id: { type: 'string' },
      },
      required: ['adset_id'],
    },
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Handlers ejecutables
// ────────────────────────────────────────────────────────────────────────────

/**
 * STUB: propose_budget_change — emite la propuesta al bus, NO ejecuta.
 * Reutiliza el stub compartido para mantener log unico.
 */
export async function proposeBudgetChangeHandler(input = {}) {
  // 1) Delega al stub compartido (loguea + retorna decision_id)
  const result = await proposeBudgetChange.handler(input);

  // 2) Publica al bus como budget_proposal (visible para otros agentes / UI)
  publish({
    from_agent:   'optimizacion',
    to_agent:     '*',
    type:         'budget_proposal',
    payload: {
      pipeline_id:         input.pipeline_id,
      adset_id:            input.adset_id,
      current_budget:      input.current_budget ?? null,
      proposed_budget:     input.proposed_budget,
      rationale:           input.rationale,
      estimated_delta_usd: input.estimated_delta_usd ?? null,
      decision_id:         result?.decision_id,
    },
    context_refs: result?.decision_id ? [result.decision_id] : [],
    requires_ack: true,
  });

  return result;
}

/**
 * STUB: apply_budget_change — solo se invoca tras approval gate.
 * graph.js (executeApprovedProposal) llama directo a esta funcion, NO el LLM.
 *
 * Flujo:
 *   1) Verifica approval (idempotente: si se llama sin approval, falla).
 *   2) Toma snapshot del previous_budget (lo recibe en el payload).
 *   3) Registra el handler de rollback para kind='budget_changed'.
 *   4) TODO Fase 2: PATCH real a Meta /{adset_id} con daily_budget = new_budget.
 */
export async function applyBudgetChangeHandler(input = {}, ctx = {}) {
  const { adset_id, previous_budget, new_budget, decision_id } = input;

  if (!adset_id || typeof new_budget !== 'number') {
    return { ok: false, error: 'adset_id y new_budget requeridos' };
  }
  if (!ctx.approval || !ctx.approval.approved) {
    return { ok: false, error: 'approval requerido — no se ejecuta sin gate' };
  }

  // El rollback handler concreto se registra en rollback-handlers.js al import.
  // Aqui solo registramos la decision_action que permitiria revertir.
  console.log(
    `[tool:apply_budget_change][STUB] adset=${adset_id} ${previous_budget ?? '?'} -> ${new_budget} USD/day. decision=${decision_id ?? '?'}`,
  );

  // TODO Fase 2: PATCH https://graph.facebook.com/v20.0/{adset_id}
  return {
    ok: true,
    mock: true,
    decision_id: decision_id || `apply-${Date.now()}`,
    rollback_kind: 'budget_changed',
    rollback_payload: { adset_id, previous_budget },
  };
}

/**
 * STUB: pause_adset — solo se invoca tras approval gate.
 */
export async function pauseAdsetHandler(input = {}, ctx = {}) {
  const { adset_id, reason, decision_id } = input;
  if (!adset_id) return { ok: false, error: 'adset_id requerido' };
  if (!ctx.approval || !ctx.approval.approved) {
    return { ok: false, error: 'approval requerido — no se ejecuta sin gate' };
  }

  console.log(
    `[tool:pause_adset][STUB] adset=${adset_id} reason="${(reason || '').slice(0, 120)}" decision=${decision_id ?? '?'}`,
  );

  // TODO Fase 2: POST Meta /{adset_id} con status='PAUSED'.
  return {
    ok: true,
    mock: true,
    decision_id: decision_id || `pause-${Date.now()}`,
    rollback_kind: 'adset_paused',
    rollback_payload: { adset_id },
  };
}

// Mapa nombre → implementacion. graph.js usa esto para resolver tool_use del modelo.
// Nota: apply_budget_change y pause_adset NO se exponen al modelo (system prompt
// lo prohibe), pero estan en el mapa para que executeApprovedProposal pueda
// invocarlas por nombre.
export const TOOL_HANDLERS = {
  read_kpis: readKpis,
  read_pipeline: readPipeline,
  propose_budget_change: proposeBudgetChangeHandler,
  apply_budget_change: applyBudgetChangeHandler,
  pause_adset: pauseAdsetHandler,
};

// Tools que el LLM puede invocar (subset de TOOL_DEFINITIONS).
// apply_budget_change y pause_adset estan declaradas para razonamiento, pero
// el system prompt instruye al modelo a NO llamarlas.
export const LLM_INVOCABLE_TOOLS = TOOL_DEFINITIONS.filter((t) =>
  ['read_kpis', 'read_pipeline', 'propose_budget_change'].includes(t.name),
);

// Re-exporta para que graph.js y rollback-handlers.js puedan importar directo.
export { requestApproval, registerRollback };

export default TOOL_DEFINITIONS;
