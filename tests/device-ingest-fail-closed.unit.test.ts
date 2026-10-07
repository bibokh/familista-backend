// Familista — device and camera ingest fail closed.
//
// Five signed paths verify a device or a camera through the credential seam
// (src/fabric/secrets/device-credentials.ts). Until this change every one of
// them checked the signature against `credential.value ?? ''` whenever the
// credential did not resolve: an empty HMAC key, which anyone can compute for
// any device id. Each refusal test below signs with exactly that empty key, as
// an attacker would, and proves the path refuses — when the secret store
// cannot answer, when the secret was revoked, and when the row holds no
// credential at all — and writes nothing. The device-session handshake keeps
// its key on the session row and already refused a missing one; it now also
// refuses a key that decodes to nothing. The replay tests prove a captured
// frame, activation, attestation or handshake cannot be sent a second time.

import fs from 'fs';
import path from 'path';
import { createHash, createHmac, randomBytes } from 'crypto';

jest.mock('../src/config/database', () => ({
  prisma: {
    camera: { findUnique: jest.fn(), update: jest.fn() },
    visionFrame: { create: jest.fn() },
    eventCameraStream: { findUnique: jest.fn(), update: jest.fn() },
    visionEventBatch: { create: jest.fn() },
    device: { findUnique: jest.fn(), update: jest.fn() },
    biomechanicalPacket: { create: jest.fn() },
    deviceAttestation: { findFirst: jest.fn(), create: jest.fn() },
    deviceTrustAnchor: { findFirst: jest.fn(), updateMany: jest.fn() },
    deviceSession: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}));
// Nonces are remembered in process memory, as they are wherever Redis is not
// configured; the Redis path is the same check made atomic.
jest.mock('../src/infra/redis', () => ({
  redisConfigured: () => false,
  getRedis: () => null,
  rkey: (...parts: string[]) => parts.join(':'),
  whenReady: async () => undefined,
}));
jest.mock('../src/security/security-event.service', () => ({ logDeviceSecurityEvent: jest.fn() }));
jest.mock('../src/security/audit-chain.service', () => ({ appendAuditEventAsync: jest.fn() }));
jest.mock('../src/big-data/publisher', () => ({ publishCustom: jest.fn() }));
jest.mock('../src/fabric/producers/devices.producer', () => ({
  publishDeviceRegistered: jest.fn(),
  publishCameraStreamStarted: jest.fn(),
  publishCameraStreamEnded: jest.fn(),
}));

import { prisma } from '../src/config/database';
import { logDeviceSecurityEvent } from '../src/security/security-event.service';
import { ForbiddenError, UnauthorizedError } from '../src/utils/errors';
import { MemorySecretStore, setSecretStore, type SecretStore } from '../src/fabric/secrets/secret-store';
import { formatSecretRef } from '../src/fabric/secrets/secret-ref';
import { credentialRefFor, signingKeyOf, verifyDeviceHmac } from '../src/fabric/secrets/device-credentials';
import { verifyCameraHmac } from '../src/vision/camera-registry.service';
import { activateDevice, verifyHmac } from '../src/services/device-registry.service';
import { ingestVisionFrame } from '../src/vision/vision-ingest.service';
import { ingestEventBatch } from '../src/vision/event-stream.service';
import { ingestBiomechPacket } from '../src/vision/biomechanical-ingest.service';
import { recordAttestation } from '../src/security-l/attestation.service';
import { issueDeviceToken } from '../src/services/device-auth.service';

type Row = Record<string, any>;
const db = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock };

const CLUB = 'club-0001';
const CAMERA = 'camera-0001';
const DEVICE = 'device-0001';
/** The real credential: 32 random bytes, as registration mints them. */
const KEY = randomBytes(32).toString('base64');

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (keyB64: string, msg: string) => createHmac('sha256', Buffer.from(keyB64, 'base64')).update(msg).digest('base64');
const withKey = (msg: string) => hmac(KEY, msg);
/** The signature anyone can make for any device: an HMAC under an empty key. */
const emptyKeyHmac = (msg: string) => createHmac('sha256', Buffer.alloc(0)).update(msg).digest('base64');

