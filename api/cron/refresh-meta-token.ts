/// <reference types="node" />
/**
 * GIOCORE Frente B — Cron diario de health-check + auto-refresh del token Meta.
 *
 * Spec original (D.2): `BRIEF_CODE_FRENTE_D2.md §refresh-meta-token` (diagnose-only).
 * Spec actualizada (Frente B): `PROMPT_CODE_LOTE_v2.md §FRENTE B` (auto-refresh real).
 *
 * Trigger: vercel.json crons "0 13 * * *" (07:00 MX).
 *
 * Comportamiento:
 *   1. `checkMetaToken()` → diagnóstico.
 *   2. Si `days_left < AUTO_REFRESH_DAYS` (14) y NO dry_run:
 *        a. `extendLongLivedToken()` → token nuevo + expires_at.
 *        b. `updateProductionEnvVar(META_TOKEN)` + `updateProductionEnvVar(META_TOKEN_EXPIRES)`.
 *        c. agent_decisions con `decision_type='token_refresh'`, severity 0.1 si OK
 *           o 0.8 si Vercel sync falló (token regenerado pero no persistido).
 *   3. En cualquier otro caso (>=14 días, ok, dry_run): flow original health_check.
 *
 * Seguridad:
 *   - Cache-Control: no-store en TODAS las respuestas (CDN cache risk del token).
 *   - Tokens en logs / agent_decisions enmascarados via `maskToken()`.
 *   - Response body NUNCA incluye el token completo (solo masked + envId Vercel).
 *
 * Idempotencia:
 *   - decision_key="meta_token_refresh_{YYYY-MM-DD}" para refresh runs.
 *   - decision_key="meta_token_check_{YYYY-MM-DD}_{status}" para health_check runs.
 *   - UNIQUE(decision_key) en migración 004 → 2 runs el mismo día con mismo outcome upsert.
 *   - Si days_left>=14 el día de un refresh → no llama a Meta, decisión health_check OK.
 */

import { createClient } from '@supabase/supabase-js';
import {
  AUTO_REFRESH_DAYS,
  checkMetaToken,
  extendLongLivedToken,
  maskToken,
  severityForStatus,
  statusNeedsAction,
} from '../../agents/_shared/providers/meta-token.js';
import type { MetaTokenCheckResult } from '../../agents/_shared/providers/meta-token.js';
import { updateProductionEnvVar } from '../../agents/_shared/providers/vercel-env.js';

/* ── Tipos handler ──────────────────────────────────────────────────────── */

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

function setNoStore(res: VercelLikeRes): void {
  if (typeof res.setHeader === 'function') {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
  }
}

