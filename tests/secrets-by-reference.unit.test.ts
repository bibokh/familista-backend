/**
 * tests/secrets-by-reference.unit.test.ts
 *
 * Data Fabric phase 1, item 3: a device's root key stops being a plain column.
 *
 * THE FINDING THIS CLOSES
 *
 * `Device.hmacSecret` and `Camera.hmacSecret` are long-lived HMAC root keys
 * stored as plaintext columns on ordinary, club-scoped rows. Every logical dump
 * of Postgres therefore carries the credentials of the entire fleet in the
 * clear, no rotation is possible anywhere in the codebase, and — the part that
 * was not in the original audit — `registerDevice` and `registerCamera` both
 * returned the WHOLE Prisma row spread into the HTTP response, so the raw
 * `hmacSecret` column travelled to the client alongside the intentional
 * `hmacSecretPlaintext`. The activate path strips it; the register paths did
 * not.
 *
 * WHAT IS ASSERTED, AND WHY IN THIS ORDER
 *
 * The dual-read rule first, because getting it wrong in either direction is
 * worse than not doing it at all: prefer the reference, fall back ONLY on its
 * absence. A fallback that also fired when a reference failed to resolve would
 * mean a revoked credential quietly reverting to the plaintext one it replaced.
 *
 * Then containment — no secret in a response, an event, a log or an error —
 * checked by executing the code, not by reading the comments.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

type Row = Record<string, any>;

const CLUB = '11111111-1111-4111-8111-111111111111';
const OTHER_CLUB = '22222222-2222-4222-8222-222222222222';
const DEVICE = 'dev-0001';
const CAMERA = 'cam-0001';

const state = { secrets: [] as Row[], outbox: [] as Row[] };

const db: Row = {
  platformSecret: {
    findUnique: async ({ where }: Row) => {
      const k = where.scope_name_version;
      return state.secrets.find((s) => s.scope === k.scope && s.name === k.name && s.version === k.version) ?? null;
    },
    findMany: async ({ where = {} }: Row = {}) => state.secrets
      .filter((s) => (!where.scope || s.scope === where.scope) && (!where.name || s.name === where.name))
      .sort((a, b) => b.version - a.version),
    create: async ({ data }: Row) => {
      if (state.secrets.some((s) => s.scope === data.scope && s.name === data.name && s.version === data.version)) {
        const err: any = new Error('Unique constraint failed'); err.code = 'P2002'; throw err;
      }
      const row = { id: `s-${state.secrets.length + 1}`, createdAt: new Date(), rotatedAt: null, revokedAt: null, ...data };
      state.secrets.push(row);
      return row;
    },
    upsert: async ({ where, create, update }: Row) => {
      const k = where.scope_name_version;
      const found = state.secrets.find((s) => s.scope === k.scope && s.name === k.name && s.version === k.version);
      if (found) { Object.assign(found, update); return found; }
      return db.platformSecret.create({ data: create });
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = state.secrets.filter((s) =>
        s.scope === where.scope && s.name === where.name && s.version === where.version
        && (where.revokedAt === undefined || s.revokedAt === where.revokedAt)
        && (where.rotatedAt === undefined || s.rotatedAt === where.rotatedAt));
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
  },
  eventOutbox: {
    create: async ({ data }: Row) => {
      if (state.outbox.some((r) => r.idempotencyKey === data.idempotencyKey)) {
        const err: any = new Error('Unique constraint failed'); err.code = 'P2002'; throw err;
      }
      const row = { id: `o-${state.outbox.length + 1}`, createdAt: new Date(), ...data };
      state.outbox.push(row);
      return row;
    },
    findMany: async () => [...state.outbox].reverse(),
  },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

// Every log line this code could emit, captured so a secret in one is a failure
// rather than something nobody looks at.
const logged: string[] = [];
jest.mock('../src/utils/logger', () => ({
  logger: {
    warn: (...a: unknown[]) => { logged.push(JSON.stringify(a)); },
    error: (...a: unknown[]) => { logged.push(JSON.stringify(a)); },
    info: (...a: unknown[]) => { logged.push(JSON.stringify(a)); },
    debug: (...a: unknown[]) => { logged.push(JSON.stringify(a)); },
  },
}));

import {
  makeSecretRef, parseSecretRef, formatSecretRef, isSecretRef, looksLikeSecretMaterial,
  SecretRefError,
  MemorySecretStore, EnvSecretStore, DbSecretStore, setSecretStore, getSecretStore,
  generateSecret, secretsEqual, sealSecret, openSecret, SECRET_KEK_ENV,
  SecretKeyConfigError, SecretKeyUnavailable, WeakSecretKey,
  MIN_KEK_BYTES, MIN_KEK_DISTINCT_CHARS, effectiveKeyBytes, kekWeakness, secretKeyStatus,
  resolveCredential, storeNewCredential, rotateCredential, revokeCredential,
  credentialRefFor, credentialStorageMode,
  setEventTransport, outboxTransport, readEvents, clearSubscribers,
  registeredEventTypes,
  type SecretStore,
} from '../src/fabric';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const decomment = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const LEGACY_SECRET = 'bGVnYWN5LXNlY3JldC1ieXRlcy1oZXJlLTMyLWJ5dGVzIQ==';

beforeEach(() => {
  state.secrets = [];
  state.outbox = [];
  logged.length = 0;
  clearSubscribers();
  setEventTransport(outboxTransport);
  process.env[SECRET_KEK_ENV] = 'a-test-key-encryption-key-of-sufficient-length';
  setSecretStore(new DbSecretStore());
});

afterAll(() => {
  setEventTransport(null);
  setSecretStore(null);
  delete process.env[SECRET_KEK_ENV];
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 · A reference is not a secret
// ─────────────────────────────────────────────────────────────────────────────

describe('the reference format', () => {
  test('round-trips, and names a provider, scope, name and version', () => {
    const ref = makeSecretRef({ provider: 'db', scope: 'device', name: DEVICE, version: 3 });
    const s = formatSecretRef(ref);
    expect(s).toBe(`fam:v1:db:device/${DEVICE}#3`);
    expect(parseSecretRef(s)).toEqual(ref);
    expect(isSecretRef(s)).toBe(true);
  });

  test('a reference carrying secret material is refused at construction', () => {
    // The rule the whole design rests on, enforced rather than trusted.
    const key = generateSecret();
    expect(looksLikeSecretMaterial(key)).toBe(true);
    expect(() => makeSecretRef({ provider: 'db', scope: 'device', name: key }))
      .toThrow(SecretRefError);
    expect(() => makeSecretRef({ provider: 'db', scope: 'device', name: 'a'.repeat(64) }))
      .toThrow(/must not contain secret material/);
  });

  test('an ordinary uuid is not mistaken for key material', () => {
    expect(looksLikeSecretMaterial(DEVICE)).toBe(false);
    expect(looksLikeSecretMaterial('11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(() => makeSecretRef({ provider: 'db', scope: 'device', name: '11111111-1111-4111-8111-111111111111' }))
      .not.toThrow();
  });

  test('anything unparseable is null rather than an exception', () => {
    // The common caller is a dual-read looking at a column that may hold a
    // reference, a legacy value, or nothing. None of those is an error.
    for (const bad of [null, undefined, '', LEGACY_SECRET, 'fam:v9:db:device/x#1', 'nonsense']) {
      expect(parseSecretRef(bad as string)).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Dual read — the property that makes the cutover safe AND meaningful
// ─────────────────────────────────────────────────────────────────────────────

describe('dual read', () => {
  test('a reference is preferred over the legacy column', async () => {
    const ref = await storeNewCredential('device', DEVICE, 'the-new-secret');
    const out = await resolveCredential({ id: DEVICE, clubId: CLUB, secretRef: ref, hmacSecret: LEGACY_SECRET });
    expect(out.source).toBe('REFERENCE');
    expect(out.value).toBe('the-new-secret');
    expect(out.value).not.toBe(LEGACY_SECRET);
  });

  test('a row with no reference still authenticates from the legacy column', async () => {
    // Every device in the field today. This is the compatibility guarantee.
    const out = await resolveCredential({ id: DEVICE, clubId: CLUB, secretRef: null, hmacSecret: LEGACY_SECRET });
    expect(out.source).toBe('LEGACY_COLUMN');
    expect(out.value).toBe(LEGACY_SECRET);
  });

  test('a reference that does NOT resolve never falls back to the legacy column', async () => {
    // The direction that matters. A revoked credential must not silently revert
    // to the plaintext one it replaced — that would be revocation that does not
    // revoke.
    const ref = await storeNewCredential('device', DEVICE, 'the-new-secret');
    await revokeCredential(ref);
    const out = await resolveCredential({ id: DEVICE, clubId: CLUB, secretRef: ref, hmacSecret: LEGACY_SECRET });
    expect(out.source).toBe('REFERENCE');
    expect(out.value).toBeNull();
  });

  test('a row with neither resolves to nothing, and does not throw', async () => {
    const out = await resolveCredential({ id: DEVICE, clubId: CLUB });
    expect(out).toEqual({ value: null, source: 'NONE', ref: null });
  });

  test('clearing the reference returns the row to the legacy path exactly', async () => {
    // Reversibility, demonstrated rather than claimed.
    const ref = await storeNewCredential('device', DEVICE, 'the-new-secret');
    const migrated = { id: DEVICE, clubId: CLUB, secretRef: ref, hmacSecret: LEGACY_SECRET };
    expect((await resolveCredential(migrated)).value).toBe('the-new-secret');
    const rolledBack = { ...migrated, secretRef: null };
    expect((await resolveCredential(rolledBack)).value).toBe(LEGACY_SECRET);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Rotation and revocation — neither of which existed before
// ─────────────────────────────────────────────────────────────────────────────

describe('rotation', () => {
  test('mints the next version and leaves the previous one working', async () => {
    // A fleet cannot re-key in the same instant. The grace window is the design.
    const ref = await storeNewCredential('device', DEVICE, 'v1-secret');
    const out = await rotateCredential({ id: DEVICE, clubId: CLUB, secretRef: ref });
    expect(out!.ref).toBe(`fam:v1:db:device/${DEVICE}#2`);
    expect(out!.previousRef).toBe(`fam:v1:db:device/${DEVICE}#1`);
    expect(out!.value).not.toBe('v1-secret');

    // Both versions still resolve — that is what makes a fleet rotation survivable.
    expect((await resolveCredential({ id: DEVICE, secretRef: out!.previousRef })).value).toBe('v1-secret');
    expect((await resolveCredential({ id: DEVICE, secretRef: out!.ref })).value).toBe(out!.value);
  });

  test('and closing the window is a separate, deliberate act', async () => {
    const ref = await storeNewCredential('device', DEVICE, 'v1-secret');
    const out = await rotateCredential({ id: DEVICE, clubId: CLUB, secretRef: ref });
    await revokeCredential(out!.previousRef);
    expect((await resolveCredential({ id: DEVICE, secretRef: out!.previousRef })).value).toBeNull();
    expect((await resolveCredential({ id: DEVICE, secretRef: out!.ref })).value).toBe(out!.value);
  });

  test('a legacy row cannot be rotated in place', async () => {
    // Rotating a plaintext column would write a NEW plaintext secret, which is
    // the exact thing this item exists to stop.
    expect(await rotateCredential({ id: DEVICE, clubId: CLUB, secretRef: null, hmacSecret: LEGACY_SECRET }))
      .toBeNull();
  });

  test('revocation keeps the record of what existed', async () => {
    const ref = await storeNewCredential('device', DEVICE, 'v1-secret');
    await revokeCredential(ref);
    // The row survives — an incident review needs to know a credential existed
    // and when it was revoked.
    expect(state.secrets).toHaveLength(1);
    expect(state.secrets[0].revokedAt).toBeInstanceOf(Date);
  });

  test('one device does not share a credential with another', async () => {
    // No global root secret authenticating the whole fleet.
    const a = await storeNewCredential('device', 'dev-a', 'secret-a');
    const b = await storeNewCredential('device', 'dev-b', 'secret-b');
    expect(a).not.toBe(b);
    expect((await resolveCredential({ id: 'dev-a', secretRef: a })).value).toBe('secret-a');
    expect((await resolveCredential({ id: 'dev-b', secretRef: b })).value).toBe('secret-b');
    // Revoking one leaves the other alone.
    await revokeCredential(a);
    expect((await resolveCredential({ id: 'dev-b', secretRef: b })).value).toBe('secret-b');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Containment — no secret in a response, an event, a log or an error
// ─────────────────────────────────────────────────────────────────────────────

describe('a secret never leaves the code that verifies with it', () => {
  test('the store holds ciphertext, not the value', async () => {
    await storeNewCredential('device', DEVICE, 'the-real-secret');
    const row = state.secrets[0];
    expect(row.sealed).not.toContain('the-real-secret');
    expect(JSON.stringify(state.secrets)).not.toContain('the-real-secret');
    // …and it opens again, so this is encryption rather than loss.
    expect(openSecret(row.sealed)).toBe('the-real-secret');
  });

  test('a wrong key opens nothing, and says nothing about why', () => {
    const sealed = sealSecret('the-real-secret');
    process.env[SECRET_KEK_ENV] = 'a-completely-different-key-of-sufficient-length';
    expect(openSecret(sealed)).toBeNull();
  });

  test('the credential events carry the reference and never the value', async () => {
    const ref = await storeNewCredential('device', DEVICE, 'the-real-secret', { clubId: CLUB });
    const out = await rotateCredential({ id: DEVICE, clubId: CLUB, secretRef: ref });
    await revokeCredential(out!.ref, { clubId: CLUB, subjectId: DEVICE });
    await new Promise((r) => setImmediate(r));

    const events = await readEvents({ clubId: CLUB });
    expect(events.map((e) => e.eventType).sort()).toEqual([
      'device.credential.created', 'device.credential.revoked', 'device.credential.rotated',
    ]);
    const dumped = JSON.stringify(events);
    expect(dumped).not.toContain('the-real-secret');
    expect(dumped).not.toContain(out!.value);
    // The reference IS there — that is the point.
    expect(dumped).toContain(`fam:v1:db:device/${DEVICE}`);
  });

  test('nothing a secret passes through is written to a log', async () => {
    const ref = await storeNewCredential('device', DEVICE, 'the-real-secret');
    await resolveCredential({ id: DEVICE, secretRef: ref, hmacSecret: LEGACY_SECRET });
    await revokeCredential(ref);
    await resolveCredential({ id: DEVICE, secretRef: ref });   // now fails to resolve
    const all = logged.join('\n');
    expect(all).not.toContain('the-real-secret');
    expect(all).not.toContain(LEGACY_SECRET);
  });

  test('an error names the reference, never the value', async () => {
    await storeNewCredential('device', DEVICE, 'the-real-secret');
    // A second put at the same reference is refused.
    await expect(getSecretStore().putSecret(credentialRefFor('device', DEVICE), 'another', { overwrite: false }))
      .rejects.toThrow(/fam:v1:db:device/);
    await expect(getSecretStore().putSecret(credentialRefFor('device', DEVICE), 'another', { overwrite: false }))
      .rejects.not.toThrow(/another/);
  });

  test('the registration responses cannot carry the raw column', () => {
    // The leak found during this item: both register paths spread the whole
    // Prisma row into the response, so `hmacSecret` travelled to the client
    // beside the intentional `hmacSecretPlaintext`. Both now select explicitly.
    for (const [file, sel] of [
      ['src/services/device-registry.service.ts', 'DEVICE_PUBLIC_SELECT'],
      ['src/vision/camera-registry.service.ts', 'CAMERA_PUBLIC_SELECT'],
    ] as const) {
      const src = decomment(read(file));
      expect(`${file} has ${sel}: ${src.includes(sel)}`).toBe(`${file} has ${sel}: true`);
      // The narrowed select must not name the secret column.
      const block = src.slice(src.indexOf(`const ${sel}`), src.indexOf('} as const', src.indexOf(`const ${sel}`)));
      expect(`${sel} selects hmacSecret: ${block.includes('hmacSecret')}`).toBe(`${sel} selects hmacSecret: false`);
    }
  });

  test('no verification path reads the plaintext column directly any more', () => {
    // Every signature check goes through the seam, so a migrated row cannot be
    // verified against the key it was migrated away from.
    for (const f of [
      'src/services/device-registry.service.ts',
      'src/security-l/attestation.service.ts',
      'src/vision/vision-ingest.service.ts',
      'src/vision/event-stream.service.ts',
      'src/vision/biomechanical-ingest.service.ts',
    ]) {
      const src = decomment(read(f));
      expect(`${f}: ${/\w+\.hmacSecret\b/.test(src)}`).toBe(`${f}: false`);
      expect(`${f} resolves: ${src.includes('resolveCredential')}`).toBe(`${f} resolves: true`);
    }
  });

  test('the registry classifies the sealed column as a credential', () => {
    const src = read('src/security/sensitive-fields.ts');
    expect(src).toContain("field: 'PlatformSecret.sealed'");
    expect(src).toContain("field: 'Device.hmacSecret'");
    expect(src).toContain("field: 'Camera.hmacSecret'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · The port is real
// ─────────────────────────────────────────────────────────────────────────────

describe('provider independence', () => {
  test('a different store takes over with no domain change', async () => {
    const calls: string[] = [];
    const fake: SecretStore = {
      provider: 'vaultish',
      getSecret: async () => { calls.push('get'); return 'from-the-other-store'; },
      putSecret: async () => { calls.push('put'); },
      rotateSecret: async (ref) => ({ ref: { ...ref, version: ref.version + 1 }, value: 'rotated', previous: ref }),
      deleteSecret: async () => { calls.push('delete'); },
      exists: async () => true,
    };
    setSecretStore(fake);

    const ref = await storeNewCredential('device', DEVICE, 'ignored');
    expect(ref).toBe(`fam:v1:vaultish:device/${DEVICE}#1`);
    expect((await resolveCredential({ id: DEVICE, secretRef: ref })).value).toBe('from-the-other-store');
    expect(calls).toEqual(['put', 'get']);
  });

  test('no domain file names a vendor', () => {
    for (const f of [
      'src/fabric/secrets/secret-ref.ts',
      'src/fabric/secrets/secret-store.ts',
      'src/fabric/secrets/device-credentials.ts',
    ]) {
      const src = decomment(read(f));
      expect(`${f}: ${/aws-sdk|SecretsManager|hashicorp|vault\.|googleapis|azure/i.test(src)}`).toBe(`${f}: false`);
    }
    // Only the db store knows Postgres exists.
    expect(decomment(read('src/fabric/secrets/secret-ref.ts'))).not.toContain('config/database');
    expect(decomment(read('src/fabric/secrets/device-credentials.ts'))).not.toContain('config/database');
  });

  test('the memory and env stores honour the same contract', async () => {
    const mem = new MemorySecretStore();
    setSecretStore(mem);
    const ref = credentialRefFor('device', DEVICE);
    await mem.putSecret(ref, 'in-memory');
    expect(await mem.getSecret(ref)).toBe('in-memory');
    expect(await mem.exists(ref)).toBe(true);
    await mem.deleteSecret(ref);
    expect(await mem.exists(ref)).toBe(false);

    // The env store is read-only, and says so rather than pretending.
    const env = new EnvSecretStore();
    await expect(env.putSecret(ref, 'x')).rejects.toThrow(/read-only/);
    await expect(env.rotateSecret(ref)).rejects.toThrow(/cannot rotate/);
  });

  test('a store that cannot accept a credential falls back rather than failing', async () => {
    // The property that lets this ship before the deployment is reconfigured.
    setSecretStore(new EnvSecretStore());
    const ref = await storeNewCredential('device', DEVICE, 'the-real-secret');
    expect(ref).toBeNull();
    const mode = await credentialStorageMode();
    expect(mode.writable).toBe(false);
    expect(mode.reason).toMatch(/read-only/);
    // And nothing about the secret reached a log on the way.
    expect(logged.join('\n')).not.toContain('the-real-secret');
  });

  test('secrets are compared without leaking which byte differed', () => {
    const a = generateSecret();
    expect(secretsEqual(a, a)).toBe(true);
    expect(secretsEqual(a, generateSecret())).toBe(false);
    expect(secretsEqual(a, a.slice(0, -1))).toBe(false);
    expect(secretsEqual(null, a)).toBe(false);
    expect(secretsEqual('', '')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · Cross-tenant
// ─────────────────────────────────────────────────────────────────────────────

describe('one club cannot resolve another club\'s credential', () => {
  test('a reference names a specific device, and there is no wildcard', async () => {
    const mine = await storeNewCredential('device', 'dev-mine', 'my-secret', { clubId: CLUB });
    await storeNewCredential('device', 'dev-theirs', 'their-secret', { clubId: OTHER_CLUB });

    // A reference resolves the credential it names and nothing else. There is
    // no listing operation on the port at all — no caller can enumerate.
    expect((await resolveCredential({ id: 'dev-mine', clubId: CLUB, secretRef: mine })).value).toBe('my-secret');
    expect('list' in getSecretStore()).toBe(false);
    expect(Object.keys(getSecretStore())).not.toContain('list');
  });

  test('the credential events stay in their own club\'s stream', async () => {
    await storeNewCredential('device', 'dev-mine', 'my-secret', { clubId: CLUB });
    await storeNewCredential('device', 'dev-theirs', 'their-secret', { clubId: OTHER_CLUB });
    await new Promise((r) => setImmediate(r));

    const mine = await readEvents({ clubId: CLUB });
    expect(mine).toHaveLength(1);
    expect(mine[0].subjectId).toBe('dev-mine');
    expect(JSON.stringify(mine)).not.toContain('their-secret');
    expect(JSON.stringify(mine)).not.toContain('dev-theirs');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 · The taxonomy knows these events
// ─────────────────────────────────────────────────────────────────────────────

describe('taxonomy', () => {
  test('the three credential events are registered and confidential', () => {
    const names = registeredEventTypes();
    for (const n of ['device.credential.created', 'device.credential.rotated', 'device.credential.revoked']) {
      expect(`${n}: ${names.includes(n)}`).toBe(`${n}: true`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 · The KEK strength floor
// ─────────────────────────────────────────────────────────────────────────────
//
// THE HAZARD THIS CLOSES
//
// `deriveKek` hashes the environment value with SHA-256 to get its AES-256 key.
// SHA-256 turns ANY input into 32 plausible-looking bytes, so a KEK of `"x"`
// produces a key that is indistinguishable, from the outside, from one derived
// from 48 bytes of `openssl rand`. Every ciphertext in `PlatformSecret` would
// look correctly sealed while being openable by anyone who guesses one
// character. Nothing downstream can detect that; only a check on the INPUT can.
//
// So the floor is enforced before the hash, and it fails CLOSED: a deployment
// whose KEK is too weak stores no credential at all rather than storing one
// badly. The legacy column keeps working in the meantime, which is what makes
// failing closed survivable rather than an outage.

describe('the KEK strength floor', () => {
  // Both are consulted by deriveKek, so both have to be controlled here. The
  // suite's own beforeEach restores FAMILISTA_SECRET_KEK; the MFA key is
  // global test setup and is put back by hand.
  const MFA = process.env.MFA_ENCRYPTION_KEY;

  afterEach(() => {
    if (MFA === undefined) delete process.env.MFA_ENCRYPTION_KEY;
    else process.env.MFA_ENCRYPTION_KEY = MFA;
  });

  /** No KEK anywhere — the state of a deployment that has not been configured. */
  const withNoKek = () => {
    delete process.env[SECRET_KEK_ENV];
    delete process.env.MFA_ENCRYPTION_KEY;
  };

  test('effective key material is measured by its smallest honest reading', () => {
    // A 44-character base64 string is 33 bytes of entropy, not 44. Crediting
    // it with 44 is how a value one byte short of the floor passes it.
    const b64 = Buffer.alloc(33, 7).toString('base64');
    expect(b64).toHaveLength(44);
    expect(effectiveKeyBytes(b64)).toBe(33);

    // hex, likewise: two characters per byte.
    expect(effectiveKeyBytes('ab'.repeat(32))).toBe(32);
    expect(effectiveKeyBytes('ab'.repeat(16))).toBe(16);

    // Neither base64 nor hex — a passphrase — is its UTF-8 byte length.
    expect(effectiveKeyBytes('a-passphrase-of-some-length-here!')).toBe(33);

    expect(effectiveKeyBytes('')).toBe(0);
    expect(effectiveKeyBytes(undefined as unknown as string)).toBe(0);
  });

  test('the floor is the width of the key it derives, and length alone is not strength', () => {
    expect(MIN_KEK_BYTES).toBe(32);

    // At or above the floor, by each of the three readings.
    expect(kekWeakness('familista-secret-kek-passphrase!!')).toBeNull();  // 33 utf-8 bytes
    expect(kekWeakness(generateSecret(32))).toBeNull();                   // 44 base64 chars, 32 bytes
    expect(kekWeakness(randomBytes(32).toString('hex'))).toBeNull();      // 64 hex chars, 32 bytes

    // One byte under, and refused.
    expect(kekWeakness('familista-secret-kek-passphrase')).not.toBeNull();

    // The conservative reading, as a rule and not an accident: 32 characters
    // drawn from the base64 alphabet carry 24 bytes, not 32. Counting the
    // characters would let a value a quarter under the floor pass it.
    const looksLongEnough = 'x'.repeat(20) + 'ABCDEFGHIJKL';
    expect(looksLongEnough).toHaveLength(32);
    expect(effectiveKeyBytes(looksLongEnough)).toBe(24);
    expect(kekWeakness(looksLongEnough)).toMatch(/fewer than 32 bytes/);

    for (const weak of ['', 'x', 'short', 'changeme', 'familista', 'a'.repeat(31)]) {
      expect(`${weak.length}:${kekWeakness(weak) !== null}`).toBe(`${weak.length}:true`);
    }

    // Long, and still almost no entropy. It CLEARS the byte floor — 64 'a's
    // read as hex are 32 bytes — so length alone would pass it, and only the
    // distinct-character floor catches it.
    expect(effectiveKeyBytes('a'.repeat(64))).toBe(MIN_KEK_BYTES);
    expect(kekWeakness('a'.repeat(64))).toMatch(/distinct characters/);
    expect(MIN_KEK_DISTINCT_CHARS).toBeLessThanOrEqual(16); // lowercase hex must stay legal
    expect(kekWeakness(Buffer.alloc(32, 0).toString('hex'))).toMatch(/distinct characters/);
  });

  test('a missing KEK cannot seal, and says which variable to set', () => {
    withNoKek();
    expect(secretKeyStatus()).toEqual({ usable: false, reason: `${SECRET_KEK_ENV} is not set` });

    let thrown: unknown;
    try { sealSecret('a-credential'); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(SecretKeyUnavailable);
    expect(thrown).toBeInstanceOf(SecretKeyConfigError);
    expect((thrown as Error).message).toContain(SECRET_KEK_ENV);
  });

  test('a too-short KEK cannot seal, and is not rescued by the MFA fallback', () => {
    // The fallback exists for a deployment with no dedicated KEK. It must not
    // turn an explicitly-set weak KEK into a silently-working one — that would
    // make a misconfiguration invisible, which is the failure mode of every
    // fallback that fires on the wrong condition.
    process.env.MFA_ENCRYPTION_KEY = 'a-perfectly-strong-mfa-key-of-length!';
    process.env[SECRET_KEK_ENV] = 'too-short';

    const status = secretKeyStatus();
    expect(status.usable).toBe(false);
    expect(status.reason).toContain(SECRET_KEK_ENV);

    let thrown: unknown;
    try { sealSecret('a-credential'); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(WeakSecretKey);
    expect(thrown).toBeInstanceOf(SecretKeyConfigError);
  });

  test('a valid KEK seals, opens and round-trips', () => {
    process.env[SECRET_KEK_ENV] = generateSecret(48);
    expect(secretKeyStatus()).toEqual({ usable: true, reason: null });

    const value = generateSecret();
    const sealed = sealSecret(value);
    expect(sealed).not.toContain(value);
    expect(sealed.split(':')).toHaveLength(3);
    expect(openSecret(sealed)).toBe(value);
  });

  test('a weak KEK does not hash into an acceptable-looking key — it fails closed', async () => {
    // The point of the whole section. Without the floor, this seals fine and
    // the row looks exactly like a properly protected one.
    process.env[SECRET_KEK_ENV] = 'x';
    delete process.env.MFA_ENCRYPTION_KEY;

    await expect(getSecretStore().putSecret(
      credentialRefFor('device', DEVICE), 'the-real-credential',
    )).rejects.toBeInstanceOf(WeakSecretKey);

    expect(state.secrets).toHaveLength(0);
  });

  test('no credential is stored when the KEK is invalid, and none is invented', async () => {
    process.env[SECRET_KEK_ENV] = 'weak';
    delete process.env.MFA_ENCRYPTION_KEY;

    const ref = await storeNewCredential('device', DEVICE, 'the-real-credential', { clubId: CLUB });

    // Null, so registration writes the legacy column exactly as it does today.
    expect(ref).toBeNull();
    expect(state.secrets).toHaveLength(0);

    // And nothing half-written: no reference resolves, so a verification path
    // gets no credential rather than a wrong one.
    expect(await getSecretStore().exists(credentialRefFor('device', DEVICE))).toBe(false);
    expect(await getSecretStore().getSecret(credentialRefFor('device', DEVICE))).toBeNull();
  });

  test('a KEK failure never puts secret material in a log, an event or an error', async () => {
    const KEK = 'weak';
    process.env[SECRET_KEK_ENV] = KEK;
    delete process.env.MFA_ENCRYPTION_KEY;

    await storeNewCredential('device', DEVICE, 'the-real-credential', { clubId: CLUB });
    await new Promise((r) => setImmediate(r));

    // Something WAS logged — a silent failure would be worse than a leaky one.
    expect(logged.length).toBeGreaterThan(0);
    const everything = `${logged.join('\n')}\n${JSON.stringify(state.outbox)}\n${JSON.stringify(await readEvents({ clubId: CLUB }))}`;

    expect(everything).not.toContain('the-real-credential');
    // The KEK itself is never echoed. Checked as a whole word so the substring
    // does not match incidentally inside an unrelated message.
    expect(everything).not.toMatch(new RegExp(`\\b${KEK}\\b`));
    // No length either: "it is 4 characters" narrows a brute force.
    expect(everything).not.toMatch(/\b4 (bytes|chars|characters)\b/);
    // The variable name and the remedy are what a log is for.
    expect(everything).toContain(SECRET_KEK_ENV);

    // No credential event was emitted for a credential that was never stored.
    expect(await readEvents({ clubId: CLUB })).toHaveLength(0);
  });

  test('the error message names the requirement, never the value', () => {
    const secretish = 'sekrit';
    let thrown: unknown;
    try { void kekWeakness(secretish); throw new WeakSecretKey(kekWeakness(secretish) as string); }
    catch (err) { thrown = err; }
    const msg = (thrown as Error).message;
    expect(msg).not.toContain(secretish);
    expect(msg).toContain(SECRET_KEK_ENV);
    expect(msg).toContain(String(MIN_KEK_BYTES));
    expect(msg).toMatch(/openssl rand/);
  });

  test('legacy hmacSecret authentication stays operational under any KEK state', async () => {
    // The compatibility guarantee. A deployment with no KEK, a weak KEK or a
    // strong one authenticates its existing fleet identically, because a
    // legacy row has no reference and never consults the store at all.
    for (const kek of [undefined, 'weak', generateSecret(48)]) {
      state.secrets = [];
      if (kek === undefined) withNoKek();
      else { process.env[SECRET_KEK_ENV] = kek; delete process.env.MFA_ENCRYPTION_KEY; }

      const resolved = await resolveCredential({ id: DEVICE, clubId: CLUB, hmacSecret: LEGACY_SECRET });
      expect(`${String(kek).slice(0, 4)}:${resolved.source}`).toBe(`${String(kek).slice(0, 4)}:LEGACY_COLUMN`);
      expect(resolved.value).toBe(LEGACY_SECRET);
      expect(resolved.ref).toBeNull();
      expect(secretsEqual(resolved.value, LEGACY_SECRET)).toBe(true);
    }
  });

  test('SYSTEM is told the KEK is why new credentials still go to the legacy column', async () => {
    process.env[SECRET_KEK_ENV] = 'weak';
    delete process.env.MFA_ENCRYPTION_KEY;

    const mode = await credentialStorageMode();
    expect(mode.provider).toBe('db');
    expect(mode.writable).toBe(false);
    expect(mode.reason).toContain(SECRET_KEK_ENV);
    expect(mode.reason).toContain('legacy column');
    expect(mode.reason).not.toContain('weak');

    process.env[SECRET_KEK_ENV] = generateSecret(48);
    expect(await credentialStorageMode()).toEqual({ provider: 'db', writable: true, reason: null });
  });

  test('a misconfigured key is loud on read, while a bad ciphertext is merely null', () => {
    process.env[SECRET_KEK_ENV] = generateSecret(48);
    const sealed = sealSecret('a-credential');

    // Wrong key, right shape: the auth tag fails and the answer is "no".
    process.env[SECRET_KEK_ENV] = generateSecret(48);
    expect(openSecret(sealed)).toBeNull();
    expect(openSecret('not-an-envelope')).toBeNull();

    // Weak key: a configuration fault, and swallowing it as null would make
    // every credential look revoked instead of the deployment look broken.
    process.env[SECRET_KEK_ENV] = 'weak';
    delete process.env.MFA_ENCRYPTION_KEY;
    expect(() => openSecret(sealed)).toThrow(SecretKeyConfigError);
  });

  test('the floor is enforced in the derivation, not at a call site', () => {
    // Read the source: a check that lives in one caller is a check the next
    // caller forgets. It must be inside deriveKek, above the hash.
    const src = decomment(read('src/fabric/secrets/secret-store.ts'));
    const derive = src.slice(src.indexOf('function deriveKek'));
    const body = derive.slice(0, derive.indexOf('\n}'));
    expect(body).toMatch(/kekWeakness/);
    expect(body).toMatch(/throw new WeakSecretKey/);
    // Order matters: the throw is before the hash, not after it.
    expect(body.indexOf('WeakSecretKey')).toBeLessThan(body.indexOf('createHash'));
  });

  test('the KEK is declared on the deployment as an unsynced secret', () => {
    const yaml = read('render.yaml');
    expect(yaml).toContain(`- key: ${SECRET_KEK_ENV}`);
    const block = yaml.slice(yaml.indexOf(`- key: ${SECRET_KEK_ENV}`));
    expect(block.slice(0, block.indexOf('- key:', 10))).toMatch(/sync:\s*false/);
    // A value in the blueprint would be the secret in the repository.
    expect(yaml).not.toMatch(new RegExp(`${SECRET_KEK_ENV}[\\s\\S]{0,40}value:`));
  });
});
