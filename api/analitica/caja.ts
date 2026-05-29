/**
 * api/analitica/caja.ts — Frente I.4 · BFF Analítica de Caja (v1 SOLO-VOLUMEN)
 *
 * Sirve métricas derivadas de `mv_analitica_caja` + vistas auxiliares
 * (migration 027). Espejo arquitectónico de api/analitica/clinica.ts (I.2) y
 * api/analitica/marketing.ts (I.3).
 *
 * ⚠ VEREDICTO SPIKE (CAJA_DATA_INVENTORY.md, sesión 12): I4-SOLO-VOLUMEN.
 *   NO existe fuente de monto/medio de pago en Supabase (los precios/ventas
 *   viven en eOptis · Issue #8). Todo KPI monetario (ingreso_*, ticket_promedio)
 *   se devuelve NULL y SIEMPRE se marca _warnings:['caja_monto_pendiente'].
 *   "Operación de caja" v1 = movimiento tipo='salida' (línea de salida de
 *   inventario). NO inventar montos.
 *
 * Naming: "caja operativa / aproximada", NUNCA "contable" (son conteos de
 *   operaciones de inventario, no un libro contable formal).
 *
 * Métricas soportadas (?metric=):
 *   - kpis          (default) → v_analitica_caja_kpis (1 row: operaciones/unidades 30/60/90 + ingreso NULL)
 *   - flujo         → v_caja_flujo (serie por día, 90d · ingreso NULL)
 *   - horarios      → v_caja_horarios (distribución por franja horaria local)
 *   - dia_semana    → v_caja_dia_semana (distribución por día de semana local)
 *   - medios        → DIFERIDO (no hay medio_pago) → data:[] + _warnings['medio_pago_pendiente']
 *   - mix_categoria → v_caja_mix_categoria (operaciones por categoría de producto)
 *   - comparativo   → v_caja_comparativo (1 row: variación vs periodo anterior 30/60/90)
 *
 * Parámetros (?periodo, ?limit):
 *   - periodo: 30 | 60 | 90 (default 30) · informativo (vistas con ventana fija 90d).
 *   - limit:   1..100 (clamp silente a 100; default 50).
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}.
 *   - Sin header → 401 · header presente pero inválido → 403.
 * CORS: misma allowlist que api/analitica/clinica.ts.
 *
 * Fallback: si la matview/vista no existe (Postgres '42P01'), responde 503
 *   `view_pending_migration_027` (no expone detalles internos).
 *
 * PII — NO NEGOCIABLE: este endpoint NUNCA expone cliente individual,
 *   paciente_hash, ni identificador de transacción crudo. Sólo agregados
 *   (conteos, unidades). Columnas explícitas (NO SELECT *).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { timingSafeBearer } from '../../agents/_shared/auth/bearer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
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
  'flujo',
  'horarios',
  'dia_semana',
  'medios',
  'mix_categoria',
  'comparativo',
] as const;
type Metric = typeof VALID_METRICS[number];

const VALID_PERIODOS = [30, 60, 90] as const;

const HARD_LIMIT_MAX = 100;
const DEFAULT_LIMIT = 50;

/** Cache-Control per-metric (todos lentos — refresh horario via cron). */
const CACHE_PER_METRIC: Record<Metric, { sMaxage: number; swr: number }> = {
  kpis:          { sMaxage: 300, swr: 600 },
  flujo:         { sMaxage: 300, swr: 600 },
  horarios:      { sMaxage: 300, swr: 600 },
  dia_semana:    { sMaxage: 300, swr: 600 },
  medios:        { sMaxage: 300, swr: 600 },
  mix_categoria: { sMaxage: 300, swr: 600 },
  comparativo:   { sMaxage: 300, swr: 600 },
};

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

type AuthResult = 'ok' | 'missing' | 'invalid';

