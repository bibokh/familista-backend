/**
 * tests/backup-latest.unit.test.ts
 *
 * Cyber Defense, Step 10 — the restore drill's -Latest: which backup is the
 * newest one worth restoring. A backup's object key ends in a random suffix
 * nobody can know in advance, so the drill lists the prefix with the Read Only
 * restore key and picks the newest complete `.fbk` — one whose signed manifest
 * is beside it. A manifest is never picked; an unfinished upload is skipped;
 * choosing is not trusting (the drill still verifies everything).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { fileStore, s3ClientFor, s3Store, StoredObject } from '../src/security/backup/backup-store';
import { findLatestBackup, isBackupKey, NoBackupError, pickLatest } from '../src/security/backup/backup-latest';
import { main, redact } from '../src/scripts/backup';

const at = (iso: string) => new Date(iso);
const obj = (key: string, iso: string, size = 100): StoredObject => ({ key, lastModified: at(iso), size });
const withManifest = (key: string, iso: string, size = 100): StoredObject[] => [obj(key, iso, size), obj(`${key}.manifest.json`, iso, 400)];

describe('isBackupKey', () => {
  it('accepts backup keys and nothing else', () => {
    expect(isBackupKey('2026/09/30/familista-20260930T031700Z-0a1b2c3d.fbk')).toBe(true);
    for (const bad of ['2026/09/30/x.fbk.manifest.json', 'x.FBK', '../x.fbk', '/x.fbk', 'a b.fbk', 'x.fbk.tmp', 'x', '']) {
      expect(isBackupKey(bad)).toBe(false);
    }
  });
});

describe('pickLatest', () => {
  it('picks the newest complete backup', () => {
    const r = pickLatest([
      ...withManifest('2026/09/28/familista-a.fbk', '2026-09-28T03:17:00Z'),
      ...withManifest('2026/09/30/familista-c.fbk', '2026-09-30T03:17:00Z', 321),
      ...withManifest('2026/09/29/familista-b.fbk', '2026-09-29T03:17:00Z'),
    ]);
    expect(r).toEqual({ objectKey: '2026/09/30/familista-c.fbk', lastModified: '2026-09-30T03:17:00.000Z', size: 321, complete: 3 });
  });

  it('never picks a manifest, however new it is', () => {
    const r = pickLatest([
      ...withManifest('2026/09/29/familista-b.fbk', '2026-09-29T03:17:00Z'),
      obj('2026/09/30/familista-c.fbk.manifest.json', '2026-10-01T00:00:00Z'),
    ]);
    expect(r.objectKey).toBe('2026/09/29/familista-b.fbk');
  });

  it('skips a newer .fbk without its signed manifest (an interrupted upload)', () => {
    const r = pickLatest([
      ...withManifest('2026/09/29/familista-b.fbk', '2026-09-29T03:17:00Z'),
      obj('2026/09/30/familista-c.fbk', '2026-09-30T03:17:00Z'),
    ]);
    expect(r).toMatchObject({ objectKey: '2026/09/29/familista-b.fbk', complete: 1 });
  });

  it('skips an empty object and a name the drill would refuse', () => {
    const r = pickLatest([
      ...withManifest('2026/09/28/familista-a.fbk', '2026-09-28T03:17:00Z'),
      ...withManifest('2026/09/30/familista-empty.fbk', '2026-09-30T03:17:00Z', 0),
      ...withManifest('2026/09/30/bad name.fbk', '2026-09-30T04:00:00Z'),
      ...withManifest('2026/09/30/x.FBK', '2026-09-30T05:00:00Z'),
    ]);
    expect(r.objectKey).toBe('2026/09/28/familista-a.fbk');
  });

  it('breaks a tie on time by the key, which starts with the time it was taken', () => {
    const r = pickLatest([
      ...withManifest('2026/09/30/familista-20260930T031700Z-aaaa.fbk', '2026-09-30T03:17:30Z'),
      ...withManifest('2026/09/30/familista-20260930T031701Z-0000.fbk', '2026-09-30T03:17:30Z'),
    ]);
    expect(r.objectKey).toBe('2026/09/30/familista-20260930T031701Z-0000.fbk');
  });

  it('fails plainly on an empty prefix, on manifests only, and on no complete backup', () => {
    expect(() => pickLatest([])).toThrow(new NoBackupError('no .fbk backup under the configured prefix'));
    expect(() => pickLatest([obj('x.fbk.manifest.json', '2026-09-30T00:00:00Z')])).toThrow(/no \.fbk backup/);
    expect(() => pickLatest([obj('x.fbk', '2026-09-30T00:00:00Z')])).toThrow(/lacks its signed manifest/);
  });

  it('refuses a store that cannot be listed', async () => {
    await expect(findLatestBackup({ describe: () => '', putFile: async () => undefined, getToFile: async () => undefined }))
      .rejects.toThrow(/cannot be listed/);
  });
});

describe('fileStore.list', () => {
  it('lists every object below the root, keys relative with "/"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-list-'));
    try {
      fs.mkdirSync(path.join(dir, '2026/09/30'), { recursive: true });
      fs.writeFileSync(path.join(dir, '2026/09/30/a.fbk'), 'abc');
      fs.writeFileSync(path.join(dir, '2026/09/30/a.fbk.manifest.json'), '{}');
      const list = await fileStore(dir).list!();
      expect(list.map((o) => o.key).sort()).toEqual(['2026/09/30/a.fbk', '2026/09/30/a.fbk.manifest.json']);
      expect(list.find((o) => o.key.endsWith('.fbk'))).toMatchObject({ size: 3 });
      expect(await fileStore(path.join(dir, 'missing')).list!()).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('s3Store.list', () => {
  const cfg = { kind: 's3' as const, bucket: 'fam-backups', region: 'auto', forcePathStyle: false, accessKeyId: 'a', secretAccessKey: 'b', prefix: 'familista/postgres/' };

  it('pages through the prefix only, and returns keys relative to it', async () => {
    const inputs: unknown[] = [];
    const pages = [
      { IsTruncated: true, NextContinuationToken: 't1', Contents: [
        { Key: 'familista/postgres/2026/09/29/b.fbk', LastModified: at('2026-09-29T03:17:00Z'), Size: 10 },
        { Key: 'familista/postgres/2026/09/29/b.fbk.manifest.json', LastModified: at('2026-09-29T03:17:00Z'), Size: 4 },
      ] },
      { IsTruncated: false, Contents: [
        { Key: 'familista/postgres/2026/09/30/c.fbk', LastModified: at('2026-09-30T03:17:00Z'), Size: 11 },
        { Key: 'elsewhere/x.fbk', LastModified: at('2026-10-01T00:00:00Z'), Size: 1 },
      ] },
    ];
    const client = { send: jest.fn(async (cmd: unknown) => {
      expect(cmd).toBeInstanceOf(ListObjectsV2Command);
      inputs.push((cmd as ListObjectsV2Command).input);
      return pages.shift();
    }) } as unknown as S3Client;
    const list = await s3Store(cfg, client).list!();
    expect(inputs).toEqual([
      { Bucket: 'fam-backups', Prefix: 'familista/postgres/', ContinuationToken: undefined },
      { Bucket: 'fam-backups', Prefix: 'familista/postgres/', ContinuationToken: 't1' },
    ]);
    expect(list.map((o) => o.key)).toEqual(['2026/09/29/b.fbk', '2026/09/29/b.fbk.manifest.json', '2026/09/30/c.fbk']);
    // c.fbk has no manifest: the newest complete one is b.
    expect(pickLatest(list).objectKey).toBe('2026/09/29/b.fbk');
  });

  it('lists read-only on the wire: one signed GET to the B2 bucket, no checksum headers, no body', async () => {
    const B2 = { ...cfg, bucket: 'familista-backups-2026-739261', region: 'eu-central-003', endpoint: 'https://s3.eu-central-003.backblazeb2.com',
      accessKeyId: 'placeholder-key-id', secretAccessKey: 'placeholder-not-a-secret' };
    const seen: Array<{ method: string; hostname: string; path: string; query: Record<string, string>; headers: Record<string, string> }> = [];
    const xml = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>familista-backups-2026-739261</Name>'
      + '<Prefix>familista/postgres/</Prefix><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated>'
      + '<Contents><Key>familista/postgres/2026/09/30/c.fbk</Key><LastModified>2026-09-30T03:17:00.000Z</LastModified><Size>11</Size></Contents>'
      + '</ListBucketResult>';
    const handler = { handle: async (req: (typeof seen)[number]) => {
      seen.push(req);
      return { response: { statusCode: 200, headers: { 'content-type': 'application/xml' }, body: Readable.from([Buffer.from(xml)]) } };
    } };
    const list = await s3Store(B2, s3ClientFor(B2, handler as never)).list!();
    expect(list).toEqual([{ key: '2026/09/30/c.fbk', lastModified: at('2026-09-30T03:17:00Z'), size: 11 }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('GET');
    expect(seen[0].hostname).toBe('familista-backups-2026-739261.s3.eu-central-003.backblazeb2.com');
    expect(seen[0].query).toMatchObject({ 'list-type': '2', prefix: 'familista/postgres/' });
    expect(Object.keys(seen[0].headers).filter((k) => /^x-amz-(sdk-)?checksum|^x-amz-trailer$/i.test(k))).toEqual([]);
  });
});

describe('backup latest (CLI)', () => {
  let dir: string;
  const out: string[] = [];
  let write: jest.SpyInstance;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-latest-cli-'));
    out.length = 0;
    write = jest.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
  });
  afterEach(() => { write.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); });

  const put = (key: string, body: string, mtime: string) => {
    const f = path.join(dir, key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
    fs.utimesSync(f, at(mtime), at(mtime));
  };
  const report = () => JSON.parse(out[out.length - 1]);

  it('names the newest complete backup as one JSON line', async () => {
    put('2026/09/29/familista-b.fbk', 'FBK1b', '2026-09-29T03:17:00Z');
    put('2026/09/29/familista-b.fbk.manifest.json', '{}', '2026-09-29T03:17:00Z');
    put('2026/09/30/familista-c.fbk', 'FBK1c', '2026-09-30T03:17:00Z');
    put('2026/09/30/familista-c.fbk.manifest.json', '{}', '2026-09-30T03:17:00Z');
    put('2026/10/01/familista-d.fbk.manifest.json', '{}', '2026-10-01T03:17:00Z');
    expect(await main(['latest'], { BACKUP_STORE: 'file', BACKUP_FILE_DIR: dir })).toBe(0);
    expect(out).toHaveLength(1);
    expect(report()).toEqual({ ok: true, objectKey: '2026/09/30/familista-c.fbk', lastModified: '2026-09-30T03:17:00.000Z', size: 5, complete: 2 });
  });

  it('fails with exit 1 and a plain reason when there is nothing to restore', async () => {
    expect(await main(['latest'], { BACKUP_STORE: 'file', BACKUP_FILE_DIR: dir })).toBe(1);
    expect(report()).toEqual({ ok: false, error: 'no .fbk backup under the configured prefix' });
    put('2026/09/30/familista-c.fbk', 'FBK1c', '2026-09-30T03:17:00Z');
    expect(await main(['latest'], { BACKUP_STORE: 'file', BACKUP_FILE_DIR: dir })).toBe(1);
    expect(report().error).toMatch(/lacks its signed manifest/);
  });

  it('never prints a credential, even when the store error repeats it', async () => {
    const secret = 'Kplaceholder0notAreal0secret0value';
    const keyId = 'placeholderKeyId0001';
    const env = { BACKUP_S3_BUCKET: 'b', BACKUP_S3_ACCESS_KEY_ID: keyId, BACKUP_S3_SECRET_ACCESS_KEY: secret,
      BACKUP_S3_ENDPOINT: 'http://127.0.0.1:9', BACKUP_S3_REGION: 'us-east-1' };
    expect(await main(['latest'], env)).toBe(1);
    const printed = out.join('');
    expect(printed).not.toContain(secret);
    expect(printed).not.toContain(keyId);
    expect(report().ok).toBe(false);
    expect(redact(`bad key ${keyId} / ${secret}`, env)).toBe('bad key [BACKUP_S3_ACCESS_KEY_ID] / [BACKUP_S3_SECRET_ACCESS_KEY]');
  }, 30_000);
});
