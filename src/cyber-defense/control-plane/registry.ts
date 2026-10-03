// The Cybersecurity Control Plane — what is protected, and by what
// ─────────────────────────────────────────────────────────────────────────────
// The Cybersecurity Command Center draws one picture: every security domain,
// every Familista area it protects, and the evidence behind each. This file is
// the registry that picture is drawn from. It holds NO status — status comes
// from evidence only:
//
//   src/cyber-defense/coverage-map.json      the 38 trust boundaries, each
//                                            with its coverage (C/P/U), its
//                                            controls, and every discovered
//                                            component mapped onto them
//   src/cyber-defense/generated/
//     security-manifest.json                 each control's measured status
//                                            and the file that proves it
//   src/cyber-defense/posture-policy.json    which controls are required,
//                                            which gaps are known
//   runtime.ts + the service's adapters      what the running platform
//                                            recorded: events, backups, RLS
//                                            mode, alert delivery
//
// HOW A NEW PART OF FAMILISTA JOINS
//
//   1. Its router, model, worker or env var must already be mapped onto a
//      trust boundary in coverage-map.json — `architecture-fully-mapped`
//      fails CI otherwise. That is the threat surface.
//   2. Its router is placed in a PLATFORM AREA below — the Command Center test
//      fails while any mounted router belongs to no area.
//   3. A new kind of risk gets a SECURITY DOMAIN here naming its boundary rows;
//      a new runtime figure gets an adapter; a new `security.*` signal names
//      its domain where it is declared (security-event-schema.ts, `evidences`).
//      Nothing else in the Command Center changes: the map, the cards and the
//      drill-downs are drawn from these.
//
// The English here is the interface's own copy; the module translates it from
// public/cybersecurity/i18n/. Boundary names, reasons and evidence notes are
// repository evidence and are shown as recorded.

/** Where a domain or area sits on the platform map. */
export type AreaGroup = 'PLATFORM' | 'DATA' | 'INTERFACES' | 'AI' | 'VISION_DEVICES' | 'FOOTBALL' | 'OPERATIONS';

export const AREA_GROUPS: ReadonlyArray<{ id: AreaGroup; title: string }> = [
  { id: 'PLATFORM', title: 'Platform & identity' },
  { id: 'FOOTBALL', title: 'Football operations' },
  { id: 'DATA', title: 'Data' },
  { id: 'INTERFACES', title: 'APIs & integrations' },
  { id: 'AI', title: 'AI & machine learning' },
  { id: 'VISION_DEVICES', title: 'Vision & devices' },
  { id: 'OPERATIONS', title: 'Operations & delivery' },
];

/** A runtime adapter: one read-only view of something the platform recorded. */
export type AdapterId =
  | 'identity' | 'mfa' | 'tenancy' | 'rls' | 'api' | 'ai' | 'devices' | 'video'
  | 'webhooks' | 'crypto' | 'secrets' | 'storage' | 'backups' | 'audit'
  | 'events' | 'supply-chain' | 'infrastructure' | 'monitoring';

export interface DomainDecl {
  id: string;
  title: string;
  /** One sentence: what this domain keeps safe, for a reader who does not read code. */
  protects: string;
  /** Trust boundaries (coverage-map row ids) this domain answers for. */
  rows: number[];
  /** Controls that belong here without being on one of the rows above. */
  extraControls: string[];
  /** SecurityEvent kinds that are this domain's evidence of activity ('*' for all). */
  eventKinds: string[];
  /**
   * Every `security.*` Data Fabric signal is this domain's evidence. Otherwise
   * a domain's signals are the ones the Security Event Schema declares as
   * `evidences: <this id>` — the name is spelled once, where it is declared.
   */
  allSignals?: boolean;
  adapter: AdapterId;
}

