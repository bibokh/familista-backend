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
}
