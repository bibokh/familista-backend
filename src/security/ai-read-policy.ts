// Familista — AI read authorization: who may see what the AI layer produced
// ─────────────────────────────────────────────────────────────────────────
// One policy for every record an AI agent or the AI layer writes, on every
// route that returns one: agent jobs with their input and output, alerts,
// recommendations, reports, anomalies, coaching recommendations and the ARIA
// history. The routes call this module; none of them decides on its own.
//
// What a record IS is decided from structure the platform controls, never from
// what its text happens to say:
//
//   · the agent that produced it (a closed enum, classified below the same way
//     the egress gateway profiles it, agent-jobs.ts);
//   · its kind, but only a kind one of the platform's own producers is declared
//     to write (DECLARED_KINDS). Each entry was classified from the producer's
//     code: what it reads, what it writes. A fatigue alert from the rules engine
//     is medical though no agent raised it.
//   · the structured fields it carries (HEALTH_FIELDS, which reuses the data
//     classes the egress gateway already applies, data-classes.ts): a record
//     whose JSON holds an injury-risk score is medical content wherever it sits.
//
// Anything not positively classified is restricted until somebody classifies
// it, the rule data-classes.ts already applies to features: a kind no producer
// declared, written by a person or by a producer nobody classified, may contain
// anything, so it needs clearance for every class it could hold — its agent's
// and medical. An agent job's own requester may still read their job: what it
// says is the answer to what they asked, from data their role may read.
//
// A role has, per class, FULL or NONE. A record with several classes needs
// FULL on each. Medical records are FULL for medical staff only: not coaching
// staff, not club leadership, not the platform's administrators, and nobody
// else sees that a medical record exists — no kind, no player, no severity.
// SUMMARY is never granted by a role. It is what a reader gets of a record they
// may otherwise read whose structured content holds health data they may not —
// that it exists, under its non-medical kind, and nothing it says — and the
// bare receipt of a job they started but may not read (presentTriggered).
//
// General lists never carry an agent job's raw input, output or error, nor a
// report's body. A record a reader may not see is "not found", whether it is
// another club's or a class the role may not read, so neither its existence
// nor its class is confirmed by asking for it.

import { AIAgent, CoachRecommendationKind, UserRole } from '@prisma/client';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { FACTOR_CLASSES, FEATURE_CLASSES } from '../platform/intelligence/data-classes';

export type AIRecordClass = 'OPERATIONAL' | 'SCOUTING' | 'FINANCE' | 'MEDICAL';
export type AIReadTier = 'FULL' | 'SUMMARY' | 'NONE';
export type AIRecordType = 'alert' | 'recommendation' | 'report' | 'job';

export interface AIReader {
  userId: string;
  clubId: string | null;
  role?:  string | null;
}

type Row = Record<string, unknown>;
type Grant = 'FULL' | 'NONE';

const CLASSES: readonly AIRecordClass[] = ['OPERATIONAL', 'SCOUTING', 'FINANCE', 'MEDICAL'];

/**
 * What each agent's records are about. A Record over the enum, so a new agent
 * does not compile until somebody has classified it.
 */
export const AGENT_RECORD_CLASS: Readonly<Record<AIAgent, AIRecordClass>> = Object.freeze({
  CLUB_MANAGER: 'OPERATIONAL',
  TACTICAL:     'OPERATIONAL',
  MEDICAL:      'MEDICAL',
  SCOUTING:     'SCOUTING',
  FINANCE:      'FINANCE',
  TRAINING:     'OPERATIONAL',
  MATCH_OPS:    'OPERATIONAL',
  COMMS:        'OPERATIONAL',
  DEVICE_MGMT:  'OPERATIONAL',
  BIG_DATA:     'OPERATIONAL',
});

const ALL_AGENTS = Object.keys(AGENT_RECORD_CLASS) as AIAgent[];

export interface DeclaredKind {
  agent:    AIAgent | null;
  kind:     string;
  cls:      AIRecordClass;
  /** The code that writes it, which is what the class was decided from. */
  producer: string;
}

