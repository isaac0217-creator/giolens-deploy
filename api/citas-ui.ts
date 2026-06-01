/// <reference types="node" />
/**
 * GIOCORE Frente G · GET /api/citas-ui
 *
 * BFF (Backend For Frontend) para la vista "Agenda · Citas del día" del dashboard
 * gen-1 (public/index.html). El browser llama aquí SIN Bearer — este handler
 * valida Origin/Referer (mismo patrón que /api/expediente-list-ui) y consulta
 * Supabase con service role.
 *
 * Por qué existe: /api/citas exige `Authorization: Bearer ${CRON_SECRET}` para
 * TODOS sus métodos (GET/POST/PUT), pensado para crons/scripts. La agenda del
 * dashboard nunca manda ese header → 401 "error al cargar". La recepcionista NO
 * debe pegar un token a mano; este BFF resuelve la lectura igual que los demás
 * `-ui` del proyecto. /api/citas sigue intacto y Bearer-gated para programático.
 *
 * Seguridad:
 *   - SOLO GET (las mutaciones confirmar/cancelar/crear siguen en /api/citas
 *     Bearer-gated; este BFF es de lectura, como expediente-list-ui).
 *   - Origin/Referer check: giolens-dashboard*.vercel.app + localhost.
 *   - Cache-Control: no-store.
 *   - PII de acceso interno: desde la rebanada "tarjeta de agenda enriquecida"
 *     (migration 029), este BFF SÍ devuelve nombre_paciente/telefono_paciente
 *     (PII) y producto_motivo (no PII) para la recepcionista. Desde migration 031
 *     devuelve además resumen_expediente (información CLÍNICA sensible). Todo eso se
 *     expone ÚNICAMENTE por este path Origin-gated + no-store — NUNCA por /api/citas
 *     (Bearer/programático, sigue no-PII) ni en logs. Email/contact_id NUNCA se exponen.
 *
 * Query params: fecha_desde, fecha_hasta, estado, optometrista,
 *               page (default 1), page_size (default 50, max 100).
 * Respuesta: { ok: true, total, page, page_size, citas: [...] }
 */

import { createClient } from '@supabase/supabase-js';

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

/* ── Origin/Referer guard (idéntico a expediente-list-ui) ─────────────────── */

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
  if (!url || !key) return null;
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

// Columnas devueltas al dashboard. Incluye paciente_hash (identificador técnico) +
// los campos de enriquecimiento de la tarjeta de agenda:
//   - nombre_paciente, telefono_paciente: PII de acceso interno (migration 029, solo este BFF).
//   - producto_motivo: NO PII (migration 029).
//   - resumen_expediente: información CLÍNICA sensible (migration 031), acceso interno.
// Email y contact_id (raw) NUNCA se incluyen (no se necesitan en la tarjeta y se evita
// ampliar el blast radius de PII). Esta es la ÚNICA ruta que expone estos campos: NUNCA
// se exponen por /api/citas (Bearer/programático, sigue no-PII) ni en logs.
const SELECT_COLS = [
  'id',
  'fecha',
  'hora',
  'duracion_min',
  'paciente_hash',
  'optometrista',
  'tipo_consulta',
  'estado',
  'notas',
  'gcal_event_id',
  'expediente_id',
  'confirmacion_enviada_at',
  'created_at',
  'updated_at',
  'nombre_paciente',
  'telefono_paciente',
  'producto_motivo',
  'resumen_expediente',
].join(', ');

const ESTADOS_VALIDOS = ['agendada', 'confirmada', 'cancelada', 'realizada'];

function getStr(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t === '' ? null : t;
}

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

  // Origin/Referer guard (reemplaza al Bearer para el browser del dashboard).
  if (!isAllowedOrigin(req)) {
    res.status(403).json({ ok: false, error: 'origin_forbidden' });
    return;
  }

  const supabase = buildSupabaseClient();
  if (!supabase) {
    res.status(500).json({ ok: false, error: 'service_unavailable' });
    return;
  }

  const q = (req.query ?? {}) as Record<string, string | string[] | undefined>;
  const page = Math.max(1, parseInt(String(getStr(q.page) ?? '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(getStr(q.page_size) ?? '50'), 10) || 50));
  const offset = (page - 1) * pageSize;

  const fechaDesde = getStr(q.fecha_desde);
  const fechaHasta = getStr(q.fecha_hasta);
  const estado = getStr(q.estado);
  const optometrista = getStr(q.optometrista);

  let query = supabase
    .from('citas')
    .select(SELECT_COLS, { count: 'exact' })
    .order('fecha', { ascending: true })
    .order('hora', { ascending: true })
    .range(offset, offset + pageSize - 1);

  if (fechaDesde) query = query.gte('fecha', fechaDesde);
  if (fechaHasta) query = query.lte('fecha', fechaHasta);
  if (estado && ESTADOS_VALIDOS.includes(estado)) query = query.eq('estado', estado);
  if (optometrista) {
    // Escapa %, _ y \ para evitar wildcard injection en el ilike.
    const escaped = optometrista.replace(/[%_\\]/g, '\\$&');
    query = query.ilike('optometrista', `%${escaped}%`);
  }

  const { data, error, count } = await query;
  if (error) {
    console.error('[api/citas-ui GET]', error.message);
    res.status(500).json({ ok: false, error: 'internal_error' });
    return;
  }

  res.status(200).json({
    ok: true,
    total: count ?? 0,
    page,
    page_size: pageSize,
    citas: data ?? [],
  });
}
