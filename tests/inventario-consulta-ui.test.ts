/**
 * tests/inventario-consulta-ui.test.ts — BFF M3 lectura · GET /api/inventario/consulta-ui.
 *
 * Invariantes:
 *   - Origin-gated (NO Bearer): origen ajeno/ausente → 403. Solo GET/OPTIONS → 405.
 *   - ?q= → búsqueda; ?slug= → detalle + movimientos; ninguno → 400.
 *   - SIN DINERO (regla 5): jamás se piden columnas de precio, costo_unitario ni proveedor.
 *   - producto inexistente → 404.
 *
 * Mock @supabase/supabase-js: builder que distingue tabla (productos | productos_movimientos)
 * y terminal (maybeSingle = detalle producto | thenable = lista búsqueda/movimientos).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  interface Cfg {
    productoDetail: Record<string, unknown> | null;
    searchRows: Array<Record<string, unknown>>;
    movRows: Array<Record<string, unknown>>;
    error: { code?: string } | null;
  }
  const fresh = (): Cfg => ({
    productoDetail: { slug: 'lente-x', sku: 'SKU1', nombre: 'Lente X', stock_actual: 5, stock_minimo: 2 },
    searchRows: [{ slug: 'lente-x', sku: 'SKU1', nombre: 'Lente X', stock_actual: 5 }],
    movRows: [{ id: 1, tipo: 'entrada', cantidad: 3, stock_anterior: 2, stock_nuevo: 5, created_at: '2026-06-01T10:00:00Z' }],
    error: null,
  });
  let cfg: Cfg = fresh();
  const calls = { from: [] as string[], selectCols: [] as string[], orFilters: [] as string[], eqFilters: [] as Array<{ col: string; val: unknown }> };

  function makeBuilder(table: string) {
    const b: Record<string, unknown> = {
      select(cols?: string) { if (typeof cols === 'string') calls.selectCols.push(`${table}:${cols}`); return b; },
      eq(col: string, val: unknown) { calls.eqFilters.push({ col, val }); return b; },
      or(expr: string) { calls.orFilters.push(expr); return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return Promise.resolve({ data: cfg.productoDetail, error: cfg.error }); },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        const rows = table === 'productos_movimientos' ? cfg.movRows : cfg.searchRows;
        return Promise.resolve({ data: rows, error: cfg.error }).then(onF, onR);
      },
    };
    return b;
  }
  const client = { from(table: string) { calls.from.push(table); return makeBuilder(table); } };
  return {
    calls,
    setCfg: (c: Partial<Cfg>) => { cfg = { ...cfg, ...c }; },
    resetCfg: () => { cfg = fresh(); },
    createClient: vi.fn(() => client),
  };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

const DASH = 'https://giolens-dashboard.vercel.app';

function makeRes() {
  const r: Record<string, unknown> = {
    statusCode: null, body: null, headers: {} as Record<string, string>, ended: false,
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; return r; },
    end() { r.ended = true; return r; },
    setHeader(n: string, v: string) { (r.headers as Record<string, string>)[n] = v; return r; },
  };
  return r as { statusCode: number; body: any; headers: Record<string, string>;
    status(c: number): unknown; json(b: unknown): unknown; end(): unknown; setHeader(n: string, v: string): unknown; };
}
function makeReq({ method = 'GET', query = {}, headers = {} } = {}) {
  return { method, query, headers };
}

describe('GET /api/inventario/consulta-ui — M3 lectura', () => {
  let handler: (req: unknown, res: unknown) => Promise<void>;

  beforeEach(async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
    mocks.resetCfg();
    mocks.calls.from.length = 0;
    mocks.calls.selectCols.length = 0;
    mocks.calls.orFilters.length = 0;
    mocks.calls.eqFilters.length = 0;
    handler = (await import('../api/inventario/consulta-ui.ts')).default;
  });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.SUPABASE_URL; });

  // ── Auth / método ──
  it('sin Origin → 403', async () => {
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.statusCode).toBe(403);
  });
  it('método POST → 405', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST', headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(405);
  });
  it('OPTIONS → 204', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'OPTIONS', headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(204);
  });

  // ── Búsqueda ──
  it('?q=lente → { ok, productos }', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { q: 'lente' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.productos).toHaveLength(1);
    expect(mocks.calls.orFilters[0]).toContain('nombre.ilike.%lente%');
  });

  it('?q con caracteres peligrosos (,()%_\\) → saneados antes del filtro', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { q: "le,n(te)%_\\'" } }), res);
    expect(res.statusCode).toBe(200);
    // La expresión .or() lleva comas y % estructurales (separadores/comodines), pero el
    // TÉRMINO del usuario ya viene saneado: sin paréntesis, backslash, comillas ni `_`
    // (comodín de un carácter en LIKE) que permitirían inyección en el filtro PostgREST.
    expect(mocks.calls.orFilters[0]).not.toMatch(/[()\\'_]/);
    expect(mocks.calls.orFilters[0]).toContain('%le n te%');
  });

  it('sin q ni slug → 400 q_o_slug_requerido', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('q_o_slug_requerido');
  });

  // ── Detalle ──
  it('?slug → { ok, producto, movimientos }', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { slug: 'lente-x' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.producto.slug).toBe('lente-x');
    expect(res.body.movimientos).toHaveLength(1);
    expect(mocks.calls.from).toContain('productos_movimientos');
  });

  it('?slug inexistente → 404 producto_no_encontrado', async () => {
    mocks.setCfg({ productoDetail: null });
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { slug: 'no-existe' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('producto_no_encontrado');
  });

  // ── Regla 5: SIN DINERO ──
  it('NUNCA pide columnas de precio/costo/proveedor (regla 5: sin dinero)', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { slug: 'lente-x' } }), res);
    const allCols = mocks.calls.selectCols.join(' ');
    for (const forbidden of ['precio_costo', 'precio_publico', 'precio_promo', 'costo_unitario', 'proveedor']) {
      expect(allCols).not.toContain(forbidden);
    }
  });

  it('error de Supabase → 500 internal_error (sin filtrar message crudo)', async () => {
    mocks.setCfg({ error: { code: '42P01' } });
    const res = makeRes();
    await handler(makeReq({ headers: { origin: DASH }, query: { q: 'lente' } }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('internal_error');
  });
});
