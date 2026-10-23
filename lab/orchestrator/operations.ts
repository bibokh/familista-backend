// LAB operations — what a task can ask an agent to do, as a versioned contract
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Intelligence, AI-0.2 (LAB). An operation is the unit the
// orchestrator routes: it names the registry TOOL it exercises (so routing and
// authorization are the tool registry's, agents.ts), the DOMAIN whose agent
// performs it (or none: then the least-privileged holder), the DATA CLASS of
// what it produces, the schemas its input and output must satisfy, and the
// operations whose outputs it may consume — the approved exchanges between
// agents, declared rather than discovered.
//
// In the Lab, `run` is a deterministic simulation over synthetic input: pure,
// no clock, no randomness, no I/O, its input frozen. Nothing here calls a
// model, the AI Gateway, a database or the network, and an action operation
// (a WRITE tool) only describes the change a person would approve; it is
// never made. A new domain joins by registering its operations against tools
// its agents hold — the orchestrator itself does not change.

import { z, type ZodType } from 'zod';
import { tool } from '../../src/platform/intelligence/agents';
import type { DataClass } from '../../src/platform/intelligence/data-classes';
import { AGENT_DOMAINS, type AgentDomain } from '../../src/platform/agents/manifest';
import { deepFreeze } from '../../src/platform/agents/registry';
import type { AIRecordClass } from '../../src/security/ai-read-policy';
import { LAB_REF, OPERATION_KEY } from './contracts';

/** A validated output another task consumes. */
export interface Handoff {
  taskId: string;
  operation: string;
  agentId: string;
  dataClass: DataClass;
  recordClass: AIRecordClass;
  output: unknown;
}

export interface LabOperation<I = unknown, O = unknown> {
  key: string;
  title: string;
  tool: string;
  domain: AgentDomain | null;
  output: DataClass;
  input: ZodType<I>;
  result: ZodType<O>;
  consumes: readonly string[];
  /** Deterministic and pure. It receives frozen copies, so it cannot change what it was given. */
  run(input: I, upstream: ReadonlyArray<Handoff>): O;
}

export class OperationCatalogError extends Error {
  constructor(readonly operation: string, readonly issues: string[]) {
    super(`LAB operation "${operation}" is not valid: ${issues.join('; ')}`);
    this.name = 'OperationCatalogError';
  }
}

const CLASSES: readonly DataClass[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];

export class OperationCatalog {
  private readonly ops = new Map<string, LabOperation>();

  /** Validate and keep an operation; refuse it with every reason otherwise. */
  register<I, O>(op: LabOperation<I, O>): LabOperation<I, O> {
    const issues: string[] = [];
    if (!OPERATION_KEY.test(op.key)) issues.push('key is not <area>.<name>@<version>');
    if (this.ops.has(op.key)) issues.push('key is already registered');
    const t = tool(op.tool);
    if (!t) issues.push(`no tool is registered as "${op.tool}"`);
    else if (t.effect === 'PROTECTED') issues.push(`"${op.tool}" is protected: no operation may exercise it`);
    if (op.domain !== null && !(AGENT_DOMAINS as readonly string[]).includes(op.domain)) issues.push(`"${op.domain}" is not a platform domain`);
    if (!CLASSES.includes(op.output)) issues.push(`"${op.output}" is not a data class`);
    for (const c of op.consumes) if (!OPERATION_KEY.test(c)) issues.push(`consumes "${c}", which is not an operation key`);
    if (issues.length > 0) throw new OperationCatalogError(op.key, issues);
    const kept = Object.freeze({ ...op, consumes: Object.freeze([...op.consumes]) });
    this.ops.set(op.key, kept as LabOperation);
    return kept;
  }

  get(key: string): LabOperation | undefined { return this.ops.get(key); }
  list(): LabOperation[] { return [...this.ops.values()].sort((a, b) => (a.key < b.key ? -1 : 1)); }
}

/** A deep, frozen copy: what an operation receives, so a simulation cannot change what it was given. */
export const frozenCopy = <T>(value: T): T => deepFreeze(JSON.parse(JSON.stringify(value)) as T);

const round2 = (n: number) => Math.round(n * 100) / 100;
const only = (upstream: ReadonlyArray<Handoff>, key: string) => upstream.filter((h) => h.operation === key);

// ── the operations of the first LAB slice ────────────────────────────────────

const OpponentMatch = z.object({
  goalsFor: z.number().int().min(0).max(20),
  goalsAgainst: z.number().int().min(0).max(20),
  pressingActions: z.number().int().min(0).max(400),
  attacksLeft: z.number().int().min(0).max(200),
  attacksRight: z.number().int().min(0).max(200),
}).strict();

