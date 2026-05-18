/**
 * GioLens — Rollback registry
 * Fase 3 §15. Capa compartida.
 *
 * Cada accion de agente que muta estado externo se registra como
 * decision_action con un `kind`. Si la accion debe revertirse (rechazo
 * humano tardio, KPI cae, QA falla), se invoca executeRollback(action)
 * que despacha al handler registrado por kind.
 *
 * Estado: registry OPERATIVO. Handlers pre-cargados son PLACEHOLDERS.
 *   - ad_published       — TODO Fase 2: llamar Meta API DELETE adcreative
 *   - lead_stage_moved   — TODO Fase 2: revertir via Wapify (cardId previo)
 *   - budget_changed     — TODO Fase 2: PATCH Meta adset daily_budget previo
 */

const _registry = new Map();

/**
 * Registra (o reemplaza) un handler de rollback para un kind.
 * @param {string} kind
 * @param {(payload:object)=>Promise<{ok:boolean, detail?:string, error?:string}>} handler
 */
export function register(kind, handler) {
  if (!kind || typeof handler !== 'function') {
    throw new Error('[rollback.register] kind y handler requeridos');
  }
  _registry.set(kind, handler);
}

/**
 * @param {string} kind
 * @returns {boolean}
 */
export function has(kind) {
  return _registry.has(kind);
}

/**
 * Ejecuta el rollback para una accion previamente registrada.
 * @param {object} decision_action
 * @param {string} decision_action.kind
 * @param {object} [decision_action.payload]
 * @returns {Promise<{ok:boolean, kind:string, detail?:string, error?:string}>}
 */
export async function executeRollback(decision_action) {
  if (!decision_action || !decision_action.kind) {
    return { ok: false, kind: 'unknown', error: 'decision_action.kind missing' };
  }
  const handler = _registry.get(decision_action.kind);
  if (!handler) {
    return { ok: false, kind: decision_action.kind, error: `no handler registered for kind=${decision_action.kind}` };
  }
  try {
    const result = await handler(decision_action.payload || {});
    return { ok: Boolean(result?.ok), kind: decision_action.kind, detail: result?.detail, error: result?.error };
  } catch (err) {
    return { ok: false, kind: decision_action.kind, error: err.message };
  }
}

/** Util tests */
export function _resetForTests() {
  _registry.clear();
  _registerDefaults();
}

// ────────────────────────────────────────────────────────────────────
// Handlers PLACEHOLDER (Fase 1). Reemplazar en Fase 2 con llamadas reales.
// ────────────────────────────────────────────────────────────────────

async function _undoAdPublished(payload) {
  // TODO Fase 2: DELETE https://graph.facebook.com/v20.0/{ad_id}
  console.log(`[rollback][ad_published][STUB] would unpublish ad_id=${payload?.ad_id || '?'}`);
  return { ok: true, detail: 'stub: ad would be unpublished' };
}

async function _undoLeadStageMoved(payload) {
  // TODO Fase 2: usar Wapify API para mover contact_id de stage actual a payload.previous_stage_id
  console.log(`[rollback][lead_stage_moved][STUB] would revert contact=${payload?.contact_id || '?'} to stage=${payload?.previous_stage_id || '?'}`);
  return { ok: true, detail: 'stub: lead stage would be reverted' };
}

async function _undoBudgetChanged(payload) {
  // TODO Fase 2: PATCH /{adset_id} con daily_budget = payload.previous_budget
  console.log(`[rollback][budget_changed][STUB] would revert adset=${payload?.adset_id || '?'} to budget=${payload?.previous_budget || '?'}`);
  return { ok: true, detail: 'stub: budget would be reverted' };
}

function _registerDefaults() {
  register('ad_published',     _undoAdPublished);
  register('lead_stage_moved', _undoLeadStageMoved);
  register('budget_changed',   _undoBudgetChanged);
}

_registerDefaults();

// Alias backward-compat: optimizacion/tools.js importa `registerRollback`
// (nombre más descriptivo cuando se usa fuera del contexto de este módulo).
export { register as registerRollback };

export default { register, has, executeRollback, _resetForTests };
