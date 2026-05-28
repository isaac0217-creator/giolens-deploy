/**
 * api/analitica/inventario.ts — Frente I.1 · BFF Analítica Inventario
 *
 * Sirve 6 métricas derivadas de `mv_analitica_inventario` + `v_analitica_inventario_kpis`
 * (migration 015). Cada métrica tiene Cache-Control específico por costo de refresh.
 *
 * Métricas soportadas (?metric=):
 *   - kpis            → vista 1-row con totales y promedios
 *   - top_rotacion    → top N por rotacion_30d DESC
 *   - bottom_rotacion → bottom N por rotacion_30d ASC (estancados)
 *   - stockout        → bajo_minimo = TRUE, orden por ratio_riesgo ASC
 *   - sin_movimiento  → dias_sin_movimiento >= 30 OR NULL, orden por valor_stock DESC
 *   - valorizacion    → orden por valor_stock DESC
 *
 * Parámetros (?periodo, ?limit, ?categoria):
 *   - periodo: 30 | 90 (default 30) · informativo (matview ya tiene ambas ventanas)
 *   - limit:   1..100 (clamp silente a 100 si > 100; default 10)
 *   - categoria: filtro eq() opcional (parameter binding, NO concat)
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}. Sin Bearer → 401.
 * CORS: misma allowlist que api/citas.ts (giolens-dashboard.vercel.app + preview deployments).
 *
 * Fallback: si la matview no existe (Postgres code '42P01'), responde 503
 * con `view_pending_migration_015` (no expone detalles internos).
 *
 * PII: NUNCA expone columnas relacionadas a pacientes/expedientes (esquema separado).
 * NO usa SELECT * — todas las columnas listadas explícitas.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────────────────────
// Types (inline · sin _shared/)
// ─────────────────────────────────────────────────────────────────────────────

interface VercelLikeReq {
  method?: string;
  url?: string;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}

interface VercelLikeRes {
  status(code: number): VercelLikeRes;
  json(body: unknown): VercelLikeRes;
  end(): void;
  setHeader?(name: string, value: string): VercelLikeRes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set<string>([
  'https://giolens-dashboard.vercel.app',
]);
const PROJECT_VERCEL_RE = /^https:\/\/giolens-dashboard(-[a-z0-9-]+){0,3}\.vercel\.app$/;

const VALID_METRICS = [
  'kpis',
  'top_rotacion',
  'bottom_rotacion',
  'stockout',
  'sin_movimiento',
  'valorizacion',
] as const;
type Metric = typeof VALID_METRICS[number];

const VALID_PERIODOS = [30, 90] as const;

/** Cache-Control per-metric — KPIs y stockout vuelan, rankings/valor cambian lento. */
const CACHE_PER_METRIC: Record<Metric, { sMaxage: number; swr: number }> = {
  kpis:            { sMaxage: 120, swr: 60  },
  stockout:        { sMaxage: 120, swr: 60  },
  top_rotacion:    { sMaxage: 600, swr: 300 },
  bottom_rotacion: { sMaxage: 600, swr: 300 },
  sin_movimiento:  { sMaxage: 600, swr: 300 },
  valorizacion:    { sMaxage: 600, swr: 300 },
};

const HARD_LIMIT_MAX = 100;
const DEFAULT_LIMIT = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function setBaseHeaders(res: VercelLikeRes, origin: string | undefined): void {
  if (typeof res.setHeader !== 'function') return;
  const allow =
    origin && (ALLOWED_ORIGINS.has(origin) || PROJECT_VERCEL_RE.test(origin))
      ? origin
      : 'https://giolens-dashboard.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function checkBearer(req: VercelLikeReq): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.authorization;
  const authStr =
    typeof auth === 'string'
      ? auth
      : Array.isArray(auth)
        ? auth[0] ?? ''
        : '';
  return authStr === `Bearer ${secret}`;
}

function buildSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function readQuery(req: VercelLikeReq, name: string): string | null {
  const v = req.query?.[name];
  if (Array.isArray(v)) return v[0] ?? null;
  if (typeof v === 'string') return v;
  if (req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      return u.searchParams.get(name);
    } catch {
      /* noop */
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-metric queries (no SELECT * · columnas explícitas)
// ─────────────────────────────────────────────────────────────────────────────

const KPI_COLS =
  'valor_total_stock, pct_bajo_minimo, productos_sin_movimiento_30d_count, ingresos_30d_total, ingresos_90d_total, rotacion_promedio';

const TOP_ROTACION_COLS =
  'sku, nombre, categoria, rotacion_30d, unidades_30d, ingresos_30d';

const BOTTOM_ROTACION_COLS =
  'sku, nombre, categoria, rotacion_30d, dias_sin_movimiento, stock_actual, valor_stock';

const STOCKOUT_COLS =
  'sku, nombre, categoria, stock_actual, stock_minimo, ratio_riesgo, dias_inventario';

const SIN_MOVIMIENTO_COLS =
  'sku, nombre, categoria, dias_sin_movimiento, stock_actual, valor_stock';

const VALORIZACION_COLS =
  'sku, nombre, categoria, stock_actual, precio_costo, valor_stock';

async function runMetricQuery(
  supa: SupabaseClient,
  metric: Metric,
  limit: number,
  categoria: string | null,
): Promise<{ data: unknown; count?: number }> {
  switch (metric) {
    case 'kpis': {
      const { data, error } = await supa
        .from('v_analitica_inventario_kpis')
        .select(KPI_COLS)
        .single();
      if (error) throw error;
      return { data, count: data ? 1 : 0 };
    }
    case 'top_rotacion': {
      let q = supa
        .from('mv_analitica_inventario')
        .select(TOP_ROTACION_COLS)
        .order('rotacion_30d', { ascending: false, nullsFirst: false })
        .limit(limit);
      if (categoria) q = q.eq('categoria', categoria);
      const { data, error } = await q;
      if (error) throw error;
      return { data: data ?? [], count: data?.length ?? 0 };
    }
    case 'bottom_rotacion': {
      let q = supa
        .from('mv_analitica_inventario')
        .select(BOTTOM_ROTACION_COLS)
        .order('rotacion_30d', { ascending: true, nullsFirst: true })
        .limit(limit);
      if (categoria) q = q.eq('categoria', categoria);
      const { data, error } = await q;
      if (error) throw error;
      return { data: data ?? [], count: data?.length ?? 0 };
    }
    case 'stockout': {
      let q = supa
        .from('mv_analitica_inventario')
        .select(STOCKOUT_COLS)
        .eq('bajo_minimo', true)
        .order('ratio_riesgo', { ascending: true })
        .limit(limit);
      if (categoria) q = q.eq('categoria', categoria);
      const { data, error } = await q;
      if (error) throw error;
      return { data: data ?? [], count: data?.length ?? 0 };
    }
    case 'sin_movimiento': {
      let q = supa
        .from('mv_analitica_inventario')
        .select(SIN_MOVIMIENTO_COLS)
        .or('dias_sin_movimiento.gte.30,dias_sin_movimiento.is.null')
        .order('valor_stock', { ascending: false, nullsFirst: false })
        .limit(limit);
      if (categoria) q = q.eq('categoria', categoria);
      const { data, error } = await q;
      if (error) throw error;
      return { data: data ?? [], count: data?.length ?? 0 };
    }
    case 'valorizacion': {
      let q = supa
        .from('mv_analitica_inventario')
        .select(VALORIZACION_COLS)
        .order('valor_stock', { ascending: false, nullsFirst: false })
        .limit(limit);
      if (categoria) q = q.eq('categoria', categoria);
      const { data, error } = await q;
      if (error) throw error;
      return { data: data ?? [], count: data?.length ?? 0 };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  const origin =
    typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  setBaseHeaders(res, origin);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed', expected: 'GET' });
    return;
  }
  if (!checkBearer(req)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  // ─── Validación params (D-6) ───
  const metricRaw = (readQuery(req, 'metric') ?? 'kpis') as Metric;
  if (!VALID_METRICS.includes(metricRaw)) {
    res.status(400).json({
      ok: false,
      error: 'invalid_metric',
      allowed: VALID_METRICS,
    });
    return;
  }
  const metric = metricRaw as Metric;

  const periodoRaw = readQuery(req, 'periodo') ?? '30';
  const periodo = Number(periodoRaw);
  if (!Number.isFinite(periodo) || !VALID_PERIODOS.includes(periodo as 30 | 90)) {
    res.status(400).json({
      ok: false,
      error: 'invalid_periodo',
      allowed: VALID_PERIODOS,
    });
    return;
  }

  const limitRaw = readQuery(req, 'limit');
  let limit = DEFAULT_LIMIT;
  let limitClamped = false;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n < 1) {
      res.status(400).json({ ok: false, error: 'invalid_limit', expected: '>=1' });
      return;
    }
    limit = Math.floor(n);
    if (limit > HARD_LIMIT_MAX) {
      console.warn(
        `[analitica/inventario] limit ${limit} > ${HARD_LIMIT_MAX}, clamping`,
      );
      limit = HARD_LIMIT_MAX;
      limitClamped = true;
    }
  }

  const categoria = readQuery(req, 'categoria');
  // Filtro con parameter binding del supabase client (NO concat de strings).

  // ─── Cache header per-metric (D-2) ───
  const { sMaxage, swr } = CACHE_PER_METRIC[metric];
  if (res.setHeader) {
    res.setHeader(
      'Cache-Control',
      `public, s-maxage=${sMaxage}, stale-while-revalidate=${swr}`,
    );
  }

  // ─── Build supabase + ejecutar query ───
  const supa = buildSupabaseClient();
  if (!supa) {
    res.status(500).json({ ok: false, error: 'supabase_unavailable' });
    return;
  }

  try {
    const { data, count } = await runMetricQuery(supa, metric, limit, categoria);
    res.status(200).json({
      ok: true,
      metric,
      periodo,
      limit,
      ...(limitClamped ? { warning: `limit clamped to ${HARD_LIMIT_MAX}` } : {}),
      generated_at: new Date().toISOString(),
      data,
      count: count ?? (Array.isArray(data) ? data.length : data ? 1 : 0),
    });
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    if (
      err?.code === '42P01' ||
      /relation .* does not exist/i.test(err?.message ?? '')
    ) {
      res.status(503).json({ ok: false, error: 'view_pending_migration_015' });
      return;
    }
    console.error('[analitica/inventario]', err?.message ?? e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
}
