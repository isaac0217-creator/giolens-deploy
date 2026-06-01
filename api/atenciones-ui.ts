/// <reference types="node" />
/**
 * GIOCORE Frente SC · /api/atenciones-ui — Módulo M4 (servicio al cliente / seguimiento)
 *
 * BFF (Backend For Frontend) Origin-gated para registrar y listar atenciones desde el
 * dashboard (public/index.html). El browser llama SIN Bearer — este handler valida
 * Origin/Referer (mismo patrón que /api/citas-ui, /api/expediente-list-ui) y consulta
 * Supabase con service role. Es la ÚNICA ruta que expone/escribe `atenciones`.
 *
 * Métodos:
 *   GET  /api/atenciones-ui?estado=abierta            — listar (filtro por estado)
 *   GET  /api/atenciones-ui?contact_id=...            — historial de un contacto/paciente
 *   POST /api/atenciones-ui  {canal,tipo,nota,contact_id?,estado?}  — crear (estado='abierta')
 *   POST /api/atenciones-ui  {id, estado:'cerrada'}   — cambiar estado (cerrar/reabrir)
 *
 * Seguridad / privacidad:
 *   - SOLO GET/POST/OPTIONS. Otro método → 405.
 *   - Origin/Referer allowlist (giolens-dashboard*.vercel.app + localhost). Falla → 403.
 *   - Cache-Control: no-store.
 *   - `nota` puede contener PII del paciente → NUNCA se loguea. `contact_id` tampoco.
 *     Acceso restringido a este path Origin-gated (no hay endpoint Bearer para atenciones).
 *
 * Robustez: valida entrada y responde 400 con error claro (no 500 feo). Sin PII en logs.
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

/* ── Origin/Referer guard (idéntico a citas-ui / expediente-list-ui) ───────── */

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// Columnas devueltas al dashboard. `nota` se incluye (la recepcionista la necesita) pero
// vive sólo en este path Origin-gated + no-store y NUNCA se loguea.
const SELECT_COLS = 'id, contact_id, canal, tipo, nota, estado, creado_en, actualizado_en';

const ESTADOS_VALIDOS = ['abierta', 'cerrada'] as const;
// Valores sugeridos (no se rechazan otros para no acoplar el back a la taxonomía del bot,
// pero sí se exige no-vacío). Tope de longitud defensivo.
const CANAL_MAX = 40;
const TIPO_MAX = 40;
const NOTA_MAX = 2000;

function firstStr(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t === '' ? null : t;
}

/** Sanea texto plano breve: quita controles, colapsa espacios, recorta. Vacío → null. */
function sanitizeText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, max).trim();
}

/** Sanea `nota`: preserva saltos de línea (solo quita controles peligrosos), recorta. */
function sanitizeNota(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Conserva \n y \t; quita el resto de controles C0/C1 + DEL.
  const cleaned = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, NOTA_MAX).trim();
}

