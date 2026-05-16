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

export default executeAnalistaDailyRun;
