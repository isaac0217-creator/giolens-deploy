/**
 * GioLens — Agente Optimizacion · index.js
 * Rol: Handlers exportables del agente Optimizacion. Igual al patron del
 *      Analista: hoy se invocan como funciones planas, Fase 2 se envuelven
 *      en inngest.createFunction(...).
 *
 * Pipelines reales (project_giolens_pipelines.md):
 *   216977 — Justin · Holbrook · Litebeam       (CPR baseline $8.64)
 *   755062 — GioSports · Deportivo              (CPR baseline $10.29)
 *   252999 — SPY · Seguridad Z87                (CPR baseline $15.20)
 *    94103 — Dama · Luxury                      (CPR baseline $23.53)
 *   273944 — GioVision · Entintados             (CPR baseline $27.78)
 *
 * TODO Fase 2: envolver en inngest.createFunction.
 * TODO Fase 2: leer pipelineIds desde Supabase en vez de hardcodear.
 */

import { analyzeAndPropose, executeApprovedProposal } from './graph.js';

export const GIOLENS_PIPELINE_IDS = [
  '216977',
  '755062',
  '252999',
  '94103',
  '273944',
];

/**
 * Ejecuta el run diario del Optimizacion sobre los 5 pipelines.
 * Devuelve proposals validadas (a ser revisadas por humano) + bloqueadas.
 */
export async function executeOptimizacionDailyRun({ period = 'last_24h' } = {}) {
  const result = await analyzeAndPropose({
    pipelineIds: GIOLENS_PIPELINE_IDS,
    period,
  });

  console.log(
    JSON.stringify({
      agent: 'optimizacion',
      event: 'daily_run_complete',
      period,
      proposals_total:     result.proposals.length,
      proposals_validated: result.validated.length,
      proposals_blocked:   result.blocked.length,
      cost_usd:            result.cost_usd,
      latency_ms:          result.latency_ms,
      errors:              result.errors,
    }),
  );

  return result;
}

/**
 * Aplica una propuesta previamente validada y aprobada.
 * @param {string} proposalId
 * @param {object} proposal      proposal completa (forma del system prompt)
 * @param {object} [approval]    opcional; si no, requestApproval() decide
 */
export async function applyApprovedProposal(proposalId, proposal, approval) {
  const result = await executeApprovedProposal({ proposalId, proposal, approval });

  console.log(
    JSON.stringify({
      agent: 'optimizacion',
      event: 'execute_proposal',
      proposal_id: proposalId,
      ok: result.ok,
      error: result.error || null,
      approval: result.approval || null,
    }),
  );

  return result;
}

export default executeOptimizacionDailyRun;
