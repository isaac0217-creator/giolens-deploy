/**
 * Frente E · tests del handler POST `/api/inventario/operaciones`.
 *
 * Mockea `@supabase/supabase-js` con `vi.mock` y verifica:
 *   - 405 method_not_allowed (GET)
 *   - 401 sin Authorization
 *   - 400 invalid_tipo / missing_fields / invalid_cantidad / invalid_costo_unitario
 *   - 404 producto_no_existe (cuando RPC falla con 'producto no existe')
 *   - 409 stock_insuficiente (cuando RPC falla con 'stock negativo')
 *   - 200 ok + movimiento_id + stock_nuevo + alerta_bajo
 *   - idempotency_key llega al RPC
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let rpcMock;
let fromMock;
let createClientMock;

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
  process.env.CRON_SECRET = 'test_cron';

  rpcMock = vi.fn();
  fromMock = vi.fn(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(() => Promise.resolve({ data: { stock_actual: 7, stock_minimo: 5 }, error: null })),
      })),
    })),
  }));

  createClientMock = vi.fn(() => ({ rpc: rpcMock, from: fromMock }));
  vi.doMock('@supabase/supabase-js', () => ({ createClient: createClientMock }));
});

function makeReq(overrides = {}) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test_cron' },
    body: {},
    ...overrides,
  };
}
function makeRes() {
  const r = {
    statusCode: null,
    jsonBody: null,
    setHeader: vi.fn(),
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    end() { return this; },
  };
  return r;
}

async function loadHandler() {
  vi.resetModules();
  // Re-mock después del reset
  vi.doMock('@supabase/supabase-js', () => ({ createClient: createClientMock }));
  return (await import('../../api/inventario/operaciones.ts')).default;
}

describe('Frente E · api/inventario/operaciones', () => {
  it('405 si method != POST', async () => {
    const handler = await loadHandler();
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.jsonBody.error).toBe('method_not_allowed');
  });

  it('401 sin Authorization', async () => {
    const handler = await loadHandler();
    const req = makeReq({ headers: {} });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('401 con Bearer token incorrecto (P2-2 · constant-time)', async () => {
    const handler = await loadHandler();
    const req = makeReq({
      headers: { authorization: 'Bearer token_equivocado' },
      body: { sku: 'a001', tipo: 'entrada', cantidad: 1 },
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    // El RPC nunca debe invocarse si el token no valida
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('401 con token de igual longitud pero distinto (constant-time mismatch)', async () => {
    const handler = await loadHandler();
    // 'test_cron' tiene 9 chars → mismo largo, contenido distinto
    const req = makeReq({
      headers: { authorization: 'Bearer XXXXXXXXX' },
      body: { sku: 'a001', tipo: 'entrada', cantidad: 1 },
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('400 missing_fields cuando falta sku', async () => {
    const handler = await loadHandler();
    const req = makeReq({ body: { tipo: 'entrada', cantidad: 5 } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toBe('missing_fields');
  });

  it('400 invalid_tipo', async () => {
    const handler = await loadHandler();
    const req = makeReq({ body: { sku: 'a001', tipo: 'XXX', cantidad: 1 } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toBe('invalid_tipo');
  });

  it('400 invalid_cantidad cuando cantidad=0', async () => {
    const handler = await loadHandler();
    const req = makeReq({ body: { sku: 'a001', tipo: 'entrada', cantidad: 0 } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toBe('invalid_cantidad');
  });

  it('400 invalid_costo_unitario cuando negativo', async () => {
    const handler = await loadHandler();
    const req = makeReq({ body: { sku: 'a001', tipo: 'entrada', cantidad: 1, costo_unitario: -3 } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toBe('invalid_costo_unitario');
  });

  it('404 cuando RPC dice "producto no existe"', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'producto no existe: a001' } });
    const handler = await loadHandler();
    const req = makeReq({ body: { sku: 'a001', tipo: 'entrada', cantidad: 1 } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody.error).toBe('producto_no_existe');
  });

  it('409 cuando RPC dice "stock negativo"', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'stock negativo: stock_actual=2 delta=-5' } });
    const handler = await loadHandler();
    const req = makeReq({ body: { sku: 'a001', tipo: 'salida', cantidad: 5 } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.jsonBody.error).toBe('stock_insuficiente');
  });

  it('200 ok con movimiento_id + stock_nuevo + alerta_bajo', async () => {
    rpcMock.mockResolvedValueOnce({ data: 42, error: null });
    const handler = await loadHandler();
    const req = makeReq({ body: { sku: 'a001', tipo: 'entrada', cantidad: 5 } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.ok).toBe(true);
    expect(res.jsonBody.movimiento_id).toBe(42);
    expect(res.jsonBody.stock_nuevo).toBe(7);
    expect(res.jsonBody.alerta_bajo).toBe(false); // 7 > 5
  });

  it('alerta_bajo=true cuando stock_actual <= stock_minimo post-RPC', async () => {
    // Mock from() para devolver stock 3, minimo 5 → alerta_bajo true
    const customFrom = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: { stock_actual: 3, stock_minimo: 5 }, error: null })),
        })),
      })),
    }));
    createClientMock = vi.fn(() => ({ rpc: vi.fn().mockResolvedValue({ data: 99, error: null }), from: customFrom }));
    const handler = await loadHandler();
    const req = makeReq({ body: { sku: 'a001', tipo: 'salida', cantidad: 2 } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.alerta_bajo).toBe(true);
  });

  it('idempotency_key se pasa al RPC', async () => {
    rpcMock.mockResolvedValueOnce({ data: 7, error: null });
    const handler = await loadHandler();
    const req = makeReq({ body: { sku: 'a001', tipo: 'entrada', cantidad: 1, idempotency_key: 'idem-1' } });
    const res = makeRes();
    await handler(req, res);
    expect(rpcMock).toHaveBeenCalledWith('registrar_movimiento', expect.objectContaining({
      p_idempotency_key: 'idem-1',
      p_slug: 'a001',
      p_tipo: 'entrada',
      p_cantidad: 1,
    }));
  });

  it('body como string JSON también se parsea', async () => {
    rpcMock.mockResolvedValueOnce({ data: 8, error: null });
    const handler = await loadHandler();
    const req = makeReq({ body: JSON.stringify({ sku: 'a002', tipo: 'entrada', cantidad: 2 }) });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.movimiento_id).toBe(8);
  });
});
