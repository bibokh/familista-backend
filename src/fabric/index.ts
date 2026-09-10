// The Familista Data Fabric — public surface
// ─────────────────────────────────────────────────────────────────────────────
// Domain code imports from here and from nowhere deeper. That is what keeps the
// promise the brief asks for: the transport and the object store can both be
// replaced without a single call site changing, because no call site can name
// either of them.

export {
  makeEvent, deriveIdempotencyKey, eventBelongsToClub, serialiseEvent,
  EventValidationError,
  type FamilistaEvent, type EventInput, type EventSourceType, type EventSubjectType,
} from './event-envelope';

export {
  EVENT_TYPES, registeredEventTypes, isRegisteredEventType, eventTypeSpec,
  classificationForEventType, canonicalNameForLegacyKind,
  type EventTypeSpec, type FamilistaEventType,
} from './event-taxonomy';

export {
  emit, readEvents, subscribe, clearSubscribers,
  setEventTransport, currentTransport,
  type EventTransport, type EventQuery, type EmitResult, type AppendOutcome, type EventHandler,
} from './event-bus';

export { OutboxEventTransport, outboxTransport, eventFromRow, isFabricRow, ENVELOPE_KEY } from './outbox-transport';

export {
  getObjectStore, setObjectStore, buildObjectKey, clubIdFromKey, sha256,
  MemoryObjectStore, DEFAULT_READ_TTL_SECONDS,
  type ObjectStore, type PutObjectArgs, type PutObjectResult, type HeadObjectResult, type SignedUrl,
} from './media/object-store';

export {
  createMediaAsset, getMediaAsset, listMediaForSubject, getMediaReadUrl,
  deleteMediaAsset, findByChecksum,
  type CreateMediaInput,
} from './media/media-asset.service';

export {
  classifyImageRef, resolveImageRef, mediaRef, decodeDataUrl,
  MEDIA_REF_PREFIX, LEGACY_IMAGE_COLUMNS, LEGACY_IMAGE_MIGRATION,
  type ImageRef, type ImageRefKind,
} from './media/legacy-media';

export { fabricStatus, type FabricStatus } from './fabric-status.service';

// ── observability ────────────────────────────────────────────────────────────
// Watching events move, without becoming a second way to read them. The frame
// is an allow-list of envelope fields and never carries a payload.

export {
  startPulse, stopPulse, isPulseRunning, onPulse, recentFrames, resetPulse, flushNow,
  pulseMetrics, pulseTopology, project, sourceLaneFor, destinationLaneFor,
  INSTRUMENTED_EVENT_TYPES, SOURCE_LANES, LIVE_DESTINATIONS, FUTURE_DESTINATIONS,
  BUFFER_LIMIT, FLUSH_MS, SAMPLE_THRESHOLD,
  type PulseFrame, type PulseBatch, type PulseMetrics, type PulseTopology, type PulseListener,
} from './pulse/pulse.service';

export {
  replayWindow, replayCounts, REPLAY_WINDOWS, REPLAY_MAX,
  type ReplayQuery, type ReplayResult,
} from './pulse/pulse-replay.service';

/**
 * Install the default transport.
 *
 * Called once at boot. Separated from module load so that importing the fabric
 * in a test does not silently bind it to a database.
 */
export function initDataFabric(): void {
  // Required lazily: a process that only reads the taxonomy should not pull in
  // Prisma to do it.
  const { outboxTransport: t } = require('./outbox-transport') as typeof import('./outbox-transport');
  const { setEventTransport: set } = require('./event-bus') as typeof import('./event-bus');
  set(t);
  // Observing from boot rather than from the owner's first visit, so "last
  // event time" means the platform's last event and not the last one somebody
  // happened to be watching. One in-process subscriber, no I/O, bounded buffer.
  const { startPulse: watch } = require('./pulse/pulse.service') as typeof import('./pulse/pulse.service');
  watch();
}

// ── secrets ──────────────────────────────────────────────────────────────────
// A reference names a secret and is not one. Domain code stores the reference,
// resolves through the port, and can name no provider.

export {
  makeSecretRef, parseSecretRef, formatSecretRef, isSecretRef, nextVersion,
  looksLikeSecretMaterial, assertNoSecretMaterial,
  SecretRefError, SECRET_REF_SCHEME, SECRET_REF_VERSION,
  type SecretRef,
} from './secrets/secret-ref';

export {
  getSecretStore, setSecretStore, generateSecret, secretsEqual,
  sealSecret, openSecret, DEFAULT_SECRET_BYTES,
  MemorySecretStore, EnvSecretStore,
  // The envelope, taken apart. A kid is not key material, so it is safe in a
  // column, a log and an event — which is what makes rotation auditable.
  parseEnvelope, envelopeKid, rewrapEnvelope, type SecretEnvelope,
  // The keyring. Exported so a status surface, a startup check or a test can
  // ask whether this deployment may seal anything WITHOUT trying to seal
  // something, and which key would do it.
  SECRET_KEK_ENV, KEYRING_ENV_PREFIX, ACTIVE_KEK_ENV, RETIRED_KEKS_ENV,
  LEGACY_KID, ENVELOPE_MARKER,
  SecretKeyConfigError, SecretKeyUnavailable, WeakSecretKey,
  UnknownKeyId, RetiredKeyId, DuplicateKeyId, KeyringMisconfigured,
  MIN_KEK_BYTES, MIN_KEK_DISTINCT_CHARS,
  effectiveKeyBytes, kekWeakness, kidFromEnvName,
  readKeyring, keyringStatus, secretKeyStatus, keyForKid, activeKey,
  type KeyringEntry, type KeyringReport,
  type SecretStore, type SecretValue, type PutSecretOptions, type RotateResult,
} from './secrets/secret-store';

// Rotation, as an operation rather than a script. Resumable, auditable, and
// incapable of returning a plaintext credential to its caller.
export {
  rewrapPlan, rewrapBatch, retirementCheck, recordKeyLifecycle,
  type RewrapPlan, type RewrapOptions, type RewrapReport, type RetirementCheck,
} from './secrets/rewrap';

export { DbSecretStore } from './secrets/db-secret-store';

export {
  resolveCredential, storeNewCredential, rotateCredential, revokeCredential,
  credentialRefFor, credentialStorageMode,
  type CredentialBearer, type CredentialScope, type CredentialSource, type ResolvedCredential,
} from './secrets/device-credentials';
