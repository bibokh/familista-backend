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

// ── the registry ─────────────────────────────────────────────────────────────
// How a module joins the fabric: declare a source, declare its event types,
// declare their payload schemas, publish. Nothing downstream — not the pulse,
// not the board, not the routes — needs editing for a new module to appear.
// See `registry/README.md`.

export {
  registerFabricSource, fabricSource, fabricSources, visibleFabricSources,
  sourceLanes, sourceForEventDomain, resetSourceRegistry,
  FabricRegistryError, FALLBACK_SOURCE_ID,
  type FabricSourceSpec, type FabricSourceInput,
} from './registry/source-registry';

export {
  registerFabricEvent, registerFabricEvents, fabricEvent, fabricEvents,
  fabricEventsForSource, exposedInLiveStream, resetEventRegistry,
  type FabricEventSpec, type FabricEventInput,
} from './registry/event-registry';

export {
  registerFabricSchema, fabricSchema, fabricSchemas, schemaVersionsFor,
  validateEventPayload, resetSchemaRegistry,
  type FabricSchemaSpec, type FabricSchemaInput, type SchemaCheck,
} from './registry/schema-registry';

export { registerCoreSchemas } from './registry/core-schemas';

// ── producers ────────────────────────────────────────────────────────────────
// A domain migrated onto `publishFabricEvent`. Exported from here so its event
// types and schemas are registered at boot by the fabric itself, rather than as
// a side effect of whichever service happened to be imported first — the event
// catalogue must describe the same set whether or not anybody has logged in
// yet, and a domain whose registrations arrive late is a domain the board
// briefly does not understand.
export {
  registerMatchesProducer, MATCHES_SOURCE_ID,
  publishMatchCreated, publishMatchUpdated, publishMatchDeleted,
  publishMatchStatusChanged, publishMatchStarted, publishMatchCompleted,
  publishMatchCancelled, publishMatchTimeChanged, publishMatchVenueChanged,
  publishMatchLineupUpdated, publishMatchResultUpdated, publishMatchEventRecorded,
  type MatchContext,
} from './producers/matches.producer';

export { matchContext, announceReschedule, type MatchLike } from './producers/match-context';

export {
  registerDevicesProducer, DEVICES_SOURCE_ID, attachmentOf,
  publishDeviceRegistered, publishDeviceConnected, publishDeviceDisconnected,
  publishTelemetryBatchReceived,
  type DeviceContext,
} from './producers/devices.producer';

export {
  registerClubsProducer, CLUBS_SOURCE_ID,
  publishClubCreated, publishClubUpdated, publishClubPresidentInvited,
  publishClubLifecycleChanged, publishClubDeleted,
  type ClubsContext,
} from './producers/clubs.producer';

export {
  registerTrainingProducer, TRAINING_SOURCE_ID,
  publishTrainingSessionCreated, publishTrainingSessionUpdated, publishTrainingSessionDeleted,
  publishTrainingAttendanceSaved, publishTrainingLocationChanged, publishTrainingStatusChanged,
  publishTrainingPlayerAdded, publishTrainingPlayerRemoved,
  type TrainingContext,
} from './producers/training.producer';

export {
  registerPlayersProducer, PLAYERS_SOURCE_ID,
  publishPlayerCreated, publishPlayerUpdated, publishPlayerPhotoAttached,
  publishPlayerProfileUpdated, publishPlayerPositionChanged, publishPlayerStatusChanged,
  publishPlayerTeamChanged, publishPlayerSquadAdded, publishPlayerSquadRemoved,
  publishPlayerTransferred,
  type PlayerContext,
} from './producers/players.producer';

export {
  registerCoachMarketProducer, COACH_MARKET_SOURCE_ID,
  publishCoachProfileCreated, publishCoachProfileUpdated,
  publishCoachAvailabilityChanged, publishCoachCareerIntentChanged,
  publishCoachContractStatusChanged,
  publishCoachShortlisted, publishCoachUnshortlisted,
  publishCoachOffer, publishCoachNegotiationStarted, publishCoachNegotiationUpdated,
  publishCoachNegotiationCancelled, publishCoachHired,
  publishStaffNeedCreated, publishStaffNeedClosed,
  type CoachMarketContext,
} from './producers/coach-market.producer';

export {
  registerSystemProducer, SYSTEM_SOURCE_ID,
  publishSystemServiceStarted, publishSystemServiceStopped,
  publishSystemHealthChanged, publishSystemConfigChanged, publishSystemFeatureToggled,
  noteFabricPublishOutcome, noteFabricRegistryProblem,
  fabricSelfHealth, resetFabricSelfHealth,
  type SystemContext,
} from './producers/system.producer';

export {
  registerAIProducer, AI_SOURCE_ID,
  publishAIRequestCreated,
  publishAIAgentStarted, publishAIAgentCompleted, publishAIAgentFailed,
  publishAIModelInvoked,
  publishAIInferenceStarted, publishAIInferenceCompleted, publishModelDeploymentCompleted, publishAIInferenceFailed,
  publishAIOrchestrationStarted, publishAIOrchestrationCompleted,
  modelFamilyOf, failureCategoryOf, bucketTokens,
  type AIContext, type TokenBucket,
} from './producers/ai.producer';

