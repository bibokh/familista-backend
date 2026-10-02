/**
 * tests/storage-keys.unit.test.ts
 *
 * Cyber Defense, R10 — every stored object sits under its owner's prefix, and
 * no key can climb out of its folder. Pinned at the guard, at both legacy
 * adapters' put and delete, and at the fabric object store.
 */

import os from 'os';
import path from 'path';
import { promises as fsp } from 'fs';

import {
  assertClubKey, assertStorageKey, assertWhiteLabelKey, clubOfKey, isWellFormedKey, rootOfKey, StorageKeyRefused,
} from '../src/security/storage-keys';
import { LocalStorageAdapter } from '../src/lib/storage/storage-local.adapter';
import { MemoryObjectStore, getObjectStore, setObjectStore } from '../src/fabric/media/object-store';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('the key guard', () => {
  it('accepts each owner root', () => {
    for (const k of [`club/${A}/media/x.png`, `clubs/${A}/videos/v/hls/index.m3u8`, 'whitelabel/cfg1/logo.png', 'year=2026/month=10/part-0.parquet']) {
      expect(() => assertStorageKey(k)).not.toThrow();
    }
    expect(rootOfKey(`clubs/${A}/x`)).toBe('club');
    expect(clubOfKey(`club/${A}/x`)).toBe(A);
  });

  it('refuses traversal, absolute, empty-segment, odd-alphabet and unowned keys', () => {
    for (const k of [
      `clubs/${A}/../${B}/x`, `clubs/${A}/./x`, '../etc/passwd', `/clubs/${A}/x`, `clubs/${A}//x`, `clubs/${A}/x/`,
      `clubs/${A}/x\\..\\y`, `clubs/${A}/a b`, `clubs/${A}/%2e%2e/x`, 'tmp/x.png', 'x.png', '', 'a'.repeat(1025),
    ]) {
      expect(isWellFormedKey(k) && rootOfKey(k) !== null).toBe(false);
      expect(() => assertStorageKey(k)).toThrow(StorageKeyRefused);
    }
    expect(() => assertStorageKey(undefined)).toThrow(StorageKeyRefused);
  });

  it('a writer for one club cannot write under another club', () => {
    expect(() => assertClubKey(`clubs/${A}/videos/x.mp4`, A)).not.toThrow();
    expect(() => assertClubKey(`clubs/${B}/videos/x.mp4`, A)).toThrow(/this club/);
    expect(() => assertClubKey(`clubs/${A}/videos/x.mp4`, null)).toThrow(StorageKeyRefused);
    expect(() => assertClubKey('whitelabel/cfg1/x.png', A)).toThrow(StorageKeyRefused);
  });

  it('a white-label writer stays inside its own config folder', () => {
    expect(() => assertWhiteLabelKey('whitelabel/cfg1/logo.png', 'cfg1')).not.toThrow();
    expect(() => assertWhiteLabelKey('whitelabel/cfg2/logo.png', 'cfg1')).toThrow(StorageKeyRefused);
    expect(() => assertWhiteLabelKey('whitelabel/cfg10/logo.png', 'cfg1')).toThrow(StorageKeyRefused);
  });

  it('is a 403, not a 500', () => {
    expect.assertions(1);
    try { assertStorageKey('x'); } catch (e) { expect((e as { statusCode: number }).statusCode).toBe(403); }
  });
});

describe('the local adapter', () => {
  let root: string;
  let adapter: LocalStorageAdapter;
  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'familista-keys-'));
    adapter = new LocalStorageAdapter({ rootDir: root });
  });
  afterAll(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  it('writes an owned key inside its root', async () => {
    await adapter.put(`clubs/${A}/thumbs/t.jpg`, Buffer.from('x'), 'image/jpeg');
    await expect(fsp.readFile(path.join(root, 'clubs', A, 'thumbs', 't.jpg'), 'utf8')).resolves.toBe('x');
  });

  it('refuses to write or delete anything outside an owner prefix or outside the root', async () => {
    const outside = path.join(path.dirname(root), 'escaped.txt');
    for (const k of [`clubs/${A}/../../../escaped.txt`, '../escaped.txt', 'loose.txt', `/clubs/${A}/x`]) {
      await expect(adapter.put(k, Buffer.from('x'), 'text/plain')).rejects.toThrow(StorageKeyRefused);
      await expect(adapter.delete(k)).rejects.toThrow(StorageKeyRefused);
    }
    await expect(fsp.access(outside)).rejects.toThrow();
  });
});

describe('the fabric object store', () => {
  afterEach(() => setObjectStore(null));

  it('refuses an unowned key on put', async () => {
    const store = new MemoryObjectStore();
    await expect(store.putObject({ key: 'loose/x.png', body: Buffer.from('x'), contentType: 'image/png' } as never))
      .rejects.toThrow(StorageKeyRefused);
  });

  it('never hands a club object out as an unsigned public URL through the legacy adapter', async () => {
    setObjectStore(null);
    const store = getObjectStore();
    expect(store.provider).not.toBe('MEMORY'); // the legacy adapter, which cannot sign
    await expect(store.getSignedReadUrl(`club/${A}/media/x.png`)).rejects.toThrow(StorageKeyRefused);
  });
});