/** Distingue header ausente (401) de header presente-pero-inválido (403). */
function authResult(req: VercelLikeReq): AuthResult {
  const auth = req.headers.authorization;
  const authStr =
    typeof auth === 'string'
      ? auth
      : Array.isArray(auth)
        ? auth[0] ?? ''
        : '';
  if (!authStr) return 'missing';
  const secret = process.env.CRON_SECRET;
  if (!secret) return 'invalid';
  return timingSafeBearer(authStr, secret) ? 'ok' : 'invalid';
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

/**
 * Warnings por métrica. v1 SOLO-VOLUMEN → SIEMPRE 'caja_monto_pendiente'
 * (no hay fuente de monto · Issue #8). 'medios' suma 'medio_pago_pendiente'.
 * 'sin_datos' cuando el resultado viene vacío.
 */
function computeWarnings(metric: Metric, data: unknown): string[] {
  const w: string[] = ['caja_monto_pendiente'];
  if (metric === 'medios') w.push('medio_pago_pendiente');
  const empty =
    data == null ||
    (Array.isArray(data) && data.length === 0) ||
    (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0);
  if (empty) w.push('sin_datos');
  return w;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-metric queries (columnas explícitas · sin PII raw · sin SELECT *)
// ─────────────────────────────────────────────────────────────────────────────

const KPI_COLS =
  'operaciones_30d, operaciones_60d, operaciones_90d, ' +
  'unidades_30d, unidades_60d, unidades_90d, ' +
  'ingreso_30d, ingreso_60d, ingreso_90d, ticket_promedio_30d';
const FLUJO_COLS = 'dia, operaciones, unidades, ingreso';
const HORARIOS_COLS = 'franja_hora, operaciones, unidades';
const DIA_SEMANA_COLS = 'dia_semana, dia_semana_nombre, operaciones, unidades';
const MIX_COLS = 'categoria, operaciones, unidades';
const COMPARATIVO_COLS =
  'operaciones_actual_30d, operaciones_previo_30d, variacion_30d_pct, ' +
  'operaciones_actual_60d, operaciones_previo_60d, variacion_60d_pct, ' +
  'operaciones_actual_90d, operaciones_previo_90d, variacion_90d_pct, ' +
  'ingreso_actual_30d, ingreso_previo_30d';

async function runMetricQuery(
  supa: SupabaseClient,
  metric: Metric,
  limit: number,
): Promise<{ data: unknown; count: number }> {
  switch (metric) {
    case 'kpis': {
      const { data, error } = await supa
        .from('v_analitica_caja_kpis')
        .select(KPI_COLS)
        .single();
      if (error) throw error;
      return { data, count: data ? 1 : 0 };
    }
    case 'flujo': {
      const { data, error } = await supa
        .from('v_caja_flujo')
        .select(FLUJO_COLS)
        .order('dia', { ascending: true })
        .limit(limit);
      if (error) throw error;
      return { data: data ?? [], count: data?.length ?? 0 };
    }
    case 'horarios': {
      const { data, error } = await supa
        .from('v_caja_horarios')
        .select(HORARIOS_COLS)
        .order('franja_hora', { ascending: true })
        .limit(limit);
      if (error) throw error;
      return { data: data ?? [], count: data?.length ?? 0 };
    }
    case 'dia_semana': {
      const { data, error } = await supa
        .from('v_caja_dia_semana')
        .select(DIA_SEMANA_COLS)
        .order('dia_semana', { ascending: true })
        .limit(limit);
      if (error) throw error;
      return { data: data ?? [], count: data?.length ?? 0 };
    }
    case 'medios': {
      // DIFERIDO: productos_movimientos no registra medio de pago (veredicto
      // spike). Sin query — data vacía; _warnings['medio_pago_pendiente'] le
      // dice a la UI que muestre el badge "medio de pago pendiente". NO inventar.
      return { data: [], count: 0 };
    }
    case 'mix_categoria': {
      const { data, error } = await supa
        .from('v_caja_mix_categoria')
        .select(MIX_COLS)
        .order('operaciones', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return { data: data ?? [], count: data?.length ?? 0 };
    }
    case 'comparativo': {
      const { data, error } = await supa
        .from('v_caja_comparativo')
        .select(COMPARATIVO_COLS)
        .single();
      if (error) throw error;
      return { data, count: data ? 1 : 0 };
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

  const auth = authResult(req);
  if (auth === 'missing') {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  if (auth === 'invalid') {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return;
  }

  // ─── Validación params ───
  const metricRaw = (readQuery(req, 'metric') ?? 'kpis') as Metric;
  if (!VALID_METRICS.includes(metricRaw)) {
    res.status(400).json({ ok: false, error: 'invalid_metric', allowed: VALID_METRICS });
    return;
  }
  const metric = metricRaw as Metric;

  const periodoRaw = readQuery(req, 'periodo') ?? '30';
  const periodo = Number(periodoRaw);
  if (
    !Number.isFinite(periodo) ||
    !VALID_PERIODOS.includes(periodo as 30 | 60 | 90)
  ) {
    res.status(400).json({ ok: false, error: 'invalid_periodo', allowed: VALID_PERIODOS });
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
      console.warn(`[analitica/caja] limit ${limit} > ${HARD_LIMIT_MAX}, clamping`);
      limit = HARD_LIMIT_MAX;
      limitClamped = true;
    }
  }

  // ─── Cache header per-metric ───
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
    const { data, count } = await runMetricQuery(supa, metric, limit);
    const _warnings = computeWarnings(metric, data);
    res.status(200).json({
      ok: true,
      metric,
      periodo,
      limit,
      ...(limitClamped ? { warning: `limit clamped to ${HARD_LIMIT_MAX}` } : {}),
      generated_at: new Date().toISOString(),
      data,
      count,
      _warnings,
    });
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    if (
      err?.code === '42P01' ||
      /relation .* does not exist/i.test(err?.message ?? '')
    ) {
      res.status(503).json({ ok: false, error: 'view_pending_migration_027' });
      return;
    }
    console.error('[analitica/caja]', err?.message ?? e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
}
