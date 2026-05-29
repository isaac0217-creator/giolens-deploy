/**
 * api/cron/pull-gcal.ts — Frente G · Sesión 10 · Doble-escritura calendario, Opción (a).
 *
 * Decisión: DECISION_DOBLE_ESCRITURA_CALENDAR.md (Isaac, 2026-05-28, ADOPTADA).
 *
 * Problema: las reservas Path A (paciente auto-reserva vía Whapify → Gestor de
 * Reservas → Google Calendar) existen en el calendario "Citas GIOCORE" pero NO en
 * la tabla `citas`. El slot-check de Path B (Cynthia agenda vía /api/citas) no las
 * ve → riesgo de doble-booking invisible para el dashboard.
 *
 * Solución: este cron lee GCal periódicamente y, por cada evento que no tenga fila
 * en `citas`, inserta una con origen='whapify'. Así `citas` refleja TODOS los slots
 * ocupados. Consistencia eventual (~30 min entre corridas).
 *
 * Vercel cron: { path: "/api/cron/pull-gcal", schedule: "15,45 * * * *" }
 *   (offset 15/45 distinto de los refresh-* de analítica en min 0/30).
 * Auth: Authorization: Bearer ${CRON_SECRET}
 *   - sin header → 401 · header inválido → 403 · ok → 200.
 * Acepta GET (invoke manual) y POST (scheduler).
 *
 * Robustez (§3.4): GCal caído / sin credencial → 200 con _warnings, NUNCA 500
 * (no romper el scheduler de Vercel). Idempotente: re-correr = mismo estado
 * (lookup por gcal_event_id). Choque real de slot (23505) → se cuenta en
 * `conflicts`, no rompe el cron (decisión humana, §5).
 *
 * PII (§3.3): NO persiste ni loggea nombre/teléfono/email. paciente_hash =
 * sha256(gcal_event_id)[:16] como placeholder (el evento Path A no trae un
 * identificador hasheable de paciente). El _report no incluye PII.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { timingSafeBearer } from '../../agents/_shared/auth/bearer.js';
import { listGCalEvents, type GCalEvent } from '../../agents/_shared/providers/gcal.js';
import { getOpticaTimezone } from '../../agents/_shared/config/timezone.js';

interface VercelLikeReq {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface VercelLikeRes {
  status(code: number): VercelLikeRes;
  json(body: unknown): VercelLikeRes;
  end(): void;
  setHeader?(name: string, value: string): VercelLikeRes;
}

// Ventana de sincronización: ayer → +30 días (§3.2).
const WINDOW_BACK_DAYS = 1;
const WINDOW_FWD_DAYS = 30;
const DEFAULT_DURACION_MIN = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function setBaseHeaders(res: VercelLikeRes): void {
  if (typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

type AuthResult = 'ok' | 'missing' | 'invalid';

/** Distingue header ausente (401) de presente-pero-inválido (403). */
function authResult(req: VercelLikeReq): AuthResult {
  const auth = req.headers.authorization;
  const authStr =
    typeof auth === 'string'
      ? auth
      : Array.isArray(auth)
        ? auth[0] ?? ''
        : '';
  if (!authStr) return 'missing';
  const secret = process.env.CRON_SECRET;
  if (!secret) return 'invalid';
  return timingSafeBearer(authStr, secret) ? 'ok' : 'invalid';
}

function buildSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Placeholder anonimizado: sha256(gcal_event_id)[:16] (16 hex, formato HASH_RE). */
function placeholderHash(gcalEventId: string): string {
  return createHash('sha256').update(gcalEventId).digest('hex').slice(0, 16);
}

/** Mapea un instante RFC3339 a fecha/hora locales en la timezone de la óptica.
 *  NO asume UTC (§3.2): respeta el offset del dateTime y la tz destino. */