let seq = 0;
const nonce = () => `nonce-${Date.now()}-${(seq += 1)}`;

const events = (): Row[] => (logDeviceSecurityEvent as jest.Mock).mock.calls.map(([e]) => e as Row);
const reasons = (): string[] => events().map((e) => `${e.kind}:${e.payload?.reason ?? ''}`);

// ── credentials, through the real seam and a real in-memory store ────────────
type Credential = 'resolves' | 'legacy-column' | 'store-unavailable' | 'revoked' | 'none';
const RESOLVABLE: Credential[] = ['resolves', 'legacy-column'];
const UNRESOLVABLE: Credential[] = ['store-unavailable', 'revoked', 'none'];

let store: MemorySecretStore;
const unavailableStore = {
  provider: 'memory',
  getSecret: async () => { throw new Error('secret store unavailable'); },
  putSecret: async () => undefined,
  deleteSecret: async () => undefined,
} as unknown as SecretStore;

async function bearer(scope: 'camera' | 'device', id: string, credential: Credential): Promise<Row> {
  const ref = credentialRefFor(scope, id);
  switch (credential) {
    case 'resolves':
      await store.putSecret(ref, KEY, { overwrite: true });
      return { secretRef: formatSecretRef(ref), hmacSecret: null };
    case 'legacy-column':
      return { secretRef: null, hmacSecret: KEY };
    case 'revoked':
      await store.deleteSecret(ref);
      return { secretRef: formatSecretRef(ref), hmacSecret: null };
    case 'store-unavailable':
      setSecretStore(unavailableStore);
      return { secretRef: formatSecretRef(ref), hmacSecret: null };
    case 'none':
      return { secretRef: null, hmacSecret: null };
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  store = new MemorySecretStore();
  setSecretStore(store);
  db.$transaction.mockImplementation(async (ops: unknown[]) => ops);
});

afterAll(() => setSecretStore(null));