const OpponentProfile = z.object({
  opponent: z.string().min(1).max(60),
  matches: z.number().int().min(1),
  pressing: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  attackSide: z.enum(['LEFT', 'RIGHT', 'BALANCED']),
  goalsConcededPerMatch: z.number().min(0),
}).strict();
type OpponentProfileT = z.infer<typeof OpponentProfile>;

const opponentProfile: LabOperation<{ opponent: string; matches: z.infer<typeof OpponentMatch>[] }, OpponentProfileT> = {
  key: 'tactics.opponent-profile@1',
  title: 'Profile an opponent from its recorded matches',
  tool: 'analyzeOpponent', domain: 'TACTICS', output: 'INTERNAL', consumes: [],
  input: z.object({ opponent: z.string().min(1).max(60), matches: z.array(OpponentMatch).min(1).max(10) }).strict(),
  result: OpponentProfile,
  run({ opponent, matches }) {
    const n = matches.length;
    const press = matches.reduce((s, m) => s + m.pressingActions, 0) / n;
    const left = matches.reduce((s, m) => s + m.attacksLeft, 0);
    const right = matches.reduce((s, m) => s + m.attacksRight, 0);
    const lean = left + right === 0 ? 0 : (left - right) / (left + right);
    return {
      opponent, matches: n,
      pressing: press >= 150 ? 'HIGH' : press >= 90 ? 'MEDIUM' : 'LOW',
      attackSide: Math.abs(lean) < 0.1 ? 'BALANCED' : lean > 0 ? 'LEFT' : 'RIGHT',
      goalsConcededPerMatch: round2(matches.reduce((s, m) => s + m.goalsAgainst, 0) / n),
    };
  },
};

const FOCUS: Record<OpponentProfileT['pressing'], string> = {
  HIGH: 'Play out under a high press', MEDIUM: 'Build-up patterns through midfield', LOW: 'Breaking down a low block',
};

const SessionDraft = z.object({
  opponent: z.string(),
  focus: z.array(z.string()).min(1),
  blocks: z.array(z.object({ title: z.string(), minutes: z.number().int().min(5) }).strict()).min(2),
  totalMinutes: z.number().int(),
  committed: z.literal(false),
}).strict();

const sessionDraft: LabOperation<{ minutes: number; squadSize: number }, z.infer<typeof SessionDraft>> = {
  key: 'training.session-draft@1',
  title: 'Draft a training session for the next opponent',
  tool: 'createTrainingDraft', domain: 'TRAINING', output: 'INTERNAL', consumes: ['tactics.opponent-profile@1'],
  input: z.object({ minutes: z.number().int().min(45).max(120), squadSize: z.number().int().min(11).max(40) }).strict(),
  result: SessionDraft,
  run({ minutes, squadSize }, upstream) {
    const profiles = only(upstream, 'tactics.opponent-profile@1');
    if (profiles.length !== 1) throw new Error('A session draft is built from exactly one opponent profile');
    const p = profiles[0].output as OpponentProfileT;
    const focus = [FOCUS[p.pressing]];
    if (p.attackSide !== 'BALANCED') focus.push(`Defending attacks down their ${p.attackSide.toLowerCase()} side`);
    const warmUp = 15;
    const coolDown = 10;
    const main = minutes - warmUp - coolDown;
    const game = Math.max(5, Math.round(main / 3));
    return {
      opponent: p.opponent, focus,
      blocks: [
        { title: 'Warm-up', minutes: warmUp },
        { title: focus[0], minutes: main - game },
        { title: `Game: ${Math.floor(squadSize / 2)} v ${Math.floor(squadSize / 2)}`, minutes: game },
        { title: 'Cool-down', minutes: coolDown },
      ],
      totalMinutes: minutes, committed: false,
    };
  },
};

const Briefing = z.object({
  title: z.string(),
  sections: z.array(z.object({ heading: z.string(), lines: z.array(z.string()).min(1) }).strict()).min(1),
  committed: z.literal(false),
}).strict();

