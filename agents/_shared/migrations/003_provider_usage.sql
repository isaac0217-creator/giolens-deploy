-- ============================================================
-- Migración 003 · provider_usage (Bloque 7 · Dashboard Consumo)
-- Generada: 22-may-2026 · Cowork
-- Spec referencia: BLOQUE7_SPEC_DASHBOARD_CONSUMO.md §2.1
-- Aplica DESPUÉS de:
--   1. supabase-schema.sql (base · 11 tablas)
--   2. 002_agent_decisions_frente_d.sql
-- ============================================================

BEGIN;

-- 1 · Tabla principal
CREATE TABLE IF NOT EXISTS provider_usage (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic','openai','meta','vercel','wapify','openai_scrape')),
  model TEXT,
  workspace_id TEXT,
  account_id TEXT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  tokens_in BIGINT DEFAULT 0,
  tokens_in_cached BIGINT DEFAULT 0,
  tokens_out BIGINT DEFAULT 0,
  requests INT DEFAULT 0,
  invocations BIGINT DEFAULT 0,
  bandwidth_gb NUMERIC(12,4) DEFAULT 0,
  messages_sent INT DEFAULT 0,
  cost_usd NUMERIC(12,4) DEFAULT 0,
  raw_payload JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_usage_unique_period
    UNIQUE (provider, model, workspace_id, account_id, period_start)
);

-- 2 · Índices para query del endpoint /api/provider-usage
CREATE INDEX IF NOT EXISTS idx_provider_usage_provider_period
  ON provider_usage (provider, period_start DESC);

CREATE INDEX IF NOT EXISTS idx_provider_usage_fetched
  ON provider_usage (fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_usage_model
  ON provider_usage (model)
  WHERE model IS NOT NULL;

-- 3 · RLS
ALTER TABLE provider_usage ENABLE ROW LEVEL SECURITY;

-- 3.1 · service_role: lectura/escritura total (el cron y los endpoints internos usan esta)
DROP POLICY IF EXISTS "provider_usage_service_role_all" ON provider_usage;
CREATE POLICY "provider_usage_service_role_all" ON provider_usage
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 3.2 · anon: solo lectura agregada vía endpoint (no acceso directo a raw_payload)
DROP POLICY IF EXISTS "provider_usage_anon_select_agregado" ON provider_usage;
CREATE POLICY "provider_usage_anon_select_agregado" ON provider_usage
  FOR SELECT TO anon
  USING (false);  -- bloqueado por default; el endpoint sanitiza y usa service_role

-- 4 · Comentarios para documentación
COMMENT ON TABLE provider_usage IS
  'Consumo diario por proveedor (Anthropic/OpenAI/Meta/Vercel/Wapify). Populado por cron /api/cron/fetch-provider-usage. Lectura vía /api/provider-usage.';

COMMENT ON COLUMN provider_usage.provider IS
  'Proveedor: anthropic | openai | meta | vercel | wapify | openai_scrape (fallback UI)';

COMMENT ON COLUMN provider_usage.workspace_id IS
  'Workspace ID dentro del proveedor (Anthropic workspaces, OpenAI projects). NULL si single-tenant.';

COMMENT ON COLUMN provider_usage.raw_payload IS
  'Respuesta completa de la API para auditoría. NO exponer en endpoint público.';

-- 5 · Función helper para upsert idempotente (Code la usará desde fetchers)
CREATE OR REPLACE FUNCTION upsert_provider_usage(
  p_provider TEXT,
  p_model TEXT,
  p_workspace_id TEXT,
  p_account_id TEXT,
  p_period_start DATE,
  p_period_end DATE,
  p_tokens_in BIGINT,
  p_tokens_in_cached BIGINT,
  p_tokens_out BIGINT,
  p_requests INT,
  p_invocations BIGINT,
  p_bandwidth_gb NUMERIC,
  p_messages_sent INT,
  p_cost_usd NUMERIC,
  p_raw_payload JSONB
) RETURNS BIGINT AS $$
DECLARE
  v_id BIGINT;
BEGIN
  INSERT INTO provider_usage (
    provider, model, workspace_id, account_id,
    period_start, period_end,
    tokens_in, tokens_in_cached, tokens_out,
    requests, invocations, bandwidth_gb, messages_sent, cost_usd,
    raw_payload, fetched_at
  ) VALUES (
    p_provider, p_model, p_workspace_id, p_account_id,
    p_period_start, p_period_end,
    COALESCE(p_tokens_in, 0), COALESCE(p_tokens_in_cached, 0), COALESCE(p_tokens_out, 0),
    COALESCE(p_requests, 0), COALESCE(p_invocations, 0),
    COALESCE(p_bandwidth_gb, 0), COALESCE(p_messages_sent, 0), COALESCE(p_cost_usd, 0),
    p_raw_payload, NOW()
  )
  ON CONFLICT (provider, model, workspace_id, account_id, period_start)
  DO UPDATE SET
    tokens_in        = EXCLUDED.tokens_in,
    tokens_in_cached = EXCLUDED.tokens_in_cached,
    tokens_out       = EXCLUDED.tokens_out,
    requests         = EXCLUDED.requests,
    invocations      = EXCLUDED.invocations,
    bandwidth_gb     = EXCLUDED.bandwidth_gb,
    messages_sent    = EXCLUDED.messages_sent,
    cost_usd         = EXCLUDED.cost_usd,
    raw_payload      = EXCLUDED.raw_payload,
    fetched_at       = NOW(),
    period_end       = EXCLUDED.period_end
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6 · Validación post-aplicación
DO $$
DECLARE
  v_table_exists BOOLEAN;
  v_rls_enabled BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='provider_usage'
  ) INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE EXCEPTION 'Migración 003 FALLÓ: tabla provider_usage no se creó';
  END IF;

  SELECT relrowsecurity FROM pg_class
  WHERE relname='provider_usage' INTO v_rls_enabled;

  IF NOT v_rls_enabled THEN
    RAISE EXCEPTION 'Migración 003 FALLÓ: RLS no habilitado en provider_usage';
  END IF;

  RAISE NOTICE 'Migración 003 OK · tabla creada · RLS habilitada · función upsert_provider_usage lista';
END $$;

COMMIT;

-- ============================================================
-- Para aplicar:
--   psql "$DATABASE_URL" -f 003_provider_usage.sql
-- Para revertir:
--   BEGIN; DROP FUNCTION upsert_provider_usage; DROP TABLE provider_usage; COMMIT;
-- ============================================================