/**
 * Every (agent, kind) the platform's own producers write, by record type, with
 * the class of what that producer puts in it. Kinds are free text in the
 * schema, so this list is the vocabulary: a pair that is not here is
 * unclassified. `tests/ai-read-authorization.unit.test.ts` fails when a
 * producer writes a literal kind that is not declared here.
 */
export const DECLARED_KINDS: Readonly<Record<AIRecordType, readonly DeclaredKind[]>> = Object.freeze({
  alert: [
    // Rules engine: a player's fatigue index and heart rate are health data.
    { agent: null, kind: 'FATIGUE_CRITICAL', cls: 'MEDICAL',     producer: 'services/rules-engine.service.ts' },
    { agent: null, kind: 'FATIGUE',          cls: 'MEDICAL',     producer: 'services/rules-engine.service.ts' },
    { agent: null, kind: 'FORMATION_DRIFT',  cls: 'OPERATIONAL', producer: 'services/rules-engine.service.ts' },
    { agent: null, kind: 'DEVICE_STALE',     cls: 'OPERATIONAL', producer: 'services/rules-engine.service.ts' },
    { agent: null, kind: 'DEVICE_OFFLINE',   cls: 'OPERATIONAL', producer: 'services/rules-engine.service.ts' },
    { agent: null, kind: 'DISCIPLINE',       cls: 'OPERATIONAL', producer: 'services/rules-engine.service.ts' },
    { agent: 'CLUB_MANAGER', kind: 'DEVICE_FLEET_STALE',     cls: 'OPERATIONAL', producer: 'services/anomaly-detector.service.ts' },
    { agent: 'CLUB_MANAGER', kind: 'AI_JOB_FAILURE_CLUSTER', cls: 'OPERATIONAL', producer: 'services/anomaly-detector.service.ts' },
    { agent: 'CLUB_MANAGER', kind: 'BIGDATA_OUTBOX_BACKLOG', cls: 'OPERATIONAL', producer: 'services/anomaly-detector.service.ts' },
    // Squad-level counts only ("n fatigued"), which name nobody.
    { agent: 'TACTICAL', kind: 'TACTICAL_COLLAPSE_RISK', cls: 'OPERATIONAL', producer: 'intel/predictive.service.ts' },
    { agent: 'MEDICAL',  kind: 'INJURY_RISK',            cls: 'MEDICAL',     producer: 'workers/agent-handlers.ts' },
    { agent: 'FINANCE',  kind: 'FINANCE_ANOMALY',        cls: 'FINANCE',     producer: 'workers/agent-handlers.ts' },
  ],
  recommendation: [
    { agent: 'TACTICAL', kind: 'TACTICAL_ADJUSTMENT', cls: 'OPERATIONAL', producer: 'workers/agent-handlers.ts' },
  ],
  report: [
    { agent: 'MATCH_OPS', kind: 'MATCH_SUMMARY', cls: 'OPERATIONAL', producer: 'workers/agent-handlers.ts' },
  ],
  // Jobs whose input the server assembles itself (intelligence.service.ts). The
  // training planner's context carries load figures only (CONFIDENTIAL); a job
  // written before that held more is caught by its fields (HEALTH_FIELDS).
  job: [
    { agent: 'MATCH_OPS', kind: 'INTELLIGENCE.MATCH_ANALYSIS',   cls: 'OPERATIONAL', producer: 'intelligence/intelligence.service.ts' },
    { agent: 'TACTICAL',  kind: 'INTELLIGENCE.TACTICAL_ADVISOR', cls: 'OPERATIONAL', producer: 'intelligence/intelligence.service.ts' },
    { agent: 'SCOUTING',  kind: 'INTELLIGENCE.RECRUITMENT',      cls: 'SCOUTING',    producer: 'intelligence/intelligence.service.ts' },
    { agent: 'TRAINING',  kind: 'INTELLIGENCE.TRAINING_PLANNER', cls: 'OPERATIONAL', producer: 'intelligence/intelligence.service.ts' },
    { agent: 'MEDICAL',   kind: 'INTELLIGENCE.INJURY_RISK_SCAN', cls: 'MEDICAL',     producer: 'intelligence/intelligence.service.ts' },
  ],
});

