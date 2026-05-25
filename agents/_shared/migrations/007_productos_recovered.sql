-- =====================================================
-- GIOCORE · Migración 007 · Tabla `productos` (RECUPERADA)
-- =====================================================
-- ESTADO: RECOVERY DOCUMENTATION ONLY
--
-- Esta migración NO fue versionada en el repo original. La tabla
-- `productos` fue creada directamente en Supabase Dashboard antes
-- de que existiera la convención de migraciones numeradas en repo.
--
-- Evidencia de existencia en prod:
--   - 3,860 rows al 2026-05-25 (confirmado via REST API)
--   - Referenciada por migración 009 (FK productos_movimientos → productos(slug))
--   - Usada por cron alertas-stock-bajo, api/inventario/operaciones, api/inventario/rotacion
--
-- Por qué NO re-aplicar en Supabase:
--   - La tabla YA EXISTE en producción (IF NOT EXISTS la haría idempotente)
--   - Re-ejecutar sin revisión del optometrista podría sobreescribir stock/precios reales
--   - Acción correcta: solo versionar como referencia para reproducibilidad
--
-- Si se necesita re-crear en un entorno nuevo (staging, local):
--   1. Revisar que las columnas aquí documentadas coincidan con prod actual (introspección REST)
--   2. Adaptar constraints y defaults a los valores reales
--   3. Cargar datos con `COPY` o script de seed separado (los 3,860 productos)
--
-- Recuperado por: Code · 2026-05-25
-- Ver: obsidian-vault/01-Architecture/decisions/DEC-002-migraciones-numeracion.md
-- =====================================================

-- ROLLBACK: no documentado (tabla con datos productivos — no dropear sin consenso Isaac)

-- ── Tabla núcleo de productos ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.productos (
  -- Identificadores
  slug          TEXT PRIMARY KEY,                         -- PK usada como FK en productos_movimientos
  sku           TEXT,                                     -- SKU interno / código de proveedor

  -- Descripción
  nombre        TEXT NOT NULL,
  marca         TEXT,
  categoria     TEXT,
  subcategoria  TEXT,
  coleccion     TEXT,

  -- Estado
  estado        TEXT NOT NULL DEFAULT 'activo'
                  CHECK (estado IN ('activo','inactivo','descontinuado')),
  es_destacado  BOOLEAN DEFAULT FALSE,

  -- Stock (se gestiona via función registrar_movimiento — ver migración 009)
  stock_actual  INT NOT NULL DEFAULT 0,
  stock_minimo  INT NOT NULL DEFAULT 2,

  -- Ubicación física
  ubicacion     TEXT,

  -- Precios
  precio_costo    NUMERIC(10,2),
  precio_publico  NUMERIC(10,2),
  precio_promo    NUMERIC(10,2),
  moneda          TEXT NOT NULL DEFAULT 'MXN',

  -- Atributos físicos
  color         TEXT,
  talla         TEXT,
  material      TEXT,

  -- Proveedor
  proveedor     TEXT,
  sku_proveedor TEXT,

  -- Assets digitales
  imagen_principal  TEXT,                                 -- URL CDN o Drive
  drive_url         TEXT,

  -- Auditoría
  creado_en     TIMESTAMPTZ DEFAULT NOW(),
  actualizado_en TIMESTAMPTZ DEFAULT NOW(),

  -- Vault / Obsidian sync
  md_original_path  TEXT,                               -- path relativo en vault local
  md_sha256         TEXT,                               -- hash del .md origen para detectar cambios

  -- Notas
  notas_internas    TEXT,

  -- Full-text search (español)
  tsv_busqueda      TSVECTOR
    GENERATED ALWAYS AS (
      to_tsvector('spanish',
        coalesce(nombre,'') || ' ' ||
        coalesce(sku,'') || ' ' ||
        coalesce(slug,'') || ' ' ||
        coalesce(marca,'') || ' ' ||
        coalesce(categoria,'') || ' ' ||
        coalesce(notas_internas,'')
      )
    ) STORED
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_productos_categoria ON public.productos(categoria) WHERE estado = 'activo';
CREATE INDEX IF NOT EXISTS idx_productos_marca ON public.productos(marca) WHERE estado = 'activo';
CREATE INDEX IF NOT EXISTS idx_productos_stock ON public.productos(stock_actual) WHERE estado = 'activo';
CREATE INDEX IF NOT EXISTS idx_productos_tsv ON public.productos USING gin(tsv_busqueda);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.actualizado_en = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_productos_updated_at ON public.productos;
CREATE TRIGGER trg_productos_updated_at
  BEFORE UPDATE ON public.productos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: anon puede leer productos activos; service_role puede todo
ALTER TABLE public.productos ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "anon_read_activos" ON public.productos
  FOR SELECT TO anon USING (estado = 'activo');
