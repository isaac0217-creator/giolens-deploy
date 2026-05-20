/**
 * GioLens — inngest/functions/distill-conversation.js · tests del wiring C.2.5
 *
 * Cubre el handler: invocación de analista.distillBatch vía runWithTrace,
 * batch vacío, claves de step deterministas (R5).
 *
 * distillBatch se mockea: el wiring no debe depender de Anthropic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const distillBatchMock = vi.fn();
vi.mock('../../agents/analista/index.js', () => ({
  distillBatch: (...args) => distillBatchMock(...args),
  executeAnalistaDailyRun: vi.fn(),
}));

const { default: distillConversation } = await import('../functions/distill-conversation.js');

function makeStep() {
  const ids = [];
  return {
    ids,
    run: async (id, fn) => { ids.push(id); return fn(); },
    sendEvent: async () => ({ ids: [] }),
    sleep: async () => {},
  };
}

beforeEach(() => {
  distillBatchMock.mockReset();
  distillBatchMock.mockResolvedValue({
    distilled: [
      { contact_id: 'c1', summary: 's1', sentiment: 'neutral', next_action: 'a1', objections: [] },
      { contact_id: 'c2', summary: 's2', sentiment: 'positivo', next_action: 'a2', objections: [] },
    ],
    cost_usd: 0.004,
    latency_ms: 11,
    model: 'claude-haiku-4-5',
    error: null,
  });
});

describe('distill-conversation handler (C.2.5 wiring)', () => {
  it('batch vacío → skipped', async () => {
    const step = makeStep();
    const out = await distillConversation.handler({ event: { data: { contact_ids: [] } }, step });
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe('empty_batch');
    expect(distillBatchMock).not.toHaveBeenCalled();
  });

  it('invoca analista.distillBatch vía runWithTrace con correlation_id', async () => {
    const step = makeStep();
    const out = await distillConversation.handler({
      event: { data: { contact_ids: ['c1', 'c2'], pipeline_id: '216977', correlation_id: 'corr-d' } },
      step,
    });
    expect(distillBatchMock).toHaveBeenCalledTimes(1);
    expect(distillBatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ correlation_id: 'corr-d' }),
    );
    expect(out.processed).toBe(2);
    expect(out.distill.cost_usd).toBe(0.004);
    expect(out.distill.trace_ok).toBe(true);
    expect(out.distill.error).toBeNull();
  });

  it('R5: la clave del step de distilación incluye el correlation_id', async () => {
    const step = makeStep();
    await distillConversation.handler({
      event: { data: { contact_ids: ['c1'], pipeline_id: '216977', correlation_id: 'corr-det' } },
      step,
    });
    expect(step.ids).toContain('claude-distill-corr-det');
    expect(step.ids).toContain('upsert-supabase-corr-det');
  });

  it('genera correlation_id si el evento no lo trae', async () => {
    const step = makeStep();
    const out = await distillConversation.handler({
      event: { data: { contact_ids: ['c1'], pipeline_id: '216977' } },
      step,
    });
    expect(out.correlation_id).toMatch(/^distill-\d+$/);
  });

  it('recorta el lote a BATCH_SIZE (50)', async () => {
    const step = makeStep();
    const many = Array.from({ length: 70 }, (_, i) => `c${i}`);
    await distillConversation.handler({
      event: { data: { contact_ids: many, pipeline_id: '216977', correlation_id: 'corr-big' } },
      step,
    });
    const passed = distillBatchMock.mock.calls[0][0].conversations;
    expect(passed).toHaveLength(50);
  });
});
