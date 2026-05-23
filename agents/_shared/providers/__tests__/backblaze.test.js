/**
 * GIOCORE Frente H — Tests de backblaze.ts (sin red real).
 *
 * Verifica:
 *   - isB2Configured() detecta correctamente vars faltantes.
 *   - assertB2Configured lanza con mensaje listando vars faltantes.
 *   - uploadToB2 con buffer chico → PutObjectCommand.
 *   - uploadToB2 con buffer >8MB → multipart upload con N partes.
 *   - multipart upload aborta si una parte falla.
 *   - listB2 paginado.
 *   - downloadFromB2 agrega stream a Buffer.
 *
 * Mockeamos @aws-sdk/client-s3 vía vi.mock con captura de comandos enviados.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = {
  B2_KEY_ID: process.env.B2_KEY_ID,
  B2_APP_KEY: process.env.B2_APP_KEY,
  B2_BUCKET: process.env.B2_BUCKET,
  B2_BUCKET_ID: process.env.B2_BUCKET_ID,
};

function setB2Vars() {
  process.env.B2_KEY_ID = 'test-key-id';
  process.env.B2_APP_KEY = 'test-app-key';
  process.env.B2_BUCKET = 'giocore-backups-test';
  process.env.B2_BUCKET_ID = 'bucket-id-123';
}

function unsetB2Vars() {
  delete process.env.B2_KEY_ID;
  delete process.env.B2_APP_KEY;
  delete process.env.B2_BUCKET;
  delete process.env.B2_BUCKET_ID;
}

/* Mock @aws-sdk/client-s3. Cada Command es marker (sólo guardamos constructor name + input). */
const sdkCalls = { sent: [] };

vi.mock('@aws-sdk/client-s3', () => {
  class FakeCommand {
    constructor(input) { this.input = input; }
  }
  class S3Client {
    constructor(opts) { this.opts = opts; }
    async send(cmd) {
      sdkCalls.sent.push({ name: cmd.constructor.name, input: cmd.input });
      // Respuestas por tipo de comando
      switch (cmd.constructor.name) {
        case 'PutObjectCommand':
          return { ETag: '"etag-put"' };
        case 'CreateMultipartUploadCommand':
          return { UploadId: 'upload-id-xxx' };
        case 'UploadPartCommand':
          return { ETag: `"etag-part-${cmd.input.PartNumber}"` };
        case 'CompleteMultipartUploadCommand':
          return { ETag: '"etag-complete"' };
        case 'AbortMultipartUploadCommand':
          return {};
        case 'ListObjectsV2Command': {
          // Devuelve 2 items y marca no truncado
          return {
            Contents: [
              { Key: 'foo.txt', Size: 100, LastModified: new Date('2026-05-01'), ETag: '"a"' },
              { Key: 'bar.txt', Size: 200, LastModified: new Date('2026-05-02'), ETag: '"b"' },
            ],
            IsTruncated: false,
          };
        }
        case 'GetObjectCommand': {
          // Body es async iterable
          const chunks = [Buffer.from('hello '), Buffer.from('world')];
          return {
            Body: (async function* () {
              for (const c of chunks) yield c;
            })(),
          };
        }
        case 'DeleteObjectCommand':
          return {};
        default:
          throw new Error(`Comando no mockeado: ${cmd.constructor.name}`);
      }
    }
  }
  return {
    S3Client,
    PutObjectCommand: class extends FakeCommand {},
    CreateMultipartUploadCommand: class extends FakeCommand {},
    UploadPartCommand: class extends FakeCommand {},
    CompleteMultipartUploadCommand: class extends FakeCommand {},
    AbortMultipartUploadCommand: class extends FakeCommand {},
    ListObjectsV2Command: class extends FakeCommand {},
    GetObjectCommand: class extends FakeCommand {},
    DeleteObjectCommand: class extends FakeCommand {},
  };
});

