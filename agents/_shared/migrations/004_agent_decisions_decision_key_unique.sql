-- Migration 004 · agent_decisions.decision_key UNIQUE
-- Fecha: 2026-05-22 PM
-- Contexto: el handler `api/cron/refresh-meta-token.ts` (Frente D.2) usa
-- `INSERT ... ON CONFLICT (decision_key) DO UPDATE` para idempotencia diaria
-- (ver docs/ADR-05_frente_d2_token_refresh_y_wapify_sync.md §D.2.1).
--
-- La migración 002 creó la columna `decision_key TEXT` pero omitió el UNIQUE
-- constraint. El STATUS_CORE_22may_PM.md §"DB schema state" declaraba
-- `decision_key UNIQUE` como si existiera — bug latente hasta el primer
-- POST a /api/cron/refresh-meta-token, que devolvió:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--
-- Esta migración añade el constraint faltante. Idempotente vía IF NOT EXISTS
-- (Postgres 15+) — si ya se aplicó por psql ad-hoc, no falla.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_decisions_decision_key_key'
      AND conrelid = 'public.agent_decisions'::regclass
  ) THEN
    ALTER TABLE public.agent_decisions
      ADD CONSTRAINT agent_decisions_decision_key_key UNIQUE (decision_key);
  END IF;
END $$;