/** A coaching recommendation's kind is a closed enum: a Record over it. */
export const COACH_KIND_CLASS: Readonly<Record<CoachRecommendationKind, AIRecordClass>> = Object.freeze({
  TACTICAL:               'OPERATIONAL',
  INJURY_RISK:            'MEDICAL',
  SUBSTITUTION:           'OPERATIONAL',
  TACTICAL_ADAPTATION:    'OPERATIONAL',
  MATCH_ADJUSTMENT:       'OPERATIONAL',
  FORMATION_OPTIMIZATION: 'OPERATIONAL',
  CUSTOM:                 'OPERATIONAL',
});

/**
 * Structured field names that carry health data. The RESTRICTED features and
 * score factors of data-classes.ts (the classes the egress gateway enforces),
 * plus the health columns of the models the AI layer reads from: the player's
 * medical status, a workload record's injury-risk inference, an injury record,
 * heart-rate telemetry.
 */
export const HEALTH_FIELDS: ReadonlySet<string> = new Set([
  ...Object.entries(FEATURE_CLASSES).filter(([, c]) => c === 'RESTRICTED').map(([k]) => k),
  ...Object.entries(FACTOR_CLASSES).filter(([, c]) => c === 'RESTRICTED').map(([k]) => k),
  'medicalStatus', 'injuryRiskScore', 'isHighRisk', 'riskFlags',
  'injuries', 'activeInjuries', 'injuryType', 'injuryDate', 'bodyLocation', 'bodyLocationCode', 'osicsCategory',
  'isContactInjury', 'isRecurrence', 'workloadAtInjury', 'returnDate', 'daysAbsent',
  'hr', 'heartRate', 'heartRateAvg', 'heartRateMax', 'hrv', 'ecg', 'tai',
]);

/** Whether any object anywhere in `value` has a health field. Bounded: a record's JSON, not a stream. */
export function holdsHealthData(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== 'object' || depth > 12) return false;
  if (Array.isArray(value)) return value.some((v) => holdsHealthData(v, depth + 1));
  for (const [k, v] of Object.entries(value as Row)) {
    if (HEALTH_FIELDS.has(k)) return true;
    if (holdsHealthData(v, depth + 1)) return true;
  }
  return false;
}

const F: Grant = 'FULL';
const N: Grant = 'NONE';

/**
 * The matrix. A Record over the role enum, so a new role does not compile
 * until somebody has decided what it may read; FULL or NONE, so no role is
 * ever granted a summary of a class it may not read.
 */
export const AI_READ_MATRIX: Readonly<Record<UserRole, Readonly<Record<AIRecordClass, Grant>>>> = Object.freeze({
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
});

export function tierFor(role: string | null | undefined, cls: AIRecordClass): Grant {
  const row = role ? AI_READ_MATRIX[role as UserRole] : undefined;
  return row ? row[cls] : 'NONE';
}

/** FULL only when the role may read every class the record holds. */
function grantFor(role: string | null | undefined, classes: readonly AIRecordClass[]): Grant {
  return classes.every((c) => tierFor(role, c) === 'FULL') ? 'FULL' : 'NONE';
}

export function isAIReader(role: string | null | undefined): boolean {
  return CLASSES.some((c) => tierFor(role, c) !== 'NONE');
}

/** The roles that may read any AI record at all. */
export const AI_READER_ROLES: readonly UserRole[] = Object.freeze(
  (Object.keys(AI_READ_MATRIX) as UserRole[]).filter((r) => isAIReader(r)),
);

export function assertAIReader(reader: AIReader): void {
  if (!isAIReader(reader.role)) throw new ForbiddenError('AI records are not available to this role');
}

