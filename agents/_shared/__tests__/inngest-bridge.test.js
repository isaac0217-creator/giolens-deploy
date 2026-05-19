/**
 * GioLens — inngest-bridge.js · tests del adapter bus ↔ inngest (C.0.7)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { toInngestEvent, toBusMsg, publishBridged } from '../inngest-bridge.js';

const BUS_MSG = {
  from_agent: 'analista',
  to_agent: 'orquestador',
  type: 'agent_message',
  payload: { severity: 'high', metric: 'CPR' },
  context_refs: ['dec-42'],
  requires_ack: true,
  created_at: '2026-05-19T00:00:00.000Z',
};

describe('toInngestEvent', () => {
  it('traduce bus msg a evento Inngest con namespace giolens/agent.*', () => {
    const ev = toInngestEvent(BUS_MSG);
    expect(ev.name).toBe('giolens/agent.agent_message');
    expect(ev.data.from_agent).toBe('analista');
    expect(ev.data.to_agent).toBe('orquestador');
    expect(ev.data.bus_type).toBe('agent_message');
    expect(ev.data.payload).toEqual({ severity: 'high', metric: 'CPR' });
  });

  it('usa context_refs[0] como correlation_id', () => {
    expect(toInngestEvent(BUS_MSG).data.correlation_id).toBe('dec-42');
  });

  it('genera correlation_id si no hay context_refs', () => {
    const ev = toInngestEvent({ ...BUS_MSG, context_refs: [] });
    expect(ev.data.correlation_id).toMatch(/^bus-analista-/);
  });

  it('lanza si falta from_agent/to_agent/type', () => {
    expect(() => toInngestEvent({ from_agent: 'x', to_agent: 'y' })).toThrow(/requiere/);
    expect(() => toInngestEvent(null)).toThrow(/objeto/);
  });
});

describe('toBusMsg', () => {
  it('roundtrip: toBusMsg(toInngestEvent(x)) preserva campos canónicos', () => {
    const back = toBusMsg(toInngestEvent(BUS_MSG));
    expect(back.from_agent).toBe('analista');
    expect(back.to_agent).toBe('orquestador');
    expect(back.type).toBe('agent_message');
    expect(back.payload).toEqual({ severity: 'high', metric: 'CPR' });
    expect(back.requires_ack).toBe(true);
  });

  it('tolera eventos que no nacieron del bridge', () => {
    const bus = toBusMsg({ name: 'giolens/lead.silence_detected', data: { correlation_id: 'c1' } });
    expect(bus.type).toBe('giolens/lead.silence_detected');
    expect(bus.from_agent).toBe('inngest');
    expect(bus.to_agent).toBe('*');
  });

  it('lanza si event sin name', () => {
    expect(() => toBusMsg({ data: {} })).toThrow(/name/);
  });
});

describe('publishBridged', () => {
  const origKey = process.env.INNGEST_EVENT_KEY;
  afterEach(() => {
    if (origKey === undefined) delete process.env.INNGEST_EVENT_KEY;
    else process.env.INNGEST_EVENT_KEY = origKey;
  });

  it('sin INNGEST_EVENT_KEY: publica al bus, no emite Inngest', async () => {
    delete process.env.INNGEST_EVENT_KEY;
    const r = await publishBridged(BUS_MSG);
    expect(r.busResult.from_agent).toBe('analista');
    expect(r.inngestSent).toBe(false);
    expect(r.inngestError).toBeNull();
  });
});
