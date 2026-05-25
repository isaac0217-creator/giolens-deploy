/**
 * Frente E · tests del handler GET `/api/inventario/movimientos`.
 *
 * Cubre:
 *   - 405 method != GET
 *   - 400 invalid_tipo / invalid_desde / invalid_hasta
 *   - 200 default (orden created_at desc, limit 100)
 *   - filtros: slug, tipo, desde, hasta
 *   - alias `sku` también funciona como filtro de slug
 *   - Cache-Control 60s
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let chainState;
let createClientMock;

function makeChain() {
  const calls = { from: null, eq: [], gte: [], lt: [], order: null, range: null };
  let result = { data: [{ id: 1, producto_slug: 'a1', tipo: 'entrada', cantidad: 5 }], count: 1, error: null };

  const chain = {
    _calls: calls,
    _setResult(r) { result = r; },
    select(cols, opts) { calls.select = { cols, opts }; return chain; },
    eq(col, val) { calls.eq.push({ col, val }); return chain; },
    gte(col, val) { calls.gte.push({ col, val }); return chain; },
    lt(col, val) { calls.lt.push({ col, val }); return chain; },
    order(col, opts) { calls.order = { col, opts }; return chain; },
    range(from, to) { calls.range = { from, to }; return chain; },
    then(resolve) { return Promise.resolve(result).then(resolve); },
  };
  return chain;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
  chainState = makeChain();
  createClientMock = vi.fn(() => ({
    from: vi.fn((tbl) => { chainState._calls.from = tbl; return chainState; }),
  }));
});

function makeReq(query = {}, overrides = {}) {
  return { method: 'GET', headers: {}, query, ...overrides };
}
function makeRes() {
  return {
    statusCode: null,
    jsonBody: null,
    headers: {},
    setHeader(n, v) { this.headers[n] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    end() { return this; },
  };
}

async function loadHandler() {
  vi.resetModules();
  vi.doMock('@supabase/supabase-js', () => ({ createClient: createClientMock }));
  return (await import('../../api/inventario/movimientos.ts')).default;
}

describe('Frente E · api/inventario/movimientos', () => {
  it('405 si method != GET', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({}, { method: 'POST' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('400 invalid_tipo', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ tipo: 'XXX' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toBe('invalid_tipo');
  });

  it('400 invalid_desde', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ desde: 'not-a-date' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toBe('invalid_desde');
  });

  it('200 default order created_at desc, limit 100', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.statusCode).toBe(200);
    expect(chainState._calls.from).toBe('productos_movimientos');
    expect(chainState._calls.order).toEqual({ col: 'created_at', opts: { ascending: false } });
    expect(chainState._calls.range).toEqual({ from: 0, to: 99 });
  });

  it('filtra por slug', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ slug: 'a001' }), res);
    expect(chainState._calls.eq).toContainEqual({ col: 'producto_slug', val: 'a001' });
  });

  it('alias ?sku= también filtra producto_slug', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ sku: 'a999' }), res);
    expect(chainState._calls.eq).toContainEqual({ col: 'producto_slug', val: 'a999' });
  });

  it('filtra por tipo + rango temporal', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    const desde = '2026-01-01T00:00:00Z';
    const hasta = '2026-02-01T00:00:00Z';
    await handler(makeReq({ tipo: 'salida', desde, hasta }), res);
    expect(chainState._calls.eq).toContainEqual({ col: 'tipo', val: 'salida' });
    expect(chainState._calls.gte).toContainEqual({ col: 'created_at', val: desde });
    expect(chainState._calls.lt).toContainEqual({ col: 'created_at', val: hasta });
  });

  it('Cache-Control 60s + stale-while-revalidate', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.headers['Cache-Control']).toContain('s-maxage=60');
    expect(res.headers['Cache-Control']).toContain('stale-while-revalidate=30');
  });

  it('500 cuando supabase devuelve error', async () => {
    chainState._setResult({ data: null, count: 0, error: { message: 'rls denied' } });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.statusCode).toBe(500);
    expect(res.jsonBody.error).toBe('rls denied');
  });
});
