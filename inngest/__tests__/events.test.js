/**
 * GioLens — inngest/events.js · tests del validator makeEvent (C.0.11)
 */

import { describe, it, expect, vi } from 'vitest';
import { EVENTS, EVENTS_EXPERIMENTAL, makeEvent } from '../events.js';

describe('makeEvent', () => {
  it('construye evento válido con correlation_id', () => {
    const ev = makeEvent(EVENTS.SEGMENTATION_REQUESTED, {
      correlation_id: 'corr-1',
      pipeline_ids: ['216977'],
    });
    expect(ev).toEqual({
      name: 'giolens/segmentation.requested',
      data: { correlation_id: 'corr-1', pipeline_ids: ['216977'] },
    });
  });

  it('clona el payload (no muta el original)', () => {
    const payload = { correlation_id: 'corr-2' };
    const ev = makeEvent(EVENTS.ARBITRAGE_REQUESTED, payload);
    ev.data.injected = true;
    expect(payload.injected).toBeUndefined();
  });

  it('lanza si falta correlation_id', () => {
    expect(() => makeEvent(EVENTS.LEAD_MESSAGE_RECEIVED, { contact_id: 'c1' }))
      .toThrow(/correlation_id obligatorio/);
  });

  it('lanza si correlation_id no es string', () => {
    expect(() => makeEvent(EVENTS.LEAD_MESSAGE_RECEIVED, { correlation_id: 123 }))
      .toThrow(/correlation_id obligatorio/);
  });

  it('lanza si name vacío o no string', () => {
    expect(() => makeEvent('', { correlation_id: 'x' })).toThrow(/name requerido/);
    expect(() => makeEvent(null, { correlation_id: 'x' })).toThrow(/name requerido/);
  });

  it('lanza si payload no es objeto', () => {
    expect(() => makeEvent(EVENTS.SYNC_WAPIFY_PULL, null)).toThrow(/payload requerido/);
    expect(() => makeEvent(EVENTS.SYNC_WAPIFY_PULL, [1, 2])).toThrow(/payload requerido/);
  });

  it('acepta eventos experimentales del catálogo', () => {
    const ev = makeEvent(EVENTS_EXPERIMENTAL.CAMPAIGN_BATCH_VARIANT_REQUESTED, {
      correlation_id: 'corr-3',
    });
    expect(ev.name).toBe('giolens/campaign.batch_variant_requested');
  });

  it('avisa (no bloquea) si name fuera del catálogo', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ev = makeEvent('giolens/agent.qa_report', { correlation_id: 'corr-4' });
    expect(ev.name).toBe('giolens/agent.qa_report');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
