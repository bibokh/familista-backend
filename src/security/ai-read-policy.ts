// Familista — AI read authorization: who may see what the AI layer produced
// ─────────────────────────────────────────────────────────────────────────
// One policy for every record an AI agent or the AI layer writes, on every
// route that returns one: agent jobs with their input and output, alerts,
// recommendations, reports, anomalies, coaching recommendations and the ARIA
// history. The routes call this module; none of them decides on its own.
//
// A record has a class, taken from the agent that produced it (the same
// profile the egress gateway and the tool registry use, agent-jobs.ts) and
// from its kind: a fatigue alert raised by any agent is still about somebody's
// body. A role has a tier for each class:
//
//   FULL     the record as stored.
//   SUMMARY  that it exists — kind, severity, status, who and when — and
//            nothing it says: no title, message, content, payload, input,
//            output or error. Enough to act on ("see medical staff about this
//            player"), not enough to learn a diagnosis.
//   NONE     the record is not listed, and asking for it is refused.
//
// Medical records are FULL only for medical staff. Coaching staff and club
// leadership, and the platform's own administrators, get the SUMMARY: a
// legitimate need to know a player needs attention, no automatic right to the
// medical detail. Players and parents get nothing here; what is shown to them
// is shown by the screens built for them, not by the agents' internal records.
//
// General lists never carry an agent job's raw input, output or error, nor a
// report's body; those come only from the record's own detail route, and only
// at FULL. Another club's record is "not found", never "forbidden", so its
// existence is not confirmed either.

import { AIAgent, UserRole } from '@prisma/client';
import { ForbiddenError, NotFoundError } from '../utils/errors';

export type AIRecordClass = 'OPERATIONAL' | 'SCOUTING' | 'FINANCE' | 'MEDICAL';
export type AIReadTier = 'FULL' | 'SUMMARY' | 'NONE';

export interface AIReader {
  userId: string;
  clubId: string | null;
  role?:  string | null;
}

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

/** A kind containing any of these is medical, whichever agent raised it. */
export const MEDICAL_KIND_WORDS: readonly string[] = Object.freeze([
  'INJUR', 'MEDIC', 'HEALTH', 'ILLNESS', 'CONCUSS', 'FATIGUE', 'RECOVERY', 'REHAB', 'WELLNESS',
]);

const F: AIReadTier = 'FULL';
const S: AIReadTier = 'SUMMARY';
const N: AIReadTier = 'NONE';

/**
 * The matrix. A Record over the role enum, so a new role does not compile
 * until somebody has decided what it may read.
 */
export const AI_READ_MATRIX: Readonly<Record<UserRole, Readonly<Record<AIRecordClass, AIReadTier>>>> = Object.freeze({
  SUPER_ADMIN:     { OPERATIONAL: F, SCOUTING: F, FINANCE: F, MEDICAL: S },
  CLUB_ADMIN:      { OPERATIONAL: F, SCOUTING: F, FINANCE: F, MEDICAL: S },
  MANAGER:         { OPERATIONAL: F, SCOUTING: F, FINANCE: F, MEDICAL: S },
  HEAD_COACH:      { OPERATIONAL: F, SCOUTING: F, FINANCE: N, MEDICAL: S },
  ASSISTANT_COACH: { OPERATIONAL: F, SCOUTING: N, FINANCE: N, MEDICAL: S },
  COACH:           { OPERATIONAL: F, SCOUTING: N, FINANCE: N, MEDICAL: S },
  ANALYST:         { OPERATIONAL: F, SCOUTING: F, FINANCE: N, MEDICAL: N },
  MEDICAL_STAFF:   { OPERATIONAL: F, SCOUTING: N, FINANCE: N, MEDICAL: F },
  SCOUT:           { OPERATIONAL: N, SCOUTING: F, FINANCE: N, MEDICAL: N },
  PARENT:          { OPERATIONAL: N, SCOUTING: N, FINANCE: N, MEDICAL: N },
  PLAYER:          { OPERATIONAL: N, SCOUTING: N, FINANCE: N, MEDICAL: N },
});

