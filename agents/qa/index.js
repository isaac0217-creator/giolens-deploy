/**
 * GioLens — Agente QA · index.js
 * Rol: Handler exportable del QA. Por ahora se invoca como función plana;
 *      cuando Inngest esté instalado, este handler se envolverá en
 *      inngest.createFunction(...) para correr en cron o triggered por
 *      evento (ej. pre-deploy, post-commit).
 *
 * Targets reales (5 motores + Analista cuando exista en /agents/analista):
 *   216977 — Justin · Holbrook
 *   755062 — GioSports
 *   252999 — SPY Z87
 *    94103 — Dama Luxury
 *   273944 — GioVision
 *   analista — Agente Analista (Fase 3 GIOCORE)
 *
 * TODO Fase 2: envolver en inngest.createFunction.
 * TODO cuando llegue Supabase: leer targets desde tabla qa_targets.
 */

import { runQA, DEFAULT_TARGETS } from './graph.js';

/**
 * Run diario del QA — evalúa los 5 motores + Analista en modo 'evals'.
 * Período típico: post-deploy o cron 6:00 AM CDMX.
 */
export async function executeQADailyRun() {
  const result = await runQA({ targets: DEFAULT_TARGETS, mode: 'evals' });

  console.log(
    JSON.stringify({
      agent: 'qa',
      event: 'daily_run_complete',
      mode: 'evals',
      summary: result.summary,
      findings_count: result.findings.length,
      cost_usd: result.cost_usd,
      latency_ms: result.latency_ms,
    }),
  );

  // Si hay blockers, el caller (deploy script) puede salir con código != 0.
  return result;
}

/**
 * Run on-demand — útil para invocar desde tests, CLI o el Orquestador.
 *
 * @param {object} args
 * @param {Array<string|object>} [args.targets]
 * @param {'unit'|'integration'|'e2e'|'evals'|'full'} [args.mode]
 */
export async function runQAOnDemand({ targets, mode = 'evals' } = {}) {
  return runQA({ targets, mode });
}

export default executeQADailyRun;


// ═══ Sprint 1 wiring · Supabase smoke read (no activa shadow) ═══════════════
// Wiring agregado 18 may PM (briefing §3 #2). El agente NO usa Supabase en
// runtime todavía — esto es solo para que cuando arranquemos Frente C,
// el cliente esté validado y las queries específicas al rol estén documentadas.
// TODO Frente C: reemplazar dynamic import por static import al top + usar
// logAgentRun + publishAgentMessage en el handler real.
export async function pingSupabase() {
  const { readAppConfig } = await import('../_shared/db.js'); return await readAppConfig('cost_caps');
}
