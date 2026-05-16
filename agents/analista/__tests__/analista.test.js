/**
 * GioLens — Agente Analista · __tests__/analista.test.js
 * Rol: Tests Vitest para runAnalista. Mockea Anthropic, bus, cost-tracker
 *      y las tools de _shared para no hacer llamadas reales ni I/O.
 *
 * Nota: estos tests usan vi.mock() con paths exactos a /agents/_shared/*.
 * Si esos módulos aún no existen, la resolución de mock fallará — está
 * esperado mientras el agente paralelo de _shared no haya aterrizado.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────
vi.mock('../../_shared/anthropic.js', () => ({
  callClaude: vi.fn(),
}));

vi.mock('../../_shared/bus.js', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../_shared/cost-tracker.js', () => ({
  trackCost: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../_shared/tools/read-kpis.js', () => ({
  default: vi.fn(),
}));

vi.mock('../../_shared/tools/read-pipeline.js', () => ({
  default: vi.fn(),
}));

// Importes después de los mocks
import { callClaude } from '../../_shared/anthropic.js';
import { publish } from '../../_shared/bus.js';
import { trackCost } from '../../_shared/cost-tracker.js';
import readKpis from '../../_shared/tools/read-kpis.js';
import readPipeline from '../../_shared/tools/read-pipeline.js';
import { runAnalista } from '../graph.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────
const PIPELINES = ['216977', '755062'];

function mockClaudeWithInsights(insights) {
  callClaude.mockResolvedValue({
    text: JSON.stringify({ insights }),
    usage: { input_tokens: 1000, output_tokens: 500 },
    cost_usd: 0.0105,
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────
describe('runAnalista', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readKpis.mockResolvedValue({
      spend: 100,
      impressions: 10000,
      clicks: 200,
      leads: 12,
      cpr: 8.33,
    });
    readPipeline.mockResolvedValue({
      stages: { NUEVO: 5, COTIZADO: 3, 'VISITA CONFIRMADA': 1 },
      stuck_leads: 2,
    });
  });

  it('returns insights array on happy path', async () => {
    mockClaudeWithInsights([
      {
        severity: 'low',
        metric: 'CPR',
        pipeline_id: '216977',
        observation: 'CPR estable en $8.33',
        recommendation: 'Mantener configuración actual',
        evidence: {
          current_value: 8.33,
          baseline_value: 8.64,
          delta_pct: -3.6,
          period: 'last_24h',
          source: 'meta_ads',
        },
      },
    ]);

    const result = await runAnalista({ pipelineIds: PIPELINES, period: 'last_24h' });

    expect(result).toHaveProperty('insights');
    expect(Array.isArray(result.insights)).toBe(true);
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].metric).toBe('CPR');
    expect(result).toHaveProperty('cost_usd');
    expect(result).toHaveProperty('latency_ms');
    expect(typeof result.latency_ms).toBe('number');

    // Tools llamadas una vez por pipeline
    expect(readKpis).toHaveBeenCalledTimes(PIPELINES.length);
    expect(readPipeline).toHaveBeenCalledTimes(PIPELINES.length);
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(trackCost).toHaveBeenCalledTimes(1);
  });

  it('publishes high-severity insights to bus', async () => {
    mockClaudeWithInsights([
      {
        severity: 'low',
        metric: 'CTR',
        pipeline_id: '216977',
        observation: 'sin cambios',
        recommendation: 'monitorear',
        evidence: { current_value: 2, baseline_value: 2, delta_pct: 0, period: 'last_24h', source: 'meta_ads' },
      },
      {
        severity: 'high',
        metric: 'CPR',
        pipeline_id: '755062',
        observation: 'CPR subió 30%',
        recommendation: 'Revisar creativos',
        evidence: { current_value: 13.4, baseline_value: 10.29, delta_pct: 30.2, period: 'last_24h', source: 'meta_ads' },
      },
      {
        severity: 'critical',
        metric: 'leads_activos',
        pipeline_id: '216977',
        observation: 'Pipeline sin leads 26h',
        recommendation: 'Investigar conexión Meta → Wapify',
        evidence: { current_value: 0, baseline_value: 12, delta_pct: -100, period: 'last_24h', source: 'crm_wapify' },
      },
    ]);

    const result = await runAnalista({ pipelineIds: PIPELINES, period: 'last_24h' });

    // 2 de 3 publicados (high + critical, no el low)
    expect(publish).toHaveBeenCalledTimes(2);
    expect(result.published).toBe(2);

    const publishedSeverities = publish.mock.calls.map((c) => c[0].severity);
    expect(publishedSeverities).toContain('high');
    expect(publishedSeverities).toContain('critical');
    expect(publishedSeverities).not.toContain('low');

    // Cada mensaje publicado tiene la forma agent_message
    for (const call of publish.mock.calls) {
      expect(call[0]).toMatchObject({
        type: 'agent_message',
        from: 'analista',
      });
      expect(call[0]).toHaveProperty('payload');
      expect(call[0]).toHaveProperty('ts');
    }
  });

  it('handles tool errors gracefully', async () => {
    // Una tool falla en un pipeline, la otra responde normal
    readKpis.mockImplementation(({ pipeline_id }) => {
      if (pipeline_id === '216977') {
        return Promise.reject(new Error('Meta API timeout'));
      }
      return Promise.resolve({ spend: 50, leads: 5, cpr: 10 });
    });

    mockClaudeWithInsights([]);

    const result = await runAnalista({ pipelineIds: PIPELINES, period: 'last_24h' });

    // No throw — el run completa
    expect(result).toBeDefined();
    expect(Array.isArray(result.insights)).toBe(true);

    // Errores reportados en el resultado
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatchObject({
      pipeline_id: '216977',
      tool: 'read_kpis',
    });

    // Claude se llama igualmente con el contexto parcial
    expect(callClaude).toHaveBeenCalledTimes(1);
  });
});
