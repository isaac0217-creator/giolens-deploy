-- ============================================================
-- Frente I.4 · Analítica de Caja (v1 SOLO-VOLUMEN) · matview KPIs + vistas
-- Spec: SPEC_FRENTE_I4_ANALITICA_CAJA.md (Fase 1 backend)
-- Spike: CAJA_DATA_INVENTORY.md (sesión 12, 2026-05-29) · veredicto I4-SOLO-VOLUMEN
-- Aplica DESPUÉS de: 009 (productos_movimientos) · patrón matview I.1/I.2/I.3
--                    (015/019/022/026).
-- Idempotente: DROP ... CASCADE + CREATE OR REPLACE. tx-safe (BEGIN/COMMIT).
--
-- ⚠ VEREDICTO DEL SPIKE (datos reales, NO el sketch del spec):
--   · NO existe tabla de ventas/pagos/cobros con importe real en Supabase.
--     Los precios/ventas viven en eOptis (externo, sin columnas $). Issue #8.
--   · `productos_movimientos` es el único ledger de operaciones, y NO tiene
--     columna de precio de venta, monto cobrado ni medio de pago.
--   · Por eso TODO KPI monetario (ingreso_*, ticket_promedio) se emite como
--     NULL aquí y el BFF lo marca con _warnings:['caja_monto_pendiente'].
--     NO se inventan montos (regla de honestidad I.1/I.3).
--   · "operación de caja" v1 = movimiento `tipo='salida'` (mercadería que sale
--     = vendida). GRANO = por línea de salida (NO hay id de ticket que agrupe).
--     `motivo` puede incluir merma/ajuste → refinamiento futuro filtraría por él.
--
-- ZONA HORARIA: las franjas horarias / día de semana se calculan en hora local
--   de la óptica (America/Tijuana, default OPTICA_TIMEZONE) vía AT TIME ZONE.
--   created_at es timestamptz; sin la conversión, la franja horaria saldría en UTC.
--
-- NAMING: "caja operativa / aproximada", NUNCA "contable". Son conteos de
--   operaciones de inventario, no un libro contable formal.
--
-- PII — NO NEGOCIABLE: ninguna relación expone cliente individual, paciente_hash,
--   ni identificador de transacción crudo. Sólo agregados (conteos, unidades).
--
-- LECCIÓN migration 022: el UNIQUE index para REFRESH ... CONCURRENTLY debe ser
--   sobre COLUMNA REAL (no expresión constante `((1))`). La matview es singleton
--   (1 fila, sin GROUP BY) → unicidad sobre `refreshed_at` la satisface.
--
-- ÍNDICES: las vistas de serie consultan productos_movimientos por
--   (tipo='salida', created_at). Esos índices YA EXISTEN en prod
--   (idx_movimientos_salida_fecha parcial + idx_movimientos_tipo_created) →
--   NO se crea migration de índices adicional (no duplicar).
-- ============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- Matview de KPIs escalares (1 fila · singleton) · refresh horario via cron
-- operaciones/unidades reales por ventana; ingreso/ticket NULL (sin monto).
-- ─────────────────────────────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS mv_analitica_caja CASCADE;
CREATE MATERIALIZED VIEW mv_analitica_caja AS
WITH salidas AS (
  SELECT cantidad, created_at
  FROM productos_movimientos
  WHERE tipo = 'salida'
)
SELECT
  -- Volumen de operaciones (# líneas de salida) por ventana
  (SELECT count(*) FROM salidas
     WHERE created_at >= now() - interval '30 days')::int   AS operaciones_30d,
  (SELECT count(*) FROM salidas
     WHERE created_at >= now() - interval '60 days')::int   AS operaciones_60d,
  (SELECT count(*) FROM salidas
     WHERE created_at >= now() - interval '90 days')::int   AS operaciones_90d,
  -- Unidades vendidas (sum abs cantidad) por ventana
  COALESCE((SELECT sum(abs(cantidad)) FROM salidas
     WHERE created_at >= now() - interval '30 days'), 0)::int AS unidades_30d,
  COALESCE((SELECT sum(abs(cantidad)) FROM salidas
     WHERE created_at >= now() - interval '60 days'), 0)::int AS unidades_60d,
  COALESCE((SELECT sum(abs(cantidad)) FROM salidas
     WHERE created_at >= now() - interval '90 days'), 0)::int AS unidades_90d,
  -- KPIs MONETARIOS · DIFERIDOS (sin fuente de monto en Supabase · Issue #8)
  -- → NULL explícito. El BFF marca _warnings:['caja_monto_pendiente']. NO inventar.
  NULL::numeric                                              AS ingreso_30d,
  NULL::numeric                                              AS ingreso_60d,
  NULL::numeric                                              AS ingreso_90d,
  NULL::numeric                                              AS ticket_promedio_30d,
  now()                                                      AS refreshed_at;

-- UNIQUE index singleton sobre columna REAL (refreshed_at) → REFRESH CONCURRENTLY.
-- (NO sobre ((1)): lección migration 022.)
CREATE UNIQUE INDEX uq_mv_caja_singleton
    ON mv_analitica_caja (refreshed_at);

-- ─────────────────────────────────────────────────────────────────────────
-- Vista KPIs (espejo de v_analitica_clinica_kpis)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_analitica_caja_kpis AS
SELECT
  operaciones_30d,
  operaciones_60d,
  operaciones_90d,
  unidades_30d,
  unidades_60d,
  unidades_90d,
  ingreso_30d,
  ingreso_60d,
  ingreso_90d,
  ticket_promedio_30d
FROM mv_analitica_caja;

-- ─────────────────────────────────────────────────────────────────────────
-- Vista flujo · operaciones (+ unidades) por día local · últimos 90 días
-- ingreso por día = NULL (sin monto). Serie temporal para el chart de caja.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_caja_flujo AS
SELECT
  (created_at AT TIME ZONE 'America/Tijuana')::date          AS dia,
  count(*)::int                                              AS operaciones,
  COALESCE(sum(abs(cantidad)), 0)::int                       AS unidades,
  NULL::numeric                                              AS ingreso
FROM productos_movimientos
WHERE tipo = 'salida'
  AND created_at >= now() - interval '90 days'
GROUP BY (created_at AT TIME ZONE 'America/Tijuana')::date;

-- ─────────────────────────────────────────────────────────────────────────
-- Vista horarios · distribución por franja horaria local (0-23) · 90d
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_caja_horarios AS
SELECT
  EXTRACT(hour FROM (created_at AT TIME ZONE 'America/Tijuana'))::int AS franja_hora,
  count(*)::int                                              AS operaciones,
  COALESCE(sum(abs(cantidad)), 0)::int                       AS unidades
FROM productos_movimientos
WHERE tipo = 'salida'
  AND created_at >= now() - interval '90 days'
GROUP BY EXTRACT(hour FROM (created_at AT TIME ZONE 'America/Tijuana'));

-- ─────────────────────────────────────────────────────────────────────────
-- Vista día de semana · distribución por dow local (0=domingo .. 6=sábado) · 90d
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_caja_dia_semana AS
SELECT
  EXTRACT(dow FROM (created_at AT TIME ZONE 'America/Tijuana'))::int  AS dia_semana,
  CASE EXTRACT(dow FROM (created_at AT TIME ZONE 'America/Tijuana'))::int
    WHEN 0 THEN 'domingo'   WHEN 1 THEN 'lunes'    WHEN 2 THEN 'martes'
    WHEN 3 THEN 'miércoles' WHEN 4 THEN 'jueves'   WHEN 5 THEN 'viernes'
    WHEN 6 THEN 'sábado'
  END                                                        AS dia_semana_nombre,
  count(*)::int                                              AS operaciones,
  COALESCE(sum(abs(cantidad)), 0)::int                       AS unidades
FROM productos_movimientos
WHERE tipo = 'salida'
  AND created_at >= now() - interval '90 days'
GROUP BY EXTRACT(dow FROM (created_at AT TIME ZONE 'America/Tijuana'));

-- ─────────────────────────────────────────────────────────────────────────
-- Vista mix por categoría · operaciones por categoría de producto · 90d
-- LEFT JOIN a productos por slug (categoria); sin precio (NULL en catálogo).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_caja_mix_categoria AS
SELECT
  COALESCE(NULLIF(TRIM(p.categoria), ''), '(sin categoría)')  AS categoria,
  count(*)::int                                               AS operaciones,
  COALESCE(sum(abs(m.cantidad)), 0)::int                      AS unidades
FROM productos_movimientos m
LEFT JOIN productos p ON p.slug = m.producto_slug
WHERE m.tipo = 'salida'
  AND m.created_at >= now() - interval '90 days'
GROUP BY COALESCE(NULLIF(TRIM(p.categoria), ''), '(sin categoría)');

-- ─────────────────────────────────────────────────────────────────────────
-- Vista comparativo · operaciones ventana actual vs ventana previa (30/60/90)
-- 1 fila. variacion_pct = (actual - previo) / previo · 100. ingreso → NULL.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_caja_comparativo AS
WITH s AS (
  SELECT created_at FROM productos_movimientos WHERE tipo = 'salida'
)
SELECT
  -- 30 días
  (SELECT count(*) FROM s WHERE created_at >= now() - interval '30 days')::int
                                                              AS operaciones_actual_30d,
  (SELECT count(*) FROM s WHERE created_at >= now() - interval '60 days'
                            AND created_at <  now() - interval '30 days')::int
                                                              AS operaciones_previo_30d,
  ROUND(
    ((SELECT count(*) FROM s WHERE created_at >= now() - interval '30 days')
     - (SELECT count(*) FROM s WHERE created_at >= now() - interval '60 days'
                                 AND created_at <  now() - interval '30 days'))::numeric
    * 100.0
    / NULLIF((SELECT count(*) FROM s WHERE created_at >= now() - interval '60 days'
                                       AND created_at <  now() - interval '30 days'), 0), 2
  )                                                           AS variacion_30d_pct,
  -- 60 días
  (SELECT count(*) FROM s WHERE created_at >= now() - interval '60 days')::int
                                                              AS operaciones_actual_60d,
  (SELECT count(*) FROM s WHERE created_at >= now() - interval '120 days'
                            AND created_at <  now() - interval '60 days')::int
                                                              AS operaciones_previo_60d,
  ROUND(
    ((SELECT count(*) FROM s WHERE created_at >= now() - interval '60 days')
     - (SELECT count(*) FROM s WHERE created_at >= now() - interval '120 days'
                                 AND created_at <  now() - interval '60 days'))::numeric
    * 100.0
    / NULLIF((SELECT count(*) FROM s WHERE created_at >= now() - interval '120 days'
                                       AND created_at <  now() - interval '60 days'), 0), 2
  )                                                           AS variacion_60d_pct,
  -- 90 días
  (SELECT count(*) FROM s WHERE created_at >= now() - interval '90 days')::int
                                                              AS operaciones_actual_90d,
  (SELECT count(*) FROM s WHERE created_at >= now() - interval '180 days'
                            AND created_at <  now() - interval '90 days')::int
                                                              AS operaciones_previo_90d,
  ROUND(
    ((SELECT count(*) FROM s WHERE created_at >= now() - interval '90 days')
     - (SELECT count(*) FROM s WHERE created_at >= now() - interval '180 days'
                                 AND created_at <  now() - interval '90 days'))::numeric
    * 100.0
    / NULLIF((SELECT count(*) FROM s WHERE created_at >= now() - interval '180 days'
                                       AND created_at <  now() - interval '90 days'), 0), 2
  )                                                           AS variacion_90d_pct,
  NULL::numeric                                               AS ingreso_actual_30d,
  NULL::numeric                                               AS ingreso_previo_30d;

-- ─────────────────────────────────────────────────────────────────────────
-- GRANTs (consistente con I.1/I.2/I.3)
-- ─────────────────────────────────────────────────────────────────────────
GRANT SELECT ON mv_analitica_caja      TO service_role;
GRANT SELECT ON v_analitica_caja_kpis  TO service_role;
GRANT SELECT ON v_caja_flujo           TO service_role;
GRANT SELECT ON v_caja_horarios        TO service_role;
GRANT SELECT ON v_caja_dia_semana      TO service_role;
GRANT SELECT ON v_caja_mix_categoria   TO service_role;
GRANT SELECT ON v_caja_comparativo     TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Función refresh (espejo de refresh_mv_analitica_marketing)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_mv_analitica_caja()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_analitica_caja;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_mv_analitica_caja() TO service_role;

COMMIT;

-- Smoke (ejecutar aparte, NO dentro de tx — REFRESH CONCURRENTLY no admite tx):
--   SELECT refresh_mv_analitica_caja();
-- Debe retornar void sin error tras esta migration.

-- ─── ROLLBACK (descomentar manualmente si necesario) ───
-- BEGIN;
-- DROP FUNCTION IF EXISTS refresh_mv_analitica_caja();
-- DROP VIEW IF EXISTS v_caja_comparativo;
-- DROP VIEW IF EXISTS v_caja_mix_categoria;
-- DROP VIEW IF EXISTS v_caja_dia_semana;
-- DROP VIEW IF EXISTS v_caja_horarios;
-- DROP VIEW IF EXISTS v_caja_flujo;
-- DROP VIEW IF EXISTS v_analitica_caja_kpis;
-- DROP MATERIALIZED VIEW IF EXISTS mv_analitica_caja CASCADE;
-- COMMIT;
