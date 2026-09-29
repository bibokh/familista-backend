// Cyber Defense, Step 10 — the backup envelope (format FBK1)
// ─────────────────────────────────────────────────────────────────────────────
// A database backup is the whole platform in one file, so it is encrypted to a
// PUBLIC key: the machine that takes backups can write them and can never read
// one back. The private key lives offline with the owner and is used only in a
// restore drill or a real recovery.
//
//   header   'FBK1' | version (1) | chunk size (u32 BE) | recipient key id (16)
//            | ephemeral X25519 public key (32)                      = 57 bytes
//   key      X25519(ephemeral, recipient) → HKDF-SHA256 (salt = header)
//            → 32-byte AES-256-GCM key + 7-byte nonce prefix
//   chunks   AES-256-GCM, nonce = prefix | u32 BE counter | final flag,
//            additional data = the header. Every chunk is authenticated on its
//            own, so a flipped bit, a reordered, dropped, appended or truncated
//            chunk, or a changed header all fail — the STREAM construction
//            (Hoang, Reyhanitabar, Rogaway, Vizár 2015), as used by age and Tink.
//
// Public-key encryption says nothing about WHO made a backup: anyone holding
// the public key could write one. So each backup also carries a manifest —
// the ciphertext's SHA-256 and what it contains — signed with Ed25519 by the
// runner. A restore verifies the signature and the hash before a single byte
// reaches the database.

import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, KeyObject, sign, verify,
} from 'crypto';
import { Transform, TransformCallback } from 'stream';

export const MAGIC = Buffer.from('FBK1', 'ascii');
export const VERSION = 1;
export const DEFAULT_CHUNK_SIZE = 64 * 1024;
export const HEADER_LENGTH = 4 + 1 + 4 + 16 + 32;
const TAG_LENGTH = 16;
const HKDF_INFO = Buffer.from('familista-backup/v1/aes-256-gcm', 'ascii');
/** DER prefix of an X25519 SubjectPublicKeyInfo; the raw key follows it. */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export class BackupCryptoError extends Error {
  constructor(message: string) { super(message); this.name = 'BackupCryptoError'; }
}

// ── keys ─────────────────────────────────────────────────────────────────────

export interface BackupKeySet {
  /** For the runner. */
  encryptionPublicKey: string;
  signingPrivateKey: string;
  /** Offline, for a restore. */
  encryptionPrivateKey: string;
  signingPublicKey: string;
}

const der = (k: KeyObject, kind: 'spki' | 'pkcs8') =>
  (kind === 'spki' ? k.export({ type: 'spki', format: 'der' }) : k.export({ type: 'pkcs8', format: 'der' })).toString('base64');

/** Two fresh key pairs, base64 DER. The operator stores them; nothing here does. */
export function generateBackupKeys(): BackupKeySet {
  const enc = generateKeyPairSync('x25519');
  const sig = generateKeyPairSync('ed25519');
  return {
    encryptionPublicKey: der(enc.publicKey, 'spki'),
    encryptionPrivateKey: der(enc.privateKey, 'pkcs8'),
    signingPublicKey: der(sig.publicKey, 'spki'),
    signingPrivateKey: der(sig.privateKey, 'pkcs8'),
  };
}

function importKey(b64: string, kind: 'public' | 'private', type: 'x25519' | 'ed25519', label: string): KeyObject {
  const raw = String(b64 ?? '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new BackupCryptoError(`${label} is not base64`);
  let key: KeyObject;
  try {
    key = kind === 'public'
      ? createPublicKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki' })
      : createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new BackupCryptoError(`${label} is not a valid ${type} ${kind} key`);
  }
  if (key.asymmetricKeyType !== type) throw new BackupCryptoError(`${label} is a ${key.asymmetricKeyType} key, expected ${type}`);
  return key;
}

export const importEncryptionPublicKey = (b64: string) => importKey(b64, 'public', 'x25519', 'BACKUP_ENCRYPTION_PUBLIC_KEY');
export const importEncryptionPrivateKey = (b64: string) => importKey(b64, 'private', 'x25519', 'BACKUP_ENCRYPTION_PRIVATE_KEY');
export const importSigningPrivateKey = (b64: string) => importKey(b64, 'private', 'ed25519', 'BACKUP_SIGNING_PRIVATE_KEY');
export const importSigningPublicKey = (b64: string) => importKey(b64, 'public', 'ed25519', 'BACKUP_SIGNING_PUBLIC_KEY');

const rawX25519 = (pub: KeyObject): Buffer => {
  const spki = pub.export({ type: 'spki', format: 'der' });
  if (spki.length !== 44 || !spki.subarray(0, 12).equals(X25519_SPKI_PREFIX)) throw new BackupCryptoError('unexpected X25519 key encoding');
  return spki.subarray(12);
};
const spkiFromRaw = (raw: Buffer): KeyObject =>
  createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });

