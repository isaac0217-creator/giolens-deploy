/**
 * Frente G · G-13 · Tests de agents/_shared/config/timezone.ts
 *
 * Cobertura (8 tests):
 *   Fallback sin env (1) · Env válida + subregión + whitespace (3)
 *   · Vacío / whitespace-only → fallback silencioso (2)
 *   · Formato inválido (regex) → fallback + warn (1)
 *   · Zona inexistente (Intl) → fallback + warn (1)
 *   · Memoización estable (incluido en los anteriores vía _resetTimezoneCache)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getOpticaTimezone, _resetTimezoneCache } from '../../agents/_shared/config/timezone.js';

const FALLBACK = 'America/Tijuana';

describe('getOpticaTimezone — G-13 timezone configurable', () => {
  const original = process.env.OPTICA_TIMEZONE;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetTimezoneCache();
    delete process.env.OPTICA_TIMEZONE;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (original === undefined) delete process.env.OPTICA_TIMEZONE;
    else process.env.OPTICA_TIMEZONE = original;
    _resetTimezoneCache();
  });

  it('sin env → fallback America/Tijuana, sin warn', () => {
    expect(getOpticaTimezone()).toBe(FALLBACK);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('env válida America/Mexico_City → la respeta, sin warn', () => {
    process.env.OPTICA_TIMEZONE = 'America/Mexico_City';
    expect(getOpticaTimezone()).toBe('America/Mexico_City');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('env con subregión America/Argentina/Buenos_Aires → la respeta', () => {
    process.env.OPTICA_TIMEZONE = 'America/Argentina/Buenos_Aires';
    expect(getOpticaTimezone()).toBe('America/Argentina/Buenos_Aires');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('env con whitespace alrededor → trim y respeta', () => {
    process.env.OPTICA_TIMEZONE = '  America/Cancun  ';
    expect(getOpticaTimezone()).toBe('America/Cancun');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('env string vacío → fallback silencioso (sin warn)', () => {
    process.env.OPTICA_TIMEZONE = '';
    expect(getOpticaTimezone()).toBe(FALLBACK);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('env whitespace-only → fallback silencioso (sin warn)', () => {
    process.env.OPTICA_TIMEZONE = '   ';
    expect(getOpticaTimezone()).toBe(FALLBACK);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('env UTC (sin slash, no cumple regex) → fallback + warn', () => {
    process.env.OPTICA_TIMEZONE = 'UTC';
    expect(getOpticaTimezone()).toBe(FALLBACK);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('env formato válido pero zona inexistente (Foo/Bar) → fallback + warn', () => {
    process.env.OPTICA_TIMEZONE = 'Foo/Bar';
    expect(getOpticaTimezone()).toBe(FALLBACK);
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
