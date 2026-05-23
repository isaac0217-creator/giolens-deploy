/**
 * GIOCORE Frente H · 1.6 — Tests del provider buildMonthlyBackup.
 *
 * Cubre:
 *   - encrypt/decrypt round-trip (AES-256-GCM)
 *   - passphrase corto (<32) → aborted
 *   - B2 no configurado → aborted con error claro
 *   - dry_run no escribe ni sube
 *   - rotación 12 meses borra keys viejos
 *   - tamper detection: ciphertext modificado → authTag falla
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = {
  B2_KEY_ID: process.env.B2_KEY_ID,
  B2_APP_KEY: process.env.B2_APP_KEY,
  B2_BUCKET: process.env.B2_BUCKET,
  B2_BUCKET_ID: process.env.B2_BUCKET_ID,
  B2_ZIP_PASSPHRASE: process.env.B2_ZIP_PASSPHRASE,
};

function restoreEnv() {
  Object.entries(ORIGINAL_ENV).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
}

function setB2() {
  process.env.B2_KEY_ID = 'test-key-id';
  process.env.B2_APP_KEY = 'test-app-key';
  process.env.B2_BUCKET = 'giocore-backups-test';
  process.env.B2_BUCKET_ID = 'bucket-id-123';
}

// Mock @aws-sdk/client-s3 — backup-monthly indirectamente lo carga vía backblaze.ts
const sdkCalls = { sent: [] };
const listObjectsResponse = { Contents: [], IsTruncated: false };

vi.mock('@aws-sdk/client-s3', () => {
  class FakeCmd {
    constructor(input) { this.input = input; }
  }
  class S3Client {
    constructor(opts) { this.opts = opts; }
    async send(cmd) {
      sdkCalls.sent.push({ name: cmd.constructor.name, input: cmd.input });
      switch (cmd.constructor.name) {
        case 'PutObjectCommand': return { ETag: '"abc"' };
        case 'ListObjectsV2Command': return listObjectsResponse;
        case 'DeleteObjectCommand': return {};
        case 'CreateMultipartUploadCommand': return { UploadId: 'u' };
        case 'UploadPartCommand': return { ETag: `"p${cmd.input.PartNumber}"` };
        case 'CompleteMultipartUploadCommand': return { ETag: '"c"' };
        default: throw new Error('unmocked: ' + cmd.constructor.name);
      }
    }
  }
  return {
    S3Client,
    PutObjectCommand: class extends FakeCmd {},
    ListObjectsV2Command: class extends FakeCmd {},
    DeleteObjectCommand: class extends FakeCmd {},
    CreateMultipartUploadCommand: class extends FakeCmd {},
    UploadPartCommand: class extends FakeCmd {},
    CompleteMultipartUploadCommand: class extends FakeCmd {},
    AbortMultipartUploadCommand: class extends FakeCmd {},
    GetObjectCommand: class extends FakeCmd {},
  };
});

/* Supabase mock */
function makeSupabase({ snapshotRows = [], historicalRows = [], deltaRows = [], insertError = null } = {}) {
  const calls = { selects: [], inserts: [] };
  return {
    calls,
    client: {
      from(table) {
        if (table !== 'backups_manifest') throw new Error('unmocked: ' + table);
        return {
          select() {
            const state = { in: null, eq: {}, gte: null, lt: null };
            const chain = {
              in(c, arr) { state.in = { c, arr }; return chain; },
              eq(c, v) { state.eq[c] = v; return chain; },
              gte(c, v) { state.gte = { c, v }; return chain; },
              lt(c, v) { state.lt = { c, v }; return chain; },
              order() {
                calls.selects.push({ ...state });
                const types = state.in?.arr ?? [];
                let rows = [];
                if (types.includes('snapshot_daily')) rows = snapshotRows;
                else if (types.includes('wapify_historical')) rows = historicalRows;
                else if (types.includes('wapify_delta')) rows = deltaRows;
                return Promise.resolve({ data: rows, error: null });
              },
            };
            return chain;
          },
          insert(row) {
            calls.inserts.push(row);
            return {
              select() {
                return {
                  single() {
                    if (insertError) return Promise.resolve({ data: null, error: insertError });
                    return Promise.resolve({ data: { id: 9999 }, error: null });
                  },
                };
              },
            };
          },
        };
      },
    },
  };
}

