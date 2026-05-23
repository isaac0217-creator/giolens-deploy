/// <reference types="node" />
/**
 * GIOCORE Frente C — Cron horario de enriquecimiento de `contacts` vía
 * `GET /api/contacts/{contact_id}` Wapify.
 *
 * Spec: PROMPT_CODE_LOTE_v2.md §FRENTE C (T7-T9).
 *
 * Trigger: vercel.json crons "0 * * * *" (top of every hour).
 *
 * Query params:
 *   - `?batch_size=50`: contact_ids únicos a procesar este run. Default 50.
 *   - `?throttle_ms=1500`: sleep entre requests Wapify. Default 1500 (~40 req/min).
 *   - `?dry_run=1`: simula sin escribir UPDATE en `contacts`.
 *
 * Auth: header `Authorization: Bearer ${CRON_SECRET}`.
 *
 * Persistencia:
 *   - `contacts` (UPDATE name/phone/email/enriched_at por contact_id).
 *   - `contacts.contact_id_invalid = true` para 404 huérfanos (no se reintenta).
 *   - `agent_decisions` (1 fila por run con stats).
 *
 * Estrategia: cron horario procesa batch=50 con throttle 1.5s ≈ 75s/run.
 * Con ~4,700 contact_ids únicos → ~94 runs ≈ 4 días backfill completo.
 * Aceptable según PROMPT_CODE_LOTE_v2 §T8.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { enrichContacts } from '../../agents/_shared/providers/wapify-enrich.js';
import type { EnrichResult } from '../../agents/_shared/providers/wapify-enrich.js';

/* ── Tipos handler (compatibles con Vercel Node 22 runtime) ─────────────── */

interface VercelLikeReq {
  url?: string;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}
interface VercelLikeRes {
  status(code: number): VercelLikeRes;
  json(body: unknown): VercelLikeRes;
  end(): void;
  setHeader?(name: string, value: string): VercelLikeRes;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function buildSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL no está definido en el entorno');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no está definido en el entorno');
  return createClient(url, key, { auth: { persistSession: false } });
}

function readQueryParam(req: VercelLikeReq, name: string): string | null {
  if (req.query) {
    const v = req.query[name];
    if (Array.isArray(v)) return v[0] ?? null;
    if (typeof v === 'string') return v;
  }
  if (req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      return u.searchParams.get(name);
    } catch {
      return null;
    }
  }
  return null;
}

function readNumberParam(req: VercelLikeReq, name: string, fallback: number): number {
  const v = readQueryParam(req, name);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isDryRun(req: VercelLikeReq): boolean {
  const v = readQueryParam(req, 'dry_run');
  return v === '1' || v === 'true';
}

async function logAgentDecision(
  supabase: SupabaseClient,
  result: EnrichResult,
  dryRun: boolean,
): Promise<void> {
  // decision_key idempotente por hora — si el cron corre 2 veces la misma hora,
  // el upsert actualiza la fila existente (UNIQUE en migración 004).
  const hourBucket = new Date().toISOString().slice(0, 13); // "2026-05-22T22"
  const decisionKey = `enrich_contacts_${hourBucket}`;
  const status =
    result.failed > 0 || result.rate_limited_retries > 0 ? 'pending' : 'auto_approved';
  const severity =
    result.failed > 5 ? 0.7 : result.failed > 0 ? 0.4 : result.rate_limited_retries > 0 ? 0.3 : 0.1;

  await supabase.from('agent_decisions').upsert(
    {
      agent_name: 'cron_enrich_contacts',
      decision_type: 'wapify_contacts_enrichment',
      proposed_action: {
        processed: result.processed,
        enriched: result.enriched,
        invalid: result.invalid,
        failed: result.failed,
        rate_limited_retries: result.rate_limited_retries,
        dry_run: dryRun,
      },
      justification: `Enrich run @ ${hourBucket}:00Z — ${result.enriched} enriched, ${result.failed} failed, ${result.invalid} invalid.`,
      evidence_refs: { notes: result.notes.slice(0, 10) },
      severity,
      status,
      decision_key: decisionKey,
    },
    { onConflict: 'decision_key' },
  );
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  // 1 · Auth
  const auth = req.headers.authorization;
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    res.status(401).end();
    return;
  }

  const dryRun = isDryRun(req);
  const batchSize = readNumberParam(req, 'batch_size', 50);
  const throttleMs = readNumberParam(req, 'throttle_ms', 1500);

  const supabase = buildSupabaseClient();

  let result: EnrichResult;
  try {
    result = await enrichContacts(supabase, {
      batchSize,
      throttleMs,
      dry_run: dryRun,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cron/enrich-contacts] enrichContacts lanzó: ${msg}`);
    try {
      await supabase.from('agent_decisions').insert({
        agent_name: 'cron_enrich_contacts',
        decision_type: 'wapify_contacts_enrichment',
        proposed_action: { error: msg, dry_run: dryRun },
        justification: `Cron lanzó excepción: ${msg}`,
        severity: 0.9,
        status: 'pending',
      });
    } catch {
      /* swallow logging error */
    }
    res.status(500).json({ ok: false, error: msg });
    return;
  }

  console.log(
    `[cron/enrich-contacts] processed=${result.processed} enriched=${result.enriched} invalid=${result.invalid} failed=${result.failed} retries=${result.rate_limited_retries} dry_run=${dryRun}`,
  );

  try {
    await logAgentDecision(supabase, result, dryRun);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.notes.push(`agent_decisions log fallo: ${msg}`);
  }

  res.status(200).json({
    ok: true,
    dry_run: dryRun,
    batch_size: batchSize,
    throttle_ms: throttleMs,
    ...result,
  });
}
