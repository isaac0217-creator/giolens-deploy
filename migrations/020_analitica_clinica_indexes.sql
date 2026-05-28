-- ============================================================
-- Frente I.2 · Analítica Clínica · índices de soporte (CONCURRENTLY)
-- Aplica DESPUÉS de: 019_analitica_clinica.sql
-- ============================================================
--
-- ⚠️ EJECUTAR FUERA DE TRANSACCIÓN
-- ⚠️ NO incluir en migrations runner Supabase (transaccional por default)
-- ⚠️ Aplicar manualmente:
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -f migrations/020_analitica_clinica_indexes.sql
--
-- Soportan los joins/agrupaciones del matview + vistas de migration 019:
--   · expedientes(created_at) — ventanas 30/60/90d
--   · citas(expediente_id)    — join funnel expediente↔cita (FK)
--   · citas(paciente_hash, fecha) — recurrencia / gaps / alertas
--   · productos_movimientos ya tiene idx_movimientos_tipo_created (migration 009)
--
-- Ver migrations/PATRON_INDICES.md para cuándo usar CONCURRENTLY.
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expedientes_created_at
    ON expedientes(created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_citas_expediente_id
    ON citas(expediente_id)
    WHERE expediente_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_citas_paciente_hash_fecha
    ON citas(paciente_hash, fecha DESC);

-- ─── ROLLBACK MANUAL (descomentar) ───
-- DROP INDEX CONCURRENTLY IF EXISTS idx_expedientes_created_at;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_citas_expediente_id;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_citas_paciente_hash_fecha;
