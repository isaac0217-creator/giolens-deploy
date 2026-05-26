/// <reference types="node" />
/**
 * GIOCORE Frente EXP — GET /api/expediente-detail-ui?id={id}
 *
 * BFF (Backend For Frontend) para el modal de detalle en el dashboard.
 * El browser llama aquí SIN Bearer — este handler valida Origin/Referer
 * y consulta directamente Supabase con service role.
 *
 * Los handlers con Bearer (`GET /api/expediente/:id`) siguen accesibles
 * para crons, scripts y futuras integraciones programáticas.
 *
 * Seguridad:
 *   - Solo GET.
 *   - Origin/Referer check: giolens-dashboard*.vercel.app + localhost.
 *   - Cache-Control: no-store (datos clínicos).
 *   - Lista explícita de columnas — NUNCA campos PII directos.
 *
 * Query param: id (requerido)
 *
 * Respuestas:
 *   200  { ok: true, data: {...} }
 *   400  { ok: false, error: 'id_requerido' }
 *   403  { ok: false, error: 'origin_forbidden' }
 *   404  { ok: false, error: 'not_found' }
 *   405  { ok: false, error: 'method_not_allowed' }
 *   500  { ok: false, error: '...' }
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
// NUNCA devolver al cliente: paciente_nombre, paciente_telefono, paciente_email,
//   vault_md_content, raw_form_data (pueden contener PII serializada).
// pipeline_id no existe en la tabla expedientes (TODO si se añade en el futuro).
const SELECT_COLS = [
  'id',
  'paciente_email',
  'paciente_telefono',
  'contact_id',
  'fecha_examen',
  'optometrista',
  'od_esfera',
  'od_cilindro',
  'od_eje',
  'od_adicion',
  'oi_esfera',
  'oi_cilindro',
  'oi_eje',
  'oi_adicion',
  'distancia_interpupilar',
  'agudeza_visual_od',
  'agudeza_visual_oi',
  'antecedentes',
  'observaciones',
  'productos_recomendados',
  'capturado_por',
  'capturado_desde',
  'firma_data_url',
  'vault_md_path',
  'venta_cerrada',
  'created_at',
  'updated_at',
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

  const rawId = req.query?.id;
  const id = typeof rawId === 'string' ? rawId.trim() : null;

  if (!id) {
    res.status(400).json({ ok: false, error: 'id_requerido' });
    return;
  }

  let supabase: ReturnType<typeof buildSupabaseClient>;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/expediente-detail-ui] buildSupabaseClient:', msg);
    res.status(500).json({ ok: false, error: 'service_unavailable' });
    return;
  }

  const { data, error } = await supabase
    .from('expedientes')
    .select(SELECT_COLS)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error(`[api/expediente-detail-ui] query error · id=${id}:`, error.message);
    res.status(500).json({ ok: false, error: error.message });
    return;
  }

  if (!data) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }

  // Strip PII — nunca devolver email/telefono/nombre/raw_form_data/vault_md_content al cliente.
  type RawDetail = {
    id?: unknown; paciente_email?: string | null; paciente_telefono?: string | null;
    contact_id?: unknown; fecha_examen?: unknown; optometrista?: unknown;
    od_esfera?: unknown; od_cilindro?: unknown; od_eje?: unknown; od_adicion?: unknown;
    oi_esfera?: unknown; oi_cilindro?: unknown; oi_eje?: unknown; oi_adicion?: unknown;
    distancia_interpupilar?: unknown; agudeza_visual_od?: unknown; agudeza_visual_oi?: unknown;
    antecedentes?: unknown; observaciones?: unknown; productos_recomendados?: unknown;
    capturado_por?: unknown; capturado_desde?: unknown; firma_data_url?: unknown;
    vault_md_path?: unknown; venta_cerrada?: unknown; created_at?: unknown; updated_at?: unknown;
  };
  const r = data as RawDetail;
  const sanitized = {
    id: r.id,
    paciente_hash: pacienteHash(r),
    contact_id: r.contact_id,
    fecha_examen: r.fecha_examen,
    optometrista: r.optometrista,
    od_esfera: r.od_esfera,
    od_cilindro: r.od_cilindro,
    od_eje: r.od_eje,
    od_adicion: r.od_adicion,
    oi_esfera: r.oi_esfera,
    oi_cilindro: r.oi_cilindro,
    oi_eje: r.oi_eje,
    oi_adicion: r.oi_adicion,
    distancia_interpupilar: r.distancia_interpupilar,
    agudeza_visual_od: r.agudeza_visual_od,
    agudeza_visual_oi: r.agudeza_visual_oi,
    antecedentes: r.antecedentes,
    observaciones: r.observaciones,
    productos_recomendados: r.productos_recomendados,
    capturado_por: r.capturado_por,
    capturado_desde: r.capturado_desde,
    firma_data_url: r.firma_data_url,
    vault_md_path: r.vault_md_path,
    venta_cerrada: r.venta_cerrada,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };

  res.status(200).json({ ok: true, data: sanitized });

  // TODO: webhook vault — pendiente decisión arquitectura (daemon local vs cron periódico)
}
