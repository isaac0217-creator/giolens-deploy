/**
 * GioLens — Agente Creativo · index.js
 * Rol: Handler exportable que despacha tareas creativas bajo demanda.
 *      Por ahora se invoca como función plana; cuando Inngest esté
 *      instalado, este handler se envuelve en inngest.createFunction(...).
 *
 * Pipelines reales (fuente: project_giolens_pipelines.md):
 *   216977 — Justin · Holbrook · Litebeam
 *   755062 — GioSports · Deportivo
 *   252999 — SPY · Seguridad Z87
 *    94103 — Dama · Luxury
 *   273944 — GioVision · Entintados
 *
 * TODO Fase 2: envolver executeCreativoOnDemand en inngest.createFunction.
 */

import {
  generateScriptVariants,
  generateAdAngles,
  generateReactivationTemplate,
} from './graph.js';

export const GIOLENS_PIPELINE_IDS = ['216977', '755062', '252999', '94103', '273944'];

/**
 * Despachador on-demand. Otro agente (Orquestador) o un cron lo invoca con
 * el task adecuado.
 *
 * @param {object} args
 * @param {'script'|'ad'|'reactivation'} args.task
 * @param {object} args.params  - depende del task:
 *   - script:        { pipelineId, stage, insightContext? }
 *   - ad:            { pipelineId, period?, performanceContext? }
 *   - reactivation:  { pipelineId, stageIn, daysInactive }
 */
export async function executeCreativoOnDemand({ task, params = {} } = {}) {
  if (!task) throw new Error('executeCreativoOnDemand: task requerido (script|ad|reactivation)');

  let result;
  switch (task) {
    case 'script':
      result = await generateScriptVariants(params);
      break;
    case 'ad':
      result = await generateAdAngles(params);
      break;
    case 'reactivation':
      result = await generateReactivationTemplate(params);
      break;
    default:
      throw new Error(`executeCreativoOnDemand: task desconocido "${task}"`);
  }

  // Log estructurado (Vercel captura stdout)
  console.log(
    JSON.stringify({
      agent: 'creativo',
      event: 'on_demand_complete',
      task,
      pipeline_id: params?.pipelineId || null,
      ok: !result.error,
      error: result.error || null,
      approved: result.approval?.approved ?? false,
      cost_usd: result.cost_usd,
      latency_ms: result.latency_ms,
    }),
  );

  return result;
}

export {
  generateScriptVariants,
  generateAdAngles,
  generateReactivationTemplate,
};

export default executeCreativoOnDemand;


// ═══ Sprint 1 wiring · Supabase smoke read (no activa shadow) ═══════════════
// Wiring agregado 18 may PM (briefing §3 #2). El agente NO usa Supabase en
// runtime todavía — esto es solo para que cuando arranquemos Frente C,
// el cliente esté validado y las queries específicas al rol estén documentadas.
// TODO Frente C: reemplazar dynamic import por static import al top + usar
// logAgentRun + publishAgentMessage en el handler real.
export async function pingSupabase() {
  const { readKnowledgeBase } = await import('../_shared/db.js'); return await readKnowledgeBase('product_pricing');
}
