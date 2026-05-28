/**
 * Frente I.2 · Analítica Clínica · Tests del endpoint GET /api/analitica/clinica
 *
 * Cobertura (22 tests):
 *   Auth (3) · Defaults (2) · Validación params (5) · Metrics shape (5)
 *   · Cache-Control per-metric (2) · PII (3) · Warnings (1) · Fallback (1)
 *
 * Patrón clonado de tests/analitica-inventario.test.ts (I.1).
 * Mock @supabase/supabase-js con builder thenable.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => {
  const calls = {
    fromTables: [] as string[],
    selectCols: [] as string[],
    eqCalls: [] as Array<{ col: string; val: unknown }>,
    orderCalls: [] as Array<{ col: string; opts: { ascending?: boolean } }>,
    limitCalls: [] as number[],
    singleCalls: 0,
  };

  interface Cfg {
    singleData?: unknown;
    singleError?: { code?: string; message?: string };
    listData?: unknown[];
    listError?: { code?: string; message?: string };
    throw42P01?: boolean;
  }
  let cfg: Cfg = {};
  const setCfg = (c: Cfg) => { cfg = c; };

  const makeBuilder = (table: string) => {
    const b: Record<string, unknown> = {
      _table: table,
      select(cols: string) { calls.selectCols.push(cols); return b; },
      eq(col: string, val: unknown) { calls.eqCalls.push({ col, val }); return b; },
      order(col: string, opts: { ascending?: boolean }) { calls.orderCalls.push({ col, opts }); return b; },
      limit(n: number) { calls.limitCalls.push(n); return b; },
      single() {
        calls.singleCalls++;
        if (cfg.throw42P01) {
          return Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "v_analitica_clinica_kpis" does not exist' } });
        }
        if (cfg.singleError) return Promise.resolve({ data: null, error: cfg.singleError });
        return Promise.resolve({ data: cfg.singleData ?? null, error: null });
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        if (cfg.throw42P01) {
          return Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "v_clinica_alertas" does not exist' } }).then(resolve, reject);
        }
        if (cfg.listError) {
          return Promise.resolve({ data: null, error: cfg.listError }).then(resolve, reject);
        }
        return Promise.resolve({ data: cfg.listData ?? [], error: null }).then(resolve, reject);
      },
      catch(rej: (e: unknown) => unknown) { return (b.then as (r: undefined, j: unknown) => unknown)(undefined, rej); },
    };
    return b;
  };

  const supabaseClient = {
    from(table: string) {
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
  const r: Record<string, unknown> = {
    statusCode: null, body: null, headers: {} as Record<string, string>, ended: false,
    status(code: number) { r.statusCode = code; return r; },
    json(body: unknown) { r.body = body; return r; },
    end() { r.ended = true; return r; },
    setHeader(name: string, value: string) { (r.headers as Record<string, string>)[name] = value; return r; },
  };
  return r as {
    statusCode: number; body: any; headers: Record<string, string>; ended: boolean;
    status(c: number): unknown; json(b: unknown): unknown; end(): unknown; setHeader(n: string, v: string): unknown;
  };
}

function makeReq({ method = 'GET', headers = {} as Record<string, string | undefined>, query = {}, url = undefined as string | undefined } = {}) {
  const hdrs: Record<string, string | undefined> = {
    authorization: `Bearer ${process.env.CRON_SECRET}`,
    origin: 'https://giolens-dashboard.vercel.app',
    ...headers,
  };
  for (const k of Object.keys(hdrs)) {
    if (hdrs[k] === undefined) delete hdrs[k];
  }
  return { method, headers: hdrs, query, url };
}

describe('GET /api/analitica/clinica', () => {
  let handler: (req: unknown, res: unknown) => Promise<void>;

  beforeEach(async () => {
    process.env.CRON_SECRET = 'test_cron_secret_clinica';
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';

    Object.values(mocks.calls).forEach((v) => {
      if (Array.isArray(v)) v.length = 0;
    });
    mocks.calls.singleCalls = 0;
    mocks.setCfg({});

    handler = (await import('../api/analitica/clinica.ts')).default;
  });

  const FULL_KPIS = {
    expediente_to_cita_rate: 42.5,
    cita_show_rate: 78.0,
    expediente_to_venta_rate: 31.2,
    recurrencia_60d: 18.9,
    tiempo_entre_citas_promedio_dias: 96.4,
    citas_confirmadas_30d: 124,
    salidas_unidades_30d: 340,
    alertas_seguimiento_count: 57,
  };

  // ─── Auth (3) ──────────────────────────────────────────────────────────
  it('401 sin Authorization header', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: undefined } }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('403 con Bearer inválido (tampered)', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: 'Bearer wrong_token' } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('200 con Bearer válido (kpis)', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // ─── Defaults (2) ──────────────────────────────────────────────────────
  it('sin metric → kpis default', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.metric).toBe('kpis');
    expect(mocks.calls.fromTables).toContain('v_analitica_clinica_kpis');
  });

  it('periodo default = 30', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.body.periodo).toBe(30);
  });

  // ─── Validación params (5) ─────────────────────────────────────────────
  it('400 metric inválido (foo)', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'foo' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_metric');
    expect(res.body.allowed).toContain('kpis');
    expect(res.body.allowed).toContain('alertas');
  });

  it('400 periodo inválido (=45)', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { periodo: '45' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_periodo');
    expect(res.body.allowed).toEqual([30, 60, 90, 180]);
  });

  it('200 limit>100 → clamp a 100 + warning', async () => {
    mocks.setCfg({ listData: [] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'alertas', limit: '500' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.limit).toBe(100);
    expect(res.body.warning).toContain('clamped');
    expect(mocks.calls.limitCalls).toContain(100);
  });

  it('400 limit<1 (=0)', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { limit: '0' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_limit');
  });

  it('optometrista llega LITERAL (normalizado) a eq() — parameter binding, no concat', async () => {
    mocks.setCfg({ listData: [] });
    const malicious = "Dr X' OR 1=1--";
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'productividad', optometrista: malicious } }), res);
    expect(res.statusCode).toBe(200);
    expect(mocks.calls.eqCalls.some((e) => e.col === 'optometrista' && e.val === malicious.trim().toLowerCase())).toBe(true);
  });

  // ─── Metrics shape (5) ─────────────────────────────────────────────────
  it('metric=kpis devuelve 8 keys exactos', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'kpis' } }), res);
    expect(res.statusCode).toBe(200);
    const keys = Object.keys(res.body.data);
    expect(keys.sort()).toEqual(Object.keys(FULL_KPIS).sort());
    expect(keys).toHaveLength(8);
  });

  it('metric=conversion_funnel shape: expedientes_90d', async () => {
    mocks.setCfg({ singleData: { expedientes_90d: 200, expedientes_con_cita_90d: 90, expedientes_con_venta_60d: 40 } });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'conversion_funnel' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveProperty('expedientes_90d');
    expect(res.body.data).toHaveProperty('expedientes_con_cita_90d');
    expect(res.body.data).toHaveProperty('expedientes_con_venta_60d');
  });

  it('metric=recurrencia shape: num_citas_bucket + order asc', async () => {
    mocks.setCfg({ listData: [{ num_citas_bucket: '1', pacientes: 120 }, { num_citas_bucket: '2', pacientes: 45 }] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'recurrencia' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data[0]).toHaveProperty('num_citas_bucket');
    expect(res.body.data[0]).toHaveProperty('pacientes');
    expect(mocks.calls.orderCalls.some((o) => o.col === 'num_citas_bucket' && o.opts.ascending === true)).toBe(true);
  });

  it('metric=productividad shape: optometrista + order desc', async () => {
    mocks.setCfg({ listData: [{ optometrista: 'dra lopez', citas_confirmadas_30d: 60 }, { optometrista: 'dr ruiz', citas_confirmadas_30d: 38 }] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'productividad' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data[0]).toHaveProperty('optometrista');
    expect(res.body.data[0]).toHaveProperty('citas_confirmadas_30d');
    expect(mocks.calls.orderCalls.some((o) => o.col === 'citas_confirmadas_30d' && o.opts.ascending === false)).toBe(true);
  });

  it('metric=alertas shape: paciente_hash + dias_sin_cita + order desc', async () => {
    mocks.setCfg({ listData: [{ paciente_hash: 'a1b2c3d4e5f60718', ultima_cita_fecha: '2025-09-01', dias_sin_cita: 270 }] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'alertas' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data[0]).toHaveProperty('paciente_hash');
    expect(res.body.data[0]).toHaveProperty('dias_sin_cita');
    expect(mocks.calls.orderCalls.some((o) => o.col === 'dias_sin_cita' && o.opts.ascending === false)).toBe(true);
  });

  // ─── Cache-Control per-metric (2) ──────────────────────────────────────
  it('cache-control kpis = s-maxage=300, swr=600', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'kpis' } }), res);
    const cc = res.headers['Cache-Control'];
    expect(cc).toContain('s-maxage=300');
    expect(cc).toContain('stale-while-revalidate=600');
  });

  it('cache-control alertas = s-maxage=120, swr=60 (cambia rápido)', async () => {
    mocks.setCfg({ listData: [] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'alertas' } }), res);
    const cc = res.headers['Cache-Control'];
    expect(cc).toContain('s-maxage=120');
    expect(cc).toContain('stale-while-revalidate=60');
  });

  // ─── PII no negociable (3) ─────────────────────────────────────────────
  const PII_RE = /nombre|paciente_nombre|paciente_telefono|paciente_email|telefono|email|direccion|diagnostico|motivo/i;

  it('productividad: ninguna response ni select col incluye PII raw', async () => {
    mocks.setCfg({ listData: [{ optometrista: 'dra lopez', citas_confirmadas_30d: 60 }] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'productividad' } }), res);
    expect(JSON.stringify(res.body)).not.toMatch(PII_RE);
    expect(mocks.calls.selectCols.every((c) => !PII_RE.test(c))).toBe(true);
  });

  it('alertas: paciente_hash 16-hex presente, sin PII raw', async () => {
    mocks.setCfg({ listData: [{ paciente_hash: 'a1b2c3d4e5f60718', ultima_cita_fecha: '2025-09-01', dias_sin_cita: 270 }] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'alertas' } }), res);
    expect(res.body.data[0].paciente_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(res.body)).not.toMatch(PII_RE);
  });

  it('kpis: select cols son sólo agregados, sin PII raw', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'kpis' } }), res);
    expect(mocks.calls.selectCols.every((c) => !PII_RE.test(c))).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(PII_RE);
  });

  // ─── Warnings (1) ──────────────────────────────────────────────────────
  it('datos vacíos → _warnings: ["datos_clinicos_pendientes"]', async () => {
    mocks.setCfg({ listData: [] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'recurrencia' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body._warnings).toContain('datos_clinicos_pendientes');
  });

  // ─── Fallback (1) ──────────────────────────────────────────────────────
  it('503 si vista no existe (mock 42P01) → view_pending_migration_019', async () => {
    mocks.setCfg({ throw42P01: true });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'alertas' } }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('view_pending_migration_019');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression guard · migration 022 (hot-fix REFRESH CONCURRENTLY)
//
// Bug sesión 7B/8: el índice singleton de 019 estaba sobre la expresión
// constante ((1)), que Postgres rechaza para REFRESH ... CONCURRENTLY. Estos
// tests bloquean que alguien "simplifique" 022 de vuelta a ((1)) y reintroduzca
// el bug. No tocan DB — validan el contenido SQL de la migration.
// ─────────────────────────────────────────────────────────────────────────
describe('migration 022 · matview clínica unique index (regression guard)', () => {
  const sql = readFileSync(
    resolve(process.cwd(), 'migrations/022_mv_clinica_unique_index_fix.sql'),
    'utf8',
  );
  // SQL ejecutable: descartar líneas de comentario (-- ...)
  const exec = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('crea uq_mv_clinica_singleton sobre la columna real refreshed_at', () => {
    expect(exec).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+uq_mv_clinica_singleton\s+ON\s+mv_analitica_clinica\s*\(\s*refreshed_at\s*\)/i,
    );
  });

  it('NO usa índice de expresión constante ((1))', () => {
    expect(exec).not.toMatch(/\(\(\s*1\s*\)\)/);
  });

  it('es idempotente: DROP INDEX IF EXISTS antes del CREATE', () => {
    expect(exec).toMatch(/DROP\s+INDEX\s+IF\s+EXISTS\s+uq_mv_clinica_singleton/i);
  });
});
