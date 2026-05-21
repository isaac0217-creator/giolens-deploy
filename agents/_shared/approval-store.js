/**
 * GioLens — Approval store (Frente C · C.3 → Frente D · ADR-02)
 * Capa compartida. Registro de decisiones que pasan por el gate de
 * aprobación humana.
 *
 * Estado: ESPEJO IN-PROCESS + PERSISTENCIA SUPABASE fire-and-forget (ADR-02).
 *   - El espejo in-process (Map + array) es SIEMPRE autoritativo.
 *   - `isSupabaseReady() === true` → además persiste cada escritura en la tabla
 *     `agent_decisions` (idempotente por `decision_key`) de forma best-effort:
 *     si la escritura falla, se loguea y el espejo in-process sigue mandando.
 *
 * API PÚBLICA IDÉNTICA en ambos backends — `register` / `resolve` / `waitFor`
 * / `getPending` / `getHistory` / `_resetForTests`. Las funciones de lectura y
 * escritura son síncronas: el store mantiene SIEMPRE un espejo in-process
 * (autoritativo para `waitFor` y para las lecturas síncronas del panel/tests),
 * y cuando Supabase está disponible además persiste de forma asíncrona
 * (fire-and-forget) para durabilidad entre cold starts. ADR-02 §backend.
 *
 * Mapeo store → columna de `agent_decisions` (ver migración 002):
 *   decision_id  → decision_key      agent       → agent_name
 *   action       → decision_type     rationale   → justification
 *   evidence     → evidence_refs     amount_usd  → amount_usd
 *   verdict      → verdict           requested_at→ created_at
 *   resolved_at  → resolved_at       correlation_id → correlation_id
 *
 * Mapeo de status del store → status de la tabla:
 *   pending → 'pending'
 *   auto-aprobado (verdict.by auto-*) → 'auto_approved'
 *   timeout (verdict.by 'timeout')    → 'expired'
 *   humano approved=true              → 'approved'
 *   humano approved=false             → 'rejected'
 */

import { getServiceClient, isSupabaseReady } from './supabase.js';

const TABLE = 'agent_decisions';

// ─────────────────────────────────────────────────────────────────────────
// Espejo in-process — SIEMPRE activo. Es el backend in-memory completo y, a la
// vez, el espejo síncrono que respalda `waitFor()` y las lecturas del panel.
// ─────────────────────────────────────────────────────────────────────────
/** @type {Map<string, object>} decisiones pendientes por decision_id */
const _pending = new Map();
/** @type {object[]} decisiones resueltas, más reciente al final */
const _history = [];
/** @type {Map<string, Array<(verdict:object)=>void>>} waiters de waitFor() */
const _waiters = new Map();

/**
 * Traduce el status interno del store al enum de `agent_decisions.status`.
 * @param {string} storeStatus  'pending' | 'approved' | 'rejected'
 * @param {object} [verdict]
 * @returns {'pending'|'approved'|'rejected'|'auto_approved'|'expired'}
 */
function _mapStatus(storeStatus, verdict) {
  if (storeStatus === 'pending') return 'pending';
  const by = verdict?.by || '';
  if (by === 'timeout') return 'expired';
  if (by === 'auto-mode' || by === 'auto-threshold' || by.startsWith('auto')) {
    return 'auto_approved';
  }
  return verdict?.approved ? 'approved' : 'rejected';
}

// ─────────────────────────────────────────────────────────────────────────
// Backend Supabase — escrituras fire-and-forget. Nunca lanza: cualquier fallo
// se loguea y el espejo in-process sigue siendo la verdad en proceso.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Persiste una decisión nueva en `agent_decisions` vía upsert idempotente.
 * `onConflict: 'decision_key'` + `ignoreDuplicates` → si la fila ya existe
 * (mismo decision_key) NO la pisa. Fire-and-forget.
 * @param {object} rec  registro del store
 */
