/**
 * GioLens — Loop QA ↔ Dev (§16 del HTML maestro GIOCORE v10)
 *
 * Stub del loop sin agentes reales:
 *   iter=0 → dev-stub genera código (mock)
 *   run evals → si pasa, return success
 *   si falla y iter<3 → dev-stub regenera CON feedback de evals → iter++
 *   si iter==3 → escalate=true con últimos findings
 *
 * Cuando los agentes Dev y QA reales lleguen en Fase 3 (sem 7-10), reemplazar
 * `mockDevAgent` y `mockQaRunner` por imports de /agents/dev/ y /agents/qa/.
 */

import { runEval, prettyPrint } from './harness.js';
import { getMotorAdapter } from './runners/motor-runner.js';

// ─── Dev stub: genera un "patch" mock dado un specChange y feedback ──────
function mockDevAgent({ specChange, iteration, feedback }) {
  const patchId = `patch-${specChange.motor || 'unknown'}-iter${iteration}-${Math.random().toString(36).slice(2, 7)}`;
  const note = feedback
    ? `Ajustes basados en feedback de QA: ${feedback.slice(0, 120)}`
    : 'Implementación inicial sin feedback previo';
  return {
    patchId,
    appliedTo: specChange.motor,
    note,
    // En la versión real, aquí iría el código generado.
    // En el stub solo registramos metadata para validar el flujo.
  };
}

// ─── QA runner: corre los goldens del motor afectado ─────────────────────
async function mockQaRunner({ specChange, golden }) {
  const adapter = getMotorAdapter(specChange.motor);
  return runEval(adapter, golden);
}

// ─── Loop principal ──────────────────────────────────────────────────────
export async function runQaDevLoop({ specChange, golden, maxIterations = 3, verbose = true }) {
  const history = [];
  let lastFeedback = null;

  for (let iter = 0; iter < maxIterations; iter++) {
    if (verbose) console.log(`\n[loop] === iteración ${iter} para motor=${specChange.motor} ===`);

    const patch = mockDevAgent({ specChange, iteration: iter, feedback: lastFeedback });
    if (verbose) console.log(`[loop] dev-stub generó ${patch.patchId} (${patch.note})`);

    const qaResult = await mockQaRunner({ specChange, golden });
    if (verbose) prettyPrint(qaResult);

    history.push({ iteration: iter, patch, qaResult });

    if (qaResult.failed === 0) {
      if (verbose) console.log(`[loop] iter ${iter} PASS — saliendo con success`);
      return {
        success: true,
        iterations: iter + 1,
        finalPatch: patch,
        history,
      };
    }

    // Construir feedback compacto para el dev-stub
    const fails = qaResult.details.filter(d => !d.pass);
    lastFeedback = fails
      .map(f => `${f.caso}: ${f.reason}`)
      .join(' || ');
    if (verbose) console.log(`[loop] iter ${iter} FAIL (${qaResult.failed}/${qaResult.total}) — feedback preparado para próxima iteración`);
  }

  if (verbose) console.log(`[loop] alcanzadas ${maxIterations} iteraciones sin éxito — ESCALAR`);
  return {
    success: false,
    escalate: true,
    iterations: maxIterations,
    lastFindings: history[history.length - 1]?.qaResult || null,
    history,
  };
}
