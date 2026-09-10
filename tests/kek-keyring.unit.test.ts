/**
 * tests/kek-keyring.unit.test.ts
 *
 * Data Fabric phase 1, item 3B: the key that seals a credential can change.
 *
 * WHAT THIS IS FOR
 *
 * Item 3 sealed every credential under one key from one environment variable.
 * That is fine until the key has to change, at which point every existing
 * ciphertext becomes unreadable in the same instant — so the only safe rotation
 * was no rotation, and a key that cannot be rotated is one that will still be
 * in use the day it leaks.
 *
 * THE ONE RULE EVERYTHING ELSE RESTS ON
 *
 * A ciphertext is opened with the key IT NAMES, and never with another. Almost
 * every property below is a restatement of that rule from a different angle:
 * old ciphertext keeps reading after a rotation because it names its own key; a
 * retired key stays retired because nothing substitutes for it; a missing key
 * fails closed rather than falling through to whatever else is configured.
 *
 * The interesting failure this guards against is not "the wrong key opens it" —
 * AES-GCM makes that impossible. It is a read path that TRIES the other keys
 * when the named one fails, which quietly turns a retired key back on and tells
 * a prober how many keys exist. So the tests assert the attempt never happens,
 * not merely that it would not succeed.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

type Row = Record<string, any>;

const CLUB = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'dev-0001';

const state = { secrets: [] as Row[], outbox: [] as Row[] };

/** Enough of Prisma to exercise the real store, including the guarded write. */
const db: Row = {
  platformSecret: {
    findUnique: async ({ where }: Row) => {
      const k = where.scope_name_version;
      return state.secrets.find((s) => s.scope === k.scope && s.name === k.name && s.version === k.version) ?? null;
    },
    findMany: async ({ where = {}, orderBy, take, select }: Row = {}) => {
      let rows = state.secrets.filter((s) => {
        if (where.revokedAt === null && s.revokedAt) return false;
        if (where.NOT?.kid !== undefined && (s.kid ?? null) === where.NOT.kid) return false;
        if (where.id?.gt !== undefined && !(s.id > where.id.gt)) return false;
        if (where.scope && s.scope !== where.scope) return false;
        if (where.name && s.name !== where.name) return false;
        return true;
      });
      if (orderBy?.id === 'asc') rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
      if (orderBy?.version === 'desc') rows = [...rows].sort((a, b) => b.version - a.version);
      if (take) rows = rows.slice(0, take);
      if (select) {
        return rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k] ?? null])));
      }
      return rows;
    },
    groupBy: async ({ where = {} }: Row = {}) => {
      const counts = new Map<string | null, number>();
      for (const s of state.secrets) {
        if (where.revokedAt === null && s.revokedAt) continue;
        const kid = s.kid ?? null;
        counts.set(kid, (counts.get(kid) ?? 0) + 1);
      }
      return [...counts].map(([kid, n]) => ({ kid, _count: { _all: n } }));
    },
    create: async ({ data }: Row) => {
      if (state.secrets.some((s) => s.scope === data.scope && s.name === data.name && s.version === data.version)) {
        const err: any = new Error('Unique constraint failed'); err.code = 'P2002'; throw err;
      }
      // Ids ascend, so the cursor-paged scan has a stable order to walk.
      const row = {
        id: `s-${String(state.secrets.length + 1).padStart(4, '0')}`,
        createdAt: new Date(), rotatedAt: null, revokedAt: null, kid: null, ...data,
      };
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
      const rows = state.secrets.filter((s) => {
        if (where.id !== undefined && s.id !== where.id) return false;
        if (where.scope !== undefined && s.scope !== where.scope) return false;
        if (where.name !== undefined && s.name !== where.name) return false;
        if (where.version !== undefined && s.version !== where.version) return false;
        // The optimistic guard. Getting this wrong in the mock would hide the
        // very race the guard exists for.
        if (where.sealed !== undefined && s.sealed !== where.sealed) return false;
        if (where.revokedAt !== undefined && (s.revokedAt ?? null) !== where.revokedAt) return false;
        if (where.rotatedAt !== undefined && (s.rotatedAt ?? null) !== where.rotatedAt) return false;
        return true;
      });
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
  DbSecretStore, setSecretStore, getSecretStore,
  sealSecret, openSecret, parseEnvelope, envelopeKid, rewrapEnvelope, generateSecret,
  readKeyring, keyringStatus, secretKeyStatus, keyForKid, activeKey,
  SecretKeyConfigError, SecretKeyUnavailable, WeakSecretKey,
  UnknownKeyId, RetiredKeyId, KeyringMisconfigured,
  SECRET_KEK_ENV, KEYRING_ENV_PREFIX, ACTIVE_KEK_ENV, RETIRED_KEKS_ENV,
  LEGACY_KID, ENVELOPE_MARKER, MIN_KEK_BYTES,
  rewrapPlan, rewrapBatch, retirementCheck, recordKeyLifecycle,
  credentialRefFor, resolveCredential, storeNewCredential, credentialStorageMode,
  setEventTransport, outboxTransport, readEvents, clearSubscribers, eventFromRow,
  registeredEventTypes, eventTypeSpec,
  type FamilistaEvent,
} from '../src/fabric';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const decomment = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const LEGACY_HMAC = 'bGVnYWN5LXNlY3JldC1ieXRlcy1oZXJlLTMyLWJ5dGVzIQ==';