describe('providers/backup-monthly.ts — encrypt/decrypt round-trip', () => {
  beforeEach(() => {
    restoreEnv();
    setB2();
    sdkCalls.sent.length = 0;
    listObjectsResponse.Contents = [];
  });
  afterEach(() => restoreEnv());

  it('encrypt + decrypt devuelve el plaintext original', async () => {
    const { encryptPayload, decryptPayload } = await import('../backup-monthly.ts');
    const passphrase = 'a'.repeat(40); // >= 32 chars
    const plaintext = Buffer.from('hola mundo · tildes · ñ · datos críticos', 'utf-8');

    const { combined, iv } = encryptPayload(plaintext, passphrase);
    const recovered = decryptPayload(combined, iv, passphrase);

    expect(recovered.toString('utf-8')).toBe(plaintext.toString('utf-8'));
  });

  it('encrypt con passphrase <32 chars lanza error', async () => {
    const { encryptPayload } = await import('../backup-monthly.ts');
    expect(() => encryptPayload(Buffer.from('x'), 'short')).toThrow(/mínimo 32/);
  });

  it('decrypt con passphrase incorrecta lanza error (authTag mismatch)', async () => {
    const { encryptPayload, decryptPayload } = await import('../backup-monthly.ts');
    const passphrase = 'a'.repeat(40);
    const wrongPass = 'b'.repeat(40);
    const { combined, iv } = encryptPayload(Buffer.from('secret'), passphrase);
    expect(() => decryptPayload(combined, iv, wrongPass)).toThrow();
  });

  it('decrypt con ciphertext modificado (tampering) lanza error', async () => {
    const { encryptPayload, decryptPayload } = await import('../backup-monthly.ts');
    const passphrase = 'a'.repeat(40);
    const { combined, iv } = encryptPayload(Buffer.from('hola'), passphrase);
    const tampered = Buffer.from(combined);
    tampered[0] = tampered[0] ^ 0xff;
    expect(() => decryptPayload(tampered, iv, passphrase)).toThrow();
  });
});

