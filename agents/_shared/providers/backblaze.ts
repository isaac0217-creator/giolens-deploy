/**
 * GIOCORE Frente H — Wrapper Backblaze B2 vía SDK S3-compatible.
 *
 * Spec: BRIEF_CODE_FRENTE_H_BIGDATA_BACKUP.md §setup-cloud.
 *
 * Decisión arquitectónica: usamos `@aws-sdk/client-s3` apuntando al endpoint
 * S3-compatible de B2 (en vez del SDK B2 nativo) para mantener una sola
 * dependencia conocida y portabilidad si migramos a S3/R2/MinIO en el futuro.
 *
 * Lazy init: el módulo SE IMPORTA SIN errores aunque no haya vars B2 en el
 * entorno. Solo `getB2Client()` y los métodos que lo usan lanzan si faltan.
 * Esto permite que `snapshot-daily.ts` (que NO usa B2 hasta el zip mensual)
 * funcione antes del CHECKPOINT 1.6.5 sin las 4 vars de Isaac.
 *
 * Vars esperadas (NO leemos al import; sólo al primer getB2Client()):
 *   - B2_KEY_ID         Application Key ID
 *   - B2_APP_KEY        Application Key secret
 *   - B2_BUCKET         Nombre del bucket (ej. "giocore-backups")
 *   - B2_BUCKET_ID      Bucket ID (necesario para algunas operaciones B2)
 *   - B2_ENDPOINT       (opcional) override del endpoint. Default us-west-002.
 *   - B2_REGION         (opcional) región. Default us-west-002.
 *
 * Restricciones:
 *   - Solo este bucket (`B2_BUCKET`). Si la Application Key tiene scope global,
 *     escalamos en log; nunca asumimos permisos cross-bucket.
 *   - `multipartUploadToB2` usa parts de 8 MB (B2 mínimo: 5 MB). Para archivos
 *     <8 MB usa PutObject normal.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const DEFAULT_ENDPOINT = 'https://s3.us-west-002.backblazeb2.com';
const DEFAULT_REGION = 'us-west-002';
const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;   // 8 MB
const MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;   // 8 MB

/* ── Estado lazy ────────────────────────────────────────────────────────── */

let _cachedClient: any = null;

/** Devuelve true si las 4 vars críticas están presentes en el entorno. */
export function isB2Configured(): boolean {
  return Boolean(
    process.env.B2_KEY_ID &&
    process.env.B2_APP_KEY &&
    process.env.B2_BUCKET &&
    process.env.B2_BUCKET_ID,
  );
}

/** Tira un error legible si falta cualquier var crítica. */
function assertB2Configured(): void {
  const missing: string[] = [];
  if (!process.env.B2_KEY_ID) missing.push('B2_KEY_ID');
  if (!process.env.B2_APP_KEY) missing.push('B2_APP_KEY');
  if (!process.env.B2_BUCKET) missing.push('B2_BUCKET');
  if (!process.env.B2_BUCKET_ID) missing.push('B2_BUCKET_ID');
  if (missing.length > 0) {
    throw new Error(
      `B2 no configurado: faltan vars ${missing.join(', ')}. ` +
      `Esperando setup Isaac (CHECKPOINT 1.6.5).`,
    );
  }
}

/**
 * Devuelve un cliente S3 apuntando a B2. Lazy: importa el SDK solo cuando se
 * necesita y mantiene una instancia singleton por proceso Vercel.
 *
 * Test injection: si `process.env.B2_TEST_CLIENT_INJECTED === '1'`, asume que
 * un test ya inyectó `_cachedClient` y lo reutiliza tal cual.
 */
export async function getB2Client(): Promise<any> {
  if (_cachedClient) return _cachedClient;
  assertB2Configured();

  // Lazy import: el module no carga el SDK si nadie usa B2 en este invoke.
  const sdk = await import('@aws-sdk/client-s3');
  const { S3Client } = sdk;

  _cachedClient = new S3Client({
    endpoint: process.env.B2_ENDPOINT || DEFAULT_ENDPOINT,
    region: process.env.B2_REGION || DEFAULT_REGION,
    credentials: {
      accessKeyId: process.env.B2_KEY_ID!,
      secretAccessKey: process.env.B2_APP_KEY!,
    },
    // B2 requiere path-style addressing en algunos endpoints.
    forcePathStyle: true,
  });

  return _cachedClient;
}

/** Reset usado en tests para limpiar singleton entre runs. */
export function __resetClientForTests(injected?: any): void {
  _cachedClient = injected ?? null;
}

/* ── Operaciones ────────────────────────────────────────────────────────── */

export interface B2UploadOptions {
  /** Content-Type opcional. Default `application/octet-stream`. */
  contentType?: string;
  /** Metadatos custom (B2 los almacena como `x-amz-meta-*`). */
  metadata?: Record<string, string>;
}

export interface B2UploadResult {
  bucket: string;
  key: string;
  size_bytes: number;
  etag: string | null;
  /** Si fue multipart, IDs de partes (debug). */
  parts_uploaded?: number;
}

