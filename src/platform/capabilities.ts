// What SYSTEM can actually do, and what it only knows about
// ─────────────────────────────────────────────────────────────────────────────
// A command centre full of buttons that do nothing is worse than a read-only
// dashboard, because the operator learns not to trust any of them. So every
// control SYSTEM offers is declared here with the truth about it:
//
//   LIVE          wired end to end. Pressing it changes the platform.
//   PARTIAL       the action exists but is narrower than its name suggests, or
//                 needs a step this platform cannot take alone. The reason says
//                 which.
//   NOT_AVAILABLE nothing behind it yet. Shown, greyed, with the reason — so an
//                 operator knows the capability is planned rather than broken,
//                 and nobody wires a fake handler to make a screen look busy.
//
// And with how dangerous it is, because a confirmation dialog that appears for
// everything is a dialog nobody reads:
//
//   SAFE      open, inspect, analyse.
//   SENSITIVE revoke a session, suspend a membership, flip an experimental flag.
//   CRITICAL  suspend a club, roll a release back, widen an agent's autonomy.
//   PROTECTED irreversible, or reaching a club's last owner. Never one click.

export type CapabilityStatus = 'LIVE' | 'PARTIAL' | 'NOT_AVAILABLE';
export type RiskLevel = 'SAFE' | 'SENSITIVE' | 'CRITICAL' | 'PROTECTED';

export interface Capability {
  key: string;
  module: string;
  label: string;
  status: CapabilityStatus;
  risk: RiskLevel;
  /** Why it is not LIVE, or what it does when it is. Shown in the UI verbatim. */
  note: string;
  /** The endpoint that performs it, when one exists. */
  endpoint?: string;
}

