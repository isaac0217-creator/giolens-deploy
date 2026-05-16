/**
 * GioLens — Tool: propose_budget_change
 * Fase 3 §15. Capa compartida (tools).
 *
 * Disponible para: Optimizacion (solo).
 *
 * Estado: STUB. Por ahora console.log + mock success.
 * Cuando llegue Fase 2: PATCH Meta /{adset_id} con nuevo daily_budget,
 * pasando por approval.requestApproval() antes de ejecutar.
 */

export const toolDefinition = {
  name: 'propose_budget_change',
  description: 'Propone cambiar el daily_budget de un adset Meta. Requiere aprobacion humana antes de ejecutar (gate Fase 2).',
  input_schema: {
    type: 'object',
    properties: {
      adset_id:        { type: 'string', description: 'ID del adset en Meta Ads.' },
      current_budget:  { type: 'number', description: 'Daily budget actual en USD.' },
      proposed_budget: { type: 'number', description: 'Daily budget propuesto en USD.' },
      rationale:       { type: 'string', description: 'Justificacion basada en KPIs (CPL, ROAS, gasto vs cap).' },
    },
    required: ['adset_id', 'proposed_budget', 'rationale'],
  },
};

/**
 * @param {{adset_id:string, current_budget?:number, proposed_budget:number, rationale:string}} input
 */
export async function handler(input = {}) {
  // TODO Fase 2:
  //   1) cost-tracker: chequear cap diario antes
  //   2) approval.requestApproval({ agent:'optimizacion', action:'budget_change', ...})
  //   3) si aprobado: fetch Meta API PATCH adset
  //   4) registrar decision_action kind='budget_changed' con previous_budget
  console.log(`[tool:propose_budget_change][STUB] adset=${input.adset_id} ${input.current_budget ?? '?'} -> ${input.proposed_budget} USD/day. Rationale: ${(input.rationale || '').slice(0, 160)}`);
  return {
    ok: true,
    mock: true,
    decision_id: `budget-${Date.now()}`,
    detail: 'STUB: cambio NO aplicado, solo registrado en log. Requiere implementacion Fase 2 + approval gate.',
  };
}

export default { toolDefinition, handler };
