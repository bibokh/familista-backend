/**
 * The AI read authorization expectations, written out by hand, and the records
 * both suites seed: tests/ai-read-authorization.unit.test.ts (the real app over
 * an in-memory database with SQL's NULL semantics) and
 * tests/ai-read-authorization.integration.test.ts (the real app over a freshly
 * migrated PostgreSQL). Nothing here is derived from src/security/ai-read-policy.ts:
 * the matrix, each record's classes and each expected tier are stated here, and
 * the unit suite pins the module against them.
 */

export type Cls = 'OPERATIONAL' | 'SCOUTING' | 'FINANCE' | 'MEDICAL';
export type Tier = 'FULL' | 'SUMMARY' | 'NONE';
export const ROLES = ['SUPER_ADMIN', 'CLUB_ADMIN', 'MANAGER', 'HEAD_COACH', 'ASSISTANT_COACH', 'COACH', 'ANALYST', 'MEDICAL_STAFF', 'SCOUT', 'PARENT', 'PLAYER'] as const;
export type Role = typeof ROLES[number];

const F = 'FULL' as const, N = 'NONE' as const;
/** Medical records are for medical staff alone; no role is granted a summary. */
export const EXPECT: Record<Role, Record<Cls, 'FULL' | 'NONE'>> = {
  SUPER_ADMIN:     { OPERATIONAL: F, SCOUTING: F, FINANCE: F, MEDICAL: N },
  CLUB_ADMIN:      { OPERATIONAL: F, SCOUTING: F, FINANCE: F, MEDICAL: N },
  MANAGER:         { OPERATIONAL: F, SCOUTING: F, FINANCE: F, MEDICAL: N },
  HEAD_COACH:      { OPERATIONAL: F, SCOUTING: F, FINANCE: N, MEDICAL: N },
  ASSISTANT_COACH: { OPERATIONAL: F, SCOUTING: N, FINANCE: N, MEDICAL: N },
  COACH:           { OPERATIONAL: F, SCOUTING: N, FINANCE: N, MEDICAL: N },
  ANALYST:         { OPERATIONAL: F, SCOUTING: F, FINANCE: N, MEDICAL: N },
  MEDICAL_STAFF:   { OPERATIONAL: F, SCOUTING: N, FINANCE: N, MEDICAL: F },
  SCOUT:           { OPERATIONAL: N, SCOUTING: F, FINANCE: N, MEDICAL: N },
  PARENT:          { OPERATIONAL: N, SCOUTING: N, FINANCE: N, MEDICAL: N },
  PLAYER:          { OPERATIONAL: N, SCOUTING: N, FINANCE: N, MEDICAL: N },
};
export const NO_ACCESS: Role[] = ['PARENT', 'PLAYER'];
export const READERS: Role[] = ROLES.filter((r) => !NO_ACCESS.includes(r));

// Who the routes let act, and who may act on a record that holds no medical data.
export const MUTE_ROUTE_ROLES: Role[] = ['CLUB_ADMIN', 'HEAD_COACH', 'ANALYST', 'MEDICAL_STAFF'];
export const OPERATIONAL_MUTE_ROLES: Role[] = ['CLUB_ADMIN', 'HEAD_COACH', 'ANALYST'];
export const CANCEL_ROUTE_ROLES: Role[] = ['CLUB_ADMIN', 'HEAD_COACH', 'MEDICAL_STAFF'];
export const OPERATIONAL_CANCEL_ROLES: Role[] = ['CLUB_ADMIN', 'HEAD_COACH'];

export type RecordType = 'job' | 'alert' | 'rec' | 'report' | 'coach';

export interface Spec {
  type:   RecordType;
  label:  string;
  agent:  string | null;
  kind:   string;
  /** Every class a reader must be cleared for to see it. */
  needs:  Cls[];
  /** Its structured content holds a health field. */
  health?: boolean;
  /** No producer declared its kind: it may hold anything. */
  unclassified?: boolean;
  /** An agent job's requester, and what the requester alone must be cleared for. */
  author?: Role;
  authorNeeds?: Cls[];
  /** Why it is classified so. */
  why:    string;
}