// ── Classification ──────────────────────────────────────────────────────────

export interface AIClassification {
  classes:  AIRecordClass[];
  /** Whether the (agent, kind) is one a platform producer is declared to write. */
  declared: boolean;
  /** The agent's own class, or null for an agent this policy does not know. */
  agentClass: AIRecordClass | null;
  /** Medical by its agent or its declared kind (not merely unclassified). */
  medical:  boolean;
}

const declaredFor = (type: AIRecordType, agent: string | null) => DECLARED_KINDS[type].filter((d) => d.agent === agent);

export function classify(type: AIRecordType, agent: string | null | undefined, kind: string | null | undefined): AIClassification {
  const a = agent ?? null;
  // An agent this policy does not know is treated as the most sensitive.
  if (a !== null && !(a in AGENT_RECORD_CLASS)) return { classes: ['MEDICAL'], declared: false, agentClass: null, medical: true };
  const agentClass = a === null ? 'OPERATIONAL' : AGENT_RECORD_CLASS[a as AIAgent];
  const entry = declaredFor(type, a).find((d) => d.kind === kind);
  // A declared agentless kind is what its producer says it is; anything else
  // also carries its agent's class (an agentless record counts as operational).
  const classes = new Set<AIRecordClass>(entry && a === null ? [entry.cls] : [agentClass, entry ? entry.cls : 'MEDICAL']);
  return {
    classes: CLASSES.filter((c) => classes.has(c)), declared: !!entry, agentClass,
    medical: agentClass === 'MEDICAL' || entry?.cls === 'MEDICAL',
  };
}

export function coachRecommendationClasses(kind: string | null | undefined): AIRecordClass[] {
  return [COACH_KIND_CLASS[kind as CoachRecommendationKind] ?? 'MEDICAL'];
}

export function isDeclaredKind(type: AIRecordType, agent: string | null | undefined, kind: string): boolean {
  return declaredFor(type, agent ?? null).some((d) => d.kind === kind);
}

/**
 * A person writing an AI record by hand may not use a kind a platform
 * producer is declared to write: classification by kind is only worth
 * anything if those kinds carry only what their producer puts in them.
 */
export function assertNotDeclaredKind(type: AIRecordType, agent: string | null | undefined, kind: string): void {
  if (isDeclaredKind(type, agent, kind)) {
    throw new BadRequestError(`The kind "${kind}" is reserved for records the platform writes itself`);
  }
}

/** The JSON a record carries, where a health field would sit. */
function contentOf(type: AIRecordType | 'coach', row: Row): unknown[] {
  switch (type) {
    case 'job':            return [row.input, row.output];
    case 'recommendation': return [row.content];
    default:               return [row.payload];
  }
}

const isRequester = (reader: AIReader, row: Row) => !!reader.userId && row.triggeredBy === reader.userId;

function classifyRow(type: AIRecordType | 'coach', row: Row): AIClassification {
  if (type !== 'coach') return classify(type, row.agent as string | null, row.kind as string | null);
  const classes = coachRecommendationClasses(row.kind as string);
  return { classes, declared: true, agentClass: null, medical: classes.includes('MEDICAL') };
}

/**
 * The tier at which `reader` may see one record, ignoring which club it is in.
 * A job's requester may read their own unclassified job at their agent tier.
 * FULL drops to SUMMARY when the record's structured content holds health data
 * and the reader may not read medical records.
 */
export function tierOf(reader: AIReader, type: AIRecordType | 'coach', row: Row): AIReadTier {
  const c = classifyRow(type, row);
  let grant = grantFor(reader.role, c.classes);
  if (grant === 'NONE' && type === 'job' && !c.declared && c.agentClass && c.agentClass !== 'MEDICAL' && isRequester(reader, row)) {
    grant = tierFor(reader.role, c.agentClass);
  }
  if (grant === 'NONE') return 'NONE';
  if (tierFor(reader.role, 'MEDICAL') !== 'FULL' && contentOf(type, row).some((v) => holdsHealthData(v))) return 'SUMMARY';
  return 'FULL';
}