function parseBody(raw: unknown): Record<string, unknown> | null {
  let b: unknown = raw;
  if (typeof raw === 'string') {
    try { b = JSON.parse(raw); } catch { return null; }
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  return b as Record<string, unknown>;
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  const origin = getHeader(req.headers, 'origin');
  setBaseHeaders(res, origin);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader?.('Allow', 'GET, POST');
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (!isAllowedOrigin(req)) {
    res.status(403).json({ ok: false, error: 'origin_forbidden' });
    return;
  }

  const supabase = buildSupabaseClient();
  if (!supabase) {
    res.status(500).json({ ok: false, error: 'service_unavailable' });
    return;
  }

  if (req.method === 'GET') {
    await handleList(req, res, supabase);
    return;
  }
  await handlePost(req, res, supabase);
}

type Supa = NonNullable<ReturnType<typeof buildSupabaseClient>>;

async function handleList(req: VercelLikeReq, res: VercelLikeRes, supabase: Supa): Promise<void> {
  const q = (req.query ?? {}) as Record<string, string | string[] | undefined>;
  const page = Math.max(1, parseInt(String(firstStr(q.page) ?? '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(firstStr(q.page_size) ?? '50'), 10) || 50));
  const offset = (page - 1) * pageSize;

  const estado = firstStr(q.estado);
  const contactId = firstStr(q.contact_id);

  let query = supabase
    .from('atenciones')
    .select(SELECT_COLS, { count: 'exact' })
    .order('creado_en', { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (estado && (ESTADOS_VALIDOS as readonly string[]).includes(estado)) {
    query = query.eq('estado', estado);
  }
  if (contactId) query = query.eq('contact_id', contactId);

  const { data, error, count } = await query;
  if (error) {
    // No filtrar el mensaje crudo de Postgres (puede revelar estructura).
    console.error('[api/atenciones-ui GET]', error.code ?? 'err');
    res.status(500).json({ ok: false, error: 'internal_error' });
    return;
  }

  res.status(200).json({
    ok: true,
    total: count ?? 0,
    page,
    page_size: pageSize,
    atenciones: data ?? [],
  });
}

async function handlePost(req: VercelLikeReq, res: VercelLikeRes, supabase: Supa): Promise<void> {
  const body = parseBody(req.body);
  if (!body) {
    res.status(400).json({ ok: false, error: 'invalid_body' });
    return;
  }

  // ── Rama 1: cambio de estado (cerrar/reabrir) — distinguida por la presencia de `id` ──
  if (body.id != null) {
    const id = parseInt(String(body.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ ok: false, error: 'id_invalido' });
      return;
    }
    const estado = sanitizeText(body.estado, 16);
    if (!estado || !(ESTADOS_VALIDOS as readonly string[]).includes(estado)) {
      res.status(400).json({ ok: false, error: 'estado_invalido', detail: `estado debe ser uno de: ${ESTADOS_VALIDOS.join(', ')}` });
      return;
    }
    const { data, error } = await supabase
      .from('atenciones')
      .update({ estado, actualizado_en: new Date().toISOString() })
      .eq('id', id)
      .select('id, estado')
      .maybeSingle();
    if (error) {
      console.error('[api/atenciones-ui POST update]', error.code ?? 'err');
      res.status(500).json({ ok: false, error: 'internal_error' });
      return;
    }
    if (!data) {
      res.status(404).json({ ok: false, error: 'atencion_no_encontrada' });
      return;
    }
    res.status(200).json({ ok: true, id: (data as { id: number }).id, estado: (data as { estado: string }).estado });
    return;
  }

  // ── Rama 2: crear atención ──
  const canal = sanitizeText(body.canal, CANAL_MAX);
  const tipo = sanitizeText(body.tipo, TIPO_MAX);
  const nota = sanitizeNota(body.nota);
  const contactId = sanitizeText(body.contact_id, 128);
  let estado = sanitizeText(body.estado, 16) ?? 'abierta';

  if (!canal) { res.status(400).json({ ok: false, error: 'canal_requerido' }); return; }
  if (!tipo) { res.status(400).json({ ok: false, error: 'tipo_requerido' }); return; }
  if (!(ESTADOS_VALIDOS as readonly string[]).includes(estado)) estado = 'abierta';

  // Si viene contact_id, validar best-effort que exista en contacts (no romper si la
  // consulta falla por infra: en ese caso se permite el insert, el contacto es opcional).
  if (contactId) {
    const { data: c, error: cErr } = await supabase
      .from('contacts')
      .select('id')
      .eq('contact_id', contactId)
      .limit(1)
      .maybeSingle();
    if (!cErr && !c) {
      res.status(400).json({ ok: false, error: 'contacto_no_encontrado' });
      return;
    }
  }

  const { data, error } = await supabase
    .from('atenciones')
    .insert({ contact_id: contactId, canal, tipo, nota, estado })
    .select('id')
    .single();
  if (error) {
    console.error('[api/atenciones-ui POST insert]', error.code ?? 'err');
    res.status(500).json({ ok: false, error: 'internal_error' });
    return;
  }
  res.status(201).json({ ok: true, id: (data as { id: number }).id });
}
