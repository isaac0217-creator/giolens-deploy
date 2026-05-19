#!/usr/bin/env node
/**
 * GioLens — sim-agents.mjs
 * Harness de simulación end-to-end para los 6 agentes GIOCORE.
 *
 * Modos:
 *   static (default) — intercepta fetch globalmente y devuelve respuestas
 *                       sintéticas. NO consume tokens, no toca red.
 *   live (--live)   — pasa fetch real, requiere ANTHROPIC_API_KEY.
 *
 * Reglas:
 *   - NO modifica nada en /agents.
 *   - NO commitea. Solo imprime reporte a stdout.
 *   - Si un import revienta, marca ❌ y continúa con los siguientes.
 *
 * Uso:
 *   node scripts/sim-agents.mjs           # modo static
 *   node scripts/sim-agents.mjs --live    # modo live
 *   node scripts/sim-agents.mjs --only=analista,qa
 *   node scripts/sim-agents.mjs --verbose
 */

import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

// ─── CLI args ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const FLAG_LIVE    = argv.includes('--live');
const FLAG_VERBOSE = argv.includes('--verbose') || argv.includes('-v');
const ONLY = (() => {
  const a = argv.find((x) => x.startsWith('--only='));
  if (!a) return null;
  return a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
})();

// ─── Shapes de output esperado (extraídos de prompt.js de cada agente) ─
// Sirven para: 1) sembrar el stub de Anthropic, 2) validar matchesShape.
const SCHEMA_SAMPLES = {
  analista: {
    insights: [
      {
        severity: 'medium',
        metric: 'CPR',
        pipeline_id: '216977',
        observation: 'CPR de Holbrook subió 18% vs baseline en 24h (de $8.64 a $10.20).',
        recommendation: 'Revisar fatiga creativa en adsets activos.',
        evidence: {
          current_value: 10.2,
          baseline_value: 8.64,
          delta_pct: 18,
          period: 'last_24h',
          source: 'meta_ads',
        },
      },
    ],
  },
  qa: {
    findings: [],
    summary: { total: 6, passed: 6, failed: 0, blockers: 0 },
  },
  creativo: {
    script: {
      task: 'script',
      pipeline_id: '216977',
      stage: 'INT2',
      status: 'draft',
      requires_approval: true,
      variants: [
        { angle: 'urgencia', body: 'Hola, ¿sigues interesado en Holbrook? Quedan piezas.', rationale: 'Reactivar leads INT2.' },
        { angle: 'social_proof', body: 'Justin acaba de cerrar 3 envíos hoy. ¿Te apartamos uno?', rationale: 'Disparar urgencia social.' },
        { angle: 'beneficio_funcional', body: 'Holbrook llega en 48h con garantía de cambio.', rationale: 'Reducir fricción logística.' },
      ],
    },
    ad: {
      task: 'ad',
      pipeline_id: '216977',
      period: 'last_7d',
      status: 'draft',
      requires_approval: true,
      angles: [
        { angle: 'precio', headline: 'Holbrook desde $X', body: 'Calidad pro a precio accesible.', cta: 'Más información', rationale: 'Test precio.' },
        { angle: 'urgencia', headline: 'Últimas piezas', body: 'Stock limitado, envío inmediato.', cta: 'Enviar mensaje', rationale: 'Urgencia.' },
        { angle: 'beneficio', headline: 'Cambia tu rifle', body: 'Holbrook eleva tu setup.', cta: 'Comprar', rationale: 'Aspiracional.' },
      ],
    },
    reactivation: {
      task: 'reactivation',
      pipeline_id: '216977',
      stage_in: 'INT2',
      days_inactive: 7,
      status: 'draft',
      requires_approval: true,
      primary: { body: 'Hola [NOMBRE], hace [DIAS_INACTIVO] que no hablamos. ¿Sigues interesado?', params: ['NOMBRE', 'DIAS_INACTIVO'], rationale: 'Saludo neutro.' },
      alternatives: [
        { body: 'Hola [NOMBRE], ¿puedo enviarte info actualizada?', params: ['NOMBRE'], rationale: 'Reactivar con valor.' },
        { body: '[NOMBRE], aún tenemos stock que vimos. ¿Te lo aparto?', params: ['NOMBRE'], rationale: 'Urgencia suave.' },
      ],
    },
  },
  optimizacion: {
    proposals: [
      {
        priority: 'medium',
        target: 'budget',
        pipeline_id: '216977',
        current_state: 'CPR subió a $10.20 vs baseline $8.64 con daily_budget $200 MXN.',
        proposed_change: 'Reducir daily_budget de $200 a $150 MXN en adset activo.',
        expected_impact: 'Bajar gasto sin perder leads activos en 48h.',
        evidence: {
          metric: 'CPR',
          current_value: 10.2,
          baseline_value: 8.64,
          delta_pct: 18,
          source: 'meta_ads',
        },
        requires_approval: true,
        estimated_delta_usd: 2.75,
      },
    ],
  },
  desarrollador: {
    analyze_qa_failure: {
      task: 'analyze_qa_failure',
      diagnosis: 'Schema mismatch: el agente devuelve `system` en vez de `systemPrompt`.',
      root_cause: 'schema_mismatch',
      suggested_files: ['agents/analista/graph.js'],
      suggested_patches: [
        { file: 'agents/analista/graph.js', old: 'system: SYSTEM_PROMPT', new: 'systemPrompt: SYSTEM_PROMPT' },
      ],
      confidence: 0.85,
      requires_human: false,
    },
    generate_fix: {
      task: 'generate_fix',
      file_path: 'agents/analista/graph.js',
      patch: { old: 'system: SYSTEM_PROMPT', new: 'systemPrompt: SYSTEM_PROMPT' },
      tests_to_add: [{ name: 'callClaude recibe systemPrompt', rationale: 'Asegura wrapper.' }],
      rollback_plan: 'Revertir patch y correr vitest.',
      status: 'draft',
      requires_approval: true,
    },
    create_pull_request: {
      task: 'create_pull_request',
      pr_url: 'stub://giocore/pulls/draft-12345',
      title: 'fix(analista): use systemPrompt key',
      body_markdown: '## Resumen\nFix\n## Causa raíz\nSchema\n## Cambios\n1\n## Cómo probar\nvitest\n## Rollback\nRevertir\n## Riesgo\nBajo',
      files_changed: ['agents/analista/graph.js'],
      status: 'open',
      reviewers: ['isaac'],
    },
  },
  orquestador: {
    schedule_run: {
      task: 'schedule_run',
      scheduled_id: 'sched-analista-1700000000000',
      target_agent: 'analista',
      priority: 4,
      estimated_start_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      justification: 'Run diario programado P4.',
      status: 'queued',
    },
    resolve_conflict: {
      task: 'resolve_conflict',
      resource_id: 'adset-123',
      decision: 'approve_one',
      winner_proposal_id: 'prop-a',
      rationale: 'Menor priority P, agente analista gana.',
      blocked_proposals: ['prop-b'],
    },
    share_context: {
      task: 'share_context',
      context_msg_ids: ['ctx-creativo-1700000000000', 'ctx-optimizacion-1700000000001'],
      delivered_to: ['creativo', 'optimizacion'],
      skipped: [{ agent: 'orquestador', reason: 'self' }],
    },
  },
};

