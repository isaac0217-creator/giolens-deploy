#!/usr/bin/env node
/**
 * GioLens — Frente C · C.4 · Smoke shadow del agente Analista
 *
 * Valida que el agente Analista produzca resultados equivalentes cuando se lo
 * invoca de dos formas, e idempotencia cross-run, SIN incurrir costo Anthropic
 * real (mismo patrón que scripts/smoke-inngest-e2e.mjs):
 *
 *   C.4.1 — disparo directo (shadow):
 *           runWithTrace('analista', executeAnalistaDailyRun, {period:'last_24h'})
 *           Verifica cost_usd numérico, errors vacío, trace.steps[] no vacío.
 *
 *   C.4.2 — disparo vía Inngest:
 *           levanta el dev server in-process + sirve las 8 funciones canónicas,
 *           envía makeEvent(EVENTS.ARBITRAGE_REQUESTED, {correlation_id}) y
 *           captura el output del run de run-arbitraje (cuyo step analista-recos
 *           invoca executeAnalistaDailyRun vía runWithTrace — C.1/C.2 ya cerrado).
 *
 *   C.4.3 — comparación shadow vs Inngest:
 *           normaliza quitando campos volátiles (timestamps, correlation_id,
 *           latency_ms, duration_ms, run_id) y verifica equivalencia.
 *
 *   C.4.4 — idempotencia cross-run:
 *           re-dispara ARBITRAGE_REQUESTED con el MISMO correlation_id y verifica
 *           que el resultado normalizado es idéntico (sin drift) y que cada run
 *           invocó al agente exactamente una vez (sin doble cobro dentro del run).
 *
 * Modo del smoke (costo Anthropic 0, sin red real):
 *   - fetch a api.anthropic.com interceptado  → respuesta sintética
 *   - fetch a /api/pipeline-summary stubbeado → sin red a Vercel (errors vacío)
 *   - process.env.ANTHROPIC_API_KEY dummy     → pasa el gate de callAnthropic
 *   - INNGEST_DEV apuntando al dev server local → sin verificación de firma
 *
 * Uso:  node scripts/smoke-shadow-analista.mjs   ·   npm run smoke:shadow
 * Requisitos: inngest-cli (se invoca vía `npx inngest-cli@latest dev`).
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// ─── Configuración (env ANTES de importar el wiring Inngest) ──────────────────
const APP_PORT = Number(process.env.SMOKE_APP_PORT || 3941);
const DEV_PORT = Number(process.env.SMOKE_DEV_PORT || 8290);
const APP_PATH = '/api/inngest';
const APP_URL  = `http://127.0.0.1:${APP_PORT}${APP_PATH}`;
const DEV_URL  = `http://127.0.0.1:${DEV_PORT}`;

process.env.INNGEST_DEV       = DEV_URL;   // modo dev: sin verificación de firma
process.env.INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY || 'smoke-shadow';
// callAnthropic corta si no hay key → key dummy para pasar el gate; el fetch
// real lo intercepta el stub de abajo, así que nunca sale a la red (costo 0).
process.env.ANTHROPIC_API_KEY = 'sk-ant-smoke-shadow-stub-no-network';
// read-kpis / read-pipeline hacen GET a este base; lo apuntamos a localhost
// (el stub de fetch igual lo intercepta antes de que salga a la red).
process.env.GIOLENS_API_BASE  = 'http://127.0.0.1:9';
delete process.env.INNGEST_SIGNING_KEY;        // dev mode no la necesita

// ─── Stub de fetch — costo Anthropic 0, sin red a Vercel ──────────────────────
// Intercepta:
//   - api.anthropic.com         → respuesta Messages sintética (insights[])
//   - /api/pipeline-summary     → KPIs/pipeline sintéticos (errors vacío)
// Todo lo demás (dev server local) pasa directo.
const ANALISTA_INSIGHTS = {
  insights: [
    {
      id: 'smoke-insight-1',
      pipeline_id: '216977',
      severity: 'low',
      title: 'Pipeline 216977 estable',
      detail: 'Sin estancamiento relevante en el período analizado.',
      recommendation: 'Mantener cadencia actual.',
    },
  ],
};
const PIPELINE_SUMMARY_SAMPLE = {
  pipeline_id: 'stub',
  stages: [],
  metrics: { won: 0, lost: 0, active: 0, stalled_48h: 0, close_rate: 0 },
};

// Contador de llamadas reales al agente vía Anthropic — clave para C.4.4
// (idempotencia: detectar doble invocación / doble cobro).
let anthropicCalls = 0;

const _realFetch = globalThis.fetch;
globalThis.fetch = async function smokeFetch(url, opts = {}) {
  const u = typeof url === 'string' ? url : url?.url || String(url);
  if (u.includes('api.anthropic.com')) {
    anthropicCalls += 1;
    const body = {
      id: 'msg_smoke_shadow', type: 'message', role: 'assistant',
      model: 'claude-sonnet-4',
      content: [{ type: 'text', text: JSON.stringify(ANALISTA_INSIGHTS) }],
      usage: { input_tokens: 120, output_tokens: 60 }, stop_reason: 'end_turn',
    };
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  if (u.includes('/api/pipeline-summary')) {
    return new Response(JSON.stringify(PIPELINE_SUMMARY_SAMPLE), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return _realFetch(url, opts);
};

// Importes dinámicos: el wiring lee process.env al cargar el módulo.
const { serve }                  = await import('inngest/node');
const { inngest }                = await import('../inngest/client.js');
const { functions }              = await import('../api/inngest.js');
const { EVENTS, makeEvent }      = await import('../inngest/events.js');
const { runWithTrace }           = await import('../agents/_shared/run-with-trace.js');
const { executeAnalistaDailyRun } = await import('../agents/analista/index.js');

// ─── Servidor HTTP que expone las funciones al dev server ─────────────────────
const handler = serve({ client: inngest, functions });
const server  = http.createServer((req, res) => handler(req, res));

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function httpJson(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* deja json null */ }
  return { status: r.status, text, json };
}

