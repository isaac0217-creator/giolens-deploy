/// <reference types="node" />
/**
 * GIOCORE Frente PAC · /api/pacientes-ui — Módulo M1 (captura / búsqueda de pacientes).
 *
 * DECISIÓN DE ARQUITECTURA (Isaac, Fase 2): NO existe ni se crea una tabla `pacientes`.
 * La identidad del paciente vive en `contacts` (cache del CRM Wapify, 31k, keyed por el
 * contact_id REAL de Wapify) y su historial clínico en `expedientes` (ligado por
 * contact_id TEXT). Este BFF es una CAPA DE LECTURA sobre contacts + expedientes, y de
 * ESCRITURA SOLO sobre `expedientes` (tabla nuestra). NUNCA escribe en `contacts` (es un
 * cache: el cron sync-wapify-cache lo repuebla; un insert local se perdería y no tendría
 * un contact_id real de Wapify).
 *
 * Métodos (todos Origin-gated, igual que citas-ui):
 *   GET  /api/pacientes-ui?q=texto       — buscar en contacts por nombre o teléfono
 *   GET  /api/pacientes-ui?contact_id=…  — detalle del contacto + sus expedientes
 *   POST /api/pacientes-ui  {contact_id} — ASEGURAR expediente: si el contacto existe en
 *                                          contacts y NO tiene expediente, crea uno mínimo
 *                                          ligado por contact_id. Idempotente. NUNCA crea
 *                                          el contacto (si no está en contacts → 404).
 *
 * ⚠️ NOTA PARA COWORK/ISAAC (gate): el expediente creado por el POST lleva
 *   capturado_desde='dashboard_alta' para distinguirlo de un examen clínico real. Como
 *   `expedientes` alimenta la analítica clínica (conteo de exámenes, % venta_cerrada),
 *   estos registros de alta deberían EXCLUIRSE de esos cálculos (filtro
 *   capturado_desde <> 'dashboard_alta' en mv_analitica_clinica) en un follow-up. Por eso
 *   esta rebanada NO modifica la analítica: se reporta para decisión, no se asume.
 *
 * Privacidad: nombre/teléfono/email son PII de acceso interno → se devuelven SOLO por este
 *   path Origin-gated + no-store y NUNCA se loguean. No hay endpoint Bearer equivalente.
 */

import { createClient } from '@supabase/supabase-js';

