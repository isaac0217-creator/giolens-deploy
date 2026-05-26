/// <reference types="node" />
/**
 * GIOCORE Frente EXP — GET /api/expediente/:id
 *
 * Detalle de un expediente clínico por ID.
 * Auth: Authorization: Bearer {CRON_SECRET} requerido.
 *
 * Devuelve campos clínicos explícitos — NUNCA campos PII directos
 * (paciente_nombre, paciente_telefono, paciente_email, paciente_direccion).
 * Identificador del paciente: sólo `paciente_hash`.
 *
 * Respuestas:
 *   200  { ok: true, data: {...} }
 *   401  { ok: false, error: 'unauthorized' }
 *   404  { ok: false, error: 'not_found' }
 *   405  { ok: false, error: 'method_not_allowed' }
 *   500  { ok: false, error: '...' }
 *
 * Cache-Control: no-store (datos clínicos).
 */

import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';

/* ── PII sanitizer ──────────────────────────────────────────────────────── */

/** Computa sha256(email|telefono).slice(0,16) — NUNCA devuelve PII. */
function pacienteHash(row: { paciente_email?: string | null; paciente_telefono?: string | null }): string {
  const seed = `${row.paciente_email ?? ''}|${row.paciente_telefono ?? ''}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/* ── Tipos handler ──────────────────────────────────────────────────────── */

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

function buildSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL no está definido en el entorno');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no está definido en el entorno');
  return createClient(url, key, { auth: { persistSession: false } });
}

function checkBearer(req: VercelLikeReq): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = typeof req.headers.authorization === 'string'
    ? req.headers.authorization
    : Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0] ?? ''
      : '';
  return auth === `Bearer ${secret}`;
}

function setBaseHeaders(res: VercelLikeRes): void {
  if (typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

/* ── Handler ────────────────────────────────────────────────────────────── */

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

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  setBaseHeaders(res);

  if (req.method !== 'GET') {
    res.setHeader?.('Allow', 'GET');
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  if (!checkBearer(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
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
    console.error('[api/expediente/[id]] buildSupabaseClient:', msg);
    res.status(500).json({ ok: false, error: 'service_unavailable' });
    return;
  }

  const { data, error } = await supabase
    .from('expedientes')
    .select(SELECT_COLS)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error(`[api/expediente/[id]] query error · id=${id}:`, error.message);
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
