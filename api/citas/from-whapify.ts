/**
 * api/citas/from-whapify.ts — W2 · Rama B · ingest de citas confirmadas por el bot.
 *
 * Verificación #1 (2026-05-30): el agendamiento lo maneja el bot GPT "ALPHA" de
 * Whapify (config en la UI de Whapify, NO en este repo), NO el Claude Engine
 * (api/webhook.js). Un nodo HTTP de Whapify (lo construye Cowork) hace POST a este
 * endpoint con el mensaje del bot (que incluye el tag) + el contact_id. Este
 * endpoint es la AUTORIDAD de la fecha: revalida el tag contra su propio reloj en
 * la zona de la óptica (resolverYRevalidarCita) y, si es agendable, crea el evento
 * en "Citas GIOCORE" y persiste la fila en `citas` (origen='whapify').
 *
 * Contrato del body (lo emite el nodo HTTP de Whapify):
 *   { "message": "<texto del bot, incluye ##ESTADO:...##>", "contact_id": "<id>" }
 *   Alias tolerados: message|mensaje · contact_id|contactId.
 *
 * Auth: secret WAPIFY_WEBHOOK_SECRET (mismo que el engine), por UNA de:
 *   - ?secret=XXX  · header x-wapify-secret: XXX  · Authorization: Bearer XXX
 *   FAIL-CLOSED: a diferencia del engine (que hace bypass sin env), este endpoint
 *   ESCRIBE en DB + GCal, así que sin secret configurado → 401 (no writes anónimos).
 *
 * Robustez: NUNCA 500 ante fallo de infra (GCal/DB) — responde 200 + _warnings,
 * para no romper el flujo del bot. 401 (auth), 405 (método), 400 (body malformado)
 * son los únicos no-200.
 *
 * Idempotencia (doble POST = 1 evento):
 *   1. pre-SELECT por (paciente_hash, fecha, hora) activa → si existe, devuelve la
 *      existente sin crear nada.
 *   2. backstop a nivel DB: el índice único parcial de migration 028 (atrapa 23505
 *      en carreras concurrentes → re-SELECT del ganador).
 *   3. la fila lleva gcal_event_id, así el cron pull-gcal la reconoce y la omite
 *      (dedup por gcal_event_id), evitando doble-escritura GCal→citas.
 *
 * PII: NUNCA loggea ni devuelve el body crudo, el message, el REF ni el contact_id.
 *   paciente_hash = sha256(contact_id)[:16] (16 hex). El tag no trae PII.
 */

import { createClient } from '@supabase/supabase-js';
import { createHash, timingSafeEqual } from 'crypto';
import { resolverYRevalidarCita } from '../../agents/_shared/citas/revalidar-cita.js';
import { createGCalEvent } from '../../agents/_shared/providers/gcal.js';

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

const DURACION_MIN = 30;

function setBaseHeaders(res: VercelLikeRes): void {
  if (typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function firstStr(v: string | string[] | undefined): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0] ?? '';
  return '';
}

/** Comparación constant-time (evita fuga de timing del secret byte-a-byte). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Fail-closed: sin WAPIFY_WEBHOOK_SECRET configurado → false (no writes anónimos). */
function secretOk(req: VercelLikeReq): boolean {
  const expected = process.env.WAPIFY_WEBHOOK_SECRET;
  if (!expected) return false;
  const candidates = [
    firstStr(req.query?.secret),
    firstStr(req.headers['x-wapify-secret']),
    firstStr(req.headers.authorization).replace(/^Bearer\s+/i, ''),
  ];
  // Sin short-circuit: evaluamos los 3 canales siempre, así el nº de comparaciones
  // no depende de cuál acertó (no filtra por timing qué canal portaba el secret).
  let ok = false;
  for (const c of candidates) {
    if (safeEqual(c, expected)) ok = true;
  }
  return ok;
}

interface ParsedBody { message: string; contactId: string; }

