/**
 * tests/backup-crypto.unit.test.ts
 *
 * Cyber Defense, Step 10 — the FBK1 backup envelope and its signed manifest.
 *
 * A backup is the whole platform in one file. These tests prove that the
 * envelope keeps it secret (only the offline private key opens it) and keeps
 * it honest (a flipped bit, a reordered, dropped or appended chunk, a changed
 * header, a truncation or a wrong key each fail loudly rather than yielding a
 * silently corrupted restore), and that a manifest cannot be forged or edited.
 */

import { randomBytes, createPublicKey, createHash } from 'crypto';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  BackupCryptoError, BackupManifest, HEADER_LENGTH, MAGIC, canonical, createDecryptStream, createEncryptStream,
  generateBackupKeys, importEncryptionPrivateKey, importEncryptionPublicKey, importSigningPrivateKey,
  importSigningPublicKey, keyId, signManifest, verifyManifest,
} from '../src/security/backup/backup-crypto';

const TAG = 16;
const keys = generateBackupKeys();
const encPub = importEncryptionPublicKey(keys.encryptionPublicKey);
const encPriv = importEncryptionPrivateKey(keys.encryptionPrivateKey);
const signPriv = importSigningPrivateKey(keys.signingPrivateKey);
const signPub = importSigningPublicKey(keys.signingPublicKey);

function collect(): { sink: Writable; data: () => Buffer } {
  const parts: Buffer[] = [];
  return {
    sink: new Writable({ write(c, _e, cb) { parts.push(Buffer.from(c)); cb(); } }),
    data: () => Buffer.concat(parts),
  };
}

/** Feeds `input` in pieces of `piece` bytes so chunk boundaries are exercised. */
function source(input: Buffer, piece = 997): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < input.length; i += piece) parts.push(input.subarray(i, i + piece));
  return Readable.from(parts);
}

async function encrypt(plain: Buffer, chunkSize = 64, pub = encPub): Promise<Buffer> {
  const out = collect();
  await pipeline(source(plain), createEncryptStream(pub, chunkSize), out.sink);
  return out.data();
}

async function decrypt(cipher: Buffer, priv = encPriv, piece = 113): Promise<Buffer> {
  const out = collect();
  await pipeline(source(cipher, piece), createDecryptStream(priv), out.sink);
  return out.data();
}

describe('FBK1 envelope — round trip', () => {
  it.each([
    ['empty', 0],
    ['one byte', 1],
    ['less than a chunk', 63],
    ['exactly one chunk', 64],
    ['exactly three chunks', 192],
    ['many chunks and a remainder', 64 * 41 + 17],
  ])('%s (%d bytes) decrypts to the same bytes', async (_label, n) => {
    const plain = randomBytes(n);
    const cipher = await encrypt(plain);
    expect((await decrypt(cipher)).equals(plain)).toBe(true);
  });

  it('works at the default chunk size with arbitrarily split input', async () => {
    const plain = randomBytes(200_000);
    const out = collect();
    await pipeline(source(plain, 4093), createEncryptStream(encPub), out.sink);
    expect((await decrypt(out.data(), encPriv, 7919)).equals(plain)).toBe(true);
  });

  it('writes the documented header and adds exactly one tag per chunk', async () => {
    const cipher = await encrypt(randomBytes(64 * 3 + 5));
    expect(cipher.subarray(0, 4).equals(MAGIC)).toBe(true);
    expect(cipher[4]).toBe(1);
    expect(cipher.readUInt32BE(5)).toBe(64);
    expect(cipher.subarray(9, 25).toString('hex')).toBe(keyId(encPub).slice(0, 32));
    expect(cipher.length).toBe(HEADER_LENGTH + 64 * 3 + 5 + 4 * TAG);
  });

  it('is not deterministic: the same plaintext encrypts differently every time', async () => {
    const plain = Buffer.from('the same backup twice');
    const [a, b] = [await encrypt(plain), await encrypt(plain)];
    expect(a.equals(b)).toBe(false);
  });

  it('never contains the plaintext', async () => {
    const marker = Buffer.from('FAMILISTA-PLAINTEXT-MARKER-'.repeat(20));
    const cipher = await encrypt(marker);
    expect(cipher.includes(Buffer.from('FAMILISTA-PLAINTEXT-MARKER'))).toBe(false);
  });

  it('refuses an invalid chunk size', () => {
    expect(() => createEncryptStream(encPub, 8)).toThrow(BackupCryptoError);
    expect(() => createEncryptStream(encPub, 1.5)).toThrow(BackupCryptoError);
  });
});

