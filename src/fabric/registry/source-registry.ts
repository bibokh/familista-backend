// Who produces data on Familista
// ─────────────────────────────────────────────────────────────────────────────
// A source is a PLATFORM DOMAIN that emits events — Users, Players, Matches,
// and one day Finance or Scouting. Before this file the set was two literals in
// `pulse.service.ts`: a map from event-name prefix to lane, and a frozen array
// of lane names in display order. Adding a domain meant editing the visualiser,
// which is backwards — the board should be a view of the platform, not the
// place the platform is defined.
//
// So the registry is the definition and everything else reads it. `sourceLanes`
// feeds the board, `sourceLaneFor` routes an event to its lane, and the source
// catalogue endpoint serves the same records to anything else that wants them.
//
// THREE RULES THAT ARE NOT NEGOTIABLE
//
// ONE · A SOURCE IS A DOMAIN, NOT A FEATURE. Adding `user.preferences.updated`
// to Users does not create a source; it is a new event on an existing one.
// A source appears when somebody registers one, and for no other reason. This
// is why `eventDomains` is a property of the SOURCE rather than something
// inferred from event names — inference is exactly how a feature accidentally
// becomes a card on the board.
//
// TWO · REGISTRATION IS NOT DISPLAY. `enabled` says the domain exists;
// `showInLiveDataFlow` says the board should draw a lane for it. A source that
// is registered for routing and catalogue purposes but not yet worth a lane
// sets the second to false and nothing on screen changes.
//
// THREE · NOTHING HERE IS PERSISTED. These are platform contracts, not data:
// they are true because this build says so, and a row in a table saying
// otherwise would be a second, disagreeing answer. Registration happens once
// at module load, never per request.

/** A platform domain that produces events. */
export interface FabricSourceSpec {
  /** Stable machine id. Lower-case, dash-separated. Never displayed. */
  id: string;
  /**
   * The lane label on the board, and the value `PulseFrame.source` carries.
   *
   * Display text, but also a join key: the board filters a lane by this string
   * and the rate counters group by it, so renaming one is a breaking change to
   * anything that stored a lane name.
   */
  name: string;
  /** The business domain it belongs to — `identity`, `football`, `platform`. */
  domain: string;
  /** Key into the SYSTEM icon set. Served to the board so it need not guess. */
  icon: string;
  /** One line: what this source is, in the words a person would use. */
  description: string;
  /** Grouping for a catalogue view. Not used for ordering. */
  category: string;
  /** Position on the board. Lower first. Ties break on `id`. */
  order: number;
  /** False for a domain that exists in the registry but is switched off. */
  enabled: boolean;
  /** Whether the board should draw a lane for it. */
  showInLiveDataFlow: boolean;
  /**
   * The event-name prefixes this source owns — `user.*`, `membership.*`.
   *
   * A prefix belongs to exactly one source. Claiming one that another source
   * already owns is refused, because two owners means an event lands on
   * whichever module happened to load first.
   */
  eventDomains: readonly string[];
}

/** What a caller supplies. Everything else has a sane default. */
export interface FabricSourceInput {
  id: string;
  name?: string;
  domain?: string;
  icon?: string;
  description?: string;
  category?: string;
  order?: number;
  enabled?: boolean;
  showInLiveDataFlow?: boolean;
  eventDomains?: readonly string[];
}

export class FabricRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FabricRegistryError';
  }
}

const sources = new Map<string, FabricSourceSpec>();
/** event-name prefix → source id. The routing index, kept in step with the map. */
const domainOwners = new Map<string, string>();

const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const DOMAIN_PATTERN = /^[a-z][a-z0-9]*$/;

