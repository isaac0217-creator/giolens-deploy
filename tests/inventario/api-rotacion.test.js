/**
 * Frente E · tests del handler GET `/api/inventario/rotacion`.
 *
 * Cubre:
 *   - 405 method != GET
 *   - 400 invalid_orden (columna fuera de whitelist)
 *   - 200 default (orden=ventas_30d.desc, limit=100)
 *   - filtros: categoria, muertos=true
 *   - limit cap MAX_LIMIT=500
 *   - Cache-Control 5min
 *   - error de supabase → 500
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let chainState;
let createClientMock;

function makeChain() {
  // Construye un mock "fluent" que graba cada llamada para inspección
  const calls = { from: null, eq: [], gt: null, order: null, range: null };
  let result = { data: [{ sku: 'a1', nombre: 'Test', stock_actual: 5 }], count: 1, error: null };

  const chain = {
    _calls: calls,
    _setResult(r) { result = r; },
    select(cols, opts) { calls.select = { cols, opts }; return chain; },
    eq(col, val) { calls.eq.push({ col, val }); return chain; },
    gt(col, val) { calls.gt = { col, val }; return chain; },
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
  return {
    method: 'GET',
    headers: {},
    query,
    ...overrides,
  };
}
function makeRes() {
  const r = {
    statusCode: null,
    jsonBody: null,
    headers: {},
    setHeader(name, val) { this.headers[name] = val; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    end() { return this; },
  };
  return r;
}

async function loadHandler() {
  vi.resetModules();
  vi.doMock('@supabase/supabase-js', () => ({ createClient: createClientMock }));
  return (await import('../../api/inventario/rotacion.ts')).default;
}

describe('Frente E · api/inventario/rotacion', () => {
  it('405 si method != GET', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({}, { method: 'POST' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('400 invalid_orden cuando columna no está en whitelist', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ orden: 'precio_costo.desc' }), res); // no en whitelist
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toBe('invalid_orden');
  });

  it('200 default: orden=ventas_30d.desc, limit=100, offset=0', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.ok).toBe(true);
    expect(chainState._calls.from).toBe('productos_rotacion_mensual');
    expect(chainState._calls.order).toEqual({ col: 'ventas_30d', opts: { ascending: false } });
    expect(chainState._calls.range).toEqual({ from: 0, to: 99 });
  });

  it('filtra por categoria', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ categoria: 'lentes' }), res);
    expect(chainState._calls.eq).toContainEqual({ col: 'categoria', val: 'lentes' });
  });

  it('filtra por muertos=true (ventas_90d=0 + stock>0)', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ muertos: 'true' }), res);
    expect(chainState._calls.eq).toContainEqual({ col: 'ventas_90d', val: 0 });
    expect(chainState._calls.gt).toEqual({ col: 'stock_actual', val: 0 });
  });

  it('limit es capped a MAX_LIMIT=500', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ limit: '10000' }), res);
    expect(chainState._calls.range.to - chainState._calls.range.from + 1).toBe(500);
  });

  it('emite Cache-Control public 5 min stale-while-revalidate', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.headers['Cache-Control']).toContain('s-maxage=300');
    expect(res.headers['Cache-Control']).toContain('stale-while-revalidate=60');
  });

  it('500 cuando supabase devuelve error', async () => {
    chainState._setResult({ data: null, count: 0, error: { message: 'db down' } });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.statusCode).toBe(500);
    expect(res.jsonBody.error).toBe('db down');
  });

  it('orden ascendente con .asc', async () => {
    const handler = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ orden: 'stock_actual.asc' }), res);
    expect(chainState._calls.order).toEqual({ col: 'stock_actual', opts: { ascending: true } });
  });
});