function isDryRun(req: VercelLikeReq): boolean {
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
      return `Token Meta vence pronto${tail}. Auto-refresh debería haber actuado; verificar.`;
    case 'expired':
      return `Token Meta EXPIRADO${tail}. Auto-refresh falló o no se intentó (sin currentToken válido).`;
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
  setNoStore(res);

  // 1 · Auth (Bearer CRON_SECRET)
  const auth = req.headers.authorization;
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    res.status(401).end();
    return;
  }

  const dryRun = isDryRun(req);

  // 2 · checkMetaToken — diagnóstico actual.
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

  // 3 · Dry run → reportar sin tocar DB / sin refrescar.
  if (dryRun) {
    res.status(200).json({
      ok: true,
      dry_run: true,
      action: 'no-op',
      token_status: result.status,
      days_left: result.days_left,
      expires_at: result.expires_at,
      probe: result.probe,
      action_required: statusNeedsAction(result.status),
    });
    return;
  }

  // 4 · Decidir flujo: refresh vs health_check.
  // Refresh solo si: status != 'invalid' (no tenemos token usable),
  //                 days_left no es null,
  //                 days_left < AUTO_REFRESH_DAYS,
  //                 META_APP_ID + META_APP_SECRET + META_TOKEN presentes.
  const currentToken = process.env.META_TOKEN;
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const canAttemptRefresh =
    result.status !== 'invalid' &&
    result.days_left !== null &&
    result.days_left < AUTO_REFRESH_DAYS &&
    !!currentToken &&
    !!appId &&
    !!appSecret;

  let supabase: ReturnType<typeof buildSupabaseClient>;
  try {
    supabase = buildSupabaseClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron/refresh-meta-token] buildSupabaseClient falló:', msg);
    res.status(500).json({ ok: false, error: msg });
    return;
  }

  // 5 · RAMA REFRESH ────────────────────────────────────────────────────
  if (canAttemptRefresh) {
    const today = new Date().toISOString().slice(0, 10);
    const decisionKey = `meta_token_refresh_${today}`;
    const oldMasked = maskToken(currentToken);

    // 5.a · Pre-checks: si falta secret, registrar pending sin llamar a Meta.
    if (!appSecret || !appId) {
      const row = {
        agent_name: 'cron_refresh_meta_token',
        decision_type: 'token_refresh',
        proposed_action: {
          action: 'refresh_blocked_missing_credentials',
          missing: [!appId && 'META_APP_ID', !appSecret && 'META_APP_SECRET'].filter(Boolean),
          old_token_masked: oldMasked,
        },
        justification:
          'No se puede auto-refrescar: META_APP_ID o META_APP_SECRET faltantes en env.',
        severity: 0.8,
        status: 'pending',
        decision_key: decisionKey,
      };
      await supabase.from('agent_decisions').upsert(row, { onConflict: 'decision_key' });
      res.status(200).json({
        ok: true,
        action: 'refresh_blocked_missing_credentials',
        token_status: result.status,
        days_left: result.days_left,
        decision_key: decisionKey,
        decision_status: 'pending',
      });
      return;
    }

    // 5.b · Llamar a Meta para extender.
    // currentToken / appId / appSecret se aseguran arriba por canAttemptRefresh + early return.
    const ext = await extendLongLivedToken(currentToken as string, appId as string, appSecret as string);

    if (!ext.ok || !ext.token) {
      const row = {
        agent_name: 'cron_refresh_meta_token',
        decision_type: 'token_refresh',
        proposed_action: {
          action: 'refresh_failed_meta_api',
          old_token_masked: oldMasked,
          meta_error: ext.error ?? null,
        },
        justification: `Meta API rechazó el fb_exchange_token: ${ext.error?.message ?? 'sin detalle'} (code=${ext.error?.code ?? 'n/a'}).`,
        severity: 0.9,
        status: 'pending',
        decision_key: decisionKey,
      };
      await supabase.from('agent_decisions').upsert(row, { onConflict: 'decision_key' });
      res.status(200).json({
        ok: false,
        action: 'refresh_failed_meta_api',
        token_status: result.status,
        days_left: result.days_left,
        meta_error_code: ext.error?.code ?? null,
        decision_key: decisionKey,
        decision_status: 'pending',
      });
      return;
    }

    // 5.c · Persistir en Vercel env (META_TOKEN + META_TOKEN_EXPIRES).
    const vercelToken = process.env.VERCEL_TOKEN ?? '';
    const projectId = process.env.VERCEL_PROJECT_ID ?? '';
    const newMasked = maskToken(ext.token);

    const tokenSync = await updateProductionEnvVar('META_TOKEN', ext.token, {
      token: vercelToken,
      projectId,
    });
    const expiresIso = ext.expires_at ?? '';
    const expSync = expiresIso
      ? await updateProductionEnvVar('META_TOKEN_EXPIRES', expiresIso, {
          token: vercelToken,
          projectId,
        })
      : { success: false, error: 'expires_at ausente en respuesta Meta' };

    const allSynced = tokenSync.success && expSync.success;

    const row = {
      agent_name: 'cron_refresh_meta_token',
      decision_type: 'token_refresh',
      proposed_action: {
        action: allSynced ? 'refreshed' : 'refreshed_no_persist',
        old_token_masked: oldMasked,
        new_token_masked: newMasked,
        new_expires_at: ext.expires_at ?? null,
        expires_in_sec: ext.expires_in_sec ?? null,
        vercel_sync: {
          META_TOKEN: tokenSync.success ? tokenSync.action : `failed: ${tokenSync.error ?? 'unknown'}`,
          META_TOKEN_EXPIRES: expSync.success
            ? (expSync as { action?: string }).action ?? 'patched'
            : `failed: ${expSync.error ?? 'unknown'}`,
        },
      },
      justification: allSynced
        ? `Token Meta renovado y persistido en Vercel env. Días anteriores: ${result.days_left}. expires_in=${ext.expires_in_sec ?? 0}s.`
        : `Token Meta renovado pero NO persistido en Vercel (rotación manual requerida). Token nuevo se descartará al terminar el handler.`,
      severity: allSynced ? 0.1 : 0.8,
      status: allSynced ? 'auto_approved' : 'pending',
      decision_key: decisionKey,
    };

    await supabase.from('agent_decisions').upsert(row, { onConflict: 'decision_key' });

    console.log(
      `[cron/refresh-meta-token] refresh action=${row.proposed_action.action} synced_token=${tokenSync.success} synced_expires=${expSync.success}`,
    );

    res.status(200).json({
      ok: allSynced,
      action: row.proposed_action.action,
      previous: { days_left: result.days_left, token_masked: oldMasked },
      current: {
        token_masked: newMasked,
        expires_at: ext.expires_at ?? null,
        expires_in_sec: ext.expires_in_sec ?? null,
      },
      vercel_sync: row.proposed_action.vercel_sync,
      decision_key: decisionKey,
      decision_status: row.status,
    });
    return;
  }

  // 6 · RAMA HEALTH_CHECK ────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const decisionKey = `meta_token_check_${today}_${result.status}`;

  const healthRow = {
    agent_name: 'cron_refresh_meta_token',
    decision_type: 'meta_token_health_check',
    proposed_action: {
      action: statusNeedsAction(result.status) ? 'rotate_meta_token' : 'noop',
      token_status: result.status,
      days_left: result.days_left,
      expires_at: result.expires_at,
      runbook:
        'STATUS_CORE_22may_PM.md §B2 · Meta Business Manager → System Users → generate token → vercel env rm/add.',
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

  const { error } = await supabase
    .from('agent_decisions')
    .upsert(healthRow, { onConflict: 'decision_key' });

  if (error) {
    console.error(
      '[cron/refresh-meta-token] No se pudo persistir health_check en agent_decisions:',
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
    action: 'no-op',
    token_status: result.status,
    days_left: result.days_left,
    expires_at: result.expires_at,
    action_required: statusNeedsAction(result.status),
    decision_key: decisionKey,
    decision_status: healthRow.status,
  });
}
