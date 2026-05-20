/**
 * GioLens — Frente C · C.2.7 · validación de idempotencia
 *
 * "Mismo correlation_id → no doble cobro Anthropic."
 *
 * Cubre dos capas:
 *   1. WITHIN-RUN (R5 · mecanismo prescrito): las claves de `step.run` de los
 *      pasos que cuestan Anthropic son deterministas (incluyen correlation_id).
 *      Inngest memoiza los steps completados por id → un retry del run NO
 *      re-ejecuta el step ni re-cobra. Se simula con un `step` que memoiza.
 *   2. CROSS-RUN (config): send-reactivation y distill-conversation declaran
 *      `idempotency: 'event.data.correlation_id'` → re-disparo del mismo evento
 *      es dedupeado por Inngest Cloud.
 *
 * Los agentes se mockean: la validación no debe depender de Anthropic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const optimizacionMock = vi.fn();
const analistaMock = vi.fn();
const distillBatchMock = vi.fn();
const creativoMock = vi.fn();

vi.mock('../../agents/optimizacion/index.js', () => ({
  executeOptimizacionDailyRun: (...a) => optimizacionMock(...a),
}));
vi.mock('../../agents/analista/index.js', () => ({
  executeAnalistaDailyRun: (...a) => analistaMock(...a),
  distillBatch: (...a) => distillBatchMock(...a),
}));
vi.mock('../../agents/creativo/index.js', () => ({
  executeCreativoOnDemand: (...a) => creativoMock(...a),
}));

const { default: runMicroseg }       = await import('../functions/run-microseg.js');
const { default: runArbitraje }      = await import('../functions/run-arbitraje.js');
const { default: sendReactivation }  = await import('../functions/send-reactivation.js');
const { default: distillConversation } = await import('../functions/distill-conversation.js');

/** step mock simple: registra ids, ejecuta fn. */
function plainStep() {
  const ids = [];
  return {
    ids,
    run: async (id, fn) => { ids.push(id); return fn(); },
    sendEvent: async () => ({ ids: [] }),
    sleep: async () => {},
  };
}

/** step mock que MEMOIZA por id — simula el checkpointing de Inngest entre retries. */
function memoStep(cache = new Map()) {
  const ids = [];
  const executed = [];
  return {
    cache,
    ids,
    executed,
    run: async (id, fn) => {
      ids.push(id);
      if (cache.has(id)) return cache.get(id);
      executed.push(id);
      const v = await fn();
      cache.set(id, v);
      return v;
    },
    sendEvent: async () => ({ ids: [] }),
    sleep: async () => {},
  };
}

beforeEach(() => {
  optimizacionMock.mockReset();
  optimizacionMock.mockResolvedValue({ proposals: [], validated: [], blocked: [], cost_usd: 0.02, latency_ms: 5, errors: [] });
  analistaMock.mockReset();
  analistaMock.mockResolvedValue({ insights: [], published: 0, cost_usd: 0.03, latency_ms: 5, errors: [] });
  distillBatchMock.mockReset();
  distillBatchMock.mockResolvedValue({ distilled: [], cost_usd: 0.01, latency_ms: 5, model: 'claude-haiku-4-5', error: null });
  creativoMock.mockReset();
  creativoMock.mockResolvedValue({ draft: { primary: 'hola' }, cost_usd: 0.005, latency_ms: 5, error: null });
});