// ─────────────────────────────────────────────────────────────────────────────
describe('the credential seam: no key, no verification', () => {
  it('a credential that did not resolve has no signing key', () => {
    expect(signingKeyOf({ value: null, source: 'REFERENCE', ref: 'ref' })).toBeNull();
    expect(signingKeyOf({ value: null, source: 'NONE', ref: null })).toBeNull();
    expect(signingKeyOf({ value: '', source: 'LEGACY_COLUMN', ref: null })).toBeNull();
    expect(signingKeyOf({ value: '   ', source: 'LEGACY_COLUMN', ref: null })).toBeNull();
    expect(signingKeyOf({ value: '====', source: 'LEGACY_COLUMN', ref: null })).toBeNull();
    expect(signingKeyOf(null)).toBeNull();
    expect(signingKeyOf({ value: KEY, source: 'REFERENCE', ref: 'ref' })).toBe(KEY);
  });

  it('every verifier refuses an empty key, even for a signature made with one', () => {
    const msg = '1700000000000000.nonce.digest';
    const forged = emptyKeyHmac(msg);
    for (const verify of [verifyDeviceHmac, verifyCameraHmac, verifyHmac]) {
      expect(verify('', msg, forged)).toBe(false);
      expect(verify('====', msg, forged)).toBe(false);
      expect(verify(KEY, msg, forged)).toBe(false);
      expect(verify(KEY, msg, withKey(msg))).toBe(true);
    }
    expect(verifyDeviceHmac(null, msg, forged)).toBe(false);
    expect(verifyDeviceHmac(undefined, msg, forged)).toBe(false);
  });

  it('no ingest path falls back to an empty key, and each asks the seam for the key', () => {
    const files = [
      'src/vision/vision-ingest.service.ts',
      'src/vision/event-stream.service.ts',
      'src/vision/biomechanical-ingest.service.ts',
      'src/services/device-registry.service.ts',
      'src/security-l/attestation.service.ts',
    ];
    for (const file of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      expect({ file, emptyKeyFallback: /credential\.value\s*\?\?\s*''/.test(src) }).toEqual({ file, emptyKeyFallback: false });
      expect({ file, asksTheSeam: /signingKeyOf\(await resolveCredential\(/.test(src) }).toEqual({ file, asksTheSeam: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('camera frame ingest — POST /vision/cameras/:id/frame', () => {
  const detections = [{ trackId: 7, x: 0.41, y: 0.62 }];
  const frame = (sign: (msg: string) => string, over: { cameraTsUs?: number; nonce?: string } = {}) => {
    const cameraTsUs = over.cameraTsUs ?? Date.now() * 1000;
    const n = over.nonce ?? nonce();
    return { cameraTsUs, detections, nonce: n, sigB64: sign(`${cameraTsUs}.${n}.${sha256(JSON.stringify(detections))}`) };
  };
  const camera = async (credential: Credential) => {
    const row = { id: CAMERA, clubId: CLUB, status: 'ACTIVE', ...(await bearer('camera', CAMERA, credential)) };
    db.camera.findUnique.mockResolvedValue(row);
    db.camera.update.mockReturnValue(row);
    db.visionFrame.create.mockReturnValue({ id: 'frame-1', monotonicMs: BigInt(1), cameraTsUs: BigInt(1), kind: 'RGB' });
  };

  it.each(RESOLVABLE)('accepts a frame signed with the camera key (credential %s)', async (credential) => {
    await camera(credential);
    await expect(ingestVisionFrame(CAMERA, frame(withKey) as never)).resolves.toMatchObject({ id: 'frame-1' });
    expect(db.visionFrame.create).toHaveBeenCalledTimes(1);
  });

  it.each(UNRESOLVABLE)('refuses an empty-key signature when the credential is %s, and writes nothing', async (credential) => {
    await camera(credential);
    await expect(ingestVisionFrame(CAMERA, frame(emptyKeyHmac) as never)).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.visionFrame.create).not.toHaveBeenCalled();
    expect(reasons()).toContain('DEVICE_REJECTED:credential_unresolved');
  });

  it('refuses a replayed frame: one nonce, one frame', async () => {
    await camera('resolves');
    const captured = frame(withKey);
    await ingestVisionFrame(CAMERA, captured as never);
    await expect(ingestVisionFrame(CAMERA, captured as never)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(db.visionFrame.create).toHaveBeenCalledTimes(1);
    expect(reasons()).toContain('DEVICE_REPLAY:nonce_reused');
  });

  it('refuses a frame whose signed clock is outside the five-minute window', async () => {
    await camera('resolves');
    const stale = frame(withKey, { cameraTsUs: (Date.now() - 10 * 60_000) * 1000 });
    await expect(ingestVisionFrame(CAMERA, stale as never)).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.visionFrame.create).not.toHaveBeenCalled();
    expect(events().map((e) => e.kind)).toContain('DEVICE_TS_SKEW');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('neuromorphic camera event stream', () => {
  const payload = { events: [{ x: 12, y: 30, t: 1, p: 1 }] };
  const batch = (sign: (msg: string) => string, over: { nonce?: string } = {}) => {
    const cameraTsUs = Date.now() * 1000;
    const n = over.nonce ?? nonce();
    return { cameraTsUs, payload, nonce: n, sigB64: sign(`${cameraTsUs}.${n}.${sha256(JSON.stringify(payload))}`) };
  };
  const stream = async (credential: Credential) => {
    db.eventCameraStream.findUnique.mockResolvedValue({ id: 'stream-1', cameraId: CAMERA, clubId: CLUB, status: 'ACTIVE', matchId: null });
    db.camera.findUnique.mockResolvedValue({ id: CAMERA, clubId: CLUB, status: 'ACTIVE', ...(await bearer('camera', CAMERA, credential)) });
    db.visionEventBatch.create.mockReturnValue({ id: 'batch-1' });
    db.eventCameraStream.update.mockReturnValue({});
  };

  it('accepts a batch signed with the camera key', async () => {
    await stream('resolves');
    await expect(ingestEventBatch('stream-1', batch(withKey) as never)).resolves.toMatchObject({ id: 'batch-1' });
  });

  it.each(UNRESOLVABLE)('refuses an empty-key signature when the credential is %s, and writes nothing', async (credential) => {
    await stream(credential);
    await expect(ingestEventBatch('stream-1', batch(emptyKeyHmac) as never)).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.visionEventBatch.create).not.toHaveBeenCalled();
    expect(reasons()).toContain('DEVICE_REJECTED:credential_unresolved');
  });

  it('refuses a replayed batch', async () => {
    await stream('resolves');
    const captured = batch(withKey);
    await ingestEventBatch('stream-1', captured as never);
    await expect(ingestEventBatch('stream-1', captured as never)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(db.visionEventBatch.create).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('biomechanical packets', () => {
  const actor = { userId: 'user-1', clubId: CLUB, role: 'ANALYST' };
  const packet = (sign: (msg: string) => string, over: { nonce?: string } = {}) => {
    const body = { deviceTsMs: Date.now(), lactateMmol: 2.1 };
    const n = over.nonce ?? nonce();
    return { payload: body, nonce: n, sigB64: sign(`${body.deviceTsMs}.${n}.${sha256(JSON.stringify(body))}`) };
  };
  const device = async (credential: Credential) => {
    db.device.findUnique.mockResolvedValue({ id: DEVICE, clubId: CLUB, status: 'ACTIVE', ...(await bearer('device', DEVICE, credential)) });
    db.biomechanicalPacket.create.mockResolvedValue({ id: 'packet-1' });
  };

  it('accepts a packet signed with the device key', async () => {
    await device('resolves');
    await expect(ingestBiomechPacket(actor, DEVICE, packet(withKey) as never)).resolves.toMatchObject({ id: 'packet-1' });
  });

  it.each(UNRESOLVABLE)('refuses an empty-key signature when the credential is %s, and writes nothing', async (credential) => {
    await device(credential);
    await expect(ingestBiomechPacket(actor, DEVICE, packet(emptyKeyHmac) as never)).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.biomechanicalPacket.create).not.toHaveBeenCalled();
    expect(reasons()).toContain('DEVICE_REJECTED:credential_unresolved');
  });

  it('refuses a replayed packet', async () => {
    await device('resolves');
    const captured = packet(withKey);
    await ingestBiomechPacket(actor, DEVICE, captured as never);
    await expect(ingestBiomechPacket(actor, DEVICE, captured as never)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(db.biomechanicalPacket.create).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('device activation', () => {
  const activation = (sign: (msg: string) => string, over: { nonce?: string; fingerprint?: string } = {}) => {
    const ts = Math.floor(Date.now() / 1000);
    const n = over.nonce ?? nonce();
    return { efuseFingerprint: over.fingerprint ?? 'efuse-genuine', ts, nonce: n, sig: sign(`${ts}.${n}`) };
  };
  const device = async (credential: Credential) => {
    db.device.findUnique.mockResolvedValue({
      id: DEVICE, serial: 'FAM-0001', clubId: CLUB, status: 'REGISTERED', efuseFingerprint: null, activatedAt: null,
      ...(await bearer('device', DEVICE, credential)),
    });
    db.device.update.mockImplementation(async ({ data }: Row) => ({ id: DEVICE, ...data }));
  };

  it('activates a device that signs with its key', async () => {
    await device('resolves');
    await expect(activateDevice('FAM-0001', activation(withKey))).resolves.toMatchObject({ status: 'PROVISIONED' });
  });

  it.each(UNRESOLVABLE)('refuses an empty-key activation when the credential is %s — no fingerprint is claimed', async (credential) => {
    await device(credential);
    await expect(activateDevice('FAM-0001', activation(emptyKeyHmac, { fingerprint: 'efuse-attacker' }))).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.device.update).not.toHaveBeenCalled();
    expect(reasons()).toContain('DEVICE_REJECTED:credential_unresolved');
  });

  it('refuses a captured activation replayed with another fingerprint', async () => {
    await device('resolves');
    const captured = activation(withKey);
    await activateDevice('FAM-0001', captured);
    // The signature covers ts.nonce, not the fingerprint — only the nonce stops this.
    await expect(activateDevice('FAM-0001', { ...captured, efuseFingerprint: 'efuse-attacker' })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(db.device.update).toHaveBeenCalledTimes(1);
    expect(reasons()).toContain('DEVICE_REPLAY:nonce_reused');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('device attestation', () => {
  const actor = { userId: 'user-1', clubId: CLUB };
  const attestation = (sign: (msg: string) => string, over: { nonce?: string } = {}) => {
    const n = over.nonce ?? nonce();
    const secureBootHash = 'secure-boot-hash-1';
    return { deviceId: DEVICE, nonce: n, secureBootHash, sigB64: sign(`${n}|${secureBootHash}`) };
  };
  const device = async (credential: Credential, nonceUsedBefore = false) => {
    db.device.findUnique.mockResolvedValue({ id: DEVICE, clubId: CLUB, status: 'ACTIVE', ...(await bearer('device', DEVICE, credential)) });
    db.deviceAttestation.findFirst.mockResolvedValue(nonceUsedBefore ? { id: 'attestation-0' } : null);
    db.deviceAttestation.create.mockImplementation(async ({ data }: Row) => ({ id: 'attestation-1', ...data }));
    db.deviceTrustAnchor.findFirst.mockResolvedValue(null);
    db.deviceTrustAnchor.updateMany.mockResolvedValue({ count: 0 });
    db.device.update.mockResolvedValue({});
  };

  it('verifies an attestation signed with the device key', async () => {
    await device('resolves');
    await expect(recordAttestation(actor, attestation(withKey))).resolves.toMatchObject({ status: 'VERIFIED' });
  });

  it.each(UNRESOLVABLE)('refuses when the credential is %s — no verdict recorded, no device revoked', async (credential) => {
    await device(credential);
    await expect(recordAttestation(actor, attestation(emptyKeyHmac))).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.deviceAttestation.create).not.toHaveBeenCalled();
    expect(db.device.update).not.toHaveBeenCalled();
    expect(reasons()).toContain('DEVICE_REJECTED:credential_unresolved');
  });

  it('refuses the same attestation twice inside the nonce memory', async () => {
    await device('resolves');
    const captured = attestation(withKey);
    await recordAttestation(actor, captured);
    await expect(recordAttestation(actor, captured)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(db.deviceAttestation.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a nonce this device used before, after the nonce memory has expired', async () => {
    await device('resolves', true);
    await expect(recordAttestation(actor, attestation(withKey))).rejects.toBeInstanceOf(UnauthorizedError);
    expect(db.deviceAttestation.create).not.toHaveBeenCalled();
    expect(reasons()).toContain('DEVICE_REPLAY:nonce_reused_recorded');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('device session handshake — POST /api/v1/devices/auth/token', () => {
  const SESSION = 'device-session-0001';
  const handshake = (sign: (msg: string) => string) => {
    const ts = Math.floor(Date.now() / 1000);
    const n = nonce();
    return { deviceSessionId: SESSION, ts, nonce: n, sig: sign(`${ts}.${n}`) };
  };
  const session = (sessionKey: string | null) => db.deviceSession.findUnique.mockResolvedValue({
    id: SESSION, clubId: CLUB, teamId: null, matchId: null, trainingSessionId: null,
    deviceModel: 'FAM-W1', deviceSerial: 'FAM-0001', sessionKey, endedAt: null,
  });

  it('issues a device token for a handshake signed with the session key', async () => {
    session(KEY);
    await expect(issueDeviceToken(handshake(withKey))).resolves.toMatchObject({ sessionId: SESSION });
  });

  it('refuses an empty-key signature when the session has no key, or one that decodes to nothing', async () => {
    session(null);
    await expect(issueDeviceToken(handshake(emptyKeyHmac))).rejects.toBeInstanceOf(ForbiddenError);
    session('====');
    await expect(issueDeviceToken(handshake(emptyKeyHmac))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a captured handshake replayed inside the clock window: one nonce, one token', async () => {
    session(KEY);
    const captured = handshake(withKey);
    await expect(issueDeviceToken(captured)).resolves.toMatchObject({ sessionId: SESSION });
    await expect(issueDeviceToken(captured)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(reasons()).toContain('DEVICE_REPLAY:nonce_reused');
  });
});