export const SPECS: Spec[] = [
  // ── agent jobs
  { type: 'job', label: 'ops',      agent: 'TACTICAL', kind: 'INTELLIGENCE.TACTICAL_ADVISOR', needs: ['OPERATIONAL'], why: 'a declared, server-assembled operational job' },
  { type: 'job', label: 'scouting', agent: 'SCOUTING', kind: 'INTELLIGENCE.RECRUITMENT',      needs: ['SCOUTING'],    why: 'a declared scouting job' },
  { type: 'job', label: 'medical',  agent: 'MEDICAL',  kind: 'INTELLIGENCE.INJURY_RISK_SCAN', needs: ['MEDICAL'],     why: 'the medical agent' },
  { type: 'job', label: 'training-legacy', agent: 'TRAINING', kind: 'INTELLIGENCE.TRAINING_PLANNER', needs: ['OPERATIONAL'], health: true, why: 'an operational job whose input holds injury-risk scores' },
  { type: 'job', label: 'chat',     agent: 'TACTICAL', kind: 'CHAT', unclassified: true, needs: ['OPERATIONAL', 'MEDICAL'], author: 'HEAD_COACH', authorNeeds: ['OPERATIONAL'], why: 'hand-written input: unclassified, its requester excepted' },
  { type: 'job', label: 'finance-human', agent: 'FINANCE', kind: 'FINANCE_SUMMARY', unclassified: true, needs: ['FINANCE', 'MEDICAL'], author: 'CLUB_ADMIN', authorNeeds: ['FINANCE'], why: 'an unclassified finance job' },
  { type: 'job', label: 'medical-human', agent: 'MEDICAL', kind: 'CHAT', unclassified: true, needs: ['MEDICAL'], author: 'HEAD_COACH', why: 'the medical agent, whoever asked' },
  // ── alerts
  { type: 'alert', label: 'ops-agentless', agent: null, kind: 'FORMATION_DRIFT',  needs: ['OPERATIONAL'], why: 'a declared rules-engine alert' },
  { type: 'alert', label: 'fatigue',       agent: null, kind: 'FATIGUE',          needs: ['MEDICAL'],     why: 'the rules engine\'s fatigue alert: a player\'s fatigue index and heart rate' },
  { type: 'alert', label: 'ops',           agent: 'CLUB_MANAGER', kind: 'DEVICE_FLEET_STALE', needs: ['OPERATIONAL'], why: 'a declared anomaly alert' },
  { type: 'alert', label: 'ops-health',    agent: 'CLUB_MANAGER', kind: 'AI_JOB_FAILURE_CLUSTER', needs: ['OPERATIONAL'], health: true, why: 'an operational alert whose payload holds a heart rate' },
  { type: 'alert', label: 'medical',       agent: 'MEDICAL', kind: 'INJURY_RISK',     needs: ['MEDICAL'], why: 'the medical agent' },
  { type: 'alert', label: 'finance',       agent: 'FINANCE', kind: 'FINANCE_ANOMALY', needs: ['FINANCE'], why: 'a declared finance alert' },
  { type: 'alert', label: 'undeclared',    agent: 'TACTICAL', kind: 'PLAYER_UPDATE', unclassified: true, needs: ['OPERATIONAL', 'MEDICAL'], why: 'a kind no producer declared, under a non-medical agent and with no medical word in it' },
  { type: 'alert', label: 'undeclared-agentless', agent: null, kind: 'MANUAL_NOTE', unclassified: true, needs: ['OPERATIONAL', 'MEDICAL'], why: 'an undeclared kind with no agent' },
  { type: 'alert', label: 'scouting-undeclared',  agent: 'SCOUTING', kind: 'SHORTLIST', unclassified: true, needs: ['SCOUTING', 'MEDICAL'], why: 'an undeclared scouting kind: nobody holds both' },
  // ── recommendations
  { type: 'rec', label: 'ops',        agent: 'TACTICAL', kind: 'TACTICAL_ADJUSTMENT', needs: ['OPERATIONAL'], why: 'a declared tactical recommendation' },
  { type: 'rec', label: 'medical',    agent: 'MEDICAL',  kind: 'REST',          needs: ['MEDICAL'], why: 'the medical agent' },
  { type: 'rec', label: 'undeclared', agent: 'TACTICAL', kind: 'SUBSTITUTION',  unclassified: true, needs: ['OPERATIONAL', 'MEDICAL'], why: 'an undeclared kind' },
  { type: 'rec', label: 'scouting',   agent: 'SCOUTING', kind: 'SHORTLIST',     unclassified: true, needs: ['SCOUTING', 'MEDICAL'], why: 'an undeclared scouting kind' },
  // ── reports
  { type: 'report', label: 'ops',        agent: 'MATCH_OPS', kind: 'MATCH_SUMMARY',    needs: ['OPERATIONAL'], why: 'the declared match report' },
  { type: 'report', label: 'medical',    agent: 'MEDICAL',   kind: 'WEEKLY_HEALTH',    needs: ['MEDICAL'], why: 'the medical agent' },
  { type: 'report', label: 'undeclared', agent: 'TACTICAL',  kind: 'OPPONENT_DOSSIER', unclassified: true, needs: ['OPERATIONAL', 'MEDICAL'], why: 'an undeclared kind' },
  { type: 'report', label: 'finance',    agent: 'FINANCE',   kind: 'FINANCE_SUMMARY',  unclassified: true, needs: ['FINANCE', 'MEDICAL'], why: 'an undeclared finance kind' },
  // ── coaching recommendations (a closed enum of kinds)
  { type: 'coach', label: 'tactical',        agent: null, kind: 'TACTICAL',     needs: ['OPERATIONAL'], why: 'an operational kind' },
  { type: 'coach', label: 'injury',          agent: null, kind: 'INJURY_RISK',  needs: ['MEDICAL'], why: 'the medical kind' },
  { type: 'coach', label: 'substitution-health', agent: null, kind: 'SUBSTITUTION', needs: ['OPERATIONAL'], health: true, why: 'an operational kind whose payload holds a player\'s condition' },
];