interface VercelLikeReq {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// PII de acceso interno (este BFF, Origin-gated). No incluye raw_payload ni pipeline interno.
const CONTACT_COLS = 'contact_id, name, phone, email';
// Expedientes del paciente (sin firma ni graduación completa; lo justo para el historial).
const EXP_COLS = 'id, fecha_examen, optometrista, venta_cerrada, capturado_desde, created_at';

function firstStr(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t === '' ? null : t;
}
function parseBody(raw: unknown): Record<string, unknown> | null {
  let b: unknown = raw;
  if (typeof raw === 'string') { try { b = JSON.parse(raw); } catch { return null; } }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  return b as Record<string, unknown>;
}

type Supa = NonNullable<ReturnType<typeof buildSupabaseClient>>;

export default async function handler(req: VercelLikeReq, res: VercelLikeRes): Promise<void> {
  const origin = getHeader(req.headers, 'origin');
  setBaseHeaders(res, origin);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader?.('Allow', 'GET, POST');
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (!isAllowedOrigin(req)) { res.status(403).json({ ok: false, error: 'origin_forbidden' }); return; }

  const supabase = buildSupabaseClient();
  if (!supabase) { res.status(500).json({ ok: false, error: 'service_unavailable' }); return; }

  if (req.method === 'POST') { await asegurarExpediente(req, res, supabase); return; }

  const q = (req.query ?? {}) as Record<string, string | string[] | undefined>;
  const contactId = firstStr(q.contact_id);
  if (contactId) { await detalle(res, supabase, contactId); return; }
  await buscar(req, res, supabase);
}

// ── Búsqueda en contacts por nombre o teléfono (con indicador has_expediente) ──
async function buscar(req: VercelLikeReq, res: VercelLikeRes, supabase: Supa): Promise<void> {
  const q = (req.query ?? {}) as Record<string, string | string[] | undefined>;
  const term = firstStr(q.q);
  if (!term) { res.status(400).json({ ok: false, error: 'q_o_contact_id_requerido' }); return; }
  // Sanea el término contra inyección en el filtro .or()/ilike de PostgREST.
  const safe = term.replace(/[,()%_\\"'*`]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!safe) { res.status(200).json({ ok: true, pacientes: [] }); return; }
  const pattern = `%${safe}%`;

  const { data: contactos, error } = await supabase
    .from('contacts')
    .select(CONTACT_COLS)
    .or(`name.ilike.${pattern},phone.ilike.${pattern}`)
    .not('contact_id', 'is', null)
    .order('name', { ascending: true })
    .limit(50);
  if (error) {
    console.error('[api/pacientes-ui buscar]', error.code ?? 'err');
    res.status(500).json({ ok: false, error: 'internal_error' });
    return;
  }
  const rows = (contactos ?? []) as Array<{ contact_id: string }>;
  // has_expediente en UNA query (sin N+1): set de contact_ids con expediente.
  const ids = rows.map((r) => r.contact_id).filter(Boolean);
  const conExp = new Set<string>();
  if (ids.length > 0) {
    const { data: exps } = await supabase
      .from('expedientes')
      .select('contact_id')
      .in('contact_id', ids);
    for (const e of (exps ?? []) as Array<{ contact_id: string | null }>) {
      if (e.contact_id) conExp.add(e.contact_id);
    }
  }
  const pacientes = rows.map((r) => ({ ...r, has_expediente: conExp.has(r.contact_id) }));
  res.status(200).json({ ok: true, pacientes });
}

// ── Detalle: contacto + sus expedientes ──
async function detalle(res: VercelLikeRes, supabase: Supa, contactId: string): Promise<void> {
  const { data: contacto, error: cErr } = await supabase
    .from('contacts')
    .select(CONTACT_COLS)
    .eq('contact_id', contactId)
    .limit(1)
    .maybeSingle();
  if (cErr) {
    console.error('[api/pacientes-ui detalle contacto]', cErr.code ?? 'err');
    res.status(500).json({ ok: false, error: 'internal_error' });
    return;
  }
  if (!contacto) { res.status(404).json({ ok: false, error: 'paciente_no_encontrado' }); return; }

  const { data: expedientes, error: eErr } = await supabase
    .from('expedientes')
    .select(EXP_COLS)
    .eq('contact_id', contactId)
    .order('fecha_examen', { ascending: false })
    .limit(50);
  if (eErr) {
    console.error('[api/pacientes-ui detalle expedientes]', eErr.code ?? 'err');
    res.status(500).json({ ok: false, error: 'internal_error' });
    return;
  }
  res.status(200).json({ ok: true, paciente: contacto, expedientes: expedientes ?? [] });
}

// ── POST: asegurar expediente para un contacto EXISTENTE sin expediente ──
async function asegurarExpediente(req: VercelLikeReq, res: VercelLikeRes, supabase: Supa): Promise<void> {
  const body = parseBody(req.body);
  if (!body) { res.status(400).json({ ok: false, error: 'invalid_body' }); return; }
  const contactId = typeof body.contact_id === 'string' ? body.contact_id.trim() : '';
  if (!contactId) { res.status(400).json({ ok: false, error: 'contact_id_requerido' }); return; }

  // 1) El contacto DEBE existir en contacts (NUNCA inventamos identidad walk-in).
  const { data: contacto, error: cErr } = await supabase
    .from('contacts')
    .select('contact_id, name, phone, email')
    .eq('contact_id', contactId)
    .limit(1)
    .maybeSingle();
  if (cErr) {
    console.error('[api/pacientes-ui asegurar contacto]', cErr.code ?? 'err');
    res.status(500).json({ ok: false, error: 'internal_error' });
    return;
  }
  if (!contacto) {
    // No está en Wapify: el alta de walk-in NUEVO es una versión futura (no se inventa).
    res.status(404).json({ ok: false, error: 'paciente_no_en_sistema', detail: 'el alta de walk-in nuevo llega en una próxima versión' });
    return;
  }

  // 2) Idempotente: si ya tiene expediente, devolver el más reciente sin crear otro.
  const { data: existente } = await supabase
    .from('expedientes')
    .select('id')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existente) {
    res.status(200).json({ ok: true, created: false, expediente_id: (existente as { id: number }).id });
    return;
  }

  // 3) Crear expediente mínimo TAGUEADO (capturado_desde='dashboard_alta') — intake, no examen.
  const c = contacto as { name: string | null; phone: string | null; email: string | null };
  const capturadoPor = typeof body.capturado_por === 'string' && body.capturado_por.trim()
    ? body.capturado_por.trim().slice(0, 80) : 'dashboard';
  const hoy = new Date().toISOString().slice(0, 10);
  const { data: nuevo, error: insErr } = await supabase
    .from('expedientes')
    .insert({
      contact_id: contactId,
      paciente_nombre: (c.name && c.name.trim()) ? c.name.trim().slice(0, 200) : '(sin nombre)',
      paciente_telefono: c.phone ?? null,
      paciente_email: c.email ?? null,
      fecha_examen: hoy,
      capturado_por: capturadoPor,
      capturado_desde: 'dashboard_alta',
      observaciones: '[Alta desde dashboard — sin examen clínico]',
      venta_cerrada: false,
    })
    .select('id')
    .single();
  if (insErr) {
    console.error('[api/pacientes-ui asegurar insert]', insErr.code ?? 'err');
    res.status(500).json({ ok: false, error: 'internal_error' });
    return;
  }
  res.status(201).json({ ok: true, created: true, expediente_id: (nuevo as { id: number }).id });
}
