-- ============================================================
-- Frente I.2 · Analítica Clínica · matview KPIs + vistas por métrica
-- Spec: SPEC_FRENTE_I2_ANALITICA_CLINICA.md (Fase 1 backend)
-- Aplica DESPUÉS de: 006 (expedientes) · 009 (productos_movimientos) ·
--                    010 (citas) · 015 (patrón matview I.1)
-- Idempotente: DROP ... CASCADE + CREATE OR REPLACE.
--
-- ⚠ SHAPE REAL validado contra migrations en main (NO contra el sketch §8
--   del spec, que asumía columnas inexistentes):
--   · expedientes NO tiene `paciente_hash` → el vínculo expediente↔cita es la
--     FK `citas.expediente_id` (migration 010), NO un hash. Esto además es
--     PII-safe: no tocamos email/teléfono para derivar identidad.
--   · "venta" se deriva de `expedientes.venta_cerrada` (BOOLEAN, migration 009)
--     que es la señal autoritativa (el trigger genera los movimientos salida
--     a partir de ese flag). NO se parsea `motivo`/`idempotency_key`.
--   · `citas.estado ∈ (agendada, confirmada, cancelada, realizada)`;
--     `fecha` es DATE, `hora` es TIME.
--
-- PII: ninguna relación de esta migration expone nombre/teléfono/email/
--      diagnóstico. `paciente_hash` (SHA256[:16], ya anonimizado) sí se expone
--      en v_clinica_alertas — es el único identificador permitido por el spec §6.
-- ============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- Matview de KPIs escalares (1 fila) · refresh horario via cron
-- ─────────────────────────────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS mv_analitica_clinica CASCADE;
CREATE MATERIALIZED VIEW mv_analitica_clinica AS
WITH
  exp_30 AS (
    SELECT id, venta_cerrada FROM expedientes
    WHERE created_at >= now() - interval '30 days'
  ),
  exp_60 AS (
    SELECT id, venta_cerrada FROM expedientes
    WHERE created_at >= now() - interval '60 days'
  ),
  exp_90 AS (
    SELECT id, created_at FROM expedientes
    WHERE created_at >= now() - interval '90 days'
  ),
  -- expedientes 90d con ≥1 cita posterior (join por FK, PII-safe)
  exp_con_cita_90 AS (
    SELECT DISTINCT e.id
    FROM exp_90 e
    JOIN citas c ON c.expediente_id = e.id
                AND c.created_at >= e.created_at
  ),
  -- citas pasadas resueltas (para show rate · excluye futuras y aún 'agendada')
  citas_resueltas AS (
    SELECT estado FROM citas
    WHERE fecha < CURRENT_DATE
      AND estado IN ('confirmada', 'realizada', 'cancelada')
  ),
  -- recurrencia 60d: pacientes por nº de citas en la ventana
  cita_60_por_paciente AS (
    SELECT paciente_hash, count(*) AS n
    FROM citas
    WHERE fecha >= CURRENT_DATE - 60
    GROUP BY paciente_hash
  ),
  -- gaps entre citas consecutivas del mismo paciente (180d)
  gaps AS (
    SELECT (fecha - LAG(fecha) OVER (
              PARTITION BY paciente_hash ORDER BY fecha, hora))::numeric AS gap_dias
    FROM citas
    WHERE fecha >= CURRENT_DATE - 180
  ),
  -- última cita "real" por paciente (para alertas de seguimiento)
  ult_cita AS (
    SELECT paciente_hash, max(fecha) AS ultima
    FROM citas
    WHERE estado IN ('confirmada', 'realizada')
    GROUP BY paciente_hash
  )
SELECT
  -- 1 · % expedientes (90d) que generaron ≥1 cita
  ROUND(
    (SELECT count(*) FROM exp_con_cita_90)::numeric * 100.0
    / NULLIF((SELECT count(*) FROM exp_90), 0), 2
  )                                                          AS expediente_to_cita_rate,
  -- 2 · show rate: confirmada/realizada vs total resuelto (citas pasadas)
  ROUND(
    (SELECT count(*) FILTER (WHERE estado IN ('confirmada', 'realizada'))
       FROM citas_resueltas)::numeric * 100.0
    / NULLIF((SELECT count(*) FROM citas_resueltas), 0), 2
  )                                                          AS cita_show_rate,
  -- 3 · % expedientes (60d) con venta cerrada (flag autoritativo)
  ROUND(
    (SELECT count(*) FILTER (WHERE venta_cerrada) FROM exp_60)::numeric * 100.0
    / NULLIF((SELECT count(*) FROM exp_60), 0), 2
  )                                                          AS expediente_to_venta_rate,
  -- 4 · % pacientes con ≥2 citas en 60d (proxy fidelización)
  ROUND(
    (SELECT count(*) FILTER (WHERE n >= 2) FROM cita_60_por_paciente)::numeric * 100.0
    / NULLIF((SELECT count(*) FROM cita_60_por_paciente), 0), 2
  )                                                          AS recurrencia_60d,
  -- 5 · días promedio entre citas consecutivas (180d)
  ROUND(
    (SELECT avg(gap_dias) FROM gaps WHERE gap_dias IS NOT NULL), 1
  )                                                          AS tiempo_entre_citas_promedio_dias,
  -- 6 · total citas confirmadas/realizadas 30d (escalar · ranking en v_clinica_productividad)
  (SELECT count(*) FROM citas
     WHERE fecha >= CURRENT_DATE - 30
       AND estado IN ('confirmada', 'realizada'))::int       AS citas_confirmadas_30d,
  -- 7 · unidades de salida 30d (escalar · breakdown por categoría deferido a Fase 2)
  COALESCE((SELECT sum(abs(cantidad)) FROM productos_movimientos
     WHERE tipo = 'salida'
       AND created_at >= now() - interval '30 days'), 0)::int AS salidas_unidades_30d,
  -- 8 · pacientes sin cita real >180d (alertas seguimiento · lista en v_clinica_alertas)
  (SELECT count(*) FROM ult_cita WHERE ultima < CURRENT_DATE - 180)::int
                                                              AS alertas_seguimiento_count,
  now()                                                       AS refreshed_at;

