/// <reference types="node" />
/**
 * agents/_shared/citas/citas-core.ts — Frente G · Núcleo de negocio de citas.
 *
 * Lógica de mutación/lectura de citas EXTRAÍDA 1:1 de api/citas.ts para que la
 * compartan dos superficies HTTP sin duplicarla:
 *   - api/citas.ts          — Bearer-gated (cron / programático). Intacto.
 *   - api/citas-write-ui.ts — Origin-gated (browser del dashboard, sin Bearer).
 *
 * Estas funciones son framework-agnósticas: reciben datos planos y devuelven
 * { status, body } (código HTTP + cuerpo JSON). NO tocan req/res. El gating
 * (Bearer vs Origin), el CORS y el wiring de req/res viven en cada endpoint.
 *
 * Reglas PII / GCal / Wapify: idénticas a las documentadas en api/citas.ts —
 * este módulo ES esa lógica, movida aquí. Cualquier cambio de comportamiento
 * rompería los tests de api/citas.ts (red de seguridad).
 */

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { sendWhatsApp } from '../providers/wapify-notify.js';
import { getOpticaTimezone } from '../config/timezone.js';
import { getGCalToken } from '../providers/gcal.js';

// ---------------------------------------------------------------------------
// Resultado framework-agnóstico
// ---------------------------------------------------------------------------

