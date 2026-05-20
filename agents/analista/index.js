/**
 * GioLens — Agente Analista · index.js
 * Rol: Handler exportable que será el trigger del Analista. Por ahora se
 *      invoca como función plana; cuando Inngest esté instalado, este
 *      mismo handler se envolverá en inngest.createFunction(...).
 *
 * Pipelines reales (Fase 2C, fuente: project_giolens_pipelines.md):
 *   216977 — Justin · Holbrook · Litebeam
 *   755062 — GioSports · Deportivo
 *   252999 — SPY · Seguridad Z87
 *    94103 — Dama · Luxury
 *   273944 — GioVision · Entintados
 *
 * TODO Fase 2: envolver en inngest.createFunction cuando Inngest esté listo.
 * TODO: leer pipelineIds desde Supabase en vez de hardcodearlos.
 */

import { runAnalista } from './graph.js';
import { distillConversations } from './distill.js';

export const GIOLENS_PIPELINE_IDS = [
  '216977',
  '755062',
  '252999',
  '94103',
  '273944',
];

/**
 * Ejecuta el run diario del Analista sobre los 5 pipelines reales.
 * Período default: últimas 24h.
 */
export async function executeAnalistaDailyRun({ period = 'last_24h' } = {}) {
  const result = await runAnalista({
    pipelineIds: GIOLENS_PIPELINE_IDS,
    period,
  });

  // Log estructurado (Vercel captura stdout)
  console.log(
    JSON.stringify({
      agent: 'analista',
      event: 'daily_run_complete',
      period,
      insights_count: result.insights.length,
      published: result.published,
      cost_usd: result.cost_usd,
      latency_ms: result.latency_ms,
      errors: result.errors,
    }),
  );

  return result;
}

/**
 * Distila un lote de conversaciones en resúmenes estructurados.
 * Capability separada del daily run (no comparte prompt ni flujo).
 * Frente C · C.2.5 — invocado por inngest/functions/distill-conversation.js.
 *
 * @param {object} args
 * @param {Array<{contact_id:string, messages:Array}>} args.conversations
 * @param {string} [args.correlation_id]  propagado por runWithTrace
 * @returns {Promise<{distilled:object[], cost_usd:number, latency_ms:number, model:string, error:string|null}>}
 */
export async function distillBatch({ conversations = [], correlation_id } = {}) {
  const result = await distillConversations({ conversations, correlation_id });

  console.log(
    JSON.stringify({
      agent: 'analista',
      event: 'distill_batch_complete',
      batch_size: Array.isArray(conversations) ? conversations.length : 0,
      distilled: result.distilled.length,
      cost_usd: result.cost_usd,
      latency_ms: result.latency_ms,
      error: result.error,
    }),
  );

  return result;
}

export default executeAnalistaDailyRun;


// ═══ Sprint 1 wiring · Supabase smoke read (no activa shadow) ═══════════════
// Wiring agregado 18 may PM (briefing §3 #2). El agente NO usa Supabase en
// runtime todavía — esto es solo para que cuando arranquemos Frente C,
// el cliente esté validado y las queries específicas al rol estén documentadas.
// TODO Frente C: reemplazar dynamic import por static import al top + usar
// logAgentRun + publishAgentMessage en el handler real.
export async function pingSupabase() {
  const { readKnowledgeBase } = await import('../_shared/db.js'); return await readKnowledgeBase('pipeline_meta');
}
