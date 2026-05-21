/**
 * GioLens — Frente C · C.3 · tests del gate de aprobación (backend).
 *
 * Cubre los dos modos de `approval.js`:
 *   - AUTO (default): auto-aprueba sin gate — mantiene verde a sim-agents.
 *   - GATE (APPROVAL_AUTO_MODE=false): bloquea hasta veredicto humano vía bus,
 *     con auto-aprobación bajo umbral y timeout opcional.
 * Y la idempotencia del `approval-store`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { publish, _resetForTests as busReset } from '../bus.js';
import { requestApproval, approvalStore, _resetForTests as approvalReset } from '../approval.js';

beforeEach(() => {
  delete process.env.APPROVAL_AUTO_MODE;
  delete process.env.APPROVAL_GATE_THRESHOLD_USD;
  delete process.env.APPROVAL_TIMEOUT_MS;
  busReset();        // borra todos los listeners del bus
  approvalReset();   // resetea el store y re-instala el suscriptor del bus
});

describe('C.3 — modo AUTO (default · kill-switch)', () => {
  it('auto-aprueba sin gate y registra en el historial', async () => {
    const verdict = await requestApproval({ decision_id: 'd-auto', agent: 'creativo', action: 'create_ad' });
    expect(verdict.approved).toBe(true);
    expect(verdict.by).toBe('auto-mode');
    expect(verdict.decision_id).toBe('d-auto');
    expect(approvalStore.getHistory().some((h) => h.decision_id === 'd-auto')).toBe(true);
    expect(approvalStore.getPending()).toHaveLength(0);
  });
});

describe('C.3 — modo GATE (APPROVAL_AUTO_MODE=false)', () => {
  it('bloquea hasta que el panel publica el veredicto en el bus', async () => {
    process.env.APPROVAL_AUTO_MODE = 'false';
    const p = requestApproval({
      decision_id: 'd-gate', agent: 'optimizacion', action: 'increase_budget', amount_usd: 200,
    });
    // queda pendiente — nadie respondió aún
    expect(approvalStore.getPending().map((d) => d.decision_id)).toContain('d-gate');

    // el panel humano publica su veredicto
    publish({
      from_agent: 'panel', to_agent: 'approval-gate', type: 'response',
      context_refs: ['d-gate'], payload: { approved: true, by: 'isaac', note: 'ok' },
    });

    const verdict = await p;
    expect(verdict.approved).toBe(true);
    expect(verdict.by).toBe('isaac');
    expect(approvalStore.getPending()).toHaveLength(0);
    expect(approvalStore.getHistory().at(-1).decision_id).toBe('d-gate');
  });

  it('un rechazo del panel resuelve con approved=false', async () => {
    process.env.APPROVAL_AUTO_MODE = 'false';
    const p = requestApproval({ decision_id: 'd-rej', agent: 'desarrollador', action: 'apply_patch', amount_usd: 999 });
    publish({
      from_agent: 'panel', to_agent: 'approval-gate', type: 'response',
      context_refs: ['d-rej'], payload: { approved: false, by: 'isaac' },
    });
    const verdict = await p;
    expect(verdict.approved).toBe(false);
  });

  it('monto <= umbral se auto-aprueba sin gate (by=auto-threshold)', async () => {
    process.env.APPROVAL_AUTO_MODE = 'false';
    const verdict = await requestApproval({ decision_id: 'd-low', agent: 'optimizacion', action: 'x', amount_usd: 10 });
    expect(verdict.approved).toBe(true);
    expect(verdict.by).toBe('auto-threshold');
  });

  it('timeout rechaza la decisión si no llega veredicto', async () => {
    process.env.APPROVAL_AUTO_MODE = 'false';
    process.env.APPROVAL_TIMEOUT_MS = '60';
    const verdict = await requestApproval({ decision_id: 'd-to', agent: 'x', action: 'y', amount_usd: 500 });
    expect(verdict.approved).toBe(false);
    expect(verdict.by).toBe('timeout');
  });
});

describe('C.3 — approval-store: idempotencia', () => {
  it('register es idempotente por decision_id', () => {
    approvalStore.register({ decision_id: 'dup', agent: 'a', action: 'b', amount_usd: 1 });
    approvalStore.register({ decision_id: 'dup', agent: 'a', action: 'b', amount_usd: 1 });
    expect(approvalStore.getPending().filter((d) => d.decision_id === 'dup')).toHaveLength(1);
  });

  it('resolver dos veces no duplica historial', () => {
    approvalStore.register({ decision_id: 'r2', agent: 'a', action: 'b' });
    const v = { approved: true, by: 'x', at: new Date().toISOString(), decision_id: 'r2' };
    approvalStore.resolve('r2', v);
    approvalStore.resolve('r2', v);
    expect(approvalStore.getHistory().filter((h) => h.decision_id === 'r2')).toHaveLength(1);
  });
});
