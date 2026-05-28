/**
 * Issue #4 · P2-2 · Tests de timingSafeBearer (comparación constant-time).
 */

import { describe, it, expect } from 'vitest';
import { timingSafeBearer } from '../../agents/_shared/auth/bearer.js';

describe('timingSafeBearer — P2-2 constant-time bearer compare', () => {
  const SECRET = 's3cr3t-cron-value';

  it('header correcto "Bearer {secret}" → true', () => {
    expect(timingSafeBearer(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it('secret incorrecto (misma longitud) → false', () => {
    const wrong = 'X'.repeat(SECRET.length);
    expect(timingSafeBearer(`Bearer ${wrong}`, SECRET)).toBe(false);
  });

  it('longitud distinta → false (sin throw de timingSafeEqual)', () => {
    expect(timingSafeBearer('Bearer corto', SECRET)).toBe(false);
    expect(timingSafeBearer(`Bearer ${SECRET}extra`, SECRET)).toBe(false);
  });

  it('header sin prefijo Bearer → false', () => {
    expect(timingSafeBearer(SECRET, SECRET)).toBe(false);
  });

  it('header vacío → false', () => {
    expect(timingSafeBearer('', SECRET)).toBe(false);
  });

  it('secret vacío → false (defensa CRON_SECRET ausente)', () => {
    expect(timingSafeBearer('Bearer ', '')).toBe(false);
  });
});