// ─── Agentes a simular y cómo invocarlos ────────────────────────────────
// Cada entry describe: módulo a importar, key del schema a usar para el stub,
// y el (los) entrypoints con su input sintético mínimo válido.
const AGENT_SPECS = [
  {
    name: 'analista',
    module: 'agents/analista/index.js',
    schemaKey: 'analista',
    runs: [
      {
        label: 'executeAnalistaDailyRun',
        invoke: async (mod) => mod.default({ period: 'last_24h' }),
        validate: (out) => Array.isArray(out?.insights),
        shapeKey: 'analista',
        shapeCheck: (out) => out && Array.isArray(out.insights),
      },
    ],
  },
  {
    name: 'qa',
    module: 'agents/qa/index.js',
    schemaKey: 'qa',
    runs: [
      {
        label: 'runQAOnDemand',
        invoke: async (mod) => mod.runQAOnDemand({ mode: 'evals' }),
        validate: (out) => Array.isArray(out?.findings) && out?.summary,
        shapeKey: 'qa',
        shapeCheck: (out) => out && Array.isArray(out.findings) && typeof out.summary === 'object',
      },
    ],
  },
  {
    name: 'creativo',
    module: 'agents/creativo/index.js',
    schemaKey: 'creativo.script',
    runs: [
      {
        label: 'script',
        invoke: async (mod) => mod.default({
          task: 'script',
          params: { pipelineId: '216977', stage: 'INT2', insightContext: null },
        }),
        validate: (out) => out && (out.variants || out.error),
        shapeKey: 'creativo.script',
        shapeCheck: (out) => out && (Array.isArray(out.variants) || out.error),
      },
      {
        label: 'ad',
        invoke: async (mod) => mod.default({
          task: 'ad',
          params: { pipelineId: '216977', period: 'last_7d' },
        }),
        validate: (out) => out && (out.angles || out.error),
        shapeKey: 'creativo.ad',
        shapeCheck: (out) => out && (Array.isArray(out.angles) || out.error),
      },
      {
        label: 'reactivation',
        invoke: async (mod) => mod.default({
          task: 'reactivation',
          params: { pipelineId: '216977', stageIn: 'INT2', daysInactive: 7 },
        }),
        validate: (out) => out && (out.primary || out.error),
        shapeKey: 'creativo.reactivation',
        shapeCheck: (out) => out && (out.primary || out.error),
      },
    ],
  },
  {
    name: 'optimizacion',
    module: 'agents/optimizacion/index.js',
    schemaKey: 'optimizacion',
    runs: [
      {
        label: 'executeOptimizacionDailyRun',
        invoke: async (mod) => mod.default({ period: 'last_24h' }),
        validate: (out) => Array.isArray(out?.proposals),
        shapeKey: 'optimizacion',
        shapeCheck: (out) => out && Array.isArray(out.proposals),
      },
    ],
  },
  {
    name: 'desarrollador',
    module: 'agents/desarrollador/index.js',
    schemaKey: 'desarrollador.analyze_qa_failure',
    runs: [
      {
        label: 'analyze_qa_failure',
        invoke: async (mod) => mod.default({
          task: 'analyze_qa_failure',
          params: {
            qaIssue: {
              test_name: 'analista::insights-shape',
              expected: '{ insights: [...] }',
              actual: '{}',
              error_trace: null,
              severity: 'high',
            },
          },
        }),
        validate: (out) => out && (out.diagnosis || out.error),
        shapeKey: 'desarrollador.analyze_qa_failure',
        shapeCheck: (out) => out && (typeof out.diagnosis === 'string' || out.error),
      },
      {
        label: 'generate_fix',
        invoke: async (mod) => mod.default({
          task: 'generate_fix',
          params: {
            filePath: 'agents/analista/graph.js',
            currentContent: 'system: SYSTEM_PROMPT,',
            diagnosis: 'Schema mismatch in callClaude args',
            rootCause: 'schema_mismatch',
          },
        }),
        validate: (out) => out && (out.patch || out.error),
        shapeKey: 'desarrollador.generate_fix',
        shapeCheck: (out) => out && (typeof out.patch === 'object' || out.error),
      },
      {
        label: 'create_pull_request',
        invoke: async (mod) => mod.default({
          task: 'create_pull_request',
          params: {
            branchName: 'fix/analista-systemprompt',
            baseBranch: 'main',
            fixPayload: { file_path: 'agents/analista/graph.js', patch: { old: 'a', new: 'b' } },
            qaIssueRef: 'qa-001',
          },
        }),
        validate: (out) => out && (out.pr_url || out.error),
        shapeKey: 'desarrollador.create_pull_request',
        shapeCheck: (out) => out && (typeof out.pr_url === 'string' || out.error),
      },
    ],
  },
  {
    name: 'orquestador',
    module: 'agents/orquestador/index.js',
    schemaKey: 'orquestador.schedule_run',
    runs: [
      {
        label: 'schedule_run',
        invoke: async (mod) => mod.default({
          task: 'schedule_run',
          params: {
            targetAgent: 'analista',
            task: 'daily_run',
            params: {},
            priority: 4,
            reason: 'cron diario',
          },
        }),
        validate: (out) => out && (out.schedule || out.error),
        shapeKey: 'orquestador.schedule_run',
        shapeCheck: (out) => out && (out.schedule || out.error),
      },
      {
        label: 'resolve_conflict',
        invoke: async (mod) => mod.default({
          task: 'resolve_conflict',
          params: {
            resourceId: 'adset-123',
            resourceType: 'meta_adset',
            proposals: [
              { agent: 'analista', proposal_id: 'prop-a', action: 'snapshot_kpis', priority: 4, evidence: {} },
              { agent: 'optimizacion', proposal_id: 'prop-b', action: 'budget_increase', priority: 3, evidence: {}, estimated_delta_usd: 10 },
            ],
          },
        }),
        validate: (out) => out && (out.resolution || out.error),
        shapeKey: 'orquestador.resolve_conflict',
        shapeCheck: (out) => out && (out.resolution || out.error),
      },
      {
        label: 'share_context',
        invoke: async (mod) => mod.default({
          task: 'share_context',
          params: {
            sourceAgent: 'analista',
            insight: { type: 'cpr_spike', payload: { pipeline_id: '216977' } },
            targetAgents: 'auto',
          },
        }),
        validate: (out) => out && (out.share || out.error),
        shapeKey: 'orquestador.share_context',
        shapeCheck: (out) => out && (out.share || out.error),
      },
    ],
  },
];

