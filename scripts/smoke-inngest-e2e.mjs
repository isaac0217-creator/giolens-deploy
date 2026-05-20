#!/usr/bin/env node
/**
 * GioLens — Frente C · C.2.6 · Smoke E2E del wiring Inngest
 *
 * Levanta el dev server local de Inngest (`inngest-cli dev`) + un servidor HTTP
 * que sirve las 8 funciones canónicas (api/inngest.js → `functions`) y verifica
 * el flujo de reactivación end-to-end con un correlation_id compartido:
 *
 *   message_received  ──►  (observador)
 *   silence_detected  ──►  send-reactivation  ──►  reactivation_sent
 *
 * Criterio de éxito C.2.6 (docs/frente_c_plan_v2.md):
 *   las 3 invocaciones aparecen, comparten el mismo correlation_id, y el run
 *   termina sin errores con dry_run=true.
 *
 * Escenario 2: regla inviolable — un silence_detected de un pipeline prohibido
 * (252999 SPY) NO produce reactivation_sent, emite blocker_violation.
 *
 * Modo del smoke (sin costo Anthropic, sin efectos Wapify):
 *   - REACTIVATION_DRY_RUN=true               → wapify-send no envía nada real
 *   - LEGACY_SEND_REACTIVATION_ENABLED=false  → ruta al agente Creativo
 *   - fetch a api.anthropic.com interceptado  → respuesta sintética, costo 0
 *     (mismo patrón que scripts/sim-agents.mjs modo static)
 *   - WAPIFY_TOKEN ausente                    → sin llamadas reales a Wapify
 *
 * La verificación es in-process: las funciones (y los observadores que añade
 * este smoke) corren en este mismo proceso cuando el dev server las invoca, así
 * que `observed` se puebla directamente — sin scrapear la API del dev server.
 *
 * Uso:  node scripts/smoke-inngest-e2e.mjs   ·   npm run smoke:inngest
 * Requisitos: inngest-cli (se invoca vía `npx inngest-cli@latest dev`).
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// ─── Configuración (env ANTES de importar el wiring Inngest) ──────────────────
const APP_PORT = Number(process.env.SMOKE_APP_PORT || 3939);
const DEV_PORT = Number(process.env.SMOKE_DEV_PORT || 8288);
const APP_PATH = '/api/inngest';
const APP_URL  = `http://127.0.0.1:${APP_PORT}${APP_PATH}`;
const DEV_URL  = `http://127.0.0.1:${DEV_PORT}`;

process.env.INNGEST_DEV          = DEV_URL;   // modo dev: sin verificación de firma
process.env.INNGEST_EVENT_KEY    = process.env.INNGEST_EVENT_KEY || 'smoke-e2e';
process.env.REACTIVATION_DRY_RUN = 'true';
process.env.LEGACY_SEND_REACTIVATION_ENABLED = 'false';
// callAnthropic corta si no hay key → key dummy para pasar el gate; el fetch
// real lo intercepta el stub de abajo, así que nunca sale a la red (costo 0).
process.env.ANTHROPIC_API_KEY    = 'sk-ant-smoke-e2e-stub-no-network';
delete process.env.WAPIFY_TOKEN;
delete process.env.INNGEST_SIGNING_KEY;        // dev mode no la necesita

// ─── Stub de fetch (modo static, igual que sim-agents.mjs) ────────────────────
// Intercepta api.anthropic.com y devuelve una respuesta sintética con el shape
// que el agente Creativo espera (task=reactivation). Todo lo demás pasa directo.
const REACTIVATION_SAMPLE = {
  task: 'reactivation', pipeline_id: '216977', stage_in: 'INT2', days_inactive: 7,
  status: 'draft', requires_approval: true,
  primary: {
    body: 'Hola [NOMBRE], hace [DIAS_INACTIVO] que no hablamos. ¿Sigues interesado?',
    params: ['NOMBRE', 'DIAS_INACTIVO'], rationale: 'Saludo neutro.',
  },
  alternatives: [
    { body: 'Hola [NOMBRE], ¿puedo enviarte info actualizada?', params: ['NOMBRE'], rationale: 'Reactivar con valor.' },
  ],
};
const _realFetch = globalThis.fetch;
globalThis.fetch = async function smokeFetch(url, opts = {}) {
  const u = typeof url === 'string' ? url : url?.url || String(url);
  if (u.includes('api.anthropic.com')) {
    const body = {
      id: 'msg_smoke_stub', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: JSON.stringify(REACTIVATION_SAMPLE) }],
      usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'end_turn',
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return _realFetch(url, opts);
};

// Importes dinámicos: el wiring lee process.env al cargar el módulo.
const { serve }      = await import('inngest/node');
const { inngest }    = await import('../inngest/client.js');
const { functions }  = await import('../api/inngest.js');

// ─── Observadores (solo del smoke) — capturan los eventos del flujo ───────────
const observed = {
  'giolens/lead.message_received':   [],
  'giolens/lead.silence_detected':   [],
  'giolens/lead.reactivation_sent':  [],
  'giolens/agent.blocker_violation': [],
};

function observer(eventName) {
  const key = eventName.replace(/[^a-z]/gi, '-');
  return inngest.createFunction(
    { id: `smoke-observer-${key}` },
    { event: eventName },
    async ({ event }) => {
      const rec = { correlation_id: event.data?.correlation_id ?? null, data: event.data, at: Date.now() };
      observed[eventName].push(rec);
      console.log(`  [observer] ${eventName} ← corr=${rec.correlation_id}`);
      return { observed: eventName };
    },
  );
}

const observers = Object.keys(observed).map(observer);

// ─── Servidor HTTP que expone las funciones al dev server ─────────────────────
const handler = serve({ client: inngest, functions: [...functions, ...observers] });
const server  = http.createServer((req, res) => handler(req, res));

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function httpText(url, opts) {
  const r = await fetch(url, opts);
  return { status: r.status, text: await r.text() };
}

async function waitFor(label, predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return true; } catch { /* reintenta */ }
    await sleep(intervalMs);
  }
  throw new Error(`timeout esperando: ${label} (${timeoutMs}ms)`);
}

