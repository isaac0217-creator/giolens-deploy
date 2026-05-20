/**
 * GioLens — inngest/functions/run-microseg.js · tests del wiring C.2.1
 *
 * Cubre:
 *   - assertSegmentationSchema (PRE-5 · schema strict clasificador → análisis)
 *   - handler offline: clasificación determinista (sin LLM) + invocación
 *     del agente Optimizacion vía runWithTrace.
 *   - R5: claves de step deterministas (incluyen correlation_id).
 *
 * El agente Optimizacion se mockea: el wiring no debe depender de Anthropic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const optimizacionMock = vi.fn();
vi.mock('../../agents/optimizacion/index.js', () => ({
  executeOptimizacionDailyRun: (...args) => optimizacionMock(...args),
}));

const { default: runMicroseg, assertSegmentationSchema } =
  await import('../functions/run-microseg.js');

/** step mock: ejecuta el fn y registra los ids usados. */
function makeStep() {
  const ids = [];
  return {
    ids,
    run: async (id, fn) => { ids.push(id); return fn(); },
    sendEvent: async () => ({ ids: [] }),
    sleep: async () => {},
  };
}

const validSegment = { count: 0, etapa_top: '—' };
const validClassification = {
  pipeline_id: '216977',
  total: 0,
  horaPico: 'tarde',
  segments: {
    caliente: { ...validSegment },
    activo:   { ...validSegment },
    tibio:    { ...validSegment },
    frio:     { ...validSegment },
  },
};

beforeEach(() => {
  optimizacionMock.mockReset();
  optimizacionMock.mockResolvedValue({
    proposals: [{ id: 'p1' }],
    validated: [{ id: 'p1' }],
    blocked: [],
    cost_usd: 0.0123,
    latency_ms: 7,
    errors: [],
  });
});

describe('assertSegmentationSchema (PRE-5)', () => {
  it('acepta una clasificación válida', () => {
    expect(() => assertSegmentationSchema(validClassification)).not.toThrow();
  });

  it('lanza si no es objeto', () => {
    expect(() => assertSegmentationSchema(null)).toThrow(/PRE-5/);
  });

  it('lanza si falta pipeline_id', () => {
    const bad = { ...validClassification, pipeline_id: '' };
    expect(() => assertSegmentationSchema(bad)).toThrow(/pipeline_id requerido/);
  });

  it('lanza si total no es número', () => {
    const bad = { ...validClassification, total: 'cero' };
    expect(() => assertSegmentationSchema(bad)).toThrow(/total inválido/);
  });

  it('lanza si falta un segmento', () => {
    const bad = {
      ...validClassification,
      segments: { ...validClassification.segments, tibio: undefined },
    };
    expect(() => assertSegmentationSchema(bad)).toThrow(/segmento "tibio"/);
  });

  it('lanza si un segmento tiene count no numérico', () => {
    const bad = {
      ...validClassification,
      segments: { ...validClassification.segments, frio: { count: 'x', etapa_top: '—' } },
    };
    expect(() => assertSegmentationSchema(bad)).toThrow(/segmento "frio"/);
  });
});

describe('run-microseg handler (C.2.1 wiring)', () => {
  it('clasifica los 5 pipelines e invoca el agente Optimizacion', async () => {
    const step = makeStep();
    const out = await runMicroseg.handler({
      event: { data: { correlation_id: 'corr-mseg-1' } },
      step,
    });
    expect(out.pipelines).toBe(5);
    expect(out.correlation_id).toBe('corr-mseg-1');
    expect(optimizacionMock).toHaveBeenCalledTimes(1);
    expect(out.optimizacion.proposals).toBe(1);
    expect(out.optimizacion.cost_usd).toBe(0.0123);
    expect(out.optimizacion.trace_ok).toBe(true);
    expect(out.optimizacion.error).toBeNull();
  });

  it('runWithTrace inyecta el correlation_id en el agente', async () => {
    const step = makeStep();
    await runMicroseg.handler({ event: { data: { correlation_id: 'corr-xyz' } }, step });
    expect(optimizacionMock).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'last_24h', correlation_id: 'corr-xyz' }),
    );
  });

  it('R5: las claves de step incluyen el correlation_id (deterministas)', async () => {
    const step = makeStep();
    await runMicroseg.handler({ event: { data: { correlation_id: 'corr-det' } }, step });
    expect(step.ids).toContain('segment-pipeline-216977-corr-det');
    expect(step.ids).toContain('optimizacion-analysis-corr-det');
    expect(step.ids).toContain('upsert-supabase-corr-det');
  });

  it('filtra pipelines por event.data.pipeline_ids', async () => {
    const step = makeStep();
    const out = await runMicroseg.handler({
      event: { data: { correlation_id: 'corr-f', pipeline_ids: ['216977', '94103'] } },
      step,
    });
    expect(out.pipelines).toBe(2);
  });

  it('genera correlation_id si el evento no lo trae', async () => {
    const step = makeStep();
    const out = await runMicroseg.handler({ event: { data: {} }, step });
    expect(out.correlation_id).toMatch(/^microseg-\d+$/);
  });

  it('no invoca al agente más de una vez por run (no doble cobro)', async () => {
    const step = makeStep();
    await runMicroseg.handler({ event: { data: { correlation_id: 'corr-once' } }, step });
    expect(optimizacionMock).toHaveBeenCalledTimes(1);
  });
});
