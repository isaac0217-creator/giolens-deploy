/**
 * GioLens — Agente QA · graph.js
 * Rol: Orquestación del flujo de QA. Por ahora JS plano; cuando LangGraph
 *      esté instalado, migrará a StateGraph.
 *
 * Flujo runQA({ targets, mode }):
 *   1. loadTargets() — lista qué evaluar (5 motores + Analista)
 *   2. para cada target, cargar golden suite correspondiente
 *   3. ejecutar cada caso vía harness, capturar pass/fail
 *   4. para fails 'blocker' o 'high', generar suggested_fix vía callClaude
 *   5. agrupar todo en summary + findings[]
 *   6. publicar via bus como qa_report
 *   7. trackCost
 *
 * Modelos:
 *   - Haiku 4.5 para tests rápidos (default, modo unit/integration/evals)
 *   - Sonnet 4 para validación semántica de fixes (modo e2e/full)
 *
 * TODO Fase 2: migrar a LangGraph cuando esté instalado.
 * TODO cuando llegue Supabase: persistir runs en tabla qa_runs.
 */

import { callClaude } from '../_shared/anthropic.js';
import { publish } from '../_shared/bus.js';
import { trackCost } from '../_shared/cost-tracker.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { TOOL_DEFINITIONS, run_eval } from './tools.js';
import { compareSnapshot } from './runners/regression.js';

const MODEL_FAST = 'claude-haiku-4-5'; // tests rápidos
const MODEL_SEMANTIC = 'claude-sonnet-4'; // validación semántica + fix suggestion
const FIX_SEVERITY_THRESHOLD = ['high', 'blocker'];

// ─── Targets default (5 motores + Analista cuando llegue) ────────────────
export const DEFAULT_TARGETS = [
  { id: '216977', kind: 'motor', suite: 'motor-justin-holbrook' },
  { id: '755062', kind: 'motor', suite: 'motor-giosports' },
  { id: '252999', kind: 'motor', suite: 'motor-spy-z87' },
  { id: '94103', kind: 'motor', suite: 'motor-dama-luxury' },
  { id: '273944', kind: 'motor', suite: 'motor-giovision' },
  { id: 'analista', kind: 'agente', suite: 'agente-analista' },
];

/**
 * Step 1: resolver la lista de targets a evaluar.
 * Acepta override del caller; si no, retorna DEFAULT_TARGETS.
 */
export function loadTargets(targets) {
  if (Array.isArray(targets) && targets.length > 0) {
    return targets.map((t) =>
      typeof t === 'string'
        ? { id: t, kind: _kindFor(t), suite: _suiteFor(t) }
        : t,
    );
  }
  return DEFAULT_TARGETS;
}

function _kindFor(id) {
  if (id === 'analista' || id === 'agente-analista') return 'agente';
  return 'motor';
}

function _suiteFor(id) {
  const MAP = {
    '216977': 'motor-justin-holbrook',
    '755062': 'motor-giosports',
    '252999': 'motor-spy-z87',
    '94103': 'motor-dama-luxury',
    '273944': 'motor-giovision',
    analista: 'agente-analista',
    'agente-analista': 'agente-analista',
  };
  return MAP[id] || `motor-${id}`;
}

/**
 * Step 2 + 3: ejecuta los casos del target y normaliza a findings.
 * Aísla errores por target para no abortar el run completo.
 */
async function runTarget(target, mode) {
  const findings = [];
  let total = 0;
  let passed = 0;
  let failed = 0;

  try {
    const evalResult = await run_eval({ motor: target.id, suite: target.suite });
    total = evalResult.total;
    passed = evalResult.passed;
    failed = evalResult.failed;

    for (const detail of evalResult.details) {
      const isFail = !detail.pass;
      let drift = null;

      // Regression: comparar snapshot si modo lo incluye
      if (mode === 'full' || mode === 'e2e') {
        try {
          drift = await compareSnapshot(target.id, detail.caso, detail.actual);
        } catch (err) {
          drift = { drift: false, error: err.message };
        }
      }

      if (isFail) {
        findings.push({
          severity: _severityForFail(detail),
          test_name: `${target.suite}::${detail.caso}`,
          expected: detail.expected,
          actual: detail.actual,
          error_trace:
            detail.reason && detail.reason.includes('runtime error')
              ? detail.reason
              : null,
          suggested_fix: null, // se rellena en Step 4 si corresponde
          blocker: false,
        });
      } else if (drift && drift.drift) {
        // Caso "pasa" el golden pero tiene drift vs snapshot → finding medium
        findings.push({
          severity: 'medium',
          test_name: `${target.suite}::${detail.caso}::regression`,
          expected: drift.prev,
          actual: drift.curr,
          error_trace: null,
          suggested_fix: `Drift detectado en keys: ${(drift.changedKeys || []).join(', ')}. Revisar si el cambio es intencional; si lo es, sobreescribir snapshot.`,
          blocker: false,
        });
      }
    }
  } catch (err) {
    // Target completo crasheó → blocker
    findings.push({
      severity: 'blocker',
      test_name: `${target.suite}::__suite__`,
      expected: 'suite ejecutable',
      actual: null,
      error_trace: err.stack || err.message,
      suggested_fix: `Revisar que /evals/golden/${target.suite}.json exista y que el adapter para '${target.id}' esté registrado en motor-runner.js o agente-runner.js.`,
      blocker: true,
    });
  }

  return { findings, total, passed, failed };
}