describe('FBK1 envelope — tampering and truncation fail closed', () => {
  const plain = randomBytes(64 * 4 + 10);
  let cipher: Buffer;
  const frame = 64 + TAG;
  beforeAll(async () => { cipher = await encrypt(plain); });

  const flip = (buf: Buffer, at: number) => { const c = Buffer.from(buf); c[at] ^= 0x01; return c; };

  it.each([
    ['magic', 0],
    ['version', 4],
    ['chunk size', 7],
    ['recipient key id', 12],
    ['ephemeral key', 40],
    ['first chunk body', HEADER_LENGTH + 3],
    ['first chunk tag', HEADER_LENGTH + frame - 1],
    ['middle chunk', HEADER_LENGTH + frame * 2 + 20],
  ])('a flipped bit in the %s is rejected', async (_label, at) => {
    await expect(decrypt(flip(cipher, at))).rejects.toThrow(BackupCryptoError);
  });

  it('rejects a flipped bit in the final chunk', async () => {
    await expect(decrypt(flip(cipher, cipher.length - 1))).rejects.toThrow(BackupCryptoError);
  });

  it('rejects truncation at a chunk boundary (the final chunk dropped)', async () => {
    await expect(decrypt(cipher.subarray(0, HEADER_LENGTH + frame * 4))).rejects.toThrow(BackupCryptoError);
  });

  it('rejects truncation mid-chunk and a header-only file', async () => {
    await expect(decrypt(cipher.subarray(0, cipher.length - 5))).rejects.toThrow(BackupCryptoError);
    await expect(decrypt(cipher.subarray(0, HEADER_LENGTH))).rejects.toThrow(BackupCryptoError);
    await expect(decrypt(cipher.subarray(0, 20))).rejects.toThrow(BackupCryptoError);
    await expect(decrypt(Buffer.alloc(0))).rejects.toThrow(BackupCryptoError);
  });

  it('rejects two chunks swapped', async () => {
    const c = Buffer.from(cipher);
    const a = HEADER_LENGTH;
    const first = Buffer.from(c.subarray(a, a + frame));
    c.subarray(a + frame, a + 2 * frame).copy(c, a);
    first.copy(c, a + frame);
    await expect(decrypt(c)).rejects.toThrow(BackupCryptoError);
  });

  it('rejects a chunk dropped from the middle', async () => {
    const c = Buffer.concat([cipher.subarray(0, HEADER_LENGTH + frame), cipher.subarray(HEADER_LENGTH + 2 * frame)]);
    await expect(decrypt(c)).rejects.toThrow(BackupCryptoError);
  });

  it('rejects data appended after the final chunk', async () => {
    await expect(decrypt(Buffer.concat([cipher, randomBytes(TAG + 4)]))).rejects.toThrow(BackupCryptoError);
    await expect(decrypt(Buffer.concat([cipher, cipher.subarray(HEADER_LENGTH)]))).rejects.toThrow(BackupCryptoError);
  });

  it('rejects a header spliced from another backup', async () => {
    const other = await encrypt(randomBytes(10));
    const c = Buffer.concat([other.subarray(0, HEADER_LENGTH), cipher.subarray(HEADER_LENGTH)]);
    await expect(decrypt(c)).rejects.toThrow(BackupCryptoError);
  });

  it('rejects the wrong private key before decrypting anything', async () => {
    const other = generateBackupKeys();
    await expect(decrypt(cipher, importEncryptionPrivateKey(other.encryptionPrivateKey)))
      .rejects.toThrow(/different key/);
  });

  it('rejects the wrong key even when the key id in the header is forged to match', async () => {
    const other = generateBackupKeys();
    const otherPriv = importEncryptionPrivateKey(other.encryptionPrivateKey);
    const c = Buffer.from(cipher);
    Buffer.from(keyId(createPublicKey(otherPriv)), 'hex').subarray(0, 16).copy(c, 9);
    await expect(decrypt(c, otherPriv)).rejects.toThrow(BackupCryptoError);
  });

  it('rejects a file that is not a backup', async () => {
    await expect(decrypt(Buffer.from('-- PostgreSQL database dump\n'.repeat(10)))).rejects.toThrow(/bad magic/);
  });
});

