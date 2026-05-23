-- Migration 008 · backups_manifest (Frente H · big data + backup multicapa)
-- Fecha: 2026-05-23
-- Spec: BRIEF_CODE_FRENTE_H_BIGDATA_BACKUP.md
--
-- Ajuste pragmático vs. brief (mismo patrón que migración 006 / Frente D):
--   El brief asumía persistencia en disco local `~/giolens_deploy/snapshots/`.
--   En Vercel serverless no existe FS persistente entre invocaciones (sólo /tmp
--   ephemeral, perdido entre runs). Solución: persistir el contenido gzipped
--   inline en `backups_manifest.data_b64` (TEXT base64). Volumen estimado:
--     · 9 tablas × ~5 KB gz/c-u × 30 días retención = ~1.4 MB (Free tier OK)
--     · 5 pipelines × ~5 MB gz = ~25 MB Wapify historical (one-time)
--   Quando B2 esté configurado, el cron backup-monthly agrega los rows del mes
--   en un zip cifrado y los sube a B2 como capa fría.

CREATE TABLE IF NOT EXISTS public.backups_manifest (
  id BIGSERIAL PRIMARY KEY,

  -- Tipo de backup. Restringido a valores conocidos.
  type TEXT NOT NULL CHECK (type IN (
    'snapshot_daily',         -- 1 fila por tabla por día
    'wapify_historical',      -- 1 fila por pipeline (bootstrap one-time)
    'wapify_delta',           -- 1 fila por pipeline por día (post-bootstrap)
    'backup_monthly',         -- 1 fila por mes (zip B2)
    'sql_dump_weekly'         -- placeholder (script local Isaac)
  )),

  -- Identificador lógico del artefacto. Permite reconstruir paths intuitivos
  -- aunque el storage real sea DB inline. Formato sugerido:
  --   snapshot_YYYY-MM-DD/{table}.json.gz
  --   wapify_historical/pipeline_{id}.json.gz
  --   wapify_delta_YYYY-MM-DD/pipeline_{id}.json.gz
  --   backup_monthly/giocore-YYYY-MM.zip
  path TEXT NOT NULL,

  -- SHA256 hex del contenido original (pre-base64). Verificación integridad.
  sha256 TEXT,

  -- Tamaño del contenido comprimido (bytes gz, NO base64).
  size_bytes BIGINT,

  -- Tamaño descomprimido (para validar compression ratio < 10%).
  uncompressed_bytes BIGINT,

  -- Conteo de rows por tabla/pipeline (JSON). Ej: {"contacts": 4690}.
  row_counts JSONB,

  -- Storage backend. 'supabase_inline' = data en data_b64 acá.
  --                  'b2' = solo metadata acá, contenido en bucket.
  --                  'both' = inline + B2 (durante migración).
  storage TEXT NOT NULL DEFAULT 'supabase_inline' CHECK (storage IN (
    'supabase_inline', 'b2', 'both'
  )),

  -- Si storage incluye 'b2', el key/path dentro del bucket.
  b2_key TEXT,

  -- Contenido gzipped + base64 encoded. NULL si storage='b2' (no inline).
  -- TEXT en vez de BYTEA por simplicidad de RPC supabase-js.
  data_b64 TEXT,

  -- Estado del run.
  --   'pending'     row creado pero no terminado (rarely used; flow normal va directo a otro).
  --   'in_progress' bootstrap parcial Wapify (resume_offset en metadata, no completado).
  --   'completed'   bootstrap o delta terminado, contenido íntegro.
  --   'failed'      el run abortó con error (ver error_message).
  --   'deleted'     row purgado por retención (raramente persistido; normalmente DELETE).
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'in_progress', 'completed', 'failed', 'deleted'
  )),

  -- Si falló, motivo legible para humanos.
  error_message TEXT,

  -- Metadata libre por tipo (ej. resume offset Wapify historical).
  metadata JSONB,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,

  -- Cuando el row puede ser purgado por la rotación. NULL = no expira.
  expires_at TIMESTAMP WITH TIME ZONE
);

-- Lookup principal: "dame el snapshot más reciente del tipo X".
CREATE INDEX IF NOT EXISTS idx_backups_type_created
  ON public.backups_manifest(type, created_at DESC);

-- Para listar in-flight / failed sin escanear toda la tabla.
CREATE INDEX IF NOT EXISTS idx_backups_status_pending
  ON public.backups_manifest(status)
  WHERE status IN ('pending', 'failed');

-- Para la rotación (cron purga expires_at < NOW()).
CREATE INDEX IF NOT EXISTS idx_backups_expires
  ON public.backups_manifest(expires_at)
  WHERE expires_at IS NOT NULL AND status = 'completed';

-- RLS: solo service_role escribe/lee (CRON_SECRET). Cliente público NO debe ver
-- contenido de backups (PII potencial en data_b64).
ALTER TABLE public.backups_manifest ENABLE ROW LEVEL SECURITY;

-- Sin policies para anon/authenticated → cero acceso desde el cliente.
-- Service_role bypasea RLS por default, así que el cron sigue funcionando.

COMMENT ON TABLE public.backups_manifest IS
  'Frente H · manifiesto de backups GIOCORE. Storage inline en data_b64 ' ||
  '(gzipped + base64) para snapshots diarios; B2 para zips mensuales fríos.';

COMMENT ON COLUMN public.backups_manifest.data_b64 IS
  'Contenido gzipped luego base64-encoded. NULL si storage=b2. Compression ' ||
  'esperada <10% original (acceptance criteria brief §H).';
