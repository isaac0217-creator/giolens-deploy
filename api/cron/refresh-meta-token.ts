/**
 * GIOCORE Frente D.2 — Cron diario que verifica el estado del token Meta.
 *
 * Spec: BRIEF_CODE_FRENTE_D2.md §refresh-meta-token.
 *
 * Trigger: vercel.json crons "0 13 * * *" (1h después del cron de provider_usage,
 * para diagnosticar a tiempo si el fetch de Meta cayó por token expirado).
 *
 * Comportamiento:
 *   - Llama `checkMetaToken()` (providers/meta-token.ts).
 *   - Persiste decisión en `agent_decisions` con shape real del schema (002).
 *   - Severidad y status mapeados según token status (severityForStatus).
 *   - NO escribe `.env.local` ni rota el token (entorno serverless ephemeral).
 *   - Si el token está expirado/por-expirar/inválido, marca la decisión como
 *     `pending` (acción humana requerida) en vez de `auto_approved`.
 *
 * Query param opcional `?dry_run=1`:
 *   - Hace el probe y devuelve el resultado, pero NO inserta en agent_decisions.
 *   - Útil para verificación manual sin contaminar la tabla.
 */

import { createClient } from '@supabase/supabase-js';
import {
  checkMetaToken,
  severityForStatus,
  statusNeedsAction,
} from '../../agents/_shared/providers/meta-token.js';
import type { MetaTokenCheckResult } from '../../agents/_shared/providers/meta-token.js';

/* ── Tipos mínimos handler (sin dep en @vercel/node) ────────────────────── */

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

function buildSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL no está definido en el entorno');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no está definido en el entorno');
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Lee `?dry_run=1` desde req.query o desde la URL string. */
function isDryRun(req: VercelLikeReq): boolean {
  // Vercel inyecta `req.query` para handlers Node; igual hacemos fallback a URL parsing
  if (req.query) {
    const v = req.query.dry_run;
    if (Array.isArray(v)) return v.includes('1') || v.includes('true');
    if (typeof v === 'string') return v === '1' || v === 'true';
  }
  if (req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const v = u.searchParams.get('dry_run');
      return v === '1' || v === 'true';
    } catch {
      return false;
    }
  }
  return false;
}

function justificationFor(result: MetaTokenCheckResult): string {
  const tail =
    result.expires_at != null
      ? ` (META_TOKEN_EXPIRES=${result.expires_at}, daysLeft=${result.days_left})`
      : '';
  switch (result.status) {
    case 'ok':
      return `Token Meta vigente${tail}.`;
    case 'expiring_soon':
      return `Token Meta vence pronto${tail}. Regenerar en Business Manager y rotar env.`;
    case 'expired':
      return `Token Meta EXPIRADO${tail}. Cron provider_usage está caído hasta rotar.`;
    case 'invalid':
      return `Token Meta inválido (probe a /me falló): ${result.raw.error ?? 'sin detalle'}.`;
    case 'unknown':
      return `Estado del token Meta no determinable: ${result.raw.error ?? 'sin META_TOKEN_EXPIRES'}.`;
  }
}

function statusFieldFor(tokenStatus: MetaTokenCheckResult['status']): string {
  // agent_decisions.status CHECK: pending|approved|rejected|auto_approved|expired
  return statusNeedsAction(tokenStatus) ? 'pending' : 'auto_approved';
}

/* ── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(
  req: VercelLikeReq,
  res: VercelLikeRes,
): Promise<void> {
  // 1 · Auth (Bearer CRON_SECRET) — igual patrón que fetch-provider-usage.ts
  const auth = req.headers.authorization;
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    res.status(401).end();
    return;
  }

  const dryRun = isDryRun(req);

  // 2 · Verificar token (probe a Graph API + cruce con META_TOKEN_EXPIRES)
  let result: MetaTokenCheckResult;
  try {
    result = await checkMetaToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/refresh-meta-token] checkMetaToken lanzó:', msg);
    res.status(500).json({ ok: false, error: msg });
    return;
  }

  console.log(
    `[cron/refresh-meta-token] status=${result.status} days_left=${result.days_left} dry_run=${dryRun}`,
  );

  // 3 · Si dry_run → devolver sin insertar en agent_decisions.
  if (dryRun) {
    res.status(200).json({
      ok: true,
      dry_run: true,
      token_status: result.status,
      days_left: result.days_left,
      expires_at: result.expires_at,
      probe: result.probe,
      action_required: statusNeedsAction(result.status),
    });
    return;
  }

  // 4 · Persistir decisión
  let supabase: ReturnType<typeof buildSupabaseClient>;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/refresh-meta-token] No se pudo construir cliente Supabase:', msg);
    res.status(500).json({ ok: false, error: msg });
    return;
  }

  // decision_key idempotente por día + status — evita spam si corre 2 veces el mismo día.
  const today = new Date().toISOString().slice(0, 10);
  const decisionKey = `meta_token_check_${today}_${result.status}`;

  const row = {
    agent_name: 'cron_refresh_meta_token',
    decision_type: 'meta_token_health_check',
    proposed_action: {
      action: statusNeedsAction(result.status) ? 'rotate_meta_token' : 'noop',
      token_status: result.status,
      days_left: result.days_left,
      expires_at: result.expires_at,
      runbook: 'STATUS_CORE_22may_PM.md §B2 · Meta Business Manager → System Users → generate token → vercel env rm/add.',
    },
    justification: justificationFor(result),
    evidence_refs: {
      probe: result.probe,
      raw: result.raw,
      checked_at: new Date().toISOString(),
    },
    severity: severityForStatus(result.status),
    status: statusFieldFor(result.status),
    decision_key: decisionKey,
  };

  // Upsert por decision_key (índice único parcial creado en migración 002).
  const { error } = await supabase
    .from('agent_decisions')
    .upsert(row, { onConflict: 'decision_key' });

  if (error) {
    console.error(
      '[cron/refresh-meta-token] No se pudo persistir decisión en agent_decisions:',
      error.message,
    );
    res.status(500).json({
      ok: false,
      error: error.message,
      token_status: result.status,
    });
    return;
  }

  res.status(200).json({
    ok: true,
    token_status: result.status,
    days_left: result.days_left,
    expires_at: result.expires_at,
    action_required: statusNeedsAction(result.status),
    decision_key: decisionKey,
    decision_status: row.status,
  });
}