export function recordClass(agent: string | null | undefined, kind: string | null | undefined): AIRecordClass {
  const k = String(kind ?? '').toUpperCase();
  if (agent === 'MEDICAL' || MEDICAL_KIND_WORDS.some((w) => k.includes(w))) return 'MEDICAL';
  if (!agent) return 'OPERATIONAL';
  // An agent this policy does not know is treated as the most sensitive.
  return AGENT_RECORD_CLASS[agent as AIAgent] ?? 'MEDICAL';
}

export function tierFor(role: string | null | undefined, cls: AIRecordClass): AIReadTier {
  const row = role ? AI_READ_MATRIX[role as UserRole] : undefined;
  return row ? row[cls] : 'NONE';
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

/**
 * The tier at which `reader` may see one record, or a refusal: another club's
 * record is not found (a platform administrator excepted), a class the role may
 * not read is forbidden.
 */
export function accessTier(
  reader: AIReader,
  record: { clubId: string; agent?: string | null; kind?: string | null },
  label: string,
  cls: AIRecordClass = recordClass(record.agent, record.kind),
): AIReadTier {
  assertAIReader(reader);
  if (record.clubId !== reader.clubId && reader.role !== 'SUPER_ADMIN') throw new NotFoundError(label);
  const tier = tierFor(reader.role, cls);
  if (tier === 'NONE') throw new ForbiddenError(`This role may not read ${cls.toLowerCase()} AI records`);
  return tier;
}

/** The record classes `reader` may see at all. */
export function readableClasses(reader: AIReader): Set<AIRecordClass> {
  return new Set(CLASSES.filter((c) => tierFor(reader.role, c) !== 'NONE'));
}

/**
 * Prisma conditions that keep a list to the records `reader` may see, for a
 * model with `agent` and a free-text `kind`. Written as positive conditions
 * with the null case spelled out: SQL drops a row whose `agent` is null from
 * both `agent IN (…)` and `NOT (agent = …)`, which would silently hide or
 * reveal the wrong rows. Returns null when nothing at all is readable.
 */
export function listConditions(reader: AIReader, opts: { agentNullable: boolean }): Array<Record<string, unknown>> | null {
  const classes = readableClasses(reader);
  if (classes.size === 0) return null;
  if (classes.size === CLASSES.length) return [];
  // The exact union of what recordClass() lets this reader see: medical rows
  // (by agent or by kind) if medical is readable, and rows of a readable
  // non-medical agent whose kind is not medical. Agentless rows are operational.
  const medicalKind = MEDICAL_KIND_WORDS.map((w) => ({ kind: { contains: w, mode: 'insensitive' } }));
  const notMedicalKind = MEDICAL_KIND_WORDS.map((w) => ({ NOT: { kind: { contains: w, mode: 'insensitive' } } }));
  const agents = ALL_AGENTS.filter((a) => AGENT_RECORD_CLASS[a] !== 'MEDICAL' && classes.has(AGENT_RECORD_CLASS[a]));
  const agentless = opts.agentNullable && classes.has('OPERATIONAL');
  const branches: Array<Record<string, unknown>> = [];
  if (classes.has('MEDICAL')) branches.push({ agent: 'MEDICAL' }, ...medicalKind);
  if (agents.length > 0 || agentless) {
    const byAgent = agentless ? { OR: [{ agent: null }, { agent: { in: agents } }] } : { agent: { in: agents } };
    branches.push({ AND: [byAgent, ...notMedicalKind] });
  }
  return branches.length > 0 ? [{ OR: branches }] : null;
}

// ── Presentation ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const pick = (row: Row, keys: readonly string[]): Row => {
  const out: Row = {};
  for (const k of keys) if (k in row) out[k] = row[k];
  return out;
};