describe('backup keys', () => {
  it('generates distinct X25519 and Ed25519 pairs as base64 DER', () => {
    const k = generateBackupKeys();
    const k2 = generateBackupKeys();
    expect(k.encryptionPublicKey).not.toBe(k2.encryptionPublicKey);
    expect(importEncryptionPublicKey(k.encryptionPublicKey).asymmetricKeyType).toBe('x25519');
    expect(importEncryptionPrivateKey(k.encryptionPrivateKey).asymmetricKeyType).toBe('x25519');
    expect(importSigningPrivateKey(k.signingPrivateKey).asymmetricKeyType).toBe('ed25519');
    expect(importSigningPublicKey(k.signingPublicKey).asymmetricKeyType).toBe('ed25519');
  });

  it('refuses malformed keys and keys of the wrong kind, naming the setting and never the value', () => {
    const bogus = 'not-a-key';
    for (const fn of [() => importEncryptionPublicKey(bogus), () => importSigningPrivateKey(bogus)]) {
      try { fn(); throw new Error('accepted'); } catch (e) {
        expect(e).toBeInstanceOf(BackupCryptoError);
        expect((e as Error).message).not.toContain(bogus);
      }
    }
    // An Ed25519 key where an X25519 key belongs, and a public where a private belongs.
    expect(() => importEncryptionPublicKey(keys.signingPublicKey)).toThrow(/BACKUP_ENCRYPTION_PUBLIC_KEY/);
    expect(() => importEncryptionPrivateKey(keys.encryptionPublicKey)).toThrow(/BACKUP_ENCRYPTION_PRIVATE_KEY/);
    expect(() => importSigningPrivateKey(keys.encryptionPrivateKey)).toThrow(/BACKUP_SIGNING_PRIVATE_KEY/);
  });

  it('key ids are stable and derived from the public key', () => {
    expect(keyId(encPub)).toMatch(/^[0-9a-f]{32}$/);
    expect(keyId(createPublicKey(encPriv))).toBe(keyId(encPub));
  });
});

describe('signed manifest', () => {
  const hex = (s: string) => createHash('sha256').update(s).digest('hex');
  const manifest: BackupManifest = {
    format: 'FBK1',
    createdAt: '2026-09-29T03:00:00.000Z',
    objectKey: '2026/09/29/familista-20260929T030000Z-0a1b2c3d.fbk',
    ciphertextSha256: hex('cipher'),
    ciphertextBytes: 1234,
    plaintextSha256: hex('plain'),
    plaintextBytes: 1000,
    encryptionKeyId: keyId(encPub),
    signingKeyId: keyId(signPub),
    dumpFormat: 'pg_dump-custom',
    migrationHead: '20260901000000_example',
  };
  const signed = () => JSON.stringify(signManifest(manifest, signPriv));

  it('verifies a genuine manifest', () => {
    expect(verifyManifest(signed(), signPub)).toEqual(manifest);
  });

  it('canonical JSON does not depend on key order', () => {
    expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  });

  it.each([
    ['ciphertextSha256', hex('other')],
    ['ciphertextBytes', 1235],
    ['objectKey', '2026/09/29/other.fbk'],
    ['migrationHead', null],
    ['encryptionKeyId', '0'.repeat(32)],
  ])('rejects an edited %s', (field, value) => {
    const s = JSON.parse(signed());
    s.manifest[field] = value;
    expect(() => verifyManifest(JSON.stringify(s), signPub)).toThrow(BackupCryptoError);
  });

  it('rejects an added or a removed field', () => {
    const extra = JSON.parse(signed()); extra.manifest.note = 'x';
    expect(() => verifyManifest(JSON.stringify(extra), signPub)).toThrow(/unexpected fields/);
    const fewer = JSON.parse(signed()); delete fewer.manifest.plaintextBytes;
    expect(() => verifyManifest(JSON.stringify(fewer), signPub)).toThrow(/unexpected fields/);
  });

  it('rejects a manifest signed by another key, even one that names itself honestly', () => {
    const other = generateBackupKeys();
    const otherPriv = importSigningPrivateKey(other.signingPrivateKey);
    const forged = JSON.stringify(signManifest({ ...manifest, signingKeyId: keyId(createPublicKey(otherPriv)) }, otherPriv));
    expect(() => verifyManifest(forged, signPub)).toThrow(/different key/);
    const lying = JSON.stringify(signManifest(manifest, otherPriv));
    expect(() => verifyManifest(lying, signPub)).toThrow(/signature is invalid/);
  });

  it('rejects a missing or garbled signature and non-JSON', () => {
    const s = JSON.parse(signed());
    expect(() => verifyManifest(JSON.stringify({ manifest: s.manifest }), signPub)).toThrow(/malformed/);
    expect(() => verifyManifest(JSON.stringify({ ...s, signature: 'AAAA' }), signPub)).toThrow(/signature is invalid/);
    expect(() => verifyManifest('{not json', signPub)).toThrow(/not JSON/);
  });

  it('rejects malformed hashes and sizes even when signed', () => {
    const bad = JSON.stringify(signManifest({ ...manifest, ciphertextSha256: 'xyz' }, signPriv));
    expect(() => verifyManifest(bad, signPub)).toThrow(/malformed/);
    const neg = JSON.stringify(signManifest({ ...manifest, plaintextBytes: 1.5 }, signPriv));
    expect(() => verifyManifest(neg, signPub)).toThrow(/malformed/);
  });
});