async function sendEvent(name, data) {
  const r = await httpText(`${DEV_URL}/e/${process.env.INNGEST_EVENT_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, data }),
  });
  if (r.status >= 300) throw new Error(`sendEvent ${name} → HTTP ${r.status}: ${r.text}`);
}

// ─── Ejecución ────────────────────────────────────────────────────────────────
let devProc;
const devLog = [];
const failures = [];
const fail = (m) => { failures.push(m); console.error(`  ✗ ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);

console.log('═══ C.2.6 · Smoke E2E del wiring Inngest ═══\n');

try {
  // Pre-flight: el puerto del dev server debe estar libre.
  const busy = await fetch(`${DEV_URL}/dev`).then((r) => r.ok).catch(() => false);
  if (busy) throw new Error(`puerto ${DEV_PORT} ya ocupado — ¿hay otro inngest-cli dev corriendo?`);

  // 1. Servidor de la app.
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(APP_PORT, '127.0.0.1', res);
  });
  console.log(`▸ app server en ${APP_URL} — ${functions.length} fns + ${observers.length} observers`);

  // 2. inngest-cli dev.
  console.log('▸ arrancando inngest-cli dev …');
  // `detached` → el hijo es líder de su grupo; en el cleanup matamos el grupo
  // entero (npx + el binario inngest) para no dejar procesos huérfanos.
  devProc = spawn('npx', ['--yes', 'inngest-cli@latest', 'dev',
    '--no-discovery', '-u', APP_URL, '--port', String(DEV_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  devProc.stdout.on('data', (d) => devLog.push(d.toString()));
  devProc.stderr.on('data', (d) => devLog.push(d.toString()));
  devProc.on('error', (e) => devLog.push(`[spawn error] ${e.message}\n`));

  // 3. Esperar a que el dev server responda.
  await waitFor('dev server arriba', async () =>
    (await fetch(`${DEV_URL}/dev`).catch(() => null))?.ok, 40_000);
  console.log('▸ dev server arriba');

  // 4. Esperar el registro de las funciones (best-effort: el gate real es la cascada).
  try {
    await waitFor('registro de send-reactivation', async () =>
      (await httpText(`${DEV_URL}/dev`)).text.includes('giolens-send-reactivation'), 30_000);
    console.log('▸ funciones registradas en el dev server');
  } catch {
    console.warn('▸ no se pudo confirmar el registro vía /dev — se continúa (la cascada lo valida)');
    await sleep(3_000);
  }

  // ── Escenario 1: cascada feliz ──────────────────────────────────────────────
  const CORR = `c26-smoke-${Date.now()}`;
  const contactId = 'smoke-contact-001';
  console.log(`\n── Escenario 1: cascada de reactivación (corr=${CORR}) ──`);

  await sendEvent('giolens/lead.message_received', {
    correlation_id: CORR, contact_id: contactId, pipeline_id: '216977',
    stage_name: 'INTERÉS', message_text: 'hola, sigo interesado',
    received_at: Date.now(), sender: 'lead',
  });
  console.log('  → message_received enviado');

  await sendEvent('giolens/lead.silence_detected', {
    correlation_id: CORR, contact_id: contactId, pipeline_id: '216977',
    stage_name: 'INTERÉS', silence_ms: 6 * 60 * 1000,
    last_interaction: Date.now() - 6 * 60 * 1000, last_sent: Date.now() - 5 * 60 * 1000,
  });
  console.log('  → silence_detected enviado');

  // send-reactivation tiene jitter 0-10s + retries → margen amplio.
  await waitFor('reactivation_sent emitido', () =>
    observed['giolens/lead.reactivation_sent'].some((r) => r.correlation_id === CORR), 50_000);

  console.log('\n── Verificaciones C.2.6 ──');
  const mr = observed['giolens/lead.message_received'].filter((r) => r.correlation_id === CORR);
  const sd = observed['giolens/lead.silence_detected'].filter((r) => r.correlation_id === CORR);
  const rs = observed['giolens/lead.reactivation_sent'].filter((r) => r.correlation_id === CORR);

  mr.length === 1 ? pass('message_received visto')  : fail(`message_received: esperaba 1, vi ${mr.length}`);
  sd.length === 1 ? pass('silence_detected visto')  : fail(`silence_detected: esperaba 1, vi ${sd.length}`);
  rs.length === 1 ? pass('reactivation_sent visto') : fail(`reactivation_sent: esperaba 1, vi ${rs.length}`);
  (mr.length && sd.length && rs.length)
    ? pass(`las 3 invocaciones comparten correlation_id (${CORR})`)
    : fail('las 3 invocaciones NO comparten correlation_id');

  const d = rs[0]?.data || {};
  d.dry_run === true       ? pass('reactivation_sent.dry_run = true')           : fail(`dry_run = ${d.dry_run}`);
  d.pipeline_id === '216977' ? pass('pipeline_id propagado (216977)')           : fail(`pipeline_id = ${d.pipeline_id}`);
  d.script_preview         ? pass(`script_preview poblado ("${String(d.script_preview).slice(0, 40)}…")`)
                           : fail('script_preview vacío');

  // ── Escenario 2: regla inviolable (pipeline prohibido) ──────────────────────
  const CORR_BLK = `c26-smoke-blk-${Date.now()}`;
  console.log(`\n── Escenario 2: regla inviolable · SPY 252999 (corr=${CORR_BLK}) ──`);
  await sendEvent('giolens/lead.silence_detected', {
    correlation_id: CORR_BLK, contact_id: 'smoke-contact-spy', pipeline_id: '252999',
    stage_name: 'INTERÉS', silence_ms: 6 * 60 * 1000,
    last_interaction: Date.now(), last_sent: Date.now(),
  });
  console.log('  → silence_detected (252999) enviado');

  await waitFor('blocker_violation emitido', () =>
    observed['giolens/agent.blocker_violation']
      .some((r) => String(r.correlation_id || '').startsWith(CORR_BLK)), 25_000).catch(() => {});

  const blk = observed['giolens/agent.blocker_violation']
    .filter((r) => String(r.correlation_id || '').startsWith(CORR_BLK));
  const rsSpy = observed['giolens/lead.reactivation_sent'].filter((r) => r.correlation_id === CORR_BLK);
  blk.length >= 1   ? pass('blocker_violation emitido para 252999')        : fail('NO se emitió blocker_violation para 252999');
  rsSpy.length === 0 ? pass('cero reactivation_sent para el pipeline prohibido') : fail(`¡fuga! ${rsSpy.length} INT en 252999`);

  // ── Veredicto ───────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(62));
  if (failures.length === 0) {
    console.log('✅ C.2.6 SMOKE E2E — PASS · cascada Inngest verificada, sin errores');
  } else {
    console.log(`❌ C.2.6 SMOKE E2E — FAIL · ${failures.length} verificación(es) fallida(s)`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\n❌ C.2.6 SMOKE E2E — ERROR: ${err.message}`);
  console.error('\n── observed ──');
  for (const [k, v] of Object.entries(observed)) console.error(`   ${k}: ${v.length}`);
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