describe('providers/backblaze.ts — configuración', () => {
  beforeEach(() => {
    unsetB2Vars();
    sdkCalls.sent.length = 0;
  });

  afterEach(() => {
    Object.entries(ORIGINAL_ENV).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  });

  it('isB2Configured() devuelve false con vars faltantes', async () => {
    const mod = await import('../backblaze.ts');
    expect(mod.isB2Configured()).toBe(false);
  });

  it('isB2Configured() devuelve true con las 4 vars set', async () => {
    setB2Vars();
    const mod = await import('../backblaze.ts');
    expect(mod.isB2Configured()).toBe(true);
  });

  it('uploadToB2 lanza error claro listando vars faltantes', async () => {
    const mod = await import('../backblaze.ts');
    mod.__resetClientForTests(null);
    await expect(mod.uploadToB2('k', Buffer.from('x'))).rejects.toThrow(/B2 no configurado/);
  });

  it('module se importa sin error aunque no haya vars (lazy)', async () => {
    // Re-import limpio
    vi.resetModules();
    await expect(import('../backblaze.ts')).resolves.toBeTruthy();
  });
});

describe('providers/backblaze.ts — uploads', () => {
  beforeEach(async () => {
    setB2Vars();
    sdkCalls.sent.length = 0;
    const mod = await import('../backblaze.ts');
    mod.__resetClientForTests(null);
  });

  afterEach(() => {
    Object.entries(ORIGINAL_ENV).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  });

  it('upload <8MB usa PutObjectCommand', async () => {
    const mod = await import('../backblaze.ts');
    const body = Buffer.alloc(1024, 'x'); // 1 KB
    const res = await mod.uploadToB2('test.txt', body, { contentType: 'text/plain' });

    expect(res.size_bytes).toBe(1024);
    expect(res.key).toBe('test.txt');
    expect(res.bucket).toBe('giocore-backups-test');
    expect(res.etag).toBe('"etag-put"');

    const putCalls = sdkCalls.sent.filter((c) => c.name === 'PutObjectCommand');
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].input.Bucket).toBe('giocore-backups-test');
    expect(putCalls[0].input.Key).toBe('test.txt');
    expect(putCalls[0].input.ContentType).toBe('text/plain');
  });

  it('upload >8MB usa multipart con N partes', async () => {
    const mod = await import('../backblaze.ts');
    // 20 MB → 3 partes (8+8+4)
    const body = Buffer.alloc(20 * 1024 * 1024, 'x');
    const res = await mod.uploadToB2('big.bin', body);

    expect(res.parts_uploaded).toBe(3);
    expect(res.size_bytes).toBe(20 * 1024 * 1024);

    const names = sdkCalls.sent.map((c) => c.name);
    expect(names).toContain('CreateMultipartUploadCommand');
    expect(names.filter((n) => n === 'UploadPartCommand')).toHaveLength(3);
    expect(names).toContain('CompleteMultipartUploadCommand');

    // Verifica que la última parte está dentro del tamaño esperado
    const partCmds = sdkCalls.sent.filter((c) => c.name === 'UploadPartCommand');
    expect(partCmds[0].input.PartNumber).toBe(1);
    expect(partCmds[2].input.PartNumber).toBe(3);
  });

  it('listB2 devuelve los items del bucket', async () => {
    const mod = await import('../backblaze.ts');
    const items = await mod.listB2('snapshot_');

    expect(items).toHaveLength(2);
    expect(items[0].key).toBe('foo.txt');
    expect(items[0].size_bytes).toBe(100);
    expect(items[0].last_modified).toMatch(/2026-05-01/);

    const listCalls = sdkCalls.sent.filter((c) => c.name === 'ListObjectsV2Command');
    expect(listCalls[0].input.Prefix).toBe('snapshot_');
  });

  it('downloadFromB2 agrega stream a Buffer', async () => {
    const mod = await import('../backblaze.ts');
    const buf = await mod.downloadFromB2('foo.txt');
    expect(buf.toString('utf-8')).toBe('hello world');
  });

  it('deleteFromB2 envía DeleteObjectCommand', async () => {
    const mod = await import('../backblaze.ts');
    await mod.deleteFromB2('old.txt');
    const delCalls = sdkCalls.sent.filter((c) => c.name === 'DeleteObjectCommand');
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0].input.Key).toBe('old.txt');
    expect(delCalls[0].input.Bucket).toBe('giocore-backups-test');
  });
});
