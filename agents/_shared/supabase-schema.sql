-- =====================================================
-- GIOCORE · Fase 1 Sprint 1 · SQL Schema Inicial
-- =====================================================
-- Pegar este SQL en: Supabase Dashboard → SQL Editor → New query
-- Ejecutar TODO el bloque en una sola corrida
-- Tiempo de ejecución estimado: <5 segundos
-- =====================================================

-- ============= EXTENSIONES =============
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============= TABLAS NÚCLEO =============

-- Contactos sincronizados desde Wapify
CREATE TABLE IF NOT EXISTS contacts (
    id BIGINT PRIMARY KEY,                           -- id de Wapify
    name TEXT,
    phone TEXT,
    email TEXT,
    pipeline_id BIGINT NOT NULL,
    stage_name TEXT,
    stage_phase TEXT,                                -- int1, int2, int3, closing, won, lost
    last_message TEXT,
    last_message_at TIMESTAMPTZ,
    raw_payload JSONB,                               -- payload completo Wapify por si necesitamos campos no modelados
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contacts_pipeline ON contacts(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_contacts_stage ON contacts(pipeline_id, stage_phase);
CREATE INDEX IF NOT EXISTS idx_contacts_last_msg ON contacts(last_message_at DESC);

-- Eventos de cambio de etapa (timeline auditable)
CREATE TABLE IF NOT EXISTS stage_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    pipeline_id BIGINT NOT NULL,
    from_stage TEXT,
    to_stage TEXT NOT NULL,
    trigger_source TEXT,                             -- 'webhook', 'manual', 'agent_proposal'
    trigger_metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stage_events_contact ON stage_events(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stage_events_pipeline ON stage_events(pipeline_id, created_at DESC);

-- Snapshots periódicos de métricas Meta (no sustituye API, es cache + historia)
CREATE TABLE IF NOT EXISTS meta_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id TEXT NOT NULL,
    campaign_id TEXT,
    metric_date DATE NOT NULL,
    period TEXT NOT NULL,                            -- 'daily', 'weekly', 'monthly'
    spend NUMERIC(10,2),
    impressions BIGINT,
    clicks BIGINT,
    cpc NUMERIC(10,4),
    cpr NUMERIC(10,4),                               -- Cost Per Result
    results BIGINT,
    raw_payload JSONB,
    fetched_at TIMESTAMPTZ DEFAULT NOW(),
    source TEXT DEFAULT 'meta_graph_api',
    UNIQUE(account_id, campaign_id, metric_date, period)
);
CREATE INDEX IF NOT EXISTS idx_meta_metrics_date ON meta_metrics(metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_meta_metrics_account_date ON meta_metrics(account_id, metric_date DESC);

-- ============= TABLAS AGENTES (Fase 2+) =============

-- Cada ejecución de un agente queda registrada
CREATE TABLE IF NOT EXISTS agent_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_name TEXT NOT NULL,                        -- 'analista', 'optimizacion', etc.
    agent_version TEXT NOT NULL,
    model_version TEXT NOT NULL,                     -- 'claude-sonnet-4-6', etc.
    mode TEXT NOT NULL DEFAULT 'production',         -- 'shadow', 'production', 'eval'
    trigger_source TEXT,                             -- 'cron', 'webhook', 'manual'
    input_context JSONB,
    output_payload JSONB,
    tokens_input INTEGER,
    tokens_output INTEGER,
    cost_usd NUMERIC(10,6),
    latency_ms INTEGER,
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_date ON agent_runs(agent_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_mode ON agent_runs(mode, started_at DESC);

-- Mensajes intercambiados entre agentes (bus)
CREATE TABLE IF NOT EXISTS agent_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_agent TEXT NOT NULL,
    to_agent TEXT,                                   -- NULL = broadcast
    message_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    context_refs UUID[],                             -- referencias a otros agent_runs
    requires_ack BOOLEAN DEFAULT false,
    acked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_type_date ON agent_messages(message_type, created_at DESC);

-- Decisiones/propuestas que requieren aprobación humana
CREATE TABLE IF NOT EXISTS agent_decisions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
    agent_name TEXT NOT NULL,
    decision_type TEXT NOT NULL,                     -- 'budget_change', 'message_send', 'stage_move', etc.
    proposed_action JSONB NOT NULL,
    justification TEXT NOT NULL,
    evidence_refs JSONB,
    severity NUMERIC(3,2),                           -- 0.00 a 1.00
    status TEXT DEFAULT 'pending',                   -- 'pending', 'approved', 'rejected', 'auto_approved', 'expired'
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_status ON agent_decisions(status, created_at DESC);

-- Aprobaciones humanas (auditoría)
CREATE TABLE IF NOT EXISTS human_approvals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    decision_id UUID NOT NULL REFERENCES agent_decisions(id) ON DELETE CASCADE,
    approver_id TEXT NOT NULL,                       -- 'isaac' por ahora
    approved BOOLEAN NOT NULL,
    feedback TEXT,
    feedback_category TEXT,                          -- 'useful', 'false_positive', 'duplicate', 'noise'
    response_time_ms INTEGER,                        -- desde creación hasta aprobación
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_human_approvals_decision ON human_approvals(decision_id);

-- Knowledge base · contexto compartido entre agentes
CREATE TABLE IF NOT EXISTS knowledge_base (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category TEXT NOT NULL,                          -- 'pipeline_pattern', 'meta_baseline', 'business_rule', 'glossary'
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    confidence NUMERIC(3,2) DEFAULT 1.00,
    source TEXT,                                     -- 'manual', 'analista', 'extracted', 'config'
    valid_from TIMESTAMPTZ DEFAULT NOW(),
    valid_until TIMESTAMPTZ,                         -- NULL = sin caducidad
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(category, key)
);
CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_base(category);

-- Audit log universal
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_type TEXT NOT NULL,                        -- 'human', 'agent', 'system'
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_actor_date ON audit_log(actor_type, actor_id, created_at DESC);

-- ============= TOKENS Y CONFIG =============

-- Almacenamiento de tokens con expiración (para auto-refresh META)
CREATE TABLE IF NOT EXISTS auth_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider TEXT NOT NULL,                          -- 'meta', 'wapify', etc.
    token_name TEXT NOT NULL,                        -- 'system_user', 'page_access', etc.
    token_value TEXT NOT NULL,                       -- cifrar en Fase 2 con pgsodium
    expires_at TIMESTAMPTZ,                          -- NULL = sin caducidad
    last_refreshed_at TIMESTAMPTZ DEFAULT NOW(),
    refresh_attempts INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(provider, token_name)
);

-- Configuración general (reemplaza localStorage)
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_by TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============= ROW LEVEL SECURITY =============
-- Por defecto bloquear todo, abrir solo lo que el dashboard necesita

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

-- Política: el service_role bypassea todo (Code la usa para escribir)
-- El anon role solo lee tablas públicas (contacts read-only, meta_metrics read-only)
-- Bug 2 fix (schema_review_notes.md): PG15 no soporta IF NOT EXISTS en CREATE POLICY;
-- wrappear con DROP POLICY IF EXISTS para idempotencia en re-aplicación.
DROP POLICY IF EXISTS "anon_read_contacts" ON contacts;
CREATE POLICY "anon_read_contacts" ON contacts FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_read_meta_metrics" ON meta_metrics;
CREATE POLICY "anon_read_meta_metrics" ON meta_metrics FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_read_stage_events" ON stage_events;
CREATE POLICY "anon_read_stage_events" ON stage_events FOR SELECT TO anon USING (true);

-- ============= TRIGGERS =============

-- Auto-update updated_at en contacts
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Bug 1 fix (schema_review_notes.md): CREATE TRIGGER no soporta IF NOT EXISTS;
-- wrappear con DROP TRIGGER IF EXISTS para idempotencia.
DROP TRIGGER IF EXISTS update_contacts_updated_at ON contacts;
CREATE TRIGGER update_contacts_updated_at
    BEFORE UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Mejora 3 (schema_review_notes.md): updated_at + trigger en knowledge_base + app_config
-- para audit trail completo de cambios de configuración.
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
DROP TRIGGER IF EXISTS update_kb_updated_at ON knowledge_base;
CREATE TRIGGER update_kb_updated_at
    BEFORE UPDATE ON knowledge_base
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_config_updated_at ON app_config;
CREATE TRIGGER update_config_updated_at
    BEFORE UPDATE ON app_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============= CHECK CONSTRAINTS =============
-- Mejora 1 (schema_review_notes.md): integridad a nivel BD para valores enumerados.
-- Cacha typos en INSERT en lugar de queries 3 horas después.
-- IF NOT EXISTS no soportado en ADD CONSTRAINT < PG16: usar DO block para idempotencia.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_mode' AND conrelid = 'agent_runs'::regclass) THEN
        ALTER TABLE agent_runs ADD CONSTRAINT chk_mode
            CHECK (mode IN ('shadow', 'production', 'eval'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_status' AND conrelid = 'agent_decisions'::regclass) THEN
        ALTER TABLE agent_decisions ADD CONSTRAINT chk_status
            CHECK (status IN ('pending', 'approved', 'rejected', 'auto_approved', 'expired'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_severity' AND conrelid = 'agent_decisions'::regclass) THEN
        ALTER TABLE agent_decisions ADD CONSTRAINT chk_severity
            CHECK (severity IS NULL OR (severity >= 0 AND severity <= 1));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_confidence' AND conrelid = 'knowledge_base'::regclass) THEN
        ALTER TABLE knowledge_base ADD CONSTRAINT chk_confidence
            CHECK (confidence >= 0 AND confidence <= 1);
    END IF;
END $$;

-- ============= ÍNDICES OPTIMIZADOS =============
-- Mejora 2 (schema_review_notes.md): índice parcial para query más frecuente
-- del panel agents-approvals.html (WHERE status='pending'). 10x más pequeño
-- y rápido que el índice completo idx_agent_decisions_status.
CREATE INDEX IF NOT EXISTS idx_agent_decisions_pending
    ON agent_decisions(created_at DESC, expires_at)
    WHERE status = 'pending';

-- ============= SEED INICIAL =============

-- Pipelines conocidos en knowledge_base
INSERT INTO knowledge_base (category, key, value, source) VALUES
('pipeline_meta', '216977', '{"name":"Justin/Holbrook/Litebeam","has_journey_3int":true,"flows":["LOCAL_HOLBROOKTJ","LOCAL_JUSTINTJ"]}', 'config'),
('pipeline_meta', '755062', '{"name":"GioSports Deportivo","has_journey_3int":true,"flows":["LOCAL_GIOSPORTSTJ"]}', 'config'),
('pipeline_meta', '94103',  '{"name":"Dama Luxury","has_journey_3int":true,"flows":["LOCAL_DAMATJ"]}', 'config'),
('pipeline_meta', '252999', '{"name":"SPY Z87 Seguridad","has_journey_3int":false,"flows":[]}', 'config'),
('pipeline_meta', '273944', '{"name":"GioVision Entintados","has_journey_3int":false,"flows":[]}', 'config')
ON CONFLICT (category, key) DO NOTHING;

-- Precios SPY (single source of truth)
INSERT INTO knowledge_base (category, key, value, source) VALUES
('product_pricing', 'spy_base', '{"price_mxn":2999,"description":"Armazón base"}', 'config'),
('product_pricing', 'spy_vision_sencilla', '{"price_mxn":3950,"description":"Con visión sencilla"}', 'config'),
('product_pricing', 'spy_fotocromatica', '{"price_mxn":4950,"description":"Lente fotocromática"}', 'config'),
('product_pricing', 'spy_progresivo', '{"min_mxn":5950,"max_mxn":9950,"description":"Lente progresivo"}', 'config')
ON CONFLICT (category, key) DO NOTHING;

-- Config inicial app
INSERT INTO app_config (key, value, updated_by) VALUES
('reactivation_dry_run', 'true'::jsonb, 'sprint_1_setup'),
('analista_mode', '"shadow"'::jsonb, 'sprint_1_setup'),
('cost_caps', '{"analista_daily_usd":5.00,"optimizacion_daily_usd":20.00}'::jsonb, 'sprint_1_setup')
ON CONFLICT (key) DO NOTHING;

-- ============= VERIFICACIÓN =============
-- Después de ejecutar todo lo anterior, correr:
-- SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;
-- Debe listar: agent_decisions, agent_messages, agent_runs, app_config, audit_log, auth_tokens,
--              contacts, human_approvals, knowledge_base, meta_metrics, stage_events
-- Total: 11 tablas