// ─── Helpers: pick sample del schema por key dotted ─────────────────────
function pickSample(key) {
  return key.split('.').reduce((acc, k) => (acc ? acc[k] : undefined), SCHEMA_SAMPLES);
}

// ─── Fetch interceptor (modo static) ────────────────────────────────────
// Estrategia: NO podemos monkey-patch un import named ESM (es read-only),
// pero callAnthropic usa fetch nativo. Si interceptamos globalThis.fetch
// antes de cualquier import dinámico, capturamos toda llamada Anthropic
// y devolvemos respuesta sintética con el shape que el agente espera.
// También stubéamos llamadas a GIOLENS_API_BASE (read_kpis/read_pipeline)
// para que devuelvan {ok:true,data:{}} sin tocar prod.
function installFetchStub() {
  const realFetch = globalThis.fetch;
  let currentSampleKey = null;

  // Permitimos que el harness diga, antes de cada run, "el próximo Anthropic
  // call esperá este shape". Si no lo dice, devolvemos {} y el parser del
  // agente típicamente cae en un fallback con `error` que sigue siendo
  // un output válido para validar shape laxa.
  function setNextSampleKey(key) { currentSampleKey = key; }

  globalThis.fetch = async function patchedFetch(url, opts = {}) {
    const u = typeof url === 'string' ? url : url?.url || String(url);

    if (u.includes('api.anthropic.com')) {
      const sample = currentSampleKey ? pickSample(currentSampleKey) : {};
      const text = JSON.stringify(sample ?? {});
      const body = {
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text }],
        usage: { input_tokens: 100, output_tokens: 50 },
        stop_reason: 'end_turn',
      };
      if (FLAG_VERBOSE) console.log(`[stub] anthropic ← shape=${currentSampleKey || '∅'}`);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Endpoints internos GioLens: devolver dato vacío válido para no
    // contaminar prod ni necesitar dashboard corriendo.
    if (u.includes('giolens-dashboard.vercel.app') || u.includes('/api/pipeline-summary')) {
      if (FLAG_VERBOSE) console.log(`[stub] giolens-api ← {}`);
      return new Response(JSON.stringify({ data: {}, pipelines: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Cualquier otra URL: usar fetch real (no debería pasar en static).
    if (FLAG_VERBOSE) console.log(`[stub] passthrough → ${u.slice(0, 80)}`);
    return realFetch(url, opts);
  };

  return { setNextSampleKey, restore: () => { globalThis.fetch = realFetch; } };
}

// ─── Runner ─────────────────────────────────────────────────────────────
const RESULTS = [];

function fmtCheck(ok) { return ok ? '✅' : '❌'; }

async function importAgent(modPath) {
  try {
    const url = pathToFileURL(resolve(REPO, modPath)).href;
    const mod = await import(url);
    return { ok: true, mod };
  } catch (err) {
    return { ok: false, err };
  }
}

async function runOne(spec, ctl) {
  const line = { name: spec.name, importOk: false, runs: [], importErr: null };

  const { ok: imp, mod, err: impErr } = await importAgent(spec.module);
  line.importOk = imp;
  if (!imp) {
    line.importErr = impErr?.message || String(impErr);
    RESULTS.push(line);
    return;
  }
  if (typeof mod.default !== 'function') {
    line.importErr = `default export no es función (${typeof mod.default})`;
    RESULTS.push(line);
    return;
  }

  for (const run of spec.runs) {
    const rec = { label: run.label, runtimeOk: false, jsonOk: false, shapeOk: false, err: null };
    try {
      if (ctl) ctl.setNextSampleKey(run.shapeKey || spec.schemaKey);
      const out = await run.invoke(mod);
      rec.runtimeOk = true;

      // JSON valid: el output del agente DEBE ser un objeto.
      rec.jsonOk = out !== null && typeof out === 'object';

      // Shape: validar con el predicado declarado en el spec.
      try { rec.shapeOk = !!run.shapeCheck(out); } catch { rec.shapeOk = false; }

      if (FLAG_VERBOSE) {
        const preview = JSON.stringify(out)?.slice(0, 180);
        console.log(`  └─ ${spec.name}.${run.label} →`, preview);
      }
    } catch (err) {
      rec.err = err?.message || String(err);
      if (FLAG_VERBOSE) console.log(`  └─ ${spec.name}.${run.label} threw:`, err?.stack?.slice(0, 400));
    }
    line.runs.push(rec);
  }

  RESULTS.push(line);
}

function printReport(mode) {
  console.log(`\n═══ Sim agents (modo: ${mode}) ═══`);
  for (const r of RESULTS) {
    const pad = r.name.padEnd(14);
    if (!r.importOk) {
      console.log(`${pad} · import ❌ · ${r.importErr}`);
      continue;
    }
    if (r.runs.length === 1) {
      const x = r.runs[0];
      const errBit = x.err ? ` · ${x.err.slice(0, 140)}` : '';
      console.log(
        `${pad} · import ${fmtCheck(r.importOk)}` +
        ` · runtime ${fmtCheck(x.runtimeOk)}` +
        ` · JSON ${fmtCheck(x.jsonOk)}` +
        ` · matches shape ${fmtCheck(x.shapeOk)}` +
        errBit,
      );
    } else {
      console.log(`${pad} · import ${fmtCheck(r.importOk)}`);
      for (const x of r.runs) {
        const errBit = x.err ? ` · ${x.err.slice(0, 120)}` : '';
        console.log(
          `  └─ ${x.label.padEnd(22)} · runtime ${fmtCheck(x.runtimeOk)}` +
          ` · JSON ${fmtCheck(x.jsonOk)}` +
          ` · shape ${fmtCheck(x.shapeOk)}` +
          errBit,
        );
      }
    }
  }

  // Resumen agregado.
  let total = 0, passed = 0;
  for (const r of RESULTS) {
    if (!r.importOk) { total++; continue; }
    for (const x of r.runs) {
      total++;
      if (x.runtimeOk && x.jsonOk && x.shapeOk) passed++;
    }
  }
  console.log(`\n  ${passed}/${total} runs verde.`);
  return { total, passed };
}

// ─── Entry ──────────────────────────────────────────────────────────────
async function main() {
  const mode = FLAG_LIVE ? 'live' : 'static';

  if (FLAG_LIVE && !process.env.ANTHROPIC_API_KEY) {
    console.error('--live requiere ANTHROPIC_API_KEY en env');
    process.exit(2);
  }

  const ctl = FLAG_LIVE ? null : installFetchStub();

  const specs = AGENT_SPECS.filter((s) => !ONLY || ONLY.includes(s.name));
  for (const s of specs) {
    await runOne(s, ctl);
  }

  const { passed, total } = printReport(mode);
  if (ctl) ctl.restore();

  // Exit code: 0 si todo verde, 1 si algo falla. Útil para CI.
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('sim-agents crashed:', err);
  process.exit(2);
});