async function _sbRegister(rec) {
  const client = getServiceClient();
  if (!client) return;
  const row = {
    decision_key:    rec.decision_id,
    agent_name:      rec.agent,
    decision_type:   rec.action,
    proposed_action: { action: rec.action },
    justification:   rec.rationale || '',
    evidence_refs:   rec.evidence || {},
    amount_usd:      rec.amount_usd,
    correlation_id:  rec.correlation_id || null,
    status:          'pending',
  };
  try {
    const { error } = await client.from(TABLE).upsert(row, {
      onConflict: 'decision_key',
      ignoreDuplicates: true,
    });
    if (error) {
      console.error(`[approval-store] sb register fallo decision=${rec.decision_id}: ${error.message}`);
    }
  } catch (err) {
    console.error(`[approval-store] sb register excepción decision=${rec.decision_id}: ${err.message}`);
  }
}

/**
 * Persiste la resolución de una decisión en `agent_decisions`.
 * `update ... where decision_key=? and status='pending'` → un segundo resolve
 * sobre una decisión ya resuelta es no-op (no matchea ninguna fila). Fire-and-forget.
 * @param {object} rec  registro ya resuelto del store
 */
async function _sbResolve(rec) {
  const client = getServiceClient();
  if (!client) return;
  const patch = {
    status:      _mapStatus(rec.status, rec.verdict),
    verdict:     rec.verdict || null,
    resolved_at: rec.resolved_at,
  };
  try {
    const { error } = await client
      .from(TABLE)
      .update(patch)
      .eq('decision_key', rec.decision_id)
      .eq('status', 'pending');
    if (error) {
      console.error(`[approval-store] sb resolve fallo decision=${rec.decision_id}: ${error.message}`);
    }
  } catch (err) {
    console.error(`[approval-store] sb resolve excepción decision=${rec.decision_id}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────────────────

/**
 * Registra una decisión pendiente. Idempotente por `decision_id`: si ya existe
 * (pendiente o resuelta) NO la duplica y devuelve el registro existente.
 * Con Supabase disponible, además persiste vía upsert idempotente.
 * @param {object} decision
 * @param {string} decision.decision_id
 * @param {string} [decision.agent]
 * @param {string} [decision.action]
 * @param {string} [decision.rationale]
 * @param {object} [decision.evidence]
 * @param {number} [decision.amount_usd]
 * @param {string} [decision.correlation_id]
 * @returns {object} el registro (nuevo o existente)
 */
export function register(decision) {
  const id = decision?.decision_id;
  if (!id) throw new Error('[approval-store] decision_id requerido');

  const existing = _pending.get(id) || _history.find((h) => h.decision_id === id);
  if (existing) return existing; // idempotente

  const rec = {
    decision_id:    id,
    agent:          decision.agent || 'unknown',
    action:         decision.action || 'unspecified',
    rationale:      decision.rationale || '',
    evidence:       decision.evidence || {},
    amount_usd:     Number(decision.amount_usd || 0),
    correlation_id: decision.correlation_id || null,
    status:         'pending',
    requested_at:   new Date().toISOString(),
  };
  _pending.set(id, rec);

  if (isSupabaseReady()) _sbRegister(rec);
  return rec;
}

/**
 * Devuelve una Promise que resuelve con el veredicto cuando la decisión se
 * resuelve. Si ya está resuelta, resuelve de inmediato. Siempre in-process
 * (sin cambios respecto a C.3): el gate vive dentro del mismo proceso.
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
 * decisión ya resuelta (o inexistente) es no-op. Con Supabase disponible,
 * además persiste el update (condicionado a status='pending', así el segundo
 * resolve tampoco escribe).
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

  if (isSupabaseReady()) _sbResolve(rec);

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

/** Util para tests: vacía pendientes, historial y waiters (espejo in-process). */
export function _resetForTests() {
  _pending.clear();
  _history.length = 0;
  _waiters.clear();
}

export default { register, waitFor, resolve, getPending, getHistory, _resetForTests };
