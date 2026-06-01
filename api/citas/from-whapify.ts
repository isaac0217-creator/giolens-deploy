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
 * PII: NUNCA loggea ni devuelve el body crudo, el message, el REF, el contact_id,
 *   el nombre ni el teléfono. paciente_hash = sha256(contact_id)[:16] (16 hex).
 *   OJO: desde la Vía B (abajo) el tag SÍ puede traer PII (NOMBRE:/TEL:) — por eso el
 *   message nunca se loguea ni se devuelve.
 *
 * Enriquecimiento de la tarjeta de agenda (robusto a DOS fuentes, aditivo):
 *   - nombre/teléfono — Vía A (CRM): lookup BEST-EFFORT del CRM Whapify por contact_id
 *     (fetchContactPII). Fiable para WhatsApp. Falla → null (nunca rompe la cita).
 *   - nombre/teléfono — Vía B (tag): campos opcionales `NOMBRE:`/`TEL:` del tag. Único
 *     canal con teléfono para Messenger (cuyo perfil CRM no trae phone). PII.
 *     Prioridad por campo: CRM válido > tag > null. Se guardan en `citas` (acceso
 *     restringido) PERO NUNCA se devuelven ni loguean.
 *   - producto_motivo: campo opcional `PROD:` del tag (NO PII). Ausente → NULL.
 *   - resumen_expediente: campo opcional `RESUMEN:` del tag (migration 031). Resumen
 *     breve de la conversación para llenar el expediente (qué busca el paciente,
 *     padecimiento/síntomas, recomendación). INFORMACIÓN CLÍNICA SENSIBLE: se persiste en
 *     columna de acceso restringido y NUNCA se loguea ni se devuelve (igual que NOMBRE/TEL,
 *     y NUNCA por /api/citas Bearer). Ausente → NULL (nunca se inventa).
 *   - contact_id (raw): se persiste (migration 030) para re-enriquecer luego las citas
 *     cuyo lookup CRM falló. Acceso restringido: nunca se devuelve ni loguea.
 */

import { createClient } from '@supabase/supabase-js';
import { createHash, timingSafeEqual } from 'crypto';
import { resolverYRevalidarCita } from '../../agents/_shared/citas/revalidar-cita.js';
import { createGCalEvent } from '../../agents/_shared/providers/gcal.js';
import { fetchContactPII } from '../../agents/_shared/providers/wapify-contact.js';

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

// NOMBRE/TEL: canal CONFIABLE de PII para Messenger, donde el CRM Whapify no trae
// teléfono (perfil de Messenger sin phone) — el bot los embebe en el tag. Opcionales
// y tolerantes: ausentes → NULL. Son PII: se persisten en columna de acceso
// restringido y NUNCA se loguean ni se devuelven (igual que nombre/teléfono del CRM).
// RESUMEN: resumen clínico breve de la conversación para el expediente (migration 031).
// Opcional y tolerante: ausente → NULL. Es información clínica sensible: se persiste en
// columna de acceso restringido y NUNCA se loguea ni se devuelve (igual que NOMBRE/TEL).
const KNOWN_KEYS = new Set(['ESTADO', 'FECHA', 'HORA', 'REF', 'INT', 'PROD', 'NOMBRE', 'TEL', 'RESUMEN']);

/** Tope de longitud para producto_motivo (defensa contra tags abusivos). */
const PRODUCTO_MOTIVO_MAX = 200;
/** Topes para los campos PII del tag (defensa contra tags abusivos). */
const NOMBRE_MAX = 120;
const TELEFONO_MAX = 32;
/** Tope de longitud para resumen_expediente (frase breve; defensa contra tags abusivos). */
const RESUMEN_MAX = 300;

/**
 * Sanea el valor `PROD:` del tag → texto plano breve o null.
 *   - quita caracteres de control,
 *   - colapsa espacios,
 *   - recorta a PRODUCTO_MOTIVO_MAX,
 *   - vacío tras limpiar → null (campo opcional: nunca se inventa).
 * NO es PII, pero se trata con cuidado por si el bot colara texto raro.
 */
function sanitizeProductoMotivo(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // Quita controles C0/C1 + DEL (incluye \n, \r, \t) y colapsa espacios.
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, PRODUCTO_MOTIVO_MAX).trim();
}

/**
 * Sanea el valor `NOMBRE:` del tag (PII) → texto plano breve o null.
 * Mismo saneo que producto_motivo (quita controles, colapsa espacios, recorta),
 * pero con tope propio. Tolera acentos/ñ (no se filtra el set de caracteres del
 * nombre). Vacío tras limpiar → null (campo opcional: nunca se inventa).
 */
function sanitizeNombre(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, NOMBRE_MAX).trim();
}

/**
 * Sanea el valor `TEL:` del tag (PII) → teléfono normalizado o null.
 *   - conserva sólo dígitos, `+`, espacio, guion, paréntesis y punto,
 *   - colapsa espacios y recorta a TELEFONO_MAX,
 *   - si tras limpiar no queda ningún dígito → null (no es un teléfono).
 * Tolerante: NO valida formato/longitud de país (el bot manda lo que capturó);
 * sólo descarta basura no telefónica y campos vacíos. Nunca se inventa.
 */
