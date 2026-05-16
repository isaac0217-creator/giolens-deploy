/**
 * GioLens — Agente Creativo · __tests__/creativo.test.js
 * Rol: Tests Vitest para los 3 flujos creativos. Mockea callClaude, bus,
 *      cost-tracker y approval para no hacer llamadas reales.
 *
 * Cobertura:
 *   - generateScriptVariants devuelve 3 variantes con status='draft'.
 *   - generateAdAngles publica draft con requires_approval=true.
 *   - Plantillas pre-aprobadas en /templates tienen status='approved' (bypass).
 *   - pickInsight extrae señal de fatiga si viene del Analista.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Mocks ─────────────────────────────────────────────────────────────────
vi.mock('../../_shared/anthropic.js', () => ({
  callClaude: vi.fn(),
}));

vi.mock('../../_shared/bus.js', () => ({
  publish: vi.fn((msg) => ({ ...msg, created_at: new Date().toISOString() })),
}));

vi.mock('../../_shared/cost-tracker.js', () => ({
  track: vi.fn(() => ({ usd: 0.01, total: { usd: 0.01, calls: 1, input_tokens: 0, output_tokens: 0 } })),
}));

vi.mock('../../_shared/approval.js', () => ({
  requestApproval: vi.fn(async (req) => ({
    approved: true,
    by: 'auto-stub',
    at: new Date().toISOString(),
    decision_id: req.decision_id,
  })),
}));

import { callClaude } from '../../_shared/anthropic.js';
import { publish } from '../../_shared/bus.js';
import { track } from '../../_shared/cost-tracker.js';
import { requestApproval } from '../../_shared/approval.js';
import {
  generateScriptVariants,
  generateAdAngles,
  generateReactivationTemplate,
  pickInsight,
} from '../graph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', 'templates');

// ─── Fixtures ──────────────────────────────────────────────────────────────
function mockClaude(payload) {
  callClaude.mockResolvedValue({
    text: JSON.stringify(payload),
    usage: { input_tokens: 800, output_tokens: 400 },
    cost_usd: 0.0084,
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────
describe('generateScriptVariants', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 3 variants with status=draft and requires_approval=true', async () => {
    mockClaude({
      task: 'script',
      pipeline_id: '755062',
      stage: 'COTIZADO',
      status: 'draft',
      requires_approval: true,
      variants: [
        { angle: 'urgencia',          body: 'Hola — última semana de promo GioSports.', rationale: 'crear FOMO' },
        { angle: 'social_proof',      body: 'Más de 200 ciclistas tijuanenses ya los usan.', rationale: 'prueba social' },
        { angle: 'beneficio_funcional', body: 'Solar UV deportivo desde $1,950, sin receta.', rationale: 'remueve fricción médica' },
      ],
    });

    const result = await generateScriptVariants({
      pipelineId: '755062',
      stage: 'COTIZADO',
      insightContext: { metric: 'CTR', severity: 'medium', observation: 'CTR cayó 15%' },
    });

    expect(result.error).toBeNull();
    expect(result.draft).toBeDefined();
    expect(result.draft.status).toBe('draft');
    expect(result.draft.requires_approval).toBe(true);
    expect(result.draft.variants).toHaveLength(3);
    expect(result.draft.pipeline_id).toBe('755062');
    expect(result.draft.stage).toBe('COTIZADO');

    // Publicado al bus como draft.script
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      from_agent: 'creativo',
      type: 'draft.script',
    });
    expect(publish.mock.calls[0][0].payload.status).toBe('draft');

    // Approval solicitada
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(result.approval.approved).toBe(true);

    // Cost tracked
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0][0]).toBe('creativo');
  });

  it('returns error on parse failure', async () => {
    callClaude.mockResolvedValue({ text: 'no soy json', usage: { input_tokens: 100, output_tokens: 10 } });

    const result = await generateScriptVariants({ pipelineId: '216977', stage: 'NUEVO' });

    expect(result.error).toBe('parse_failed_or_invalid_shape');
    expect(result.draft).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
  });
});

describe('generateAdAngles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires approval flag set and publishes draft.ad', async () => {
    mockClaude({
      task: 'ad',
      pipeline_id: '252999',
      period: 'last_7d',
      status: 'draft',
      requires_approval: true,
      angles: [
        { angle: 'b2b',     headline: 'Z87 para tu equipo',        body: 'Cotización con factura y descuento por volumen.', cta: 'Enviar mensaje', rationale: 'B2B fuerte' },
        { angle: 'online',  headline: 'Envío nacional Z87',         body: 'Compra desde casa, certificados ANSI Z87.1.',     cta: 'Comprar',        rationale: '80.9% cierra online' },
        { angle: 'precio',  headline: 'Z87 desde $2,999',           body: 'Lente de seguridad industrial sin graduación.',   cta: 'Más información', rationale: 'ancla precio' },
      ],
    });

    const result = await generateAdAngles({ pipelineId: '252999', period: 'last_7d' });

    expect(result.error).toBeNull();
    expect(result.draft.angles).toHaveLength(3);
    expect(result.draft.status).toBe('draft');
    expect(result.draft.requires_approval).toBe(true);

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'draft.ad',
      from_agent: 'creativo',
    }));
    expect(publish.mock.calls[0][0].payload.requires_approval).toBe(true);

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0][0].action).toBe('create_ad_angles');
  });
});

describe('generateReactivationTemplate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes draft.reactivation with primary + 2 alternatives', async () => {
    mockClaude({
      task: 'reactivation',
      pipeline_id: '94103',
      stage_in: 'COTIZADO',
      days_inactive: 7,
      status: 'draft',
      requires_approval: true,
      primary: { body: 'Hola [NOMBRE], hace [DIAS_INACTIVO] días viste Michael Kors…', params: ['NOMBRE','DIAS_INACTIVO'], rationale: 'marca #1' },
      alternatives: [
        { body: 'Hola [NOMBRE], nueva colección Versace…', params: ['NOMBRE'], rationale: 'segunda marca' },
        { body: 'Hola [NOMBRE], asesoría de imagen gratis esta semana.', params: ['NOMBRE'], rationale: 'consultoría' },
      ],
    });

    const result = await generateReactivationTemplate({ pipelineId: '94103', stageIn: 'COTIZADO', daysInactive: 7 });

    expect(result.error).toBeNull();
    expect(result.draft.primary).toBeDefined();
    expect(result.draft.alternatives).toHaveLength(2);
    expect(result.draft.days_inactive).toBe(7);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'draft.reactivation' }));
  });
});

describe('templates pre-approved bypass approval', () => {
  it('all 5 reactivation templates exist with status="approved"', () => {
    const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(5);

    const expectedPipelines = new Set(['216977', '755062', '252999', '94103', '273944']);
    const seenPipelines = new Set();

    for (const file of files) {
      const tpl = JSON.parse(readFileSync(join(TEMPLATES_DIR, file), 'utf8'));
      expect(tpl.status).toBe('approved');
      expect(tpl.approved_by).toBeDefined();
      expect(tpl.approved_at).toBeDefined();
      expect(tpl.content).toContain('[NOMBRE]');
      expect(Array.isArray(tpl.params)).toBe(true);
      expect(tpl.params).toContain('NOMBRE');
      seenPipelines.add(tpl.pipeline_id);
    }

    for (const pid of expectedPipelines) {
      expect(seenPipelines.has(pid)).toBe(true);
    }
  });
});

describe('pickInsight', () => {
  it('returns null on empty or invalid input', () => {
    expect(pickInsight(null)).toBeNull();
    expect(pickInsight([])).toBeNull();
  });

  it('prefers critical/high fatigue signals over low ones', () => {
    const insights = [
      { severity: 'low',    metric: 'CTR',          observation: 'sin cambios' },
      { severity: 'high',   metric: 'fatiga_creativa', observation: 'frecuencia 4.2' },
      { severity: 'medium', metric: 'CPR',          observation: 'CPR subió 12%' },
    ];
    const picked = pickInsight(insights);
    expect(picked).not.toBeNull();
    expect(picked.severity).toBe('high');
    expect(picked.metric).toBe('fatiga_creativa');
  });

  it('falls back to first medium+ insight if no fatigue metric matches', () => {
    const insights = [
      { severity: 'low',    metric: 'irrelevante' },
      { severity: 'medium', metric: 'tasa_avance_COTIZADO_a_VISITA' },
    ];
    const picked = pickInsight(insights);
    expect(picked?.severity).toBe('medium');
  });
});
