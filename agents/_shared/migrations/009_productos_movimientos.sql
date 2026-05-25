-- Migration 009 · productos_movimientos (Frente E · inventario interactivo)
-- Fecha: 2026-05-23 PM
-- Spec: PROMPT_CODE_FRENTE_E.md / BRIEF_CODE_FRENTE_E_INVENTARIO.md
--
-- Contenido:
--   0. expedientes.venta_cerrada (BOOLEAN, default false) — pre-requisito del trigger
--   1. Tabla productos_movimientos (ledger inmutable de cambios de stock)
--   2. PG function registrar_movimiento (SECURITY DEFINER, FOR UPDATE, idempotente)
--   3. Trigger decrement stock en expedientes.venta_cerrada=true
--   4. Materialized view productos_rotacion_mensual + UNIQUE index (para CONCURRENTLY)
--   5. RPC refresh_productos_rotacion (callable via supabase.rpc, evita pg.Pool runtime)
--   6. RLS readonly para anon en productos_movimientos
--
-- Decisiones vs. brief:
--   - Columna `producto_slug` (no `producto_sku`): productos PK es `slug` TEXT;
--     `sku` es columna nullable distinta. Usamos slug para FK explícita.
--   - RPC en vez de pg.Pool runtime: mantiene pg como devDep, código de cron
--     usa supabase-js (consistente con resto del proyecto).
--   - Trigger usa `WHEN (OLD.venta_cerrada IS DISTINCT FROM NEW.venta_cerrada
--     AND NEW.venta_cerrada = true)` para correr SOLO en la transición
--     false→true (no en cada UPDATE del row).

/* ── 0 · expedientes.venta_cerrada ────────────────────────────────────── */

ALTER TABLE public.expedientes
  ADD COLUMN IF NOT EXISTS venta_cerrada BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_expedientes_venta_cerrada
  ON public.expedientes(venta_cerrada)
  WHERE venta_cerrada = true;

/* ── 1 · Tabla productos_movimientos ──────────────────────────────────── */

