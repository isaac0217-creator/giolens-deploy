/**
 * agents/_shared/citas/revalidar-cita.ts — W2 · revalidación de fecha/hora de cita
 *
 * Función PURA, branch-agnóstica (sirve igual en rama A = Claude Engine, o
 * rama B = handler nuevo desde Whapify). NO crea eventos, NO toca red, NO
 * persiste: solo decide si una cita propuesta por el bot es agendable.
 *
 * Contrato (edge-case #1 de DECISION_CITA_CALENDARIO_W2):
 *   - El backend es la AUTORIDAD de la fecha. La FECHA/HORA del tag del bot es
 *     "mejor esfuerzo": se revalida contra el reloj propio en zona de la óptica
 *     (getOpticaTimezone(), tz database con DST — NUNCA el offset fijo -06:00).
 *   - Re-resuelve la frase cruda del paciente (REF) contra ese reloj y marca
 *     mismatch si la FECHA del bot ≠ la que el backend deduce de REF.
 *   - Rechaza: domingo, fuera de 10:00–16:30, fuera de [hoy, hoy+30d].
 *   - Ante CUALQUIER motivo → no agenda: estado CITA_SOLICITADA (revisión).
 *
 * Decisiones de diseño:
 *   - Toda comparación de calendario (ventana, día de semana) se hace en espacio
 *     de fecha-calendario (UTC-midnight como contador de días), inmune a DST.
 *   - "hoy" se deriva de `ahora` con Intl en la tz de la óptica (DST-correcto),
 *     no del reloj UTC del servidor.
 *   - `inicioISO` (instante UTC del inicio) se calcula con conversión
 *     wall-clock→UTC robusta vía Intl (aplica el offset DST del día). Sirve para
 *     logs/sanity; la creación GCal puede pasar dateTime+timeZone y dejar que
 *     Google aplique el offset (como ya hace api/citas.ts).
 *   - El resolver de REF es CONSERVADOR: solo marca mismatch en parseos de alta
 *     confianza (hoy / mañana / pasado mañana / nombre de día). Si REF es
 *     ambiguo o no parseable → no marca mismatch (warning no bloqueante), para
 *     no mandar a revisión citas legítimas por límites del parser.
 */

import { getOpticaTimezone } from '../config/timezone.js';

const MIN_MINUTOS = 10 * 60;      // 10:00 — apertura
const MAX_MINUTOS = 16 * 60 + 30; // 16:30 — última cita (memoria: 4:30pm)
const VENTANA_DIAS = 30;
const MS_DIA = 86_400_000;

export type EstadoRevalidacion = 'CITA_AGENDADA' | 'CITA_SOLICITADA';

export type MotivoRechazo =
  | 'fecha_malformada'
  | 'hora_malformada'
  | 'fecha_en_pasado'
  | 'fuera_ventana_30d'
  | 'domingo'
  | 'fuera_horario'
  | 'mismatch_ref';

export interface ResultadoRevalidacion {
  /** true → se puede crear el evento GCal. false → CITA_SOLICITADA / revisión humana. */
  ok: boolean;
  estado: EstadoRevalidacion;
  /** YYYY-MM-DD normalizada (wall-clock de la óptica). null si la fecha es inválida. */
  fecha: string | null;
  /** HH:MM 24h. null si la hora es inválida. */
  hora: string | null;
  /** Instante UTC ISO del inicio (DST-correcto). null si fecha/hora inválidas. */
  inicioISO: string | null;
  /** IANA tz usada para resolver. */
  tz: string;
  /** Por qué NO se agenda (vacío si ok). */
  motivos: MotivoRechazo[];
  /** Señales no bloqueantes (p.ej. REF no resuelto). */
  warnings: string[];
}

interface ZonedParts { y: number; mo: number; d: number; hh: number; mm: number; ss: number; }

