/// <reference types="node" />
/**
 * GIOCORE Bloque 7 — endpoint de lectura del dashboard de consumo.
 *
 * `GET /api/provider-usage?provider={p}&days={n}`
 *
 * Spec: BLOQUE7_SPEC_DASHBOARD_CONSUMO.md §4.
 * Brief Fase 2 (22-may): D2=a → si `provider=wapify` devolver bypass
 * `{ note: 'Wapify no incluido en v1' }` con HTTP 200.
 *
 * Devuelve KPIs agregados (cost total, delta % vs período anterior, tokens,
 * requests), serie diaria y desglose por modelo. NO expone `raw_payload`.
 *
 * Cache: 5 min CDN edge (Cache-Control headers).
 */

import { createClient } from '@supabase/supabase-js';

/* ── Tipos mínimos del handler Vercel ───────────────────────────────────── */

interface VercelLikeReq {
  query?: Record<string, string | string[] | undefined>;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  method?: string;
}
interface VercelLikeRes {
  status(code: number): VercelLikeRes;
  setHeader(name: string, value: string): VercelLikeRes;
  json(body: unknown): VercelLikeRes;
  end(): void;
}

/* ── Configuración ──────────────────────────────────────────────────────── */

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/* ── Helpers ────────────────────────────────────────────────────────────── */

/** Cliente Supabase con service_role (la tabla tiene RLS y este endpoint
 *  sanitiza el output — no expone raw_payload). */
function buildSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL no está definido en el entorno');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no está definido en el entorno');
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Devuelve un string param sin importar si llegó como `string | string[] |
 * undefined`. Si llegan varios (raro en GET) toma el primero.
 */