/**
 * The tier at which `reader` may see one record, or a refusal. A record in
 * another club (a platform administrator excepted) and a record the reader may
 * not see are both "not found".
 */
export function accessTier(reader: AIReader, type: AIRecordType | 'coach', row: Row & { clubId: string }, label: string): AIReadTier {
  assertAIReader(reader);
  if (row.clubId !== reader.clubId && reader.role !== 'SUPER_ADMIN') throw new NotFoundError(label);
  const tier = tierOf(reader, type, row);
  if (tier === 'NONE') throw new NotFoundError(label);
  return tier;
}

/**
 * Who may act on a record (mute an alert, cancel a job). The actor must be able
 * to read it in full. A record that holds medical data — by its agent, its
 * declared kind or its fields — is acted on by medical staff alone. Any other
 * keeps the roles its route has always allowed; an unclassified one may also
 * be acted on by medical staff, who are cleared for whatever it might hold.
 */
export function assertMayAct(reader: AIReader, type: AIRecordType | 'coach', row: Row, tier: AIReadTier, routeRoles: readonly string[], action: string): void {
  const c = classifyRow(type, row);
  const medicalClearance = tierFor(reader.role, 'MEDICAL') === 'FULL';
  const allowed = c.medical || contentOf(type, row).some((v) => holdsHealthData(v))
    ? medicalClearance
    : routeRoles.includes(String(reader.role)) || (!c.declared && medicalClearance);
  if (tier !== 'FULL' || !allowed) throw new ForbiddenError(`This role may not ${action} this record`);
}

// ── List queries ────────────────────────────────────────────────────────────

/**
 * Prisma conditions that keep a list to exactly the records `reader` may see:
 * the same decision as tierOf(), made by the database so totals and pages are
 * right. Written as positive conditions per agent with the null agent spelled
 * out: SQL drops a row whose `agent` is null from both `agent IN (…)` and
 * `NOT (agent = …)`, which would silently hide or reveal the wrong rows.
 * `kind` is never null, so `kind NOT IN (…)` is safe. Returns null when
 * nothing at all is visible.
 */
export function listConditions(reader: AIReader, type: AIRecordType, opts: { agentNullable: boolean }): Array<Record<string, unknown>> | null {
  const branches: Array<Record<string, unknown>> = [];
  const agents: Array<AIAgent | null> = [...(opts.agentNullable ? [null] : []), ...ALL_AGENTS];
  for (const agent of agents) {
    const declared = declaredFor(type, agent).map((d) => d.kind);
    const visible = declared.filter((kind) => grantFor(reader.role, classify(type, agent, kind).classes) === 'FULL');
    if (visible.length > 0) branches.push({ agent, kind: { in: visible } });
    const undeclared = declared.length > 0 ? { kind: { notIn: declared } } : {};
    const u = classify(type, agent, null);
    if (grantFor(reader.role, u.classes) === 'FULL') branches.push({ agent, ...undeclared });
    else if (type === 'job' && u.agentClass && u.agentClass !== 'MEDICAL' && tierFor(reader.role, u.agentClass) === 'FULL' && reader.userId) {
      branches.push({ agent, triggeredBy: reader.userId, ...undeclared });
    }
  }
  return branches.length > 0 ? [{ OR: branches }] : null;
}

/** The coaching-recommendation kinds `reader` may see (the kind is a closed enum). */
export function coachListKinds(reader: AIReader): CoachRecommendationKind[] {
  return (Object.keys(COACH_KIND_CLASS) as CoachRecommendationKind[])
    .filter((k) => grantFor(reader.role, coachRecommendationClasses(k)) === 'FULL');
}

// ── Presentation ────────────────────────────────────────────────────────────

const pick = (row: Row, keys: readonly string[]): Row => {
  const out: Row = {};
  for (const k of keys) if (k in row) out[k] = row[k];
  return out;
};