const matchBriefing: LabOperation<{ fixture: string }, z.infer<typeof Briefing>> = {
  key: 'operations.match-briefing@1',
  title: 'Compile a match briefing for the staff',
  tool: 'createReport', domain: 'CLUB_OPERATIONS', output: 'INTERNAL',
  consumes: ['tactics.opponent-profile@1', 'training.session-draft@1'],
  input: z.object({ fixture: z.string().min(1).max(80) }).strict(),
  result: Briefing,
  run({ fixture }, upstream) {
    const sections: Array<{ heading: string; lines: string[] }> = [];
    for (const h of only(upstream, 'tactics.opponent-profile@1')) {
      const p = h.output as OpponentProfileT;
      sections.push({ heading: `Opponent: ${p.opponent}`, lines: [
        `Pressing: ${p.pressing.toLowerCase()} (from ${p.matches} recorded matches)`,
        `Attacks mostly: ${p.attackSide.toLowerCase()}`,
        `Goals conceded per match: ${p.goalsConcededPerMatch}`,
      ] });
    }
    for (const h of only(upstream, 'training.session-draft@1')) {
      const d = h.output as z.infer<typeof SessionDraft>;
      sections.push({ heading: 'Training draft (not committed)', lines: d.blocks.map((b) => `${b.title}: ${b.minutes} min`) });
    }
    if (sections.length === 0) throw new Error('A briefing needs at least one upstream output');
    return { title: `Briefing: ${fixture}`, sections, committed: false };
  },
};

const FORMATIONS = ['4-4-2', '4-3-3', '3-5-2', '4-2-3-1', '5-3-2'] as const;
const LiveChange = z.object({
  proposal: z.object({ minute: z.number().int(), formation: z.enum(FORMATIONS), because: z.string() }).strict(),
  executed: z.literal(false),
  simulated: z.literal(true),
}).strict();

const liveChange: LabOperation<{ minute: number; formation: typeof FORMATIONS[number] }, z.infer<typeof LiveChange>> = {
  key: 'tactics.live-change@1',
  title: 'Propose a live tactical change',
  tool: 'changeTacticsLive', domain: 'TACTICS', output: 'INTERNAL', consumes: ['tactics.opponent-profile@1'],
  input: z.object({ minute: z.number().int().min(1).max(120), formation: z.enum(FORMATIONS) }).strict(),
  result: LiveChange,
  run({ minute, formation }, upstream) {
    const p = only(upstream, 'tactics.opponent-profile@1')[0]?.output as OpponentProfileT | undefined;
    const because = p ? `Opponent pressing is ${p.pressing.toLowerCase()}` : 'No opponent profile';
    return { proposal: { minute, formation, because }, executed: false, simulated: true };
  },
};

const PlayerStatus = z.object({ ref: z.string().regex(LAB_REF), medicalStatus: z.enum(['FIT', 'RECOVERING', 'INJURED']) }).strict();
const Availability = z.object({
  available: z.array(z.string()),
  unavailable: z.array(PlayerStatus),
}).strict();

const availability: LabOperation<{ players: z.infer<typeof PlayerStatus>[] }, z.infer<typeof Availability>> = {
  key: 'medical.availability@1',
  title: 'Report squad availability from medical status',
  tool: 'createReport', domain: 'MEDICAL', output: 'RESTRICTED', consumes: [],
  input: z.object({ players: z.array(PlayerStatus).min(1).max(40) }).strict(),
  result: Availability,
  run({ players }) {
    return {
      available: players.filter((p) => p.medicalStatus === 'FIT').map((p) => p.ref),
      unavailable: players.filter((p) => p.medicalStatus !== 'FIT').map((p) => ({ ref: p.ref, medicalStatus: p.medicalStatus })),
    };
  },
};

const MedicalRecommendation = z.object({
  recommendations: z.array(z.object({ ref: z.string(), action: z.enum(['REST', 'MODIFIED_LOAD']) }).strict()),
  executed: z.literal(false),
  simulated: z.literal(true),
}).strict();

const medicalRecommendation: LabOperation<Record<string, never>, z.infer<typeof MedicalRecommendation>> = {
  key: 'medical.recommendation@1',
  title: 'Propose medical recommendations for unavailable players',
  tool: 'issueMedicalRecommendation', domain: 'MEDICAL', output: 'RESTRICTED', consumes: ['medical.availability@1'],
  input: z.object({}).strict(),
  result: MedicalRecommendation,
  run(_input, upstream) {
    const a = only(upstream, 'medical.availability@1')[0]?.output as z.infer<typeof Availability> | undefined;
    const recommendations = (a?.unavailable ?? []).map((p) => ({ ref: p.ref, action: p.medicalStatus === 'INJURED' ? 'REST' as const : 'MODIFIED_LOAD' as const }));
    return { recommendations, executed: false, simulated: true };
  },
};

/** The operations of the first LAB slice. */
export function labOperations(): OperationCatalog {
  const c = new OperationCatalog();
  for (const op of [opponentProfile, sessionDraft, matchBriefing, liveChange, availability, medicalRecommendation]) c.register(op as LabOperation);
  return c;
}