function mapToLocal(iso: string, tz: string): { fecha: string; hora: string } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const fecha = `${get('year')}-${get('month')}-${get('day')}`;
  let hora = `${get('hour')}:${get('minute')}`;
  if (hora.startsWith('24')) hora = `00${hora.slice(2)}`; // algunos engines dan 24:00 a medianoche
  return { fecha, hora };
}

/** Duración en minutos derivada de start/end; default 30 si no es derivable. */
function deriveDuracion(ev: GCalEvent): number {
  const s = ev.start?.dateTime;
  const e = ev.end?.dateTime;
  if (!s || !e) return DEFAULT_DURACION_MIN;
  const ms = new Date(e).getTime() - new Date(s).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_DURACION_MIN;
  return Math.round(ms / 60000);
}

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  setBaseHeaders(res);

  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = authResult(req);
  if (auth === 'missing') {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  if (auth === 'invalid') {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return;
  }

  const supa = buildSupabaseClient();
  if (!supa) {
    res.status(500).json({ ok: false, error: 'supabase_unavailable' });
    return;
  }

  const report = { pulled: 0, inserted: 0, skipped: 0, conflicts: 0, errors: 0 };
  const warnings: string[] = [];

  const now = Date.now();
  const timeMin = new Date(now - WINDOW_BACK_DAYS * MS_PER_DAY).toISOString();
  const timeMax = new Date(now + WINDOW_FWD_DAYS * MS_PER_DAY).toISOString();

  const events = await listGCalEvents({ timeMin, timeMax });
  if (events === null) {
    // GCal sin credencial o caído → 200 con warning, nunca 500 (§3.4).
    res.status(200).json({
      ok: true,
      ...report,
      generated_at: new Date().toISOString(),
      _warnings: ['gcal_unavailable'],
    });
    return;
  }

  report.pulled = events.length;
  const tz = getOpticaTimezone();

  // Sólo eventos con hora concreta (citas.hora es TIME NOT NULL): all-day y
  // cancelados no mapean a un slot. id ya garantizado string por listGCalEvents.
  const timed = events.filter(
    (e) => e.status !== 'cancelled' && typeof e.start?.dateTime === 'string',
  );
  report.skipped += events.length - timed.length;

  // Idempotencia (§3.4): lookup batch de gcal_event_id ya presentes en `citas`.
  const ids = timed.map((e) => e.id);
  const existing = new Set<string>();
  if (ids.length > 0) {
    const { data, error } = await supa
      .from('citas')
      .select('gcal_event_id')
      .in('gcal_event_id', ids);
    if (error) {
      console.error('[cron/pull-gcal] lookup error:', error.message);
      warnings.push('lookup_failed');
    } else {
      for (const row of (data ?? []) as Array<{ gcal_event_id: string | null }>) {
        if (row.gcal_event_id) existing.add(row.gcal_event_id);
      }
    }
  }

  for (const ev of timed) {
    if (existing.has(ev.id)) {
      report.skipped++;
      continue;
    }
    const slot = mapToLocal(ev.start!.dateTime as string, tz);
    if (!slot) {
      report.skipped++;
      continue;
    }
    const { error } = await supa.from('citas').insert({
      fecha: slot.fecha,
      hora: slot.hora,
      duracion_min: deriveDuracion(ev),
      paciente_hash: placeholderHash(ev.id),
      gcal_event_id: ev.id,
      origen: 'whapify',
      estado: 'confirmada',
    });
    if (!error) {
      report.inserted++;
    } else if (error.code === '23505') {
      // Choque real de slot con una cita Path B existente (§5): se cuenta para
      // auditoría, NO se auto-resuelve ni rompe el cron.
      report.conflicts++;
    } else {
      console.error('[cron/pull-gcal] insert error:', error.code, error.message);
      report.errors++;
    }
  }

  if (report.errors > 0) warnings.push('partial_insert_errors');

  res.status(200).json({
    ok: true,
    ...report,
    generated_at: new Date().toISOString(),
    _warnings: warnings,
  });
}
