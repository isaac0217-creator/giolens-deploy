/**
 * GioLens — inngest/functions/send-reactivation.js · tests del wiring C.2.4
 *
 * Cubre:
 *   - REGLA INVIOLABLE: silence_detected de 252999/273944 → blocker_violation.
 *   - D1-W3 (b) feature flag LEGACY_SEND_REACTIVATION_ENABLED:
 *       · true (default)  → path legacy copiloto inline.
 *       · false           → agente Creativo vía runWithTrace.
 *   - jitter (step.sleep), dry_run (REACTIVATION_DRY_RUN), emit reactivation_sent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EVENTS } from '../events.js';

const creativoMock = vi.fn();
vi.mock('../../agents/creativo/index.js', () => ({
  executeCreativoOnDemand: (...args) => creativoMock(...args),
}));

const { default: sendReactivation } = await import('../functions/send-reactivation.js');

function makeStep() {
  const ids = [];
  const events = [];
  const sleeps = [];
  return {
    ids,
    events,
    sleeps,
    run: async (id, fn) => { ids.push(id); return fn(); },
    sendEvent: async (id, ev) => { events.push({ id, ev }); return { ids: [] }; },
    sleep: async (id, dur) => { sleeps.push({ id, dur }); },
  };
}

const silenceEvent = (over = {}) => ({
  data: {
    contact_id: 'c1',
    pipeline_id: '216977',
    stage_name: 'INT2 · CATÁLOGO',
    silence_ms: 6 * 60 * 1000,
    correlation_id: 'corr-sr',
    ...over,
  },
});

const ENV_KEY = 'LEGACY_SEND_REACTIVATION_ENABLED';

beforeEach(() => {
  creativoMock.mockReset();
  creativoMock.mockResolvedValue({
    draft: {
      primary: 'Hola [NOMBRE], ¿pudiste revisar la opción que te compartí?',
      alternatives: ['¿Sigues interesado?'],
      urgencia: 'media',
    },
    cost_usd: 0.009,
    latency_ms: 8,
    error: null,
  });
});

afterEach(() => {
  delete process.env[ENV_KEY];
  vi.restoreAllMocks();
});

describe('send-reactivation — REGLA INVIOLABLE (defense-in-depth)', () => {
  it('252999 (SPY) → blocker_violation, NO envía INT', async () => {
    const step = makeStep();
    const out = await sendReactivation.handler({ event: silenceEvent({ pipeline_id: '252999' }), step });
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe('blocker_violation');
    expect(creativoMock).not.toHaveBeenCalled();
    const blocker = step.events.filter((e) => e.ev.name === 'giolens/agent.blocker_violation');
    expect(blocker).toHaveLength(1);
    const sent = step.events.filter((e) => e.ev.name === EVENTS.LEAD_REACTIVATION_SENT);
    expect(sent).toHaveLength(0);
  });

  it('273944 (GioVision) → blocker_violation', async () => {
    const step = makeStep();
    const out = await sendReactivation.handler({ event: silenceEvent({ pipeline_id: '273944' }), step });
    expect(out.reason).toBe('blocker_violation');
  });
});

describe('send-reactivation — feature flag LEGACY_SEND_REACTIVATION_ENABLED (D1-W3 b)', () => {
  it('flag=false → usa el agente Creativo (runWithTrace)', async () => {
    process.env[ENV_KEY] = 'false';
    const step = makeStep();
    const out = await sendReactivation.handler({ event: silenceEvent(), step });
    expect(out.sent).toBe(true);
    expect(out.script_source).toBe('creativo_agent');
    expect(creativoMock).toHaveBeenCalledTimes(1);
    expect(creativoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'reactivation',
        params: expect.objectContaining({ pipelineId: '216977' }),
        correlation_id: 'corr-sr',
      }),
    );
  });

  it('flag=true (default) → usa el path legacy copiloto, NO invoca Creativo', async () => {
    process.env[ENV_KEY] = 'true';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ script: 'Script legacy del copiloto', urgencia: 'alta' }),
    });
    const step = makeStep();
    const out = await sendReactivation.handler({ event: silenceEvent(), step });
    expect(out.sent).toBe(true);
    expect(out.script_source).toBe('legacy_copiloto');
    expect(creativoMock).not.toHaveBeenCalled();
  });
});

describe('send-reactivation — jitter, dry_run y emisión', () => {
  beforeEach(() => { process.env[ENV_KEY] = 'false'; });

  it('aplica jitter vía step.sleep', async () => {
    const step = makeStep();
    await sendReactivation.handler({ event: silenceEvent(), step });
    expect(step.sleeps).toHaveLength(1);
    expect(step.sleeps[0].id).toBe('jitter');
  });

  it('respeta REACTIVATION_DRY_RUN (default dry) y arma wapify_payload', async () => {
    const step = makeStep();
    const out = await sendReactivation.handler({ event: silenceEvent(), step });
    expect(out.dry_run).toBe(true);
    expect(out.send_result.dry_run).toBe(true);
    expect(out.send_result.wapify_payload).toEqual(
      expect.objectContaining({ contact_id: 'c1', type: 'text' }),
    );
  });

  it('emite lead.reactivation_sent con script_source y dry_run', async () => {
    const step = makeStep();
    await sendReactivation.handler({ event: silenceEvent(), step });
    const sent = step.events.filter((e) => e.ev.name === EVENTS.LEAD_REACTIVATION_SENT);
    expect(sent).toHaveLength(1);
    expect(sent[0].ev.data.correlation_id).toBe('corr-sr');
    expect(sent[0].ev.data.script_source).toBe('creativo_agent');
    expect(sent[0].ev.data.dry_run).toBe(true);
  });

  it('aborta sin script (creativo sin draft) → skipped no_script', async () => {
    creativoMock.mockResolvedValue({ draft: null, cost_usd: 0, error: 'parse_failed' });
    const step = makeStep();
    const out = await sendReactivation.handler({ event: silenceEvent(), step });
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe('no_script');
  });
});
