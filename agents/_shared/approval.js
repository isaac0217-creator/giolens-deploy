/**
 * GioLens — Human approval gate
 * Fase 3 §15. Capa compartida.
 *
 * Estado: STUB Fase 1. Auto-aprueba todo y deja log.
 *
 * Cuando llegue el dashboard widget (Fase 2):
 *   - persistir decision en tabla agent_decisions
 *   - publicar evento en bus para UI
 *   - bloquear hasta que el humano apruebe/rechace (timeout configurable)
 */

/**
 * Solicita aprobacion humana para una accion de agente.
 * @param {object} req
 * @param {string} req.decision_id  - ID unico (sugerido: uuid o `${agent}-${ts}`)
 * @param {string} req.agent        - nombre del agente solicitante
 * @param {string} req.action       - accion propuesta (ej. 'increase_budget', 'pause_ad')
 * @param {string} req.rationale    - por que el agente quiere hacerlo
 * @param {object} [req.evidence]   - data soportando la decision (kpis, snapshots, refs)
 * @param {number} [req.amount_usd] - impacto economico si aplica
 * @returns {Promise<{approved:boolean, by:string, at:string, decision_id:string, note?:string}>}
 */
export async function requestApproval(req) {
  const decisionId = req?.decision_id || `auto-${Date.now()}`;
  const agent      = req?.agent || 'unknown';
  const action     = req?.action || 'unspecified';
  const amount     = Number(req?.amount_usd || 0);

  // TODO Fase 2: aqui se persiste en Supabase + se publica en bus + se espera respuesta humana.
  console.log(`[approval][STUB] auto-approve decision=${decisionId} agent=${agent} action=${action} amount=$${amount.toFixed(2)} rationale="${(req?.rationale || '').slice(0, 120)}"`);

  return {
    approved:    true,
    by:          'auto-stub',
    at:          new Date().toISOString(),
    decision_id: decisionId,
    note:        'STUB Fase 1 — todas las decisiones auto-aprobadas. Reemplazar antes de exponer a produccion.',
  };
}

export default requestApproval;
