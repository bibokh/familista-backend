// What the agent runtime decides, as plain data
// ─────────────────────────────────────────────────────────────────────────────
// The behaviour of the ten agents the platform runs, taken as one snapshot:
// each agent's runtime profile, the identity a job runs as, and the decision
// authorizeAgentJob reaches for every shape of job — analysis, every action the
// approval classifier knows (by job kind and by an explicit approval flag), a job
// with no club — with the kill switch released and engaged.
//
// tests/fixtures/agents/runtime-baseline.json is this snapshot as it was
// recorded on main 86c1ca2, before the runtime read the agent registry. A
// change to how agents are authorised is behaviour-preserving exactly when the
// snapshot still equals it (tests/agents-registry.unit.test.ts, section 6).

import type { AIAgent, Prisma } from '@prisma/client';
import { ACTION_TOOLS, AGENT_PROFILES, agentIdentity, authorizeAgentJob } from '../../src/platform/intelligence/agent-jobs';
import { engageKillSwitch, releaseKillSwitch } from '../../src/platform/intelligence/agents';

/** The agents the platform runs, in the order the runtime lists them. */
export const RUNNING_AGENTS: readonly AIAgent[] = [
  'CLUB_MANAGER', 'TACTICAL', 'MEDICAL', 'SCOUTING', 'FINANCE', 'TRAINING', 'MATCH_OPS', 'COMMS', 'DEVICE_MGMT', 'BIG_DATA',
];

const APPROVAL_KINDS = ['DELETE_DATA', 'CHANGE_TACTICS_LIVE', 'MASS_MESSAGE', 'APPROVE_TRANSFER', 'MEDICAL_RECOMMENDATION', 'PAYMENT_ACTION', 'OTHER'];

/** Every shape of job: analysis, each action by its kind, each action by an explicit flag, and a job with no club. */
export const JOB_CASES: ReadonlyArray<{ label: string; kind: string; input: Prisma.JsonValue; clubId: string }> = [
  ...['MATCH_REVIEW', 'WEEKLY_DIGEST', 'FATIGUE_SCAN', ''].map((kind) => ({ label: `kind:${kind || '(empty)'}`, kind, input: {}, clubId: 'club-1' })),
  ...['DATA_PURGE', 'DELETE_PLAYER', 'CHANGE_TACTICS_LIVE', 'TACTICS_LIVE', 'MASS_MESSAGE_PARENTS', 'COMMS_BROADCAST',
    'APPROVE_TRANSFER_FINAL', 'TRANSFER_FINALISE', 'MEDICAL_RECOMMENDATION_RTP', 'PAYMENT_RUN', 'PAYOUT_BONUS',
  ].map((kind) => ({ label: `kind:${kind}`, kind, input: {}, clubId: 'club-1' })),
  ...[...APPROVAL_KINDS, 'NOT_A_KIND'].map((k) => ({ label: `flag:${k}`, kind: 'ANALYSIS', input: { requiresApproval: true, approvalKind: k }, clubId: 'club-1' })),
  { label: 'flag:(no kind)', kind: 'ANALYSIS', input: { requiresApproval: true }, clubId: 'club-1' },
  { label: 'no-club', kind: 'MATCH_REVIEW', input: {}, clubId: '' },
];

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** The runtime's behaviour for the running agents, with the kill switch released and then engaged. */
export function runtimeSnapshot() {
  const decide = () => Object.fromEntries(RUNNING_AGENTS.map((agent) => [agent, Object.fromEntries(
    JOB_CASES.map((c) => [c.label, plain(authorizeAgentJob({ agent, kind: c.kind, input: c.input, clubId: c.clubId }))]),
  )]));
  releaseKillSwitch();
  const released = decide();
  engageKillSwitch('runtime baseline');
  let engaged;
  try { engaged = decide(); } finally { releaseKillSwitch(); }
  return {
    runtimeAgents: Object.keys(AGENT_PROFILES),
    profiles: plain(AGENT_PROFILES) as Record<string, { tools: string[]; dataClass: string }>,
    actionTools: plain(ACTION_TOOLS),
    identities: Object.fromEntries(RUNNING_AGENTS.map((agent) => [agent, plain(agentIdentity(agent, 'club-1'))])),
    decisions: { killSwitchReleased: released, killSwitchEngaged: engaged },
  };
}