function sanitizeTelefono(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[^\d+()\-.\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || !/\d/.test(cleaned)) return null;
  return cleaned.slice(0, TELEFONO_MAX).trim();
}

/**
 * Sanea el valor `RESUMEN:` del tag (información clínica sensible) → frase breve o null.
 *   - quita caracteres de control (incl. \n, \r, \t),
 *   - quita `|` y `#` (separador de campos y delimitador del tag — el sub-prompt no debe
 *     emitirlos, pero si se colaran romperían el parseo/delimitador: se eliminan),
 *   - colapsa espacios,
 *   - recorta a RESUMEN_MAX,
 *   - vacío tras limpiar → null (campo opcional: nunca se inventa).
 * Tolera acentos/ñ y puntuación normal. Vacío/ausente → null.
 */
function sanitizeResumen(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[|#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, RESUMEN_MAX).trim();
}

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
 *   - Continuación greedy: un segmento sin `K:` se trata como continuación del campo
 *     actual (tolera un `|` literal dentro de cualquier campo —REF, PROD, RESUMEN…—
 *     hasta el próximo `K:` conocido). Para RESUMEN, además, sanitizeResumen quita los
 *     `|`/`#` residuales que hayan sobrevivido a la continuación.
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
  // Producto/motivo (NO PII): campo opcional del tag. Ausente/vacío → null.
  const productoMotivo = sanitizeProductoMotivo(fields.PROD ?? null);
  // Resumen del expediente (información CLÍNICA sensible): campo opcional del tag.
  // Ausente/vacío → null (nunca se inventa). Se persiste en columna de acceso
  // restringido y NUNCA se loguea ni se devuelve (igual que NOMBRE/TEL).
  const resumenExpediente = sanitizeResumen(fields.RESUMEN ?? null);
  // PII del tag (Vía B): canal CONFIABLE para Messenger (el CRM no trae teléfono).
  // Opcionales: ausentes → null. Se combinan abajo con el lookup CRM (Vía A).
  const nombreTag = sanitizeNombre(fields.NOMBRE ?? null);
  const telefonoTag = sanitizeTelefono(fields.TEL ?? null);

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

  // 1️⃣bis Enriquecimiento PII robusto a DOS fuentes (Vía A + Vía B). NUNCA bloquea
  // ni rompe la cita. Se hace sólo en creación (los hits idempotentes ya devolvieron).
  //   Vía A — lookup CRM Whapify por contact_id (best-effort, falla → null + warning).
  //           Fiable para WhatsApp (perfil con full_name + phone).
  //   Vía B — campos NOMBRE:/TEL: del tag. Único canal con teléfono para Messenger.
  // Prioridad POR CAMPO: CRM válido > tag > null (el CRM es el dato "de sistema"; el
  // tag rellena lo que el CRM no resuelve, p. ej. el teléfono de un contacto Messenger).
  let nombreCrm: string | null = null;
  let telefonoCrm: string | null = null;
  const pii = await fetchContactPII(parsed.contactId);
  if (pii) {
    nombreCrm = pii.nombre;
    telefonoCrm = pii.telefono;
  } else {
    warnings.push('crm_lookup_skipped');
  }
  const nombrePaciente = nombreCrm ?? nombreTag;
  const telefonoPaciente = telefonoCrm ?? telefonoTag;
  // Señal (sin PII) de que el tag cubrió un hueco que el CRM no resolvió.
  if (!nombreCrm && nombreTag) warnings.push('nombre_from_tag');
  if (!telefonoCrm && telefonoTag) warnings.push('telefono_from_tag');

  // 2️⃣ INSERT primero (gcal null) — captura la carrera vía índice único (mig 028).
  // Columnas PII (nombre/telefono) y producto_motivo añadidas por migration 029.
  // resumen_expediente (clínico) añadido por migration 031 — acceso restringido como NOMBRE/TEL.
  // contact_id (raw) añadido por migration 030 — habilita re-enriquecer (Vía A) las
  // citas cuyo lookup CRM falló al agendar, sin re-hashear. PII de acceso restringido:
  // NUNCA se devuelve (ni por /api/citas Bearer ni por el BFF /api/citas-ui) ni se loguea.
  const { data: inserted, error: insErr } = await supabase
    .from('citas')
    .insert({
      fecha,
      hora,
      duracion_min: DURACION_MIN,
      paciente_hash: pHash,
      contact_id: parsed.contactId,
      optometrista: null,
      tipo_consulta: null,
      estado: 'confirmada',
      notas: null,
      gcal_event_id: null,
      origen: 'whapify',
      nombre_paciente: nombrePaciente,
      telefono_paciente: telefonoPaciente,
      producto_motivo: productoMotivo,
      resumen_expediente: resumenExpediente,
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
