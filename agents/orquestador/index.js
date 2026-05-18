/**
 * GioLens — Agente Orquestador · index.js
 * Rol: Handler exportable que despacha tareas de orquestación bajo demanda.
 *      Por ahora se invoca como función plana; cuando Inngest esté
 *      instalado, este handler se envuelve en inngest.createFunction(...).
 *
 * Tasks soportados (§15 v12 GIOCORE):
 *   schedule_run      — encola ejecución para otro agente
 *   resolve_conflict  — decide entre N propuestas sobre el mismo recurso
 *   share_context     — reparte un insight de un agente a otros relevantes
 *
 * RESTRICCIONES INMUTABLES:
 *   - NUNCA ejecuta acciones de negocio directamente.
 *   - NUNCA invoca a otros agentes (no llama executeAnalistaDailyRun, etc.).
 *   - Solo emite eventos al bus para que otros sistemas (Fase 2 Inngest) los
 *     consuman.
 *
 * TODO Fase 2: envolver executeOrquestadorOnDemand en inngest.createFunction.
 * TODO Fase 2: cron que detecta P2 (humano sin atender >30min) y reescala.
 */

import {
  scheduleAgentRun,
  resolveConflict,
  shareContext,
} from './graph.js';

/**
 * Despachador on-demand. Otros agentes / dashboard / cron lo invocan con el
 * task adecuado.
 *
 * @param {object} args
 * @param {'schedule_run'|'resolve_conflict'|'share_context'} args.task
 * @param {object} args.params  - depende del task:
 *   - schedule_run:     { targetAgent, task, params, priority, dependsOn, reason }
 *   - resolve_conflict: { resourceId, resourceType, proposals }
 *   - share_context:    { sourceAgent, insight, targetAgents }
 */
export async function executeOrquestadorOnDemand({ task, params = {} } = {}) {
  if (!task) {
    throw new Error(
      'executeOrquestadorOnDemand: task requerido (schedule_run|resolve_conflict|share_context)',
    );
  }

  let result;
  switch (task) {
    case 'schedule_run':
      result = await scheduleAgentRun(params);
      break;
    case 'resolve_conflict':
      result = await resolveConflict(params);
      break;
    case 'share_context':
      result = await shareContext(params);
      break;
    default:
      throw new Error(`executeOrquestadorOnDemand: task desconocido "${task}"`);
  }

  // Log estructurado (Vercel captura stdout)
  console.log(
    JSON.stringify({
      agent: 'orquestador',
      event: 'on_demand_complete',
      task,
      target_agent: params?.targetAgent || result?.schedule?.target_agent || null,
      resource_id: params?.resourceId || result?.resolution?.resource_id || null,
      decision: result?.resolution?.decision || null,
      delivered_to: result?.share?.delivered_to || null,
      escalated: result?.escalation ? Boolean(result.escalation.approved) : null,
      ok: !result?.error,
      error: result?.error || null,
      cost_usd: result?.cost_usd,
      latency_ms: result?.latency_ms,
    }),
  );

  return result;
}

export {
  scheduleAgentRun,
  resolveConflict,
  shareContext,
};

export default executeOrquestadorOnDemand;


// ═══ Sprint 1 wiring · Supabase smoke read (no activa shadow) ═══════════════
// Wiring agregado 18 may PM (briefing §3 #2). El agente NO usa Supabase en
// runtime todavía — esto es solo para que cuando arranquemos Frente C,
// el cliente esté validado y las queries específicas al rol estén documentadas.
// TODO Frente C: reemplazar dynamic import por static import al top + usar
// logAgentRun + publishAgentMessage en el handler real.
export async function pingSupabase() {
  const { readPendingApprovals } = await import('../_shared/db.js'); return await readPendingApprovals();
}