-- UNIQUE index singleton requerido para REFRESH ... CONCURRENTLY (matview 1 fila)
CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_clinica_singleton
    ON mv_analitica_clinica((1));

-- ─────────────────────────────────────────────────────────────────────────
-- Vista KPIs (espejo de patrón I.1 · 8 keys exactos)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_analitica_clinica_kpis AS
SELECT
  expediente_to_cita_rate,
  cita_show_rate,
  expediente_to_venta_rate,
  recurrencia_60d,
  tiempo_entre_citas_promedio_dias,
  citas_confirmadas_30d,
  salidas_unidades_30d,
  alertas_seguimiento_count
FROM mv_analitica_clinica;

-- ─────────────────────────────────────────────────────────────────────────
-- Vista conversion_funnel (1 fila · 3 stages)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_clinica_conversion_funnel AS
WITH exp90 AS (
  SELECT id FROM expedientes WHERE created_at >= now() - interval '90 days'
)
SELECT
  (SELECT count(*) FROM exp90)::int                          AS expedientes_90d,
  (SELECT count(DISTINCT e.id)
     FROM exp90 e
     JOIN citas c ON c.expediente_id = e.id)::int            AS expedientes_con_cita_90d,
  (SELECT count(*) FROM expedientes
     WHERE created_at >= now() - interval '60 days'
       AND venta_cerrada)::int                               AS expedientes_con_venta_60d;

-- ─────────────────────────────────────────────────────────────────────────
-- Vista recurrencia (histograma · pacientes por nº de citas en 90d)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_clinica_recurrencia AS
WITH por_paciente AS (
  SELECT paciente_hash, count(*) AS n
  FROM citas
  WHERE fecha >= CURRENT_DATE - 90
  GROUP BY paciente_hash
)
SELECT bucket AS num_citas_bucket, count(*)::int AS pacientes
FROM (
  SELECT CASE
           WHEN n = 1 THEN '1'
           WHEN n = 2 THEN '2'
           WHEN n BETWEEN 3 AND 4 THEN '3-4'
           ELSE '5+'
         END AS bucket
  FROM por_paciente
) b
GROUP BY bucket;

-- ─────────────────────────────────────────────────────────────────────────
-- Vista productividad (ranking optometristas · citas confirmadas 30d)
-- Normaliza optometrista (TRIM + lower) para mitigar typos/case (spec §9).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_clinica_productividad AS
SELECT
  lower(trim(optometrista))                AS optometrista,
  count(*)::int                            AS citas_confirmadas_30d
FROM citas
WHERE fecha >= CURRENT_DATE - 30
  AND estado IN ('confirmada', 'realizada')
  AND optometrista IS NOT NULL
  AND trim(optometrista) <> ''
GROUP BY lower(trim(optometrista));

-- ─────────────────────────────────────────────────────────────────────────
-- Vista alertas (pacientes sin cita real >180d · SOLO paciente_hash + fechas)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_clinica_alertas AS
SELECT
  paciente_hash,
  max(fecha)                                          AS ultima_cita_fecha,
  (CURRENT_DATE - max(fecha))::int                    AS dias_sin_cita
FROM citas
WHERE estado IN ('confirmada', 'realizada')
GROUP BY paciente_hash
HAVING max(fecha) < CURRENT_DATE - 180;

-- ─────────────────────────────────────────────────────────────────────────
-- GRANTs (consistente con I.1)
-- ─────────────────────────────────────────────────────────────────────────
GRANT SELECT ON mv_analitica_clinica        TO service_role;
GRANT SELECT ON v_analitica_clinica_kpis     TO service_role;
GRANT SELECT ON v_clinica_conversion_funnel  TO service_role;
GRANT SELECT ON v_clinica_recurrencia        TO service_role;
GRANT SELECT ON v_clinica_productividad      TO service_role;
GRANT SELECT ON v_clinica_alertas            TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Función refresh (espejo de refresh_mv_analitica_inventario)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_mv_analitica_clinica()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_analitica_clinica;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_mv_analitica_clinica() TO service_role;

COMMIT;

-- ─── ROLLBACK (descomentar manualmente si necesario) ───
-- BEGIN;
-- DROP FUNCTION IF EXISTS refresh_mv_analitica_clinica();
-- DROP VIEW IF EXISTS v_clinica_alertas;
-- DROP VIEW IF EXISTS v_clinica_productividad;
-- DROP VIEW IF EXISTS v_clinica_recurrencia;
-- DROP VIEW IF EXISTS v_clinica_conversion_funnel;
-- DROP VIEW IF EXISTS v_analitica_clinica_kpis;
-- DROP MATERIALIZED VIEW IF EXISTS mv_analitica_clinica CASCADE;
-- COMMIT;