export {
  registerMediaProducer, MEDIA_SOURCE_ID,
  publishMediaCreated, publishMediaUpdated, publishMediaDeleted,
  publishMediaUploadStarted, publishMediaUploadCompleted,
  publishMediaProcessingStarted, publishMediaProcessingCompleted, publishMediaProcessingFailed,
  bucketSize, bucketDuration,
  type MediaContext, type MediaFacts, type SizeBucket, type DurationBucket,
} from './producers/media.producer';

export { withMediaContext } from './producers/media-context';

export {
  registerMedicalProducer, MEDICAL_SOURCE_ID,
  publishInjuryCreated, publishInjuryUpdated, publishInjuryClosed, publishInjuryDeleted,
  publishMedicalRecordCreated, publishMedicalStatusUpdated, publishMedicalAvailabilityChanged,
  injuryContextOf, availableForSelection,
  type MedicalContext,
} from './producers/medical.producer';

export { withMedicalContext, withAthleteMedicalContext } from './producers/medical-context';

export {
  registerTransfersProducer, TRANSFERS_SOURCE_ID,
  publishTransferListed, publishTransferListingUpdated, publishTransferListingWithdrawn,
  publishTransferOffer, publishTransferBidPlaced,
  publishTransferNegotiationStarted, publishTransferNegotiationUpdated,
  publishTransferNegotiationCompleted,
  publishTransferShortlisted, publishTransferUnshortlisted, publishTransferCompleted,
  type TransferContext, type ListingKind, type TransferSettledBy,
} from './producers/transfers.producer';

export {
  registerUsersProducer, USERS_SOURCE_ID,
  publishUserCreated, publishUserUpdated, publishUserProfileUpdated,
  publishUserLogin, publishUserLogout,
  publishMembershipGranted, publishMembershipRevoked, publishAccessRoleChanged, publishMembershipChanged, publishMembershipSuspended, publishMembershipReactivated, publishUserContextSwitched,
} from './producers/users.producer';

export {
  publishFabricEvent, publishFabricEventDetached, FabricPublishError,
  type PublishOptions, type PublishResult,
} from './registry/publisher';

export {
  registryHealth, resetRegistryHealth,
  type RegistryHealth,
} from './registry/unknown-events';

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
  startPulse, stopPulse, isPulseRunning, onPulse, recentFrames, resetPulse, flushNow, ingestFrames,
  pulseMetrics, pulseTopology, project, sourceLaneFor, destinationLaneFor,
  instrumentedEventTypes, SOURCE_LANES, LIVE_DESTINATIONS, FUTURE_DESTINATIONS,
  BUFFER_LIMIT, FLUSH_MS, SAMPLE_THRESHOLD,
  type PulseFrame, type PulseBatch, type PulseMetrics, type PulseTopology,
  type PulseListener, type PulseSourceCard,
} from './pulse/pulse.service';

export {
  replayWindow, replayCounts, REPLAY_WINDOWS, REPLAY_MAX,
  type ReplayQuery, type ReplayResult,
} from './pulse/pulse-replay.service';

// The durable tail. Live reads the outbox, so an event written by one instance
// is seen by an owner streaming from another — which the in-process bus could
// never do.
export {
  tailStep, tailAfter, latestCursor, framesFromRows,
  formatCursor, parseCursor, TAIL_BATCH, TAIL_INTERVAL_MS,
  type OutboxCursor,
} from './pulse/outbox-tail.service';

export { resolveSubjects, isNameableSubject } from './pulse/subject-resolver.service';

// Where Familista is, as opposed to how fast it is moving. Counts of clubs,
// people and the countries clubs record, plus the country centroids the board
// plots them at — every one of them a COUNT over a real table.
export {
  ecosystemFootprint, placeCountry, resetEcosystemCache, ATLAS_SIZE,
  type EcosystemFootprint, type EcosystemRegion,
} from './pulse/ecosystem.service';

// The second tail. `EventOutbox` says what the platform recorded; this says
// whether anyone is using it — a person can read every screen for an hour and
// write nothing, and a board fed only by domain events sits dark through a busy
// afternoon.
export {
  telemetryStep, telemetryAfter, latestTelemetryCursor, frameFromTelemetryRow,
  formatTelemetryCursor, parseTelemetryCursor, activeCounts,
  telemetryCategory, telemetrySourceLane, telemetryDestinationLane,
  TELEMETRY_BATCH,
  type TelemetryCursor, type TelemetryCategory,
} from './pulse/telemetry-tail.service';

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
  // Data Pulse is NOT started here any more. It used to subscribe to this bus,
  // which is exactly why a `player.updated` written by one instance never
  // reached an owner watching another. Live now tails `EventOutbox` and starts
  // with the first stream that asks for it — see `data-pulse.routes.ts`.
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
