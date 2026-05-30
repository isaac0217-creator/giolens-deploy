/**
 * tests/revalidar-cita.test.ts — W2 · revalidación de fecha/hora de cita.
 *
 * Función pura, sin red. Reloj `ahora` inyectado para determinismo.
 * tz por defecto: America/Tijuana (fallback de getOpticaTimezone), con DST
 * (Baja California sigue el DST de EEUU: PDT -07:00 verano, PST -08:00 invierno).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolverYRevalidarCita } from '../agents/_shared/citas/revalidar-cita.js';

// Reloj fijo: 2026-05-26 18:00Z = mar 2026-05-26 11:00 en Tijuana (PDT).
// "hoy" en la óptica = martes 2026-05-26.
const AHORA = new Date('2026-05-26T18:00:00Z');

beforeEach(() => { delete process.env.OPTICA_TIMEZONE; });
afterEach(() => { delete process.env.OPTICA_TIMEZONE; });

describe('resolverYRevalidarCita — happy path', () => {
  it('cita válida (jueves, 14:00, REF coherente) → CITA_AGENDADA', () => {
    // 2026-05-28 es jueves, +2 días de hoy.
    const r = resolverYRevalidarCita('2026-05-28', '14:00', 'el jueves a las 2', AHORA);
    expect(r.ok).toBe(true);
    expect(r.estado).toBe('CITA_AGENDADA');
    expect(r.motivos).toEqual([]);
    expect(r.fecha).toBe('2026-05-28');
    expect(r.hora).toBe('14:00');
    expect(r.tz).toBe('America/Tijuana');
  });
});

describe('resolverYRevalidarCita — rechazos de rango', () => {
  it('domingo → motivo domingo, CITA_SOLICITADA', () => {
    // 2026-05-31 es domingo.
    const r = resolverYRevalidarCita('2026-05-31', '12:00', null, AHORA);
    expect(r.ok).toBe(false);
    expect(r.estado).toBe('CITA_SOLICITADA');
    expect(r.motivos).toContain('domingo');
  });

  it('antes de 10:00 → fuera_horario', () => {
    const r = resolverYRevalidarCita('2026-05-28', '09:30', null, AHORA);
    expect(r.motivos).toContain('fuera_horario');
  });

  it('después de 16:30 → fuera_horario', () => {
    const r = resolverYRevalidarCita('2026-05-28', '17:00', null, AHORA);
    expect(r.motivos).toContain('fuera_horario');
  });

  it('bordes 10:00 y 16:30 son inclusivos', () => {
    expect(resolverYRevalidarCita('2026-05-28', '10:00', null, AHORA).motivos).not.toContain('fuera_horario');
    expect(resolverYRevalidarCita('2026-05-28', '16:30', null, AHORA).motivos).not.toContain('fuera_horario');
    expect(resolverYRevalidarCita('2026-05-28', '16:31', null, AHORA).motivos).toContain('fuera_horario');
  });

  it('fecha en el pasado → fecha_en_pasado', () => {
    const r = resolverYRevalidarCita('2026-05-25', '11:00', null, AHORA);
    expect(r.motivos).toContain('fecha_en_pasado');
  });

  it('hoy mismo (diff 0) NO es pasado', () => {
    const r = resolverYRevalidarCita('2026-05-26', '11:00', null, AHORA);
    expect(r.motivos).not.toContain('fecha_en_pasado');
    expect(r.motivos).not.toContain('fuera_ventana_30d');
  });

  it('hoy+30 es el borde aceptado; hoy+31 cae fuera de ventana', () => {
    // hoy = 2026-05-26 → +30 = 2026-06-25 (jueves), +31 = 2026-06-26 (viernes).
    expect(resolverYRevalidarCita('2026-06-25', '11:00', null, AHORA).motivos).not.toContain('fuera_ventana_30d');
    expect(resolverYRevalidarCita('2026-06-26', '11:00', null, AHORA).motivos).toContain('fuera_ventana_30d');
  });
});

describe('resolverYRevalidarCita — malformados', () => {
  it('fecha no-ISO → fecha_malformada, sin inicioISO', () => {
    const r = resolverYRevalidarCita('mañana', '14:00', null, AHORA);
    expect(r.ok).toBe(false);
    expect(r.motivos).toContain('fecha_malformada');
    expect(r.fecha).toBeNull();
    expect(r.inicioISO).toBeNull();
  });

  it('fecha de calendario inexistente (2026-02-30) → fecha_malformada', () => {
    const r = resolverYRevalidarCita('2026-02-30', '14:00', null, AHORA);
    expect(r.motivos).toContain('fecha_malformada');
  });

  it('hora no-HH:MM ("2pm") → hora_malformada', () => {
    const r = resolverYRevalidarCita('2026-05-28', '2pm', null, AHORA);
    expect(r.motivos).toContain('hora_malformada');
    expect(r.hora).toBeNull();
  });
});

describe('resolverYRevalidarCita — mismatch con REF', () => {
  it('REF "el lunes" vs FECHA sábado → mismatch_ref → CITA_SOLICITADA', () => {
    // 2026-05-30 es sábado; REF dice lunes (2026-06-01) → no coincide.
    const r = resolverYRevalidarCita('2026-05-30', '12:00', 'el lunes a las 12', AHORA);
    expect(r.ok).toBe(false);
    expect(r.motivos).toContain('mismatch_ref');
  });

  it('REF "mañana" coincide con hoy+1 → sin mismatch', () => {
    // hoy = 2026-05-26 → mañana = 2026-05-27 (miércoles).
    const r = resolverYRevalidarCita('2026-05-27', '11:00', 'mañana a las 11', AHORA);
    expect(r.motivos).not.toContain('mismatch_ref');
    expect(r.ok).toBe(true);
  });

  it('REF "mañana" NO coincide con fecha lejana → mismatch_ref', () => {
    const r = resolverYRevalidarCita('2026-06-10', '11:00', 'mañana a las 11', AHORA);
    expect(r.motivos).toContain('mismatch_ref');
  });

  it('ambigüedad de día: "el sábado" acepta esta semana o la próxima', () => {
    // 2026-05-30 (este sábado) y 2026-06-06 (próximo) ambos válidos.
    expect(resolverYRevalidarCita('2026-05-30', '12:00', 'el sábado', AHORA).motivos).not.toContain('mismatch_ref');
    expect(resolverYRevalidarCita('2026-06-06', '12:00', 'el sábado', AHORA).motivos).not.toContain('mismatch_ref');
  });

  it('"pasado mañana" → +2, no lo confunde con "mañana"', () => {
    // hoy = 2026-05-26 → pasado mañana = 2026-05-28.
    expect(resolverYRevalidarCita('2026-05-28', '11:00', 'pasado mañana', AHORA).motivos).not.toContain('mismatch_ref');
    expect(resolverYRevalidarCita('2026-05-27', '11:00', 'pasado mañana', AHORA).motivos).toContain('mismatch_ref');
  });

  it('"en la mañana" (franja) NO se interpreta como día → REF no resuelto', () => {
    const r = resolverYRevalidarCita('2026-06-10', '11:00', 'cuando puedas en la mañana', AHORA);
    expect(r.motivos).not.toContain('mismatch_ref');
    expect(r.warnings).toContain('ref_no_resuelto');
  });

  it('REF no parseable → warning no bloqueante, no mismatch', () => {
    const r = resolverYRevalidarCita('2026-05-28', '14:00', 'lo que sea, gracias', AHORA);
    expect(r.motivos).not.toContain('mismatch_ref');
    expect(r.warnings).toContain('ref_no_resuelto');
    expect(r.ok).toBe(true);
  });

  it('REF vacío/null → sin warning ni mismatch', () => {
    const r = resolverYRevalidarCita('2026-05-28', '14:00', '', AHORA);
    expect(r.warnings).not.toContain('ref_no_resuelto');
    expect(r.motivos).not.toContain('mismatch_ref');
  });
});

describe('resolverYRevalidarCita — DST America/Tijuana', () => {
  it('verano (PDT, -07:00): 14:00 wall-clock → 21:00Z', () => {
    const r = resolverYRevalidarCita('2026-05-28', '14:00', null, AHORA);
    expect(r.inicioISO).toBe('2026-05-28T21:00:00.000Z');
  });

  it('invierno (PST, -08:00): 14:00 wall-clock → 22:00Z', () => {
    const ahoraInvierno = new Date('2026-01-10T18:00:00Z');
    // 2026-01-15 es jueves, dentro de ventana respecto a 2026-01-10.
    const r = resolverYRevalidarCita('2026-01-15', '14:00', null, ahoraInvierno);
    expect(r.inicioISO).toBe('2026-01-15T22:00:00.000Z');
    expect(r.ok).toBe(true);
  });

  it('"hoy" se calcula en la tz de la óptica, no en UTC', () => {
    // 2026-05-27 06:30Z = mar 2026-05-26 23:30 en Tijuana (PDT). "hoy" debe ser
    // 26, no 27: agendar el 27 NO debe ser "pasado" indebido, y el 26 sigue vivo.
    const cercaMedianoche = new Date('2026-05-27T06:30:00Z');
    expect(resolverYRevalidarCita('2026-05-26', '11:00', null, cercaMedianoche).motivos).not.toContain('fecha_en_pasado');
    expect(resolverYRevalidarCita('2026-05-25', '11:00', null, cercaMedianoche).motivos).toContain('fecha_en_pasado');
  });
});

describe('resolverYRevalidarCita — tz configurable', () => {
  it('respeta OPTICA_TIMEZONE override (CDMX, sin DST, -06:00)', () => {
    process.env.OPTICA_TIMEZONE = 'America/Mexico_City';
    const r = resolverYRevalidarCita('2026-05-28', '14:00', null, AHORA);
    expect(r.tz).toBe('America/Mexico_City');
    expect(r.inicioISO).toBe('2026-05-28T20:00:00.000Z');
  });
});