/**
 * Sube un buffer al bucket. Si body > 8 MB, usa multipart automáticamente.
 */
export async function uploadToB2(
  key: string,
  body: Buffer | Uint8Array,
  opts: B2UploadOptions = {},
): Promise<B2UploadResult> {
  assertB2Configured();
  const bytes = body instanceof Buffer ? body : Buffer.from(body);

  if (bytes.byteLength >= MULTIPART_THRESHOLD_BYTES) {
    return multipartUploadToB2(key, bytes, opts);
  }

  const client = await getB2Client();
  const sdk = await import('@aws-sdk/client-s3');
  const { PutObjectCommand } = sdk;

  const cmd = new PutObjectCommand({
    Bucket: process.env.B2_BUCKET!,
    Key: key,
    Body: bytes,
    ContentType: opts.contentType ?? 'application/octet-stream',
    Metadata: opts.metadata,
  });
  const res: any = await client.send(cmd);

  return {
    bucket: process.env.B2_BUCKET!,
    key,
    size_bytes: bytes.byteLength,
    etag: res?.ETag ?? null,
  };
}

/**
 * Upload multipart explícito (B2 soporta hasta 10,000 partes × 5 GB = 50 TB).
 * Cada parte: 8 MB excepto la última (puede ser <8 MB).
 */
export async function multipartUploadToB2(
  key: string,
  body: Buffer,
  opts: B2UploadOptions = {},
): Promise<B2UploadResult> {
  assertB2Configured();
  const client = await getB2Client();
  const sdk = await import('@aws-sdk/client-s3');
  const {
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
  } = sdk;
  const bucket = process.env.B2_BUCKET!;

  const created: any = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: opts.contentType ?? 'application/octet-stream',
    Metadata: opts.metadata,
  }));
  const uploadId: string = created.UploadId;

  const total = body.byteLength;
  const partCount = Math.ceil(total / MULTIPART_PART_SIZE_BYTES);
  const parts: Array<{ PartNumber: number; ETag: string }> = [];

  try {
    for (let i = 0; i < partCount; i++) {
      const start = i * MULTIPART_PART_SIZE_BYTES;
      const end = Math.min(start + MULTIPART_PART_SIZE_BYTES, total);
      const chunk = body.subarray(start, end);
      const partRes: any = await client.send(new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: i + 1,
        Body: chunk,
      }));
      parts.push({ PartNumber: i + 1, ETag: partRes.ETag });
    }

    const completeRes: any = await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));

    return {
      bucket,
      key,
      size_bytes: total,
      etag: completeRes?.ETag ?? null,
      parts_uploaded: partCount,
    };
  } catch (err) {
    // Intentamos abortar el upload incompleto. Si falla, B2 lo limpia eventualmente.
    try {
      await client.send(new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }));
    } catch {
      /* swallow */
    }
    throw err;
  }
}

export interface B2ListItem {
  key: string;
  size_bytes: number;
  last_modified: string | null;
  etag: string | null;
}

/** Lista objetos por prefijo (paginado, devuelve todos los matches). */
export async function listB2(prefix: string, max = 1000): Promise<B2ListItem[]> {
  assertB2Configured();
  const client = await getB2Client();
  const sdk = await import('@aws-sdk/client-s3');
  const { ListObjectsV2Command } = sdk;

  const items: B2ListItem[] = [];
  let continuationToken: string | undefined = undefined;

  while (items.length < max) {
    const res: any = await client.send(new ListObjectsV2Command({
      Bucket: process.env.B2_BUCKET!,
      Prefix: prefix,
      MaxKeys: Math.min(1000, max - items.length),
      ContinuationToken: continuationToken,
    }));
    for (const obj of res.Contents ?? []) {
      items.push({
        key: obj.Key,
        size_bytes: obj.Size ?? 0,
        last_modified: obj.LastModified ? new Date(obj.LastModified).toISOString() : null,
        etag: obj.ETag ?? null,
      });
    }
    if (!res.IsTruncated) break;
    continuationToken = res.NextContinuationToken;
  }

  return items;
}

/** Descarga un objeto como Buffer. */
export async function downloadFromB2(key: string): Promise<Buffer> {
  assertB2Configured();
  const client = await getB2Client();
  const sdk = await import('@aws-sdk/client-s3');
  const { GetObjectCommand } = sdk;

  const res: any = await client.send(new GetObjectCommand({
    Bucket: process.env.B2_BUCKET!,
    Key: key,
  }));

  // res.Body es un stream Node.js (Readable) en runtime Node. Lo agregamos a buffer.
  const stream = res.Body;
  if (!stream) throw new Error(`B2 GET ${key}: respuesta sin body`);

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Borra un objeto. Usado en rotación 12 meses. */
export async function deleteFromB2(key: string): Promise<void> {
  assertB2Configured();
  const client = await getB2Client();
  const sdk = await import('@aws-sdk/client-s3');
  const { DeleteObjectCommand } = sdk;

  await client.send(new DeleteObjectCommand({
    Bucket: process.env.B2_BUCKET!,
    Key: key,
  }));
}