function parseBody(raw: unknown): ParsedBody | null {
  let b: Record<string, unknown>;
  try {
    b = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!b || typeof b !== 'object') return null;
  const message = typeof b.message === 'string' ? b.message
    : typeof b.mensaje === 'string' ? b.mensaje : '';
  // contact_id numérico (Whapify a veces lo manda como número) → string estable,
  // para que el paciente_hash sea idéntico envíe lo que envíe el nodo HTTP.
  const contactId = typeof b.contact_id === 'string' ? b.contact_id
    : typeof b.contactId === 'string' ? b.contactId
    : b.contact_id != null ? String(b.contact_id)
    : b.contactId != null ? String(b.contactId) : '';
  if (!message) return null;
  return { message, contactId };
}

const KNOWN_KEYS = new Set(['ESTADO', 'FECHA', 'HORA', 'REF', 'INT']);

/** Aísla el cuerpo del tag `##...##` que contiene ESTADO (ignora otros `##` del
 *  mensaje). Tolerante a posición: ESTADO no tiene que ser el primer campo. */
function extractTagBody(message: string): string | null {
  const re = /##([\s\S]*?)##/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    if (/(^|\|)\s*ESTADO\s*:/i.test(m[1])) return m[1];
  }
  return null;
}

/**
 * Parser TOLERANTE del tag, por clave (no por posición):
 *   - Cada segmento `K:V` separado por `|`. Claves conocidas → se guardan;
 *     desconocidas (ej. `RUTA:` residual de sub-prompts viejos) → se IGNORAN
 *     pero actúan de límite (no contaminan el campo previo).
 *   - REF es greedy: un segmento sin `K:` se trata como continuación del campo
 *     actual (tolera un `|` literal dentro de REF hasta el próximo `K:` conocido).
 *   - Orden de campos arbitrario. REF/INT ausentes → simplemente no están (sin crash).
 * Devuelve null sólo si no hay bloque de tag con ESTADO.
 */
function parseTagFields(message: string): Record<string, string> | null {
  const body = extractTagBody(message);
  if (body === null) return null;
  const fields: Record<string, string> = {};
  let current: string | null = null;
  for (const seg of body.split('|')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]*)$/.exec(seg);
    if (m) {
      const key = m[1].toUpperCase();
      if (KNOWN_KEYS.has(key)) {
        fields[key] = m[2];
        current = key;
      } else {
        current = null; // clave desconocida: límite, se descarta
      }
    } else if (current) {
      fields[current] += `|${seg}`; // continuación (REF con `|` literal)
    }
  }
  for (const k of Object.keys(fields)) fields[k] = fields[k].trim();
  return fields;
}

function pacienteHashFromContact(contactId: string): string {
  return createHash('sha256').update(contactId).digest('hex').slice(0, 16);
}

function buildSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

