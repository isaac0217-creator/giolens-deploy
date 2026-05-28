-- ============================================================
-- ⚠️ EJECUTAR FUERA DE TRANSACCIÓN
-- ⚠️ NO incluir en migrations runner Supabase
-- ⚠️ Aplicar manualmente: psql $DATABASE_URL -f migrations/016_*.sql
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_movimientos_salida_fecha
    ON productos_movimientos(created_at DESC)
    WHERE tipo = 'salida';

-- Rollback manual:
-- DROP INDEX CONCURRENTLY IF EXISTS idx_movimientos_salida_fecha;