export const specsOf = (type: RecordType) => SPECS.filter((s) => s.type === type);
export const spec = (type: RecordType, label: string) => SPECS.find((s) => s.type === type && s.label === label)!;

/** The tier `role` (as user `userRole`) must get on `s`, from the hand-written matrix. */
export function expectTier(role: Role, s: Spec): Tier {
  const cleared = (cs: Cls[]) => cs.every((c) => EXPECT[role][c] === 'FULL');
  const visible = cleared(s.needs) || (s.author === role && !!s.authorNeeds && cleared(s.authorNeeds));
  if (!visible) return 'NONE';
  if (s.health && EXPECT[role].MEDICAL !== 'FULL') return 'SUMMARY';
  return 'FULL';
}

/** May `role` act on `s` (mute, cancel) when the route lets it in at all. */
export function mayAct(role: Role, s: Spec, operationalRoles: Role[]): boolean {
  if (expectTier(role, s) !== 'FULL') return false;
  const medicalClearance = EXPECT[role].MEDICAL === 'FULL';
  const medical = (s.needs.includes('MEDICAL') && (!s.unclassified || s.agent === 'MEDICAL')) || !!s.health;
  if (medical) return medicalClearance;
  return operationalRoles.includes(role) || (!!s.unclassified && medicalClearance);
}