/** Title Case from an id, so `video-intelligence` gets a readable default. */
function titleFrom(id: string): string {
  return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Register a platform source.
 *
 * Idempotent for an IDENTICAL re-registration — a module imported twice, or a
 * test file that re-runs bootstrap, must not fail. A registration that differs
 * from the one already held is refused, because silently replacing a source
 * would move every event on its lane without anybody asking.
 */
export function registerFabricSource(input: FabricSourceInput): FabricSourceSpec {
  const id = String(input?.id ?? '').trim();
  if (!ID_PATTERN.test(id)) {
    throw new FabricRegistryError(
      `source id "${id}" must be lower-case and dash-separated, e.g. "video-intelligence"`,
    );
  }

  // An event name's first segment is a single lower-case word, so a dashed id
  // cannot be its own prefix — `video-intelligence` owns `video`, or `vision`,
  // or whatever its events are actually called, and only it knows which. The
  // default therefore applies only when the id is already a legal prefix;
  // anything else must say so rather than have a prefix guessed for it.
  const defaulted = input.eventDomains ?? (DOMAIN_PATTERN.test(id) ? [id] : null);
  if (!defaulted) {
    throw new FabricRegistryError(
      `source "${id}" must name its eventDomains — a dashed id is not a legal event-name prefix, `
      + `so there is nothing to default to`,
    );
  }
  const eventDomains = Object.freeze([...defaulted].map((d) => String(d).trim()));
  for (const d of eventDomains) {
    if (!DOMAIN_PATTERN.test(d)) {
      throw new FabricRegistryError(
        `source "${id}" claims event domain "${d}", which is not a single lower-case word`,
      );
    }
  }

  const spec: FabricSourceSpec = Object.freeze({
    id,
    name: input.name ?? titleFrom(id),
    domain: input.domain ?? id,
    icon: input.icon ?? 'system',
    description: input.description ?? '',
    category: input.category ?? 'core',
    order: Number.isFinite(input.order) ? Number(input.order) : 1000,
    enabled: input.enabled ?? true,
    showInLiveDataFlow: input.showInLiveDataFlow ?? true,
    eventDomains,
  });

  const existing = sources.get(id);
  if (existing) {
    if (sameSpec(existing, spec)) return existing;
    throw new FabricRegistryError(
      `source "${id}" is already registered with different settings — a source is a platform `
      + 'contract and is not replaced at runtime',
    );
  }

  // Claim the prefixes only once the whole registration is known to be sound,
  // so a rejected registration cannot leave half its domains claimed.
  for (const d of eventDomains) {
    const owner = domainOwners.get(d);
    if (owner && owner !== id) {
      throw new FabricRegistryError(
        `event domain "${d}" is already owned by source "${owner}" — one prefix, one source`,
      );
    }
  }

  sources.set(id, spec);
  for (const d of eventDomains) domainOwners.set(d, id);
  return spec;
}

function sameSpec(a: FabricSourceSpec, b: FabricSourceSpec): boolean {
  return a.name === b.name && a.domain === b.domain && a.icon === b.icon
    && a.description === b.description && a.category === b.category && a.order === b.order
    && a.enabled === b.enabled && a.showInLiveDataFlow === b.showInLiveDataFlow
    && a.eventDomains.join('|') === b.eventDomains.join('|');
}

/** One source by id. */
export function fabricSource(id: string): FabricSourceSpec | undefined {
  return sources.get(id);
}

/** Every registered source, in board order. Includes disabled ones. */
export function fabricSources(): FabricSourceSpec[] {
  return [...sources.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** The sources the board should draw, in order. */
export function visibleFabricSources(): FabricSourceSpec[] {
  return fabricSources().filter((s) => s.enabled && s.showInLiveDataFlow);
}

/**
 * The lane names the board draws, in order.
 *
 * Computed on every call rather than snapshotted, so a source registered by a
 * module that loaded after this one still appears. The list is ten entries
 * long; recomputing it is cheaper than the cache-invalidation bug.
 */
export function sourceLanes(): string[] {
  return visibleFabricSources().map((s) => s.name);
}

/** The source that owns an event-name prefix. */
export function sourceForEventDomain(domain: string): FabricSourceSpec | undefined {
  const id = domainOwners.get(String(domain ?? ''));
  return id ? sources.get(id) : undefined;
}

/**
 * The fallback lane for an event whose domain nobody claimed.
 *
 * `System` rather than a lane invented from the first word of the name: an
 * unrouted event should look unrouted, not like a domain that exists.
 */
export const FALLBACK_SOURCE_ID = 'system';

/** Wipe the registry. Tests only — never called by the application. */
export function resetSourceRegistry(): void {
  sources.clear();
  domainOwners.clear();
  seedCoreSources();
}

// ── the sources Familista has today ──────────────────────────────────────────
//
// Seeded here, at module load, rather than in a bootstrap file somebody has to
// remember to import. Anything that can reach `sourceLaneFor` can reach this,
// so there is no order in which the lanes come out empty.
//
// `order` reproduces the board's existing left column exactly. The values are
// spaced by ten so a future source can be slotted between two without
// renumbering the set.

const CORE_SOURCES: readonly FabricSourceInput[] = Object.freeze([
  {
    id: 'clubs', name: 'Clubs', domain: 'tenancy', icon: 'clubs', category: 'core', order: 10,
    description: 'Club records, lifecycle and tenancy',
    eventDomains: ['club'],
  },
  {
    id: 'users', name: 'Users', domain: 'identity', icon: 'users', category: 'core', order: 20,
    description: 'People, memberships and access',
    eventDomains: ['user', 'membership', 'access'],
  },
  {
    id: 'players', name: 'Players', domain: 'football', icon: 'players', category: 'core', order: 30,
    description: 'Squad records and player profiles',
    eventDomains: ['player'],
  },
  {
    id: 'training', name: 'Training', domain: 'football', icon: 'training', category: 'operations', order: 40,
    description: 'Sessions, attendance and load',
    eventDomains: ['training', 'attendance'],
  },
  {
    id: 'matches', name: 'Matches', domain: 'football', icon: 'matches', category: 'operations', order: 50,
    description: 'Fixtures, matches and in-match events',
    eventDomains: ['match'],
  },
  {
    id: 'transfers', name: 'Transfers', domain: 'football', icon: 'transfers', category: 'operations', order: 60,
    description: 'Listings, offers and completed moves',
    eventDomains: ['transfer'],
  },
  {
    id: 'medical', name: 'Medical', domain: 'football', icon: 'medical', category: 'operations', order: 70,
    description: 'Injuries, availability and return to play',
    eventDomains: ['medical', 'injury'],
  },
  {
    id: 'media', name: 'Media', domain: 'media', icon: 'media', category: 'core', order: 80,
    description: 'Assets, uploads and processing',
    eventDomains: ['media'],
  },
  {
    id: 'ai', name: 'AI', domain: 'intelligence', icon: 'ai', category: 'intelligence', order: 90,
    description: 'Models, agents and analysis',
    eventDomains: ['ai', 'model', 'agent'],
  },
  {
    id: 'system', name: 'System', domain: 'platform', icon: 'system', category: 'platform', order: 100,
    description: 'Platform, devices, capture and secrets',
    eventDomains: ['device', 'telemetry', 'camera', 'secret', 'system', 'ui', 'route', 'module', 'page'],
  },
]);

function seedCoreSources(): void {
  for (const s of CORE_SOURCES) registerFabricSource(s);
}

seedCoreSources();