describe('C.2.7 — claves de step deterministas (within-run · R5)', () => {
  it('run-microseg: mismo correlation_id → mismas claves de step', async () => {
    const a = plainStep();
    const b = plainStep();
    await runMicroseg.handler({ event: { data: { correlation_id: 'corr-X' } }, step: a });
    await runMicroseg.handler({ event: { data: { correlation_id: 'corr-X' } }, step: b });
    expect(a.ids).toEqual(b.ids);
    expect(a.ids).toContain('optimizacion-analysis-corr-X');
  });

  it('run-arbitraje: mismo correlation_id → mismas claves de step', async () => {
    const a = plainStep();
    const b = plainStep();
    await runArbitraje.handler({ event: { data: { correlation_id: 'corr-Y' } }, step: a });
    await runArbitraje.handler({ event: { data: { correlation_id: 'corr-Y' } }, step: b });
    expect(a.ids).toEqual(b.ids);
    expect(a.ids).toContain('analista-recos-corr-Y');
  });

  it('distill-conversation: mismo correlation_id → mismas claves de step', async () => {
    const a = plainStep();
    const b = plainStep();
    const ev = { event: { data: { contact_ids: ['c1'], pipeline_id: '216977', correlation_id: 'corr-Z' } } };
    await distillConversation.handler({ ...ev, step: a });
    await distillConversation.handler({ ...ev, step: b });
    expect(a.ids).toEqual(b.ids);
    expect(a.ids).toContain('claude-distill-corr-Z');
  });
});

describe('C.2.7 — no doble cobro: retry reusa steps memoizados', () => {
  it('run-microseg: retry del run NO re-invoca al agente Optimizacion', async () => {
    const cache = new Map();
    // Intento 1 (run completo).
    const s1 = memoStep(cache);
    await runMicroseg.handler({ event: { data: { correlation_id: 'corr-R1' } }, step: s1 });
    expect(optimizacionMock).toHaveBeenCalledTimes(1);
    // Intento 2 (retry): mismo cache → todos los steps hacen cache-hit.
    const s2 = memoStep(cache);
    await runMicroseg.handler({ event: { data: { correlation_id: 'corr-R1' } }, step: s2 });
    expect(optimizacionMock).toHaveBeenCalledTimes(1); // NO re-cobró
    expect(s2.executed).toHaveLength(0);               // 0 steps re-ejecutados
  });

  it('distill-conversation: retry del run NO re-invoca distillBatch', async () => {
    const cache = new Map();
    const ev = { event: { data: { contact_ids: ['c1', 'c2'], pipeline_id: '216977', correlation_id: 'corr-R2' } } };
    const s1 = memoStep(cache);
    await distillConversation.handler({ ...ev, step: s1 });
    expect(distillBatchMock).toHaveBeenCalledTimes(1);
    const s2 = memoStep(cache);
    await distillConversation.handler({ ...ev, step: s2 });
    expect(distillBatchMock).toHaveBeenCalledTimes(1);
    expect(s2.executed).toHaveLength(0);
  });

  it('run-arbitraje: retry del run NO re-invoca al agente Analista', async () => {
    const cache = new Map();
    const s1 = memoStep(cache);
    await runArbitraje.handler({ event: { data: { correlation_id: 'corr-R3' } }, step: s1 });
    expect(analistaMock).toHaveBeenCalledTimes(1);
    const s2 = memoStep(cache);
    await runArbitraje.handler({ event: { data: { correlation_id: 'corr-R3' } }, step: s2 });
    expect(analistaMock).toHaveBeenCalledTimes(1);
  });
});

describe('C.2.7 — idempotencia cross-run (config Inngest)', () => {
  it('send-reactivation declara idempotency por correlation_id', () => {
    expect(sendReactivation.config.idempotency).toBe('event.data.correlation_id');
  });

  it('distill-conversation declara idempotency por correlation_id', () => {
    expect(distillConversation.config.idempotency).toBe('event.data.correlation_id');
  });

  it('retries acotados (PRE-3 spirit): ningún function supera 2 retries', () => {
    expect(runMicroseg.config.retries).toBeLessThanOrEqual(2);
    expect(runArbitraje.config.retries).toBeLessThanOrEqual(2);
    expect(sendReactivation.config.retries).toBeLessThanOrEqual(2);
    expect(distillConversation.config.retries).toBeLessThanOrEqual(2);
  });
});