/** A short public fingerprint: which key a backup or manifest belongs to. Never secret. */
export function keyId(pub: KeyObject): string {
  return createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 32);
}

function deriveKey(ephemeralPrivate: KeyObject | null, recipientPublic: KeyObject | null,
  recipientPrivate: KeyObject | null, ephemeralPublic: KeyObject | null, header: Buffer): { key: Buffer; prefix: Buffer } {
  const shared = ephemeralPrivate
    ? diffieHellman({ privateKey: ephemeralPrivate, publicKey: recipientPublic! })
    : diffieHellman({ privateKey: recipientPrivate!, publicKey: ephemeralPublic! });
  if (shared.every((b) => b === 0)) throw new BackupCryptoError('degenerate key agreement');
  const okm = Buffer.from(hkdfSync('sha256', shared, header, HKDF_INFO, 39));
  shared.fill(0);
  return { key: okm.subarray(0, 32), prefix: okm.subarray(32, 39) };
}

function nonce(prefix: Buffer, counter: number, final: boolean): Buffer {
  if (counter > 0xffffffff) throw new BackupCryptoError('backup too large for one envelope');
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(counter, 7);
  n[11] = final ? 1 : 0;
  return n;
}

// ── encrypt ──────────────────────────────────────────────────────────────────

/** Plaintext in, FBK1 envelope out. Holds back one chunk so the last is marked final. */
export function createEncryptStream(recipientPublicKey: KeyObject, chunkSize = DEFAULT_CHUNK_SIZE): Transform {
  if (!Number.isInteger(chunkSize) || chunkSize < 16 || chunkSize > 16 * 1024 * 1024) throw new BackupCryptoError('invalid chunk size');
  const eph = generateKeyPairSync('x25519');
  const header = Buffer.alloc(HEADER_LENGTH);
  MAGIC.copy(header, 0);
  header[4] = VERSION;
  header.writeUInt32BE(chunkSize, 5);
  Buffer.from(keyId(recipientPublicKey), 'hex').subarray(0, 16).copy(header, 9);
  rawX25519(eph.publicKey).copy(header, 25);
  const { key, prefix } = deriveKey(eph.privateKey, recipientPublicKey, null, null, header);
  let counter = 0;
  let pending = Buffer.alloc(0);
  let headerSent = false;

  const seal = (plain: Buffer, final: boolean): Buffer => {
    const c = createCipheriv('aes-256-gcm', key, nonce(prefix, counter++, final));
    c.setAAD(header);
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        if (!headerSent) { this.push(header); headerSent = true; }
        pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
        // Strictly more than one chunk: the last chunk is only known at flush.
        while (pending.length > chunkSize) {
          this.push(seal(pending.subarray(0, chunkSize), false));
          pending = pending.subarray(chunkSize);
        }
        cb();
      } catch (e) { cb(e as Error); }
    },
    flush(cb: TransformCallback) {
      try {
        if (!headerSent) { this.push(header); headerSent = true; }
        this.push(seal(pending, true));
        pending = Buffer.alloc(0);
        key.fill(0);
        cb();
      } catch (e) { cb(e as Error); }
    },
  });
}

// ── decrypt ──────────────────────────────────────────────────────────────────

