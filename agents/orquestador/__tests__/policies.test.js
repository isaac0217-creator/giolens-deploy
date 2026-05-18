/**
 * GioLens — Agente Orquestador · __tests__/policies.test.js
 * Tests unitarios para constantes + función pura computeWinner() +
 * heurísticas (inferTargetsForInsight, isIrreversibleAction,
 * areMergeCompatible, exceedsHumanEscalationThreshold).
 *
 * Sin mocks: policies.js es puro. Estos tests son rápidos y deterministas.
 */

import { describe, it, expect } from 'vitest';
import {
  PRIORITIES,
  RISK_RANKING,
  CONFLICT_RULES,
  normalizePriority,
  riskOf,
  isIrreversibleAction,
  areMergeCompatible,
  exceedsHumanEscalationThreshold,
  computeWinner,
  inferTargetsForInsight,
} from '../policies.js';

describe('PRIORITIES / RISK_RANKING constants', () => {
  it('PRIORITIES has P1..P5 with monotonic SLA', () => {
    expect(PRIORITIES.P1.level).toBe(1);
    expect(PRIORITIES.P5.level).toBe(5);
    expect(PRIORITIES.P1.sla_minutes).toBeLessThan(PRIORITIES.P2.sla_minutes);
    expect(PRIORITIES.P2.sla_minutes).toBeLessThan(PRIORITIES.P3.sla_minutes);
    expect(PRIORITIES.P3.sla_minutes).toBeLessThan(PRIORITIES.P4.sla_minutes);
    expect(PRIORITIES.P4.sla_minutes).toBeLessThan(PRIORITIES.P5.sla_minutes);
  });

  it('RISK_RANKING follows analista < qa < creativo < optimizacion < desarrollador', () => {
    expect(RISK_RANKING.analista).toBeLessThan(RISK_RANKING.qa);
    expect(RISK_RANKING.qa).toBeLessThan(RISK_RANKING.creativo);
    expect(RISK_RANKING.creativo).toBeLessThan(RISK_RANKING.optimizacion);
    expect(RISK_RANKING.optimizacion).toBeLessThan(RISK_RANKING.desarrollador);
    expect(RISK_RANKING.orquestador).toBeGreaterThan(RISK_RANKING.desarrollador);
  });

  it('CONFLICT_RULES.ESCALATE_HUMAN_USD === 50', () => {
    expect(CONFLICT_RULES.ESCALATE_HUMAN_USD).toBe(50);
  });

  it('CONFLICT_RULES freezes nested arrays (immutable)', () => {
    expect(Object.isFrozen(CONFLICT_RULES)).toBe(true);
    expect(Object.isFrozen(CONFLICT_RULES.IRREVERSIBLE_ACTIONS)).toBe(true);
    expect(Object.isFrozen(CONFLICT_RULES.MERGE_COMPATIBLE_ACTIONS)).toBe(true);
  });
});

describe('normalizePriority', () => {
  it('accepts numeric 1..5', () => {
    expect(normalizePriority(1)).toBe(1);
    expect(normalizePriority(5)).toBe(5);
  });
  it('accepts "P1".."P5" strings', () => {
    expect(normalizePriority('P1')).toBe(1);
    expect(normalizePriority('p3')).toBe(3);
  });
  it('accepts label strings', () => {
    expect(normalizePriority('blocker_prod')).toBe(1);
    expect(normalizePriority('exploration')).toBe(5);
  });
  it('returns 5 (default exploración) on bogus input', () => {
    expect(normalizePriority(undefined)).toBe(5);
    expect(normalizePriority('P9')).toBe(5);
    expect(normalizePriority({})).toBe(5);
    expect(normalizePriority(0)).toBe(5);
  });
});

describe('riskOf', () => {
  it('returns RISK_RANKING values for known agents (case-insensitive)', () => {
    expect(riskOf('analista')).toBe(1);
    expect(riskOf('Optimizacion')).toBe(4);
    expect(riskOf('DESARROLLADOR')).toBe(5);
  });
  it('returns 99 for unknown', () => {
    expect(riskOf('rogue_agent')).toBe(99);
    expect(riskOf(null)).toBe(99);
  });
});

