#!/usr/bin/env node
/**
 * GioLens — Run All Evals
 * Entry point: corre los 5 motores + el agente Analista.
 * Exit code 0 si todo pasa, 1 si algo falla.
 *
 * Uso:
 *   node evals/run-all.js
 *   LIVE=1 node evals/run-all.js          (hits Anthropic — requiere ANTHROPIC_API_KEY)
 *   node evals/run-all.js --motor=216977  (solo un motor)
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadGolden, runEval, prettyPrint } from './harness.js';
import { getMotorAdapter } from './runners/motor-runner.js';
import { getAnalistaAdapter } from './runners/agente-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const SUITES = [
  { name: 'Motor #1 Justin/Holbrook', file: 'golden/motor-justin-holbrook.json', kind: 'motor', key: '216977' },
  { name: 'Motor #2 GioSports',       file: 'golden/motor-giosports.json',       kind: 'motor', key: '755062' },
  { name: 'Motor #3 SPY Z87',         file: 'golden/motor-spy-z87.json',         kind: 'motor', key: '252999' },
  { name: 'Motor #4 Dama Luxury',     file: 'golden/motor-dama-luxury.json',     kind: 'motor', key: '94103' },
  { name: 'Motor #5 GioVision',       file: 'golden/motor-giovision.json',       kind: 'motor', key: '273944' },
  { name: 'Agente Analista (Fase 3)', file: 'golden/agente-analista.json',       kind: 'agente', key: 'analista' },
];

function parseArgs() {
  const filter = {};
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--motor=')) filter.motor = a.slice('--motor='.length);
  }
  return filter;
}

async function main() {
  const args = parseArgs();
  let totalCases = 0, totalPassed = 0, totalFailed = 0;
  const summaries = [];

  for (const suite of SUITES) {
    if (args.motor && suite.key !== args.motor) continue;
    const goldenPath = path.resolve(__dirname, suite.file);
    const golden = await loadGolden(goldenPath);

    const adapter = suite.kind === 'motor'
      ? getMotorAdapter(suite.key)
      : getAnalistaAdapter();

    console.log(`\n┌─ ${suite.name} (${golden.cases.length} casos) ─`);
    const result = await runEval(adapter, golden);
    prettyPrint(result);

    totalCases  += result.total;
    totalPassed += result.passed;
    totalFailed += result.failed;
    summaries.push({ suite: suite.name, ...result });
  }

  console.log(`\n══════════════════════════════════════════════`);
  console.log(`TOTAL: ${totalPassed}/${totalCases} pass · ${totalFailed} fail`);
  console.log(`══════════════════════════════════════════════`);
  for (const s of summaries) {
    const icon = s.failed === 0 ? '[ok]  ' : '[FAIL]';
    console.log(`  ${icon} ${s.suite}: ${s.passed}/${s.total}`);
  }

  if (totalFailed > 0) process.exit(1);
  process.exit(0);
}

main().catch(err => {
  console.error('[run-all] error fatal:', err);
  process.exit(2);
});