async function waitFor(label, predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await predicate(); if (last) return last; } catch { /* reintenta */ }
    await sleep(intervalMs);
  }
  throw new Error(`timeout esperando: ${label} (${timeoutMs}ms)`);
}

/** Envía un evento al dev server y devuelve los event ids generados. */
async function sendEvent(name, data) {
  const r = await httpJson(`${DEV_URL}/e/${process.env.INNGEST_EVENT_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makeEvent(name, data)),
  });
  if (r.status >= 300) throw new Error(`sendEvent ${name} → HTTP ${r.status}: ${r.text}`);
  const ids = r.json?.ids || [];
  if (ids.length === 0) throw new Error(`sendEvent ${name} → sin event ids en la respuesta`);
  return ids;
}

/**
 * Espera al run de run-arbitraje disparado por `eventId` y devuelve su output.
 * Usa la REST API del dev server: GET /v1/events/{id}/runs.
 */
async function waitForArbitrajeRun(eventId, timeoutMs = 60_000) {
  return waitFor(`run de run-arbitraje (event ${eventId})`, async () => {
    const r = await httpJson(`${DEV_URL}/v1/events/${encodeURIComponent(eventId)}/runs`);
    const runs = r.json?.data || [];
    // El dev server lista todos los runs disparados por el evento.
    const done = runs.find((x) => x.status === 'Completed' && x.output);
    if (done) return done;
    const failed = runs.find((x) => x.status === 'Failed' || x.status === 'Cancelled');
    if (failed) throw new Error(`run-arbitraje terminó en estado ${failed.status}: ${JSON.stringify(failed.output)}`);
    return null;
  }, timeoutMs);
}

/**
 * Normaliza un resultado del Analista quitando campos volátiles para poder
 * comparar shadow vs Inngest y run vs re-run (C.4.3 / C.4.4).
 * Volátiles: timestamps, correlation_id, latency_ms, duration_ms, run_id.
 */
function normalizeAnalista(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  return {
    insights_count: Array.isArray(raw.insights) ? raw.insights.length
                  : (typeof raw.insights === 'number' ? raw.insights : null),
    published: typeof raw.published === 'number' ? raw.published : null,
    cost_usd: typeof raw.cost_usd === 'number' ? raw.cost_usd : null,
    errors_count: Array.isArray(raw.errors) ? raw.errors.length
                : (typeof raw.error === 'string' && raw.error ? 1 : 0),
  };
}

// ─── Ejecución ────────────────────────────────────────────────────────────────
let devProc;
const devLog = [];
const failures = [];
const fail = (m) => { failures.push(m); console.error(`  ✗ ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);

console.log('═══ C.4 · Smoke shadow del agente Analista ═══\n');

try {
  // Pre-flight: el puerto del dev server debe estar libre.
  const busy = await fetch(`${DEV_URL}/dev`).then((r) => r.ok).catch(() => false);
  if (busy) throw new Error(`puerto ${DEV_PORT} ya ocupado — ¿hay otro inngest-cli dev corriendo?`);

  // ── C.4.1 · Disparo directo (shadow) ────────────────────────────────────────
  console.log('── C.4.1 · disparo directo: runWithTrace(analista, …) ──');
  const callsBeforeShadow = anthropicCalls;
  const shadow = await runWithTrace(
    'analista',
    executeAnalistaDailyRun,
    { period: 'last_24h' },
  );
  const shadowAgentCalls = anthropicCalls - callsBeforeShadow;

  shadow.error === null
    ? pass('runWithTrace no reportó error')
    : fail(`runWithTrace reportó error: ${shadow.error}`);

  typeof shadow.result?.cost_usd === 'number'
    ? pass(`result.cost_usd numérico (${shadow.result.cost_usd})`)
    : fail(`result.cost_usd no es numérico (${shadow.result?.cost_usd})`);

  Array.isArray(shadow.result?.errors) && shadow.result.errors.length === 0
    ? pass('result.errors vacío')
    : fail(`result.errors no vacío: ${JSON.stringify(shadow.result?.errors)}`);

  Array.isArray(shadow.trace?.steps) && shadow.trace.steps.length > 0
    ? pass(`trace.steps[] no vacío (${shadow.trace.steps.length} steps)`)
    : fail('trace.steps[] vacío');

  shadowAgentCalls === 1
    ? pass(`agente invocado 1× en el disparo directo (${shadowAgentCalls} call Anthropic)`)
    : fail(`agente invocado ${shadowAgentCalls}× en el disparo directo (esperaba 1)`);

  const shadowNorm = normalizeAnalista(shadow.result);
  console.log(`  · shadow normalizado: ${JSON.stringify(shadowNorm)}`);

  // ── Levantar el dev server in-process para C.4.2 / C.4.4 ────────────────────
  console.log('\n── arrancando wiring Inngest (app server + inngest-cli dev) ──');
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(APP_PORT, '127.0.0.1', res);
  });
  console.log(`▸ app server en ${APP_URL} — ${functions.length} fns`);

  console.log('▸ arrancando inngest-cli dev …');
  // `detached` → el hijo es líder de su grupo; en el cleanup matamos el grupo
  // entero (npx + el binario inngest) para no dejar procesos huérfanos.
  devProc = spawn('npx', ['--yes', 'inngest-cli@latest', 'dev',
    '--no-discovery', '-u', APP_URL, '--port', String(DEV_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  devProc.stdout.on('data', (d) => devLog.push(d.toString()));
  devProc.stderr.on('data', (d) => devLog.push(d.toString()));
  devProc.on('error', (e) => devLog.push(`[spawn error] ${e.message}\n`));

  await waitFor('dev server arriba', async () =>
    (await fetch(`${DEV_URL}/dev`).catch(() => null))?.ok, 40_000);
  console.log('▸ dev server arriba');

  try {
    await waitFor('registro de run-arbitraje', async () =>
      (await httpJson(`${DEV_URL}/dev`)).text.includes('giolens-run-arbitraje'), 30_000);
    console.log('▸ funciones registradas en el dev server');
  } catch {
    console.warn('▸ no se pudo confirmar el registro vía /dev — se continúa');
    await sleep(3_000);
  }

  // ── C.4.2 · Disparo vía Inngest ─────────────────────────────────────────────
  const CORR = `c4-smoke-${Date.now()}`;
  console.log(`\n── C.4.2 · disparo vía Inngest: ARBITRAGE_REQUESTED (corr=${CORR}) ──`);
  const callsBeforeInngest = anthropicCalls;
  const [eventId1] = await sendEvent(EVENTS.ARBITRAGE_REQUESTED, { correlation_id: CORR });
  console.log(`  → ARBITRAGE_REQUESTED enviado (event ${eventId1})`);

  const run1 = await waitForArbitrajeRun(eventId1);
  const inngestAgentCalls1 = anthropicCalls - callsBeforeInngest;
  const analista1 = run1.output?.analista || {};
  console.log(`  · run-arbitraje #1 output.analista: ${JSON.stringify(analista1)}`);

  run1.status === 'Completed'
    ? pass('run-arbitraje #1 completó sin error')
    : fail(`run-arbitraje #1 estado = ${run1.status}`);

  analista1.error == null
    ? pass('output.analista.error nulo')
    : fail(`output.analista.error = ${analista1.error}`);

  typeof analista1.cost_usd === 'number'
    ? pass(`output.analista.cost_usd numérico (${analista1.cost_usd})`)
    : fail(`output.analista.cost_usd no numérico (${analista1.cost_usd})`);

  analista1.trace_ok === true
    ? pass('output.analista.trace_ok = true')
    : fail(`output.analista.trace_ok = ${analista1.trace_ok}`);

  Number(analista1.trace_steps) > 0
    ? pass(`output.analista.trace_steps > 0 (${analista1.trace_steps})`)
    : fail(`output.analista.trace_steps = ${analista1.trace_steps}`);

  inngestAgentCalls1 === 1
    ? pass(`agente invocado 1× vía Inngest (${inngestAgentCalls1} call Anthropic)`)
    : fail(`agente invocado ${inngestAgentCalls1}× vía Inngest (esperaba 1)`);

  // ── C.4.3 · Comparación shadow vs Inngest ───────────────────────────────────
  console.log('\n── C.4.3 · comparación shadow vs Inngest (normalizado) ──');
  // run-arbitraje expone insights como conteo (number) → normalizamos igual.
  const inngestNorm = normalizeAnalista({
    insights: analista1.insights,
    published: analista1.published,
    cost_usd: analista1.cost_usd,
    error: analista1.error || '',
  });
  console.log(`  · inngest normalizado: ${JSON.stringify(inngestNorm)}`);

  shadowNorm.insights_count === inngestNorm.insights_count
    ? pass(`insights_count equivalente (${shadowNorm.insights_count})`)
    : fail(`insights_count diverge: shadow=${shadowNorm.insights_count} inngest=${inngestNorm.insights_count}`);

  shadowNorm.published === inngestNorm.published
    ? pass(`published equivalente (${shadowNorm.published})`)
    : fail(`published diverge: shadow=${shadowNorm.published} inngest=${inngestNorm.published}`);

  shadowNorm.cost_usd === inngestNorm.cost_usd
    ? pass(`cost_usd equivalente (${shadowNorm.cost_usd})`)
    : fail(`cost_usd diverge: shadow=${shadowNorm.cost_usd} inngest=${inngestNorm.cost_usd}`);

  shadowNorm.errors_count === 0 && inngestNorm.errors_count === 0
    ? pass('ambos disparos sin errores')
    : fail(`errors_count diverge: shadow=${shadowNorm.errors_count} inngest=${inngestNorm.errors_count}`);

  // ── C.4.4 · Idempotencia cross-run (mismo correlation_id) ───────────────────
  console.log(`\n── C.4.4 · re-disparo con el MISMO correlation_id (corr=${CORR}) ──`);
  const callsBeforeRerun = anthropicCalls;
  const [eventId2] = await sendEvent(EVENTS.ARBITRAGE_REQUESTED, { correlation_id: CORR });
  console.log(`  → ARBITRAGE_REQUESTED re-enviado (event ${eventId2})`);

  const run2 = await waitForArbitrajeRun(eventId2);
  const inngestAgentCalls2 = anthropicCalls - callsBeforeRerun;
  const analista2 = run2.output?.analista || {};
  console.log(`  · run-arbitraje #2 output.analista: ${JSON.stringify(analista2)}`);

  const rerunNorm = normalizeAnalista({
    insights: analista2.insights,
    published: analista2.published,
    cost_usd: analista2.cost_usd,
    error: analista2.error || '',
  });

  run2.status === 'Completed'
    ? pass('re-run completó sin error')
    : fail(`re-run estado = ${run2.status}`);

  JSON.stringify(rerunNorm) === JSON.stringify(inngestNorm)
    ? pass(`resultado normalizado idéntico al primer run (${JSON.stringify(rerunNorm)}) — sin drift`)
    : fail(`drift entre runs: #1=${JSON.stringify(inngestNorm)} #2=${JSON.stringify(rerunNorm)}`);

  inngestAgentCalls2 === 1
    ? pass(`re-run invocó al agente exactamente 1× — sin doble invocación dentro del run (${inngestAgentCalls2} call)`)
    : fail(`re-run invocó al agente ${inngestAgentCalls2}× (esperaba 1 — doble cobro)`);

  analista2.cost_usd === analista1.cost_usd
    ? pass(`cost_usd estable entre runs (${analista2.cost_usd}) — sin doble cobro`)
    : fail(`cost_usd inestable: #1=${analista1.cost_usd} #2=${analista2.cost_usd}`);

  // ── Veredicto ───────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(62));
  if (failures.length === 0) {
    console.log('✅ C.4 SMOKE — PASS · shadow ≡ Inngest, idempotencia verificada, costo Anthropic 0');
  } else {
    console.log(`❌ C.4 SMOKE — FAIL · ${failures.length} verificación(es) fallida(s)`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\n❌ C.4 SMOKE — ERROR: ${err.message}`);
  console.error('\n── inngest-cli dev (últimas líneas) ──');
  console.error(devLog.join('').split('\n').slice(-25).join('\n'));
  process.exitCode = 1;
} finally {
  server.close();
  // Mata el grupo de procesos del dev server; espera la salida real y escala
  // a SIGKILL si no termina en 4s — no deja inngest-cli huérfano.
  if (devProc?.pid && !devProc.killed) {
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { process.kill(-devProc.pid, 'SIGKILL'); } catch { /* ya muerto */ } resolve(); }, 4_000);
      devProc.once('exit', () => { clearTimeout(t); resolve(); });
      try { process.kill(-devProc.pid, 'SIGTERM'); } catch { clearTimeout(t); resolve(); }
    });
  }
  process.exit(process.exitCode || 0);
}
