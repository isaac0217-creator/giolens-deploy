/**
 * Frente E · PATCH 2 — verificación del filter client-side en
 * `api/cron/alertas-stock-bajo.ts`.
 *
 * Cubre el bug que CHECK 2 expuso: supabase-js no soporta column-vs-column en
 * `.filter('stock_actual', 'lte', 'stock_minimo')` (trata el 2º arg como literal
 * string, intenta parsearlo como integer y revienta). El patch elimina esa
 * llamada y aplica el filtro en JS sobre el resultado del SELECT.
 *
 * Tests:
 *   1. Set mixto (algunos bajo umbral, otros no) → solo bajos alertados
 *   2. Universo vacío → respuesta `{alertas_enviadas:0, productos_bajos:0, universo:0}`
 *   3. Verificar que `.filter()` NO se invoca en la chain (regresión-proof
 *      contra la versión rota anterior)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let chainCalls;
let universoData;
let createClientMock;
let sendWhatsAppMock;
let insertMock;

function makeProductosChain() {
  const calls = {
    select: [], gt: [], eq: [], filter: [], order: [],
  };
  const chain = {
    _calls: calls,
    select(cols, opts) { calls.select.push({ cols, opts }); return chain; },
    gt(c, v) { calls.gt.push({ c, v }); return chain; },
    eq(c, v) { calls.eq.push({ c, v }); return chain; },
    filter(c, op, v) { calls.filter.push({ c, op, v }); return chain; },
    order(c, opts) { calls.order.push({ c, opts }); return Promise.resolve({ data: universoData, error: null }); },
  };
  return chain;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
  process.env.CRON_SECRET = 'test_cron';
  process.env.WHATSAPP_ISAAC = '+52555';

  universoData = [];
  insertMock = vi.fn().mockResolvedValue({ error: null });
  sendWhatsAppMock = vi.fn().mockResolvedValue({ ok: true, retries: 0, message_id: 'mWA' });

  const productosChain = makeProductosChain();
  chainCalls = productosChain._calls;

  const agentDecisionsChain = {
    select() { return this; },
    eq() { return this; },
    gte() { return Promise.resolve({ data: [], error: null }); },
  };

  createClientMock = vi.fn(() => ({
    from: vi.fn((tbl) => {
      if (tbl === 'productos') return productosChain;
      if (tbl === 'agent_decisions') {
        return {
          select: agentDecisionsChain.select.bind(agentDecisionsChain),
          insert: insertMock,
        };
      }
      return {};
    }),
  }));
});

function makeReq(overrides = {}) {
  return { method: 'POST', headers: { authorization: 'Bearer test_cron' }, ...overrides };
}
function makeRes() {
  return {
    statusCode: null, jsonBody: null, headers: {},
    setHeader(n, v) { this.headers[n] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    end() { return this; },
  };
}

async function loadHandler() {
  vi.resetModules();
  vi.doMock('@supabase/supabase-js', () => ({ createClient: createClientMock }));
  vi.doMock('../../agents/_shared/providers/wapify-notify', () => ({
    sendWhatsApp: sendWhatsAppMock,
  }));
  return (await import('../../api/cron/alertas-stock-bajo.ts')).default;
}

describe('Frente E · PATCH 2 · alertas-stock-bajo filter client-side', () => {
  it('set MIXTO (5 productos, 3 bajo umbral) → SOLO esos 3 alertados', async () => {
    universoData = [
      // Estos 3 SÍ son "bajos" (stock <= mínimo)
      { slug: 'A', nombre: 'lente A', stock_actual: 0, stock_minimo: 5, categoria: 'l', estado: 'activo' },
      { slug: 'B', nombre: 'lente B', stock_actual: 2, stock_minimo: 5, categoria: 'l', estado: 'activo' },
      { slug: 'C', nombre: 'lente C', stock_actual: 3, stock_minimo: 3, categoria: 'l', estado: 'activo' },
      // Estos 2 NO son bajos
      { slug: 'D', nombre: 'lente D', stock_actual: 10, stock_minimo: 5, categoria: 'l', estado: 'activo' },
      { slug: 'E', nombre: 'lente E', stock_actual: 6, stock_minimo: 5, categoria: 'l', estado: 'activo' },
    ];
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.alertas_enviadas).toBe(3);
    expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);

    const mensaje = sendWhatsAppMock.mock.calls[0][1];
    expect(mensaje).toContain('Stock bajo (3 SKUs)');
    expect(mensaje).toContain('A '); // espacio para no matchear sub-substrings
    expect(mensaje).toContain('B ');
    expect(mensaje).toContain('C ');
    expect(mensaje).not.toContain('lente D'); // D no es bajo
    expect(mensaje).not.toContain('lente E'); // E no es bajo
  });

  it('universo VACÍO → {alertas_enviadas:0, productos_bajos:0, universo:0}', async () => {
    universoData = [];
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.alertas_enviadas).toBe(0);
    expect(res.jsonBody.productos_bajos).toBe(0);
    expect(res.jsonBody.universo).toBe(0);
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
  });

  it('regresión-proof: handler NO invoca .filter() en la chain (era el bug)', async () => {
    universoData = [
      { slug: 'X', nombre: 'X', stock_actual: 0, stock_minimo: 1, categoria: 'l', estado: 'activo' },
    ];
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);

    // El patch removió .filter() de la cadena. Si reaparece, fallamos acá.
    expect(chainCalls.filter).toHaveLength(0);
    // Pero sí se llaman .select(), .gt() para stock_minimo > 0, .eq() para estado, .order()
    expect(chainCalls.select.length).toBeGreaterThan(0);
    expect(chainCalls.gt).toContainEqual({ c: 'stock_minimo', v: 0 });
    expect(chainCalls.eq).toContainEqual({ c: 'estado', v: 'activo' });
    expect(chainCalls.order).toHaveLength(1);
  });

  it('universo con productos pero NINGUNO bajo (todos stock>minimo) → 0 alertas', async () => {
    universoData = [
      { slug: 'F', nombre: 'F', stock_actual: 100, stock_minimo: 10, categoria: 'l', estado: 'activo' },
      { slug: 'G', nombre: 'G', stock_actual: 50, stock_minimo: 5, categoria: 'l', estado: 'activo' },
    ];
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.alertas_enviadas).toBe(0);
    expect(res.jsonBody.productos_bajos).toBe(0);
    expect(res.jsonBody.universo).toBe(2); // los 2 candidatos del fetch, pero ninguno bajo
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
  });
});