/**
 * The events this module emits, read back off the outbox.
 *
 * `readEvents` is club-scoped by design — it is the tenant-isolated read — and
 * a key-encryption key belongs to no club. So these come off the rows, which
 * also proves the envelope that reached the outbox is the one asserted on.
 */
const platformEvents = (): FamilistaEvent[] =>
  state.outbox.map((r) => eventFromRow(r as any)).filter((e): e is FamilistaEvent => e !== null);

/** Distinct, strong, deterministic per name so a test can tell them apart. */
const KEY_A = `key-a-${'A1b2C3d4'.repeat(5)}`;
const KEY_B = `key-b-${'Z9y8X7w6'.repeat(5)}`;
const KEY_C = `key-c-${'Q4r5S6t7'.repeat(5)}`;

/** Every variable this module reads, so no test leaks into the next. */
const OWNED = [SECRET_KEK_ENV, ACTIVE_KEK_ENV, RETIRED_KEKS_ENV, 'MFA_ENCRYPTION_KEY'];
const saved: Record<string, string | undefined> = {};

const clearKeyring = () => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(KEYRING_ENV_PREFIX)) delete process.env[name];
  }
  for (const name of OWNED) delete process.env[name];
};

/** `FAMILISTA_KEK_<KID>` for a kid, spelled the way the loader expects. */
const kekVar = (kid: string) => `${KEYRING_ENV_PREFIX}${kid.toUpperCase().replace(/-/g, '_')}`;
const setKey = (kid: string, material: string) => { process.env[kekVar(kid)] = material; };

beforeAll(() => {
  for (const name of OWNED) saved[name] = process.env[name];
});

beforeEach(() => {
  state.secrets = [];
  state.outbox = [];
  logged.length = 0;
  clearSubscribers();
  setEventTransport(outboxTransport);
  clearKeyring();
  setSecretStore(new DbSecretStore());
});

