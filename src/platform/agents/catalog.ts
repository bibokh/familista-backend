// The platform's agents, as manifests
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Foundation, AI-0.1. The ten agents Familista runs today
// (the AIAgent enum, executed by workers/ai-agent.worker.ts) as manifests bound
// to their runtime agent. This is where an agent's permissions are written: the
// runtime derives each agent's egress profile from its RUNNING manifest here —
// its tools, and the highest data class it reads (intelligence/agent-jobs.ts) —
// so changing a manifest changes what the agent may do, in a reviewed pull
// request. Its outputs are the record kinds the read policy declares for it
// (security/ai-read-policy.ts), and tests/agents-registry.unit.test.ts fails the
// moment one drifts from the other. Section 6 of that file holds the ten agents
// to the behaviour recorded before the runtime read this.
//
// A new agent — an education tutor, a commerce assistant, a vision analyst, a
// platform operations agent — joins by adding its manifest here, in a reviewed
// pull request, as DRAFT or LAB. The runtime refuses every job for an agent
// whose manifest is not RUNNING, and only an agent the platform already runs
// can be RUNNING (manifest.ts), so no LAB agent is executed.

import { AutonomyLevel } from '../intelligence/agents';
import { AgentRegistry } from './registry';
import type { AgentManifest } from './manifest';

const ANALYSIS = ['getClub', 'getTeam', 'getPlayers', 'getMatch', 'analyzeOpponent', 'createReport', 'createTrainingDraft'];

const running = (m: Omit<AgentManifest, 'lifecycle' | 'scope' | 'autonomyCeiling' | 'version'>): AgentManifest => ({
  ...m, version: '1.0.0', scope: 'CLUB', lifecycle: 'RUNNING', autonomyCeiling: AutonomyLevel.APPROVE,
});