CREATE TABLE IF NOT EXISTS public.productos_movimientos (
  id BIGSERIAL PRIMARY KEY,
  producto_slug TEXT NOT NULL REFERENCES public.productos(slug)
                ON UPDATE CASCADE ON DELETE RESTRICT,
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'salida', 'ajuste', 'devolucion')),
  cantidad INTEGER NOT NULL CHECK (cantidad <> 0),
  stock_anterior INTEGER NOT NULL,
  stock_nuevo INTEGER NOT NULL CHECK (stock_nuevo >= 0),
  proveedor TEXT,
  costo_unitario NUMERIC(10,2),
  motivo TEXT,
  registrado_por TEXT NOT NULL DEFAULT 'api',
  idempotency_key TEXT,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_movimientos_producto_created
  ON public.productos_movimientos(producto_slug, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_movimientos_tipo_created
  ON public.productos_movimientos(tipo, created_at DESC);

-- Partial unique para idempotencia: NULL no es único (múltiples NULL OK)
CREATE UNIQUE INDEX IF NOT EXISTS uq_mov_idempotency
  ON public.productos_movimientos(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON TABLE public.productos_movimientos IS
$$Frente E · ledger de movimientos de inventario. NUNCA INSERT directo; usar siempre RPC registrar_movimiento() (FOR UPDATE atomic + idempotencia).$$;

/* ── 2 · RPC registrar_movimiento ─────────────────────────────────────── */

CREATE OR REPLACE FUNCTION public.registrar_movimiento(
  p_slug            TEXT,
  p_tipo            TEXT,
  p_cantidad        INTEGER,
  p_proveedor       TEXT    DEFAULT NULL,
  p_costo_unitario  NUMERIC DEFAULT NULL,
  p_motivo          TEXT    DEFAULT NULL,
  p_registrado_por  TEXT    DEFAULT 'api',
  p_idempotency_key TEXT    DEFAULT NULL,
  p_metadata        JSONB   DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stock_actual INTEGER;
  v_costo_actual NUMERIC;
  v_stock_nuevo  INTEGER;
  v_costo_nuevo  NUMERIC;
  v_delta        INTEGER;
  v_mov_id       BIGINT;
  v_existing_id  BIGINT;
BEGIN
  /* Idempotencia · si la key existe → devolver id existente sin tocar nada. */
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_id
      FROM productos_movimientos
     WHERE idempotency_key = p_idempotency_key;
    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  /* Validar args (defensive aunque el handler ya valide). */
  IF p_tipo NOT IN ('entrada','salida','ajuste','devolucion') THEN
    RAISE EXCEPTION 'tipo inválido: %', p_tipo USING ERRCODE = '22023';
  END IF;
  IF p_cantidad = 0 THEN
    RAISE EXCEPTION 'cantidad no puede ser 0' USING ERRCODE = '22023';
  END IF;

  /* Lock + read row de productos (race-safe). */
  SELECT stock_actual, precio_costo
    INTO v_stock_actual, v_costo_actual
    FROM productos
   WHERE slug = p_slug
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'producto no existe: %', p_slug USING ERRCODE = 'P0002';
  END IF;

  /* Calcular delta según tipo. cantidad negativa solo válida en 'ajuste'. */
  v_delta := CASE
    WHEN p_tipo IN ('entrada','devolucion') THEN ABS(p_cantidad)
    WHEN p_tipo = 'salida'                  THEN -ABS(p_cantidad)
    WHEN p_tipo = 'ajuste'                  THEN p_cantidad
  END;

  v_stock_nuevo := v_stock_actual + v_delta;
  IF v_stock_nuevo < 0 THEN
    RAISE EXCEPTION 'stock negativo: stock_actual=% delta=% slug=%',
      v_stock_actual, v_delta, p_slug USING ERRCODE = '23514';
  END IF;

  /* Costo promedio ponderado · solo en entrada con costo_unitario provisto.
     Fórmula: ((costo_actual * stock_actual) + (nuevo_costo * cantidad)) / stock_nuevo */
  IF p_tipo = 'entrada' AND p_costo_unitario IS NOT NULL AND p_costo_unitario > 0 THEN
    IF v_stock_actual > 0 AND v_costo_actual IS NOT NULL AND v_costo_actual > 0 THEN
      v_costo_nuevo := ROUND(
        ((v_costo_actual * v_stock_actual) + (p_costo_unitario * ABS(p_cantidad)))::numeric
        / NULLIF(v_stock_nuevo, 0),
        2
      );
    ELSE
      v_costo_nuevo := p_costo_unitario;
    END IF;
  ELSE
    v_costo_nuevo := v_costo_actual;
  END IF;

  /* Insert ledger entry. */
  INSERT INTO productos_movimientos (
    producto_slug, tipo, cantidad, stock_anterior, stock_nuevo,
    proveedor, costo_unitario, motivo, registrado_por, idempotency_key, metadata
  ) VALUES (
    p_slug, p_tipo, p_cantidad, v_stock_actual, v_stock_nuevo,
    p_proveedor, p_costo_unitario, p_motivo, p_registrado_por, p_idempotency_key, p_metadata
  )
  RETURNING id INTO v_mov_id;

  /* Update productos manteniendo el FOR UPDATE lock. */
  UPDATE productos
     SET stock_actual    = v_stock_nuevo,
         precio_costo    = v_costo_nuevo,
         actualizado_en  = NOW()
   WHERE slug = p_slug;

  RETURN v_mov_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.registrar_movimiento(
  TEXT, TEXT, INTEGER, TEXT, NUMERIC, TEXT, TEXT, TEXT, JSONB
) TO service_role;

/* ── 3 · Trigger decrement stock on venta_cerrada=true ────────────────── */

CREATE OR REPLACE FUNCTION public.trigger_decrement_stock_on_venta()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_slug TEXT;
BEGIN
  /* Si no hay productos asociados al expediente → no-op */
  IF NEW.productos_recomendados IS NULL OR array_length(NEW.productos_recomendados, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  FOREACH v_slug IN ARRAY NEW.productos_recomendados
  LOOP
    /* idempotency_key determinístico: re-UPDATE del mismo expediente
       NO duplica movimientos (uq_mov_idempotency). */
    PERFORM registrar_movimiento(
      p_slug            := v_slug,
      p_tipo            := 'salida',
      p_cantidad        := 1,
      p_motivo          := 'venta cerrada · expediente ' || NEW.id,
      p_registrado_por  := 'trigger:expedientes',
      p_idempotency_key := 'venta_' || NEW.id || '_' || v_slug
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_decrement_stock ON public.expedientes;

CREATE TRIGGER trigger_decrement_stock
  AFTER UPDATE OF venta_cerrada ON public.expedientes
  FOR EACH ROW
  WHEN (OLD.venta_cerrada IS DISTINCT FROM NEW.venta_cerrada
        AND NEW.venta_cerrada = true)
  EXECUTE FUNCTION public.trigger_decrement_stock_on_venta();

/* ── 4 · Materialized view productos_rotacion_mensual ─────────────────── */

CREATE MATERIALIZED VIEW IF NOT EXISTS public.productos_rotacion_mensual AS
WITH ventas AS (
  SELECT
    producto_slug,
    COUNT(*) FILTER (WHERE tipo = 'salida' AND created_at > NOW() - INTERVAL '30 days')  AS ventas_30d,
    COUNT(*) FILTER (WHERE tipo = 'salida' AND created_at > NOW() - INTERVAL '90 days')  AS ventas_90d,
    SUM(ABS(cantidad)) FILTER (WHERE tipo = 'salida' AND created_at > NOW() - INTERVAL '30 days') AS unidades_30d,
    SUM(ABS(cantidad)) FILTER (WHERE tipo = 'salida' AND created_at > NOW() - INTERVAL '90 days') AS unidades_90d,
    MAX(created_at) FILTER (WHERE tipo = 'salida') AS ultima_venta_real
  FROM productos_movimientos
  GROUP BY producto_slug
)
SELECT
  p.slug             AS sku,            -- alias 'sku' por compat con dashboard / brief
  p.nombre,
  p.categoria,
  p.stock_actual,
  p.stock_minimo,
  p.precio_publico,
  p.precio_costo,
  COALESCE(v.ventas_30d,   0) AS ventas_30d,
  COALESCE(v.ventas_90d,   0) AS ventas_90d,
  COALESCE(v.unidades_30d, 0) AS unidades_30d,
  COALESCE(v.unidades_90d, 0) AS unidades_90d,
  CASE WHEN p.stock_actual > 0
       THEN ROUND((COALESCE(v.unidades_30d, 0)::numeric / p.stock_actual), 4)
       ELSE 0
  END AS rotacion_30d,
  v.ultima_venta_real,
  NOW() AS computed_at
FROM productos p
LEFT JOIN ventas v ON v.producto_slug = p.slug;

-- UNIQUE index requerido para REFRESH ... CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS uq_rotacion_sku
  ON public.productos_rotacion_mensual(sku);

CREATE INDEX IF NOT EXISTS idx_rotacion_ventas30
  ON public.productos_rotacion_mensual(ventas_30d DESC);

CREATE INDEX IF NOT EXISTS idx_rotacion_categoria
  ON public.productos_rotacion_mensual(categoria);

-- Index parcial para detectar "productos muertos" rápido
CREATE INDEX IF NOT EXISTS idx_rotacion_muertos
  ON public.productos_rotacion_mensual(stock_actual)
  WHERE ventas_90d = 0 AND stock_actual > 0;

/* ── 5 · RPC refresh_productos_rotacion ───────────────────────────────── */

CREATE OR REPLACE FUNCTION public.refresh_productos_rotacion()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_start TIMESTAMP := clock_timestamp();
  v_rows  BIGINT;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY productos_rotacion_mensual;
  SELECT COUNT(*) INTO v_rows FROM productos_rotacion_mensual;
  RETURN jsonb_build_object(
    'rows', v_rows,
    'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - v_start)) * 1000)::int,
    'refreshed_at', NOW()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_productos_rotacion() TO service_role;

/* ── 6 · RLS para dashboard /inventario.html ──────────────────────────── */

ALTER TABLE public.productos_movimientos ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'productos_movimientos'
       AND policyname = 'anon_select_movimientos'
  ) THEN
    CREATE POLICY anon_select_movimientos
      ON public.productos_movimientos
      FOR SELECT TO anon
      USING (true);
  END IF;
END $$;

-- productos tiene RLS (Frente A) — agregamos política anon-select si falta.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'productos'
       AND policyname = 'anon_select_productos'
  ) THEN
    CREATE POLICY anon_select_productos
      ON public.productos
      FOR SELECT TO anon
      USING (estado = 'activo');
  END IF;
END $$;

-- Matviews no soportan RLS directo; el acceso anon se controla por:
-- PostgREST expone matviews por default → ya queda accesible para anon como SELECT.
-- Si se requiere restringir más, hacer el matview en un schema separado.

-- Frente E · 23-may-2026 PM · cierra CORE 100%