export function resolverYRevalidarCita(
  fechaTag: string | null | undefined,
  horaTag: string | null | undefined,
  refCrudo: string | null | undefined,
  ahora: Date = new Date(),
): ResultadoRevalidacion {
  const tz = getOpticaTimezone();
  const motivos: MotivoRechazo[] = [];
  const warnings: string[] = [];

  const fechaP = parseFechaISO(fechaTag);
  const horaP = parseHora(horaTag);

  if (!fechaP) motivos.push('fecha_malformada');
  if (!horaP) motivos.push('hora_malformada');

  // Sin fecha o sin hora válidas no hay nada más que revalidar.
  if (!fechaP || !horaP) {
    return {
      ok: false,
      estado: 'CITA_SOLICITADA',
      fecha: fechaP ? fmtFecha(fechaP) : null,
      hora: horaP ? fmtHora(horaP) : null,
      inicioISO: null,
      tz,
      motivos,
      warnings,
    };
  }

  const fechaNorm = fmtFecha(fechaP);
  const horaNorm = fmtHora(horaP);

  // ── Ventana [hoy, hoy+30d] en calendario de la óptica (DST-inmune) ──
  const hoy = getZonedParts(ahora, tz);
  const idxHoy = diaIndex(hoy.y, hoy.mo, hoy.d);
  const idxTag = diaIndex(fechaP.y, fechaP.mo, fechaP.d);
  const diffDias = idxTag - idxHoy;
  if (diffDias < 0) motivos.push('fecha_en_pasado');
  else if (diffDias > VENTANA_DIAS) motivos.push('fuera_ventana_30d');

  // ── Día de semana (UTC-midnight: el weekday de una fecha-calendario es fijo) ──
  if (new Date(Date.UTC(fechaP.y, fechaP.mo - 1, fechaP.d)).getUTCDay() === 0) {
    motivos.push('domingo');
  }

  // ── Horario 10:00–16:30 (inclusive) ──
  const minutos = horaP.hh * 60 + horaP.mm;
  if (minutos < MIN_MINUTOS || minutos > MAX_MINUTOS) motivos.push('fuera_horario');

  // ── Mismatch con la frase cruda del paciente (REF) ──
  const aceptables = resolverRefAFechas(refCrudo, idxHoy);
  if (aceptables === null) {
    if (refCrudo && String(refCrudo).trim() !== '') warnings.push('ref_no_resuelto');
  } else if (!aceptables.includes(fechaNorm)) {
    motivos.push('mismatch_ref');
  }

  const inicioISO = wallClockToUTC(fechaP.y, fechaP.mo, fechaP.d, horaP.hh, horaP.mm, tz)
    .toISOString();

  const ok = motivos.length === 0;
  return {
    ok,
    estado: ok ? 'CITA_AGENDADA' : 'CITA_SOLICITADA',
    fecha: fechaNorm,
    hora: horaNorm,
    inicioISO,
    tz,
    motivos,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de parseo / formato
// ─────────────────────────────────────────────────────────────────────────────

function parseFechaISO(s: string | null | undefined): { y: number; mo: number; d: number } | null {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  // Validez de calendario real (rechaza 2026-02-30, 2026-13-01, etc.).
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return { y, mo, d };
}

function parseHora(s: string | null | undefined): { hh: number; mm: number } | null {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const hh = +m[1], mm = +m[2];
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

function fmtFecha(p: { y: number; mo: number; d: number }): string {
  return `${pad4(p.y)}-${pad2(p.mo)}-${pad2(p.d)}`;
}
function fmtHora(p: { hh: number; mm: number }): string {
  return `${pad2(p.hh)}:${pad2(p.mm)}`;
}
function pad2(n: number): string { return String(n).padStart(2, '0'); }
function pad4(n: number): string { return String(n).padStart(4, '0'); }

/** Índice de día-calendario (contador entero de días desde epoch, sin hora). */
function diaIndex(y: number, mo: number, d: number): number {
  return Math.floor(Date.UTC(y, mo - 1, d) / MS_DIA);
}

function fechaDesdeIndex(idx: number): string {
  const dt = new Date(idx * MS_DIA);
  return `${pad4(dt.getUTCFullYear())}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timezone (Intl, DST-correcto)
// ─────────────────────────────────────────────────────────────────────────────

function getZonedParts(date: Date, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return {
    y: get('year'), mo: get('month'), d: get('day'),
    hh: get('hour'), mm: get('minute'), ss: get('second'),
  };
}

/**
 * Convierte wall-clock (en tz) → instante UTC. Itera para asentar el offset
 * (incluido el salto DST). Para horas de cita (10:00–16:30, lejos del salto de
 * las 2am) converge en 1 paso; el bucle protege los bordes.
 */
function wallClockToUTC(y: number, mo: number, d: number, hh: number, mm: number, tz: string): Date {
  const targetMs = Date.UTC(y, mo - 1, d, hh, mm, 0);
  let t = targetMs;
  for (let i = 0; i < 3; i++) {
    const p = getZonedParts(new Date(t), tz);
    const shownMs = Date.UTC(p.y, p.mo - 1, p.d, p.hh, p.mm, p.ss);
    const diff = targetMs - shownMs;
    if (diff === 0) break;
    t += diff;
  }
  return new Date(t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver conservador de la frase cruda (REF) del paciente
// ─────────────────────────────────────────────────────────────────────────────

const DIAS_SEMANA: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};

/**
 * Devuelve el conjunto de fechas YYYY-MM-DD plausibles según la frase del
 * paciente, o null si no se puede resolver con confianza. Usa UNIÓN de
 * interpretaciones para minimizar falsos positivos de mismatch.
 */
function resolverRefAFechas(ref: string | null | undefined, idxHoy: number): string[] | null {
  if (!ref || typeof ref !== 'string') return null;
  const norm = ref.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ').trim();
  if (norm === '') return null;

  const offsets = new Set<number>();

  if (/\bhoy\b/.test(norm)) offsets.add(0);

  // "pasado mañana" / "pasado" → +2 (tiene prioridad sobre "mañana" suelto).
  const tienePasado = /\bpasado\b/.test(norm);
  if (tienePasado) offsets.add(2);

  // "mañana" como DÍA (no como "la mañana" = franja matutina).
  const sinFranja = norm.replace(/\bla manana\b/g, ' ').replace(/\blas mananas\b/g, ' ');
  if (!tienePasado && /\bmanana\b/.test(sinFranja)) offsets.add(1);

  // Nombre de día → ocurrencia más próxima y la de la semana siguiente
  // (tolera la ambigüedad "el sábado" = esta semana o la próxima).
  for (const [nombre, wd] of Object.entries(DIAS_SEMANA)) {
    if (new RegExp(`\\b${nombre}\\b`).test(norm)) {
      const wdHoy = new Date((idxHoy) * MS_DIA).getUTCDay();
      const delta = ((wd - wdHoy) + 7) % 7;
      offsets.add(delta);
      offsets.add(delta + 7);
    }
  }

  if (offsets.size === 0) return null;
  return [...offsets].map((o) => fechaDesdeIndex(idxHoy + o));
}