const JOB_META = ['id', 'clubId', 'teamId', 'agent', 'kind', 'status', 'model', 'costTokens', 'costCents', 'triggeredBy', 'startedAt', 'finishedAt', 'createdAt'] as const;
const ALERT_META = ['id', 'clubId', 'matchId', 'teamId', 'playerId', 'agent', 'kind', 'severity', 'status', 'createdAt', 'ackedAt', 'ackedBy', 'resolvedAt'] as const;
const RECOMMENDATION_META = ['id', 'clubId', 'matchId', 'teamId', 'playerId', 'agent', 'kind', 'status', 'createdAt', 'ackedAt', 'ackedBy'] as const;
const REPORT_META = ['id', 'clubId', 'matchId', 'teamId', 'agent', 'kind', 'createdAt'] as const;
const COACH_RECOMMENDATION_META = ['id', 'clubId', 'matchId', 'teamId', 'playerId', 'agentId', 'kind', 'tacticalImpact', 'approvalRequestId', 'status', 'createdAt', 'ackedAt', 'ackedBy'] as const;

const summary = (row: Row, keys: readonly string[]): Row => ({ ...pick(row, keys), restricted: true });

/** An agent job. A list never carries input, output or error; a detail does at FULL. */
export function presentJob(job: Row, tier: AIReadTier, view: 'list' | 'detail'): Row {
  if (view === 'detail' && tier === 'FULL') return job;
  const meta = { ...pick(job, JOB_META), hasOutput: job.output != null, hasError: job.error != null && job.error !== '' };
  return tier === 'SUMMARY' ? { ...meta, restricted: true } : meta;
}

export function presentAlert(alert: Row, tier: AIReadTier): Row {
  return tier === 'FULL' ? alert : summary(alert, ALERT_META);
}

export function presentRecommendation(rec: Row, tier: AIReadTier): Row {
  return tier === 'FULL' ? rec : summary(rec, RECOMMENDATION_META);
}

/** A report. A list carries the title at FULL but never the body; a detail carries the body at FULL. */
export function presentReport(report: Row, tier: AIReadTier, view: 'list' | 'detail'): Row {
  if (tier !== 'FULL') return summary(report, REPORT_META);
  return view === 'detail' ? report : { ...pick(report, REPORT_META), title: report.title };
}

export function presentCoachRecommendation(rec: Row, tier: AIReadTier): Row {
  return tier === 'FULL' ? rec : summary(rec, COACH_RECOMMENDATION_META);
}

// The live match channel carries three AI events. Each subscriber's stream
// passes them through here with that subscriber's role: dropped at NONE,
// reduced to the summary at SUMMARY. Every other event passes unchanged.
const AI_MATCH_EVENTS: ReadonlySet<string> = new Set(['RULES_ALERT', 'AI_RECOMMENDATION', 'AI_REPORT']);
const MATCH_EVENT_SUMMARY = ['id', 'kind', 'agent', 'severity', 'createdAt'] as const;

export function presentMatchEvent<E extends { kind: string; payload: unknown }>(role: string | null | undefined, event: E): E | null {
  if (!AI_MATCH_EVENTS.has(event.kind)) return event;
  const p = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Row;
  const tier = tierFor(role, recordClass(p.agent as string | null, p.kind as string | null));
  if (tier === 'NONE') return null;
  if (tier === 'FULL') return event;
  return { ...event, payload: summary(p, MATCH_EVENT_SUMMARY) };
}

/** A coaching recommendation's class: its kind is a closed enum. */
export function coachRecommendationClass(kind: string | null | undefined): AIRecordClass {
  return recordClass(null, kind);
}

/** Keep the rows a list query returned that `reader` may see, each at its own tier. */
export function presentList<T extends Row>(
  reader: AIReader,
  rows: T[],
  classOf: (row: T) => AIRecordClass,
  present: (row: T, tier: AIReadTier) => Row,
): Row[] {
  const out: Row[] = [];
  for (const row of rows) {
    const tier = tierFor(reader.role, classOf(row));
    if (tier !== 'NONE') out.push(present(row, tier));
  }
  return out;
}
