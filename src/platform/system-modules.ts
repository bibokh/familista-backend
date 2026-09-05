// SYSTEM / FOS — the platform's own operating surface
// ─────────────────────────────────────────────────────────────────────────────
// Familista is two products sharing one codebase, and they never mix:
//
//   SYSTEM  the management, intelligence and operation of the PLATFORM itself.
//           Its audience is the platform owner. Clubs never see it.
//   CLUBS   football operations performed by clubs using Familista.
//           Its audience is club staff. It never contains platform machinery.
//
// This file is the SYSTEM side of that boundary, stated as data so the
// navigation, the routing and the tests all read the same list rather than
// three copies of it that will disagree.
//
// ── Honesty about readiness
//
// A module is declared with what actually backs it TODAY:
//
//   LIVE            real data, served from real rows.
//   PARTIAL         some panels are real, others are not yet instrumented.
//   NOT_INSTRUMENTED the contract exists; nothing measures it yet.
//
// A NOT_INSTRUMENTED module renders an explicit empty state naming what is
// missing. It must never render an invented number. A platform dashboard that
// lies is worse than one that is honestly blank, because somebody will make a
// decision on it.

export type ModuleReadiness = 'LIVE' | 'PARTIAL' | 'NOT_INSTRUMENTED';

export interface SystemModule {
  /** Stable identifier — a route segment and a test's handle. Never renamed. */
  key: string;
  /** English label. Goes through the i18n catalogue like every other string. */
  label: string;
  group: 'COMMAND' | 'PEOPLE' | 'INSIGHT' | 'PLATFORM' | 'INTELLIGENCE' | 'GOVERNANCE' | 'CONTINUITY' | 'INNOVATION';
  readiness: ModuleReadiness;
  /** What backs it, or what would have to exist for it to be LIVE. */
  backing: string;
}

/**
 * The permanent SYSTEM module list.
 *
 * Adding a capability to Familista adds a row here. Removing one is a decision
 * about the platform, not a tidy-up — the keys are referenced by navigation,
 * by tests and, in time, by release records.
 */
export const SYSTEM_MODULES: ReadonlyArray<SystemModule> = Object.freeze([
  { key: 'overview',      label: 'Platform Command Center', group: 'COMMAND',      readiness: 'LIVE',
    backing: 'counts of clubs, teams, users, memberships and invitations, read live' },
  { key: 'clubs',         label: 'Clubs Management',        group: 'COMMAND',      readiness: 'LIVE',
    backing: 'Club, Team, Membership' },
  { key: 'people',        label: 'People & Access',         group: 'PEOPLE',       readiness: 'LIVE',
    backing: 'User, Membership, ClubInvitation, MembershipAuditLog' },
  { key: 'platform-analytics', label: 'Platform Analytics', group: 'INSIGHT',      readiness: 'NOT_INSTRUMENTED',
    backing: 'needs the analytics event stream (Phase 3) before DAU/WAU/MAU mean anything' },
  { key: 'product-analytics',  label: 'Product Analytics',  group: 'INSIGHT',      readiness: 'NOT_INSTRUMENTED',
    backing: 'needs feature-usage events; deliberately separate from audit' },
  { key: 'infrastructure', label: 'Infrastructure',         group: 'PLATFORM',     readiness: 'PARTIAL',
    backing: 'process and database reachability are real; host metrics are not collected' },
  { key: 'health',        label: 'Platform Health',         group: 'PLATFORM',     readiness: 'PARTIAL',
    backing: 'health checks and worker heartbeats exist; SLOs do not' },
  { key: 'security',      label: 'Security Center',         group: 'PLATFORM',     readiness: 'LIVE',
    backing: 'SecurityEvent, login attempts, tenant mismatches' },
  { key: 'audit',         label: 'Audit Center',            group: 'PLATFORM',     readiness: 'LIVE',
    backing: 'MembershipAuditLog, PlatformAuditLog, audit chain' },
  { key: 'intelligence',  label: 'Familista Intelligence',  group: 'INTELLIGENCE', readiness: 'PARTIAL',
    backing: 'AI gateway and model registry contracts; engines are declared, not all implemented' },
  { key: 'agents',        label: 'AI Agent Control',        group: 'INTELLIGENCE', readiness: 'PARTIAL',
    backing: 'agent identity, tool registry, autonomy levels and kill switch; execution history is thin' },
  { key: 'governance',    label: 'Global Governance',       group: 'GOVERNANCE',   readiness: 'PARTIAL',
    backing: 'retention, consent and GDPR requests exist; jurisdiction packs are declared' },
  { key: 'data-archive',  label: 'Data & Archive',          group: 'CONTINUITY',   readiness: 'NOT_INSTRUMENTED',
    backing: 'needs the archival contracts of Phase 7 to have something to show' },
  { key: 'backup',        label: 'Backup & Recovery',       group: 'CONTINUITY',   readiness: 'NOT_INSTRUMENTED',
    backing: 'provider-side backups exist; restore verification is not wired to this platform' },
  { key: 'lab',           label: 'Innovation Lab',          group: 'INNOVATION',   readiness: 'LIVE',
    backing: 'environment resolution and owner-only visibility' },
  { key: 'experiments',   label: 'Experiments',             group: 'INNOVATION',   readiness: 'LIVE',
    backing: 'experiment registry' },
  { key: 'flags',         label: 'Feature Flags',           group: 'INNOVATION',   readiness: 'LIVE',
    backing: 'FeatureFlag and the targeting resolver' },
  { key: 'releases',      label: 'Release Management',      group: 'INNOVATION',   readiness: 'PARTIAL',
    backing: 'release stages and canary targeting are modelled; the pipeline is the deploy provider\'s' },
  { key: 'models',        label: 'Model Management',        group: 'INTELLIGENCE', readiness: 'PARTIAL',
    backing: 'AIModel and the model registry contract' },
  { key: 'automation',    label: 'Automation',              group: 'PLATFORM',     readiness: 'PARTIAL',
    backing: 'the existing automation workers' },
  { key: 'approvals',     label: 'Approval Center',         group: 'GOVERNANCE',   readiness: 'LIVE',
    backing: 'AIApprovalRequest' },
  { key: 'notifications', label: 'Notifications',           group: 'PLATFORM',     readiness: 'PARTIAL',
    backing: 'the notification dispatch worker' },
  { key: 'integrations',  label: 'Integrations',            group: 'PLATFORM',     readiness: 'NOT_INSTRUMENTED',
    backing: 'no integration registry exists yet' },
  { key: 'settings',      label: 'Platform Settings',       group: 'PLATFORM',     readiness: 'LIVE',
    backing: 'PlatformAdmin, feature flags, environment' },
]);

export function systemModule(key: string): SystemModule | undefined {
  return SYSTEM_MODULES.find((m) => m.key === key);
}

/**
 * The club-side modules, named here for one reason: so a test can prove the two
 * lists never intersect. A platform module must never appear in a club
 * workspace, and a club module must never appear in SYSTEM.
 */
export const CLUB_MODULES: ReadonlyArray<string> = Object.freeze([
  'club-home', 'first-team', 'academy', 'players', 'training-centre', 'tactical-os',
  'match-center', 'competitions', 'familista-league', 'medical-center', 'player-intelligence',
  'ai-coach', 'ai-tactical-brain', 'ai-scouting', 'video-intelligence', 'transfers',
  'coach-market', 'club-staff', 'club-people-access', 'club-analytics', 'reports',
  'club-documents', 'club-history', 'club-notifications', 'club-settings',
]);