describe('isIrreversibleAction', () => {
  it('flags delete/deactivate/archive/etc', () => {
    expect(isIrreversibleAction('delete_campaign')).toBe(true);
    expect(isIrreversibleAction('deactivate_pixel')).toBe(true);
    expect(isIrreversibleAction('archive_adset')).toBe(true);
    expect(isIrreversibleAction('force_close_pipeline')).toBe(true);
    expect(isIrreversibleAction('permanent_pause_ad')).toBe(true);
    expect(isIrreversibleAction('drop_table_leads')).toBe(true);
  });
  it('does not flag reversible actions', () => {
    expect(isIrreversibleAction('apply_budget_change')).toBe(false);
    expect(isIrreversibleAction('pause_adset')).toBe(false);
    expect(isIrreversibleAction('snapshot_kpis')).toBe(false);
  });
  it('handles bad input', () => {
    expect(isIrreversibleAction(null)).toBe(false);
    expect(isIrreversibleAction('')).toBe(false);
    expect(isIrreversibleAction(123)).toBe(false);
  });
});

describe('areMergeCompatible', () => {
  it('returns true when both actions are in MERGE_COMPATIBLE_ACTIONS', () => {
    expect(areMergeCompatible('generate_creative_variant_A', 'generate_creative_variant_B')).toBe(true);
    expect(areMergeCompatible('snapshot_kpis_24h', 'snapshot_kpis_7d')).toBe(true);
  });
  it('returns false when only one is mergeable', () => {
    expect(areMergeCompatible('generate_creative_variant_A', 'delete_campaign')).toBe(false);
  });
  it('returns false on bad input', () => {
    expect(areMergeCompatible(null, 'x')).toBe(false);
    expect(areMergeCompatible('x', undefined)).toBe(false);
  });
});

describe('exceedsHumanEscalationThreshold', () => {
  it('returns true when |usd| > $50', () => {
    expect(exceedsHumanEscalationThreshold(75)).toBe(true);
    expect(exceedsHumanEscalationThreshold(-100)).toBe(true);
  });
  it('returns false at or below threshold', () => {
    expect(exceedsHumanEscalationThreshold(50)).toBe(false);
    expect(exceedsHumanEscalationThreshold(49.99)).toBe(false);
    expect(exceedsHumanEscalationThreshold(0)).toBe(false);
  });
  it('returns false on non-number', () => {
    expect(exceedsHumanEscalationThreshold('a lot')).toBe(false);
    expect(exceedsHumanEscalationThreshold(null)).toBe(false);
  });
});

