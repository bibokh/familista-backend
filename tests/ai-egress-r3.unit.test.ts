/**
 * Cyber Defense, R3 — what leaves Familista for an AI provider
 *
 * The AI Gateway is the only egress (one file imports the provider SDK), and
 * every call passes its policy: RESTRICTED data needs the club's opt-in, names
 * are pseudonymised on the way out and restored on the way back, a per-club
 * daily budget applies, a record is written before anything leaves (never the
 * prompt), and an answer that must have a shape is refused when it does not.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);

type Row = Record<string, unknown>;
const POLICIES = new Map<string, Row>();
const INSIGHTS: Row[] = [];
const ADULT = new Date('1995-03-01T00:00:00Z');
const CHILD = new Date(Date.now() - 14 * 365.25 * 86_400_000);

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === 'club') return { findUnique: async () => ({ name: 'Riverside FC', level: 3, overallRating: 71, leaguePosition: 4 }) };
      if (k === 'player') return {
        findFirst: async () => ({ id: 'p-1', firstName: 'Mohamed', lastName: 'Salah', position: 'RW', number: 11, dateOfBirth: ADULT, condition: 64, isInjured: true, overallRating: 88,
          gpsData: [{ topSpeed: 33.1, playerLoad: 640, riskScore: 81 }], injuries: [], attributes: [] }),
        findMany: async () => [
          { firstName: 'Mohamed', lastName: 'Salah', number: 11, dateOfBirth: ADULT, position: 'RW', overallRating: 88, condition: 64, isInjured: true,
            gpsData: [{ topSpeed: 33.1, playerLoad: 640, riskScore: 81 }] },
          { firstName: 'Tomás', lastName: 'Müller-Fernández', number: 27, dateOfBirth: CHILD, position: 'CM', overallRating: 61, condition: 92, isInjured: false,
            gpsData: [{ topSpeed: 28.4, playerLoad: 410, riskScore: 12 }] },
        ],
      };
      if (k === 'match') return { findMany: async () => [{ homeTeam: 'Riverside FC', awayTeam: 'Harbour Town', homeScore: 2, awayScore: 1, result: 'WIN', competition: 'League' }] };
      if (k === 'playerInjury') return {
        findMany: async () => [{ injuryType: 'Anterior cruciate ligament tear', severity: 'SEVERE', player: { firstName: 'Mohamed', lastName: 'Salah' } }],
      };
      if (k === 'aiInsight') return { create: async ({ data }: { data: Row }) => { INSIGHTS.push(data); return { id: `ins-${INSIGHTS.length}`, ...data }; } };
      if (k === 'clubAiDataPolicy') return { findUnique: async ({ where }: { where: { clubId: string } }) => POLICIES.get(where.clubId) ?? null };
      return new Proxy({}, { get: () => async () => null });
    },
  }),
}));

import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { config } from '../src/config';
import {
  complete, pseudonymiser, registerModel, registerProvider, resetGateway, setEgressRecorder,
  type EgressRecord, type GatewayRequest,
} from '../src/platform/intelligence/gateway';
import { DEFAULT_MODEL_ID, AI_PURPOSES } from '../src/platform/intelligence/default-gateway';
import { __resetClubAiPolicyCache } from '../src/platform/intelligence/club-ai-policy';
import { FEATURE_CLASSES, FACTOR_CLASSES, classOf, filterFeatures, isMinor } from '../src/platform/intelligence/data-classes';
import { analyzeWithAI, analyzePlayer } from '../src/services/ai.service';
import { buildNarrativeMessage, type NarrativeRequest } from '../src/services/ai-llm.adapter';

const ROOT = path.join(__dirname, '..');

// ── a provider that records what it was sent, and an in-memory egress record ──
let sent: GatewayRequest[] = [];
let reply = 'Rest [P1] this week; [P2] is ready to start.';
let records: Array<EgressRecord & { id: string; finished?: Partial<EgressRecord> }> = [];
let spent = 0;
let recorderDown = false;

function install(): void {
  resetGateway();
  registerProvider({ id: 'anthropic', available: () => true, complete: async (req) => { sent.push(req); return { text: reply, usage: { inputTokens: 100, outputTokens: 40 } }; } });
  registerModel({ id: DEFAULT_MODEL_ID, provider: 'anthropic', providerModel: 'test-model', purposes: Object.values(AI_PURPOSES) });
  setEgressRecorder({
    async start(r) { if (recorderDown) throw new Error('db down'); const id = `rec-${records.length + 1}`; records.push({ ...r, id }); return id; },
    async finish(id, r) { const row = records.find((x) => x.id === id); if (row) row.finished = r; },
    async spentToday() { if (recorderDown) throw new Error('db down'); return spent; },
  });
}

beforeEach(() => {
  sent = []; records = []; spent = 0; recorderDown = false; INSIGHTS.length = 0;
  reply = 'Rest [P1] this week; [P2] is ready to start.';
  POLICIES.clear(); __resetClubAiPolicyCache();
  (config.anthropic as Row).apiKey = 'test-key-not-real';
  install();
});
afterAll(() => { (config.anthropic as Row).apiKey = ''; resetGateway(); });

const allOut = () => sent.map((r) => `${r.system ?? ''}\n${r.prompt}`).join('\n');

describe('one door: only the gateway\'s provider imports the SDK', () => {
  it('no other file under src/ imports @anthropic-ai/sdk', () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const code = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
          if (/from\s+['"]@anthropic-ai\/sdk['"]|require\(\s*['"]@anthropic-ai\/sdk['"]\s*\)/.test(code)) hits.push(path.relative(ROOT, p));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(hits).toEqual(['src/platform/intelligence/anthropic-provider.ts']);
  });
});

describe('ARIA under the egress policy', () => {
  it('a prompt built from seeded injuries carries no names and no diagnosis when the club has not opted in', async () => {
    const out = await analyzeWithAI({ type: 'team', prompt: 'How should Salah be managed this week?', clubId: 'c-1', userId: 'u-1' });
    const wire = allOut();
    expect(wire).not.toMatch(/Salah|Mohamed|Tomás|Müller/);
    expect(wire).not.toMatch(/cruciate|ligament|SEVERE|INJURED|Cond \d|Risk \d/);
    expect(wire).toContain('1 player(s) currently injured');
    expect(wire).toContain('[P1]');
    // The answer comes back with the names put back.
    expect(out.response).toBe('Rest Mohamed Salah this week; Tomás Müller-Fernández is ready to start.');
    // A minor's workload is not sent without the opt-in.
    expect(wire).not.toContain('28.4km/h');
    expect(records[0]).toMatchObject({ caller: 'ai.service', purpose: 'club-analysis', clubId: 'c-1', outcome: 'STARTED' });
    expect(records[0].dataClasses).not.toContain('RESTRICTED');
  });

  it('with the club\'s opt-in the diagnosis is sent — but still never a name', async () => {
    POLICIES.set('c-1', { restrictedEgress: true, trainingUse: false });
    await analyzeWithAI({ type: 'medical', prompt: 'Summarise the injuries', clubId: 'c-1', userId: 'u-1' });
    const wire = allOut();
    expect(wire).toContain('Anterior cruciate ligament tear');
    expect(wire).not.toMatch(/Salah|Mohamed|Tomás|Müller/);
    expect(records[0].dataClasses).toContain('RESTRICTED');
  });

  it('a player analysis leaves condition and injury out without the opt-in', async () => {
    await analyzePlayer('p-1', 'c-1', 'u-1');
    expect(sent).toHaveLength(1);
    const wire = allOut();
    expect(wire).toContain('[P1]');
    expect(wire).not.toMatch(/Salah|CURRENTLY INJURED|Current condition|Risk 81/);
  });

  it('nothing is stored or sent as the prompt in the egress record', async () => {
    await analyzeWithAI({ type: 'team', prompt: 'secret question about Salah', clubId: 'c-1', userId: 'u-1' });
    expect(JSON.stringify(records)).not.toMatch(/secret question|Salah|Rest/);
  });
});

describe('the gateway\'s rules, one at a time', () => {
  const ask = (over: Partial<GatewayRequest> = {}) => complete({ caller: 't', purpose: 'agent', clubId: 'c-1', prompt: 'hello', dataClasses: ['INTERNAL'], ...over });

  it('RESTRICTED without the club\'s opt-in is refused before anything leaves', async () => {
    const out = await ask({ dataClasses: ['RESTRICTED'] });
    expect(out).toMatchObject({ ok: false, refusal: 'restricted' });
    expect(sent).toHaveLength(0);
    expect(records[0]).toMatchObject({ outcome: 'REFUSED', reason: 'restricted' });
  });

  it('a caller that declares nothing is treated as sending RESTRICTED', async () => {
    const out = await ask({ dataClasses: undefined });
    expect(out.refusal).toBe('restricted');
    expect(sent).toHaveLength(0);
  });

  it('the daily budget is a refusal', async () => {
    spent = 10_000_000;
    expect((await ask()).refusal).toBe('budget');
    expect(sent).toHaveLength(0);
  });

  it('no record, no call: if the record cannot be written nothing is sent', async () => {
    recorderDown = true;
    expect((await ask()).refusal).toBe('audit');
    expect(sent).toHaveLength(0);
  });

  it('a successful call is recorded with its tokens and outcome', async () => {
    await ask();
    expect(records[0].finished).toMatchObject({ outcome: 'OK', tokensIn: 100, tokensOut: 40 });
  });

  it('an answer that must have a shape is validated; anything else is refused', async () => {
    const schema = z.object({ rationale: z.string().min(1) });
    reply = 'Sure! Here is my answer: {"rationale": 1}';
    const bad = await ask({ outputSchema: schema });
    expect(bad).toMatchObject({ ok: false, refusal: 'invalid-output' });
    expect(records[0].finished?.outcome).toBe('INVALID_OUTPUT');
    reply = '```json\n{"rationale":"[P1] is tired"}\n```';
    const good = await ask({ outputSchema: schema, subjects: ['Mohamed Salah'] });
    expect(good.ok).toBe(true);
    expect(good.data).toEqual({ rationale: 'Mohamed Salah is tired' });
  });

  it('control characters are stripped and length is capped', async () => {
    reply = 'ok\u0007\u001b[31m' + 'x'.repeat(50);
    const out = await ask({ maxOutputChars: 10 });
    expect(out.text).toBe('ok[31mxxxx');
  });

  it('a provider failure comes back as a category, never the provider\'s text', async () => {
    registerProvider({ id: 'anthropic', available: () => true, complete: async () => { throw Object.assign(new Error('provider failed'), { category: 'rate_limited', status: 429 }); } });
    const out = await ask({ prompt: 'about Salah' });
    expect(out).toMatchObject({ ok: false, refusal: 'provider', providerStatus: 429 });
    expect(out.refusedBecause).toBe('The provider failed: rate_limited');
  });
});

describe('pseudonyms', () => {
  it('replace full names and a surname on its own, and put them back', () => {
    const p = pseudonymiser(['Mohamed Salah', 'Tomás Müller-Fernández']);
    const out = p.apply('Salah and Tomás Müller-Fernández; mohamed salah again. Salahs is not a name here.');
    expect(out.text).toBe('[P1] and [P2]; [P1] again. Salahs is not a name here.');
    expect(p.restore(out.text)).toBe('Mohamed Salah and Tomás Müller-Fernández; Mohamed Salah again. Salahs is not a name here.');
  });

  it('a name part shared by two people is not used on its own', () => {
    const p = pseudonymiser(['Alex Smith', 'Jordan Smith']);
    expect(p.apply('Smith played well').text).toBe('Smith played well');
  });
});

describe('classification', () => {
  it('every feature the decision engine extracts is classified', () => {
    const types = fs.readFileSync(path.join(ROOT, 'src/types/ai-engine.types.ts'), 'utf8');
    const keys = new Set<string>();
    for (const m of types.matchAll(/export type \w+Features = FeatureMap & \{([\s\S]*?)\n\};/g)) for (const k of m[1].matchAll(/^\s+(\w+):/gm)) keys.add(k[1]);
    expect(keys.size).toBeGreaterThan(50);
    expect([...keys].filter((k) => !(k in FEATURE_CLASSES))).toEqual([]);
  });

  it('every score factor is classified', () => {
    const src = ['src/lib/ai-scoring.lib.ts', ...fs.readdirSync(path.join(ROOT, 'src/services')).filter((f) => /^ai-[a-z-]+-decisions\.service\.ts$/.test(f)).map((f) => `src/services/${f}`)]
      .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    const names = new Set([...src.matchAll(/name: '([a-z0-9_]+)'/g)].map((m) => m[1]));
    expect([...names].filter((n) => !(n in FACTOR_CLASSES))).toEqual([]);
  });

  it('an unknown feature is RESTRICTED; health features are RESTRICTED; a minor is under 18', () => {
    expect(classOf('somethingNew')).toBe('RESTRICTED');
    for (const k of ['isInjured', 'condition', 'avgRiskScore30d', 'injuryCount365d']) expect(FEATURE_CLASSES[k]).toBe('RESTRICTED');
    expect(isMinor(CHILD)).toBe(true);
    expect(isMinor(ADULT)).toBe(false);
    expect(isMinor(null)).toBe(true);
    expect(filterFeatures({ age: 20, isInjured: true, overallRating: 80 }, 'CONFIDENTIAL')).toMatchObject({ features: { age: 20, overallRating: 80 }, withheld: ['isInjured'] });
  });

  it('a decision narrative without the opt-in sends no injury feature, no injury factor and no name', () => {
    const req: NarrativeRequest = {
      clubId: 'c-1', domain: 'PLAYER', decisionType: 'INJURY_RISK',
      subject: { type: 'PLAYER', id: 'p-1', label: 'Mohamed Salah' } as never,
      score: 80, confidence: 0.7, urgency: 'HIGH',
      features: { playerId: 'p-1', isInjured: true, condition: 60, overallRating: 88, avgRiskScore30d: 80 },
      factors: [
        { name: 'currently_injured', value: true, contribution: 100, description: 'Player is currently injured' },
        { name: 'form_signal', value: 7.1, contribution: 5 },
      ],
      recommendation: { kind: 'REST_PLAYER', label: 'Rest' }, alternatives: [],
    };
    const m = buildNarrativeMessage(req, 'CONFIDENTIAL');
    expect(m.text).not.toMatch(/isInjured|currently_injured|avgRiskScore30d|"condition"/);
    expect(m.text).toContain('form_signal');
    expect(m.subjects).toEqual(['Mohamed Salah']);
    expect(m.classes).not.toContain('RESTRICTED');
    expect(buildNarrativeMessage(req, 'RESTRICTED').classes).toContain('RESTRICTED');
  });
});
