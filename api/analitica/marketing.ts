/**
 * api/analitica/marketing.ts — Frente I.3 · BFF Analítica Marketing (v1 PROXY)
 *
 * Sirve métricas derivadas de `mv_analitica_marketing` + 4 vistas (migration 026).
 * Espejo arquitectónico de api/analitica/clinica.ts (I.2).
 *
 * v1 = KPIs PROXY del snapshot `contacts` (spike MARKETING_DATA_INVENTORY.md).
 * Los KPIs de COSTE (#1–#3,#10) y VELOCIDAD (#5,#9) se DIFIEREN con _warnings
 * porque sus fuentes (meta_metrics / stage_events) están VACÍAS al 2026-05-28.
 *
 * Métricas soportadas (?metric=):
 *   - kpis        → v_marketing_kpis (total_leads, leads_perdidos, ventas_proxy, tasas)
 *   - funnel      → v_marketing_funnel (leads por stage_name, ordenado desc)
 *   - interaccion → v_marketing_interaccion (3-int por stage_phase; EXCLUYE 252999/273944)
 *   - ruta_split  → v_marketing_ruta_split (medica/comercial/indeterminada)
 *   - portafolios → DIFERIDO (no hay spend Meta) → data:[] + _warnings:['spend_pendiente']
 *
 * Parámetros:
 *   - pipeline: 0 (todos · default) | 216977 | 755062 | 94103 | 252999 | 273944
 *               binding .eq('pipeline_id', n) — NO concat. 0 = fila agregada del view.
 *   - limit:    1..100 (clamp silente a 100; default 50 · funnel tiene ~19 etapas)
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}.
 *   - Sin header → 401 · header inválido → 403.
 * CORS: misma allowlist que api/analitica/clinica.ts.
 *
 * Fallback: si la vista no existe (Postgres '42P01'), responde 503
 *   `view_pending_migration_026` (no expone detalles internos).
 *
 * PII — NO NEGOCIABLE: este endpoint NUNCA expone columnas raw de contacts
 *   (name/phone/email/last_message). Sólo conteos agregados. Columnas explícitas.
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
  'funnel',
  'interaccion',
  'ruta_split',
  'portafolios',
] as const;
type Metric = typeof VALID_METRICS[number];

// 0 = agregado ('todos'). Resto = los 5 pipelines conocidos.
const VALID_PIPELINES = new Set<number>([0, 216977, 755062, 94103, 252999, 273944]);
const DEFAULT_PIPELINE = 0;

// Pipelines SIN metodología 3 interacciones (regla crítica · excluidos en el view).
const PIPELINES_SIN_INTERACCION = new Set<number>([252999, 273944]);

const HARD_LIMIT_MAX = 100;
const DEFAULT_LIMIT = 50;

/** Cache-Control per-metric (todos lentos — refresh horario via cron). */
const CACHE_PER_METRIC: Record<Metric, { sMaxage: number; swr: number }> = {
  kpis:        { sMaxage: 300, swr: 600 },
  funnel:      { sMaxage: 300, swr: 600 },
  interaccion: { sMaxage: 300, swr: 600 },
  ruta_split:  { sMaxage: 300, swr: 600 },
  portafolios: { sMaxage: 300, swr: 600 },
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
 * Warnings por métrica. SIEMPRE incluye 'cobertura_5_dias' (sólo ~5 días de datos,
 * won/lost casi vacíos → no sobre-interpretar). Difiere coste/velocidad donde aplica.
 */
function computeWarnings(metric: Metric, pipeline: number, data: unknown): string[] {
  const w: string[] = ['cobertura_5_dias'];
  if (metric === 'kpis') {
    // #1–#3,#10 coste → spend_pendiente · #5,#9 velocidad → historico_pendiente
    w.push('spend_pendiente', 'historico_pendiente');
  } else if (metric === 'interaccion') {
    w.push('historico_pendiente'); // velocity por etapa diferida
    if (PIPELINES_SIN_INTERACCION.has(pipeline)) w.push('pipeline_sin_interaccion');
  } else if (metric === 'portafolios') {
    w.push('spend_pendiente'); // mix por portafolio Meta diferido
  }
  const empty =
    data == null ||
    (Array.isArray(data) && data.length === 0) ||
    (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0);
  if (empty) w.push('sin_datos');
  return w;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-metric queries (columnas explícitas · sin PII raw · parameter binding)
// ─────────────────────────────────────────────────────────────────────────────

const KPI_COLS =
  'pipeline_id, total_leads, leads_perdidos, ventas_proxy, tasa_perdida_pct, tasa_venta_proxy_pct';
const FUNNEL_COLS = 'pipeline_id, stage_name, stage_phase, leads';
const INTERACCION_COLS = 'pipeline_id, stage_phase, leads';
const RUTA_COLS = 'pipeline_id, ruta, leads';

async function runMetricQuery(
  supa: SupabaseClient,
  metric: Metric,
  pipeline: number,
  limit: number,
): Promise<{ data: unknown; count: number }> {
  switch (metric) {
    case 'kpis': {
      const { data, error } = await supa
        .from('v_marketing_kpis')
        .select(KPI_COLS)
        .eq('pipeline_id', pipeline)
        .maybeSingle();
      if (error) throw error;
      return { data: data ?? null, count: data ? 1 : 0 };
    }
    case 'funnel': {
      const { data, error } = await supa
        .from('v_marketing_funnel')
        .select(FUNNEL_COLS)
        .eq('pipeline_id', pipeline)
        .order('leads', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return { data: data ?? [], count: data?.length ?? 0 };
    }
    case 'interaccion': {
      const { data, error } = await supa
        .from('v_marketing_interaccion')
        .select(INTERACCION_COLS)
        .eq('pipeline_id', pipeline)
        .order('stage_phase', { ascending: true })
        .limit(limit);
      if (error) throw error;
      return { data: data ?? [], count: data?.length ?? 0 };
    }
    case 'ruta_split': {
      const { data, error } = await supa
        .from('v_marketing_ruta_split')
        .select(RUTA_COLS)
        .eq('pipeline_id', pipeline)
        .order('leads', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return { data: data ?? [], count: data?.length ?? 0 };
    }
    case 'portafolios': {
      // DIFERIDO: no hay spend Meta (meta_metrics vacía). Sin query — data vacía,
      // el _warnings 'spend_pendiente' le dice a la UI que muestre el badge.
      return { data: [], count: 0 };
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

  const pipelineRaw = readQuery(req, 'pipeline');
  let pipeline = DEFAULT_PIPELINE;
  if (pipelineRaw !== null) {
    const n = Number(pipelineRaw);
    if (!Number.isInteger(n) || !VALID_PIPELINES.has(n)) {
      res.status(400).json({
        ok: false,
        error: 'invalid_pipeline',
        allowed: [...VALID_PIPELINES],
      });
      return;
    }
    pipeline = n;
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
      console.warn(`[analitica/marketing] limit ${limit} > ${HARD_LIMIT_MAX}, clamping`);
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
    const { data, count } = await runMetricQuery(supa, metric, pipeline, limit);
    const _warnings = computeWarnings(metric, pipeline, data);
    res.status(200).json({
      ok: true,
      metric,
      pipeline,
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
      res.status(503).json({ ok: false, error: 'view_pending_migration_026' });
      return;
    }
    console.error('[analitica/marketing]', err?.message ?? e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
}
