-- ============================================================
-- Frente I.1 · Analítica Inventario · matview + KPIs
-- Aplica DESPUÉS de: 010-014 (Frente G) + migrations previas INV
-- Idempotente: usa CREATE OR REPLACE / DROP IF EXISTS
-- ============================================================

BEGIN;

-- Matview por SKU (≈3,860 rows)
DROP MATERIALIZED VIEW IF EXISTS mv_analitica_inventario CASCADE;
CREATE MATERIALIZED VIEW mv_analitica_inventario AS
SELECT
    p.sku,
    p.nombre,
    p.categoria,
    p.stock_actual,
    p.stock_minimo,
    p.precio_costo,
    p.precio_publico,
    (p.stock_actual * p.precio_costo)::NUMERIC(14,2)        AS valor_stock,
    (p.stock_actual < p.stock_minimo)                       AS bajo_minimo,
    CASE WHEN COALESCE(mov30.unidades, 0) > 0
         THEN (p.stock_actual * 30.0 / mov30.unidades)::NUMERIC(8,1)
         ELSE NULL END                                      AS dias_inventario,
    CASE WHEN p.stock_minimo > 0
         THEN (p.stock_actual::NUMERIC / p.stock_minimo)::NUMERIC(6,2)
         ELSE NULL END                                      AS ratio_riesgo,
    -- Camino B (Cowork 27-may): ingresos = unidades * precio_publico (revenue aprox)
    COALESCE(mov30.unidades * p.precio_publico, 0)::NUMERIC(14,2)  AS ventas_30d,
    COALESCE(mov90.unidades * p.precio_publico, 0)::NUMERIC(14,2)  AS ventas_90d,
    COALESCE(mov30.unidades, 0)::INTEGER                    AS unidades_30d,
    COALESCE(mov90.unidades, 0)::INTEGER                    AS unidades_90d,
    rot.rotacion_30d                                        AS rotacion_30d,
    mov30.ultima_venta                                      AS ultima_venta_real,
    CASE WHEN mov30.ultima_venta IS NOT NULL
         THEN EXTRACT(DAY FROM (now() - mov30.ultima_venta))::INTEGER
         ELSE NULL END                                      AS dias_sin_movimiento,
    COALESCE(mov30.unidades * p.precio_publico, 0)::NUMERIC(14,2)  AS ingresos_30d
FROM productos p
LEFT JOIN productos_rotacion_mensual rot ON rot.sku = p.sku
LEFT JOIN LATERAL (
    SELECT
        SUM(m.cantidad)                       AS unidades,
        MAX(m.created_at)                     AS ultima_venta
    FROM productos_movimientos m
    WHERE m.producto_slug = p.slug
      AND m.tipo = 'salida'
      AND m.created_at >= now() - interval '30 days'
) mov30 ON TRUE
LEFT JOIN LATERAL (
    SELECT
        SUM(m.cantidad)                       AS unidades
    FROM productos_movimientos m
    WHERE m.producto_slug = p.slug
      AND m.tipo = 'salida'
      AND m.created_at >= now() - interval '90 days'
) mov90 ON TRUE
WHERE p.estado = 'activo';  -- Camino B · valor verificado en introspect 2026-05-27

CREATE UNIQUE INDEX IF NOT EXISTS mv_analitica_inventario_sku_idx
    ON mv_analitica_inventario(sku);
CREATE INDEX IF NOT EXISTS mv_analitica_inventario_categoria_idx
    ON mv_analitica_inventario(categoria);
CREATE INDEX IF NOT EXISTS mv_analitica_inventario_rotacion_idx
    ON mv_analitica_inventario(rotacion_30d DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS mv_analitica_inventario_bajo_minimo_idx
    ON mv_analitica_inventario(bajo_minimo) WHERE bajo_minimo = TRUE;

-- Vista KPIs (1 row · derivada de matview)
CREATE OR REPLACE VIEW v_analitica_inventario_kpis AS
SELECT
    SUM(valor_stock)::NUMERIC(14,2)                                   AS valor_total_stock,
    (COUNT(*) FILTER (WHERE bajo_minimo) * 100.0 / NULLIF(COUNT(*),0))::NUMERIC(5,2)
                                                                       AS pct_bajo_minimo,
    COUNT(*) FILTER (WHERE dias_sin_movimiento >= 30 OR dias_sin_movimiento IS NULL)
                                                                       AS productos_sin_movimiento_30d_count,
    SUM(ingresos_30d)::NUMERIC(14,2)                                   AS ingresos_30d_total,
    SUM(ventas_90d)::NUMERIC(14,2)                                     AS ingresos_90d_total,
    AVG(rotacion_30d)::NUMERIC(8,2)                                    AS rotacion_promedio
FROM mv_analitica_inventario;

-- GRANTs (consistente con productos_rotacion_mensual)
GRANT SELECT ON mv_analitica_inventario     TO service_role;
GRANT SELECT ON v_analitica_inventario_kpis TO service_role;

-- Función helper para refresh manual / cron
CREATE OR REPLACE FUNCTION refresh_mv_analitica_inventario()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_analitica_inventario;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_mv_analitica_inventario() TO service_role;

COMMIT;

-- ─── ROLLBACK (descomentar manualmente si necesario) ───
-- BEGIN;
-- DROP FUNCTION IF EXISTS refresh_mv_analitica_inventario();
-- DROP VIEW IF EXISTS v_analitica_inventario_kpis;
-- DROP MATERIALIZED VIEW IF EXISTS mv_analitica_inventario CASCADE;
-- COMMIT;

-- ============================================================
-- Nota Cowork 27-may PM:
-- 4 patches aplicados vs PROMPT_v3 §4 B-1.a por cross-check schema:
--   1. WHERE p.estado = 'activo' (no p.activo) — valor verificado: 1001/1001 rows
--   2. m.producto_slug = p.slug (no m.sku = p.sku) — columna real movimientos
--   3. ingresos = unidades * p.precio_publico (Camino B · revenue aproximado)
--      → cálculo movido afuera de LATERAL para poder leer p.precio_publico
--   4. rot.rotacion_30d (no rot.rotacion_mensual) — columna real rotacion_mensual view
-- KPIs siguen llamándose "ingresos" (Camino B no renombra).
-- ============================================================