export const C1 = 'aaaaaaaa-0000-4000-8000-000000000001';
export const C2 = 'aaaaaaaa-0000-4000-8000-000000000002';
export const uid = (r: Role, club = C1) => `u-${r.toLowerCase()}-${club.slice(-1)}`;
export const secret = (type: string, label: string, f: string) => `SECRET:${type}:${label}:${f}`;
export const ID = (type: string, label: string, club = C1) => `${type}-${label}-${club.slice(-1)}`;
/** What another club holds: one operational and one medical record of each type. */
export const C2_LABELS: Record<RecordType, string[]> = {
  job: ['ops', 'medical'], alert: ['ops', 'medical'], rec: ['ops', 'medical'], report: ['ops', 'medical'], coach: ['tactical', 'injury'],
};

type Row = Record<string, unknown>;

/**
 * Every seeded record, per Prisma model. Each sensitive field carries a unique
 * marker; a health spec's JSON also carries a health field. createdAt is
 * strictly decreasing so lists and pages are deterministic.
 */
export function buildRecords(t0 = Date.now()): Record<'aIAgentJob' | 'aIAlert' | 'aIRecommendation' | 'aIReport' | 'coachRecommendation', Row[]> {
  const out = { aIAgentJob: [] as Row[], aIAlert: [] as Row[], aIRecommendation: [] as Row[], aIReport: [] as Row[], coachRecommendation: [] as Row[] };
  let i = 0;
  const at = () => new Date(t0 - (++i) * 1000);
  for (const club of [C1, C2]) {
    for (const s of SPECS) {
      if (club === C2 && !C2_LABELS[s.type].includes(s.label)) continue;
      const L = club === C1 ? s.label : `${s.label}-c2`;
      const id = ID(s.type, s.label, club);
      const sec = (f: string) => secret(s.type, L, f);
      if (s.type === 'job') {
        out.aIAgentJob.push({
          id, clubId: club, teamId: null, agent: s.agent, kind: s.kind, status: 'SUCCESS', model: 'm', costTokens: 1, costCents: 0,
          triggeredBy: s.author ? uid(s.author, club) : null, createdAt: at(), startedAt: null, finishedAt: null,
          input: s.health
            ? { context: { players: [{ name: sec('input'), workload: { acwr: 1.4, injuryRiskScore: 0.91, isHighRisk: true } }] } }
            : { prompt: sec('input') },
          output: { text: sec('output') }, error: sec('error'),
        });
      } else if (s.type === 'alert') {
        out.aIAlert.push({
          id, clubId: club, matchId: null, teamId: null, playerId: 'p-1', agent: s.agent, kind: s.kind, severity: 'CRITICAL', status: 'OPEN',
          createdAt: at(), ackedAt: null, ackedBy: null, resolvedAt: null,
          title: sec('title'), message: sec('message'), payload: s.health ? { count: 3, hr: 188, x: sec('payload') } : { x: sec('payload') },
        });
      } else if (s.type === 'rec') {
        out.aIRecommendation.push({
          id, clubId: club, matchId: null, teamId: null, playerId: 'p-1', agent: s.agent, kind: s.kind, status: 'OPEN',
          createdAt: at(), ackedAt: null, ackedBy: null, title: sec('title'), content: { x: sec('content') }, score: 0.9,
        });
      } else if (s.type === 'report') {
        out.aIReport.push({
          id, clubId: club, matchId: null, teamId: null, agent: s.agent, kind: s.kind, createdAt: at(),
          title: sec('title'), content: sec('content'), payload: { x: sec('payload') },
        });
      } else {
        out.coachRecommendation.push({
          id, clubId: club, matchId: null, teamId: null, playerId: 'p-1', agentId: null, kind: s.kind, tacticalImpact: 'LOW', approvalRequestId: null,
          status: 'OPEN', createdAt: at(), ackedAt: null, ackedBy: null, confidence: 0.7,
          title: sec('title'), rationale: sec('rationale'), payload: s.health ? { condition: 41, x: sec('payload') } : { x: sec('payload') },
        });
      }
    }
  }
  return out;
}

