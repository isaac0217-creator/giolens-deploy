/**
 * Frente I.3 · Analítica Marketing (v1 PROXY) · Tests GET /api/analitica/marketing
 *
 * Cobertura (24 tests + 5 regression guard de migration 026):
 *   Auth (3) · Defaults (2) · Validación params (4) · Pipeline binding (1)
 *   · Metrics shape (4) · REGLA crítica 252999/273944 (2) · Deferidos/warnings (4)
 *   · Cache (1) · PII (2) · Fallback (1)
 *
 * Patrón clonado de tests/analitica-clinica.test.ts (I.2).
 * Mock @supabase/supabase-js con builder thenable (+ maybeSingle).
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
          return Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "v_marketing_kpis" does not exist' } });
        }
        if (cfg.singleError) return Promise.resolve({ data: null, error: cfg.singleError });
        return Promise.resolve({ data: cfg.singleData ?? null, error: null });
      },
      maybeSingle() {
        calls.singleCalls++;
        if (cfg.throw42P01) {
          return Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "v_marketing_kpis" does not exist' } });
        }
        if (cfg.singleError) return Promise.resolve({ data: null, error: cfg.singleError });
        return Promise.resolve({ data: cfg.singleData ?? null, error: null });
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        if (cfg.throw42P01) {
          return Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "v_marketing_funnel" does not exist' } }).then(resolve, reject);
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

describe('GET /api/analitica/marketing', () => {
  let handler: (req: unknown, res: unknown) => Promise<void>;

  beforeEach(async () => {
    process.env.CRON_SECRET = 'test_cron_secret_marketing';
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';

    Object.values(mocks.calls).forEach((v) => {
      if (Array.isArray(v)) v.length = 0;
    });
    mocks.calls.singleCalls = 0;
    mocks.setCfg({});

    handler = (await import('../api/analitica/marketing.ts')).default;
  });

  const FULL_KPIS = {
    pipeline_id: 0,
    total_leads: 5480,
    leads_perdidos: 3,
    ventas_proxy: 0,
    tasa_perdida_pct: 0.05,
    tasa_venta_proxy_pct: 0.0,
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
  it('sin metric → kpis default sobre v_marketing_kpis', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.metric).toBe('kpis');
    expect(mocks.calls.fromTables).toContain('v_marketing_kpis');
  });

  it('pipeline default = 0 (agregado)', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.body.pipeline).toBe(0);
    expect(mocks.calls.eqCalls.some((e) => e.col === 'pipeline_id' && e.val === 0)).toBe(true);
  });

  // ─── Validación params (4) ─────────────────────────────────────────────
  it('400 metric inválido (foo)', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'foo' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_metric');
    expect(res.body.allowed).toContain('kpis');
    expect(res.body.allowed).toContain('portafolios');
  });

  it('400 pipeline desconocido (=99999)', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { pipeline: '99999' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_pipeline');
  });

  it('200 limit>100 → clamp a 100 + warning', async () => {
    mocks.setCfg({ listData: [] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'funnel', limit: '500' } }), res);
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

  // ─── Pipeline binding (1) · anti-injection ─────────────────────────────
  it('pipeline malicioso ("0 OR 1=1") → 400 (NaN rechazado, nunca llega a eq)', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { pipeline: '0 OR 1=1' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_pipeline');
    expect(mocks.calls.eqCalls.length).toBe(0);
  });

  // ─── Metrics shape (4) ─────────────────────────────────────────────────
  it('metric=kpis devuelve 6 keys exactos', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'kpis' } }), res);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(Object.keys(FULL_KPIS).sort());
  });

  it('metric=funnel shape: stage_name + order leads desc', async () => {
    mocks.setCfg({ listData: [{ pipeline_id: 0, stage_name: 'NUEVO', stage_phase: 'other', leads: 2275 }] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'funnel' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data[0]).toHaveProperty('stage_name');
    expect(res.body.data[0]).toHaveProperty('leads');
    expect(mocks.calls.orderCalls.some((o) => o.col === 'leads' && o.opts.ascending === false)).toBe(true);
  });

  it('metric=interaccion shape: stage_phase + leads', async () => {
    mocks.setCfg({ listData: [{ pipeline_id: 0, stage_phase: 'int2', leads: 358 }] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'interaccion' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data[0]).toHaveProperty('stage_phase');
    expect(res.body.data[0]).toHaveProperty('leads');
    expect(mocks.calls.fromTables).toContain('v_marketing_interaccion');
  });

  it('metric=ruta_split shape: ruta + leads', async () => {
    mocks.setCfg({ listData: [{ pipeline_id: 0, ruta: 'indeterminada', leads: 5281 }, { pipeline_id: 0, ruta: 'medica', leads: 199 }] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'ruta_split' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data[0]).toHaveProperty('ruta');
    expect(res.body.data[0]).toHaveProperty('leads');
  });

  // ─── REGLA CRÍTICA: 252999 y 273944 NO siguen 3-int (2) ────────────────
  it('interaccion pipeline=252999 (SPY Z87) → _warnings incluye pipeline_sin_interaccion', async () => {
    mocks.setCfg({ listData: [] }); // el view ya los excluye → data vacía
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'interaccion', pipeline: '252999' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body._warnings).toContain('pipeline_sin_interaccion');
  });

  it('interaccion pipeline=273944 (GioVision) → _warnings incluye pipeline_sin_interaccion', async () => {
    mocks.setCfg({ listData: [] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'interaccion', pipeline: '273944' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body._warnings).toContain('pipeline_sin_interaccion');
  });

  // ─── Deferidos / warnings (4) ──────────────────────────────────────────
  it('TODA respuesta incluye _warnings: ["cobertura_5_dias", ...]', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'kpis' } }), res);
    expect(res.body._warnings).toContain('cobertura_5_dias');
  });

  it('kpis difiere coste y velocidad: spend_pendiente + historico_pendiente', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'kpis' } }), res);
    expect(res.body._warnings).toContain('spend_pendiente');
    expect(res.body._warnings).toContain('historico_pendiente');
  });

  it('portafolios → DIFERIDO: data vacía, spend_pendiente, sin tocar DB', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'portafolios' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body._warnings).toContain('spend_pendiente');
    // No hay vista de portafolios → no se consulta ninguna tabla.
    expect(mocks.calls.fromTables.length).toBe(0);
  });

  it('interaccion difiere velocidad: historico_pendiente', async () => {
    mocks.setCfg({ listData: [{ pipeline_id: 0, stage_phase: 'int2', leads: 358 }] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'interaccion' } }), res);
    expect(res.body._warnings).toContain('historico_pendiente');
  });

  // ─── Cache (1) ─────────────────────────────────────────────────────────
  it('cache-control kpis = s-maxage=300, swr=600', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'kpis' } }), res);
    const cc = res.headers['Cache-Control'];
    expect(cc).toContain('s-maxage=300');
    expect(cc).toContain('stale-while-revalidate=600');
  });

  // ─── PII no negociable (2) ─────────────────────────────────────────────
  const PII_RE = /\bname\b|nombre|phone|telefono|\bemail\b|last_message|direccion|diagnostico/i;

  it('funnel: select cols sólo agregados, sin PII raw', async () => {
    mocks.setCfg({ listData: [{ pipeline_id: 0, stage_name: 'NUEVO', stage_phase: 'other', leads: 2275 }] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'funnel' } }), res);
    expect(mocks.calls.selectCols.every((c) => !PII_RE.test(c))).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(PII_RE);
  });

  it('kpis: response no contiene columnas PII raw de contacts', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'kpis' } }), res);
    expect(JSON.stringify(res.body)).not.toMatch(PII_RE);
  });

  // ─── Fallback (1) ──────────────────────────────────────────────────────
  it('503 si vista no existe (mock 42P01) → view_pending_migration_026', async () => {
    mocks.setCfg({ throw42P01: true });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'funnel' } }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('view_pending_migration_026');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// migration 026 · matview marketing (regression guard · no toca DB)
//
// Lección 022: el UNIQUE index para REFRESH ... CONCURRENTLY debe ser sobre
// COLUMNAS REALES, no expresión constante ((1)). Y la regla crítica:
// v_marketing_interaccion DEBE excluir 252999/273944.
// ─────────────────────────────────────────────────────────────────────────
describe('migration 026 · matview marketing (regression guard)', () => {
  const sql = readFileSync(
    resolve(process.cwd(), 'migrations/026_analitica_marketing_proxy.sql'),
    'utf8',
  );
  const exec = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('UNIQUE index sobre columnas reales (pipeline_id, stage_name)', () => {
    expect(exec).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+\w+\s+ON\s+mv_analitica_marketing\s*\(\s*pipeline_id\s*,\s*stage_name\s*\)/i,
    );
  });

  it('NO usa índice de expresión constante ((1))', () => {
    expect(exec).not.toMatch(/\(\(\s*1\s*\)\)/);
  });

  it('REGLA crítica: v_marketing_interaccion excluye 252999 y 273944', () => {
    expect(exec).toMatch(/pipeline_id\s+NOT\s+IN\s*\(\s*252999\s*,\s*273944\s*\)/i);
  });

  it('refresh fn SECURITY DEFINER + REFRESH CONCURRENTLY', () => {
    expect(exec).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+refresh_mv_analitica_marketing/i);
    expect(exec).toMatch(/SECURITY\s+DEFINER/i);
    expect(exec).toMatch(/REFRESH\s+MATERIALIZED\s+VIEW\s+CONCURRENTLY\s+mv_analitica_marketing/i);
  });

  it('idempotente: DROP MATERIALIZED VIEW IF EXISTS ... CASCADE', () => {
    expect(exec).toMatch(/DROP\s+MATERIALIZED\s+VIEW\s+IF\s+EXISTS\s+mv_analitica_marketing\s+CASCADE/i);
  });
});