export interface CoreResult {
  status: number;
  body: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers (movidos 1:1 de api/citas.ts)
// ---------------------------------------------------------------------------

export function buildSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

/** SHA256(email|telefono)[:16] — mismo patrón que expedientes */
export function pacienteHash(email: string | null | undefined, telefono: string | null | undefined): string {
  const seed = `${email ?? ''}|${telefono ?? ''}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

export function getStr(v: unknown, max = 500): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

export function getInt(v: unknown, fallback: number | null = null): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Regex de validación A-4 (R-7 + hash format)
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const HORA_RE  = /^\d{2}:\d{2}$/;
const HASH_RE  = /^[a-f0-9]{16}$/;

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
  'confirmacion_enviada_at',
  'created_at',
  'updated_at',
].join(', ');

const TIPOS_VALIDOS = ['revision_visual', 'contactologia', 'entrega_producto', 'seguimiento'] as const;
const ESTADOS_VALIDOS = ['agendada', 'confirmada', 'cancelada', 'realizada'] as const;

type TipoCita   = typeof TIPOS_VALIDOS[number];
type EstadoCita = typeof ESTADOS_VALIDOS[number];

// ---------------------------------------------------------------------------
// G-8 · Clasificación de errores 23505 (unique_violation) por constraint.
// ---------------------------------------------------------------------------
type PgUniqueError = { code?: string; message?: string; details?: string };

function classifySlotConflict(err: PgUniqueError): {
  isSlot: boolean;
  constraintName: string | null;
} {
  const msg = err?.message ?? '';
  const details = err?.details ?? '';
  const isSlot =
    msg.includes('idx_citas_slot_unique') ||
    msg.includes('uq_citas_slot') ||
    details.includes('idx_citas_slot_unique') ||
    details.includes('uq_citas_slot');
  const constraintName = msg.match(/"([^"]+)"/)?.[1] ?? null;
  return { isSlot, constraintName };
}

// ---------------------------------------------------------------------------
// GCal — cliente Service Account compartido (getGCalToken). createGCalEvent /
// updateGCalEvent quedan acá por ser específicos del dominio citas.
// ---------------------------------------------------------------------------

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
  const tz      = getOpticaTimezone();

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
          start: { dateTime: startDt, timeZone: tz },
          end:   { dateTime: endDt,   timeZone: tz },
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
    const tz      = getOpticaTimezone();
    body.start = { dateTime: startDt, timeZone: tz };
    body.end   = { dateTime: new Date(endMs).toISOString().slice(0, 19), timeZone: tz };
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
// Núcleo de negocio — createCita / updateCita / listCitas
// (framework-agnóstico: devuelven { status, body })
// ---------------------------------------------------------------------------

/** Crear cita (+ GCal + Wapify si nace confirmada). Lógica idéntica a POST /api/citas. */
export async function createCita(rawBody: unknown): Promise<CoreResult> {
  const b = (rawBody ?? {}) as Record<string, unknown>;

  const fecha             = getStr(b.fecha, 10);
  const hora              = getStr(b.hora, 8);
  const paciente_email    = getStr(b.paciente_email);
  const paciente_telefono = getStr(b.paciente_telefono);
  const paciente_hash_raw = getStr(b.paciente_hash, 64);
  const optometrista      = getStr(b.optometrista, 200);
  const tipo_consulta     = getStr(b.tipo_consulta, 50) as TipoCita | null;
  const notas             = getStr(b.notas, 2000);
  const duracion_min      = getInt(b.duracion_min, 30) ?? 30;
  const expediente_id     = b.expediente_id ? getInt(b.expediente_id) : null;
  const estado_inicial    = (getStr(b.estado, 50) as EstadoCita | null) ?? 'agendada';

  if (!fecha) return { status: 400, body: { ok: false, error: 'fecha requerida (YYYY-MM-DD)' } };
  if (!FECHA_RE.test(fecha)) return { status: 400, body: { ok: false, error: 'fecha debe ser YYYY-MM-DD' } };
  if (!hora)  return { status: 400, body: { ok: false, error: 'hora requerida (HH:MM)' } };
  if (!HORA_RE.test(hora))   return { status: 400, body: { ok: false, error: 'hora debe ser HH:MM' } };
  if (!paciente_hash_raw && !paciente_email && !paciente_telefono) {
    return { status: 400, body: { ok: false, error: 'Se requiere paciente_hash, paciente_email o paciente_telefono' } };
  }
  if (tipo_consulta && !TIPOS_VALIDOS.includes(tipo_consulta)) {
    return { status: 400, body: { ok: false, error: 'tipo_consulta inválido', valid: TIPOS_VALIDOS } };
  }
  if (!ESTADOS_VALIDOS.includes(estado_inicial)) {
    return { status: 400, body: { ok: false, error: 'estado inválido', valid: ESTADOS_VALIDOS } };
  }

  // G-9: optometrista requerido cuando el estado nuevo es distinto de 'cancelada'.
  if (estado_inicial !== 'cancelada' && !optometrista) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'optometrista_requerido_para_slot_unique',
        detail: "optometrista debe ser no-null para estados distintos de 'cancelada'",
      },
    };
  }

  const supabase = buildSupabaseClient();
  if (!supabase) return { status: 500, body: { ok: false, error: 'service unavailable' } };

  const p_hash = paciente_hash_raw ?? pacienteHash(paciente_email, paciente_telefono);

  // A-4: validación formato hash (R-5)
  if (!HASH_RE.test(p_hash)) {
    return { status: 400, body: { ok: false, error: 'paciente_hash debe ser 16 chars hex (0-9, a-f)' } };
  }

  // A-2/A-3: Transacción ordenada — INSERT primero (captura race 23505).
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
      gcal_event_id: null,
      expediente_id,
    })
    .select(SELECT_COLS)
    .single();

  if (error) {
    if (error.code === '23505') {
      const { isSlot, constraintName } = classifySlotConflict(error);
      if (isSlot) {
        console.warn('[citas-core create] Slot occupied (23505):', error.message);
        return { status: 409, body: { ok: false, error: 'slot_ocupado' } };
      }
      console.error('[citas-core create] Unexpected 23505 constraint:', {
        constraint: constraintName,
        table: 'citas',
        message: error.message,
      });
      return { status: 409, body: { ok: false, error: 'duplicate_entry', constraint: constraintName } };
    }
    console.error('[citas-core create] INSERT error:', error.message);
    return { status: 500, body: { ok: false, error: 'internal_error' } };
  }

  const cita_id = (data as unknown as { id: number }).id;

  // 2️⃣ Crear evento en GCal (graceful fallback si creds no están configuradas)
  let gcal_event_id: string | null = null;
  try {
    gcal_event_id = await createGCalEvent({
      titulo: `GioLens · ${tipo_consulta ?? 'consulta'} · ${p_hash.slice(0, 8)}`,
      fecha,
      hora,
      duracion_min,
      notas,
    });
  } catch (e) {
    console.error('[citas-core create] createGCalEvent error:', e);
  }

  // 3️⃣ UPDATE con gcal_event_id (si fue generado). Best-effort: errores se loguean.
  if (gcal_event_id) {
    try {
      await supabase.from('citas').update({ gcal_event_id }).eq('id', cita_id);
    } catch (e) {
      console.error('[citas-core create] UPDATE gcal_event_id error:', e);
    }
  }

  // Wapify si la cita ya nace confirmada · A-4 R-4 (tracking idempotente)
  if (estado_inicial === 'confirmada') {
    try {
      await sendWapifyConfirmacion({
        paciente_hash: p_hash,
        fecha,
        hora,
        tipo_consulta,
        gcal_event_id,
      });
      await supabase
        .from('citas')
        .update({ confirmacion_enviada_at: new Date().toISOString() })
        .eq('id', cita_id);
    } catch (e) {
      console.error('[citas-core create] Wapify error:', e);
    }
  }

  return { status: 201, body: { ok: true, id: cita_id, gcal_event_id, cita: data } };
}

/** Actualizar cita (estado + reflejos GCal/Wapify). Lógica idéntica a PUT /api/citas.
 *  `idRaw` = el id crudo (de query ?id=N o de body.id). */
export async function updateCita(idRaw: unknown, rawBody: unknown): Promise<CoreResult> {
  const id = getInt(idRaw);
  if (!id) return { status: 400, body: { ok: false, error: 'id requerido como ?id=N o en body' } };

  const supabase = buildSupabaseClient();
  if (!supabase) return { status: 500, body: { ok: false, error: 'service unavailable' } };

  const b = (rawBody ?? {}) as Record<string, unknown>;
  const updates: Record<string, unknown> = {};

  const nuevo_estado = getStr(b.estado, 50) as EstadoCita | null;
  if (nuevo_estado) {
    if (!ESTADOS_VALIDOS.includes(nuevo_estado)) {
      return { status: 400, body: { ok: false, error: 'estado inválido', valid: ESTADOS_VALIDOS } };
    }
    updates.estado = nuevo_estado;
  }
  if (b.notas         !== undefined) updates.notas         = getStr(b.notas, 2000);
  if (b.optometrista  !== undefined) updates.optometrista  = getStr(b.optometrista, 200);
  if (b.expediente_id !== undefined) updates.expediente_id = getInt(b.expediente_id);
  if (b.gcal_event_id !== undefined) updates.gcal_event_id = getStr(b.gcal_event_id, 200);

  if (Object.keys(updates).length === 0) {
    return { status: 400, body: { ok: false, error: 'sin campos a actualizar' } };
  }

  // Leer registro actual (gcal_event_id + datos para Wapify + idempotency guard + optometrista G-9)
  const { data: existing } = await supabase
    .from('citas')
    .select('gcal_event_id, estado, fecha, hora, tipo_consulta, paciente_hash, confirmacion_enviada_at, optometrista')
    .eq('id', id)
    .single();

  // G-9: si el PUT mueve la cita a un estado distinto de 'cancelada', el slot
  // debe tener optometrista no-null (para que idx_citas_slot_unique funcione).
  if (nuevo_estado && nuevo_estado !== 'cancelada') {
    const existingOpt = (existing as { optometrista?: string | null } | null)?.optometrista ?? null;
    const effectiveOpt =
      updates.optometrista !== undefined
        ? (updates.optometrista as string | null)
        : existingOpt;
    if (!effectiveOpt) {
      return {
        status: 400,
        body: {
          ok: false,
          error: 'optometrista_requerido_para_slot_unique',
          detail: "optometrista debe ser no-null para estados distintos de 'cancelada'",
        },
      };
    }
  }

  const { data, error } = await supabase
    .from('citas')
    .update(updates)
    .eq('id', id)
    .select(SELECT_COLS)
    .single();

  // G-7/G-8: race PUT reactivar mismo slot → 23505 → 409 slot_ocupado (solo si es el slot único).
  if (error) {
    if (error.code === '23505') {
      const { isSlot, constraintName } = classifySlotConflict(error);
      if (isSlot) {
        console.warn('[citas-core update] Slot occupied (23505) on update:', error.message);
        return { status: 409, body: { ok: false, error: 'slot_ocupado' } };
      }
      console.error('[citas-core update] Unexpected 23505 constraint:', {
        constraint: constraintName,
        table: 'citas',
        message: error.message,
      });
      return { status: 409, body: { ok: false, error: 'duplicate_entry', constraint: constraintName } };
    }
    console.error('[citas-core update]', error.message);
    return { status: 500, body: { ok: false, error: 'internal_error' } };
  }

  type ExistingRow = {
    gcal_event_id?: string | null;
    estado?: EstadoCita;
    fecha?: string;
    hora?: string;
    tipo_consulta?: string | null;
    paciente_hash?: string;
    confirmacion_enviada_at?: string | null;
  };
  const ex = existing as ExistingRow | null;
  const gcalId = ex?.gcal_event_id ?? null;

  // Reflejo en GCal — graceful fallback
  if (gcalId) {
    if (nuevo_estado === 'cancelada') {
      cancelGCalEvent(gcalId).catch(e => console.error('[citas-core update] cancelGCalEvent:', e));
    } else {
      updateGCalEvent(gcalId, {
        notas:  typeof updates.notas  === 'string' ? updates.notas  : undefined,
        estado: typeof updates.estado === 'string' ? updates.estado : undefined,
      }).catch(e => console.error('[citas-core update] updateGCalEvent:', e));
    }
  }

  // Wapify si estado → confirmada · A-4 R-4 idempotente (cambio real + no enviado antes)
  if (
    nuevo_estado === 'confirmada' &&
    ex &&
    ex.estado !== 'confirmada' &&
    !ex.confirmacion_enviada_at
  ) {
    try {
      await sendWapifyConfirmacion({
        paciente_hash: ex.paciente_hash ?? '',
        fecha:         ex.fecha         ?? '',
        hora:          ex.hora          ?? '',
        tipo_consulta: ex.tipo_consulta ?? null,
        gcal_event_id: gcalId,
      });
      await supabase
        .from('citas')
        .update({ confirmacion_enviada_at: new Date().toISOString() })
        .eq('id', id);
    } catch (e) {
      console.error('[citas-core update] Wapify error:', e);
    }
  }

  return { status: 200, body: { ok: true, cita: data } };
}

/** Listar citas paginado SIN PII. Lógica idéntica a GET /api/citas. */
export async function listCitas(query: Record<string, string | string[] | undefined>): Promise<CoreResult> {
  const supabase = buildSupabaseClient();
  if (!supabase) return { status: 500, body: { ok: false, error: 'service unavailable' } };

  const page     = Math.max(1, parseInt(String(query.page      ?? '1'),  10));
  const pageSize = Math.min(100, Math.max(1, parseInt(String(query.page_size ?? '50'), 10)));
  const offset   = (page - 1) * pageSize;

  const fecha_desde  = getStr(query.fecha_desde  as string);
  const fecha_hasta  = getStr(query.fecha_hasta  as string);
  const estado       = getStr(query.estado       as string) as EstadoCita | null;
  const optometrista = getStr(query.optometrista as string);

  let q = supabase
    .from('citas')
    .select(SELECT_COLS, { count: 'exact' })
    .order('fecha', { ascending: true })
    .order('hora',  { ascending: true })
    .range(offset, offset + pageSize - 1);

  if (fecha_desde)  q = q.gte('fecha', fecha_desde);
  if (fecha_hasta)  q = q.lte('fecha', fecha_hasta);
  if (estado && ESTADOS_VALIDOS.includes(estado)) q = q.eq('estado', estado);
  if (optometrista) {
    // A-4 R-11: escape % y _ y \ para evitar wildcard injection
    const escaped = optometrista.replace(/[%_\\]/g, '\\$&');
    q = q.ilike('optometrista', `%${escaped}%`);
  }

  const { data, error, count } = await q;

  if (error) {
    console.error('[citas-core list]', error.message);
    return { status: 500, body: { ok: false, error: 'internal_error' } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      total:     count ?? 0,
      page,
      page_size: pageSize,
      citas:     data ?? [],
    },
  };
}
