/**
 * GioLens — cost-tracker.js tests (Vitest)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { calcUSD, track, getDailyCost, getDailyStats, checkCap, _resetForTests } from '../cost-tracker.js';

describe('cost-tracker.js', () => {
  beforeEach(() => _resetForTests());

  it('calcUSD: Haiku 4.5 1M input + 1M output = $6.00', () => {
    const usd = calcUSD({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-haiku-4-5');
    expect(usd).toBeCloseTo(6.0, 4);
  });

  it('calcUSD: incluye cache_read y cache_write tokens', () => {
    const usd = calcUSD({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens:     1_000_000,
    }, 'claude-haiku-4-5');
    expect(usd).toBeCloseTo(1.25 + 0.10, 4);
  });

  it('calcUSD: usage null -> 0', () => {
    expect(calcUSD(null)).toBe(0);
  });

  it('track acumula por agente y getDailyCost lo refleja', () => {
    track('analista', { input_tokens: 500_000, output_tokens: 100_000 });
    track('analista', { input_tokens: 500_000, output_tokens: 100_000 });
    // 1M in => $1, 200k out => $1 => total $2
    const cost = getDailyCost('analista');
    expect(cost).toBeCloseTo(1.0 + 1.0, 4);
    const stats = getDailyStats('analista');
    expect(stats.calls).toBe(2);
    expect(stats.input_tokens).toBe(1_000_000);
  });

  it('getDailyCost para agente sin actividad = 0', () => {
    expect(getDailyCost('nuevo')).toBe(0);
  });

  it('checkCap retorna true al exceder', () => {
    track('optimizacion', { input_tokens: 5_000_000, output_tokens: 0 }); // $5
    expect(checkCap('optimizacion', 10)).toBe(false);
    expect(checkCap('optimizacion', 5)).toBe(true);
    expect(checkCap('optimizacion', 4)).toBe(true);
  });

  it('checkCap con cap invalido -> false (no bloquea por error de config)', () => {
    track('optimizacion', { input_tokens: 5_000_000, output_tokens: 0 });
    expect(checkCap('optimizacion', 0)).toBe(false);
    expect(checkCap('optimizacion', -1)).toBe(false);
    expect(checkCap('optimizacion', NaN)).toBe(false);
  });

  it('agentes independientes no se contaminan', () => {
    track('a', { input_tokens: 1_000_000, output_tokens: 0 });
    track('b', { input_tokens: 2_000_000, output_tokens: 0 });
    expect(getDailyCost('a')).toBeCloseTo(1.0, 4);
    expect(getDailyCost('b')).toBeCloseTo(2.0, 4);
  });
});