describe('providers/backup-monthly.ts — buildMonthlyBackup', () => {
  beforeEach(() => {
    restoreEnv();
    setB2();
    process.env.B2_ZIP_PASSPHRASE = 'a'.repeat(40);
    sdkCalls.sent.length = 0;
    listObjectsResponse.Contents = [];
  });
  afterEach(() => restoreEnv());

  it('B2_ZIP_PASSPHRASE ausente → aborted', async () => {
    delete process.env.B2_ZIP_PASSPHRASE;
    const { buildMonthlyBackup } = await import('../backup-monthly.ts');
    const { client } = makeSupabase();
    const r = await buildMonthlyBackup(client, { month: '2026-04' });
    expect(r.status).toBe('aborted');
    expect(r.error).toMatch(/B2_ZIP_PASSPHRASE/);
  });

  it('passphrase corta → aborted', async () => {
    process.env.B2_ZIP_PASSPHRASE = 'short';
    const { buildMonthlyBackup } = await import('../backup-monthly.ts');
    const { client } = makeSupabase();
    const r = await buildMonthlyBackup(client, { month: '2026-04' });
    expect(r.status).toBe('aborted');
    expect(r.error).toMatch(/muy corto/);
  });

  it('B2 no configurado → aborted (a menos que skip_upload)', async () => {
    delete process.env.B2_KEY_ID;
    const { buildMonthlyBackup } = await import('../backup-monthly.ts');
    const { client } = makeSupabase();
    const r = await buildMonthlyBackup(client, { month: '2026-04' });
    expect(r.status).toBe('aborted');
    expect(r.error).toMatch(/B2 no configurado/);
  });

  it('dry_run=true no escribe ni sube a B2', async () => {
    const { buildMonthlyBackup } = await import('../backup-monthly.ts');
    const { client, calls } = makeSupabase({
      snapshotRows: [{ id: 1, type: 'snapshot_daily', path: 'p1' }],
    });
    const r = await buildMonthlyBackup(client, { month: '2026-04', dry_run: true });
    expect(r.status).toBe('completed');
    expect(calls.inserts).toHaveLength(0);
    expect(sdkCalls.sent.filter((c) => c.name === 'PutObjectCommand')).toHaveLength(0);
  });

  it('skip_upload=true cifra payload pero no toca B2', async () => {
    const { buildMonthlyBackup } = await import('../backup-monthly.ts');
    const { client, calls } = makeSupabase({
      snapshotRows: [
        { id: 1, type: 'snapshot_daily', path: 'p1', data_b64: 'aGk=' },
        { id: 2, type: 'snapshot_daily', path: 'p2', data_b64: 'aGk=' },
      ],
      historicalRows: [{ id: 10, type: 'wapify_historical', path: 'h1' }],
      deltaRows: [{ id: 20, type: 'wapify_delta', path: 'd1' }],
    });
    const r = await buildMonthlyBackup(client, { month: '2026-04', skip_upload: true });

    expect(r.status).toBe('completed');
    expect(r.snapshot_daily_count).toBe(2);
    expect(r.wapify_historical_count).toBe(1);
    expect(r.wapify_delta_count).toBe(1);
    expect(r.encrypted_bytes).toBeGreaterThan(0);
    expect(r.sha256_of_encrypted).toMatch(/^[a-f0-9]{64}$/);
    // skip_upload: no PUT, b2_key=null
    expect(sdkCalls.sent.filter((c) => c.name === 'PutObjectCommand')).toHaveLength(0);
    expect(r.b2_key_bin).toBeNull();
    // Manifest insert (storage='supabase_inline' porque uploadOk=false)
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0].storage).toBe('supabase_inline');
  });

  it('upload exitoso → 2 PutObject (bin + iv) + manifest storage=b2', async () => {
    const { buildMonthlyBackup } = await import('../backup-monthly.ts');
    const { client, calls } = makeSupabase({
      snapshotRows: [{ id: 1 }],
    });
    const r = await buildMonthlyBackup(client, { month: '2026-04' });

    expect(r.status).toBe('completed');
    expect(r.b2_key_bin).toMatch(/backup_monthly\/2026-04\/giocore-2026-04\.bin/);
    expect(r.b2_key_iv).toMatch(/giocore-2026-04\.iv/);

    const puts = sdkCalls.sent.filter((c) => c.name === 'PutObjectCommand');
    expect(puts).toHaveLength(2);
    expect(puts[0].input.Key).toMatch(/\.bin$/);
    expect(puts[1].input.Key).toMatch(/\.iv$/);

    expect(calls.inserts[0].storage).toBe('b2');
    expect(calls.inserts[0].b2_key).toBe(r.b2_key_bin);
  });

  it('rotación: borra keys con month < cutoff (12 meses atrás)', async () => {
    // Listamos 3 keys: 1 viejo (>12m), 2 recientes
    const now = new Date('2026-05-23T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 12);
    const oldMonth = '2024-01'; // claramente > 12 meses atrás
    const recentMonth = '2025-12';

    listObjectsResponse.Contents = [
      { Key: `backup_monthly/${oldMonth}/giocore-${oldMonth}.bin`, Size: 100, LastModified: new Date('2024-01-15'), ETag: '"a"' },
      { Key: `backup_monthly/${oldMonth}/giocore-${oldMonth}.iv`, Size: 12, LastModified: new Date('2024-01-15'), ETag: '"b"' },
      { Key: `backup_monthly/${recentMonth}/giocore-${recentMonth}.bin`, Size: 100, LastModified: new Date('2025-12-15'), ETag: '"c"' },
    ];

    const { buildMonthlyBackup } = await import('../backup-monthly.ts');
    const { client } = makeSupabase({ snapshotRows: [{ id: 1 }] });
    const r = await buildMonthlyBackup(client, { month: '2026-04' });

    expect(r.rotation.keys_listed).toBe(3);
    expect(r.rotation.keys_deleted).toBe(2); // los 2 de 2024-01

    const deletes = sdkCalls.sent.filter((c) => c.name === 'DeleteObjectCommand');
    expect(deletes).toHaveLength(2);

    vi.useRealTimers();
  });

  it('month default = mes anterior', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T00:00:00Z'));
    const { buildMonthlyBackup } = await import('../backup-monthly.ts');
    const { client } = makeSupabase();
    const r = await buildMonthlyBackup(client, { skip_upload: true });
    expect(r.month).toBe('2026-04'); // abril, no mayo
    vi.useRealTimers();
  });
});
