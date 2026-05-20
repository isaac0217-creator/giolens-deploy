/**
 * GioLens — inngest/functions/run-arbitraje.js · tests del wiring C.2.2
 *
 * Cubre:
 *   - handler invoca al agente Analista vía runWithTrace (period:'last_6h').
 *   - D2-W3 (c): approval_gate_threshold_usd se surface (env var, default 50).
 *   - R5: clave de step del análisis incluye correlation_id.
 *   - Step 5: fatigue events emitidos para campañas 🔴.
 *
 * El agente Analista se mockea: el wiring no debe depender de Anthropic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EVENTS } from '../events.js';

const analistaMock = vi.fn();
vi.mock('../../agents/analista/index.js', () => ({
  executeAnalistaDailyRun: (...args) => analistaMock(...args),
}));

const { default: runArbitraje } = await import('../functions/run-arbitraje.js');

/** step mock: ejecuta fn, registra ids/eventos, permite overrides por step id. */
function makeStep(overrides = {}) {
  const ids = [];
  const events = [];
  return {
    ids,
    events,
    run: async (id, fn) => {
      ids.push(id);
      for (const key of Object.keys(overrides)) {
        if (id === key || id.startsWith(`${key}-`)) return overrides[key];
      }
      return fn();
    },
    sendEvent: async (id, ev) => { events.push({ id, ev }); return { ids: [] }; },
    sleep: async () => {},
  };
}

beforeEach(() => {
  analistaMock.mockReset();
  analistaMock.mockResolvedValue({
    insights: [{ severity: 'medium' }, { severity: 'low' }],
    published: 1,
    cost_usd: 0.0345,
    latency_ms: 12,
    errors: [],
  });
});

describe('run-arbitraje handler (C.2.2 wiring)', () => {
  it('invoca al agente Analista vía runWithTrace con period last_6h', async () => {
    const step = makeStep();
    const out = await runArbitraje.handler({
      event: { data: { correlation_id: 'corr-arb-1' } },
      step,
    });
    expect(analistaMock).toHaveBeenCalledTimes(1);
    expect(analistaMock).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'last_6h', correlation_id: 'corr-arb-1' }),
    );
    expect(out.analista.insights).toBe(2);
    expect(out.analista.cost_usd).toBe(0.0345);
    expect(out.analista.trace_ok).toBe(true);
    expect(out.recos_count).toBe(2);
  });

  it('D2-W3 (c): surface approval_gate_threshold_usd (default 50)', async () => {
    const step = makeStep();
    const out = await runArbitraje.handler({ event: { data: {} }, step });
    expect(out.approval_gate_threshold_usd).toBe(50);
  });

  it('R5: la clave del step de análisis incluye el correlation_id', async () => {
    const step = makeStep();
    await runArbitraje.handler({ event: { data: { correlation_id: 'corr-det' } }, step });
    expect(step.ids).toContain('analista-recos-corr-det');
  });

  it('genera correlation_id si el evento no lo trae', async () => {
    const step = makeStep();
    const out = await runArbitraje.handler({ event: { data: {} }, step });
    expect(out.correlation_id).toMatch(/^arbitraje-\d+$/);
  });

  it('emite campaign.fatigue_detected por cada campaña 🔴', async () => {
    const step = makeStep({
      'score-campaigns': [
        { campaign_id: 'c1', pipeline: 'GioSports', semaforo: '🔴', ctr_drop_pct: 30, cpc_rise_pct: 20 },
        { campaign_id: 'c2', pipeline: 'Dama', semaforo: '🟡', ctr_drop_pct: 5, cpc_rise_pct: 2 },
      ],
    });
    const out = await runArbitraje.handler({
      event: { data: { correlation_id: 'corr-fat' } },
      step,
    });
    expect(out.fatigue_emitted).toBe(1);
    const fatigue = step.events.filter((e) => e.ev.name === EVENTS.CAMPAIGN_FATIGUE_DETECTED);
    expect(fatigue).toHaveLength(1);
    expect(fatigue[0].ev.data.campaign_id).toBe('c1');
    expect(fatigue[0].ev.data.correlation_id).toBe('corr-fat-c1');
  });

  it('no invoca al agente más de una vez por run (no doble cobro)', async () => {
    const step = makeStep();
    await runArbitraje.handler({ event: { data: { correlation_id: 'corr-once' } }, step });
    expect(analistaMock).toHaveBeenCalledTimes(1);
  });
});