// A summary names the record and its declared, non-medical kind, and nothing
// it says or that a health reading could be inferred from: no title, text,
// payload, input or output, and no player, severity, score or model figures.
const JOB_META = ['id', 'clubId', 'teamId', 'agent', 'kind', 'status', 'model', 'costTokens', 'costCents', 'triggeredBy', 'startedAt', 'finishedAt', 'createdAt'] as const;
const JOB_SUMMARY = ['id', 'clubId', 'teamId', 'agent', 'kind', 'status', 'startedAt', 'finishedAt', 'createdAt'] as const;
const ALERT_SUMMARY = ['id', 'clubId', 'matchId', 'teamId', 'agent', 'kind', 'status', 'createdAt'] as const;
const RECOMMENDATION_SUMMARY = ['id', 'clubId', 'matchId', 'teamId', 'agent', 'kind', 'status', 'createdAt'] as const;
const REPORT_META = ['id', 'clubId', 'matchId', 'teamId', 'agent', 'kind', 'createdAt'] as const;
const COACH_SUMMARY = ['id', 'clubId', 'matchId', 'teamId', 'kind', 'status', 'createdAt'] as const;

const summary = (row: Row, keys: readonly string[]): Row => ({ ...pick(row, keys), restricted: true });

/** An agent job. A list never carries input, output or error; a detail does at FULL. */
export function presentJob(job: Row, tier: AIReadTier, view: 'list' | 'detail'): Row {
  if (tier !== 'FULL') return summary(job, JOB_SUMMARY);
  if (view === 'detail') return job;
  return { ...pick(job, JOB_META), hasOutput: job.output != null, hasError: job.error != null && job.error !== '' };
}

export function presentAlert(alert: Row, tier: AIReadTier): Row {
  return tier === 'FULL' ? alert : summary(alert, ALERT_SUMMARY);
}

export function presentRecommendation(rec: Row, tier: AIReadTier): Row {
  return tier === 'FULL' ? rec : summary(rec, RECOMMENDATION_SUMMARY);
}

/** A report. A list carries the title at FULL but never the body; a detail carries the body at FULL. */
export function presentReport(report: Row, tier: AIReadTier, view: 'list' | 'detail'): Row {
  if (tier !== 'FULL') return summary(report, REPORT_META);
  return view === 'detail' ? report : { ...pick(report, REPORT_META), title: report.title };
}

export function presentCoachRecommendation(rec: Row, tier: AIReadTier): Row {
  return tier === 'FULL' ? rec : summary(rec, COACH_SUMMARY);
}

/**
 * Keep the rows a list query returned that `reader` may see, each at its own
 * tier. The query already holds exactly these (listConditions); this is the
 * same decision again, per row, so a query that drifted could not leak.
 */
export function presentList<T extends Row>(
  reader: AIReader,
  type: AIRecordType | 'coach',
  rows: T[],
  present: (row: T, tier: AIReadTier) => Row,
): Row[] {
  const out: Row[] = [];
  for (const row of rows) {
    const tier = tierOf(reader, type, row);
    if (tier !== 'NONE') out.push(present(row, tier));
  }
  return out;
}

// The live match channel carries three AI events. Each subscriber's stream
// passes them through here with that subscriber's role: an event the role may
// not read in full is dropped, so a medical alert's existence, kind and player
// never reach a coach's screen. Every other event passes unchanged.
const AI_MATCH_EVENTS: Readonly<Record<string, AIRecordType>> = Object.freeze({
  RULES_ALERT: 'alert', AI_RECOMMENDATION: 'recommendation', AI_REPORT: 'report',
});

export function presentMatchEvent<E extends { kind: string; payload: unknown }>(role: string | null | undefined, event: E): E | null {
  const type = AI_MATCH_EVENTS[event.kind];
  if (!type) return event;
  const p = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Row;
  const tier = tierOf({ userId: '', clubId: null, role }, type, p);
  return tier === 'FULL' ? event : null;
}
