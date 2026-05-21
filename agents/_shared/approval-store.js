/**
 * GioLens — Approval store (Frente C · C.3)
 * Capa compartida. Registro in-memory de decisiones que pasan por el gate
 * de aprobación humana.
 *
 * Estado: IN-MEMORY. Misma API que tendrá la tabla `agent_decisions` de
 * Supabase (Frente D) — `register`/`resolve`/`getPending`/`getHistory`.
 *
 * TODO Frente D (Supabase):
 *   - register()  -> insert en agent_decisions (status='pending')
 *   - resolve()   -> update status + verdict
 *   - getPending()/getHistory() -> select con filtro
 *   - mantener fallback in-memory para tests
 */

/** @type {Map<string, object>} decisiones pendientes por decision_id */
const _pending = new Map();
/** @type {object[]} decisiones resueltas, más reciente al final */
const _history = [];
/** @type {Map<string, Array<(verdict:object)=>void>>} waiters de waitFor() */
const _waiters = new Map();

/**
 * Registra una decisión pendiente. Idempotente por `decision_id`: si ya existe
 * (pendiente o resuelta) NO la duplica y devuelve el registro existente.
 * @param {object} decision
 * @param {string} decision.decision_id
 * @returns {object} el registro (nuevo o existente)
 */
export function register(decision) {
  const id = decision?.decision_id;
  if (!id) throw new Error('[approval-store] decision_id requerido');

  const existing = _pending.get(id) || _history.find((h) => h.decision_id === id);
  if (existing) return existing; // idempotente

  const rec = {
    decision_id: id,
    agent:       decision.agent || 'unknown',
    action:      decision.action || 'unspecified',
    rationale:   decision.rationale || '',
    evidence:    decision.evidence || {},
    amount_usd:  Number(decision.amount_usd || 0),
    status:      'pending',
    requested_at: new Date().toISOString(),
  };
  _pending.set(id, rec);
  return rec;
}

/**
 * Devuelve una Promise que resuelve con el veredicto cuando la decisión se
 * resuelve. Si ya está resuelta, resuelve de inmediato.
 * @param {string} decision_id
 * @returns {Promise<object>} verdict
 */
export function waitFor(decision_id) {
  const done = _history.find((h) => h.decision_id === decision_id);
  if (done) return Promise.resolve(done.verdict);
  return new Promise((resolve) => {
    const arr = _waiters.get(decision_id);
    if (arr) arr.push(resolve);
    else _waiters.set(decision_id, [resolve]);
  });
}

/**
 * Resuelve una decisión pendiente con un veredicto. Idempotente: resolver una
 * decisión ya resuelta (o inexistente) es no-op.
 * @param {string} decision_id
 * @param {{approved:boolean, by:string, at:string, decision_id:string, note?:string}} verdict
 * @returns {object|null} el registro resuelto, o null si no estaba pendiente
 */
export function resolve(decision_id, verdict) {
  const rec = _pending.get(decision_id);
  if (!rec) return _history.find((h) => h.decision_id === decision_id) || null;

  _pending.delete(decision_id);
  rec.status      = verdict?.approved ? 'approved' : 'rejected';
  rec.verdict     = verdict;
  rec.resolved_at = new Date().toISOString();
  _history.push(rec);

  const waiters = _waiters.get(decision_id) || [];
  _waiters.delete(decision_id);
  for (const w of waiters) w(verdict);
  return rec;
}

/** @returns {object[]} decisiones pendientes */
export function getPending() {
  return [..._pending.values()];
}

/** @returns {object[]} últimas N decisiones resueltas (más reciente al final) */
export function getHistory(limit = 20) {
  return _history.slice(-limit);
}

/** Util para tests: vacía pendientes, historial y waiters. */
export function _resetForTests() {
  _pending.clear();
  _history.length = 0;
  _waiters.clear();
}

export default { register, waitFor, resolve, getPending, getHistory, _resetForTests };
