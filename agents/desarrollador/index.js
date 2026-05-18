/**
 * GioLens — Agente Desarrollador · index.js
 * Rol: Handler exportable que despacha tareas de desarrollo bajo demanda.
 *      Por ahora se invoca como función plana; cuando Inngest esté
 *      instalado, este handler se envuelve en inngest.createFunction(...).
 *
 * Tasks soportados (§15 v12 GIOCORE):
 *   analyze_qa_failure   — diagnostica un issue del agente QA
 *   generate_fix         — genera patch atómico para un archivo
 *   create_pull_request  — empaca fix en PR-like stub (NO publica en GitHub)
 *
 * RESTRICCIONES INMUTABLES:
 *   - NUNCA hace push directo a main.
 *   - NUNCA escribe a disco.
 *   - NUNCA conecta a GitHub real (PR es stub://...).
 *   - Cambios solo se mergean tras: QA pasa + humano revisa PR + tests verdes en CI.
 *
 * TODO Fase 2: envolver executeDesarrolladorOnDemand en inngest.createFunction.
 * TODO Fase 4: createPullRequestReal con GitHub API y branch protection.
 */

import {
  analyzeQAFailure,
  generateFix,
  createPullRequestStub,
} from './graph.js';

/**
 * Despachador on-demand. Otro agente (QA, Orquestador) o un cron lo invoca
 * con el task adecuado.
 *
 * @param {object} args
 * @param {'analyze_qa_failure'|'generate_fix'|'create_pull_request'} args.task
 * @param {object} args.params  - depende del task:
 *   - analyze_qa_failure:   { qaIssue }
 *   - generate_fix:         { filePath, currentContent?, diagnosis, rootCause }
 *   - create_pull_request:  { branchName, baseBranch?, fixPayload, qaIssueRef? }
 */
export async function executeDesarrolladorOnDemand({ task, params = {} } = {}) {
  if (!task) {
    throw new Error('executeDesarrolladorOnDemand: task requerido (analyze_qa_failure|generate_fix|create_pull_request)');
  }

  let result;
  switch (task) {
    case 'analyze_qa_failure':
      result = await analyzeQAFailure(params);
      break;
    case 'generate_fix':
      result = await generateFix(params);
      break;
    case 'create_pull_request':
      result = await createPullRequestStub(params);
      break;
    default:
      throw new Error(`executeDesarrolladorOnDemand: task desconocido "${task}"`);
  }

  // Log estructurado (Vercel captura stdout)
  console.log(
    JSON.stringify({
      agent: 'desarrollador',
      event: 'on_demand_complete',
      task,
      file_path:    params?.filePath || result?.draft?.file_path || null,
      branch_name:  params?.branchName || result?.draft?.branch_name || null,
      ok:           !result?.error,
      error:        result?.error || null,
      approved:     result?.approval?.approved ?? null,
      requires_human: result?.diagnosis?.requires_human ?? null,
      sensitive:    result?.draft?.sensitive ?? null,
      cost_usd:     result?.cost_usd,
      latency_ms:   result?.latency_ms,
    }),
  );

  return result;
}

export {
  analyzeQAFailure,
  generateFix,
  createPullRequestStub,
};

export default executeDesarrolladorOnDemand;


// ═══ Sprint 1 wiring · Supabase smoke read (no activa shadow) ═══════════════
// Wiring agregado 18 may PM (briefing §3 #2). El agente NO usa Supabase en
// runtime todavía — esto es solo para que cuando arranquemos Frente C,
// el cliente esté validado y las queries específicas al rol estén documentadas.
// TODO Frente C: reemplazar dynamic import por static import al top + usar
// logAgentRun + publishAgentMessage en el handler real.
export async function pingSupabase() {
  const { readPendingApprovals } = await import('../_shared/db.js'); return await readPendingApprovals({ agent: 'desarrollador' });
}
