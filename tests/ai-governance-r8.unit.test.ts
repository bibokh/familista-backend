/**
 * Cyber Defense, R8 — agents, model registry, federated learning, training data
 *
 *   · an agent job that acts is refused outside its agent's profile, needs a
 *     person's approval, and stops at the kill switch; deleting data is
 *     refused for every agent; accepting a decision that acts takes a second
 *     person, from the same club;
 *   · a model becomes ACTIVE only through a promotion a second person approves,
 *     Ed25519-signed over its artifact; a tampered artifact fails;
 *   · federated learning denies by default, computes the gradient's norm
 *     itself, caps contributions, rejects outliers and checks who aggregates;
 *   · training data needs the club's consent and never uses a minor's
 *     RESTRICTED features;
 *   · a recommendation signature covers the whole payload.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);

type Row = Record<string, any>;
const T: Record<string, Row[]> = {};
const table = (n: string) => (T[n] ??= []);
let seq = 0;

function match(row: Row, where: Row = {}): boolean {
  for (const [k, c] of Object.entries(where)) {
    if (k === 'NOT') { if (match(row, c as Row)) return false; continue; }
    if (k.includes('_') && c && typeof c === 'object' && !Array.isArray(c) && !(c instanceof Date) && Object.keys(c).every((x) => x in row)) {
      if (!match(row, c as Row)) return false; continue; // compound unique (modelFamily_clubId …)
    }
    const v = row[k];
    if (c === null) { if (v !== null && v !== undefined) return false; continue; }
    if (c && typeof c === 'object' && !(c instanceof Date) && !Array.isArray(c)) {
      if ('in' in c) { if (!(c.in as unknown[]).includes(v)) return false; continue; }
      if ('not' in c) { if (c.not === null ? v === null || v === undefined : v === c.not) return false; continue; }
      if ('gte' in c) { if (!(v >= c.gte)) return false; continue; }
      if ('gt' in c) { if (!(v > c.gt)) return false; continue; }
    }
    if (v instanceof Date && c instanceof Date) { if (v.getTime() !== c.getTime()) return false; continue; }
    if (v !== c) return false;
  }
  return true;
}

const model = (n: string) => ({
  findUnique: async ({ where, include }: Row) => {
    const r = table(n).find((x) => match(x, where));
    if (!r) return null;
    if (include?.model) return { ...r, model: table('aIModel').find((m) => m.id === r.modelId) };
    return { ...r };
  },
  findFirst: async ({ where, orderBy }: Row = {}) => {
    let rows = table(n).filter((x) => match(x, where));
    if (orderBy) { const [[k, dir]] = Object.entries(orderBy as Row); rows = [...rows].sort((a, b) => (a[k] > b[k] ? 1 : -1) * (dir === 'desc' ? -1 : 1)); }
    return rows[0] ? { ...rows[0] } : null;
  },
  findMany: async ({ where, orderBy }: Row = {}) => {
    let rows = table(n).filter((x) => match(x, where));
    if (orderBy) { const [[k, dir]] = Object.entries(orderBy as Row); rows = [...rows].sort((a, b) => (a[k] > b[k] ? 1 : -1) * (dir === 'desc' ? -1 : 1)); }
    return rows.map((r) => ({ ...r }));
  },
  count: async ({ where }: Row = {}) => table(n).filter((x) => match(x, where)).length,
  create: async ({ data }: Row) => { const r = { id: `${n}-${++seq}`, createdAt: new Date(), ...data }; table(n).push(r); return { ...r }; },
  update: async ({ where, data }: Row) => { const r = table(n).find((x) => match(x, where)); if (!r) throw new Error('not found'); Object.assign(r, data); return { ...r }; },
  updateMany: async ({ where, data }: Row) => { const rows = table(n).filter((x) => match(x, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; },
  upsert: async ({ where, create, update }: Row) => {
    const r = table(n).find((x) => match(x, where));
    if (r) { Object.assign(r, update); return { ...r }; }
    const c = { id: `${n}-${++seq}`, createdAt: new Date(), ...create }; table(n).push(c); return { ...c };
  },
});

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$transaction') return async (fn: any) => fn(jest.requireMock('../src/config/database').prisma);
      if (typeof k !== 'string' || k.startsWith('$')) return async () => null;
      return model(k);
    },
  }),
}));

import { generateKeyPairSync } from 'crypto';
import { authorizeAgentJob, AGENT_PROFILES } from '../src/platform/intelligence/agent-jobs';
import { engageKillSwitch, releaseKillSwitch } from '../src/platform/intelligence/agents';
import { reviewDecision } from '../src/services/ai-orchestrator.service';
import * as promotion from '../src/services/ai-model-promotion.service';
import { activateModel, resolveModel, updateModel } from '../src/services/ai-model-registry.service';
import * as fed from '../src/federated/federated.service';
import { selectForTraining } from '../src/platform/intelligence/training-data';
import { __resetClubAiPolicyCache } from '../src/platform/intelligence/club-ai-policy';
import { signRecommendation, verifyRecommendation, canonical } from '../src/security-n/signed-recommendations.service';

beforeEach(() => {
  for (const k of Object.keys(T)) delete T[k];
  __resetClubAiPolicyCache();
  releaseKillSwitch();
});

const actor = (userId: string, clubId = 'c-1', isPlatformAdmin = false) =>
  ({ userId, ipAddress: null, userAgent: null, scope: { isPlatformAdmin, platformRole: null, userId, clubId, userRole: 'CLUB_ADMIN', investorId: null, franchiseUnitIds: new Set(), entityIds: new Set() } }) as any;

// ─────────────────────────────────────────────────────────────────────────────
describe('agents: an action is refused, approved or stopped — never just run', () => {
  const job = (agent: string, kind: string, input: unknown = {}) => ({ agent: agent as any, kind, input: input as any, clubId: 'c-1' });

  it('analysis runs without approval for every agent', () => {
    for (const agent of Object.keys(AGENT_PROFILES)) {
      expect(authorizeAgentJob(job(agent, 'MATCH_REVIEW'))).toMatchObject({ allowed: true, requiresApproval: false, actionKind: null });
    }
  });

  it('an action inside the agent\'s profile needs a person\'s approval', () => {
    expect(authorizeAgentJob(job('COMMS', 'MASS_MESSAGE_PARENTS'))).toMatchObject({ allowed: true, requiresApproval: true, actionKind: 'MASS_MESSAGE' });
    expect(authorizeAgentJob(job('MEDICAL', 'MEDICAL_RECOMMENDATION_RTP'))).toMatchObject({ allowed: true, requiresApproval: true });
  });

  it('an action outside it is refused whatever approval exists', () => {
    expect(authorizeAgentJob(job('COMMS', 'PAYOUT_BONUS'))).toMatchObject({ allowed: false, actionKind: 'PAYMENT_ACTION' });
    expect(authorizeAgentJob(job('FINANCE', 'MASS_MESSAGE'))).toMatchObject({ allowed: false });
    expect(authorizeAgentJob(job('TRAINING', 'X', { requiresApproval: true, approvalKind: 'APPROVE_TRANSFER' }))).toMatchObject({ allowed: false });
  });

  it('deleting data is refused for every agent', () => {
    for (const agent of Object.keys(AGENT_PROFILES)) expect(authorizeAgentJob(job(agent, 'DATA_PURGE')).allowed).toBe(false);
  });

  it('the kill switch stops actions and leaves analysis running', () => {
    engageKillSwitch('test');
    expect(authorizeAgentJob(job('COMMS', 'MASS_MESSAGE')).allowed).toBe(false);
    expect(authorizeAgentJob(job('COMMS', 'WEEKLY_DIGEST')).allowed).toBe(true);
  });

  it('the medical agent\'s prompts are declared RESTRICTED to the gateway', () => {
    expect(authorizeAgentJob(job('MEDICAL', 'FATIGUE_SCAN')).dataClass).toBe('RESTRICTED');
  });
});

describe('decisions: accepting one that acts takes a second person from the same club', () => {
  const seed = (over: Row = {}) => table('aIDecision').push({ id: 'd-1', clubId: 'c-1', modelId: 'm', status: 'GENERATED', generatedByUserId: 'u-gen', recommendation: { kind: 'SELL_PLAYER', label: 'Sell' }, ...over });

  it('the person who generated it cannot accept it', async () => {
    seed();
    await expect(reviewDecision(actor('u-gen'), 'd-1', 'ACCEPTED', '')).rejects.toThrow(/someone other than/);
    await expect(reviewDecision(actor('u-other'), 'd-1', 'ACCEPTED', '')).resolves.toMatchObject({ status: 'ACCEPTED' });
  });

  it('a decision that only informs can be accepted by its author', async () => {
    seed({ recommendation: { kind: 'MONITOR_PLAYER', label: 'Monitor' } });
    await expect(reviewDecision(actor('u-gen'), 'd-1', 'ACCEPTED', '')).resolves.toMatchObject({ status: 'ACCEPTED' });
  });

  it('another club cannot review it at all', async () => {
    seed();
    await expect(reviewDecision(actor('u-other', 'c-2'), 'd-1', 'REJECTED', '')).rejects.toThrow(/not found/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('model registry: nothing is ACTIVE without a signed promotion', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const m = () => table('aIModel').find((x) => x.id === 'm-1')!;
  beforeEach(() => {
    process.env.MODEL_SIGNING_PRIVATE_KEY = privB64;
    delete process.env.MODEL_SIGNING_PUBLIC_KEY;
    table('aIModel').push({ id: 'm-1', slug: 'player.injury-risk', name: 'x', version: '1.0.0', provider: 'HYBRID', domain: 'PLAYER', decisionType: 'INJURY_RISK',
      inputSchema: { a: 1 }, outputSchema: { b: 2 }, parameters: { threshold: 70 }, isActive: false, deprecatedAt: null, releasedAt: null });
  });
  afterAll(() => { delete process.env.MODEL_SIGNING_PRIVATE_KEY; });

  it('the requester cannot approve their own promotion', async () => {
    const p = await promotion.requestPromotion({ userId: 'u-a' }, 'm-1');
    await expect(promotion.approvePromotion({ userId: 'u-a' }, p.id)).rejects.toThrow(/someone other than/);
  });

  it('a second person approves; the signature verifies; the model can then be activated and resolved', async () => {
    await expect(activateModel(actor('u-b'), 'm-1', { deactivatePeers: true })).rejects.toThrow(/no approved promotion/);
    const p = await promotion.requestPromotion({ userId: 'u-a' }, 'm-1');
    const { promotion: approved } = await promotion.approvePromotion({ userId: 'u-b' }, p.id);
    expect(approved).toMatchObject({ status: 'APPROVED', decidedById: 'u-b' });
    expect(approved.signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(await promotion.verifyModel(m() as any)).toMatchObject({ ok: true });
    await activateModel(actor('u-b'), 'm-1', { deactivatePeers: true });
    expect(m().isActive).toBe(true);
    await expect(resolveModel('PLAYER' as any, 'INJURY_RISK' as any)).resolves.toMatchObject({ id: 'm-1' });
  });

  it('a tampered artifact fails verification and is not resolved', async () => {
    const p = await promotion.requestPromotion({ userId: 'u-a' }, 'm-1');
    await promotion.approvePromotion({ userId: 'u-b' }, p.id);
    await activateModel(actor('u-b'), 'm-1', { deactivatePeers: true });
    m().parameters = { threshold: 1 }; // changed in the database behind the registry's back
    expect(await promotion.verifyModel(m() as any)).toEqual({ ok: false, reason: 'the model changed after it was approved' });
    await expect(resolveModel('PLAYER' as any, 'INJURY_RISK' as any)).rejects.toThrow(/not verified/);
  });

  it('a signature from another key fails', async () => {
    const p = await promotion.requestPromotion({ userId: 'u-a' }, 'm-1');
    await promotion.approvePromotion({ userId: 'u-b' }, p.id);
    process.env.MODEL_SIGNING_PRIVATE_KEY = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    expect((await promotion.verifyModel(m() as any)).ok).toBe(false);
  });

  it('without a signing key nothing can be approved', async () => {
    delete process.env.MODEL_SIGNING_PRIVATE_KEY;
    const p = await promotion.requestPromotion({ userId: 'u-a' }, 'm-1');
    await expect(promotion.approvePromotion({ userId: 'u-b' }, p.id)).rejects.toThrow(/not configured/);
  });

  it('a model cannot be activated by editing it, and an active one cannot be changed', async () => {
    await expect(updateModel(actor('u-a'), 'm-1', { isActive: true } as any)).rejects.toThrow(/approved promotion/);
    m().isActive = true;
    await expect(updateModel(actor('u-a'), 'm-1', { parameters: { threshold: 1 } } as any)).rejects.toThrow(/cannot be changed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('federated learning', () => {
  const club = (clubId: string, role = 'CLUB_ADMIN') => ({ userId: `u-${clubId}`, clubId, role });
  const g = (n: number, scale = 0.1) => Array.from({ length: n }, (_, i) => Math.round(Math.sin(i + 1) * scale * 1e6) / 1e6);
  const submit = (clubId: string, gradient: number[], over: Row = {}) =>
    fed.submitGradient(club(clubId), 'job-1', { payloadHash: fed.gradientHash(gradient), gradient, nonce: `nonce-${clubId}-${++seq}-xxxx`, ...over } as any);
  const trust = (clubId: string) => table('federatedTrustBoundary').push({ id: `t-${clubId}`, modelFamily: 'fam', clubId, trusted: true });
  const consent = (clubId: string) => table('clubAiDataPolicy').push({ clubId, restrictedEgress: false, trainingUse: true });

  beforeEach(() => {
    table('federatedTrainingJob').push({ id: 'job-1', modelFamily: 'fam', status: 'RUNNING', initiatorClubId: 'c-1', clippingNormMax: null, aggregationSeed: BigInt(7), privacyBoundaryId: null });
  });

  it('a club with no trust record is refused — default deny', async () => {
    consent('c-1');
    await expect(submit('c-1', g(10))).rejects.toThrow(/not trusted/);
  });

  it('a trusted club that has not allowed training use is refused', async () => {
    trust('c-1');
    await expect(submit('c-1', g(10))).rejects.toThrow(/not allowed its data to be used for training/);
  });

  it('the server computes the norm; a false self-reported size is ignored', async () => {
    trust('c-1'); consent('c-1');
    const grad = g(10);
    const env = await submit('c-1', grad, { normValue: 0.0001 });
    expect(env.normValue).toBeCloseTo(fed.l2Norm(grad), 10);
    expect(env.normValue).not.toBe(0.0001);
  });

  it('a hash that is not the gradient\'s, an oversized norm and a second contribution are refused', async () => {
    trust('c-1'); consent('c-1');
    await expect(submit('c-1', g(10), { payloadHash: 'a'.repeat(64) })).rejects.toThrow(/does not match/);
    await expect(submit('c-1', g(10, 50))).rejects.toThrow(/exceeds the clipping norm/);
    await submit('c-1', g(10));
    await expect(submit('c-1', g(10))).rejects.toThrow(/already contributed/);
  });

  it('only the club that started the round, or the platform owner, aggregates it', async () => {
    await expect(fed.aggregate(club('c-2'), 'job-1', 'v1')).rejects.toThrow(/started it or the platform owner/);
  });

  it('an outlier is rejected at aggregation and left out of the checkpoint', async () => {
    for (const c of ['c-1', 'c-2', 'c-3', 'c-4']) { trust(c); consent(c); }
    await submit('c-1', g(10, 0.1));
    await submit('c-2', g(10, 0.11));
    await submit('c-3', g(10, 0.12));
    await submit('c-4', g(10, 1.5)); // within the clip, far above the median
    const cp = await fed.aggregate(club('c-1'), 'job-1', 'v1');
    expect(cp.participants).toBe(3);
    expect(table('federatedGradientEnvelope').find((e) => e.clubId === 'c-4')?.rejectedReason).toMatch(/outlier/);
  });

  it('trust is granted by the platform owner only', async () => {
    await expect(fed.publishTrust(club('c-1'), 'fam', 'c-9', true)).rejects.toThrow(/platform owner/);
    await expect(fed.publishTrust(club('c-1', 'SUPER_ADMIN'), 'fam', 'c-9', true)).resolves.toMatchObject({ clubId: 'c-9', trusted: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('training data', () => {
  const child = new Date(Date.now() - 15 * 365.25 * 86_400_000);
  const adult = new Date('1990-01-01T00:00:00Z');
  const rec = (clubId: string, dob: Date | null, features: Row) => ({ clubId, subjectDateOfBirth: dob, features });

  it('a club that has not consented contributes nothing', async () => {
    const out = await selectForTraining([rec('c-1', adult, { overallRating: 80 })]);
    expect(out).toMatchObject({ rows: [], withoutConsent: 1 });
  });

  it('a minor\'s RESTRICTED features are excluded even with every switch on; an adult\'s are kept', async () => {
    table('clubAiDataPolicy').push({ clubId: 'c-1', restrictedEgress: true, trainingUse: true });
    const out = await selectForTraining([
      rec('c-1', child, { overallRating: 61, isInjured: true, condition: 70, injuryCount365d: 2 }),
      rec('c-1', adult, { overallRating: 88, isInjured: true }),
    ]);
    expect(out.rows[0].features).toEqual({ overallRating: 61 });
    expect(out.rows[1].features).toEqual({ overallRating: 88, isInjured: true });
    expect(out.withheld).toEqual({ isInjured: 1, condition: 1, injuryCount365d: 1 });
  });

  it('RESTRICTED and unclassified features need the RESTRICTED switch too; an unknown birth date counts as a minor', async () => {
    table('clubAiDataPolicy').push({ clubId: 'c-1', restrictedEgress: false, trainingUse: true });
    const out = await selectForTraining([rec('c-1', adult, { overallRating: 88, isInjured: true, brandNewFeature: 1 })]);
    expect(out.rows[0].features).toEqual({ overallRating: 88 });
    table('clubAiDataPolicy')[0].restrictedEgress = true; __resetClubAiPolicyCache();
    expect((await selectForTraining([rec('c-1', null, { isInjured: true })])).rows[0].features).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('recommendation signatures cover the whole recommendation', () => {
  it('the canonical form keeps nested keys (the old one signed the payload as {})', () => {
    expect(canonical({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  });

  it('a tampered payload fails, and a pre-fix n1 signature never verifies', async () => {
    const payload = { score: 91, components: { pace: 0.9 }, athleteIdHash: 'abc' };
    const row = await signRecommendation('c-1', 'r-1', 'GLOBAL_RANKING', payload);
    expect(row.signerVersion).toBe('n2');
    expect(verifyRecommendation('c-1', 'GLOBAL_RANKING', payload, row.signatureB64)).toBe(true);
    expect(verifyRecommendation('c-1', 'GLOBAL_RANKING', { ...payload, score: 99 }, row.signatureB64)).toBe(false);
    expect(verifyRecommendation('c-1', 'GLOBAL_RANKING', { ...payload, components: { pace: 0.1 } }, row.signatureB64)).toBe(false);
    expect(verifyRecommendation('c-2', 'GLOBAL_RANKING', payload, row.signatureB64)).toBe(false);
    expect(verifyRecommendation('c-1', 'GLOBAL_RANKING', payload, row.signatureB64, 'n1')).toBe(false);
  });
});
