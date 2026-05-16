/**
 * GioLens — Capa compartida agentes Fase 3 (barrel)
 * §15 HTML maestro v10. Importable desde cualquier agente:
 *   import { callTracked, publish, subscribe, requestApproval, tools } from '../_shared/index.js';
 */

export { callAnthropic, buildSystemBlock } from './anthropic.js';
export { getServiceClient, getAnonClient, isSupabaseReady } from './supabase.js';
export { publish, subscribe, _resetForTests as _busReset } from './bus.js';
export {
  calcUSD,
  track,
  callTracked,
  getDailyCost,
  getDailyStats,
  checkCap,
  _resetForTests as _costReset,
} from './cost-tracker.js';
export { requestApproval } from './approval.js';
export {
  register as registerRollback,
  has as hasRollback,
  executeRollback,
  _resetForTests as _rollbackReset,
} from './rollback.js';

// Tools (definitions + handlers)
import * as readKpis           from './tools/read-kpis.js';
import * as readPipeline       from './tools/read-pipeline.js';
import * as proposeBudgetChange from './tools/propose-budget-change.js';

export const tools = {
  read_kpis:              readKpis,
  read_pipeline:          readPipeline,
  propose_budget_change:  proposeBudgetChange,
};

/**
 * Helper: arma el array de tool definitions para un agente especifico.
 * @param {string[]} toolNames
 * @returns {Array} tool definitions listas para anthropic.js
 */
export function toolDefsFor(toolNames) {
  return toolNames
    .map(n => tools[n]?.toolDefinition)
    .filter(Boolean);
}

/**
 * Helper: ejecuta un tool por nombre.
 * @param {string} name
 * @param {object} input
 * @param {object} [ctx]
 */
export async function runTool(name, input, ctx) {
  const t = tools[name];
  if (!t) return { ok: false, error: `unknown tool: ${name}` };
  return t.handler(input, ctx);
}
