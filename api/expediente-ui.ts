/// <reference types="node" />
/**
 * GIOCORE Frente EXP · GET /api/expediente-ui — Módulo M2 (historial del paciente).
 *
 * BFF Origin-gated que arma el "expediente del paciente": sus datos + su historial
 * (expedientes clínicos + citas + atenciones), unidos por `contact_id`.
 *
 * IDENTIDAD: el sistema NO usa un `paciente_id` numérico — la identidad del paciente es
 * `contact_id` (text), la misma llave que usan citas/expedientes/atenciones. Por eso este
 * endpoint recibe `?contact_id=…` (se acepta `?paciente_id=…` como alias por compatibilidad
 * con el lenguaje del brief). NO escribe nada (solo lectura).
 *
 *   GET /api/expediente-ui?contact_id=…   → { ok, paciente, expedientes, citas, atenciones }
 *
 * Robustez:
 *   - Si el paciente no tiene citas/expedientes/atenciones → listas vacías, NO error.
 *   - `atenciones` puede no existir aún (su migration 032 la aplica otro PR/Isaac): la
 *     consulta es BEST-EFFORT — si la tabla falta, se devuelve [] + flag, sin romper.
 *   - paciente no hallado en contacts → `paciente: null` pero igual se devuelve el historial
 *     que exista por contact_id (no se bloquea con 404; "no error, listas vacías").
 *
 * Privacidad: name/phone/email (contacts), observaciones (expedientes), nota (atenciones)
 *   y nombre/telefono (citas) son PII de acceso interno → SOLO por este path Origin-gated +
 *   no-store, NUNCA logueados, sin endpoint Bearer equivalente.
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

const ORIGIN_RE = /^https:\/\/giolens-dashboard(-[a-z0-9-]+)?\.vercel\.app(\/|$)|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
  const val = headers[name.toLowerCase()];
  if (Array.isArray(val)) return val[0] ?? '';
  return val ?? '';
}
function isAllowedOrigin(req: VercelLikeReq): boolean {
  const source = getHeader(req.headers, 'origin') || getHeader(req.headers, 'referer');
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

const CONTACT_COLS = 'contact_id, name, phone, email';
const EXP_COLS = 'id, fecha_examen, optometrista, venta_cerrada, capturado_desde, observaciones, created_at';
// Citas: incluye PII de la tarjeta (nombre/telefono/producto/resumen) — Origin-gated, igual
// que citas-ui. NO incluye paciente_hash crudo extra ni datos sensibles fuera de lo necesario.
const CITA_COLS = 'id, fecha, hora, estado, tipo_consulta, producto_motivo, nombre_paciente, telefono_paciente, resumen_expediente, created_at';
const ATEN_COLS = 'id, canal, tipo, nota, estado, creado_en';

function firstStr(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t === '' ? null : t;
}

type Supa = NonNullable<ReturnType<typeof buildSupabaseClient>>;

export default async function handler(req: VercelLikeReq, res: VercelLikeRes): Promise<void> {
  const origin = getHeader(req.headers, 'origin');
  setBaseHeaders(res, origin);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method && req.method !== 'GET') {
    res.setHeader?.('Allow', 'GET');
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (!isAllowedOrigin(req)) { res.status(403).json({ ok: false, error: 'origin_forbidden' }); return; }

  const supabase = buildSupabaseClient();
  if (!supabase) { res.status(500).json({ ok: false, error: 'service_unavailable' }); return; }

  const q = (req.query ?? {}) as Record<string, string | string[] | undefined>;
  // `paciente_id` es alias de `contact_id` (el sistema no tiene id numérico de paciente).
  const contactId = firstStr(q.contact_id) ?? firstStr(q.paciente_id);
  if (!contactId) { res.status(400).json({ ok: false, error: 'contact_id_requerido' }); return; }

  // Paciente (best-effort: si no está en el cache contacts, paciente=null pero igual va el historial).
  const { data: paciente, error: pErr } = await supabase
    .from('contacts')
    .select(CONTACT_COLS)
    .eq('contact_id', contactId)
    .limit(1)
    .maybeSingle();
  if (pErr) {
    console.error('[api/expediente-ui paciente]', pErr.code ?? 'err');
    res.status(500).json({ ok: false, error: 'internal_error' });
    return;
  }

  // Expedientes clínicos por contact_id (desc por fecha de examen).
  const { data: expedientes, error: eErr } = await supabase
    .from('expedientes')
    .select(EXP_COLS)
    .eq('contact_id', contactId)
    .order('fecha_examen', { ascending: false })
    .limit(100);
  if (eErr) {
    console.error('[api/expediente-ui expedientes]', eErr.code ?? 'err');
    res.status(500).json({ ok: false, error: 'internal_error' });
    return;
  }

  // Citas por contact_id (desc por fecha/hora).
  const { data: citas, error: cErr } = await supabase
    .from('citas')
    .select(CITA_COLS)
    .eq('contact_id', contactId)
    .order('fecha', { ascending: false })
    .order('hora', { ascending: false })
    .limit(100);
  if (cErr) {
    console.error('[api/expediente-ui citas]', cErr.code ?? 'err');
    res.status(500).json({ ok: false, error: 'internal_error' });
    return;
  }

  // Atenciones por contact_id — BEST-EFFORT: la tabla puede no existir aún (migration 032
  // de otro PR). Si falla por tabla inexistente (u otra causa), devolvemos [] + flag y
  // seguimos: el historial de citas/expedientes no debe romperse por esto.
  let atenciones: unknown[] = [];
  let atencionesDisponible = true;
  {
    const { data: at, error: aErr } = await supabase
      .from('atenciones')
      .select(ATEN_COLS)
      .eq('contact_id', contactId)
      .order('creado_en', { ascending: false })
      .limit(100);
    if (aErr) {
      // No logueamos PII; solo el code (p.ej. 42P01 undefined_table cuando aún no se aplicó 032).
      console.error('[api/expediente-ui atenciones]', aErr.code ?? 'err');
      atencionesDisponible = false;
    } else {
      atenciones = at ?? [];
    }
  }

  res.status(200).json({
    ok: true,
    paciente: paciente ?? null,
    expedientes: expedientes ?? [],
    citas: citas ?? [],
    atenciones,
    atenciones_disponible: atencionesDisponible,
  });
}