export const PLATFORM_AGENT_MANIFESTS: readonly AgentManifest[] = Object.freeze([
  running({
    id: 'club.club-manager', title: 'Club Manager', domain: 'CLUB_OPERATIONS', supervisor: 'CLUB_ADMIN',
    purpose: 'An operational snapshot of the club: matches in flight, open alerts and recommendations, the active squad, live device sessions.',
    tools: [...ANALYSIS, 'sendNotification', 'updateAllowedResource'],
    data: { reads: ['PUBLIC', 'INTERNAL'], writes: ['INTERNAL'] },
    outputs: [
      { type: 'alert', kind: 'DEVICE_FLEET_STALE' }, { type: 'alert', kind: 'AI_JOB_FAILURE_CLUSTER' }, { type: 'alert', kind: 'BIGDATA_OUTBOX_BACKLOG' },
    ],
    binding: { legacyAgent: 'CLUB_MANAGER' },
  }),
  running({
    id: 'club.tactical', title: 'Tactical', domain: 'TACTICS', supervisor: 'HEAD_COACH',
    purpose: 'Tactical briefs and adjustments from a match\'s recorded events, formation and phase; the tactical advisor for a team.',
    tools: [...ANALYSIS, 'changeTacticsLive'],
    data: { reads: ['PUBLIC', 'INTERNAL'], writes: ['INTERNAL'] },
    outputs: [
      { type: 'alert', kind: 'TACTICAL_COLLAPSE_RISK' }, { type: 'recommendation', kind: 'TACTICAL_ADJUSTMENT' },
      { type: 'job', kind: 'INTELLIGENCE.TACTICAL_ADVISOR' },
    ],
    binding: { legacyAgent: 'TACTICAL' },
  }),
  running({
    id: 'club.medical', title: 'Medical', domain: 'MEDICAL', supervisor: 'MEDICAL_STAFF',
    purpose: 'Injury-risk screening from condition, medical status and workload, for medical staff to act on.',
    tools: [...ANALYSIS, 'issueMedicalRecommendation'],
    data: { reads: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'], writes: ['RESTRICTED'] },
    outputs: [{ type: 'alert', kind: 'INJURY_RISK' }, { type: 'job', kind: 'INTELLIGENCE.INJURY_RISK_SCAN' }],
    binding: { legacyAgent: 'MEDICAL' },
  }),
  running({
    id: 'club.scouting', title: 'Scouting', domain: 'SCOUTING', supervisor: 'HEAD_COACH',
    purpose: 'Shortlists and recruitment advice from position, age, rating, market value and contract.',
    tools: [...ANALYSIS, 'approveTransfer'],
    data: { reads: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'], writes: ['CONFIDENTIAL'] },
    outputs: [{ type: 'job', kind: 'INTELLIGENCE.RECRUITMENT' }],
    binding: { legacyAgent: 'SCOUTING' },
  }),
  running({
    id: 'club.finance', title: 'Finance', domain: 'FINANCE', supervisor: 'CLUB_ADMIN',
    purpose: 'A profit-and-loss snapshot from payments, invoices and usage, with anomalies raised as alerts.',
    tools: [...ANALYSIS, 'initiatePayment'],
    data: { reads: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'], writes: ['CONFIDENTIAL'] },
    outputs: [{ type: 'alert', kind: 'FINANCE_ANOMALY' }],
    binding: { legacyAgent: 'FINANCE' },
  }),
  running({
    id: 'club.training', title: 'Training', domain: 'TRAINING', supervisor: 'HEAD_COACH',
    purpose: 'A seven-day training microcycle from intensity, upcoming matches and load figures.',
    tools: [...ANALYSIS],
    data: { reads: ['PUBLIC', 'INTERNAL'], writes: ['INTERNAL'] },
    outputs: [{ type: 'job', kind: 'INTELLIGENCE.TRAINING_PLANNER' }],
    binding: { legacyAgent: 'TRAINING' },
  }),
  running({
    id: 'club.match-ops', title: 'Match Operations', domain: 'MATCH_OPERATIONS', supervisor: 'HEAD_COACH',
    purpose: 'The automated match report and match analysis from the recorded timeline and statistics.',
    tools: [...ANALYSIS],
    data: { reads: ['PUBLIC', 'INTERNAL'], writes: ['INTERNAL'] },
    outputs: [{ type: 'report', kind: 'MATCH_SUMMARY' }, { type: 'job', kind: 'INTELLIGENCE.MATCH_ANALYSIS' }],
    binding: { legacyAgent: 'MATCH_OPS' },
  }),
  running({
    id: 'club.comms', title: 'Communications', domain: 'COMMUNICATIONS', supervisor: 'CLUB_ADMIN',
    purpose: 'Drafts club notices for a topic and an audience; sending one waits for a person.',
    tools: [...ANALYSIS, 'sendNotification'],
    data: { reads: ['PUBLIC', 'INTERNAL'], writes: ['INTERNAL'] },
    outputs: [],
    binding: { legacyAgent: 'COMMS' },
  }),
  running({
    id: 'club.device-mgmt', title: 'Device Management', domain: 'DEVICES', supervisor: 'CLUB_ADMIN',
    purpose: 'The state of the club\'s live device sessions and the ones that have gone silent.',
    tools: [...ANALYSIS, 'updateAllowedResource'],
    data: { reads: ['PUBLIC', 'INTERNAL'], writes: ['INTERNAL'] },
    outputs: [],
    binding: { legacyAgent: 'DEVICE_MGMT' },
  }),
  running({
    id: 'club.big-data', title: 'Big Data', domain: 'DATA', supervisor: 'CLUB_ADMIN',
    purpose: 'The state of the club\'s data pipeline and event outbox.',
    tools: [...ANALYSIS],
    data: { reads: ['PUBLIC', 'INTERNAL'], writes: ['INTERNAL'] },
    outputs: [],
    binding: { legacyAgent: 'BIG_DATA' },
  }),
]);

let cached: AgentRegistry | null = null;

/** The platform's registry, built once from the catalog. A manifest that does not validate stops it here. */
export function platformAgentRegistry(): AgentRegistry {
  if (cached) return cached;
  const r = new AgentRegistry();
  for (const m of PLATFORM_AGENT_MANIFESTS) r.register(m);
  cached = r;
  return r;
}
