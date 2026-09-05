// Event contracts — the vocabulary of things that happen in Familista
// ─────────────────────────────────────────────────────────────────────────────
// One name per meaningful thing, declared once, so that a screen, a worker, an
// analytics pipeline and an AI agent all refer to the same event rather than to
// four spellings of it.
//
// ── Two streams, never one table
//
//   PRODUCT ANALYTICS answers "what is being used?" — anonymous-leaning, high
//                     volume, aggregate. It may be sampled and it may expire.
//   AUDIT             answers "who changed what?" — attributable, low volume,
//                     kept. It may never be sampled and must not expire while
//                     the record it explains exists.
//
// They are different questions with different retention, different privacy
// exposure and different consumers, and merging them produces a table that is
// too sensitive to query freely and too noisy to audit with.
//
// ── Versioned from the first day
//
// Every event carries `version`. A consumer written today must still be able to
// read an event written last year, which means the shape is allowed to grow but
// never to change meaning under an unchanged version.

export type EventVersion = 1;

/** Everything an event carries regardless of what happened. */
export interface EventEnvelope {
  /** Dot-separated, past tense, stable forever once published. */
  name: PlatformEventName;
  version: EventVersion;
  occurredAt: string;
  /** Ties every event of one request together, across services and workers. */
  correlationId?: string | null;
  /** PRODUCTION | STAGING | LAB | PREVIEW — see platform/environment.ts. */
  environment: string;
  actor: {
    type: 'USER' | 'PLATFORM_OWNER' | 'SYSTEM' | 'AI_AGENT';
    id?: string | null;
    /** The agent's identifier when type is AI_AGENT. Never a person's. */
    agentId?: string | null;
  };
  scope: {
    clubId?: string | null;
    teamId?: string | null;
  };
}

export interface PlatformEvent<P = Record<string, unknown>> extends EventEnvelope {
  payload: P;
}

/**
 * The names. Adding one is additive; renaming one is a breaking change to every
 * consumer and is not done.
 */
export const EVENT_NAMES = [
  // identity & access
  'UserLoggedIn', 'UserRegistered', 'StaffInvited', 'InvitationAccepted',
  'MembershipGranted', 'MembershipRevoked', 'MembershipSuspended', 'MembershipReactivated',
  'ClubOpened', 'TeamOpened',
  // football operations
  'PlayerCreated', 'PlayerUpdated', 'TrainingCreated', 'TrainingCompleted',
  'MatchCreated', 'MatchFinished', 'FormationChanged', 'TransferOfferCreated',
  'MedicalAlertCreated',
  // product
  'FeatureUsed', 'ExperimentStarted', 'ExperimentDecided', 'FeatureFlagChanged',
  // intelligence
  'AIActionRequested', 'AIActionExecuted', 'AIActionRefused', 'AIApprovalRequested',
] as const;

export type PlatformEventName = typeof EVENT_NAMES[number];

/**
 * Which stream an event belongs to.
 *
 * Stated per event rather than inferred from its name, because the distinction
 * is a decision about privacy and retention and must be visible when the event
 * is declared.
 */
export const EVENT_STREAM: Readonly<Record<PlatformEventName, 'AUDIT' | 'ANALYTICS' | 'BOTH'>> = Object.freeze({
  UserLoggedIn: 'BOTH',
  UserRegistered: 'AUDIT',
  StaffInvited: 'AUDIT',
  InvitationAccepted: 'AUDIT',
  MembershipGranted: 'AUDIT',
  MembershipRevoked: 'AUDIT',
  MembershipSuspended: 'AUDIT',
  MembershipReactivated: 'AUDIT',
  ClubOpened: 'ANALYTICS',
  TeamOpened: 'ANALYTICS',
  PlayerCreated: 'AUDIT',
  PlayerUpdated: 'AUDIT',
  TrainingCreated: 'BOTH',
  TrainingCompleted: 'BOTH',
  MatchCreated: 'AUDIT',
  MatchFinished: 'BOTH',
  FormationChanged: 'AUDIT',
  TransferOfferCreated: 'AUDIT',
  MedicalAlertCreated: 'AUDIT',
  FeatureUsed: 'ANALYTICS',
  ExperimentStarted: 'BOTH',
  ExperimentDecided: 'BOTH',
  FeatureFlagChanged: 'AUDIT',
  AIActionRequested: 'BOTH',
  AIActionExecuted: 'AUDIT',
  AIActionRefused: 'AUDIT',
  AIApprovalRequested: 'AUDIT',
});

/**
 * Payload keys that must never be published on an event, in either stream.
 *
 * Checked at publish time rather than trusted: an event is the easiest place in
 * a platform for a secret to escape, because events get copied to warehouses,
 * to logs and to third parties by people who never read the code that made them.
 */
export const FORBIDDEN_PAYLOAD_KEYS: ReadonlyArray<string> = Object.freeze([
  'password', 'passwordHash', 'token', 'tokenHash', 'refreshToken', 'accessToken',
  'secret', 'apiKey', 'authorization', 'cookie', 'ssn', 'creditCard',
]);

export function assertPublishable(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload ?? {})) {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_PAYLOAD_KEYS.some((f) => lowered === f.toLowerCase() || lowered.endsWith(f.toLowerCase()))) {
      throw new Error(`Event payloads must not carry "${key}"`);
    }
  }
}
