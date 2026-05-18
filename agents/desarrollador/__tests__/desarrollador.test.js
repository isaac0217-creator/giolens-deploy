/**
 * GioLens — Agente Desarrollador · __tests__/desarrollador.test.js
 * Rol: Tests Vitest para los 3 flujos del Desarrollador. Mockea callClaude,
 *      bus, cost-tracker y approval para no hacer llamadas reales.
 *
 * Cobertura:
 *   - analyzeQAFailure devuelve diagnosis con campos requeridos.
 *   - analyzeQAFailure marca requires_human=true en zonas sensibles.
 *   - analyzeQAFailure marca requires_human=true cuando severity='critical'.
 *   - generateFix publica draft.fix con status='draft' y requires_approval=true.
 *   - generateFix marca sensitive=true al tocar agents/_shared/.
 *   - createPullRequestStub publica draft.pull_request con pr_url='stub://...'.
 *   - createPullRequestStub trunca title si excede 72 chars.
 *   - isSensitivePath detecta correctamente las rutas peligrosas.
 *   - parse failure → error y NO publish/approval.
 *   - executeDesarrolladorOnDemand despacha al task correcto.
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
  track: vi.fn(() => ({ usd: 0.02, total: { usd: 0.02, calls: 1, input_tokens: 0, output_tokens: 0 } })),
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
  analyzeQAFailure,
  generateFix,
  createPullRequestStub,
} from '../graph.js';
import { executeDesarrolladorOnDemand } from '../index.js';
import { isSensitivePath, SENSITIVE_PATHS, drainProposedPatches } from '../tools.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────
function mockClaude(payload) {
  callClaude.mockResolvedValue({
    text: JSON.stringify(payload),
    usage: { input_tokens: 1200, output_tokens: 600 },
    cost_usd: 0.063,
  });
}

const QA_ISSUE_REGEX = {
  test_name: 'analista.test.js > pickInsight > matches fatigue metric',
  expected: 'fatiga_creativa con severity=high seleccionada',
  actual: 'devuelve null (no match)',
  error_trace: "TypeError: Cannot read properties of null (reading 'severity')\n  at pickInsight (graph.js:53)",
  severity: 'medium',
};

const QA_ISSUE_CRITICAL = {
  test_name: 'webhook.test.js > processIncoming > replies to lead',
  expected: 'reply enviado a Wapify',
  actual: '500 Internal Server Error',
  error_trace: 'Error: ANTHROPIC_API_KEY missing',
  severity: 'critical',
};

// ─── Tests: analyzeQAFailure ───────────────────────────────────────────────
describe('analyzeQAFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drainProposedPatches();
  });

  it('returns diagnosis with all required fields and emits qa_failure_diagnosis event', async () => {
    mockClaude({
      task: 'analyze_qa_failure',
      diagnosis: 'pickInsight no maneja insight con metric=null antes del .toLowerCase().',
      root_cause: 'null_dereference',
      suggested_files: ['agents/analista/graph.js'],
      suggested_patches: [
        {
          file: 'agents/analista/graph.js',
          old: 'i.metric.toLowerCase()',
          new: 'String(i.metric || "").toLowerCase()',
        },
      ],
      confidence: 0.85,
      requires_human: false,
    });

    const result = await analyzeQAFailure({ qaIssue: QA_ISSUE_REGEX });

    expect(result.error).toBeNull();
    expect(result.diagnosis).toBeDefined();
    expect(result.diagnosis.root_cause).toBe('null_dereference');
    expect(result.diagnosis.suggested_patches).toHaveLength(1);
    expect(result.diagnosis.confidence).toBe(0.85);
    // No sensible, no crítica, confianza alta → no requiere human
    expect(result.diagnosis.requires_human).toBe(false);

    // Publicado al bus como qa_failure_diagnosis
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      from_agent: 'desarrollador',
      to_agent: 'qa',
      type: 'qa_failure_diagnosis',
    });

    // Cost tracked, model debe ser opus
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0][0]).toBe('desarrollador');
    expect(track.mock.calls[0][2]).toBe('claude-opus-4-5');
  });

  it('overrides requires_human=true when suggested_files include sensitive paths', async () => {
    mockClaude({
      task: 'analyze_qa_failure',
      diagnosis: 'callClaude no exporta default y rompe import en webhook.',
      root_cause: 'api_contract',
      suggested_files: ['api/webhook.js', 'agents/_shared/anthropic.js'],
      suggested_patches: [],
      confidence: 0.9,
      requires_human: false, // El modelo dice false, pero graph debe forzar true
    });

    const result = await analyzeQAFailure({ qaIssue: QA_ISSUE_REGEX });

    expect(result.error).toBeNull();
    expect(result.diagnosis.requires_human).toBe(true); // override forzado
  });

  it('overrides requires_human=true when severity is critical', async () => {
    mockClaude({
      task: 'analyze_qa_failure',
      diagnosis: 'Variable de entorno ANTHROPIC_API_KEY ausente en runtime.',
      root_cause: 'env_missing',
      suggested_files: ['vercel.json'], // también sensible
      suggested_patches: [],
      confidence: 0.95,
      requires_human: false,
    });

    const result = await analyzeQAFailure({ qaIssue: QA_ISSUE_CRITICAL });

    expect(result.error).toBeNull();
    expect(result.diagnosis.requires_human).toBe(true);
  });

  it('returns error on parse failure and does NOT publish or request approval', async () => {
    callClaude.mockResolvedValue({
      text: 'no soy json válido',
      usage: { input_tokens: 100, output_tokens: 10 },
    });

    const result = await analyzeQAFailure({ qaIssue: QA_ISSUE_REGEX });

    expect(result.error).toBe('parse_failed_or_invalid_shape');
    expect(result.diagnosis).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('normalizes invalid root_cause to "other"', async () => {
    mockClaude({
      task: 'analyze_qa_failure',
      diagnosis: 'algo raro',
      root_cause: 'cosmic_ray', // no en VALID_ROOT_CAUSES
      suggested_files: [],
      suggested_patches: [],
      confidence: 0.7,
      requires_human: false,
    });

    const result = await analyzeQAFailure({ qaIssue: QA_ISSUE_REGEX });
    expect(result.diagnosis.root_cause).toBe('other');
  });

  it('throws when qaIssue is missing test_name', async () => {
    await expect(analyzeQAFailure({ qaIssue: { severity: 'low' } })).rejects.toThrow(/test_name requerido/);
  });
});

// ─── Tests: generateFix ────────────────────────────────────────────────────
describe('generateFix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drainProposedPatches();
  });

  it('publishes draft.fix with status=draft, requires_approval=true and tests_to_add', async () => {
    mockClaude({
      task: 'generate_fix',
      file_path: 'agents/analista/graph.js',
      patch: {
        old: 'i.metric.toLowerCase()',
        new: 'String(i.metric || "").toLowerCase()',
      },
      tests_to_add: [
        { name: 'pickInsight handles null metric', rationale: 'cubrir regresión null_dereference' },
      ],
      rollback_plan: 'Revertir patch y correr suite analista; si pasa, mantener original.',
      status: 'draft',
      requires_approval: true,
    });

    const result = await generateFix({
      filePath: 'agents/analista/graph.js',
      currentContent: '// stub current content',
      diagnosis: 'pickInsight no maneja insight con metric=null',
      rootCause: 'null_dereference',
    });

    expect(result.error).toBeNull();
    expect(result.draft.status).toBe('draft');
    expect(result.draft.requires_approval).toBe(true);
    expect(result.draft.tests_to_add).toHaveLength(1);
    expect(result.draft.sensitive).toBe(false); // agents/analista no es sensible

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'draft.fix',
      from_agent: 'desarrollador',
    }));
    expect(publish.mock.calls[0][0].payload.status).toBe('draft');

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0][0].action).toBe('apply_code_patch');
    expect(result.approval.approved).toBe(true);
  });

  it('marks sensitive=true when fix touches agents/_shared/', async () => {
    mockClaude({
      task: 'generate_fix',
      file_path: 'agents/_shared/anthropic.js',
      patch: { old: 'const X = 1;', new: 'const X = 2;' },
      tests_to_add: [{ name: 'X is 2', rationale: 'cover the change' }],
      rollback_plan: 'revert',
      status: 'draft',
      requires_approval: true,
    });

    const result = await generateFix({
      filePath: 'agents/_shared/anthropic.js',
      currentContent: 'const X = 1;',
      diagnosis: 'X debe ser 2',
      rootCause: 'other',
    });

    expect(result.error).toBeNull();
    expect(result.draft.sensitive).toBe(true);
    expect(requestApproval.mock.calls[0][0].evidence.sensitive).toBe(true);
  });

  it('returns error on missing patch and does NOT publish', async () => {
    mockClaude({
      task: 'generate_fix',
      file_path: 'agents/analista/graph.js',
      // patch ausente
      tests_to_add: [],
      status: 'draft',
      requires_approval: true,
    });

    const result = await generateFix({
      filePath: 'agents/analista/graph.js',
      diagnosis: 'x',
      rootCause: 'other',
    });

    expect(result.error).toBe('parse_failed_or_invalid_shape');
    expect(result.draft).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it('throws when filePath / diagnosis / rootCause missing', async () => {
    await expect(generateFix({})).rejects.toThrow(/filePath requerido/);
    await expect(generateFix({ filePath: 'a.js' })).rejects.toThrow(/diagnosis requerido/);
    await expect(generateFix({ filePath: 'a.js', diagnosis: 'd' })).rejects.toThrow(/rootCause requerido/);
  });
});

// ─── Tests: createPullRequestStub ──────────────────────────────────────────
describe('createPullRequestStub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drainProposedPatches();
  });

  it('publishes draft.pull_request with pr_url starting with stub:// and default reviewer', async () => {
    mockClaude({
      task: 'create_pull_request',
      pr_url: 'stub://giocore/pulls/draft-123',
      title: 'fix(analista): handle null metric in pickInsight',
      body_markdown: '## Resumen\n...\n## Causa raíz\n...\n## Cambios\n...\n## Cómo probar\n...\n## Rollback\n...\n## Riesgo\nbajo',
      files_changed: ['agents/analista/graph.js', 'agents/analista/__tests__/analista.test.js'],
      status: 'open',
      reviewers: [],
    });

    const result = await createPullRequestStub({
      branchName: 'fix/analista-null-metric',
      baseBranch: 'main',
      fixPayload: { task: 'generate_fix', file_path: 'agents/analista/graph.js' },
      qaIssueRef: 'qa-issue-001',
    });

    expect(result.error).toBeNull();
    expect(result.draft.pr_url.startsWith('stub://')).toBe(true);
    expect(result.draft.status).toBe('open');
    expect(result.draft.reviewers).toEqual(['isaac']); // default forzado
    expect(result.draft.base_branch).toBe('main');
    expect(result.draft.branch_name).toBe('fix/analista-null-metric');
    expect(result.draft.qa_issue_ref).toBe('qa-issue-001');
    expect(result.draft.sensitive).toBe(false);

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'draft.pull_request',
      from_agent: 'desarrollador',
    }));
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0][0].action).toBe('create_pull_request_stub');
  });

  it('forces stub:// prefix if the model returns a real URL', async () => {
    mockClaude({
      task: 'create_pull_request',
      pr_url: 'https://github.com/giolens/core/pulls/42', // intento del modelo
      title: 'fix(core): something',
      body_markdown: '## Resumen\nx\n## Causa raíz\nx\n## Cambios\nx\n## Cómo probar\nx\n## Rollback\nx\n## Riesgo\nx',
      files_changed: ['agents/analista/graph.js'],
      status: 'open',
    });

    const result = await createPullRequestStub({
      branchName: 'fix/x',
      fixPayload: { task: 'generate_fix' },
    });

    expect(result.error).toBeNull();
    expect(result.draft.pr_url.startsWith('stub://')).toBe(true);
    expect(result.draft.pr_url).not.toContain('github.com');
  });

  it('truncates title if it exceeds 72 chars', async () => {
    const longTitle = 'fix(analista): ' + 'x'.repeat(120);
    mockClaude({
      task: 'create_pull_request',
      pr_url: 'stub://giocore/pulls/draft-1',
      title: longTitle,
      body_markdown: '## Resumen\nx\n## Causa raíz\nx\n## Cambios\nx\n## Cómo probar\nx\n## Rollback\nx\n## Riesgo\nx',
      files_changed: ['agents/analista/graph.js'],
      status: 'open',
    });

    const result = await createPullRequestStub({
      branchName: 'fix/long-title',
      fixPayload: { task: 'generate_fix' },
    });

    expect(result.error).toBeNull();
    expect(result.draft.title.length).toBeLessThanOrEqual(72);
    expect(result.draft.title.endsWith('...')).toBe(true);
  });

  it('marks sensitive=true when files_changed touch agents/_shared/', async () => {
    mockClaude({
      task: 'create_pull_request',
      pr_url: 'stub://giocore/pulls/draft-2',
      title: 'fix(_shared): bump cache_control threshold',
      body_markdown: '## Resumen\nx\n## Causa raíz\nx\n## Cambios\nx\n## Cómo probar\nx\n## Rollback\nx\n## Riesgo\nalto',
      files_changed: ['agents/_shared/anthropic.js'],
      status: 'open',
    });

    const result = await createPullRequestStub({
      branchName: 'fix/shared-cache',
      fixPayload: { task: 'generate_fix' },
    });

    expect(result.error).toBeNull();
    expect(result.draft.sensitive).toBe(true);
    expect(requestApproval.mock.calls[0][0].evidence.sensitive).toBe(true);
  });
});

// ─── Tests: isSensitivePath ────────────────────────────────────────────────
describe('isSensitivePath', () => {
  it('detects all SENSITIVE_PATHS entries', () => {
    expect(isSensitivePath('agents/_shared/bus.js')).toBe(true);
    expect(isSensitivePath('api/webhook.js')).toBe(true);
    expect(isSensitivePath('.env')).toBe(true);
    expect(isSensitivePath('.env.local')).toBe(true);
    expect(isSensitivePath('package.json')).toBe(true);
    expect(isSensitivePath('vercel.json')).toBe(true);
  });

  it('does not flag normal agent files', () => {
    expect(isSensitivePath('agents/analista/graph.js')).toBe(false);
    expect(isSensitivePath('agents/creativo/prompt.js')).toBe(false);
    expect(isSensitivePath('dashboard/index.html')).toBe(false);
  });

  it('handles bad input safely', () => {
    expect(isSensitivePath(null)).toBe(false);
    expect(isSensitivePath('')).toBe(false);
    expect(isSensitivePath(123)).toBe(false);
  });

  it('exports SENSITIVE_PATHS as a non-empty list', () => {
    expect(Array.isArray(SENSITIVE_PATHS)).toBe(true);
    expect(SENSITIVE_PATHS.length).toBeGreaterThanOrEqual(5);
  });
});

// ─── Tests: dispatcher executeDesarrolladorOnDemand ────────────────────────
describe('executeDesarrolladorOnDemand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drainProposedPatches();
  });

  it('dispatches analyze_qa_failure correctly', async () => {
    mockClaude({
      task: 'analyze_qa_failure',
      diagnosis: 'x',
      root_cause: 'other',
      suggested_files: [],
      suggested_patches: [],
      confidence: 0.7,
      requires_human: false,
    });

    const result = await executeDesarrolladorOnDemand({
      task: 'analyze_qa_failure',
      params: { qaIssue: QA_ISSUE_REGEX },
    });

    expect(result.error).toBeNull();
    expect(result.diagnosis).toBeDefined();
  });

  it('throws on unknown task', async () => {
    await expect(
      executeDesarrolladorOnDemand({ task: 'launch_nuke', params: {} }),
    ).rejects.toThrow(/task desconocido/);
  });

  it('throws when task missing', async () => {
    await expect(executeDesarrolladorOnDemand({})).rejects.toThrow(/task requerido/);
  });
});