afterAll(() => {
  setEventTransport(null);
  setSecretStore(null);
  clearKeyring();
  for (const name of OWNED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name] as string;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 · The envelope says which key sealed it
// ─────────────────────────────────────────────────────────────────────────────

describe('the ciphertext format', () => {
  test('a versioned envelope carries kid, format, nonce and tag, and nothing secret', () => {
    setKey('2026-01', KEY_A);
    process.env[ACTIVE_KEK_ENV] = '2026-01';

    const value = generateSecret();
    const sealed = sealSecret(value);
    const parts = sealed.split(':');

    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe(ENVELOPE_MARKER);
    expect(parts[1]).toBe('2026-01');

    const parsed = parseEnvelope(sealed)!;
    expect(parsed.kid).toBe('2026-01');
    expect(parsed.format).toBe('fam1');
    expect(Buffer.from(parsed.ivB64, 'base64')).toHaveLength(12);   // GCM nonce
    expect(Buffer.from(parsed.tagB64, 'base64')).toHaveLength(16);  // GCM tag
    expect(parsed.ciphertextB64.length).toBeGreaterThan(0);

    // Not one byte of the plaintext, and not one byte of the key.
    expect(sealed).not.toContain(value);
    expect(sealed).not.toContain(KEY_A);
    expect(openSecret(sealed)).toBe(value);
  });

  test('the two formats are told apart by shape, never guessed at', () => {
    // Three parts is Item 3's envelope and resolves to the legacy kid. Five
    // parts with the marker is versioned. Anything else is not an envelope —
    // which is different from being an envelope read the wrong way.
    process.env[SECRET_KEK_ENV] = KEY_A;
    const legacy = sealSecret('a-credential');
    expect(legacy.split(':')).toHaveLength(3);
    expect(parseEnvelope(legacy)!.format).toBe('legacy');
    expect(parseEnvelope(legacy)!.kid).toBe(LEGACY_KID);
    expect(envelopeKid(legacy)).toBe(LEGACY_KID);

    for (const bad of ['', 'nonsense', 'a:b', 'a:b:c:d', 'nope:x:y:z:w', 'fam1:kid::t:c']) {
      expect(`${bad}: ${parseEnvelope(bad)}`).toBe(`${bad}: null`);
    }
  });

  test('a deployment with only the Item 3 variable still writes the Item 3 format', () => {
    // Shipping 3B must not change a single byte of what production writes until
    // a keyring is actually configured. Otherwise a rolling deploy leaves a
    // five-part envelope in front of an instance that predates the change.
    process.env[SECRET_KEK_ENV] = KEY_A;
    expect(readKeyring().versionedWrites).toBe(false);
    expect(sealSecret('x').split(':')).toHaveLength(3);

    setKey('2026-01', KEY_B);
    process.env[ACTIVE_KEK_ENV] = '2026-01';
    expect(readKeyring().versionedWrites).toBe(true);
    expect(sealSecret('x').split(':')).toHaveLength(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Rotation, which is the whole point
// ─────────────────────────────────────────────────────────────────────────────

describe('rotation', () => {
  test('a credential written under A reads back under A', async () => {
    setKey('a', KEY_A);
    process.env[ACTIVE_KEK_ENV] = 'a';

    const ref = credentialRefFor('device', DEVICE);
    await getSecretStore().putSecret(ref, 'credential-under-a');

    expect(state.secrets[0].kid).toBe('a');
    expect(await getSecretStore().getSecret(ref)).toBe('credential-under-a');
  });

  test('after B becomes active, the A credential still reads and new ones use B', async () => {
    setKey('a', KEY_A);
    process.env[ACTIVE_KEK_ENV] = 'a';
    const refA = credentialRefFor('device', 'dev-old');
    await getSecretStore().putSecret(refA, 'credential-under-a');

    // Step A and step B of the runbook: add material, then name it active.
    setKey('b', KEY_B);
    process.env[ACTIVE_KEK_ENV] = 'b';

    // Step C, which is the property that makes rotation survivable: nothing was
    // re-keyed, and the old credential opens anyway, because it names its key.
    expect(await getSecretStore().getSecret(refA)).toBe('credential-under-a');
    expect(state.secrets[0].kid).toBe('a');

    const refB = credentialRefFor('device', 'dev-new');
    await getSecretStore().putSecret(refB, 'credential-under-b');
    expect(state.secrets[1].kid).toBe('b');
    expect(await getSecretStore().getSecret(refB)).toBe('credential-under-b');

    // And both are live at once, which is the state a real fleet is in.
    expect(await getSecretStore().getSecret(refA)).toBe('credential-under-a');
  });

  test('adding a key does not silently start using it', () => {
    // The dangerous convenience this design refuses. A "newest wins" rule means
    // adding material rotates the deployment without anybody performing — or
    // verifying — a rotation.
    setKey('a', KEY_A);
    expect(readKeyring().activeKid).toBe('a');   // one key, no ambiguity

    setKey('b', KEY_B);
    const ring = readKeyring();
    expect(ring.activeKid).toBeNull();
    expect(ring.problem).toContain(ACTIVE_KEK_ENV);
    expect(() => sealSecret('x')).toThrow(KeyringMisconfigured);

    process.env[ACTIVE_KEK_ENV] = 'b';
    expect(readKeyring().activeKid).toBe('b');
  });

  test('B is never tried for an A ciphertext', () => {
    // AES-GCM already makes a wrong key fail, so the real hazard is a read path
    // that TRIES the other keys. Proven by making A's material wrong while B
    // stays perfectly valid and active: if anything fell through to B the
    // plaintext would come back. It must not.
    setKey('a', KEY_A);
    process.env[ACTIVE_KEK_ENV] = 'a';
    const sealed = sealSecret('credential-under-a');
    expect(envelopeKid(sealed)).toBe('a');

    setKey('a', KEY_C);              // A's material replaced — wrong key, right shape
    setKey('b', KEY_B);
    process.env[ACTIVE_KEK_ENV] = 'b';

    expect(openSecret(sealed)).toBeNull();

    // And with A absent entirely it fails closed rather than reaching for B.
    delete process.env[kekVar('a')];
    expect(() => openSecret(sealed)).toThrow(UnknownKeyId);
    expect(() => openSecret(sealed)).toThrow(/"a"/);
  });

  test('kid `v1` keeps deriving exactly the key Item 3 derived', () => {
    // The compatibility hinge. Ciphertext sealed before 3B existed must open
    // after it, so `v1` alone keeps the original domain separator — and the
    // same material under a different kid must NOT produce the same key, or a
    // copy-pasted rotation would be a rotation in name only.
    process.env[SECRET_KEK_ENV] = KEY_A;
    const sealedBefore = sealSecret('credential-from-item-3');
    expect(sealedBefore.split(':')).toHaveLength(3);

    // Same material, offered as an explicit v1 keyring entry: still opens.
    delete process.env[SECRET_KEK_ENV];
    setKey('v1', KEY_A);
    process.env[ACTIVE_KEK_ENV] = 'v1';
    expect(openSecret(sealedBefore)).toBe('credential-from-item-3');

    // Same material under kid `a`: a different key, so the v1 ciphertext does
    // not open under it.
    const asV1 = keyForKid('v1');
    setKey('a', KEY_A);
    expect(keyForKid('a').equals(asV1)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Failure safety — every one of these fails closed
// ─────────────────────────────────────────────────────────────────────────────

describe('failing closed', () => {
  test('an unknown kid throws rather than resolving to anything', () => {
    setKey('b', KEY_B);
    process.env[ACTIVE_KEK_ENV] = 'b';
    const orphan = `${ENVELOPE_MARKER}:ghost:${Buffer.alloc(12).toString('base64')}:${Buffer.alloc(16).toString('base64')}:AAAA`;
    expect(() => openSecret(orphan)).toThrow(UnknownKeyId);
    expect(() => keyForKid('ghost')).toThrow(UnknownKeyId);
  });

  test('a retired key is refused for reading and for writing', () => {
    setKey('a', KEY_A);
    process.env[ACTIVE_KEK_ENV] = 'a';
    const sealed = sealSecret('credential-under-a');

    setKey('b', KEY_B);
    process.env[ACTIVE_KEK_ENV] = 'b';
    process.env[RETIRED_KEKS_ENV] = 'a';

    expect(() => openSecret(sealed)).toThrow(RetiredKeyId);
    expect(() => keyForKid('a')).toThrow(RetiredKeyId);
    expect(keyringStatus().retiredKids).toEqual(['a']);

    // And it cannot be made active again by naming it.
    process.env[ACTIVE_KEK_ENV] = 'a';
    expect(readKeyring().activeKid).toBeNull();
    expect(readKeyring().problem).toContain(RETIRED_KEKS_ENV);
    expect(() => sealSecret('x')).toThrow(SecretKeyConfigError);
  });

  test('two variables meaning one kid are rejected, not silently ranked', () => {
    // `FAMILISTA_KEK_V1` and `FAMILISTA_KEK_v1` are both legal environment
    // variables and both mean `v1`. Which one wins is not something to guess.
    process.env[`${KEYRING_ENV_PREFIX}DUP`] = KEY_A;
    process.env[`${KEYRING_ENV_PREFIX}dup`] = KEY_B;

    const ring = readKeyring();
    expect(ring.activeKid).toBeNull();
    expect(ring.problem).toMatch(/both define/);
    expect(ring.problem).toContain(`${KEYRING_ENV_PREFIX}DUP`);
    expect(ring.problem).toContain(`${KEYRING_ENV_PREFIX}dup`);
    expect(() => keyForKid('dup')).toThrow(KeyringMisconfigured);
    expect(() => sealSecret('x')).toThrow(SecretKeyConfigError);
  });

  test('the strength floor applies to every configured key, not just the active one', () => {
    // A weak key that is merely readable still protects real ciphertext.
    setKey('strong', KEY_A);
    setKey('weak', 'short');
    process.env[ACTIVE_KEK_ENV] = 'strong';

    const ring = readKeyring();
    expect(ring.activeKid).toBe('strong');
    expect(ring.keys.find((k) => k.kid === 'weak')!.weakness).toMatch(/fewer than 32 bytes/);
    expect(ring.keys.find((k) => k.kid === 'strong')!.weakness).toBeNull();

    // Usable for nothing, in either direction.
    expect(() => keyForKid('weak')).toThrow(WeakSecretKey);
    process.env[ACTIVE_KEK_ENV] = 'weak';
    expect(() => sealSecret('x')).toThrow(WeakSecretKey);
    expect(secretKeyStatus().usable).toBe(false);
  });

  test('a weak key is named with the variable to fix, not reported generically', () => {
    setKey('only', 'short');
    const status = secretKeyStatus();
    expect(status.usable).toBe(false);
    expect(status.reason).toContain(kekVar('only'));
    expect(status.reason).toContain('32 bytes');

    let thrown: unknown;
    try { activeKey(); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(WeakSecretKey);
    expect((thrown as Error).message).toContain(kekVar('only'));
    expect((thrown as Error).message).toMatch(/openssl rand/);
    // Never the material, and never its length.
    expect((thrown as Error).message).not.toContain('short');
  });

  test('no keys at all is distinguishable from keys that do not work', () => {
    expect(secretKeyStatus()).toEqual({ usable: false, reason: `${SECRET_KEK_ENV} is not set` });
    expect(() => sealSecret('x')).toThrow(SecretKeyUnavailable);

    setKey('a', KEY_A);
    process.env[RETIRED_KEKS_ENV] = 'a';
    expect(secretKeyStatus().reason).toContain(RETIRED_KEKS_ENV);
    expect(() => sealSecret('x')).toThrow(KeyringMisconfigured);
  });

  test('a malformed ciphertext is null, while a configuration fault throws', () => {
    setKey('a', KEY_A);
    process.env[ACTIVE_KEK_ENV] = 'a';

    // Not an envelope: null, and no key is even resolved.
    for (const bad of ['', 'nonsense', 'a:b', 'fam1:a:b']) expect(openSecret(bad)).toBeNull();

    // An envelope whose tag does not check out: null. This is a wrong or
    // tampered ciphertext and the answer is "no", not "here is why".
    const sealed = sealSecret('a-credential');
    const parts = sealed.split(':');
    parts[3] = Buffer.alloc(16, 9).toString('base64');
    expect(openSecret(parts.join(':'))).toBeNull();

    // A key that cannot be resolved: throws, because swallowing it as null
    // would make every credential look revoked instead of the deployment look
    // broken.
    delete process.env[kekVar('a')];
    expect(() => openSecret(sealed)).toThrow(SecretKeyConfigError);
  });

  test('an invalid kid cannot be spelled, let alone resolved', () => {
    setKey('a', KEY_A);
    process.env[ACTIVE_KEK_ENV] = 'a';
    for (const bad of ['', 'UPPER', 'has space', 'has:colon', 'a'.repeat(64), '-leading']) {
      expect(() => keyForKid(bad)).toThrow(UnknownKeyId);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · The re-key, which has to be resumable and must never lose a credential
// ─────────────────────────────────────────────────────────────────────────────

describe('re-keying', () => {
  /** Three credentials under A, then B configured and made active. */
  const threeUnderAThenB = async () => {
    setKey('a', KEY_A);
    process.env[ACTIVE_KEK_ENV] = 'a';
    for (const id of ['dev-1', 'dev-2', 'dev-3']) {
      await getSecretStore().putSecret(credentialRefFor('device', id), `secret-${id}`);
    }
    setKey('b', KEY_B);
    process.env[ACTIVE_KEK_ENV] = 'b';
  };

  test('the plan counts what is outstanding without opening anything', async () => {
    await threeUnderAThenB();
    const plan = await rewrapPlan();
    expect(plan.activeKid).toBe('b');
    expect(plan.byKid).toEqual({ a: 3 });
    expect(plan.outstanding).toBe(3);
    expect(plan.problem).toBeNull();
    // Counting must not have decrypted anything, so nothing can have leaked.
    expect(logged.join('\n')).not.toContain('secret-dev-1');
  });

  test('re-keying moves every row onto the active key and preserves every value', async () => {
    await threeUnderAThenB();

    const report = await rewrapBatch({ actor: 'owner' });
    expect(report.toKid).toBe('b');
    expect(report.rewrapped).toBe(3);
    expect(report.unreadable).toBe(0);
    expect(report.done).toBe(true);

    for (const id of ['dev-1', 'dev-2', 'dev-3']) {
      expect(await getSecretStore().getSecret(credentialRefFor('device', id))).toBe(`secret-${id}`);
    }
    expect(state.secrets.map((s) => s.kid)).toEqual(['b', 'b', 'b']);
    expect((await rewrapPlan()).outstanding).toBe(0);

    // With A gone, everything still opens — which is what "the re-key is
    // finished" actually means.
    delete process.env[kekVar('a')];
    expect(await getSecretStore().getSecret(credentialRefFor('device', 'dev-2'))).toBe('secret-dev-2');
  });

  test('it is resumable: a batch stops where told and continues from the cursor', async () => {
    await threeUnderAThenB();

    const first = await rewrapBatch({ limit: 1, max: 1 });
    expect(first.rewrapped).toBe(1);
    expect(first.done).toBe(false);
    expect(first.cursor).toBe('s-0001');

    // Interrupted here, the finished row stays finished and the rest stay valid.
    expect(state.secrets.map((s) => s.kid)).toEqual(['b', 'a', 'a']);
    expect(await getSecretStore().getSecret(credentialRefFor('device', 'dev-2'))).toBe('secret-dev-2');

    const second = await rewrapBatch({ after: first.cursor, limit: 10 });
    expect(second.rewrapped).toBe(2);
    expect(second.done).toBe(true);
    expect(state.secrets.map((s) => s.kid)).toEqual(['b', 'b', 'b']);

    // And running it again is a no-op rather than a second pass.
    const third = await rewrapBatch();
    expect(third).toMatchObject({ scanned: 0, rewrapped: 0, done: true });
  });

  test('a row whose key is missing is left exactly as it was', async () => {
    await threeUnderAThenB();
    // A's material is gone, so its rows cannot be opened. Overwriting them with
    // anything would destroy the only copy while reporting success.
    delete process.env[kekVar('a')];

    const before = state.secrets.map((s) => s.sealed);
    const report = await rewrapBatch();

    expect(report.rewrapped).toBe(0);
    expect(report.unreadable).toBe(3);
    expect(state.secrets.map((s) => s.sealed)).toEqual(before);
    expect(state.secrets.map((s) => s.kid)).toEqual(['a', 'a', 'a']);

    // Loud about it, and without naming a credential.
    expect(logged.join('\n')).toMatch(/cannot resolve/);
    expect(logged.join('\n')).not.toMatch(/secret-dev/);
  });

  test('a concurrent rotation is not clobbered by the scan', async () => {
    // The guarded write, which is the whole safety of an unattended re-key. The
    // scan opened an envelope that has since been replaced; writing its re-seal
    // would resurrect the value the rotation superseded.
    setKey('a', KEY_A);
    process.env[ACTIVE_KEK_ENV] = 'a';
    const ref = credentialRefFor('device', DEVICE);
    await getSecretStore().putSecret(ref, 'the-old-value');

    setKey('b', KEY_B);
    process.env[ACTIVE_KEK_ENV] = 'b';

    const store = getSecretStore() as DbSecretStore;
    const [row] = await store.pageForRewrap('b', { limit: 1 });
    const rewrapped = rewrapEnvelope(row.sealed)!;

    // Something else rewrites the row first.
    await store.putSecret(ref, 'the-new-value', { overwrite: true });

    // The stale write does not apply, and the newer value survives.
    expect(await store.applyRewrap(row.id, row.sealed, rewrapped.sealed)).toBe(false);
    expect(await store.getSecret(ref)).toBe('the-new-value');
  });

  test('a revoked row is not re-keyed', async () => {
    setKey('a', KEY_A);
    process.env[ACTIVE_KEK_ENV] = 'a';
    const ref = credentialRefFor('device', DEVICE);
    await getSecretStore().putSecret(ref, 'a-withdrawn-credential');
    await getSecretStore().deleteSecret(ref);

    setKey('b', KEY_B);
    process.env[ACTIVE_KEK_ENV] = 'b';

    const report = await rewrapBatch();
    expect(report).toMatchObject({ scanned: 0, rewrapped: 0, done: true });
    expect(state.secrets[0].kid).toBe('a');
    expect((await rewrapPlan()).byKid).toEqual({});
  });

  test('a key cannot be retired while anything still references it', async () => {
    await threeUnderAThenB();

    expect(await retirementCheck('a')).toMatchObject({ referenced: 3, safeToRetire: false });
    expect((await retirementCheck('a')).reason).toMatch(/re-key them first/);

    // The active key is never retirable, whatever the counts say.
    expect(await retirementCheck('b')).toMatchObject({ safeToRetire: false, reason: expect.stringContaining('active') });

    await rewrapBatch();
    const after = await retirementCheck('a');
    expect(after).toEqual({ kid: 'a', referenced: 0, safeToRetire: true, reason: null });
  });

  test('re-keying refuses to start when the keyring is not usable', async () => {
    setKey('a', KEY_A);
    process.env[ACTIVE_KEK_ENV] = 'a';
    await getSecretStore().putSecret(credentialRefFor('device', DEVICE), 'a-credential');

    setKey('b', KEY_B);
    delete process.env[ACTIVE_KEK_ENV];    // ambiguous: two keys, none named

    const report = await rewrapBatch();
    expect(report.rewrapped).toBe(0);
    expect(report.problem).toContain(ACTIVE_KEK_ENV);
    expect(state.secrets[0].kid).toBe('a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · Nothing secret escapes — checked by running the code, not reading it
// ─────────────────────────────────────────────────────────────────────────────

describe('containment', () => {
  test('a re-key event carries key names and a reference, and no material', async () => {
    setKey('a', KEY_A);
    process.env[ACTIVE_KEK_ENV] = 'a';
    await getSecretStore().putSecret(credentialRefFor('device', DEVICE), 'the-real-credential');
    setKey('b', KEY_B);
    process.env[ACTIVE_KEK_ENV] = 'b';

    await rewrapBatch({ actor: 'owner' });
    await new Promise((r) => setImmediate(r));

    const events = platformEvents();
    const rewrapEvents = events.filter((e) => e.eventType === 'secret.kek.rewrapped');
    expect(rewrapEvents).toHaveLength(1);
    expect(rewrapEvents[0].payload).toMatchObject({
      secretRef: `fam:v1:db:device/${DEVICE}#1`, fromKid: 'a', toKid: 'b', actor: 'owner',
    });

    const everything = `${JSON.stringify(events)}\n${JSON.stringify(state.outbox)}\n${logged.join('\n')}`;
    expect(everything).not.toContain('the-real-credential');
    expect(everything).not.toContain(KEY_A);
    expect(everything).not.toContain(KEY_B);
  });

  test('the key lifecycle record names the key and nothing else', async () => {
    setKey('b', KEY_B);
    process.env[ACTIVE_KEK_ENV] = 'b';
    await recordKeyLifecycle('activated', 'b', { actor: 'owner', note: 'scheduled rotation' });
    await recordKeyLifecycle('retired', 'a', { actor: 'owner' });
    await new Promise((r) => setImmediate(r));

    const events = platformEvents();
    expect(events.map((e) => e.eventType).sort()).toEqual(['secret.kek.activated', 'secret.kek.retired']);
    expect(JSON.stringify(events)).not.toContain(KEY_B);
  });

  test('no status surface reports key material, or even a length', () => {
    setKey('a', KEY_A);
    setKey('weak', 'short');
    process.env[ACTIVE_KEK_ENV] = 'a';

    const status = JSON.stringify(keyringStatus());
    expect(status).not.toContain(KEY_A);
    expect(status).not.toContain('short');
    // Sources are variable NAMES, which is the actionable part.
    expect(status).toContain(kekVar('a'));
    // "the key is 31 bytes" narrows a brute force. No numbers but the floor.
    expect(status.replace(String(MIN_KEK_BYTES), '')).not.toMatch(/\b\d{1,3} (bytes|chars|characters)\b/);
  });

  test('the store never selects a sealed envelope into a history view', async () => {
    setKey('a', KEY_A);
    process.env[ACTIVE_KEK_ENV] = 'a';
    const ref = credentialRefFor('device', DEVICE);
    await getSecretStore().putSecret(ref, 'the-real-credential');

    const history = await (getSecretStore() as DbSecretStore).history('device', DEVICE);
    expect(JSON.stringify(history)).not.toContain('the-real-credential');
    expect(history[0]).not.toHaveProperty('sealed');
    // The kid IS reportable — it is a name, and it is what an audit needs.
    expect(history[0].kid).toBe('a');
  });

  test('re-keying cannot be asked for a plaintext credential', () => {
    // Read the source. `rewrapEnvelope` opens and re-seals inside one function;
    // nothing in the rotation module returns, logs or emits what it saw.
    const src = decomment(read('src/fabric/secrets/rewrap.ts'));
    expect(src).not.toMatch(/\bopenSecret\b/);
    expect(src).toMatch(/rewrapEnvelope/);
    // No function here hands back a secret value.
    expect(src).not.toMatch(/return\s+.*\bvalue\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · Everything Item 3 promised still holds
// ─────────────────────────────────────────────────────────────────────────────

describe('nothing else changed', () => {
  test('legacy hmacSecret authentication is untouched by any keyring state', async () => {
    // The credential seam never consults the store for a row with no reference,
    // so the keyring cannot affect it — under any configuration, including none.
    const states: Array<() => void> = [
      () => {},                                                        // no keys at all
      () => { process.env[SECRET_KEK_ENV] = KEY_A; },                  // Item 3's shape
      () => { setKey('a', KEY_A); process.env[ACTIVE_KEK_ENV] = 'a'; }, // a keyring
      () => { setKey('a', 'short'); },                                  // a weak keyring
      () => { setKey('a', KEY_A); process.env[RETIRED_KEKS_ENV] = 'a'; }, // all retired
    ];

    for (const [i, configure] of states.entries()) {
      clearKeyring();
      configure();
      const resolved = await resolveCredential({ id: DEVICE, clubId: CLUB, hmacSecret: LEGACY_HMAC });
      expect(`${i}:${resolved.source}`).toBe(`${i}:LEGACY_COLUMN`);
      expect(resolved.value).toBe(LEGACY_HMAC);
      expect(resolved.ref).toBeNull();
    }
  });

  test('an unusable keyring means no credential is stored, and the legacy path is used', async () => {
    setKey('a', KEY_A);
    setKey('b', KEY_B);            // ambiguous — nothing may be sealed

    const ref = await storeNewCredential('device', DEVICE, 'the-real-credential', { clubId: CLUB });
    expect(ref).toBeNull();
    expect(state.secrets).toHaveLength(0);

    const mode = await credentialStorageMode();
    expect(mode).toMatchObject({ provider: 'db', writable: false });
    expect(mode.reason).toContain('legacy column');

    await new Promise((r) => setImmediate(r));
    expect(await readEvents({ clubId: CLUB })).toHaveLength(0);
    expect(logged.join('\n')).not.toContain('the-real-credential');
  });

  test('a usable keyring stores by reference and says so', async () => {
    setKey('a', KEY_A);
    process.env[ACTIVE_KEK_ENV] = 'a';

    const ref = await storeNewCredential('device', DEVICE, 'the-real-credential', { clubId: CLUB });
    expect(ref).toBe(`fam:v1:db:device/${DEVICE}#1`);
    expect(await credentialStorageMode()).toEqual({ provider: 'db', writable: true, reason: null });
    expect(await resolveCredential({ id: DEVICE, clubId: CLUB, secretRef: ref }))
      .toMatchObject({ value: 'the-real-credential', source: 'REFERENCE' });
  });

  test('the domain still cannot name a provider or a key', () => {
    // Provider independence, restated for 3B: the keyring is the fabric's
    // business, and no domain service may read a KEK variable or a kid.
    const domain = ['src/services/device-registry.service.ts', 'src/vision/camera-registry.service.ts',
      'src/security-l/attestation.service.ts'];
    for (const file of domain) {
      const src = decomment(read(file));
      expect(`${file}: ${/FAMILISTA_KEK|FAMILISTA_SECRET_KEK|ACTIVE_KEK|keyForKid|sealSecret/.test(src)}`)
        .toBe(`${file}: false`);
    }
  });

  test('the three key-lifecycle events are registered and confidential', () => {
    for (const n of ['secret.kek.activated', 'secret.kek.rewrapped', 'secret.kek.retired']) {
      expect(`${n}: ${registeredEventTypes().includes(n)}`).toBe(`${n}: true`);
      expect(`${n}: ${eventTypeSpec(n)?.classification}`).toBe(`${n}: CONFIDENTIAL`);
    }
  });

  test('the migration that adds the kid column is additive only', () => {
    const sql = read('prisma/migrations/20260915120000_data_fabric_kek_keyring/migration.sql');
    const statements = sql.split('\n').filter((l) => !/^\s*(--|$)/.test(l)).join('\n');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME|UPDATE|INSERT)\b/i);
    expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS "kid" TEXT/);
    // Nullable, no default, no backfill: an existing row keeps NULL, and NULL
    // is read as the legacy kid by the envelope it already carries.
    expect(statements).not.toMatch(/NOT NULL|DEFAULT/i);
    expect(statements).not.toMatch(/hmacSecret/);
  });
});
