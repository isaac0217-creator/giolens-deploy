/**
 * api/citas.ts — Frente G · BFF citas + Calendar Sync
 *
 * Rutas:
 *   POST /api/citas        — crear cita + GCal event + Wapify si confirmada
 *   GET  /api/citas        — listar paginado sin PII
 *   PUT  /api/citas        — actualizar estado (?id=N en query o en body)
 *
 * Reglas PII:
 *   - NUNCA devolver paciente_nombre, paciente_telefono, paciente_email en claro.
 *   - Solo exponer: paciente_hash (SHA256[:16]), fecha, hora, estado, tipo_consulta,
 *     optometrista, gcal_event_id, expediente_id, created_at.
 *
 * GCal (G-1 ✅ aprobado):
 *   - Service Account del consultorio vía GCAL_SERVICE_ACCOUNT_JSON (nunca al repo).
 *   - Calendar ID vía GCAL_CALENDAR_ID.
 *   - Sync unidireccional: GioLens → GCal (G-3 ✅).
 *   - Sin googleapis npm: JWT firmado con crypto nativo Node 22.
 *
 * Wapify (G-2 ✅ aprobado):
 *   - Pipeline exclusivo citas vía WAPIFY_PIPELINE_CITAS (nunca al repo).
 *   - NO tocar pipelines protegidos 252999 ni 273944.
 *   - Reutiliza sendWhatsApp de wapify-notify.js (mismo patrón Frente INV/EXP).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { createHash, createSign } from 'crypto';
import { sendWhatsApp } from '../agents/_shared/providers/wapify-notify.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

/** SHA256(email|telefono)[:16] — mismo patrón que expedientes */
function pacienteHash(email: string | null | undefined, telefono: string | null | undefined): string {
  const seed = `${email ?? ''}|${telefono ?? ''}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

function getStr(v: unknown, max = 500): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

function getInt(v: unknown, fallback: number | null = null): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Campos seguros a exponer (sin PII)
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
  'created_at',
  'updated_at',
].join(', ');

const TIPOS_VALIDOS = ['revision_visual', 'contactologia', 'entrega_producto', 'seguimiento'] as const;
const ESTADOS_VALIDOS = ['agendada', 'confirmada', 'cancelada', 'realizada'] as const;

type TipoCita   = typeof TIPOS_VALIDOS[number];
type EstadoCita = typeof ESTADOS_VALIDOS[number];

// ---------------------------------------------------------------------------
// GCal — JWT firmado con crypto nativo Node 22 (sin googleapis npm)
// ---------------------------------------------------------------------------

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Obtiene access_token de Google OAuth2 usando Service Account JWT. */
async function getGCalToken(): Promise<string | null> {
  const saJson = process.env.GCAL_SERVICE_ACCOUNT_JSON;
  if (!saJson) {
    console.warn('[citas/gcal] GCAL_SERVICE_ACCOUNT_JSON no configurado — GCal sync desactivado');
    return null;
  }
  let sa: ServiceAccountKey;
  try {
    sa = JSON.parse(saJson) as ServiceAccountKey;
  } catch {
    console.error('[citas/gcal] GCAL_SERVICE_ACCOUNT_JSON no es JSON válido');
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim  = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));
  const signing = `${header}.${claim}`;
  let sig: string;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(signing);
    sig = b64url(signer.sign(sa.private_key));
  } catch (err) {
    console.error('[citas/gcal] Error firmando JWT:', err instanceof Error ? err.message : String(err));
    return null;
  }
  const jwt = `${signing}.${sig}`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }).toString(),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const data = await res.json() as { access_token?: string; error?: string };
    if (!data.access_token) {
      console.error('[citas/gcal] Token error:', data.error ?? JSON.stringify(data));
      return null;
    }
    return data.access_token;
  } catch (err) {
    console.error('[citas/gcal] getGCalToken fetch error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Crea evento en Google Calendar. Devuelve gcal_event_id o null (graceful fallback). */
async function createGCalEvent(payload: {
  titulo: string;
  fecha: string;        // YYYY-MM-DD
  hora: string;         // HH:MM
  duracion_min: number;
  notas?: string | null;
}): Promise<string | null> {
  const calendarId = process.env.GCAL_CALENDAR_ID;
  if (!calendarId) {
    console.warn('[citas/gcal] GCAL_CALENDAR_ID no configurado — skip createGCalEvent');
    return null;
  }
  const token = await getGCalToken();
  if (!token) return null;

  const startDt = `${payload.fecha}T${payload.hora}:00`;
  const endMs   = new Date(startDt).getTime() + payload.duracion_min * 60 * 1000;
  const endDt   = new Date(endMs).toISOString().slice(0, 19);

  try {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: payload.titulo,
          description: payload.notas ?? undefined,
          start: { dateTime: startDt, timeZone: 'America/Tijuana' },
          end:   { dateTime: endDt,   timeZone: 'America/Tijuana' },
        }),
        signal: ctl.signal,
      },
    );
    clearTimeout(timer);
    const ev = await res.json() as { id?: string; error?: unknown };
    if (ev.error) {
      console.error('[citas/gcal] createGCalEvent API error:', JSON.stringify(ev.error));
      return null;
    }
    return ev.id ?? null;
  } catch (err) {
    console.error('[citas/gcal] createGCalEvent fetch error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Actualiza evento existente en Google Calendar (PATCH). Graceful fallback si falla. */
async function updateGCalEvent(gcalEventId: string, patch: {
  fecha?: string;
  hora?: string;
  duracion_min?: number;
  estado?: string;
  notas?: string | null;
}): Promise<void> {
  const calendarId = process.env.GCAL_CALENDAR_ID;
  if (!calendarId || !gcalEventId) return;
  const token = await getGCalToken();
  if (!token) return;

  const body: Record<string, unknown> = {};
  if (patch.notas !== undefined) body.description = patch.notas;
  if (patch.estado === 'cancelada') body.status = 'cancelled';
  if (patch.fecha && patch.hora) {
    const startDt = `${patch.fecha}T${patch.hora}:00`;
    const endMs   = new Date(startDt).getTime() + (patch.duracion_min ?? 30) * 60 * 1000;
    body.start = { dateTime: startDt, timeZone: 'America/Tijuana' };
    body.end   = { dateTime: new Date(endMs).toISOString().slice(0, 19), timeZone: 'America/Tijuana' };
  }
  if (Object.keys(body).length === 0) return;

  try {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(gcalEventId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      },
    );
    clearTimeout(timer);
  } catch (err) {
    console.error('[citas/gcal] updateGCalEvent error:', err instanceof Error ? err.message : String(err));
  }
}

/** Cancela evento en GCal (status: cancelled). */
async function cancelGCalEvent(gcalEventId: string): Promise<void> {
  return updateGCalEvent(gcalEventId, { estado: 'cancelada' });
}

// ---------------------------------------------------------------------------
// Wapify — Patrón idéntico a Frente INV/EXP (sendWhatsApp de wapify-notify.js)
// WAPIFY_PIPELINE_CITAS = identificador del pipeline de citas (nuevo, no protegido)
// ---------------------------------------------------------------------------

async function sendWapifyConfirmacion(cita: {
  paciente_hash: string;
  fecha: string;
  hora: string;
  tipo_consulta: string | null;
  gcal_event_id: string | null;
}): Promise<void> {
  const pipelineId = process.env.WAPIFY_PIPELINE_CITAS;
  if (!pipelineId) {
    console.warn('[citas/wapify] WAPIFY_PIPELINE_CITAS no configurado — skip WhatsApp confirmación');
    return;
  }
  // Enviar notificación al número de administración (mismo patrón Frente EXP)
  const numero = process.env.WHATSAPP_ISAAC;
  if (!numero) {
    console.warn('[citas/wapify] WHATSAPP_ISAAC no configurado — skip WhatsApp confirmación');
    return;
  }
  const gcalLink = cita.gcal_event_id
    ? `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(cita.gcal_event_id)}`
    : null;
  const tipoLabel: Record<string, string> = {
    revision_visual:   'Revisión visual',
    contactologia:     'Contactología',
    entrega_producto:  'Entrega de producto',
    seguimiento:       'Seguimiento',
  };
  const tipo = tipoLabel[cita.tipo_consulta ?? ''] ?? cita.tipo_consulta ?? 'Consulta';
  const msg = [
    `✅ Cita confirmada — GioLens`,
    `📅 ${cita.fecha} a las ${cita.hora}`,
    `🩺 ${tipo}`,
    `👤 Hash: ${cita.paciente_hash}`,
    gcalLink ? `🔗 ${gcalLink}` : null,
  ].filter(Boolean).join('\n');

  const result = await sendWhatsApp(numero, msg);
  if (!result.ok) {
    console.warn('[citas/wapify] sendWhatsApp result:', JSON.stringify(result));
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const b = req.body ?? {};

  const fecha             = getStr(b.fecha, 10);
  const hora              = getStr(b.hora, 8);
  const paciente_email    = getStr(b.paciente_email);
  const paciente_telefono = getStr(b.paciente_telefono);
  // paciente_hash puede venir pre-computado (desde modal Agenda) o se computa aquí
  const paciente_hash_raw = getStr(b.paciente_hash, 64);
  const optometrista      = getStr(b.optometrista, 200);
  const tipo_consulta     = getStr(b.tipo_consulta, 50) as TipoCita | null;
  const notas             = getStr(b.notas, 2000);
  const duracion_min      = getInt(b.duracion_min, 30) ?? 30;
  const expediente_id     = b.expediente_id ? getInt(b.expediente_id) : null;
  const estado_inicial    = (getStr(b.estado, 50) as EstadoCita | null) ?? 'agendada';

  if (!fecha) return res.status(400).json({ ok: false, error: 'fecha requerida (YYYY-MM-DD)' });
  if (!hora)  return res.status(400).json({ ok: false, error: 'hora requerida (HH:MM)' });
  if (!paciente_hash_raw && !paciente_email && !paciente_telefono) {
    return res.status(400).json({ ok: false, error: 'Se requiere paciente_hash, paciente_email o paciente_telefono' });
  }
  if (tipo_consulta && !TIPOS_VALIDOS.includes(tipo_consulta)) {
    return res.status(400).json({ ok: false, error: 'tipo_consulta inválido', valid: TIPOS_VALIDOS });
  }
  if (!ESTADOS_VALIDOS.includes(estado_inicial)) {
    return res.status(400).json({ ok: false, error: 'estado inválido', valid: ESTADOS_VALIDOS });
  }

  const supabase = buildSupabaseClient();
  if (!supabase) return res.status(500).json({ ok: false, error: 'service unavailable' });

  const p_hash = paciente_hash_raw ?? pacienteHash(paciente_email, paciente_telefono);

  // GCal — graceful fallback si creds no están configuradas
  const gcal_event_id = await createGCalEvent({
    titulo: `GioLens · ${tipo_consulta ?? 'consulta'} · ${p_hash.slice(0, 8)}`,
    fecha,
    hora,
    duracion_min,
    notas,
  }).catch(e => {
    console.error('[api/citas POST] createGCalEvent unexpected:', e);
    return null;
  });

  const { data, error } = await supabase
    .from('citas')
    .insert({
      fecha,
      hora,
      duracion_min,
      paciente_hash: p_hash,
      optometrista,
      tipo_consulta,
      estado: estado_inicial,
      notas,
      gcal_event_id,
      expediente_id,
    })
    .select(SELECT_COLS)
    .single();

  if (error) {
    console.error('[api/citas POST]', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  // Wapify si la cita ya nace confirmada
  if (estado_inicial === 'confirmada') {
    sendWapifyConfirmacion({
      paciente_hash: p_hash,
      fecha,
      hora,
      tipo_consulta,
      gcal_event_id,
    }).catch(e => console.error('[api/citas POST] Wapify error:', e));
  }

  return res.status(201).json({ ok: true, id: (data as { id: number }).id, gcal_event_id, cita: data });
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const supabase = buildSupabaseClient();
  if (!supabase) return res.status(500).json({ ok: false, error: 'service unavailable' });

  const page     = Math.max(1, parseInt(String(req.query.page    ?? '1'),  10));
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.page_size ?? '50'), 10)));
  const offset   = (page - 1) * pageSize;

  const fecha_desde  = getStr(req.query.fecha_desde  as string);
  const fecha_hasta  = getStr(req.query.fecha_hasta  as string);
  const estado       = getStr(req.query.estado       as string) as EstadoCita | null;
  const optometrista = getStr(req.query.optometrista as string);

  let query = supabase
    .from('citas')
    .select(SELECT_COLS, { count: 'exact' })
    .order('fecha', { ascending: true })
    .order('hora',  { ascending: true })
    .range(offset, offset + pageSize - 1);

  if (fecha_desde)  query = query.gte('fecha', fecha_desde);
  if (fecha_hasta)  query = query.lte('fecha', fecha_hasta);
  if (estado && ESTADOS_VALIDOS.includes(estado)) query = query.eq('estado', estado);
  if (optometrista) query = query.ilike('optometrista', `%${optometrista}%`);

  const { data, error, count } = await query;

  if (error) {
    console.error('[api/citas GET]', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.status(200).json({
    ok: true,
    total:     count ?? 0,
    page,
    page_size: pageSize,
    citas:     data ?? [],
  });
}

async function handlePut(req: NextApiRequest, res: NextApiResponse) {
  const id = getInt(req.query.id ?? req.body?.id);
  if (!id) return res.status(400).json({ ok: false, error: 'id requerido como ?id=N o en body' });

  const supabase = buildSupabaseClient();
  if (!supabase) return res.status(500).json({ ok: false, error: 'service unavailable' });

  const b = req.body ?? {};
  const updates: Record<string, unknown> = {};

  const nuevo_estado = getStr(b.estado, 50) as EstadoCita | null;
  if (nuevo_estado) {
    if (!ESTADOS_VALIDOS.includes(nuevo_estado)) {
      return res.status(400).json({ ok: false, error: 'estado inválido', valid: ESTADOS_VALIDOS });
    }
    updates.estado = nuevo_estado;
  }
  if (b.notas         !== undefined) updates.notas         = getStr(b.notas, 2000);
  if (b.optometrista  !== undefined) updates.optometrista  = getStr(b.optometrista, 200);
  if (b.expediente_id !== undefined) updates.expediente_id = getInt(b.expediente_id);
  if (b.gcal_event_id !== undefined) updates.gcal_event_id = getStr(b.gcal_event_id, 200);

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ ok: false, error: 'sin campos a actualizar' });
  }

  // Leer registro actual para obtener gcal_event_id y datos para Wapify
  const { data: existing } = await supabase
    .from('citas')
    .select('gcal_event_id, estado, fecha, hora, tipo_consulta, paciente_hash')
    .eq('id', id)
    .single();

  const { data, error } = await supabase
    .from('citas')
    .update(updates)
    .eq('id', id)
    .select(SELECT_COLS)
    .single();

  if (error) {
    console.error('[api/citas PUT]', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  type ExistingRow = {
    gcal_event_id?: string | null;
    fecha?: string;
    hora?: string;
    tipo_consulta?: string | null;
    paciente_hash?: string;
  };
  const ex = existing as ExistingRow | null;
  const gcalId = ex?.gcal_event_id ?? null;

  // Reflejo en GCal — graceful fallback
  if (gcalId) {
    if (nuevo_estado === 'cancelada') {
      cancelGCalEvent(gcalId).catch(e => console.error('[api/citas PUT] cancelGCalEvent:', e));
    } else {
      updateGCalEvent(gcalId, {
        notas:  typeof updates.notas  === 'string' ? updates.notas  : undefined,
        estado: typeof updates.estado === 'string' ? updates.estado : undefined,
      }).catch(e => console.error('[api/citas PUT] updateGCalEvent:', e));
    }
  }

  // Wapify si estado → confirmada
  if (nuevo_estado === 'confirmada' && ex) {
    sendWapifyConfirmacion({
      paciente_hash: ex.paciente_hash ?? '',
      fecha:         ex.fecha         ?? '',
      hora:          ex.hora          ?? '',
      tipo_consulta: ex.tipo_consulta ?? null,
      gcal_event_id: gcalId,
    }).catch(e => console.error('[api/citas PUT] Wapify error:', e));
  }

  return res.status(200).json({ ok: true, cita: data });
}

// ---------------------------------------------------------------------------
// Router principal
// ---------------------------------------------------------------------------

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') return handlePost(req, res);
  if (req.method === 'GET')  return handleGet(req, res);
  if (req.method === 'PUT')  return handlePut(req, res);
  return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
}