/**
 * Heurística de severidad para un fail del harness.
 * Runtime error → blocker; fail semántico → high; mensaje menor → medium.
 */
function _severityForFail(detail) {
  const reason = String(detail.reason || '').toLowerCase();
  if (reason.includes('runtime error')) return 'blocker';
  if (reason.includes('no tool_use') || reason.includes('stage=')) return 'high';
  return 'medium';
}

/**
 * Step 4: para findings high/blocker, pide a Claude un fix sugerido.
 * Modelo: Sonnet 4 para razonamiento semántico.
 * Si no hay API key, marca suggested_fix con un placeholder.
 */
async function enrichWithFixSuggestions(findings) {
  const needsFix = findings.filter(
    (f) => FIX_SEVERITY_THRESHOLD.includes(f.severity) && !f.suggested_fix,
  );
  if (needsFix.length === 0) return { calls: 0, cost_usd: 0 };

  let calls = 0;
  let cost_usd = 0;

  for (const f of needsFix) {
    const userMsg = [
      `Test fallido: ${f.test_name}`,
      `Severity: ${f.severity}`,
      `Esperado: ${JSON.stringify(f.expected)}`,
      `Actual: ${JSON.stringify(f.actual)?.slice(0, 800)}`,
      f.error_trace ? `Trace: ${f.error_trace.slice(0, 400)}` : '',
      '',
      'Devuelve SOLO 1-2 frases con la corrección concreta que debería aplicar el Agente Desarrollador. Sin preámbulo, sin JSON.',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const res = await callClaude({
        model: MODEL_SEMANTIC,
        systemPrompt: SYSTEM_PROMPT,
        tools: TOOL_DEFINITIONS,
        messages: [{ role: 'user', content: userMsg }],
        max_tokens: 256,
      });

      const txt =
        res?.text ??
        (Array.isArray(res?.content)
          ? res.content.find((b) => b.type === 'text')?.text
          : '') ??
        '';
      f.suggested_fix = txt.trim() || 'Sin sugerencia: revisar manualmente.';

      calls += 1;
      cost_usd +=
        typeof res?.cost_usd === 'number'
          ? res.cost_usd
          : (res?.usage?.input_tokens ?? 0) * 0.000003 +
            (res?.usage?.output_tokens ?? 0) * 0.000015;
    } catch (err) {
      f.suggested_fix = `Sin sugerencia (callClaude falló: ${err.message}). Revisar manualmente.`;
    }
  }

  return { calls, cost_usd };
}

/**
 * Marca como blocker los findings que cumplen criterios duros.
 * Criterio: severity 'blocker' OR (severity 'high' AND mode === 'full').
 */
function _flagBlockers(findings, mode) {
  for (const f of findings) {
    if (f.severity === 'blocker') {
      f.blocker = true;
      continue;
    }
    if (mode === 'full' && f.severity === 'high') {
      f.blocker = true;
    }
  }
}

/**
 * Ejecuta el ciclo completo del QA.
 *
 * @param {object} args
 * @param {Array<string|object>} [args.targets] — overrides; default = 5 motores + Analista
 * @param {'unit'|'integration'|'e2e'|'evals'|'full'} [args.mode='evals']
 * @returns {Promise<{ summary: object, findings: object[], cost_usd: number, latency_ms: number }>}
 */
export async function runQA({ targets, mode = 'evals' } = {}) {
  const t0 = Date.now();
  const resolved = loadTargets(targets);

  // Step 2 + 3
  const allFindings = [];
  let total = 0;
  let passed = 0;
  let failed = 0;

  for (const target of resolved) {
    const r = await runTarget(target, mode);
    allFindings.push(...r.findings);
    total += r.total;
    passed += r.passed;
    failed += r.failed;
  }

  // Step 4
  const enrich = await enrichWithFixSuggestions(allFindings);

  // Marcar blockers
  _flagBlockers(allFindings, mode);

  // Step 5
  const blockers = allFindings.filter((f) => f.blocker).length;
  const summary = { total, passed, failed, blockers };

  const report = {
    summary,
    findings: allFindings,
    mode,
    targets: resolved.map((t) => t.id),
    ts: new Date().toISOString(),
  };

  // Step 6: publicar al bus (tipo qa_report)
  try {
    await publish({
      type: 'qa_report',
      from_agent: 'qa',
      to_agent: 'orquestador',
      payload: { severity: blockers > 0 ? 'blocker' : failed > 0 ? 'high' : 'low', report },
    });
  } catch (err) {
    console.error(`[qa] publish failed: ${err.message}`);
  }

  // Step 7: trackCost
  const cost_usd = enrich.cost_usd;
  try {
    await trackCost({
      agent: 'qa',
      model: MODEL_FAST,
      cost_usd,
      usage: null,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[qa] trackCost failed: ${err.message}`);
  }

  const latency_ms = Date.now() - t0;
  return { summary, findings: allFindings, cost_usd, latency_ms };
}

export default runQA;
