/**
 * GioLens — bus.js tests (Vitest)
 * Correr con: npx vitest run agents/_shared/__tests__/bus.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { publish, subscribe, _resetForTests } from '../bus.js';

describe('bus.js — in-memory pub/sub', () => {
  beforeEach(() => _resetForTests());

  it('entrega un mensaje al suscriptor con to_agent exacto', () => {
    const received = [];
    subscribe('analista', (m) => received.push(m));
    publish({ from_agent: 'orquestador', to_agent: 'analista', type: 'request', payload: { q: 'kpis' } });
    expect(received.length).toBe(1);
    expect(received[0].from_agent).toBe('orquestador');
    expect(received[0].payload.q).toBe('kpis');
    expect(received[0].created_at).toMatch(/T.*Z$/);
  });

  it('broadcast con to_agent="*" llega a todos los agentes suscritos', () => {
    const a = [], b = [];
    subscribe('analista',    (m) => a.push(m));
    subscribe('optimizacion', (m) => b.push(m));
    publish({ from_agent: 'orquestador', to_agent: '*', type: 'event', payload: {} });
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });

  it('no entrega mensajes dirigidos a otro agente', () => {
    const received = [];
    subscribe('qa', (m) => received.push(m));
    publish({ from_agent: 'orquestador', to_agent: 'analista', type: 'request' });
    expect(received.length).toBe(0);
  });

  it('unsubscribe deja de recibir', () => {
    const received = [];
    const off = subscribe('analista', (m) => received.push(m));
    off();
    publish({ from_agent: 'orquestador', to_agent: 'analista', type: 'request' });
    expect(received.length).toBe(0);
  });

  it('throws si faltan campos obligatorios', () => {
    expect(() => publish({})).toThrow();
    expect(() => publish({ from_agent: 'x' })).toThrow();
  });

  it('normaliza context_refs y requires_ack', () => {
    const received = [];
    subscribe('analista', (m) => received.push(m));
    publish({ from_agent: 'o', to_agent: 'analista', type: 'request' });
    expect(received[0].context_refs).toEqual([]);
    expect(received[0].requires_ack).toBe(false);
  });
});
