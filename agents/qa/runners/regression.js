/**
 * GioLens — Agente QA · runners/regression.js
 * Rol: Snapshots de regression. Compara el output actual de cada caso
 *      contra el snapshot previo y reporta drift.
 *
 * Política:
 *   - Los snapshots viven en /agents/qa/snapshots/{motor}__{caseId}.json.
 *   - Si el snapshot NO existe, lo crea (modo "primer run") y reporta neutral.
 *   - Si existe, hace deep-equal estricto y devuelve { drift, diff }.
 *   - El QA NUNCA sobreescribe un snapshot sin flag explícito (overwrite=true).
 *
 * TODO Fase 2: cuando llegue Supabase, persistir snapshots en BD también
 *   para tener historial y poder navegar drift en el tiempo.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SNAPSHOTS_DIR = path.resolve(__dirname, '..', 'snapshots');

/**
 * Construye el path de un snapshot dado motor + caseId.
 * Sanitiza para evitar paths peligrosos (sólo a-z, 0-9, _ y -).
 */
function snapshotPath(motor, caseId) {
  const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9_\-]/g, '_');
  return path.join(SNAPSHOTS_DIR, `${safe(motor)}__${safe(caseId)}.json`);
}

async function ensureSnapshotsDir() {
  if (!existsSync(SNAPSHOTS_DIR)) {
    await mkdir(SNAPSHOTS_DIR, { recursive: true });
  }
}

/**
 * Guarda (o sobreescribe) un snapshot. Sólo el llamador (graph o test)
 * decide si sobreescribir — el QA agente NO debe llamar esto sin aprobación.
 *
 * @param {string} motor
 * @param {string} caseId
 * @param {*} output
 * @param {{ overwrite?: boolean }} [opts]
 * @returns {Promise<{ path: string, created: boolean, overwritten: boolean }>}
 */
export async function saveSnapshot(motor, caseId, output, { overwrite = false } = {}) {
  await ensureSnapshotsDir();
  const file = snapshotPath(motor, caseId);
  const existed = existsSync(file);

  if (existed && !overwrite) {
    return { path: file, created: false, overwritten: false };
  }

  const body = JSON.stringify(
    {
      motor,
      case_id: caseId,
      saved_at: new Date().toISOString(),
      output,
    },
    null,
    2,
  );

  await writeFile(file, body, 'utf8');
  return { path: file, created: !existed, overwritten: existed && overwrite };
}

/**
 * Lee un snapshot previo. Devuelve null si no existe.
 *
 * @param {string} motor
 * @param {string} caseId
 * @returns {Promise<object|null>}
 */
export async function readSnapshot(motor, caseId) {
  const file = snapshotPath(motor, caseId);
  if (!existsSync(file)) return null;
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // Snapshot corrupto: tratamos como ausente para no romper el run.
    console.warn(`[regression] snapshot corrupto en ${file}: ${err.message}`);
    return null;
  }
}

/**
 * Deep-equal estructural mínimo (sin dependencias).
 * Suficiente para outputs JSON-serializables del harness.
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/**
 * Diff superficial: lista las keys top-level que difieren.
 * No es un diff visual completo — es un hint para el finding.
 */
function shallowDiffKeys(prev, curr) {
  if (!prev || typeof prev !== 'object' || !curr || typeof curr !== 'object') {
    return ['<non-object>'];
  }
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  const changed = [];
  for (const k of allKeys) {
    if (!deepEqual(prev[k], curr[k])) changed.push(k);
  }
  return changed;
}

/**
 * Compara output actual vs snapshot guardado.
 * - Si snapshot no existe: lo crea (primer run) y devuelve { firstRun: true }.
 * - Si existe y matchea: { drift: false }.
 * - Si existe y difiere: { drift: true, changedKeys, prev, curr }.
 *
 * @param {string} motor
 * @param {string} caseId
 * @param {*} currentOutput
 * @returns {Promise<{ drift: boolean, firstRun?: boolean, changedKeys?: string[], prev?: any, curr?: any }>}
 */
export async function compareSnapshot(motor, caseId, currentOutput) {
  const prev = await readSnapshot(motor, caseId);

  if (!prev) {
    await saveSnapshot(motor, caseId, currentOutput);
    return { drift: false, firstRun: true };
  }

  const prevOutput = prev.output;
  if (deepEqual(prevOutput, currentOutput)) {
    return { drift: false };
  }

  return {
    drift: true,
    changedKeys: shallowDiffKeys(prevOutput, currentOutput),
    prev: prevOutput,
    curr: currentOutput,
  };
}

export default {
  saveSnapshot,
  readSnapshot,
  compareSnapshot,
  deepEqual,
};
