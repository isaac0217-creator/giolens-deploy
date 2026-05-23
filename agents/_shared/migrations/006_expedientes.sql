-- Migration 006 · expedientes (captura iPad-first)
-- Fecha: 2026-05-23
-- Spec: BRIEF_CODE_FRENTE_D_CAPTURA_EXPEDIENTES.md
--
-- Tabla `expedientes` para captura clínica desde form web (iPad-first).
-- Mantiene FK suave a `contacts(contact_id)` (ON DELETE SET NULL) y persiste
-- el .md generado en `vault_md_content` para sync local posterior al vault
-- Obsidian (pragmatic adjustment: Vercel serverless no tiene FS persistente).

CREATE TABLE IF NOT EXISTS public.expedientes (
  id BIGSERIAL PRIMARY KEY,
  -- contact_id es link suave a contacts.contact_id; sin FK porque ese campo
  -- repite (1 contact en N opportunities en `contacts`). El handler hace
  -- el matching por teléfono y persiste el contact_id si encuentra match.
  contact_id TEXT,
  paciente_nombre TEXT NOT NULL,
  paciente_telefono TEXT,
  paciente_email TEXT,
  fecha_examen DATE NOT NULL DEFAULT CURRENT_DATE,
  optometrista TEXT,
  -- Graduación OD (ojo derecho)
  od_esfera NUMERIC(5,2) CHECK (od_esfera IS NULL OR od_esfera BETWEEN -25 AND 25),
  od_cilindro NUMERIC(5,2) CHECK (od_cilindro IS NULL OR od_cilindro BETWEEN -12 AND 12),
  od_eje INT CHECK (od_eje IS NULL OR od_eje BETWEEN 0 AND 180),
  od_adicion NUMERIC(4,2) CHECK (od_adicion IS NULL OR od_adicion BETWEEN 0 AND 5),
  -- Graduación OI (ojo izquierdo)
  oi_esfera NUMERIC(5,2) CHECK (oi_esfera IS NULL OR oi_esfera BETWEEN -25 AND 25),
  oi_cilindro NUMERIC(5,2) CHECK (oi_cilindro IS NULL OR oi_cilindro BETWEEN -12 AND 12),
  oi_eje INT CHECK (oi_eje IS NULL OR oi_eje BETWEEN 0 AND 180),
  oi_adicion NUMERIC(4,2) CHECK (oi_adicion IS NULL OR oi_adicion BETWEEN 0 AND 5),
  -- Otros campos clínicos
  distancia_interpupilar NUMERIC(4,1) CHECK (distancia_interpupilar IS NULL OR distancia_interpupilar BETWEEN 40 AND 90),
  agudeza_visual_od TEXT,
  agudeza_visual_oi TEXT,
  antecedentes TEXT,
  observaciones TEXT,
  productos_recomendados TEXT[],
  firma_data_url TEXT,
  -- Metadata vault sync
  capturado_por TEXT NOT NULL,
  capturado_desde TEXT NOT NULL DEFAULT 'web_form_ipad',
  vault_md_path TEXT,
  vault_md_content TEXT,
  vault_synced_at TIMESTAMP WITH TIME ZONE,
  raw_form_data JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expedientes_contact ON public.expedientes(contact_id);
CREATE INDEX IF NOT EXISTS idx_expedientes_fecha ON public.expedientes(fecha_examen DESC);
CREATE INDEX IF NOT EXISTS idx_expedientes_paciente ON public.expedientes USING gin(to_tsvector('spanish', coalesce(paciente_nombre, '')));
CREATE INDEX IF NOT EXISTS idx_expedientes_vault_pending ON public.expedientes(id)
  WHERE vault_synced_at IS NULL AND vault_md_content IS NOT NULL;

-- RLS: service_role escribe, anon solo lee (no expone PII por sí mismo;
-- el endpoint api/expediente sanitiza antes de devolver).
ALTER TABLE public.expedientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS expedientes_service_role ON public.expedientes;
CREATE POLICY expedientes_service_role ON public.expedientes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS expedientes_anon_select ON public.expedientes;
CREATE POLICY expedientes_anon_select ON public.expedientes
  FOR SELECT TO anon USING (true);

-- Trigger updated_at idempotente (la función puede existir de migraciones previas).
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_expedientes_updated_at ON public.expedientes;
CREATE TRIGGER update_expedientes_updated_at
  BEFORE UPDATE ON public.expedientes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
