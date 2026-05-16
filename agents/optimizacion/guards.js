/**
 * GioLens — Agente Optimizacion · guards.js
 * Rol: Reglas duras que validan TODA propuesta antes de emitirla o ejecutarla.
 *
 * Capas:
 *   1) checkDeltaUsd(amount)  — gate de approval por monto ($50 USD threshold).
 *   2) isIrreversible(action) — bloquea si no hay rollback handler registrado.
 *   3) validateProposal(p)    — schema + reglas de negocio del dominio GioLens.
 *
 * Estas guards NO consultan al modelo. Son determinsticas, baratas, y se
 * ejecutan en graph.js antes de publicar al bus o invocar una tool mutante.
 */

import { has as hasRollbackHandler } from '../_shared/rollback.js';

export const APPROVAL_THRESHOLD_USD = 50;
export const MAX_BUDGET_INCREASE_PCT = 100; // no aumentar > 100% en una operacion
export const MIN_DAILY_BUDGET_MXN = 100;
export const MXN_PER_USD = 18; // aprox; TODO leer de config / FX live

// Acciones cuya naturaleza es irreversible salvo handler explicito.
const MUTATING_ACTIONS = new Set([
  'apply_budget_change',
  'pause_adset',
  'archive_adset',
  'delete_creative',
]);

// Mapa accion -> kind del rollback registry que debe existir.
const ACTION_TO_ROLLBACK_KIND = {
  apply_budget_change: 'budget_changed',
  pause_adset:         'adset_paused',
  archive_adset:       'adset_archived',
  delete_creative:     'creative_deleted',
};

/**
 * Decide si una operacion economica requiere approval humano.
 * @param {number} amount  USD absoluto (positivo)
 * @returns {{requires_approval: boolean, threshold: number, amount: number}}
 */
export function checkDeltaUsd(amount) {
  const n = Math.abs(Number(amount) || 0);
  return {
    requires_approval: n > APPROVAL_THRESHOLD_USD,
    threshold:         APPROVAL_THRESHOLD_USD,
    amount:            n,
  };
}

/**
 * Bloquea acciones mutantes sin handler de rollback registrado.
 * @param {string} action  nombre de la accion (ej. 'apply_budget_change')
 * @returns {{blocked: boolean, reason?: string}}
 */
export function isIrreversible(action) {
  if (!action) return { blocked: true, reason: 'action vacia' };
  if (!MUTATING_ACTIONS.has(action)) return { blocked: false };

  const kind = ACTION_TO_ROLLBACK_KIND[action];
  if (!kind) {
    return { blocked: true, reason: `accion '${action}' sin mapping a rollback kind` };
  }
  if (!hasRollbackHandler(kind)) {
    return {
      blocked: true,
      reason:  `rollback handler no registrado para kind='${kind}' (accion='${action}')`,
    };
  }
  return { blocked: false };
}

/**
 * Schema check + reglas de negocio sobre una proposal individual.
 * @param {object} p  proposal item segun forma del system prompt
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateProposal(p) {
  const errors = [];
  const warnings = [];

  if (!p || typeof p !== 'object') {
    return { ok: false, errors: ['proposal no es objeto'], warnings };
  }

  // ── Schema basico ────────────────────────────────────────────────────
  const requiredStr = ['priority', 'target', 'pipeline_id', 'current_state', 'proposed_change', 'expected_impact'];
  for (const k of requiredStr) {
    if (typeof p[k] !== 'string' || !p[k].trim()) errors.push(`campo '${k}' requerido (string no vacio)`);
  }
  if (!['low', 'medium', 'high', 'critical'].includes(p.priority)) {
    errors.push(`priority invalido: ${p.priority}`);
  }
  if (!['budget', 'segmentation', 'copy', 'angle'].includes(p.target)) {
    errors.push(`target invalido: ${p.target}`);
  }
  if (typeof p.requires_approval !== 'boolean') {
    errors.push('requires_approval debe ser boolean');
  }
  if (typeof p.estimated_delta_usd !== 'number' || Number.isNaN(p.estimated_delta_usd)) {
    errors.push('estimated_delta_usd debe ser number');
  }
  if (!p.evidence || typeof p.evidence !== 'object') {
    errors.push('evidence requerida (objeto)');
  }

  // Si ya hay errores de schema, no avanzar a reglas de negocio.
  if (errors.length > 0) return { ok: false, errors, warnings };

  // ── Reglas de negocio ─────────────────────────────────────────────────
  // Coherencia approval vs monto
  const gate = checkDeltaUsd(p.estimated_delta_usd);
  if (gate.requires_approval && !p.requires_approval) {
    errors.push(`requires_approval=false pero estimated_delta_usd=${p.estimated_delta_usd} excede threshold $${APPROVAL_THRESHOLD_USD}`);
  }

  // Reglas especificas de budget
  if (p.target === 'budget') {
    const ev = p.evidence || {};
    const current = Number(ev.current_value);
    const proposed = Number(ev.proposed_value ?? (current + Number(p.estimated_delta_usd || 0)));

    // No subir > 100% en una operacion
    if (Number.isFinite(current) && current > 0 && Number.isFinite(proposed)) {
      const pct = ((proposed - current) / current) * 100;
      if (pct > MAX_BUDGET_INCREASE_PCT) {
        errors.push(`aumento de budget ${pct.toFixed(1)}% excede max ${MAX_BUDGET_INCREASE_PCT}% en una sola operacion`);
      }
      // No bajar daily_budget por debajo de MIN_DAILY_BUDGET_MXN
      const proposedMxn = proposed * MXN_PER_USD;
      if (proposedMxn < MIN_DAILY_BUDGET_MXN) {
        errors.push(`daily_budget propuesto $${proposedMxn.toFixed(0)} MXN < min $${MIN_DAILY_BUDGET_MXN} MXN`);
      }
    } else {
      warnings.push('evidence.current_value/proposed_value no numericos — no se pudo validar reglas de budget');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export default { checkDeltaUsd, isIrreversible, validateProposal, APPROVAL_THRESHOLD_USD };