export const CAPABILITIES: ReadonlyArray<Capability> = Object.freeze([
  // ── clubs ──────────────────────────────────────────────────────────────────
  { key: 'club.inspect', module: 'clubs', label: 'Inspect club', status: 'LIVE', risk: 'SAFE',
    note: 'Teams, players, memberships and ownership, counted live.', endpoint: 'GET /system/clubs' },
  { key: 'club.health', module: 'clubs', label: 'Inspect club health', status: 'PARTIAL', risk: 'SAFE',
    note: 'Access and ownership are real; usage health needs the analytics stream.' },
  { key: 'club.ownership', module: 'clubs', label: 'Inspect ownership state', status: 'LIVE', risk: 'SAFE',
    note: 'Which clubs have an active owner, and which do not.', endpoint: 'GET /system/clubs' },
  { key: 'club.create', module: 'clubs', label: 'Create club', status: 'PARTIAL', risk: 'CRITICAL',
    note: 'Club creation exists in club administration; it is not exposed to SYSTEM yet.' },
  { key: 'club.suspend', module: 'clubs', label: 'Suspend club', status: 'NOT_AVAILABLE', risk: 'PROTECTED',
    note: 'No club suspension state exists in the schema. Adding one is a deliberate migration.' },

  // ── people & access ────────────────────────────────────────────────────────
  { key: 'people.inspect', module: 'people', label: 'Inspect person and memberships', status: 'LIVE', risk: 'SAFE',
    note: 'Identity and every active membership. No credential is ever selected.', endpoint: 'GET /system/people' },
  { key: 'people.invite', module: 'people', label: 'Invite to a club', status: 'PARTIAL', risk: 'SENSITIVE',
    note: 'Invitations are live; a club administrator sends them. Delivery needs a mail provider.',
    endpoint: 'POST /invitations' },
  { key: 'people.invite.resend', module: 'people', label: 'Resend invitation', status: 'PARTIAL', risk: 'SENSITIVE',
    note: 'Mints a new token and retires the old one. Needs a mail provider to deliver.',
    endpoint: 'POST /invitations/:id/resend' },
  { key: 'people.invite.revoke', module: 'people', label: 'Revoke invitation', status: 'LIVE', risk: 'SENSITIVE',
    note: 'The link stops working immediately.', endpoint: 'DELETE /invitations/:id' },
  { key: 'people.membership.suspend', module: 'people', label: 'Suspend membership', status: 'LIVE', risk: 'CRITICAL',
    note: 'Ends the person\'s sessions for that club. Refused for a club\'s last owner.',
    endpoint: 'DELETE /memberships/:id' },
  { key: 'people.sessions.revoke', module: 'people', label: 'Revoke active sessions', status: 'LIVE', risk: 'CRITICAL',
    note: 'Runs automatically when a person\'s last membership of a club ends.' },

  // ── intelligence ───────────────────────────────────────────────────────────
  { key: 'ai.inspect', module: 'agents', label: 'Inspect agents and tools', status: 'LIVE', risk: 'SAFE',
    note: 'Identity, scope, tools, autonomy and environment.', endpoint: 'GET /system/intelligence' },
  { key: 'ai.killswitch', module: 'agents', label: 'Global AI action kill switch', status: 'LIVE', risk: 'CRITICAL',
    note: 'Stops autonomous ACTIONS platform-wide. Reading and recommending continue; Familista stays up.',
    endpoint: 'POST /system/agents/kill-switch' },
  { key: 'ai.autonomy', module: 'agents', label: 'Change an agent\'s autonomy', status: 'PARTIAL', risk: 'CRITICAL',
    note: 'The autonomy model is enforced; agents are declared in code, so changes are a deploy.' },
  { key: 'ai.runs', module: 'agents', label: 'Runs, logs and cost', status: 'PARTIAL', risk: 'SAFE',
    note: 'Agent jobs and decisions are recorded; per-run cost is not attributed yet.' },
  { key: 'ai.models', module: 'models', label: 'Model registry', status: 'PARTIAL', risk: 'SAFE',
    note: 'The gateway registry is live in-process; persisted model versions and evaluations are not wired.',
    endpoint: 'GET /system/intelligence' },

  // ── innovation ─────────────────────────────────────────────────────────────
  { key: 'flags.read', module: 'flags', label: 'Inspect feature flags', status: 'LIVE', risk: 'SAFE',
    note: 'Every flag, its audience, its environments and who it reaches.', endpoint: 'GET /system/innovation' },
  { key: 'flags.toggle', module: 'flags', label: 'Enable / disable a flag', status: 'LIVE', risk: 'SENSITIVE',
    note: 'Takes effect immediately for every request after it.', endpoint: 'POST /system/flags/:key' },
  { key: 'flags.target', module: 'flags', label: 'Target owner / users / clubs / percentage', status: 'LIVE', risk: 'SENSITIVE',
    note: 'Hidden by default: a flag reaches nobody until an audience is chosen.', endpoint: 'POST /system/flags/:key' },
  { key: 'flags.rollback', module: 'flags', label: 'Stop a rollout', status: 'LIVE', risk: 'CRITICAL',
    note: 'Disabling a flag removes the feature from everyone on the next request.', endpoint: 'POST /system/flags/:key' },
  { key: 'exp.read', module: 'experiments', label: 'Inspect experiments', status: 'LIVE', risk: 'SAFE',
    note: 'Hypothesis, metrics, models, status and decision.', endpoint: 'GET /system/innovation' },
  { key: 'exp.transition', module: 'experiments', label: 'Start / pause / decide / archive', status: 'LIVE', risk: 'SENSITIVE',
    note: 'Follows the fixed transition table; a rejected experiment keeps its history.',
    endpoint: 'POST /system/experiments/:id/decide' },
  { key: 'lab.private', module: 'lab', label: 'Owner-only private testing', status: 'LIVE', risk: 'SAFE',
    note: 'A LAB flag is invisible in production, to everybody, including the owner.' },
  { key: 'release.promote', module: 'releases', label: 'Promote a release', status: 'PARTIAL', risk: 'CRITICAL',
    note: 'Stages and canary targeting are modelled here; the pipeline itself belongs to the deploy provider.' },

  // ── platform ───────────────────────────────────────────────────────────────
  { key: 'security.events', module: 'security', label: 'Inspect security events', status: 'LIVE', risk: 'SAFE',
    note: 'Tenant mismatches, login failures and suspicious payloads.', endpoint: 'GET /system/security' },
  { key: 'audit.read', module: 'audit', label: 'Inspect the audit trail', status: 'LIVE', risk: 'SAFE',
    note: 'Every membership and invitation change, with actor, before and after.', endpoint: 'GET /system/audit' },
  { key: 'governance.policy', module: 'governance', label: 'Evaluate a policy decision', status: 'LIVE', risk: 'SAFE',
    note: 'Jurisdiction packs, classification and the decision they produce, evaluated without changing anything.',
    endpoint: 'GET /system/governance' },
  { key: 'governance.retention', module: 'governance', label: 'Retention and consent', status: 'PARTIAL', risk: 'SENSITIVE',
    note: 'Policies and consent records exist; automatic enforcement sweeps do not run yet.' },
  { key: 'infra.jobs', module: 'automation', label: 'Inspect jobs and workers', status: 'PARTIAL', risk: 'SAFE',
    note: 'Worker health is recorded; retry and pause controls are not exposed to SYSTEM.' },
  { key: 'backup.verify', module: 'backup', label: 'Verify backup / restore test', status: 'NOT_AVAILABLE', risk: 'PROTECTED',
    note: 'Backups are the database provider\'s. Familista has no restore-verification hook yet.' },
  { key: 'archive.inspect', module: 'data-archive', label: 'Inspect archive and recovery points', status: 'NOT_AVAILABLE', risk: 'SAFE',
    note: 'No archival store exists yet — the contracts are declared, nothing is written.' },
  { key: 'analytics.platform', module: 'platform-analytics', label: 'DAU / WAU / retention', status: 'NOT_AVAILABLE', risk: 'SAFE',
    note: 'Needs the analytics event stream. Sign-ins are counted today; sessions are not.' },
]);

export function capabilitiesFor(module: string): Capability[] {
  return CAPABILITIES.filter((c) => c.module === module);
}

export function capability(key: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.key === key);
}

/** A count per status, for the readiness strip at the top of the command centre. */
export function capabilitySummary(): Record<CapabilityStatus, number> {
  return CAPABILITIES.reduce((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, { LIVE: 0, PARTIAL: 0, NOT_AVAILABLE: 0 } as Record<CapabilityStatus, number>);
}