type Supa = NonNullable<ReturnType<typeof buildSupabase>>;

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  setBaseHeaders(res);

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  if (!secretOk(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const parsed = parseBody(req.body);
  if (!parsed) {
    res.status(400).json({ ok: false, error: 'invalid_body', detail: 'se requiere { message, contact_id }' });
    return;
  }

  // ── Detección + parseo tolerante del tag · no-op silencioso si no es confirmación ──
  const fields = parseTagFields(parsed.message);
  if (!fields) {
    res.status(200).json({ ok: true, action: 'ignored', reason: 'no_tag' });
    return;
  }
  if (fields.ESTADO !== 'CITA_AGENDADA') {
    res.status(200).json({ ok: true, action: 'ignored', reason: 'estado_no_agendada' });
    return;
  }

  // contact_id es obligatorio para derivar paciente_hash estable e idempotencia.
  if (!parsed.contactId) {
    res.status(400).json({ ok: false, error: 'contact_id_requerido' });
    return;
  }

  const fechaTag = fields.FECHA ?? null;
  const horaTag = fields.HORA ?? null;
  const refCrudo = fields.REF ?? null;

  // ── Revalidación: el backend es la autoridad de la fecha ──
  const r = resolverYRevalidarCita(fechaTag, horaTag, refCrudo, new Date());
  if (!r.ok) {
    // No agenda: revisión humana. Sin PII en la respuesta (solo motivos).
    console.warn(`[citas/from-whapify] revision motivos=${r.motivos.join(',')}`);
    res.status(200).json({
      ok: true,
      action: 'revision',
      estado: 'CITA_SOLICITADA',
      _warnings: ['cita_revision_humana', ...r.motivos],
    });
    return;
  }

  const pHash = pacienteHashFromContact(parsed.contactId);
  const fecha = r.fecha as string;
  const hora = r.hora as string;
  const warnings: string[] = [];

  const supabase = buildSupabase();
  if (!supabase) {
    // Infra faltante: nunca 500 (no romper el bot). El slot no se persiste; queda
    // el warning para alertar. No creamos GCal sin poder dedupe en DB.
    console.error('[citas/from-whapify] supabase no disponible');
    res.status(200).json({ ok: true, action: 'persist_skipped', _warnings: ['db_unavailable'] });
    return;
  }

  // 1️⃣ Idempotencia: ¿ya existe una cita activa de este paciente en este slot?
  const found = await selectActiva(supabase, pHash, fecha, hora);
  if (found) {
    res.status(200).json({
      ok: true,
      action: 'idempotent',
      id: found.id,
      gcal_event_id: found.gcal_event_id,
      fecha,
      hora,
    });
    return;
  }

  // 2️⃣ INSERT primero (gcal null) — captura la carrera vía índice único (mig 028).
  const { data: inserted, error: insErr } = await supabase
    .from('citas')
    .insert({
      fecha,
      hora,
      duracion_min: DURACION_MIN,
      paciente_hash: pHash,
      optometrista: null,
      tipo_consulta: null,
      estado: 'confirmada',
      notas: null,
      gcal_event_id: null,
      origen: 'whapify',
    })
    .select('id, gcal_event_id')
    .single();

  if (insErr) {
    if (insErr.code === '23505') {
      // Carrera concurrente: otro POST ganó. Re-SELECT del ganador → idempotente.
      const winner = await selectActiva(supabase, pHash, fecha, hora);
      if (winner) {
        res.status(200).json({
          ok: true,
          action: 'idempotent',
          id: winner.id,
          gcal_event_id: winner.gcal_event_id,
          fecha,
          hora,
        });
        return;
      }
      res.status(200).json({ ok: true, action: 'conflict', _warnings: ['slot_conflict'] });
      return;
    }
    console.error('[citas/from-whapify] insert error:', insErr.code, insErr.message);
    res.status(200).json({ ok: true, action: 'persist_failed', _warnings: ['db_insert_failed'] });
    return;
  }

  const citaId = (inserted as { id: number }).id;

  // 3️⃣ Crear evento GCal (graceful: null si creds faltan o API falla).
  let gcalEventId: string | null = null;
  try {
    gcalEventId = await createGCalEvent({
      titulo: `GioLens · cita · ${pHash.slice(0, 8)}`,
      fecha,
      hora,
      duracion_min: DURACION_MIN,
      notas: null,
    });
  } catch (e) {
    console.error('[citas/from-whapify] createGCalEvent error:', e instanceof Error ? e.message : String(e));
  }

  // 4️⃣ UPDATE con gcal_event_id (lo que permite al cron pull-gcal reconocer y omitir).
  if (gcalEventId) {
    const { error: updErr } = await supabase
      .from('citas')
      .update({ gcal_event_id: gcalEventId })
      .eq('id', citaId);
    if (updErr) console.error('[citas/from-whapify] update gcal_event_id error:', updErr.message);
  } else {
    warnings.push('gcal_unavailable');
  }

  console.log(`[citas/from-whapify] created id=${citaId} hash=${pHash} fecha=${fecha} hora=${hora} gcal=${gcalEventId ? 'ok' : 'none'}`);
  res.status(200).json({
    ok: true,
    action: 'created',
    estado: 'CITA_AGENDADA',
    id: citaId,
    gcal_event_id: gcalEventId,
    fecha,
    hora,
    _warnings: warnings,
  });
}

async function selectActiva(
  supabase: Supa,
  pHash: string,
  fecha: string,
  hora: string,
): Promise<{ id: number; gcal_event_id: string | null } | null> {
  const { data } = await supabase
    .from('citas')
    .select('id, gcal_event_id')
    .eq('paciente_hash', pHash)
    .eq('origen', 'whapify')
    .eq('fecha', fecha)
    .eq('hora', hora)
    .neq('estado', 'cancelada')
    .limit(1)
    .maybeSingle();
  return (data as { id: number; gcal_event_id: string | null } | null) ?? null;
}
