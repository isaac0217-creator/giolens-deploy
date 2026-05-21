/**
 * GioLens — Human approval gate
 * Fase 3 §15. Capa compartida.
 *
 * Frente C · C.3 — gate de aprobación REAL (backend):
 *   - registra cada decisión en `approval-store` (espejo de la tabla
 *     `agent_decisions` que llegará en Frente D / Supabase).
 *   - en modo gate publica un `request` en el bus (`to_agent:'panel-aprobaciones'`)
 *     y bloquea hasta recibir el veredicto humano.
 *   - el veredicto llega como un `response` del panel (`to_agent:'approval-gate'`).
 *
 * Modos (kill-switch de compatibilidad):
 *   - APPROVAL_AUTO_MODE != 'false'  → AUTO (default): auto-aprueba sin gate.
 *     Es el default para no colgar `sim-agents` ni runs que invocan agentes
 *     reales mientras el panel humano (track dashboard) no esté conectado.
 *   - APPROVAL_AUTO_MODE == 'false'  → GATE: bloquea hasta veredicto humano,
 *     salvo que el monto sea <= APPROVAL_GATE_THRESHOLD_USD (auto sin gate).
 *
 * La suscripción UI ↔ bus en vivo (SSE/WebSocket) es del track dashboard web
 * — fuera del alcance del núcleo. Ver ADR-01.
 */

import { publish, subscribe } from './bus.js';
import * as store from './approval-store.js';

/** Lee config de env en cada llamada (los tests la ajustan dinámicamente). */
function autoMode()      { return process.env.APPROVAL_AUTO_MODE !== 'false'; }
function gateThreshold() { return Number(process.env.APPROVAL_GATE_THRESHOLD_USD ?? 50); }
function gateTimeoutMs() { return Number(process.env.APPROVAL_TIMEOUT_MS ?? 0); }

/**
 * Handler del bus: el panel humano publica su veredicto como `response`
 * dirigido a `to_agent:'approval-gate'`. Lo enruta al store.
 * @param {object} msg  mensaje del bus
 */
function _panelVerdictHandler(msg) {
  if (!msg || msg.type !== 'response') return;
  const decisionId = (Array.isArray(msg.context_refs) && msg.context_refs[0]) ||
                     msg.payload?.decision_id;
  if (!decisionId) return;
  store.resolve(decisionId, {
    approved:    Boolean(msg.payload?.approved),
    by:          msg.payload?.by || msg.from_agent || 'panel',
    at:          new Date().toISOString(),
    decision_id: decisionId,
    note:        msg.payload?.note ?? null,
  });
}

// Suscripción al canal de veredictos. Se hace al cargar el módulo (singleton ESM).
let _unsubscribe = subscribe('approval-gate', _panelVerdictHandler);

/**
 * Solicita aprobacion humana para una accion de agente.
 * @param {object} req
 * @param {string} req.decision_id  - ID unico (sugerido: uuid o `${agent}-${ts}`)
 * @param {string} req.agent        - nombre del agente solicitante
 * @param {string} req.action       - accion propuesta (ej. 'increase_budget', 'pause_ad')
 * @param {string} req.rationale    - por que el agente quiere hacerlo
 * @param {object} [req.evidence]   - data soportando la decision (kpis, snapshots, refs)
 * @param {number} [req.amount_usd] - impacto economico si aplica
 * @param {string} [req.correlation_id] - id del run que originó la decisión (trazabilidad Frente D)
 * @returns {Promise<{approved:boolean, by:string, at:string, decision_id:string, note?:string}>}
 */
export async function requestApproval(req) {
  const decisionId = req?.decision_id || `auto-${Date.now()}`;
  const agent      = req?.agent || 'unknown';
  const action     = req?.action || 'unspecified';
  const amount     = Number(req?.amount_usd || 0);

  store.register({
    decision_id: decisionId,
    agent,
    action,
    rationale: req?.rationale,
    evidence:  req?.evidence,
    amount_usd: amount,
    correlation_id: req?.correlation_id,
  });

  // Auto-resolución: modo AUTO (default) o monto bajo el umbral del gate.
  const auto = autoMode();
  if (auto || amount <= gateThreshold()) {
    const by = auto ? 'auto-mode' : 'auto-threshold';
    const verdict = {
      approved:    true,
      by,
      at:          new Date().toISOString(),
      decision_id: decisionId,
      note: auto
        ? 'APPROVAL_AUTO_MODE activo — auto-aprobado (gate humano desactivado).'
        : `Monto $${amount.toFixed(2)} <= umbral $${gateThreshold()} — auto-aprobado sin gate.`,
    };
    store.resolve(decisionId, verdict);
    console.log(`[approval] auto-approve (${by}) decision=${decisionId} agent=${agent} action=${action} amount=$${amount.toFixed(2)}`);
    return verdict;
  }

  // GATE real: publica al bus y bloquea hasta el veredicto humano.
  console.log(`[approval] GATE decision=${decisionId} agent=${agent} action=${action} amount=$${amount.toFixed(2)} — esperando veredicto humano`);
  publish({
    from_agent:   agent,
    to_agent:     'panel-aprobaciones',
    type:         'request',
    payload:      { decision_id: decisionId, action, rationale: req?.rationale || '', evidence: req?.evidence || {}, amount_usd: amount },
    context_refs: [decisionId],
    requires_ack: true,
  });

  const timeoutMs = gateTimeoutMs();
  if (timeoutMs > 0) {
    return Promise.race([
      store.waitFor(decisionId),
      new Promise((resolve) => setTimeout(() => {
        const verdict = {
          approved:    false,
          by:          'timeout',
          at:          new Date().toISOString(),
          decision_id: decisionId,
          note:        `Sin veredicto humano en ${timeoutMs}ms — rechazado por timeout.`,
        };
        store.resolve(decisionId, verdict);
        resolve(verdict);
      }, timeoutMs)),
    ]);
  }
  return store.waitFor(decisionId);
}

/** El store de decisiones, expuesto para inspección / panel / tests. */
export { store as approvalStore };

/** Util para tests: resetea el store y re-instala el suscriptor del bus. */
export function _resetForTests() {
  store._resetForTests();
  _unsubscribe = subscribe('approval-gate', _panelVerdictHandler);
}

export default requestApproval;
