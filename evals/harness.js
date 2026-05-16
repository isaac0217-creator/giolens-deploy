/**
 * GioLens — Eval Harness
 * Framework de evals (input → expected → actual → diff)
 *
 * Estrategias de assertion soportadas en `expected`:
 *   - tool_should_be_called: string | string[]   → uno de los nombres permitidos
 *   - stage_should_move_to: string | string[]    → extrae stage del tool input
 *   - message_should_mention: string[]           → contiene ALGUNO (regex i, accent-insensitive)
 *   - message_should_NOT_mention: string[]       → NO contiene ninguno
 *   - insights_count_at_least: number            → para outputs de agentes (insights[])
 *   - insights_should_mention: string[]          → contiene ALGUNO en cualquier insight
 *
 * Uso típico:
 *   import { loadGolden, runEval, prettyPrint } from './harness.js';
 *   const golden = await loadGolden('./golden/motor-justin-holbrook.json');
 *   const result = await runEval(motorFn, golden);
 *   prettyPrint(result);
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Loader ───────────────────────────────────────────────────────────────
export async function loadGolden(file) {
  const abs = path.isAbsolute(file) ? file : path.resolve(__dirname, file);
  const raw = await readFile(abs, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.cases)) {
    throw new Error(`Golden ${file} no tiene array 'cases'`);
  }
  return parsed;
}

// ─── Helpers para acceso al output ────────────────────────────────────────
// U+0300–U+036F = Combining Diacritical Marks block. Construimos el regex
// con string ASCII puro vía new RegExp para evitar problemas de encoding.
const DIACRITICS_RE = new RegExp('[\\u0300-\\u036f]', 'g');
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS_RE, '');
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function findToolUse(actual) {
  // Acepta:
  //   1. Respuesta cruda de Anthropic: { content: [{type:'tool_use', name, input}, ...] }
  //   2. Resultado de executeDecision (mock): { action, input }
  //   3. Adapter-friendly: { tool_name, tool_input }
  if (!actual) return null;

  if (Array.isArray(actual.content)) {
    const tu = actual.content.find(c => c && c.type === 'tool_use');
    if (tu) return { name: tu.name, input: tu.input || {} };
  }
  if (actual.tool_name) {
    return { name: actual.tool_name, input: actual.tool_input || {} };
  }
  if (actual.action && actual.action !== 'no_decision' && actual.action !== 'no_tool') {
    return { name: actual.action, input: actual.input || {} };
  }
  return null;
}

function extractMessageText(toolUse) {
  if (!toolUse || !toolUse.input) return '';
  return String(toolUse.input.text || toolUse.input.message || '');
}

function extractStageName(toolUse) {
  if (!toolUse || !toolUse.input) return '';
  return String(toolUse.input.stage_name || toolUse.input.stage || '');
}

function extractInsights(actual) {
  // Adapter del agente debe devolver { insights: string[] } o array suelto
  if (!actual) return [];
  if (Array.isArray(actual)) return actual.map(String);
  if (Array.isArray(actual.insights)) return actual.insights.map(String);
  if (typeof actual.text === 'string') return [actual.text];
  return [];
}

// ─── Assertion principal ─────────────────────────────────────────────────
export function assertOutput(actual, expected) {
  const reasons = [];

  // 1. tool_should_be_called
  if (expected.tool_should_be_called !== undefined) {
    const allowed = asArray(expected.tool_should_be_called);
    const tu = findToolUse(actual);
    if (!tu) {
      reasons.push(`no tool_use encontrado (esperado uno de: ${allowed.join(', ')})`);
    } else if (!allowed.includes(tu.name)) {
      reasons.push(`tool=${tu.name} no está en permitidos [${allowed.join(', ')}]`);
    }
  }

  // 2. stage_should_move_to
  if (expected.stage_should_move_to !== undefined) {
    const allowed = asArray(expected.stage_should_move_to);
    const tu = findToolUse(actual);
    const stage = extractStageName(tu);
    if (!stage) {
      reasons.push(`no se encontró stage_name (esperado: ${allowed.join(', ')})`);
    } else if (!allowed.includes(stage)) {
      reasons.push(`stage=${stage} no está en permitidos [${allowed.join(', ')}]`);
    }
  }

  // 3. message_should_mention
  if (expected.message_should_mention !== undefined) {
    const needles = asArray(expected.message_should_mention).map(normalize);
    const tu = findToolUse(actual);
    const haystack = normalize(extractMessageText(tu));
    if (!haystack) {
      reasons.push(`mensaje vacío (esperaba mencionar alguno de: ${needles.join(', ')})`);
    } else {
      const hit = needles.some(n => n && haystack.includes(n));
      if (!hit) reasons.push(`mensaje no mencionó ninguno de [${needles.join(', ')}]`);
    }
  }

  // 4. message_should_NOT_mention
  if (expected.message_should_NOT_mention !== undefined) {
    const forbidden = asArray(expected.message_should_NOT_mention).map(normalize);
    const tu = findToolUse(actual);
    const haystack = normalize(extractMessageText(tu));
    const hits = forbidden.filter(n => n && haystack.includes(n));
    if (hits.length > 0) reasons.push(`mensaje contiene términos prohibidos: [${hits.join(', ')}]`);
  }

  // 5. insights_count_at_least
  if (expected.insights_count_at_least !== undefined) {
    const insights = extractInsights(actual);
    if (insights.length < expected.insights_count_at_least) {
      reasons.push(`insights=${insights.length} < esperados ${expected.insights_count_at_least}`);
    }
  }

  // 6. insights_should_mention
  if (expected.insights_should_mention !== undefined) {
    const needles = asArray(expected.insights_should_mention).map(normalize);
    const insights = extractInsights(actual).map(normalize);
    const combined = insights.join(' || ');
    const hit = needles.some(n => n && combined.includes(n));
    if (!hit) {
      reasons.push(`ningún insight mencionó alguno de [${needles.join(', ')}]`);
    }
  }

  return { pass: reasons.length === 0, reasons };
}

// ─── Runner ───────────────────────────────────────────────────────────────
export async function runEval(motorFn, golden) {
  const details = [];
  let passed = 0;
  let failed = 0;

  for (const c of golden.cases) {
    let actual;
    let runtimeError = null;
    try {
      actual = await motorFn(c.input, { caseId: c.id, golden });
    } catch (err) {
      runtimeError = err;
      actual = null;
    }

    let verdict;
    if (runtimeError) {
      verdict = { pass: false, reasons: [`runtime error: ${runtimeError.message}`] };
    } else {
      verdict = assertOutput(actual, c.expected);
    }

    if (verdict.pass) passed++; else failed++;

    details.push({
      caso: c.id,
      description: c.description,
      pass: verdict.pass,
      expected: c.expected,
      actual,
      reason: verdict.reasons.join(' | ') || null,
    });
  }

  return {
    motor: golden.motor || 'unknown',
    total: golden.cases.length,
    passed,
    failed,
    details,
  };
}

// ─── Pretty print ─────────────────────────────────────────────────────────
export function prettyPrint(result) {
  const header = `\n━━━ ${result.motor} — ${result.passed}/${result.total} pass ━━━`;
  console.log(header);
  for (const d of result.details) {
    const icon = d.pass ? '[ok]' : '[fail]';
    console.log(`  ${icon} ${d.caso} — ${d.description}`);
    if (!d.pass) {
      console.log(`         razón: ${d.reason}`);
      const tu = findToolUse(d.actual);
      if (tu) {
        const preview = JSON.stringify(tu).slice(0, 180);
        console.log(`         actual.tool: ${preview}`);
      } else if (d.actual) {
        console.log(`         actual: ${JSON.stringify(d.actual).slice(0, 180)}`);
      }
    }
  }
  if (result.failed > 0) {
    console.log(`  → ${result.failed} fail(s) en ${result.motor}`);
  }
}
