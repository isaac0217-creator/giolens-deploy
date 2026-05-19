/**
 * GioLens — run-with-trace (Frente C · C.1.2)
 *
 * Wrapper de observabilidad para runs de agentes. Envuelve la invocación de
 * cualquier entrypoint de agente (`executeAnalistaDailyRun`, `runQAOnDemand`,
 * etc.) y produce un `trace` estructurado y auditable:
 *
 *   - genera/propaga un `correlation_id` (rastrea cascadas cross-agente)
 *   - mide latencia wall-clock
 *   - registra `steps[]` con hitos de la ejecución (invoke → result/error)
 *   - extrae `cost_usd` / `latency_ms` del resultado del agente si los expone
 *
 * El `correlation_id` se INYECTA en los args del agente: agentes que lo
 * soporten lo propagan a sus `bus.publish` (vía `context_refs`); agentes que
 * no, simplemente lo ignoran (campo extra inofensivo en el destructuring).
 *
 * NO modifica `bus.js`. La captura de cada `bus.publish` individual dentro del
 * run requeriría un hook en el emitter — diferido (el trace de hitos cubre la
 * necesidad de C.1: runs auditables con steps[] no vacío).
 *
 * Uso:
 *   import { runWithTrace } from '../_shared/run-with-trace.js';
 *   const { result, trace, error } = await runWithTrace(
 *     'analista', executeAnalistaDailyRun, { period: 'last_24h' });
 */

import { randomUUID } from 'node:crypto';

/**
 * Genera un correlation_id nuevo para un agente.
 * Formato: `run-<agent>-<uuid>` — legible + único.
 */
export function newCorrelationId(agentName) {
  return `run-${agentName || 'agent'}-${randomUUID()}`;
}

/**
 * Ejecuta `runFn` con tracing.
 *
 * @param {string} agentName  nombre del agente (para tags del trace)
 * @param {Function} runFn  entrypoint async del agente
 * @param {object} [args]  argumentos para runFn; se le inyecta correlation_id
 * @param {object} [opts]
 * @param {string} [opts.correlation_id]  id existente a propagar (cascada)
 * @returns {Promise<{result:any, trace:object, error:string|null}>}
 *   nunca rechaza — un fallo del agente se refleja en `error` + trace.steps
 */
export async function runWithTrace(agentName, runFn, args = {}, opts = {}) {
  if (typeof runFn !== 'function') {
    throw new Error('[runWithTrace] runFn debe ser una función');
  }
  const agent = String(agentName || 'agent');
  const correlation_id = opts.correlation_id || newCorrelationId(agent);
  const started_at = new Date().toISOString();
  const t0 = Date.now();

  /** @type {Array<object>} */
  const steps = [
    { step: 'invoke', agent, at: started_at, correlation_id },
  ];

  let result = null;
  let error = null;
  try {
    // Inyecta correlation_id: agentes que lo soporten lo propagan al bus.
    result = await runFn({ ...args, correlation_id });
  } catch (err) {
    error = err?.message || String(err);
  }

  const finished_at = new Date().toISOString();
  const duration_ms = Date.now() - t0;

  steps.push({
    step: error ? 'error' : 'result',
    agent,
    at: finished_at,
    duration_ms,
    // Métricas del agente si las expone (shape estándar de los 6 entrypoints).
    cost_usd:   typeof result?.cost_usd === 'number' ? result.cost_usd : null,
    latency_ms: typeof result?.latency_ms === 'number' ? result.latency_ms : null,
    error,
  });

  const trace = {
    correlation_id,
    agent,
    started_at,
    finished_at,
    duration_ms,
    ok: error === null,
    steps,
  };

  return { result, trace, error };
}

export default runWithTrace;
