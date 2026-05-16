/**
 * GioLens — Agente Optimizacion · __tests__/optimizacion.test.js
 * Tests Vitest. Mocks completos de Anthropic, bus, cost-tracker, tools y
 * approval gate. NO realiza I/O ni llama a APIs externas.
 *
 * Cobertura:
 *   - analyzeAndPropose returns proposals with estimated_delta_usd
 *   - guards block irreversible without rollback registered
 *   - validateProposal rejects budget delta >100%
 *   - executeApprovedProposal calls approval first
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (deben declararse antes de los imports del SUT) ─────────────────
vi.mock('../../_shared/anthropic.js', () => ({
  callClaude: vi.fn(),
}));

vi.mock('../../_shared/bus.js', () => ({
  publish: vi.fn(),
}));

vi.mock('../../_shared/cost-tracker.js', () => ({
  track: vi.fn(),
}));

vi.mock('../../_shared/approval.js', () => ({
  requestApproval: vi.fn(),
}));

vi.mock('../../_shared/rollback.js', () => {
  const _registered = new Set();
  return {
    register: vi.fn((kind) => _registered.add(kind)),
    has: vi.fn((kind) => _registered.has(kind)),
    executeRollback: vi.fn().mockResolvedValue({ ok: true }),
    _registered,
  };
});

vi.mock('../../_shared/tools/read-kpis.js', () => ({
  default: vi.fn(),
}));
vi.mock('../../_shared/tools/read-pipeline.js', () => ({
  default: vi.fn(),
}));
vi.mock('../../_shared/tools/propose-budget-change.js', () => ({
  default: {
    handler: vi.fn().mockResolvedValue({ ok: true, decision_id: 'stub-1' }),
  },
  handler: vi.fn().mockResolvedValue({ ok: true, decision_id: 'stub-1' }),
}));

// Importes tras los mocks
import { callClaude } from '../../_shared/anthropic.js';
import { publish } from '../../_shared/bus.js';
import { requestApproval } from '../../_shared/approval.js';
import * as rollbackMod from '../../_shared/rollback.js';
import readKpis from '../../_shared/tools/read-kpis.js';
import readPipeline from '../../_shared/tools/read-pipeline.js';

import { analyzeAndPropose, executeApprovedProposal } from '../graph.js';
import { validateProposal, isIrreversible, checkDeltaUsd } from '../guards.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────
const PIPELINES = ['216977', '755062', '252999'];

function makeProposal(overrides = {}) {
  return {
    priority: 'high',
    target: 'budget',
    pipeline_id: '216977',
    current_state: 'CPR $13.40 vs baseline $8.64 (last_24h)',
    proposed_change: 'Bajar daily_budget de $20 a $15 USD en adset_id=123',
    expected_impact: 'CPR retoma $9 en 48h',
    evidence: {
      metric: 'CPR',
      current_value: 20,
      proposed_value: 15,
      baseline_value: 20,
      delta_pct: -25,
      source: 'meta_ads',
      adset_id: '123',
    },
    requires_approval: false,
    estimated_delta_usd: 5,
    ...overrides,
  };
}

function mockClaudeWithProposals(proposals) {
  callClaude.mockResolvedValue({
    text: JSON.stringify({ proposals }),
    usage: { input_tokens: 2000, output_tokens: 800 },
    cost_usd: 0.045,
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────
describe('analyzeAndPropose', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Por defecto: kinds de rollback YA estan registrados (caso real al importar
    // rollback-handlers.js). Los tests que verifiquen bloqueo los limpiaran.
    rollbackMod._registered.clear();
    rollbackMod._registered.add('budget_changed');
    rollbackMod._registered.add('adset_paused');

    readKpis.mockResolvedValue({ spend: 100, leads: 12, cpr: 8.33 });
    readPipeline.mockResolvedValue({ stages: { NUEVO: 5 }, stuck_leads: 2 });
  });

  it('returns proposals with estimated_delta_usd', async () => {
    mockClaudeWithProposals([makeProposal()]);

    const result = await analyzeAndPropose({ pipelineIds: PIPELINES, period: 'last_24h' });

    expect(result).toHaveProperty('proposals');
    expect(result).toHaveProperty('validated');
    expect(result).toHaveProperty('blocked');
    expect(Array.isArray(result.proposals)).toBe(true);
    expect(result.proposals).toHaveLength(1);
    expect(typeof result.proposals[0].estimated_delta_usd).toBe('number');
    expect(result.proposals[0].estimated_delta_usd).toBe(5);

    expect(result.validated).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);

    // tools llamadas una vez por pipeline
    expect(readKpis).toHaveBeenCalledTimes(PIPELINES.length);
    expect(readPipeline).toHaveBeenCalledTimes(PIPELINES.length);
    expect(callClaude).toHaveBeenCalledTimes(1);

    // publish llamado por cada proposal validada (1) — el alert agregado puede sumar otro
    expect(publish).toHaveBeenCalled();
    const types = publish.mock.calls.map((c) => c[0].type);
    expect(types).toContain('budget_proposal');
  });

  it('blocks irreversible action when rollback kind not registered', async () => {
    // Quitar budget_changed del registry → isIrreversible debe bloquear
    rollbackMod._registered.delete('budget_changed');

    mockClaudeWithProposals([makeProposal()]);

    const result = await analyzeAndPropose({ pipelineIds: PIPELINES, period: 'last_24h' });

    expect(result.validated).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toMatch(/irreversible|rollback/i);
  });
});

describe('guards.validateProposal', () => {
  beforeEach(() => {
    rollbackMod._registered.clear();
    rollbackMod._registered.add('budget_changed');
    rollbackMod._registered.add('adset_paused');
  });

  it('rejects budget delta >100% in a single operation', async () => {
    const bad = makeProposal({
      evidence: {
        metric: 'CPR',
        current_value: 10,        // current daily budget
        proposed_value: 25,       // 150% increase -> debe rechazar
        baseline_value: 10,
        delta_pct: 150,
        source: 'meta_ads',
        adset_id: '123',
      },
      estimated_delta_usd: 15,
    });

    const v = validateProposal(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/excede max 100%/i);
  });

  it('rejects proposal where requires_approval=false but delta > $50', async () => {
    const inconsistent = makeProposal({
      requires_approval: false,
      estimated_delta_usd: 200,   // > threshold $50
      evidence: {
        metric: 'CPR',
        current_value: 20,
        proposed_value: 30,       // 50% increase, ok
        baseline_value: 20,
        delta_pct: 50,
        source: 'meta_ads',
        adset_id: '123',
      },
    });
    const v = validateProposal(inconsistent);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/threshold/i);
  });

  it('accepts valid budget proposal under thresholds', () => {
    const v = validateProposal(makeProposal());
    expect(v.ok).toBe(true);
    expect(v.errors).toHaveLength(0);
  });

  it('checkDeltaUsd flags amounts over $50 as requiring approval', () => {
    expect(checkDeltaUsd(49).requires_approval).toBe(false);
    expect(checkDeltaUsd(50).requires_approval).toBe(false); // strict >
    expect(checkDeltaUsd(51).requires_approval).toBe(true);
    expect(checkDeltaUsd(-200).requires_approval).toBe(true);
  });

  it('isIrreversible blocks apply_budget_change without registered handler', () => {
    rollbackMod._registered.clear(); // sin budget_changed
    const r = isIrreversible('apply_budget_change');
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/rollback/i);
  });
});

describe('executeApprovedProposal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rollbackMod._registered.clear();
    rollbackMod._registered.add('budget_changed');
    rollbackMod._registered.add('adset_paused');
  });

  it('calls approval first when delta > $50 and refuses if not approved', async () => {
    requestApproval.mockResolvedValue({
      approved: false,
      by: 'human',
      at: new Date().toISOString(),
      decision_id: 'p-1',
    });

    const proposal = makeProposal({
      estimated_delta_usd: 200,   // requiere approval
      requires_approval: true,
      evidence: {
        metric: 'CPR',
        current_value: 50,
        proposed_value: 60,       // 20% increase, valido
        baseline_value: 50,
        delta_pct: 20,
        source: 'meta_ads',
        adset_id: '123',
      },
    });

    const r = await executeApprovedProposal({
      proposalId: 'p-1',
      proposal,
      // sin approval -> debe llamar requestApproval
    });

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0][0]).toMatchObject({
      decision_id: 'p-1',
      agent: 'optimizacion',
      action: 'apply_budget_change',
      amount_usd: 200,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/approval/i);
  });

  it('executes when approval granted, emits optimization_executed', async () => {
    requestApproval.mockResolvedValue({
      approved: true,
      by: 'human',
      at: new Date().toISOString(),
      decision_id: 'p-2',
    });

    const proposal = makeProposal({
      estimated_delta_usd: 100,
      requires_approval: true,
      evidence: {
        metric: 'CPR',
        current_value: 50,
        proposed_value: 60,
        baseline_value: 50,
        delta_pct: 20,
        source: 'meta_ads',
        adset_id: '123',
      },
    });

    const r = await executeApprovedProposal({ proposalId: 'p-2', proposal });

    expect(r.ok).toBe(true);
    expect(r.executed).toMatchObject({ ok: true, rollback_kind: 'budget_changed' });

    // bus recibe optimization_executed
    const types = publish.mock.calls.map((c) => c[0].type);
    expect(types).toContain('optimization_executed');
  });

  it('skips approval gate when delta <= $50 and executes directly', async () => {
    const proposal = makeProposal({
      estimated_delta_usd: 5,
      requires_approval: false,
    });

    const r = await executeApprovedProposal({ proposalId: 'p-3', proposal });

    expect(requestApproval).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.approval?.by).toBe('auto-below-threshold');
  });
});