export const SECURITY_DOMAINS: readonly DomainDecl[] = [
  {
    id: 'identity', title: 'Identity & Access Security', adapter: 'identity',
    protects: 'Who may call the platform, and what each role may do once signed in.',
    rows: [3, 4, 6, 7], extraControls: [],
    eventKinds: ['LOGIN_SUCCESS', 'LOGIN_FAILED'],
  },
  {
    id: 'mfa-sessions', title: 'MFA & Session Security', adapter: 'mfa',
    protects: 'Second-factor sign-in, lockout of repeated failures, and sessions that can be ended at once.',
    rows: [2, 8], extraControls: ['mfa-required-at-login', 'refresh-token-legacy-fallback-removed'],
    eventKinds: ['LOGIN_LOCKED'],
  },
  {
    id: 'tenant', title: 'Club / Tenant Isolation', adapter: 'tenancy',
    protects: 'One club can never read or change another club’s data, in any module.',
    rows: [5, 13, 15, 24], extraControls: [],
    eventKinds: ['TENANT_MISMATCH'],
  },
  {
    id: 'rls', title: 'PostgreSQL Row-Level Security', adapter: 'rls',
    protects: 'A second, database-level wall between clubs, independent of the application.',
    rows: [5, 18], extraControls: ['db-rls-pilot', 'db-rls-system-paths-reviewed', 'db-row-level-security'],
    eventKinds: [],
  },
  {
    id: 'api', title: 'API Security', adapter: 'api',
    protects: 'Every endpoint: authentication, browser policy, rate limits and safe database access.',
    rows: [1, 4, 6, 38], extraControls: ['no-unsafe-raw-sql'],
    eventKinds: ['RATE_LIMITED', 'SUSPICIOUS_PAYLOAD'],
  },
  {
    id: 'ai-ml', title: 'AI & ML Security', adapter: 'ai',
    protects: 'What reaches an AI model, what agents may do, and how models and training data are trusted.',
    rows: [9, 10, 11, 12, 13, 14, 15], extraControls: [],
    eventKinds: ['PROMPT_INJECTION_SUSPECT', 'UNAUTHORIZED_AI_ATTEMPT', 'APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'APPROVAL_REJECTED', 'APPROVAL_EXPIRED'],
  },
  {
    id: 'video', title: 'Video Intelligence Security', adapter: 'video',
    protects: 'Video uploads, transcoding and analysis workers, and the media they write.',
    rows: [20, 21], extraControls: [],
    eventKinds: [],
  },
  {
    id: 'devices', title: 'Camera / Device Security', adapter: 'devices',
    protects: 'Cameras, wearables, sensors and edge nodes: only signed, fresh messages are accepted.',
    rows: [22, 23, 24], extraControls: [],
    eventKinds: ['DEVICE_REJECTED', 'DEVICE_REPLAY', 'DEVICE_TS_SKEW'],
  },
  {
    id: 'webhooks', title: 'Webhook & SSRF Protection', adapter: 'webhooks',
    protects: 'Calls into the platform from providers and workers, and calls out of it to addresses users supply.',
    rows: [25, 27, 33], extraControls: ['worker-channel-authenticated'],
    eventKinds: [],
  },
  {
    id: 'data-protection', title: 'Data Protection & Encryption', adapter: 'crypto',
    protects: 'Passwords, tokens, stored secrets, backups, logs and e-mail: encrypted, hashed or redacted.',
    rows: [14, 26, 34],
    extraControls: ['password-hashing-bcrypt', 'refresh-token-hashed-at-rest', 'versioned-keyring', 'backup-encrypted-authenticated'],
    eventKinds: [],
  },
  {
    id: 'secrets', title: 'Secrets Management', adapter: 'secrets',
    protects: 'Keys and credentials: kept out of code, scanned for in every change, and rotatable.',
    rows: [28], extraControls: [],
    eventKinds: [],
  },
  {
    id: 'storage', title: 'Storage Security', adapter: 'storage',
    protects: 'Every stored object sits under its owner’s prefix; no club writes into another’s folder.',
    rows: [20, 32], extraControls: [],
    eventKinds: [],
  },
  {
    id: 'backup', title: 'Backup & Disaster Recovery', adapter: 'backups',
    protects: 'Encrypted, signed backups, a restore proven in CI, and a written recovery plan.',
    rows: [31, 32], extraControls: [],
    eventKinds: [],
  },
  {
    id: 'audit', title: 'Audit & Evidence', adapter: 'audit',
    protects: 'A tamper-evident record of what happened, which the database itself refuses to rewrite.',
    rows: [35, 16, 17], extraControls: [],
    eventKinds: ['AUDIT_CHAIN_VERIFIED', 'AUDIT_CHAIN_BROKEN'],
  },
  {
    id: 'events', title: 'Security Events & Alerts', adapter: 'events',
    protects: 'Every recorded security event, and the alerts that reach the owner when one matters.',
    rows: [36, 34], extraControls: ['security-event-log'],
    eventKinds: ['*'], allSignals: true,
  },
  {
    id: 'supply-chain', title: 'Dependency / Supply Chain Security', adapter: 'supply-chain',
    protects: 'Third-party code and the build pipeline: pinned, audited and unable to leak secrets.',
    rows: [29, 37], extraControls: [],
    eventKinds: [],
  },
  {
    id: 'infrastructure', title: 'Infrastructure Security', adapter: 'infrastructure',
    protects: 'Databases, cache, services and deploys: private networking, gated releases, authenticated internal calls.',
    rows: [19, 30, 33], extraControls: [],
    eventKinds: [],
  },
  {
    id: 'monitoring', title: 'Security Monitoring', adapter: 'monitoring',
    protects: 'Whether the platform is watching: collectors, alert delivery and redacted logs.',
    rows: [34, 36], extraControls: ['security-event-log', 'log-redaction'],
    eventKinds: [],
  },
];

export interface AreaDecl {
  id: string;
  title: string;
  group: AreaGroup;
  /** Router modules (as named in coverage-map `components.routers`) that serve this area. */
  routers: string[];
  /** Trust boundaries the area depends on beyond its routers’ own. */
  rows: number[];
  /** Said when the area has no router of its own, so the map can explain itself. */
  note?: string;
}

export const PLATFORM_AREAS: readonly AreaDecl[] = [
  // ── platform & identity ──
  { id: 'system', title: 'System', group: 'PLATFORM', routers: ['system.routes', 'owner-trace.routes', 'observability.routes'], rows: [7] },
  { id: 'clubs', title: 'Clubs & club workspaces', group: 'PLATFORM', routers: ['club.routes', 'club-admin.routes', 'home.routes', 'team.routes', 'player.routes', 'training.routes', 'analytics.routes'], rows: [5] },
  { id: 'users-roles', title: 'Users, roles & permissions', group: 'PLATFORM', routers: ['membership.routes', 'invitation.routes', 'context.routes'], rows: [6] },
  { id: 'auth-sessions', title: 'Authentication, MFA & sessions', group: 'PLATFORM', routers: ['auth.routes'], rows: [2, 3, 8] },
  // ── football operations ──
  { id: 'transfers', title: 'Transfers', group: 'FOOTBALL', routers: ['transfer-market.routes', 'scouting.routes'], rows: [] },
  { id: 'coach-market', title: 'Coach Market', group: 'FOOTBALL', routers: ['staff-market.routes', 'coaches.routes'], rows: [] },
  {
    id: 'academy', title: 'Academy', group: 'FOOTBALL', routers: ['team.routes', 'player.routes', 'training.routes'], rows: [],
    note: 'The Academy has no router of its own; its teams, players and training are served by the club workspace routers.',
  },
  { id: 'match-center', title: 'Match Center', group: 'FOOTBALL', routers: ['match.routes', 'match-center.routes'], rows: [8] },
  { id: 'familista-league', title: 'Familista League', group: 'FOOTBALL', routers: ['familista-league.routes'], rows: [] },
  // ── data ──
  { id: 'databases', title: 'Databases & tenant data', group: 'DATA', routers: [], rows: [5, 18, 19], note: 'Reached through every router; protected at the boundary rows shown.' },
  { id: 'postgres-rls', title: 'PostgreSQL / RLS', group: 'DATA', routers: [], rows: [18, 5], note: 'The database itself; protected at the boundary rows shown.' },
  { id: 'data-vault', title: 'Data Vault', group: 'DATA', routers: ['fabric.routes'], rows: [16, 35] },
  { id: 'data-fabric', title: 'Data Fabric & data sources', group: 'DATA', routers: ['fabric.routes', 'sources.routes', 'data-pulse.routes'], rows: [17] },
  { id: 'object-storage', title: 'Object storage', group: 'DATA', routers: ['phase-q.routes'], rows: [20, 32] },
  { id: 'uploads-media', title: 'Uploads & media', group: 'DATA', routers: ['phase-q.routes'], rows: [20] },
  // ── interfaces ──
  {
    id: 'apis', title: 'APIs', group: 'INTERFACES', routers: [], rows: [1, 4, 6, 38],
    note: 'Every mounted router; the figures below are the whole API surface.',
  },
  { id: 'realtime', title: 'Realtime & WebSockets', group: 'INTERFACES', routers: ['realtime.routes', 'data-pulse.routes'], rows: [8] },
  { id: 'integrations', title: 'Integrations & webhooks', group: 'INTERFACES', routers: ['billing.routes', 'billing-j.routes', 'phase-p.routes'], rows: [25, 26, 27] },
  // ── AI ──
  {
    id: 'ai-engines', title: 'AI Gateway & AI engines', group: 'AI',
    routers: ['ai.routes', 'ai-data-policy.routes', 'intelligence.routes', 'predictive.routes', 'tactical-ai.routes', 'neuro.routes', 'spatial.routes', 'distributed.routes', 'phase-n.routes'],
    rows: [9, 10],
  },
  { id: 'ml-models', title: 'ML, models & training data', group: 'AI', routers: ['ai-ops.routes', 'phase-l.routes'], rows: [12, 13, 14] },
  { id: 'agents', title: 'Agents & multi-agent systems', group: 'AI', routers: ['automation.routes', 'phase-m.routes', 'ai-ops.routes'], rows: [11] },
  // ── vision & devices ──
  { id: 'video-intelligence', title: 'Video Intelligence', group: 'VISION_DEVICES', routers: ['phase-q.routes', 'vision.routes', 'familista-vision.routes'], rows: [21] },
  { id: 'cameras', title: 'Cameras', group: 'VISION_DEVICES', routers: ['vision.routes', 'familista-vision.routes'], rows: [22] },
  { id: 'devices', title: 'Sensors & devices', group: 'VISION_DEVICES', routers: ['device-session.routes', 'device-infra.routes', 'provisioning.routes', 'telemetry.routes', 'edge.routes'], rows: [23, 24] },
  // ── operations ──
  { id: 'infrastructure', title: 'Infrastructure & services', group: 'OPERATIONS', routers: ['infrastructure.routes'], rows: [19, 30, 33] },
  { id: 'backups', title: 'Backups & disaster recovery', group: 'OPERATIONS', routers: ['phase-o.routes'], rows: [31, 32] },
  { id: 'secrets', title: 'Secrets', group: 'OPERATIONS', routers: [], rows: [28], note: 'Held in the hosting provider and CI, never in the repository.' },
  { id: 'audit-trails', title: 'Audit trails', group: 'OPERATIONS', routers: ['security.routes'], rows: [35] },
  { id: 'cicd', title: 'CI/CD & deployments', group: 'OPERATIONS', routers: [], rows: [29, 30], note: 'GitHub Actions and the deploy gate; no API surface.' },
  { id: 'supply-chain', title: 'Dependencies & supply chain', group: 'OPERATIONS', routers: [], rows: [37, 29], note: 'The lockfile, the registry and the build; no API surface.' },
  { id: 'security-monitoring', title: 'Security events, alerts & monitoring', group: 'OPERATIONS', routers: ['security.routes', 'cybersecurity.routes'], rows: [34, 36] },
];

/** The continuous lifecycle every change passes through, and what proves each stage. */
export interface StageDecl {
  id: string;
  title: string;
  describes: string;
  /** Controls whose status is this stage’s evidence. */
  controls: string[];
  /** Said when part of a stage happens outside what the platform can see. */
  outsideView?: string;
}

export const SECURITY_LIFECYCLE: readonly StageDecl[] = [
  {
    id: 'develop', title: 'New development',
    describes: 'A change adds a router, model, worker, integration or setting.',
    controls: [],
  },
  {
    id: 'register', title: 'Security registration',
    describes: 'Every new component must be mapped onto a trust boundary, or CI fails.',
    controls: ['architecture-fully-mapped', 'coverage-ratchet', 'authz-declared-per-handler', 'owner-rooms-pinned'],
  },
  {
    id: 'controls', title: 'Required controls',
    describes: 'The posture policy names the controls every build must keep.',
    controls: [],
  },
  {
    id: 'tests', title: 'Security tests',
    describes: 'Unit tests pin each control; real PostgreSQL proves RLS, append-only audit and restore.',
    controls: ['backup-restore-drill-in-ci', 'db-rls-pilot', 'db-audit-append-only'],
  },
  {
    id: 'gate', title: 'CI security gate',
    describes: 'Secrets scan, dependency audit and pinned, least-privilege CI on every pull request.',
    controls: ['ci-secret-scanning', 'ci-audit-blocking', 'ci-actions-sha-pinned', 'ci-least-privilege', 'ci-no-expression-injection'],
  },
  {
    id: 'review', title: 'Human review',
    describes: 'Code owners are requested on security-relevant files.',
    controls: ['codeowners'],
    outsideView: 'Branch protection and review approvals are GitHub settings the platform cannot read.',
  },
  {
    id: 'merge', title: 'Merge',
    describes: 'A reviewed, green change is merged to main.',
    controls: [],
    outsideView: 'Merges happen on GitHub; the platform cannot observe them.',
  },
  {
    id: 'deploy', title: 'Deploy',
    describes: 'Only a commit that passed CI on main is deployed.',
    controls: ['deploy-gated-by-ci'],
  },
  {
    id: 'monitor', title: 'Runtime monitoring',
    describes: 'Collectors record security events; alerts reach the owner.',
    controls: ['security-event-log', 'security-alert-delivery', 'log-redaction'],
  },
  {
    id: 'evidence', title: 'Audit evidence',
    describes: 'A hash-chained trail the database refuses to rewrite.',
    controls: ['audit-hash-chain', 'db-audit-append-only', 'ai-call-audited'],
  },
];

/** Labels for the figures adapters report. The adapters report keys; the screen shows these. */
export const METRIC_LABELS: Readonly<Record<string, string>> = {
  'api.routers': 'Mounted routers',
  'api.handlers': 'API handlers',
  'api.public': 'Public handlers (reviewed)',
  'api.routerWideAuth': 'Routers authenticated as a whole',
  'api.dormant': 'Dormant route modules',
  'api.outbound': 'Outbound call sites',
  'authz.roles': 'Handlers limited to named roles',
  'authz.member': 'Handlers open to any club member',
  'authz.scoped': 'Handlers scoped to a resource',
  'authz.owner': 'Platform-owner handlers',
  'authz.public': 'Public handlers',
  'tenancy.idParameters': 'Route ids that name a club resource',
  'tenancy.guarded': 'Guarded by the tenant check',
  'tenancy.exempt': 'Exempt by review',
  'tenancy.unguarded': 'Unguarded',
  'mfa.requiredForAdmins': 'MFA required for administrators',
  'mfa.admins': 'Active administrators',
  'mfa.adminsEnrolled': 'Administrators enrolled in MFA',
  'rls.mode': 'Application context mode',
  'rls.enforced': 'Database enforcement',
  'rls.tables': 'Pilot tables',
  'rls.systemPaths': 'Named cross-club paths',
  'rls.observations': 'Queries seen without a context',
  'ai.calls24h': 'AI calls in 24 hours',
  'ai.refused24h': 'AI calls refused in 24 hours',
  'ai.failed24h': 'AI calls failed in 24 hours',
  'ai.pendingApprovals': 'AI actions awaiting approval',
  'devices.events24h': 'Device security events in 24 hours',
  'devices.events7d': 'Device security events in 7 days',
  'crypto.primitives': 'Cryptographic primitives in use',
  'secrets.declared': 'Settings declared',
  'secrets.secretNamed': 'Settings holding a secret',
  'secrets.inline': 'Secrets written into configuration',
  'backups.lastSuccess': 'Last successful backup',
  'backups.failed7d': 'Failed backups in 7 days',
  'backups.ageHours': 'Hours since the last backup',
  'audit.chainEvents': 'Hash-chained audit events',
  'audit.lastAppended': 'Last audit event',
  'audit.egressRecords': 'AI calls recorded',
  'events.total24h': 'Security events in 24 hours',
  'events.critical24h': 'Critical events in 24 hours',
  'events.warning24h': 'Warnings in 24 hours',
  'events.total7d': 'Security events in 7 days',
  'events.signals24h': 'Security signals in 24 hours',
  'supply.packages': 'Locked packages',
  'supply.integrity': 'Packages with an integrity hash',
  'supply.actionsPinned': 'CI actions pinned to a commit',
  'infra.datastores': 'Private datastores',
  'monitor.written': 'Signals recorded since start',
  'monitor.suppressed': 'Duplicates suppressed since start',
  'monitor.overCap': 'Held back by the flood cap',
  'monitor.refused': 'Signals the store refused',
  'monitor.uptimeHours': 'Hours this instance has been watching',
};

/** Human names for SecurityEvent kinds. The kind itself is an identifier and is shown beside it. */
export const EVENT_KIND_LABELS: Readonly<Record<string, string>> = {
  LOGIN_SUCCESS: 'Sign-in succeeded',
  LOGIN_FAILED: 'Sign-in failed',
  LOGIN_LOCKED: 'Account locked after failed sign-ins',
  TENANT_MISMATCH: 'Request named another club’s data',
  RATE_LIMITED: 'Rate limit reached',
  SUSPICIOUS_PAYLOAD: 'Suspicious request payload',
  DEVICE_REJECTED: 'Device message rejected',
  DEVICE_REPLAY: 'Device message replayed',
  DEVICE_TS_SKEW: 'Device clock out of range',
  PROMPT_INJECTION_SUSPECT: 'Possible prompt injection',
  UNAUTHORIZED_AI_ATTEMPT: 'Unauthorised AI action attempted',
  AUDIT_CHAIN_VERIFIED: 'Audit chain verified',
  AUDIT_CHAIN_BROKEN: 'Audit chain failed verification',
  APPROVAL_REQUESTED: 'AI action approval requested',
  APPROVAL_GRANTED: 'AI action approved',
  APPROVAL_REJECTED: 'AI action rejected',
  APPROVAL_EXPIRED: 'AI action approval expired',
  CUSTOM: 'Other security event',
};

export function domainById(id: string): DomainDecl | undefined {
  return SECURITY_DOMAINS.find((d) => d.id === id);
}

/** Warnings an adapter may raise. Each is a fact the owner can act on, never decoration. */
export const WARNING_TEXT: Readonly<Record<string, string>> = {
  'rls.observations': 'Some pilot-table queries ran without a database context. Resolve them before enforcement is turned on.',
  'rls.enforcedWithoutContext': 'The database enforces RLS but the application is not sending a context: pilot tables will refuse every query.',
  'tenancy.unguarded': 'Some route ids that name a club resource are neither guarded nor exempted by review.',
  'events.tenantMismatch': 'A request named another club’s data in the last 24 hours.',
  'events.critical': 'Critical security events were recorded in the last 24 hours.',
  'alerts.noRecipient': 'No alert recipient is configured: security alerts cannot reach the owner.',
  'alerts.stopped': 'The security alert dispatcher is not running in this instance.',
  'backups.never': 'No successful scheduled backup has been recorded.',
  'backups.stale': 'The last successful backup is older than the alerting threshold.',
  'backups.failed': 'A scheduled backup failed in the last 7 days.',
  'audit.chainBroken': 'The audit hash chain failed verification in the last 24 hours.',
  'mfa.adminsNotEnrolled': 'MFA is required for administrators, but not every active administrator is enrolled.',
  'secrets.inline': 'A secret-named setting is written into configuration rather than held as a secret.',
  'monitor.refused': 'The event store refused security signals since this instance started.',
  'supply.integrity': 'Some locked packages carry no integrity hash.',
  'infra.publicDatastore': 'A datastore is reachable outside the private network.',
};

/** The small vocabulary configuration states are reported in. Values only — never a secret. */
export const CONFIG_VALUES = [
  'On', 'Off', 'Observe', 'Enforced', 'Not enforced', 'Unknown',
  'Configured', 'Not configured', 'Running', 'Not running',
  'Closed — no secret configured', 'Open — signed callbacks only',
] as const;
export type ConfigValue = typeof CONFIG_VALUES[number];

/** Labels for configuration items. */
export const CONFIG_LABELS: Readonly<Record<string, string>> = {
  'mfa.requiredForAdmins': 'MFA required for administrators',
  'rls.mode': 'Application context (DB_RLS_CONTEXT)',
  'rls.enforcement': 'Database enforcement',
  'alerts.dispatcher': 'Alert dispatcher',
  'alerts.recipient': 'Alert recipient',
  'webhooks.vision': 'Vision worker callbacks',
  'webhooks.clip': 'Clip worker callbacks',
};

/** Why a domain has no live layer, when it has none. */
export const NO_LIVE_TEXT: Readonly<Record<string, string>> = {
  'not-instrumented': 'No runtime security signal is recorded for this domain yet. Its protection is proven at build time.',
  'build-time': 'This domain is enforced at build time, before anything is deployed; there is no runtime signal to show.',
  'see-infrastructure': 'Live infrastructure health is measured in Infrastructure City; security signals for it are not recorded here yet.',
  'no-events': 'No security event is recorded for this domain yet.',
  'declared-not-produced': 'Signals are declared for this domain but no collector produces them yet.',
};

/** RLS rollout stages, in order. */
export const RLS_STAGES: ReadonlyArray<{ id: string; title: string; describes: string }> = [
  { id: 'installed', title: 'Installed', describes: 'Policies exist in the database; the application sends no context and nothing is enforced.' },
  { id: 'observe', title: 'Observe', describes: 'The application reports queries that would lack a context; nothing is enforced.' },
  { id: 'context', title: 'Context on', describes: 'Every pilot-table query carries its club context; the database still does not enforce.' },
  { id: 'enforced', title: 'Enforced', describes: 'The database refuses any pilot-table query outside its club or a named system path.' },
];
