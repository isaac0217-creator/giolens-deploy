/**
 * api/analitica/clinica.ts — Frente I.2 · BFF Analítica Clínica
 *
 * Sirve 5 métricas derivadas de `mv_analitica_clinica` + vistas auxiliares
 * (migration 019). Espejo arquitectónico de api/analitica/inventario.ts (I.1).
 *
 * Métricas soportadas (?metric=):
 *   - kpis              → v_analitica_clinica_kpis (1 row, 8 KPIs escalares)
 *   - conversion_funnel → v_clinica_conversion_funnel (1 row, 3 stages)
 *   - recurrencia       → v_clinica_recurrencia (histograma pacientes por nº citas)
 *   - productividad     → v_clinica_productividad (ranking optometristas, 30d)
 *   - alertas           → v_clinica_alertas (pacientes sin cita real >180d)
 *
 * Parámetros (?periodo, ?limit, ?optometrista):
 *   - periodo: 30 | 60 | 90 | 180 (default 30) · informativo (vistas con ventana fija)
 *   - limit:   1..100 (clamp silente a 100 si > 100; default 10)
 *   - optometrista: filtro eq() opcional en productividad (parameter binding, NO concat)
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}.
 *   - Sin header Authorization → 401 Unauthorized
 *   - Header presente pero inválido → 403 Forbidden
 * CORS: misma allowlist que api/analitica/inventario.ts.
 *
 * Fallback: si la matview/vista no existe (Postgres '42P01'), responde 503
 * con `view_pending_migration_019` (no expone detalles internos).
 *
 * PII — NO NEGOCIABLE: este endpoint NUNCA expone columnas raw de pacientes ni
 * expedientes (nombre, teléfono, email, dirección, motivo, diagnóstico). El único
 * identificador permitido es `paciente_hash` (SHA256[:16], ya anonimizado) en la
 * métrica `alertas`. Todas las columnas de cada query son explícitas (NO SELECT *).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { timingSafeBearer } from '../../agents/_shared/auth/bearer.js';

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
  'conversion_funnel',
  'recurrencia',
  'productividad',
  'alertas',
] as const;
type Metric = typeof VALID_METRICS[number];

const VALID_PERIODOS = [30, 60, 90, 180] as const;

/** Cache-Control per-metric — alertas cambia rápido, KPIs/rankings lento. */
const CACHE_PER_METRIC: Record<Metric, { sMaxage: number; swr: number }> = {
  kpis:              { sMaxage: 300, swr: 600 },
  conversion_funnel: { sMaxage: 300, swr: 600 },
  recurrencia:       { sMaxage: 300, swr: 600 },
  productividad:     { sMaxage: 300, swr: 600 },
  alertas:           { sMaxage: 120, swr: 60  },
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
 * Detecta gaps de datos clínicos para que la UI muestre badge
 * "datos clínicos pendientes" (mismo patrón que _warnings de I.1).
 */
function computeClinicalWarnings(metric: Metric, data: unknown): string[] {
  let empty = false;
  if (metric === 'kpis') {
    const d = (data ?? null) as Record<string, unknown> | null;
    empty =
      d == null ||
      (d.expediente_to_cita_rate == null &&
        d.cita_show_rate == null &&
        Number(d.citas_confirmadas_30d ?? 0) === 0);
  } else if (metric === 'conversion_funnel') {
    const d = (data ?? null) as Record<string, unknown> | null;
    empty = d == null || Number(d.expedientes_90d ?? 0) === 0;
  } else {
    empty = !Array.isArray(data) || data.length === 0;
  }
  return empty ? ['datos_clinicos_pendientes'] : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-metric queries (no SELECT * · columnas explícitas · sin columnas PII raw)
// ─────────────────────────────────────────────────────────────────────────────

const KPI_COLS =
  'expediente_to_cita_rate, cita_show_rate, expediente_to_venta_rate, ' +
  'recurrencia_60d, tiempo_entre_citas_promedio_dias, citas_confirmadas_30d, ' +
  'salidas_unidades_30d, alertas_seguimiento_count';

const FUNNEL_COLS =
  'expedientes_90d, expedientes_con_cita_90d, expedientes_con_venta_60d';

const RECURRENCIA_COLS = 'num_citas_bucket, pacientes';

const PRODUCTIVIDAD_COLS = 'optometrista, citas_confirmadas_30d';

const ALERTAS_COLS = 'paciente_hash, ultima_cita_fecha, dias_sin_cita';

async function runMetricQuery(
  supa: SupabaseClient,
  metric: Metric,
  limit: number,
  optometrista: string | null,
): Promise<{ data: unknown; count: number }> {
  switch (metric) {
    case 'kpis': {
      const { data, error } = await supa
        .from('v_analitica_clinica_kpis')
        .select(KPI_COLS)
        .single();
      if (error) throw error;
      return { data, count: data ? 1 : 0 };
    }
    case 'conversion_funnel': {
      const { data, error } = await supa
        .from('v_clinica_conversion_funnel')
        .select(FUNNEL_COLS)
        .single();
      if (error) throw error;
      return { data, count: data ? 1 : 0 };
    }
    case 'recurrencia': {
      const { data, error } = await supa
        .from('v_clinica_recurrencia')
        .select(RECURRENCIA_COLS)
        .order('num_citas_bucket', { ascending: true })
        .limit(limit);
      if (error) throw error;
      return { data: data ?? [], count: data?.length ?? 0 };
    }
    case 'productividad': {
      let q = supa
        .from('v_clinica_productividad')
        .select(PRODUCTIVIDAD_COLS)
        .order('citas_confirmadas_30d', { ascending: false, nullsFirst: false })
        .limit(limit);
      if (optometrista) {
        // El view normaliza con lower(trim()); igualamos el binding (NO concat).
        q = q.eq('optometrista', optometrista.trim().toLowerCase());
      }
      const { data, error } = await q;
      if (error) throw error;
      return { data: data ?? [], count: data?.length ?? 0 };
    }
    case 'alertas': {
      const { data, error } = await supa
        .from('v_clinica_alertas')
        .select(ALERTAS_COLS)
        .order('dias_sin_cita', { ascending: false })
        .limit(limit);
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
    !VALID_PERIODOS.includes(periodo as 30 | 60 | 90 | 180)
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
      console.warn(`[analitica/clinica] limit ${limit} > ${HARD_LIMIT_MAX}, clamping`);
      limit = HARD_LIMIT_MAX;
      limitClamped = true;
    }
  }

  const optometrista = readQuery(req, 'optometrista');
  // Filtro con parameter binding del supabase client (NO concat de strings).

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
    const { data, count } = await runMetricQuery(supa, metric, limit, optometrista);
    const _warnings = computeClinicalWarnings(metric, data);
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
      res.status(503).json({ ok: false, error: 'view_pending_migration_019' });
      return;
    }
    console.error('[analitica/clinica]', err?.message ?? e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
}
