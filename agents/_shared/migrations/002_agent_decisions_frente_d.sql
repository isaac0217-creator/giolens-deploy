-- =====================================================
-- GIOCORE · Frente D · ADR-02 · Migración 002
-- Persistencia Supabase del approval-store
-- =====================================================
-- Migración ADITIVA sobre la tabla `agent_decisions` (ya existe — ver
-- supabase-schema.sql, líneas 107-119). NO recrea la tabla, solo agrega
-- columnas e índices que el approval-store necesita para persistir.
--
-- Pegar en: Supabase Dashboard → SQL Editor → New query
-- Re-aplicable (idempotente): todo usa IF NOT EXISTS.
-- =====================================================

-- Columnas nuevas para el mapeo del approval-store:
--   decision_key   <- decision.decision_id  (clave idempotente del store, no es el UUID `id`)
--   amount_usd     <- decision.amount_usd   (impacto económico de la decisión)
--   verdict        <- verdict completo de resolve() (approved/by/at/note)
--   resolved_at    <- timestamp de resolución
--   correlation_id <- correlation_id del run que originó la decisión (trazabilidad)
ALTER TABLE agent_decisions
  ADD COLUMN IF NOT EXISTS decision_key   TEXT,
  ADD COLUMN IF NOT EXISTS amount_usd     NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS verdict        JSONB,
  ADD COLUMN IF NOT EXISTS resolved_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;

-- Índice único parcial sobre decision_key: garantiza idempotencia de register()
-- (upsert onConflict:'decision_key'). Parcial porque las filas históricas
-- previas a esta migración tienen decision_key NULL y NULL no colisiona.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_decisions_decision_key
  ON agent_decisions(decision_key) WHERE decision_key IS NOT NULL;

-- Índice de lookup por correlation_id para trazar decisiones de un mismo run.
CREATE INDEX IF NOT EXISTS idx_agent_decisions_correlation
  ON agent_decisions(correlation_id) WHERE correlation_id IS NOT NULL;

-- ============= VERIFICACIÓN =============
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='agent_decisions' AND table_schema='public'
--   ORDER BY column_name;
-- Debe incluir: amount_usd, correlation_id, decision_key, resolved_at, verdict
