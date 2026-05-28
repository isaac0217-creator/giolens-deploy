/**
 * Frente I.1 · Analítica Inventario · Tests del endpoint GET /api/analitica/inventario
 *
 * Cobertura (16 tests · §8 PROMPT_v3):
 *   Auth (2) · Defaults (1) · Validación params (4) · Metrics shape (3)
 *   · Cache-Control per-metric (2) · Categoria sanitization (2) · Fallback (1)
 *   · PII (1)
 *
 * Patrón clonado de agents/_shared/api/__tests__/citas.test.js
 * Mock @supabase/supabase-js con builder thenable.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const calls = {
    fromTables: [],     // [table]
    selectCols: [],     // [cols]
    eqCalls:    [],     // [{col, val}]
    orderCalls: [],     // [{col, opts}]
    limitCalls: [],     // [n]
    orCalls:    [],     // [filter]
    singleCalls: 0,
  };

  // cfg controls per-test behaviour
  interface CitasCfg {
    singleData?: unknown;
    singleError?: { code?: string; message?: string };
    listData?: unknown[];
    listError?: { code?: string; message?: string };
    throw42P01?: boolean;
  }
  let cfg: CitasCfg = {};
  const setCfg = (c: CitasCfg) => { cfg = c; };

  const makeBuilder = (table) => {
    const b = {
      _table: table,
      select(cols) { calls.selectCols.push(cols); return this; },
      eq(col, val) { calls.eqCalls.push({ col, val }); return this; },
      or(filter)   { calls.orCalls.push(filter);    return this; },
      order(col, opts) { calls.orderCalls.push({ col, opts }); return this; },
      limit(n)     { calls.limitCalls.push(n);      return this; },
      single() {
        calls.singleCalls++;
        if (cfg.throw42P01) {
          return Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "v_analitica_inventario_kpis" does not exist' } });
        }
        if (cfg.singleError) return Promise.resolve({ data: null, error: cfg.singleError });
        return Promise.resolve({ data: cfg.singleData ?? null, error: null });
      },
      // Thenable para `await q`
      then(resolve, reject) {
        if (cfg.throw42P01) {
          return Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "mv_analitica_inventario" does not exist' } }).then(resolve, reject);
        }
        if (cfg.listError) {
          return Promise.resolve({ data: null, error: cfg.listError }).then(resolve, reject);
        }
        return Promise.resolve({
          data: cfg.listData ?? [],
          error: null,
        }).then(resolve, reject);
      },
      catch(rej) { return this.then(undefined, rej); },
    };
    return b;
  };

  const supabaseClient = {
    from(table) {
      calls.fromTables.push(table);
      return makeBuilder(table);
    },
  };

  return {
    calls,
    setCfg,
    createClient: vi.fn(() => supabaseClient),
  };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

function makeRes() {
  const r = {
    statusCode: null, body: null, headers: {}, ended: false,
    status(code) { r.statusCode = code; return r; },
    json(body)   { r.body = body;       return r; },
    end()        { r.ended = true;      return r; },
    setHeader(name, value) { r.headers[name] = value; return r; },
  };
  return r;
}

function makeReq({ method = 'GET', headers = {}, query = {}, url = undefined } = {}) {
  const hdrs = {
    authorization: `Bearer ${process.env.CRON_SECRET}`,
    origin:        'https://giolens-dashboard.vercel.app',
    ...headers,
  };
  for (const k of Object.keys(hdrs)) {
    if (hdrs[k] === undefined) delete hdrs[k];
  }
  return { method, headers: hdrs, query, url };
}

describe('GET /api/analitica/inventario', () => {
  let handler;

  beforeEach(async () => {
    process.env.CRON_SECRET               = 'test_cron_secret_analitica';
    process.env.SUPABASE_URL              = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';

    Object.values(mocks.calls).forEach(v => {
      if (Array.isArray(v)) v.length = 0;
    });
    mocks.calls.singleCalls = 0;
    mocks.setCfg({});

    handler = (await import('../api/analitica/inventario.ts')).default;
  });

  // ─── Auth (2) ─────────────────────────────────────────────────────────
  it('401 sin Bearer', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: undefined } }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('401 con Bearer tampered', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: 'Bearer wrong_token' } }), res);
    expect(res.statusCode).toBe(401);
  });

  // ─── Defaults (1) ─────────────────────────────────────────────────────
  it('200 default metric=kpis periodo=30 shape OK', async () => {
    mocks.setCfg({
      singleData: {
        valor_total_stock: 1234567.89,
        pct_bajo_minimo: 8.4,
        productos_sin_movimiento_30d_count: 312,
        ingresos_30d_total: 187420,
        ingresos_90d_total: 524300,
        rotacion_promedio: 1.85,
      },
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.metric).toBe('kpis');
    expect(res.body.periodo).toBe(30);
    expect(res.body.data).toHaveProperty('valor_total_stock');
    expect(res.body.data).toHaveProperty('rotacion_promedio');
    expect(res.body.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ─── Validación params (4) ────────────────────────────────────────────
  it('400 metric inválido (foo)', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'foo' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_metric');
    expect(res.body.allowed).toContain('kpis');
    expect(res.body.allowed).toContain('stockout');
  });

  it('400 periodo inválido (=45)', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { periodo: '45' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_periodo');
    expect(res.body.allowed).toEqual([30, 90]);
  });

  it('200 limit>100 → clamp a 100 + warning', async () => {
    mocks.setCfg({ listData: [] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'top_rotacion', limit: '500' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.limit).toBe(100);
    expect(res.body.warning).toContain('clamped');
    // Verificar que el mock recibió el limit clampado
    expect(mocks.calls.limitCalls).toContain(100);
  });

  it('400 limit<1 (=0)', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { limit: '0' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_limit');
  });

  // ─── Metrics shape (3) ────────────────────────────────────────────────
  it('200 metric=top_rotacion shape: sku + rotacion_30d', async () => {
    mocks.setCfg({
      listData: [
        { sku: 'AC-001', nombre: 'Solucion', categoria: 'AC', rotacion_30d: 4.2, unidades_30d: 84, ingresos_30d: 8400 },
        { sku: 'LC-014', nombre: 'Lente',    categoria: 'LC', rotacion_30d: 3.8, unidades_30d: 76, ingresos_30d: 12180 },
      ],
    });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'top_rotacion' } }), res);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0]).toHaveProperty('sku');
    expect(res.body.data[0]).toHaveProperty('rotacion_30d');
    // Verificar select cols y orden
    expect(mocks.calls.selectCols.some(c => /sku.*rotacion_30d/.test(c))).toBe(true);
    expect(mocks.calls.orderCalls.some(o => o.col === 'rotacion_30d' && o.opts.ascending === false)).toBe(true);
  });

  it('200 metric=stockout shape: ratio_riesgo + stock_actual', async () => {
    mocks.setCfg({
      listData: [
        { sku: 'AC-105', nombre: 'Estuche', categoria: 'AC', stock_actual: 2, stock_minimo: 10, ratio_riesgo: 0.20, dias_inventario: 4.0 },
      ],
    });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'stockout' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data[0]).toHaveProperty('ratio_riesgo');
    expect(res.body.data[0]).toHaveProperty('stock_actual');
    // Verificar filtro bajo_minimo=true
    expect(mocks.calls.eqCalls.some(e => e.col === 'bajo_minimo' && e.val === true)).toBe(true);
    expect(mocks.calls.orderCalls.some(o => o.col === 'ratio_riesgo' && o.opts.ascending === true)).toBe(true);
  });

  it('200 metric=valorizacion: valor_stock typeof number', async () => {
    mocks.setCfg({
      listData: [
        { sku: 'X-1', nombre: 'N', categoria: 'C', stock_actual: 10, precio_costo: 50, valor_stock: 500 },
      ],
    });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'valorizacion' } }), res);
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.data[0].valor_stock).toBe('number');
    expect(mocks.calls.orderCalls.some(o => o.col === 'valor_stock' && o.opts.ascending === false)).toBe(true);
  });

  // ─── Cache-Control per-metric (2) ─────────────────────────────────────
  it('cache-control kpis = s-maxage=120, swr=60', async () => {
    mocks.setCfg({ singleData: { valor_total_stock: 0 } });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'kpis' } }), res);
    expect(res.statusCode).toBe(200);
    const cc = res.headers['Cache-Control'];
    expect(cc).toContain('s-maxage=120');
    expect(cc).toContain('stale-while-revalidate=60');
  });

  it('cache-control top_rotacion = s-maxage=600, swr=300', async () => {
    mocks.setCfg({ listData: [] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'top_rotacion' } }), res);
    expect(res.statusCode).toBe(200);
    const cc = res.headers['Cache-Control'];
    expect(cc).toContain('s-maxage=600');
    expect(cc).toContain('stale-while-revalidate=300');
  });

  // ─── Categoria sanitization (2) ───────────────────────────────────────
  it('200 con categoria normal', async () => {
    mocks.setCfg({ listData: [] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'top_rotacion', categoria: 'Lentes' } }), res);
    expect(res.statusCode).toBe(200);
    // Verificar que el valor pasó a eq() sin modificación
    expect(mocks.calls.eqCalls.some(e => e.col === 'categoria' && e.val === 'Lentes')).toBe(true);
  });

  it("200 con categoria con caracteres especiales (escape)", async () => {
    mocks.setCfg({ listData: [] });
    const malicious = "ojos' OR 1=1--";
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'top_rotacion', categoria: malicious } }), res);
    expect(res.statusCode).toBe(200);
    // El valor llega LITERAL a eq() — Supabase client usa parameter binding, no concat
    expect(mocks.calls.eqCalls.some(e => e.col === 'categoria' && e.val === malicious)).toBe(true);
  });

  // ─── Fallback (1) ─────────────────────────────────────────────────────
  it('503 si matview no existe (mock 42P01)', async () => {
    mocks.setCfg({ throw42P01: true });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'top_rotacion' } }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('view_pending_migration_015');
  });

  // ─── PII no negociable (1) ────────────────────────────────────────────
  it('respuesta NO contiene paciente_hash/email/telefono/nombre_paciente', async () => {
    mocks.setCfg({
      listData: [
        { sku: 'X-1', nombre: 'N', categoria: 'C', rotacion_30d: 1, unidades_30d: 5, ingresos_30d: 50 },
      ],
    });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'top_rotacion' } }), res);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/paciente_hash|paciente_email|paciente_telefono|nombre_paciente/);
  });
});
