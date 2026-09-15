// The Familista Data Fabric registry — public surface
// ─────────────────────────────────────────────────────────────────────────────
// A module that wants to join the fabric imports from here and from nowhere
// deeper. Four calls is the whole API:
//
//   registerFabricSource({ id: 'finance', ... })          once, at load
//   registerFabricEvent({ type: 'finance.invoice.issued' })  once, at load
//   registerFabricSchema({ eventType, version, schema })  once, at load
//   await publishFabricEvent({ eventType, ... })          wherever it happens
//
// Nothing else has to be touched. Not the Live Data Flow page, not the pulse
// service, not the routes. See README.md in this directory for the worked
// example.

export {
  registerFabricSource, fabricSource, fabricSources, visibleFabricSources,
  sourceLanes, sourceForEventDomain, resetSourceRegistry,
  FabricRegistryError, FALLBACK_SOURCE_ID,
  type FabricSourceSpec, type FabricSourceInput,
} from './source-registry';

export {
  registerFabricEvent, registerFabricEvents, fabricEvent, fabricEvents,
  fabricEventsForSource, registeredEventTypes, isRegisteredEventType,
  classificationForEventType, canonicalNameForLegacyKind, exposedInLiveStream,
  resetEventRegistry,
  type FabricEventSpec, type FabricEventInput,
} from './event-registry';

export {
  registerFabricSchema, fabricSchema, fabricSchemas, schemaVersionsFor,
  validateEventPayload, resetSchemaRegistry,
  type FabricSchemaSpec, type FabricSchemaInput, type SchemaCheck,
} from './schema-registry';

// Declared against the producers that exist. Imported for the side effect of
// registering them, and exported so a test can re-seed after a reset.
export { registerCoreSchemas } from './core-schemas';

export {
  publishFabricEvent, publishFabricEventDetached, FabricPublishError,
  type PublishOptions, type PublishResult,
} from './publisher';

export {
  registryHealth, resetRegistryHealth,
  noteUnknownEventType, noteSchemaFailure, noteQuarantine,
  type RegistryHealth,
} from './unknown-events';