// What a list may carry of each type at FULL, and what it never carries.
export interface ListRoute { name: string; url: string; type: RecordType; fullShows: string[]; listHides: string[]; paged: boolean }
export const LISTS: ListRoute[] = [
  { name: 'GET /ai-ops/alerts',          url: '/api/v1/ai-ops/alerts',          type: 'alert',  fullShows: ['title', 'message', 'payload'], listHides: [], paged: true },
  { name: 'GET /ai-ops/recommendations', url: '/api/v1/ai-ops/recommendations', type: 'rec',    fullShows: ['title', 'content'], listHides: [], paged: true },
  { name: 'GET /ai-ops/reports',         url: '/api/v1/ai-ops/reports',         type: 'report', fullShows: ['title'], listHides: ['content', 'payload'], paged: true },
  { name: 'GET /automation/agents/jobs', url: '/api/v1/automation/agents/jobs', type: 'job',    fullShows: [], listHides: ['input', 'output', 'error'], paged: true },
  { name: 'GET /phase-s/intelligence/jobs', url: '/api/v1/phase-s/intelligence/jobs?limit=50', type: 'job', fullShows: [], listHides: ['input', 'output', 'error'], paged: false },
  // The route reads no page or limit (it never has): one page, with its total.
  { name: 'GET /phase-l/coaching/recommendations', url: '/api/v1/phase-l/coaching/recommendations', type: 'coach', fullShows: ['title', 'rationale', 'payload'], listHides: [], paged: false },
];

export interface DetailRoute { name: string; url: (id: string) => string; type: RecordType; fields: string[]; envelope: (body: Row) => Row }
export const DETAILS: DetailRoute[] = [
  { name: 'GET /ai-ops/jobs/:id',              url: (id) => `/api/v1/ai-ops/jobs/${id}`,              type: 'job',    fields: ['input', 'output', 'error'], envelope: (b) => b.data as Row },
  { name: 'GET /automation/agents/jobs/:id',   url: (id) => `/api/v1/automation/agents/jobs/${id}`,   type: 'job',    fields: ['input', 'output', 'error'], envelope: (b) => b.data as Row },
  { name: 'GET /phase-s/intelligence/jobs/:jobId', url: (id) => `/api/v1/phase-s/intelligence/jobs/${id}`, type: 'job', fields: ['input', 'output', 'error'], envelope: (b) => b },
  { name: 'GET /ai-ops/reports/:id',           url: (id) => `/api/v1/ai-ops/reports/${id}`,           type: 'report', fields: ['title', 'content', 'payload'], envelope: (b) => b.data as Row },
];

/** Only the intelligence routes list and open intelligence jobs. */
export const intelligenceOnly = (url: string, s: Spec) => !url.includes('/phase-s/intelligence') || s.kind.startsWith('INTELLIGENCE.');

/** The fields a summary may hold, per type: nothing a reading could be inferred from. */
export const SUMMARY_KEYS: Record<RecordType, string[]> = {
  job:    ['id', 'clubId', 'teamId', 'agent', 'kind', 'status', 'startedAt', 'finishedAt', 'createdAt', 'restricted'],
  alert:  ['id', 'clubId', 'matchId', 'teamId', 'agent', 'kind', 'status', 'createdAt', 'restricted'],
  rec:    ['id', 'clubId', 'matchId', 'teamId', 'agent', 'kind', 'status', 'createdAt', 'restricted'],
  report: ['id', 'clubId', 'matchId', 'teamId', 'agent', 'kind', 'createdAt', 'restricted'],
  coach:  ['id', 'clubId', 'matchId', 'teamId', 'kind', 'status', 'createdAt', 'restricted'],
};

export const itemsOf = (body: Row): Row[] => {
  const d = body.data as Row | Row[] | undefined;
  if (Array.isArray(d)) return d;
  if (Array.isArray(body)) return body as unknown as Row[];
  return ((d?.items ?? body.items ?? (d as Row | undefined)?.insights ?? []) as Row[]);
};
export const totalOf = (body: Row): number | undefined =>
  ((body.meta as Row | undefined)?.total ?? (body.data as Row | undefined)?.total ?? body.total) as number | undefined;
