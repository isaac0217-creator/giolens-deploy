/**
 * GioLens — Wrapper Claude (Anthropic Messages API)
 * Fase 3 §15. Capa compartida para los 6 agentes (Analista, Optimizacion,
 * Creativo, Desarrollador, QA, Orquestador).
 *
 * Reutiliza el patron de api/webhook.js::callClaude pero parametrizado:
 *   - Acepta { systemPrompt, messages, tools, model, max_tokens }
 *   - Aplica cache_control: ephemeral automatico si systemPrompt > 1k chars
 *   - Retorna { content, usage, error }
 *
 * Modelo default: claude-haiku-4-5 (mismo que el resto del ecosistema).
 *
 * Estado: OPERATIVO (requiere ANTHROPIC_API_KEY en env).
 */

const ANTHROPIC_URL  = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VER  = '2023-06-01';
const DEFAULT_MODEL  = 'claude-haiku-4-5';
const DEFAULT_TOKENS = 1024;
const CACHE_THRESHOLD = 1024; // > 1k chars -> cache_control ephemeral

/**
 * Llama al endpoint Messages de Anthropic.
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {Array<{role:string, content:string|Array}>} opts.messages
 * @param {Array} [opts.tools]
 * @param {string} [opts.model]
 * @param {number} [opts.max_tokens]
 * @param {object} [opts.tool_choice]
 * @returns {Promise<{content:Array|null, usage:object|null, error:string|null, raw:object|null}>}
 */
export async function callAnthropic({
  systemPrompt,
  messages,
  tools,
  model = DEFAULT_MODEL,
  max_tokens = DEFAULT_TOKENS,
  tool_choice,
} = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { content: null, usage: null, error: 'ANTHROPIC_API_KEY missing', raw: null };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { content: null, usage: null, error: 'messages required', raw: null };
  }

  const systemBlock = buildSystemBlock(systemPrompt);
  const body = {
    model,
    max_tokens,
    messages,
  };
  if (systemBlock) body.system = systemBlock;
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = tool_choice || { type: 'auto' };
  }

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VER,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text();
      const msg = `Claude ${res.status}: ${errBody.slice(0, 240)}`;
      console.error(`[anthropic] ${msg}`);
      return { content: null, usage: null, error: msg, raw: null };
    }
    const json = await res.json();
    return {
      content: json.content || null,
      usage: json.usage || null,
      error: null,
      raw: json,
    };
  } catch (err) {
    console.error(`[anthropic] fetch failed: ${err.message}`);
    return { content: null, usage: null, error: err.message, raw: null };
  }
}

/**
 * Construye el bloque system. Aplica cache_control ephemeral si supera el umbral.
 * @param {string} systemPrompt
 */
export function buildSystemBlock(systemPrompt) {
  if (!systemPrompt || typeof systemPrompt !== 'string') return null;
  const block = { type: 'text', text: systemPrompt };
  if (systemPrompt.length > CACHE_THRESHOLD) {
    block.cache_control = { type: 'ephemeral' };
  }
  return [block];
}

// Alias backward-compat: los 6 agentes Fase 3 (Frente B) importan `callClaude`.
// Se mantiene `callAnthropic` como nombre canónico + este alias para no
// tener que tocar los 6 graph.js + sus tests.
export { callAnthropic as callClaude };

export default callAnthropic;
