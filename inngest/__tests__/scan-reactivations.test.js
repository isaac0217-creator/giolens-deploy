/**
 * GioLens — inngest/functions/scan-reactivations.js · tests del wiring C.2.3
 *
 * Cubre:
 *   - handler stub mode (sin WAPIFY_TOKEN) → 0 candidatos, 0 blockers.
 *   - candidato en pipeline permitido → Creativo invocado, lead.silence_detected
 *     emitido con script_preview poblado.
 *   - REGLA INVIOLABLE: candidato en 252999 (SPY) / 273944 (GioVision) →
 *     blocker_violation, NO emite silence_detected.
 *   - cap MAX_CANDIDATES_PER_RUN.
 *
 * El agente Creativo se mockea: el wiring no debe depender de Anthropic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EVENTS } from '../events.js';

const creativoMock = vi.fn();
vi.mock('../../agents/creativo/index.js', () => ({
  executeCreativoOnDemand: (...args) => creativoMock(...args),
}));

const { default: scanReactivations } = await import('../functions/scan-reactivations.js');

function makeStep(overrides = {}) {
  const ids = [];
  const events = [];
  return {
    ids,
    events,
    run: async (id, fn) => {
      ids.push(id);
      for (const key of Object.keys(overrides)) {
        if (id === key || id.startsWith(`${key}-`)) return overrides[key];
      }
      return fn();
    },
    sendEvent: async (id, ev) => { events.push({ id, ev }); return { ids: [] }; },
    sleep: async () => {},
  };
}

/** override de scan: candidatos por pipeline (resto stub vacío). */
function scanOverrides(byPipeline) {
  const o = {};
  for (const pid of ['216977', '755062', '252999', '94103', '273944']) {
    o[`scan-pipeline-${pid}`] = {
      pipeline_id: pid,
      stub_mode: false,
      candidates: byPipeline[pid] || [],
    };
  }
  return o;
}

const candidate = (contact_id) => ({
  contact_id,
  stage_name: 'INT2 · CATÁLOGO',
  silence_ms: 6 * 60 * 1000,
  last_interaction: Date.now() - 6 * 60 * 1000,
  last_sent: Date.now() - 5 * 60 * 1000,
});

beforeEach(() => {
  creativoMock.mockReset();
  creativoMock.mockResolvedValue({
    draft: { primary: 'Hola [NOMBRE], ¿pudiste revisar la opción que te compartí?' },
    cost_usd: 0.008,
    latency_ms: 9,
    error: null,
  });
});

describe('scan-reactivations handler (C.2.3 wiring)', () => {
  it('stub mode: sin WAPIFY_TOKEN → 0 candidatos, 0 blockers', async () => {
    const step = makeStep();
    const out = await scanReactivations.handler({ event: {}, step });
    expect(out.pipelines_scanned).toBe(5);
    expect(out.candidates_emitted).toBe(0);
    expect(out.blockers).toBe(0);
    expect(out.stub_mode).toBe(true);
    expect(creativoMock).not.toHaveBeenCalled();
  });

  it('candidato en pipeline permitido → Creativo + lead.silence_detected con script_preview', async () => {
    const step = makeStep(scanOverrides({ '216977': [candidate('lead-1')] }));
    const out = await scanReactivations.handler({ event: {}, step });
    expect(out.candidates_emitted).toBe(1);
    expect(out.blockers).toBe(0);
    expect(creativoMock).toHaveBeenCalledTimes(1);
    expect(creativoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'reactivation',
        params: expect.objectContaining({ pipelineId: '216977', stageIn: 'INT2 · CATÁLOGO' }),
        correlation_id: expect.stringContaining('lead-1'),
      }),
    );
    const silence = step.events.filter((e) => e.ev.name === EVENTS.LEAD_SILENCE_DETECTED);
    expect(silence).toHaveLength(1);
    expect(silence[0].ev.data.contact_id).toBe('lead-1');
    expect(silence[0].ev.data.script_preview).toContain('¿pudiste revisar');
  });

  it('REGLA INVIOLABLE: candidato en 252999 (SPY) → blocker_violation, NO silence_detected', async () => {
    const step = makeStep(scanOverrides({ '252999': [candidate('spy-lead')] }));
    const out = await scanReactivations.handler({ event: {}, step });
    expect(out.blockers).toBe(1);
    expect(out.candidates_emitted).toBe(0);
    expect(creativoMock).not.toHaveBeenCalled();
    const blockerEv = step.events.filter((e) => e.ev.name === 'giolens/agent.blocker_violation');
    expect(blockerEv).toHaveLength(1);
    expect(blockerEv[0].ev.data.pipeline_id).toBe('252999');
    expect(blockerEv[0].ev.data.reason).toBe('INT_forbidden_pipeline');
    const silence = step.events.filter((e) => e.ev.name === EVENTS.LEAD_SILENCE_DETECTED);
    expect(silence).toHaveLength(0);
  });

  it('REGLA INVIOLABLE: candidato en 273944 (GioVision) → blocker_violation', async () => {
    const step = makeStep(scanOverrides({ '273944': [candidate('giov-lead')] }));
    const out = await scanReactivations.handler({ event: {}, step });
    expect(out.blockers).toBe(1);
    expect(out.candidates_emitted).toBe(0);
  });

  it('mezcla: permitido emite, prohibido bloquea — en el mismo run', async () => {
    const step = makeStep(scanOverrides({
      '755062': [candidate('ok-lead')],
      '252999': [candidate('spy-lead')],
    }));
    const out = await scanReactivations.handler({ event: {}, step });
    expect(out.candidates_emitted).toBe(1);
    expect(out.blockers).toBe(1);
  });

  it('respeta el cap MAX_CANDIDATES_PER_RUN (5)', async () => {
    const many = Array.from({ length: 9 }, (_, i) => candidate(`lead-${i}`));
    const step = makeStep(scanOverrides({ '216977': many }));
    const out = await scanReactivations.handler({ event: {}, step });
    expect(out.candidates_emitted).toBe(5);
    expect(creativoMock).toHaveBeenCalledTimes(5);
  });
});
