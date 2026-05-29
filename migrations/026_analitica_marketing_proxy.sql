-- ============================================================
-- Frente I.3 · Analítica Marketing (v1 PROXY) · matview + 4 vistas
-- Spec: SPEC_FRENTE_I3_ANALITICA_MARKETING.md · §4 (spike) + §10 Fase 1
-- Spike:  MARKETING_DATA_INVENTORY.md (sesión 10, 2026-05-28) · veredicto I3-BLOCKED
-- Aplica DESPUÉS de: schema inicial (contacts) · patrón matview I.1/I.2 (015/019/022)
-- Idempotente: DROP ... CASCADE + CREATE OR REPLACE. tx-safe (BEGIN/COMMIT).
--
-- ⚠ DECISIÓN DE DISEÑO derivada de los datos reales (NO del sketch del spec):
--   · contacts es un SNAPSHOT (upsert por id) — NO hay histórico de transiciones.
--     Las tablas stage_events / meta_metrics EXISTEN en el schema pero están VACÍAS
--     (0 filas al 2026-05-28). Por eso los KPIs de COSTE (#1–#3,#10) y VELOCIDAD
--     (#5,#9) NO se calculan aquí: se difieren en el BFF con _warnings
--     (spend_pendiente / historico_pendiente). Ver api/analitica/marketing.ts.
--   · El embudo se llave por `stage_name` (libre, 19 etapas reales), NO por
--     `stage_phase`: phase colapsa ~93% de los leads a 'other' y pierde el embudo.
--     stage_phase se conserva como dimensión secundaria (MIN por grano) para el
--     KPI de interacción (3-int).
--   · ruta_split es DÉBIL: la única etapa rotulable como médica es 'RUTA MÉDICA'
--     (con É acentuada). ILIKE '%médic%' (acentuado) la matchea; ILIKE '%medic%'
--     SIN acento NO la matchea (Postgres ILIKE es case-insensitive pero NO
--     accent-insensitive). Se incluyen ambos patrones por robustez. No hay etapa
--     "comercial" rotulada → el resto cae en 'indeterminada' (no se inventa).
--   · lead_perdido / venta_proxy se detectan por substring de stage_name.
--
-- REGLA CRÍTICA (inviolable): los pipelines 252999 (SPY Z87) y 273944 (GioVision)
--   NO siguen la metodología de 3 interacciones → se EXCLUYEN de v_marketing_interaccion.
--   (Sí aparecen en funnel/kpis/ruta como cualquier pipeline; sólo la métrica de
--    interacción los omite.)
--
-- PII — NO NEGOCIABLE: ninguna relación expone name/phone/email/last_message
--   (contenido). Sólo se agregan conteos por (pipeline_id, stage_name/phase/ruta).
--
-- LECCIÓN migration 022: el UNIQUE index para REFRESH ... CONCURRENTLY debe ser
--   sobre COLUMNAS REALES (no expresión constante `((1))`). Aquí el grano natural
--   (pipeline_id, stage_name) es único y no-nulo → satisface el requisito.
-- ============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- Matview base · grano (pipeline_id, stage_name) · refresh horario via cron
-- Clasificación (es_perdida / es_venta_proxy / ruta) es función de stage_name,
-- por lo que es constante dentro de cada grupo (stage_name está en GROUP BY).
-- ─────────────────────────────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS mv_analitica_marketing CASCADE;
CREATE MATERIALIZED VIEW mv_analitica_marketing AS
WITH base AS (
  SELECT
    pipeline_id,
    COALESCE(NULLIF(TRIM(stage_name), ''), '(sin etapa)') AS stage_name,
    stage_phase
  FROM contacts
)
SELECT
  pipeline_id,
  stage_name,
  MIN(stage_phase)                                          AS stage_phase,
  count(*)::int                                             AS leads,
  (stage_name ILIKE '%perdid%'
     OR stage_name ILIKE '%fuera de cat%'
     OR stage_name ILIKE '%catch-all%'
     OR stage_name ILIKE '%descart%')                       AS es_perdida,
  (stage_name ILIKE '%venta%'
     OR stage_name ILIKE '%ganad%'
     OR stage_name ILIKE '%cerrado%')                       AS es_venta_proxy,
  CASE
    WHEN stage_name ILIKE '%médic%'
      OR stage_name ILIKE '%medic%'
      OR stage_name ILIKE '%visual%'
      OR stage_name ILIKE '%síntoma%'
      OR stage_name ILIKE '%sintoma%'        THEN 'medica'
    WHEN stage_name ILIKE '%comercial%'      THEN 'comercial'
    ELSE 'indeterminada'
  END                                                       AS ruta,
  now()                                                     AS refreshed_at
FROM base
GROUP BY pipeline_id, stage_name;

-- UNIQUE index sobre columnas REALES (grano natural) → requisito REFRESH CONCURRENTLY.
CREATE UNIQUE INDEX uq_mv_marketing_grain
    ON mv_analitica_marketing (pipeline_id, stage_name);

-- ─────────────────────────────────────────────────────────────────────────
-- Vista KPIs · por pipeline + fila agregada pipeline_id=0 ('todos')
-- GROUPING SETS ((pipeline_id), ()) → la fila () colapsa pipeline_id=NULL→0.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_marketing_kpis AS
SELECT
  COALESCE(pipeline_id, 0)::bigint                          AS pipeline_id,
  SUM(leads)::int                                           AS total_leads,
  COALESCE(SUM(leads) FILTER (WHERE es_perdida), 0)::int    AS leads_perdidos,
  COALESCE(SUM(leads) FILTER (WHERE es_venta_proxy), 0)::int AS ventas_proxy,
  ROUND(
    COALESCE(SUM(leads) FILTER (WHERE es_perdida), 0)::numeric * 100.0
    / NULLIF(SUM(leads), 0), 2
  )                                                          AS tasa_perdida_pct,
  ROUND(
    COALESCE(SUM(leads) FILTER (WHERE es_venta_proxy), 0)::numeric * 100.0
    / NULLIF(SUM(leads), 0), 2
  )                                                          AS tasa_venta_proxy_pct
FROM mv_analitica_marketing
GROUP BY GROUPING SETS ((pipeline_id), ());

-- ─────────────────────────────────────────────────────────────────────────
-- Vista funnel · leads por (pipeline_id, stage_name) + agregado por stage_name
-- La fila agregada (pipeline_id=0) suma el mismo stage_name across pipelines.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_marketing_funnel AS
SELECT
  COALESCE(pipeline_id, 0)::bigint                          AS pipeline_id,
  stage_name,
  MIN(stage_phase)                                          AS stage_phase,
  SUM(leads)::int                                           AS leads
FROM mv_analitica_marketing
GROUP BY GROUPING SETS ((pipeline_id, stage_name), (stage_name));

-- ─────────────────────────────────────────────────────────────────────────
-- Vista interacción (3-int) · stage_phase ∈ (int1,int2,int3)
-- EXCLUYE 252999 y 273944 (regla crítica: no siguen metodología 3-int).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_marketing_interaccion AS
SELECT
  COALESCE(pipeline_id, 0)::bigint                          AS pipeline_id,
  stage_phase,
  SUM(leads)::int                                           AS leads
FROM mv_analitica_marketing
WHERE pipeline_id NOT IN (252999, 273944)
  AND stage_phase IN ('int1', 'int2', 'int3')
GROUP BY GROUPING SETS ((pipeline_id, stage_phase), (stage_phase));

-- ─────────────────────────────────────────────────────────────────────────
-- Vista ruta_split · leads por ruta (medica/comercial/indeterminada) + agregado
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_marketing_ruta_split AS
SELECT
  COALESCE(pipeline_id, 0)::bigint                          AS pipeline_id,
  ruta,
  SUM(leads)::int                                           AS leads
FROM mv_analitica_marketing
GROUP BY GROUPING SETS ((pipeline_id, ruta), (ruta));

-- ─────────────────────────────────────────────────────────────────────────
-- GRANTs (consistente con I.1/I.2)
-- ─────────────────────────────────────────────────────────────────────────
GRANT SELECT ON mv_analitica_marketing  TO service_role;
GRANT SELECT ON v_marketing_kpis         TO service_role;
GRANT SELECT ON v_marketing_funnel       TO service_role;
GRANT SELECT ON v_marketing_interaccion  TO service_role;
GRANT SELECT ON v_marketing_ruta_split   TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Función refresh (espejo de refresh_mv_analitica_clinica)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_mv_analitica_marketing()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_analitica_marketing;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_mv_analitica_marketing() TO service_role;

COMMIT;

-- Smoke (ejecutar aparte, NO dentro de tx — REFRESH CONCURRENTLY no admite tx):
--   SELECT refresh_mv_analitica_marketing();
-- Debe retornar void sin error tras esta migration.

-- ─── ROLLBACK (descomentar manualmente si necesario) ───
-- BEGIN;
-- DROP FUNCTION IF EXISTS refresh_mv_analitica_marketing();
-- DROP VIEW IF EXISTS v_marketing_ruta_split;
-- DROP VIEW IF EXISTS v_marketing_interaccion;
-- DROP VIEW IF EXISTS v_marketing_funnel;
-- DROP VIEW IF EXISTS v_marketing_kpis;
-- DROP MATERIALIZED VIEW IF EXISTS mv_analitica_marketing CASCADE;
-- COMMIT;
