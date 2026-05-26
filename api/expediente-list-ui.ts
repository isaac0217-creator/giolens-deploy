/// <reference types="node" />
/**
 * GIOCORE Frente EXP — GET /api/expediente-list-ui
 *
 * BFF (Backend For Frontend) para la vista "Expedientes" del dashboard.
 * El browser llama aquí SIN Bearer — este handler valida Origin/Referer
 * y consulta directamente Supabase con service role.
 *
 * Los handlers con Bearer (`GET /api/expediente`) siguen accesibles para
 * crons, scripts y futuras integraciones programáticas. Este BFF es
 * exclusivamente lo que el dashboard browser consume.
 *
 * Seguridad:
 *   - Solo GET.
 *   - Origin/Referer check: giolens-dashboard*.vercel.app + localhost.
 *   - Cache-Control: no-store.
 *   - Devuelve únicamente campos no-PII (lista explícita).
 *
 * Query params: fecha_desde, fecha_hasta, optometrista,
 *               limit (default 20, max 100), offset (default 0).
 *               (pipeline_id ignorado — no existe en tabla expedientes)
 *
 * Respuesta: { data: [...], total: N, limit: L, offset: O, has_more: bool }
 */

import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';

/* ── PII sanitizer ──────────────────────────────────────────────────────── */

/** Computa sha256(email|telefono).slice(0,16) — NUNCA devuelve PII. */
function pacienteHash(row: { paciente_email?: string | null; paciente_telefono?: string | null }): string {
  const seed = `${row.paciente_email ?? ''}|${row.paciente_telefono ?? ''}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

interface VercelLikeReq {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}
interface VercelLikeRes {
  status(code: number): VercelLikeRes;
  json(body: unknown): VercelLikeRes;
  end(): void;
  setHeader?(name: string, value: string): VercelLikeRes;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

const ORIGIN_RE = /^https:\/\/giolens-dashboard(-[a-z0-9-]+)?\.vercel\.app(\/|$)|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
  const val = headers[name.toLowerCase()];
  if (Array.isArray(val)) return val[0] ?? '';
  return val ?? '';
}

function isAllowedOrigin(req: VercelLikeReq): boolean {
  const origin = getHeader(req.headers, 'origin');
  const referer = getHeader(req.headers, 'referer');
  const source = origin || referer;
  if (!source) return false;
  return ORIGIN_RE.test(source);
}

function buildSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL no está definido en el entorno');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no está definido en el entorno');
  return createClient(url, key, { auth: { persistSession: false } });
}

function setBaseHeaders(res: VercelLikeRes, origin: string): void {
  if (typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const allowOrigin = ORIGIN_RE.test(origin) ? origin : 'https://giolens-dashboard.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// Columnas internas — incluye email+telefono para computar hash; se stripean antes del response.
// NUNCA devolver al cliente: paciente_nombre, paciente_telefono, paciente_email, firma_data_url.
// pipeline_id no existe en la tabla expedientes (TODO si se añade en el futuro).
const SELECT_COLS = [
  'id',
  'paciente_email',
  'paciente_telefono',
  'fecha_examen',
  'optometrista',
  'observaciones',
  'capturado_por',
  'created_at',
].join(', ');

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  const origin = getHeader(req.headers, 'origin');
  setBaseHeaders(res, origin);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method && req.method !== 'GET') {
    res.setHeader?.('Allow', 'GET');
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  // Origin/Referer guard
  if (!isAllowedOrigin(req)) {
    res.status(403).json({ ok: false, error: 'origin_forbidden' });
    return;
  }

  // Parse query params
  const q = (req.query ?? {}) as Record<string, string | string[] | undefined>;
  const getStr = (k: string): string | null => {
    const v = q[k];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };

  const fecha_desde = getStr('fecha_desde');
  const fecha_hasta = getStr('fecha_hasta');
  const optometrista = getStr('optometrista');
  // pipeline_id no existe en la tabla expedientes — ignorado.
  // TODO: si se añade pipeline_id en el futuro, reactivar aquí.

  const rawLimit = parseInt(String(q.limit ?? '20'), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  const rawOffset = parseInt(String(q.offset ?? '0'), 10);
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  let supabase: ReturnType<typeof buildSupabaseClient>;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/expediente-list-ui] buildSupabaseClient:', msg);
    res.status(500).json({ ok: false, error: 'service_unavailable' });
    return;
  }

  let query = supabase
    .from('expedientes')
    .select(SELECT_COLS, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (fecha_desde) query = query.gte('fecha_examen', fecha_desde);
  if (fecha_hasta) query = query.lte('fecha_examen', fecha_hasta);
  if (optometrista) query = query.ilike('optometrista', `%${optometrista}%`);

  const { data, error, count } = await query;

  if (error) {
    console.error('[api/expediente-list-ui] query error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
    return;
  }

  // Strip PII — nunca devolver email/telefono/nombre al cliente.
  type RawRow = { id: unknown; paciente_email?: string | null; paciente_telefono?: string | null; fecha_examen?: unknown; optometrista?: unknown; observaciones?: unknown; capturado_por?: unknown; created_at?: unknown };
  const sanitized = ((data ?? []) as unknown as RawRow[]).map((r) => ({
    id: r.id,
    paciente_hash: pacienteHash(r),
    fecha_examen: r.fecha_examen,
    optometrista: r.optometrista,
    observaciones: r.observaciones,
    capturado_por: r.capturado_por,
    created_at: r.created_at,
  }));

  const total = count ?? 0;
  res.status(200).json({
    data: sanitized,
    total,
    limit,
    offset,
    has_more: offset + limit < total,
  });

  // TODO: webhook vault — pendiente decisión arquitectura (daemon local vs cron periódico)
}