/** FBK1 envelope in, plaintext out. Any tampering, truncation or wrong key fails the stream. */
export function createDecryptStream(recipientPrivateKey: KeyObject): Transform {
  const recipientPublic = createPublicKey(recipientPrivateKey);
  const expectedId = Buffer.from(keyId(recipientPublic), 'hex').subarray(0, 16);
  let header: Buffer | null = null;
  let key: Buffer | null = null;
  let prefix: Buffer | null = null;
  let frame = 0;
  let counter = 0;
  let buf = Buffer.alloc(0);

  const open = (sealed: Buffer, final: boolean): Buffer => {
    if (sealed.length < TAG_LENGTH) throw new BackupCryptoError('backup is truncated');
    const d = createDecipheriv('aes-256-gcm', key!, nonce(prefix!, counter++, final));
    d.setAAD(header!);
    d.setAuthTag(sealed.subarray(sealed.length - TAG_LENGTH));
    try {
      return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_LENGTH)), d.final()]);
    } catch {
      throw new BackupCryptoError('backup failed authentication: tampered, truncated or encrypted to another key');
    }
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
        if (!header) {
          if (buf.length < HEADER_LENGTH) return cb();
          const h = buf.subarray(0, HEADER_LENGTH);
          if (!h.subarray(0, 4).equals(MAGIC)) throw new BackupCryptoError('not a Familista backup (bad magic)');
          if (h[4] !== VERSION) throw new BackupCryptoError(`unsupported backup version ${h[4]}`);
          const size = h.readUInt32BE(5);
          if (size < 16 || size > 16 * 1024 * 1024) throw new BackupCryptoError('invalid chunk size in header');
          if (!h.subarray(9, 25).equals(expectedId)) throw new BackupCryptoError('backup is encrypted to a different key');
          header = Buffer.from(h);
          frame = size + TAG_LENGTH;
          ({ key, prefix } = deriveKey(null, null, recipientPrivateKey, spkiFromRaw(h.subarray(25, 57)), header));
          buf = buf.subarray(HEADER_LENGTH);
        }
        while (buf.length > frame) {
          this.push(open(buf.subarray(0, frame), false));
          buf = buf.subarray(frame);
        }
        cb();
      } catch (e) { cb(e as Error); }
    },
    flush(cb: TransformCallback) {
      try {
        if (!header) throw new BackupCryptoError('backup is truncated (no header)');
        this.push(open(buf, true));
        key!.fill(0);
        cb();
      } catch (e) { cb(e as Error); }
    },
  });
}

// ── manifest ─────────────────────────────────────────────────────────────────

export interface BackupManifest {
  format: 'FBK1';
  createdAt: string;
  objectKey: string;
  ciphertextSha256: string;
  ciphertextBytes: number;
  plaintextSha256: string;
  plaintextBytes: number;
  encryptionKeyId: string;
  signingKeyId: string;
  dumpFormat: 'pg_dump-custom';
  migrationHead: string | null;
}

export interface SignedManifest { manifest: BackupManifest; signature: string }

/** Canonical JSON: sorted keys, no whitespace, so the signature is over exactly one byte string. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export function signManifest(manifest: BackupManifest, signingPrivateKey: KeyObject): SignedManifest {
  return { manifest, signature: sign(null, Buffer.from(canonical(manifest)), signingPrivateKey).toString('base64') };
}

const MANIFEST_KEYS: Array<keyof BackupManifest> = ['format', 'createdAt', 'objectKey', 'ciphertextSha256', 'ciphertextBytes',
  'plaintextSha256', 'plaintextBytes', 'encryptionKeyId', 'signingKeyId', 'dumpFormat', 'migrationHead'];

/** Parses, checks the shape and verifies the signature. Returns the manifest only if all hold. */
export function verifyManifest(raw: string, signingPublicKey: KeyObject): BackupManifest {
  let parsed: SignedManifest;
  try { parsed = JSON.parse(raw); } catch { throw new BackupCryptoError('manifest is not JSON'); }
  const m = parsed && parsed.manifest;
  if (!m || typeof m !== 'object' || typeof parsed.signature !== 'string') throw new BackupCryptoError('manifest is malformed');
  const keys = Object.keys(m).sort();
  if (canonical(keys) !== canonical([...MANIFEST_KEYS].sort())) throw new BackupCryptoError('manifest has unexpected fields');
  if (m.format !== 'FBK1' || m.dumpFormat !== 'pg_dump-custom'
    || !/^[0-9a-f]{64}$/.test(String(m.ciphertextSha256)) || !/^[0-9a-f]{64}$/.test(String(m.plaintextSha256))
    || !Number.isSafeInteger(m.ciphertextBytes) || !Number.isSafeInteger(m.plaintextBytes)) {
    throw new BackupCryptoError('manifest is malformed');
  }
  if (m.signingKeyId !== keyId(signingPublicKey)) throw new BackupCryptoError('manifest was signed by a different key');
  let ok = false;
  try { ok = verify(null, Buffer.from(canonical(m)), signingPublicKey, Buffer.from(parsed.signature, 'base64')); } catch { ok = false; }
  if (!ok) throw new BackupCryptoError('manifest signature is invalid');
  return m;
}