describe('computeWinner', () => {
  it('returns reject_all on empty list', () => {
    const r = computeWinner([]);
    expect(r.decision).toBe('reject_all');
    expect(r.winner_proposal_id).toBeNull();
  });

  it('returns approve_one on single proposal', () => {
    const r = computeWinner([
      { agent: 'creativo', proposal_id: 'p1', action: 'generate_creative_variant' },
    ]);
    expect(r.decision).toBe('approve_one');
    expect(r.winner_proposal_id).toBe('p1');
    expect(r.blocked_proposals).toEqual([]);
  });

  it('escalates to human when any proposal is irreversible', () => {
    const r = computeWinner([
      { agent: 'creativo', proposal_id: 'p1', action: 'generate_creative_variant', priority: 3 },
      { agent: 'optimizacion', proposal_id: 'p2', action: 'delete_campaign', priority: 4 },
    ]);
    expect(r.decision).toBe('escalate_human');
    expect(r.winner_proposal_id).toBeNull();
    expect(r.blocked_proposals).toEqual(['p1', 'p2']);
    expect(r.rationale).toMatch(/irreversible/);
  });

  it('escalates to human when any proposal exceeds $50 USD impact', () => {
    const r = computeWinner([
      { agent: 'optimizacion', proposal_id: 'p1', action: 'apply_budget_change', priority: 2, estimated_delta_usd: 80 },
      { agent: 'creativo', proposal_id: 'p2', action: 'generate_creative_variant', priority: 3 },
    ]);
    expect(r.decision).toBe('escalate_human');
    expect(r.rationale).toMatch(/\$50/);
  });

  it('merges when all actions are merge-compatible', () => {
    const r = computeWinner([
      { agent: 'creativo', proposal_id: 'p1', action: 'generate_creative_variant_A', priority: 3 },
      { agent: 'creativo', proposal_id: 'p2', action: 'generate_creative_variant_B', priority: 3 },
    ]);
    expect(r.decision).toBe('merge');
    expect(r.winner_proposal_id).toBeNull();
    expect(r.blocked_proposals).toEqual([]);
  });

  it('picks lower priority number on conflict', () => {
    const r = computeWinner([
      { agent: 'creativo', proposal_id: 'p1', action: 'apply_budget_change', priority: 4 },
      { agent: 'optimizacion', proposal_id: 'p2', action: 'apply_budget_change', priority: 2 },
    ]);
    expect(r.decision).toBe('approve_one');
    expect(r.winner_proposal_id).toBe('p2');
    expect(r.blocked_proposals).toEqual(['p1']);
  });

  it('breaks priority ties by lower risk agent (analista wins over desarrollador)', () => {
    const r = computeWinner([
      { agent: 'desarrollador', proposal_id: 'p1', action: 'apply_code_patch', priority: 3 },
      { agent: 'analista', proposal_id: 'p2', action: 'flag_anomaly', priority: 3 },
    ]);
    expect(r.decision).toBe('approve_one');
    expect(r.winner_proposal_id).toBe('p2');
    expect(r.blocked_proposals).toEqual(['p1']);
  });

  it('irreversible+budget combo still escalates (irreversible check runs first)', () => {
    const r = computeWinner([
      { agent: 'optimizacion', proposal_id: 'p1', action: 'apply_budget_change', priority: 2, estimated_delta_usd: 200 },
      { agent: 'desarrollador', proposal_id: 'p2', action: 'delete_table', priority: 1 },
    ]);
    expect(r.decision).toBe('escalate_human');
  });
});

describe('inferTargetsForInsight', () => {
  it('routes fatiga creativa → creativo + optimizacion', () => {
    const t = inferTargetsForInsight({ type: 'creative_fatigue_detected' });
    expect(t).toEqual(expect.arrayContaining(['creativo', 'optimizacion']));
  });

  it('routes CPR/budget insights → optimizacion', () => {
    const t = inferTargetsForInsight({ type: 'cpr_spike_24h' });
    expect(t).toContain('optimizacion');
  });

  it('routes bugs/errors → desarrollador', () => {
    const t = inferTargetsForInsight({ type: 'bug_regression_webhook' });
    expect(t).toContain('desarrollador');
  });

  it('routes qa_/test_ prefixes → desarrollador + qa', () => {
    const t = inferTargetsForInsight({ type: 'qa_failed_assertion' });
    expect(t).toEqual(expect.arrayContaining(['desarrollador', 'qa']));
  });

  it('routes critical events → always includes analista', () => {
    const t = inferTargetsForInsight({ type: 'critical_alert_pipeline', payload: { severity: 'critical' } });
    expect(t).toContain('analista');
  });

  it('falls back to analista on unknown type', () => {
    const t = inferTargetsForInsight({ type: 'random_signal' });
    expect(t).toEqual(['analista']);
  });

  it('never includes orquestador', () => {
    const t = inferTargetsForInsight({ type: 'critical_alert' });
    expect(t).not.toContain('orquestador');
  });

  it('returns [] on malformed insight', () => {
    expect(inferTargetsForInsight(null)).toEqual([]);
    expect(inferTargetsForInsight({})).toEqual([]);
    expect(inferTargetsForInsight({ payload: {} })).toEqual([]);
  });
});