function pickParam(
  q: VercelLikeReq['query'],
  key: string,
): string | undefined {
  if (!q) return undefined;
  const v = q[key];
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Fallback de parsing de query si el runtime no expone `req.query`. Vercel
 * clásico lo da, pero por defensividad lo extraemos también del `req.url`.
 */
function parseQuery(req: VercelLikeReq): Record<string, string> {
  const out: Record<string, string> = {};
  if (req.query && typeof req.query === 'object') {
    for (const [k, v] of Object.entries(req.query)) {
      if (Array.isArray(v)) out[k] = String(v[0] ?? '');
      else if (v != null) out[k] = String(v);
    }
  }
  if (Object.keys(out).length === 0 && req.url) {
    try {
      const u = new URL(req.url, 'http://x');
      u.searchParams.forEach((v, k) => {
        out[k] = v;
      });
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Formato YYYY-MM-DD en UTC. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Resta `n` días a una fecha (UTC). */
function minusDays(base: Date, n: number): Date {
  return new Date(base.getTime() - n * 86_400_000);
}

/**
 * Calcula delta % de forma segura.
 *  - prev = 0 y curr = 0  → 0
 *  - prev = 0 y curr > 0  → 100 (interpretado como "primer período con datos")
 *  - resto: ((curr - prev) / prev) * 100, redondeado a 2 decimales.
 */
function deltaPct(curr: number, prev: number): number {
  if (prev === 0 && curr === 0) return 0;
  if (prev === 0) return 100;
  return Number((((curr - prev) / prev) * 100).toFixed(2));
}

/** Shape sanitizado de una fila de `provider_usage` (sin raw_payload). */
interface UsageRow {
  period_start: string;
  model: string | null;
  cost_usd: number | string | null;
  tokens_in: number | string | null;
  tokens_in_cached: number | string | null;
  tokens_out: number | string | null;
  requests: number | string | null;
  messages_sent: number | string | null;
  invocations: number | string | null;
}

function n(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const x = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(x) ? x : 0;
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  // CORS básico (consistente con api/meta.js)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const q = parseQuery(req);
  const provider = pickParam(q, 'provider') ?? q.provider;
  const daysRaw = pickParam(q, 'days') ?? q.days;

  if (!provider) {
    res.status(400).json({ error: 'Falta query param `provider`' });
    return;
  }

  let days = parseInt(String(daysRaw ?? DEFAULT_DAYS), 10);
  if (!Number.isFinite(days) || days <= 0) days = DEFAULT_DAYS;
  if (days > MAX_DAYS) days = MAX_DAYS;

  const now = new Date();
  const to = isoDay(now);
  const from = isoDay(minusDays(now, days));
  const prevFrom = isoDay(minusDays(now, days * 2));
  const prevTo = isoDay(minusDays(now, days));

  // D2=a: Wapify excluido de v1 — bypass con shape consistente
  if (provider === 'wapify') {
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.status(200).json({
      provider: 'wapify',
      range: { from, to },
      kpis: {
        cost_usd_total: 0,
        cost_usd_prev_period: 0,
        delta_pct: 0,
        tokens_total: 0,
        requests_total: 0,
      },
      by_day: [],
      by_model: [],
      note: 'Wapify no incluido en v1',
    });
    return;
  }

  let supabase: ReturnType<typeof buildSupabaseClient>;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
    return;
  }

  // Una sola query cubre el período actual + anterior (rango doble) y
  // particionamos en memoria. Más eficiente que dos roundtrips.
  const { data, error } = await supabase
    .from('provider_usage')
    .select(
      'period_start, model, cost_usd, tokens_in, tokens_in_cached, tokens_out, requests, messages_sent, invocations',
    )
    .eq('provider', provider)
    .gte('period_start', prevFrom)
    .lte('period_start', to)
    .order('period_start', { ascending: true });

  if (error) {
    res.status(500).json({ error: `Query a provider_usage falló: ${error.message}` });
    return;
  }

  const rows = (data ?? []) as UsageRow[];

  // Partición período actual vs anterior. `period_start >= from` define el
  // período actual; el resto cae en `prev_period`.
  let costTotal = 0;
  let costPrev = 0;
  let tokensTotal = 0;
  let requestsTotal = 0;
  const byDay = new Map<string, { cost_usd: number; tokens: number }>();
  const byModel = new Map<string, { cost_usd: number; tokens: number }>();

  for (const row of rows) {
    const cost = n(row.cost_usd);
    const tokens = n(row.tokens_in) + n(row.tokens_in_cached) + n(row.tokens_out);
    const requests = n(row.requests);

    if (row.period_start >= from) {
      costTotal += cost;
      tokensTotal += tokens;
      requestsTotal += requests;

      // by_day
      const dayKey = row.period_start;
      const prev = byDay.get(dayKey) ?? { cost_usd: 0, tokens: 0 };
      prev.cost_usd += cost;
      prev.tokens += tokens;
      byDay.set(dayKey, prev);

      // by_model (omitir filas sin model — proveedores sin desglose)
      if (row.model) {
        const m = byModel.get(row.model) ?? { cost_usd: 0, tokens: 0 };
        m.cost_usd += cost;
        m.tokens += tokens;
        byModel.set(row.model, m);
      }
    } else {
      costPrev += cost;
    }
  }

  const by_day = Array.from(byDay.entries())
    .map(([date, v]) => ({
      date,
      cost_usd: Number(v.cost_usd.toFixed(4)),
      tokens: v.tokens,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const by_model = Array.from(byModel.entries())
    .map(([model, v]) => ({
      model,
      cost_usd: Number(v.cost_usd.toFixed(4)),
      tokens: v.tokens,
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd);

  // Cache: 5 min CDN edge (spec §4) — SOLO en respuestas exitosas, para que
  // un 500 transitorio (ej. PostgREST schema cache propagando) no quede pegado.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.status(200).json({
    provider,
    range: { from, to },
    kpis: {
      cost_usd_total: Number(costTotal.toFixed(4)),
      cost_usd_prev_period: Number(costPrev.toFixed(4)),
      delta_pct: deltaPct(costTotal, costPrev),
      tokens_total: tokensTotal,
      requests_total: requestsTotal,
    },
    by_day,
    by_model,
    // Exponemos las fechas del período anterior por trazabilidad (útil para
    // que el frontend muestre "vs período X..Y" en el tooltip del delta).
    prev_range: { from: prevFrom, to: prevTo },
  });
}
