/**
 * GioLens — Agente Orquestador · __tests__/orquestador.test.js
 * Rol: Tests Vitest para los 3 flujos del Orquestador. Mockea callClaude,
 *      bus, cost-tracker y approval para no hacer llamadas reales.
 *
 * Cobertura:
 *   - scheduleAgentRun publica task_scheduled con priority normalizada.
 *   - scheduleAgentRun rechaza target_agent inválido.
 *   - scheduleAgentRun preserva depends_on en el bus payload.
 *   - resolveConflict (atajo determinista, sin LLM): escalate_human cuando hay irreversibles.
 *   - resolveConflict (atajo): escalate_human cuando |delta_usd| > $50.
 *   - resolveConflict (atajo): merge cuando todas son merge-compatibles.
 *   - resolveConflict (con LLM): aprueba la de menor priority/risk en empate complejo.
 *   - resolveConflict: escalate_human dispara requestApproval.
 *   - shareContext con targetAgents='auto' infiere creativo+optimizacion para fatiga.
 *   - shareContext deduplica destinatarios y excluye source_agent + orquestador.
 *   - shareContext con targets explícitos publica un mensaje por destinatario.
 *   - shareContext devuelve no_valid_targets cuando no hay destinatarios válidos.
 *   - executeOrquestadorOnDemand despacha al task correcto.
 *   - executeOrquestadorOnDemand lanza con task desconocido.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  scheduleAgentRun,
  resolveConflict,
  shareContext,
} from '../graph.js';
import { executeOrquestadorOnDemand } from '../index.js';
import { VALID_TARGET_AGENTS, isValidTargetAgent } from '../tools.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────
function mockClaude(payload) {
  callClaude.mockResolvedValue({
    text: JSON.stringify(payload),
    usage: { input_tokens: 800, output_tokens: 300 },
    cost_usd: 0.034,
  });
}

// ─── Tests: scheduleAgentRun ───────────────────────────────────────────────
describe('scheduleAgentRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes task_scheduled with normalized priority and queued status', async () => {
    mockClaude({
      task: 'schedule_run',
      scheduled_id: 'sched-analista-1700000000000',
      target_agent: 'analista',
      priority: 4,
      estimated_start_at: '2026-05-18T10:00:00Z',
      justification: 'cron diario',
      status: 'queued',
    });

    const result = await scheduleAgentRun({
      targetAgent: 'analista',
      task: 'daily_run',
      params: { period: 'last_24h' },
      priority: 'P4',
      reason: 'cron diario 09:00',
    });

    expect(result.error).toBeNull();
    expect(result.schedule.target_agent).toBe('analista');
    expect(result.schedule.priority).toBe(4);
    expect(result.schedule.status).toBe('queued');

    expect(publish).toHaveBeenCalledTimes(1);
    const msg = publish.mock.calls[0][0];
    expect(msg.from_agent).toBe('orquestador');
    expect(msg.to_agent).toBe('analista');
    expect(msg.type).toBe('task_scheduled');
    expect(msg.payload.task).toBe('daily_run');
    expect(msg.payload.priority).toBe(4);
    expect(msg.payload.status).toBe('queued');
    expect(msg.requires_ack).toBe(true);

    expect(track).toHaveBeenCalledWith('orquestador', expect.any(Object), 'claude-opus-4-5');
  });

  it('rejects invalid target_agent', async () => {
    await expect(
      scheduleAgentRun({ targetAgent: 'inexistente', task: 'x', reason: 'r' }),
    ).rejects.toThrow(/targetAgent inválido/);
    expect(callClaude).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('preserves depends_on in bus payload', async () => {
    mockClaude({
      task: 'schedule_run',
      scheduled_id: 'sched-qa-1700000000001',
      target_agent: 'qa',
      priority: 3,
      estimated_start_at: '2026-05-18T10:15:00Z',
      justification: 'tras finalizar generate_fix',
      status: 'queued',
    });

    const result = await scheduleAgentRun({
      targetAgent: 'qa',
      task: 'run_regression_suite',
      priority: 3,
      dependsOn: ['sched-desarrollador-prev'],
      reason: 'validar fix antes de PR',
    });

    expect(result.error).toBeNull();
    expect(publish.mock.calls[0][0].payload.depends_on).toEqual(['sched-desarrollador-prev']);
    expect(publish.mock.calls[0][0].context_refs).toContain('sched-desarrollador-prev');
  });

  it('overrides bogus target_agent from model with caller input', async () => {
    mockClaude({
      task: 'schedule_run',
      scheduled_id: 'sched-fake-1',
      target_agent: 'rogue_agent', // modelo intenta inventar
      priority: 2,
      estimated_start_at: '2026-05-18T10:00:00Z',
      justification: 'x',
      status: 'queued',
    });

    const result = await scheduleAgentRun({
      targetAgent: 'creativo',
      task: 'generate_variants',
      priority: 'P2',
      reason: 'lanzamiento nuevo concepto',
    });

    expect(result.error).toBeNull();
    expect(result.schedule.target_agent).toBe('creativo'); // override
    expect(publish.mock.calls[0][0].to_agent).toBe('creativo');
  });

  it('returns parse error and does NOT publish when LLM emits garbage', async () => {
    callClaude.mockResolvedValue({
      text: 'no es json',
      usage: { input_tokens: 100, output_tokens: 10 },
    });

    const result = await scheduleAgentRun({
      targetAgent: 'analista',
      task: 'daily_run',
      reason: 'cron',
    });

    expect(result.error).toBe('parse_failed_or_invalid_shape');
    expect(result.schedule).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it('throws when task / reason missing', async () => {
    await expect(scheduleAgentRun({ targetAgent: 'analista' })).rejects.toThrow(/task requerido/);
    await expect(scheduleAgentRun({ targetAgent: 'analista', task: 'x' })).rejects.toThrow(/reason requerido/);
  });
});

// ─── Tests: resolveConflict ────────────────────────────────────────────────
describe('resolveConflict (deterministic shortcuts, no LLM)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('escalates to human when any proposal is irreversible (no LLM call)', async () => {
    const result = await resolveConflict({
      resourceId: 'campaign-789',
      resourceType: 'campaign',
      proposals: [
        { agent: 'creativo', proposal_id: 'p1', action: 'generate_creative_variant', priority: 3 },
        { agent: 'desarrollador', proposal_id: 'p2', action: 'delete_table_leads', priority: 1 },
      ],
    });

    expect(result.error).toBeNull();
    expect(result.resolution.decision).toBe('escalate_human');
    expect(result.resolution.blocked_proposals).toEqual(['p1', 'p2']);
    expect(callClaude).not.toHaveBeenCalled();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0][0].action).toBe('orquestador_escalation');
    expect(result.escalation.approved).toBe(true);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].type).toBe('conflict_resolved');
    expect(publish.mock.calls[0][0].payload.decision).toBe('escalate_human');
    expect(publish.mock.calls[0][0].requires_ack).toBe(true);
  });

  it('escalates to human when |delta_usd| exceeds $50 (no LLM call)', async () => {
    const result = await resolveConflict({
      resourceId: 'adset-321',
      resourceType: 'campaign',
      proposals: [
        { agent: 'optimizacion', proposal_id: 'a', action: 'apply_budget_change', priority: 2, estimated_delta_usd: 120 },
        { agent: 'optimizacion', proposal_id: 'b', action: 'apply_budget_change', priority: 3, estimated_delta_usd: 10 },
      ],
    });

    expect(result.resolution.decision).toBe('escalate_human');
    expect(callClaude).not.toHaveBeenCalled();
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('merges when all actions are merge-compatible (no LLM call)', async () => {
    const result = await resolveConflict({
      resourceId: 'creative-bucket-1',
      resourceType: 'creative',
      proposals: [
        { agent: 'creativo', proposal_id: 'm1', action: 'generate_creative_variant_v1', priority: 3 },
        { agent: 'creativo', proposal_id: 'm2', action: 'generate_creative_variant_v2', priority: 3 },
      ],
    });

    expect(result.resolution.decision).toBe('merge');
    expect(result.resolution.blocked_proposals).toEqual([]);
    expect(callClaude).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();

    expect(publish.mock.calls[0][0].payload.decision).toBe('merge');
  });

  it('returns reject_all on empty proposals (no LLM)', async () => {
    const result = await resolveConflict({
      resourceId: 'x',
      resourceType: 'pipeline',
      proposals: [],
    });
    expect(result.resolution.decision).toBe('reject_all');
    expect(callClaude).not.toHaveBeenCalled();
  });
});

describe('resolveConflict (LLM path for complex cases)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks the LLM when conflict is non-trivial and respects approve_one', async () => {
    mockClaude({
      task: 'resolve_conflict',
      resource_id: 'pipeline-94103',
      decision: 'approve_one',
      winner_proposal_id: 'opt-low-prio',
      rationale: 'optimizacion priority 2 < creativo priority 3',
      blocked_proposals: ['cre-1'],
    });

    const result = await resolveConflict({
      resourceId: 'pipeline-94103',
      resourceType: 'pipeline',
      proposals: [
        { agent: 'creativo', proposal_id: 'cre-1', action: 'pause_adset_temp', priority: 3, estimated_delta_usd: 5 },
        { agent: 'optimizacion', proposal_id: 'opt-low-prio', action: 'apply_budget_change', priority: 2, estimated_delta_usd: 20 },
      ],
    });

    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(result.error).toBeNull();
    expect(result.resolution.decision).toBe('approve_one');
    expect(result.resolution.winner_proposal_id).toBe('opt-low-prio');
    expect(publish.mock.calls[0][0].payload.decision).toBe('approve_one');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('falls back to deterministic result when LLM returns invalid JSON', async () => {
    callClaude.mockResolvedValue({
      text: 'totally broken',
      usage: { input_tokens: 200, output_tokens: 5 },
    });

    const result = await resolveConflict({
      resourceId: 'pipeline-x',
      resourceType: 'pipeline',
      proposals: [
        { agent: 'creativo', proposal_id: 'p1', action: 'pause_adset_temp', priority: 4, estimated_delta_usd: 5 },
        { agent: 'optimizacion', proposal_id: 'p2', action: 'apply_budget_change', priority: 2, estimated_delta_usd: 10 },
      ],
    });

    expect(result.error).toBe('parse_failed_or_invalid_shape');
    expect(result.resolution.decision).toBe('approve_one');
    expect(result.resolution.winner_proposal_id).toBe('p2'); // determinista
    expect(result.resolution.rationale).toMatch(/fallback determinista/);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('overrides LLM if computeWinner already said escalate_human', async () => {
    // Aquí computeWinner detecta delta>50 antes; el atajo evita el LLM
    // por completo. Verificamos que NO se llame al LLM.
    mockClaude({
      task: 'resolve_conflict',
      resource_id: 'x',
      decision: 'approve_one',
      winner_proposal_id: 'big',
      rationale: 'lo apruebo igual',
      blocked_proposals: ['small'],
    });

    const result = await resolveConflict({
      resourceId: 'pipeline-big',
      resourceType: 'pipeline',
      proposals: [
        { agent: 'optimizacion', proposal_id: 'big', action: 'apply_budget_change', priority: 2, estimated_delta_usd: 999 },
        { agent: 'creativo', proposal_id: 'small', action: 'pause_adset_temp', priority: 3, estimated_delta_usd: 1 },
      ],
    });

    expect(callClaude).not.toHaveBeenCalled();
    expect(result.resolution.decision).toBe('escalate_human');
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });
});

// ─── Tests: shareContext ───────────────────────────────────────────────────
describe('shareContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('infers creativo + optimizacion for fatiga creativa insights (auto)', async () => {
    const result = await shareContext({
      sourceAgent: 'analista',
      insight: { type: 'creative_fatigue_detected', payload: { ad_id: '123', score: 0.8 } },
      targetAgents: 'auto',
    });

    expect(result.error).toBeNull();
    expect(result.share.delivered_to).toEqual(expect.arrayContaining(['creativo', 'optimizacion']));
    expect(result.share.delivered_to).not.toContain('orquestador');
    expect(result.share.delivered_to).not.toContain('analista'); // source
    expect(publish.mock.calls.length).toBe(result.share.delivered_to.length);
    publish.mock.calls.forEach((call) => {
      expect(call[0].type).toBe('context_shared');
      expect(call[0].from_agent).toBe('orquestador');
    });
  });

  it('routes critical events to analista (auto)', async () => {
    const result = await shareContext({
      sourceAgent: 'qa',
      insight: { type: 'critical_pipeline_failure', payload: { severity: 'critical' } },
      targetAgents: 'auto',
    });
    expect(result.share.delivered_to).toContain('analista');
    expect(result.share.delivered_to).not.toContain('qa');
  });

  it('deduplicates + excludes source_agent and orquestador with explicit targets', async () => {
    const result = await shareContext({
      sourceAgent: 'analista',
      insight: { type: 'random_signal' },
      targetAgents: ['creativo', 'creativo', 'analista', 'orquestador', 'unknown_agent'],
    });

    expect(result.share.delivered_to).toEqual(['creativo']);
    // Skipped: analista (source), orquestador (banned), unknown_agent (invalid)
    expect(result.share.skipped.length).toBe(3);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('publishes one context_shared per delivered target with unique ctx ids', async () => {
    const result = await shareContext({
      sourceAgent: 'analista',
      insight: { type: 'cpr_spike_24h' },
      targetAgents: ['optimizacion'],
    });

    expect(result.share.context_msg_ids).toHaveLength(1);
    expect(result.share.context_msg_ids[0]).toMatch(/^ctx-optimizacion-/);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].payload.context_msg_id).toBe(result.share.context_msg_ids[0]);
  });

  it('returns no_valid_targets when nothing routes', async () => {
    const result = await shareContext({
      sourceAgent: 'creativo',
      insight: { type: 'creative_fatigue_detected' }, // auto → creativo + optimizacion
      targetAgents: ['creativo'], // explicit pero === source → skip
    });

    expect(result.error).toBe('no_valid_targets');
    expect(result.share.delivered_to).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('throws when sourceAgent or insight missing', async () => {
    await expect(shareContext({})).rejects.toThrow(/sourceAgent requerido/);
    await expect(shareContext({ sourceAgent: 'analista' })).rejects.toThrow(/insight con campo/);
    await expect(shareContext({ sourceAgent: 'analista', insight: { foo: 'bar' } })).rejects.toThrow(/insight con campo/);
  });
});

// ─── Tests: dispatcher executeOrquestadorOnDemand ──────────────────────────
describe('executeOrquestadorOnDemand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches schedule_run correctly', async () => {
    mockClaude({
      task: 'schedule_run',
      scheduled_id: 'sched-analista-x',
      target_agent: 'analista',
      priority: 4,
      estimated_start_at: '2026-05-18T10:00:00Z',
      justification: 'x',
      status: 'queued',
    });

    const result = await executeOrquestadorOnDemand({
      task: 'schedule_run',
      params: { targetAgent: 'analista', task: 'daily_run', reason: 'cron' },
    });

    expect(result.error).toBeNull();
    expect(result.schedule).toBeDefined();
  });

  it('dispatches resolve_conflict correctly (no LLM via shortcut)', async () => {
    const result = await executeOrquestadorOnDemand({
      task: 'resolve_conflict',
      params: {
        resourceId: 'pipe-1',
        resourceType: 'pipeline',
        proposals: [
          { agent: 'creativo', proposal_id: 'p1', action: 'generate_creative_variant_a', priority: 3 },
          { agent: 'creativo', proposal_id: 'p2', action: 'generate_creative_variant_b', priority: 3 },
        ],
      },
    });
    expect(result.error).toBeNull();
    expect(result.resolution.decision).toBe('merge');
  });

  it('dispatches share_context correctly', async () => {
    const result = await executeOrquestadorOnDemand({
      task: 'share_context',
      params: {
        sourceAgent: 'analista',
        insight: { type: 'bug_regression' },
        targetAgents: 'auto',
      },
    });
    expect(result.error).toBeNull();
    expect(result.share.delivered_to).toContain('desarrollador');
  });

  it('throws on unknown task', async () => {
    await expect(
      executeOrquestadorOnDemand({ task: 'launch_nuke', params: {} }),
    ).rejects.toThrow(/task desconocido/);
  });

  it('throws when task missing', async () => {
    await expect(executeOrquestadorOnDemand({})).rejects.toThrow(/task requerido/);
  });
});

// ─── Tests: helpers exportados de tools.js ─────────────────────────────────
describe('tools.js helpers', () => {
  it('VALID_TARGET_AGENTS exports the 5 ecosystem agents (without orquestador)', () => {
    expect(VALID_TARGET_AGENTS).toEqual([
      'analista', 'qa', 'creativo', 'optimizacion', 'desarrollador',
    ]);
  });

  it('isValidTargetAgent is case-insensitive and excludes orquestador', () => {
    expect(isValidTargetAgent('Analista')).toBe(true);
    expect(isValidTargetAgent('QA')).toBe(true);
    expect(isValidTargetAgent('orquestador')).toBe(false);
    expect(isValidTargetAgent('rogue')).toBe(false);
    expect(isValidTargetAgent(null)).toBe(false);
  });
});
