/**
 * Frente E · PATCH 1 + 3 — verificación dual-mode Bearer/sin-Bearer.
 *
 * Cubre la matriz de auth para los 2 endpoints públicos:
 *   - GET /api/inventario/movimientos: público strip {proveedor, costo_unitario,
 *     motivo, registrado_por}; admin Bearer ve TODO.
 *   - GET /api/inventario/rotacion: público strip {precio_publico, precio_costo};
 *     admin Bearer ve TODO (SELECT *).
 *   - Bearer inválido: tratado como público (NO 401, sino subset sanitizado).
 *
 * Estrategia mock: capturar el primer arg de `.select(cols, opts)` y aseverar
 * sobre el string de columnas devuelto. No necesitamos data real — el patch
 * sólo decide qué le pide a Supabase.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let lastSelect;
let createClientMock;

function makeChain(result = { data: [], count: 0, error: null }) {
  const chain = {
    select(cols, opts) { lastSelect = cols; return chain; },
    eq() { return chain; },
    gt() { return chain; },
    gte() { return chain; },
    lt() { return chain; },
    order() { return chain; },
    range() { return Promise.resolve(result); },
  };
  return chain;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
  process.env.CRON_SECRET = 'test_cron_secret';
  lastSelect = null;
  createClientMock = vi.fn(() => ({ from: vi.fn(() => makeChain()) }));
});

function makeReq(overrides = {}) {
  return { method: 'GET', headers: {}, query: {}, ...overrides };
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

async function loadHandler(path) {
  vi.resetModules();
  vi.doMock('@supabase/supabase-js', () => ({ createClient: createClientMock }));
  return (await import(path)).default;
}

/* ── 1 · MOVIMIENTOS ──────────────────────────────────────────────────── */

describe('Frente E · PATCH 1 · /api/inventario/movimientos auth dual-mode', () => {
  it('SIN Authorization → select PÚBLICO (sin proveedor/costo/motivo/registrado_por)', async () => {
    const handler = await loadHandler('../../api/inventario/movimientos.ts');
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.mode).toBe('public');
    expect(lastSelect).not.toContain('proveedor');
    expect(lastSelect).not.toContain('costo_unitario');
    expect(lastSelect).not.toContain('motivo');
    expect(lastSelect).not.toContain('registrado_por');
    // Y SÍ debe contener los safe-to-publish
    expect(lastSelect).toContain('producto_slug');
    expect(lastSelect).toContain('stock_anterior');
    expect(lastSelect).toContain('stock_nuevo');
    expect(lastSelect).toContain('cantidad');
    expect(lastSelect).toContain('tipo');
    expect(lastSelect).toContain('created_at');
  });

  it('CON Bearer válido → select ADMIN (incluye TODOS los campos)', async () => {
    const handler = await loadHandler('../../api/inventario/movimientos.ts');
    const req = makeReq({ headers: { authorization: 'Bearer test_cron_secret' } });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.mode).toBe('admin');
    expect(lastSelect).toContain('proveedor');
    expect(lastSelect).toContain('costo_unitario');
    expect(lastSelect).toContain('motivo');
    expect(lastSelect).toContain('registrado_por');
  });

  it('Bearer INVÁLIDO → tratado como público (no 401, sino sanitizado)', async () => {
    const handler = await loadHandler('../../api/inventario/movimientos.ts');
    const req = makeReq({ headers: { authorization: 'Bearer un_token_basura' } });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200); // NO 401
    expect(res.jsonBody.mode).toBe('public');
    expect(lastSelect).not.toContain('proveedor');
    expect(lastSelect).not.toContain('motivo');
  });

  it('Bearer con formato raro (sin "Bearer " prefix) → público', async () => {
    const handler = await loadHandler('../../api/inventario/movimientos.ts');
    const req = makeReq({ headers: { authorization: 'test_cron_secret' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.jsonBody.mode).toBe('public');
    expect(lastSelect).not.toContain('costo_unitario');
  });
});

/* ── 2 · ROTACIÓN ─────────────────────────────────────────────────────── */

describe('Frente E · PATCH 3 · /api/inventario/rotacion auth dual-mode', () => {
  it('SIN Authorization → select PÚBLICO (sin precio_publico ni precio_costo)', async () => {
    const handler = await loadHandler('../../api/inventario/rotacion.ts');
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.mode).toBe('public');
    expect(lastSelect).not.toContain('precio_publico');
    expect(lastSelect).not.toContain('precio_costo');
    // Y SÍ debe contener los operativos
    expect(lastSelect).toContain('sku');
    expect(lastSelect).toContain('stock_actual');
    expect(lastSelect).toContain('ventas_30d');
    expect(lastSelect).toContain('rotacion_30d');
  });

  it('CON Bearer válido → select ADMIN (* — incluye todo el matview)', async () => {
    const handler = await loadHandler('../../api/inventario/rotacion.ts');
    const req = makeReq({ headers: { authorization: 'Bearer test_cron_secret' } });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.mode).toBe('admin');
    // SELECT_ADMIN = '*' → contiene literal '*' (no es un set de columnas)
    expect(lastSelect).toBe('*');
  });

  it('Bearer INVÁLIDO → tratado como público (no 401)', async () => {
    const handler = await loadHandler('../../api/inventario/rotacion.ts');
    const req = makeReq({ headers: { authorization: 'Bearer fake_token' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.mode).toBe('public');
    expect(lastSelect).not.toContain('precio_costo');
  });
});
