/**
 * Frente I.4 · Analítica de Caja (v1 SOLO-VOLUMEN) · Tests GET /api/analitica/caja
 *
 * Cobertura (22 tests + 6 regression guard de migration 027):
 *   Auth (3) · Defaults (2) · Validación params (5) · Metrics shape (5)
 *   · SOLO-VOLUMEN / warnings (4) · PII (1) · Cache (1) · Fallback (1)
 *
 * Patrón clonado de tests/analitica-marketing.test.ts (I.3).
 * Veredicto spike (CAJA_DATA_INVENTORY.md): NO hay fuente de monto en Supabase →
 * TODA respuesta lleva _warnings:['caja_monto_pendiente']; ingreso_* es NULL.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => {
  const calls = {
    fromTables: [] as string[],
    selectCols: [] as string[],
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
      order(col: string, opts: { ascending?: boolean }) { calls.orderCalls.push({ col, opts }); return b; },
      limit(n: number) { calls.limitCalls.push(n); return b; },
      single() {
        calls.singleCalls++;
        if (cfg.throw42P01) {
          return Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "v_analitica_caja_kpis" does not exist' } });
        }
        if (cfg.singleError) return Promise.resolve({ data: null, error: cfg.singleError });
        return Promise.resolve({ data: cfg.singleData ?? null, error: null });
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        if (cfg.throw42P01) {
          return Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "v_caja_flujo" does not exist' } }).then(resolve, reject);
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

describe('GET /api/analitica/caja', () => {
  let handler: (req: unknown, res: unknown) => Promise<void>;

  beforeEach(async () => {
    process.env.CRON_SECRET = 'test_cron_secret_caja';
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';

    Object.values(mocks.calls).forEach((v) => {
      if (Array.isArray(v)) v.length = 0;
    });
    mocks.calls.singleCalls = 0;
    mocks.setCfg({});

    handler = (await import('../api/analitica/caja.ts')).default;
  });

  const FULL_KPIS = {
    operaciones_30d: 1,
    operaciones_60d: 1,
    operaciones_90d: 1,
    unidades_30d: 5,
    unidades_60d: 5,
    unidades_90d: 5,
    ingreso_30d: null,
    ingreso_60d: null,
    ingreso_90d: null,
    ticket_promedio_30d: null,
  };

  const FULL_COMPARATIVO = {
    operaciones_actual_30d: 1,
    operaciones_previo_30d: 0,
    variacion_30d_pct: null,
    operaciones_actual_60d: 1,
    operaciones_previo_60d: 0,
    variacion_60d_pct: null,
    operaciones_actual_90d: 1,
    operaciones_previo_90d: 0,
    variacion_90d_pct: null,
    ingreso_actual_30d: null,
    ingreso_previo_30d: null,
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
  it('sin metric → kpis default sobre v_analitica_caja_kpis', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.metric).toBe('kpis');
    expect(mocks.calls.fromTables).toContain('v_analitica_caja_kpis');
  });

  it('periodo default = 30 (informativo)', async () => {
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
    expect(res.body.allowed).toContain('flujo');
  });

  it('400 periodo inválido (=45)', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { periodo: '45' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_periodo');
    expect(res.body.allowed).toContain(90);
  });

  it('200 limit>100 → clamp a 100 + warning', async () => {
    mocks.setCfg({ listData: [] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'flujo', limit: '500' } }), res);
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

  it('405 método no permitido (POST)', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST' }), res);
    expect(res.statusCode).toBe(405);
    expect(res.body.error).toBe('method_not_allowed');
  });

  // ─── Metrics shape (5) ─────────────────────────────────────────────────
  it('metric=kpis devuelve los 10 keys exactos', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'kpis' } }), res);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(Object.keys(FULL_KPIS).sort());
  });

  it('metric=flujo shape: dia + operaciones + order dia asc', async () => {
    mocks.setCfg({ listData: [{ dia: '2026-05-25', operaciones: 1, unidades: 5, ingreso: null }] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'flujo' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data[0]).toHaveProperty('dia');
    expect(res.body.data[0]).toHaveProperty('operaciones');
    expect(mocks.calls.fromTables).toContain('v_caja_flujo');
    expect(mocks.calls.orderCalls.some((o) => o.col === 'dia' && o.opts.ascending === true)).toBe(true);
  });

  it('metric=horarios shape: franja_hora + operaciones', async () => {
    mocks.setCfg({ listData: [{ franja_hora: 19, operaciones: 1, unidades: 5 }] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'horarios' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data[0]).toHaveProperty('franja_hora');
    expect(res.body.data[0]).toHaveProperty('operaciones');
    expect(mocks.calls.fromTables).toContain('v_caja_horarios');
  });

  it('metric=mix_categoria shape: categoria + operaciones, order operaciones desc', async () => {
    mocks.setCfg({ listData: [{ categoria: 'Armazones', operaciones: 1, unidades: 5 }] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'mix_categoria' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data[0]).toHaveProperty('categoria');
    expect(res.body.data[0]).toHaveProperty('operaciones');
    expect(mocks.calls.orderCalls.some((o) => o.col === 'operaciones' && o.opts.ascending === false)).toBe(true);
  });

  it('metric=comparativo shape: variacion_30d_pct sobre v_caja_comparativo', async () => {
    mocks.setCfg({ singleData: FULL_COMPARATIVO });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'comparativo' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveProperty('variacion_30d_pct');
    expect(mocks.calls.fromTables).toContain('v_caja_comparativo');
  });

  // ─── SOLO-VOLUMEN / warnings (4) ───────────────────────────────────────
  it('TODA respuesta incluye _warnings: ["caja_monto_pendiente"]', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'kpis' } }), res);
    expect(res.body._warnings).toContain('caja_monto_pendiente');
  });

  it('kpis: ingreso_* NULL en data (monto diferido · no inventado)', async () => {
    mocks.setCfg({ singleData: FULL_KPIS });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'kpis' } }), res);
    expect(res.body.data.ingreso_30d).toBeNull();
    expect(res.body.data.ingreso_90d).toBeNull();
    expect(res.body.data.ticket_promedio_30d).toBeNull();
  });

  it('medios → DIFERIDO: data vacía, medio_pago_pendiente, sin tocar DB', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'medios' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body._warnings).toContain('medio_pago_pendiente');
    expect(res.body._warnings).toContain('caja_monto_pendiente');
    // No hay vista de medios → no se consulta ninguna tabla.
    expect(mocks.calls.fromTables.length).toBe(0);
  });

  it('flujo vacío → _warnings incluye sin_datos', async () => {
    mocks.setCfg({ listData: [] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'flujo' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body._warnings).toContain('sin_datos');
  });

  // ─── PII no negociable (1) ─────────────────────────────────────────────
  const PII_RE = /\bname\b|nombre|paciente_hash|phone|telefono|\bemail\b|cliente_id|transaccion_id|idempotency/i;

  it('flujo: select cols sólo agregados, sin PII raw + response sin PII', async () => {
    mocks.setCfg({ listData: [{ dia: '2026-05-25', operaciones: 1, unidades: 5, ingreso: null }] });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'flujo' } }), res);
    expect(mocks.calls.selectCols.every((c) => !PII_RE.test(c))).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(PII_RE);
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

  // ─── Fallback (1) ──────────────────────────────────────────────────────
  it('503 si vista no existe (mock 42P01) → view_pending_migration_027', async () => {
    mocks.setCfg({ throw42P01: true });
    const res = makeRes();
    await handler(makeReq({ query: { metric: 'flujo' } }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('view_pending_migration_027');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// migration 027 · matview caja (regression guard · no toca DB)
//
// Lección 022: el UNIQUE index para REFRESH ... CONCURRENTLY debe ser sobre
// COLUMNA REAL, no expresión constante ((1)). Honestidad SOLO-VOLUMEN: ingreso
// monetario NULL (no se inventa). Grano = tipo='salida'. Franjas en hora local.
// ─────────────────────────────────────────────────────────────────────────
describe('migration 027 · matview caja (regression guard)', () => {
  const sql = readFileSync(
    resolve(process.cwd(), 'migrations/027_analitica_caja.sql'),
    'utf8',
  );
  const exec = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('UNIQUE index singleton sobre columna real (refreshed_at)', () => {
    expect(exec).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+\w+\s+ON\s+mv_analitica_caja\s*\(\s*refreshed_at\s*\)/i,
    );
  });

  it('NO usa índice de expresión constante ((1))', () => {
    expect(exec).not.toMatch(/\(\(\s*1\s*\)\)/);
  });

  it('honestidad SOLO-VOLUMEN: ingreso monetario emitido como NULL (no inventado)', () => {
    expect(exec).toMatch(/NULL::numeric\s+AS\s+ingreso_30d/i);
    expect(exec).toMatch(/NULL::numeric\s+AS\s+ticket_promedio_30d/i);
  });

  it("grano = tipo='salida' (operación de caja v1)", () => {
    expect(exec).toMatch(/tipo\s*=\s*'salida'/i);
  });

  it('franjas en hora local (AT TIME ZONE America/Tijuana)', () => {
    expect(exec).toMatch(/AT\s+TIME\s+ZONE\s+'America\/Tijuana'/i);
  });

  it('refresh fn SECURITY DEFINER + REFRESH CONCURRENTLY + idempotente CASCADE', () => {
    expect(exec).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+refresh_mv_analitica_caja/i);
    expect(exec).toMatch(/SECURITY\s+DEFINER/i);
    expect(exec).toMatch(/REFRESH\s+MATERIALIZED\s+VIEW\s+CONCURRENTLY\s+mv_analitica_caja/i);
    expect(exec).toMatch(/DROP\s+MATERIALIZED\s+VIEW\s+IF\s+EXISTS\s+mv_analitica_caja\s+CASCADE/i);
  });
});
