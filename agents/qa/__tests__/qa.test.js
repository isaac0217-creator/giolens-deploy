/**
 * GioLens — Agente QA · __tests__/qa.test.js
 * Rol: Tests Vitest para runQA + regression. Mockea callClaude, bus,
 *      cost-tracker, harness y runners para no hacer I/O ni llamadas reales.
 *
 * Nota: usa vi.mock() con paths exactos. Si los módulos shared aún no
 * exponen los nombres exactos (callClaude, trackCost), los mocks atrapan
 * la resolución y los tests siguen siendo deterministas.
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

// Mockear harness y runners para no ejecutar evals reales
vi.mock('../../../evals/harness.js', () => ({
  runEval: vi.fn(),
  loadGolden: vi.fn(),
}));

vi.mock('../../../evals/runners/motor-runner.js', () => ({
  getMotorAdapter: vi.fn(() => async () => ({ content: [] })),
}));

vi.mock('../../../evals/runners/agente-runner.js', () => ({
  getAnalistaAdapter: vi.fn(() => async () => ({ insights: [] })),
}));

// Mockear regression para test puntual
vi.mock('../runners/regression.js', () => ({
  compareSnapshot: vi.fn(),
  readSnapshot: vi.fn(),
  saveSnapshot: vi.fn(),
  deepEqual: vi.fn(),
}));

// Importes después de los mocks
import { callClaude } from '../../_shared/anthropic.js';
import { publish } from '../../_shared/bus.js';
import { trackCost } from '../../_shared/cost-tracker.js';
import { runEval } from '../../../evals/harness.js';
import { compareSnapshot } from '../runners/regression.js';
import { runQA } from '../graph.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────
const ONE_TARGET = [{ id: '216977', kind: 'motor', suite: 'motor-justin-holbrook' }];

function mockRunEvalAllPass(total = 3) {
  runEval.mockResolvedValue({
    motor: 'justin-holbrook',
    total,
    passed: total,
    failed: 0,
    details: Array.from({ length: total }, (_, i) => ({
      caso: `jh-0${i + 1}`,
      description: `caso ${i + 1}`,
      pass: true,
      expected: { tool_should_be_called: 'send_message' },
      actual: { content: [{ type: 'tool_use', name: 'send_message', input: { text: 'ok' } }] },
      reason: null,
    })),
  });
}

function mockRunEvalWithBlocker() {
  runEval.mockResolvedValue({
    motor: 'justin-holbrook',
    total: 2,
    passed: 1,
    failed: 1,
    details: [
      {
        caso: 'jh-01',
        description: 'ok',
        pass: true,
        expected: { tool_should_be_called: 'send_message' },
        actual: { content: [{ type: 'tool_use', name: 'send_message', input: { text: 'ok' } }] },
        reason: null,
      },
      {
        caso: 'jh-02',
        description: 'crash',
        pass: false,
        expected: { tool_should_be_called: 'send_message' },
        actual: null,
        reason: 'runtime error: boom',
      },
    ],
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────
describe('runQA', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callClaude.mockResolvedValue({
      text: 'Revisar el prompt del motor para incluir el precio mínimo.',
      usage: { input_tokens: 200, output_tokens: 30 },
      cost_usd: 0.001,
    });
  });

  it('runQA returns summary with totals', async () => {
    mockRunEvalAllPass(3);

    const result = await runQA({ targets: ONE_TARGET, mode: 'evals' });

    expect(result).toHaveProperty('summary');
    expect(result.summary).toMatchObject({
      total: 3,
      passed: 3,
      failed: 0,
      blockers: 0,
    });
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(typeof result.cost_usd).toBe('number');
    expect(typeof result.latency_ms).toBe('number');

    // publish llamado con type qa_report
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      type: 'qa_report',
      from: 'qa',
    });
    expect(trackCost).toHaveBeenCalledTimes(1);
  });

  it('runQA blocks promotion if blocker found', async () => {
    mockRunEvalWithBlocker();

    const result = await runQA({ targets: ONE_TARGET, mode: 'evals' });

    expect(result.summary.failed).toBe(1);
    expect(result.summary.blockers).toBeGreaterThanOrEqual(1);

    const blockerFinding = result.findings.find((f) => f.blocker === true);
    expect(blockerFinding).toBeDefined();
    expect(blockerFinding.severity).toBe('blocker');
    expect(blockerFinding.error_trace).toContain('runtime error');

    // Se pidió fix suggestion vía callClaude (severity blocker)
    expect(callClaude).toHaveBeenCalled();
    expect(blockerFinding.suggested_fix).toBeTruthy();

    // El bus reporta severity blocker
    expect(publish.mock.calls[0][0].severity).toBe('blocker');
  });

  it('regression detects snapshot drift', async () => {
    // Todos los casos del harness pasan
    mockRunEvalAllPass(2);

    // Pero el segundo caso tiene drift vs snapshot
    compareSnapshot.mockImplementation(async (motor, caseId) => {
      if (caseId === 'jh-02') {
        return {
          drift: true,
          changedKeys: ['content'],
          prev: { content: [{ type: 'tool_use', name: 'send_message', input: { text: 'viejo' } }] },
          curr: { content: [{ type: 'tool_use', name: 'send_message', input: { text: 'ok' } }] },
        };
      }
      return { drift: false };
    });

    const result = await runQA({ targets: ONE_TARGET, mode: 'full' });

    const driftFinding = result.findings.find((f) =>
      f.test_name.includes('::regression'),
    );
    expect(driftFinding).toBeDefined();
    expect(driftFinding.severity).toBe('medium');
    expect(driftFinding.suggested_fix).toMatch(/drift/i);

    // compareSnapshot llamado una vez por caso (modo full)
    expect(compareSnapshot).toHaveBeenCalledTimes(2);
  });
});
