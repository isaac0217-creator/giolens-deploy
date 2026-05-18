/**
 * GioLens — Cost tracker para llamadas Claude
 * Fase 3 §15. Capa compartida.
 *
 * Estado: OPERATIVO (in-memory). Persistencia en agent_runs cuando llegue Supabase.
 *
 * Tarifas Haiku 4.5 (verificar contra https://www.anthropic.com/pricing):
 *   - input:        $1.00 / MTok
 *   - output:       $5.00 / MTok
 *   - cache write:  $1.25 / MTok (aprox)
 *   - cache read:   $0.10 / MTok (aprox)
 * TODO Fase 2: verificar precios actualizados en docs Anthropic y ajustar PRICING.
 */

import { callAnthropic } from './anthropic.js';

const PRICING = {
  'claude-haiku-4-5': {
    input:       1.00 / 1_000_000,
    output:      5.00 / 1_000_000,
    cache_write: 1.25 / 1_000_000,
    cache_read:  0.10 / 1_000_000,
  },
  'claude-sonnet-4-5': {
    input:       3.00 / 1_000_000,
    output:     15.00 / 1_000_000,
    cache_write: 3.75 / 1_000_000,
    cache_read:  0.30 / 1_000_000,
  },
};

// Map: `${agentName}|${YYYY-MM-DD}` -> { calls, input_tokens, output_tokens, usd }
const _daily = new Map();

function _todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
function _bucketKey(agentName, day) {
  return `${agentName}|${day}`;
}

/**
 * Calcula USD para un usage block dado y un modelo.
 * @param {object} usage  - { input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens? }
 * @param {string} model
 * @returns {number} USD
 */
export function calcUSD(usage, model = 'claude-haiku-4-5') {
  if (!usage) return 0;
  const tier = PRICING[model] || PRICING['claude-haiku-4-5'];
  const inTok    = Number(usage.input_tokens || 0);
  const outTok   = Number(usage.output_tokens || 0);
  const cWrite   = Number(usage.cache_creation_input_tokens || 0);
  const cRead    = Number(usage.cache_read_input_tokens || 0);
  return inTok * tier.input
       + outTok * tier.output
       + cWrite * tier.cache_write
       + cRead  * tier.cache_read;
}

/**
 * Registra un consumo. Util cuando ya tienes un usage block (test/manual).
 * @param {string} agentName
 * @param {object} usage
 * @param {string} [model]
 */
export function track(agentName, usage, model = 'claude-haiku-4-5') {
  const day = _todayKey();
  const key = _bucketKey(agentName, day);
  const usd = calcUSD(usage, model);
  const cur = _daily.get(key) || { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0 };
  cur.calls         += 1;
  cur.input_tokens  += Number(usage?.input_tokens || 0);
  cur.output_tokens += Number(usage?.output_tokens || 0);
  cur.usd           += usd;
  _daily.set(key, cur);
  // TODO cuando llegue Supabase: insert en agent_runs (agent, day, calls, tokens, usd)
  return { usd, total: cur };
}

/**
 * Llama a Claude via anthropic.js y registra costo automaticamente.
 * @param {string} agentName  - para atribuir el gasto
 * @param {object} opts       - args para callAnthropic
 * @returns {Promise<{content, usage, error, usd, raw}>}
 */
export async function callTracked(agentName, opts) {
  const res = await callAnthropic(opts);
  if (res.usage) {
    const { usd } = track(agentName, res.usage, opts.model || 'claude-haiku-4-5');
    res.usd = usd;
  } else {
    res.usd = 0;
  }
  return res;
}

/**
 * Costo acumulado hoy para un agente.
 * @param {string} agentName
 * @param {string} [day]  - YYYY-MM-DD (default hoy)
 * @returns {number} USD
 */
export function getDailyCost(agentName, day = _todayKey()) {
  const cur = _daily.get(_bucketKey(agentName, day));
  return cur ? cur.usd : 0;
}

/**
 * @param {string} agentName
 * @param {string} [day]
 * @returns {{calls:number, input_tokens:number, output_tokens:number, usd:number}}
 */
export function getDailyStats(agentName, day = _todayKey()) {
  return _daily.get(_bucketKey(agentName, day)) || { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0 };
}

/**
 * Verifica si el agente excedio el cap diario en USD.
 * @param {string} agentName
 * @param {number} cap_usd
 * @returns {boolean} true si excede (gasto >= cap)
 */
export function checkCap(agentName, cap_usd) {
  if (!Number.isFinite(cap_usd) || cap_usd <= 0) return false;
  return getDailyCost(agentName) >= cap_usd;
}

/** Util tests */
export function _resetForTests() {
  _daily.clear();
}

// Alias backward-compat para Analista/QA que pasan objeto único en lugar de
// (agentName, usage, model). Adapta el shape y delega a `track`. cost_usd y ts
// son ignorados (track los calcula internamente desde usage).
export function trackCost({ agent, model, usage, cost_usd, ts } = {}) {
  return track(agent, usage, model);
}

export default { calcUSD, track, trackCost, callTracked, getDailyCost, getDailyStats, checkCap, _resetForTests };
