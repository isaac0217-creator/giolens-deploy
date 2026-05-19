/**
 * GioLens — run-with-trace.js · tests (C.1.2)
 */

import { describe, it, expect } from 'vitest';
import { runWithTrace, newCorrelationId } from '../run-with-trace.js';

describe('newCorrelationId', () => {
  it('genera ids únicos con prefijo del agente', () => {
    const a = newCorrelationId('analista');
    const b = newCorrelationId('analista');
    expect(a).toMatch(/^run-analista-/);
    expect(a).not.toBe(b);
  });
});

describe('runWithTrace', () => {
  it('ejecuta el agente y produce trace con steps no vacío', async () => {
    const fakeAgent = async () => ({ insights: [], cost_usd: 0.01, latency_ms: 42 });
    const { result, trace, error } = await runWithTrace('analista', fakeAgent);

    expect(error).toBeNull();
    expect(result.cost_usd).toBe(0.01);
    expect(trace.agent).toBe('analista');
    expect(trace.ok).toBe(true);
    expect(trace.steps.length).toBeGreaterThan(0);
    expect(trace.steps[0].step).toBe('invoke');
    expect(trace.steps[trace.steps.length - 1].step).toBe('result');
  });

  it('propaga el correlation_id provisto (cascada)', async () => {
    let seenArgs = null;
    const fakeAgent = async (args) => { seenArgs = args; return {}; };
    const { trace } = await runWithTrace('qa', fakeAgent, { mode: 'evals' }, { correlation_id: 'corr-parent' });

    expect(trace.correlation_id).toBe('corr-parent');
    // El correlation_id se inyecta en los args del agente.
    expect(seenArgs.correlation_id).toBe('corr-parent');
    expect(seenArgs.mode).toBe('evals');
  });

  it('genera correlation_id si no se provee', async () => {
    const { trace } = await runWithTrace('creativo', async () => ({}));
    expect(trace.correlation_id).toMatch(/^run-creativo-/);
  });

  it('extrae cost_usd y latency_ms al step result', async () => {
    const { trace } = await runWithTrace('optimizacion', async () => ({ cost_usd: 0.5, latency_ms: 100 }));
    const resultStep = trace.steps.find((s) => s.step === 'result');
    expect(resultStep.cost_usd).toBe(0.5);
    expect(resultStep.latency_ms).toBe(100);
  });

  it('no rechaza si el agente lanza — refleja error en trace', async () => {
    const boom = async () => { throw new Error('agente reventó'); };
    const { result, trace, error } = await runWithTrace('desarrollador', boom);

    expect(result).toBeNull();
    expect(error).toBe('agente reventó');
    expect(trace.ok).toBe(false);
    expect(trace.steps[trace.steps.length - 1].step).toBe('error');
    expect(trace.steps[trace.steps.length - 1].error).toBe('agente reventó');
  });

  it('lanza si runFn no es función', async () => {
    await expect(runWithTrace('x', null)).rejects.toThrow(/runFn debe ser una función/);
  });
});
