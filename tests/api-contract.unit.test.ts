/**
 * tests/api-contract.unit.test.ts
 *
 * The gap between two correct halves.
 *
 * THE DEFECT THIS SUITE EXISTS FOR
 *
 * Infrastructure City shipped an inventory endpoint that returned districts,
 * components and future plots but not `relationships`. The route was correct.
 * The frontend was correct. Both compiled. 3664 tests passed. Three features —
 * the Connections list, the Change Impact paths and the dependency highlight an
 * alert lights up — rendered EMPTY, because the consumer guards every read with
 * `|| []` and an absent field is indistinguishable from an empty one.
 *
 * It was found by looking at a screenshot. This suite is the control that was
 * missing.
 *
 * TWO DIRECTIONS, AND NEITHER ALONE IS ENOUGH
 *
 *   BACKEND → SCHEMA   the real Express app is booted, the endpoint is called
 *                      through the real middleware stack, and the response is
 *                      parsed. A renamed, removed, retyped or newly-nullable
 *                      field fails here.
 *
 *   SCHEMA → FRONTEND  every path the consumer reads must be a path the schema
 *                      promises, and every path the contract claims the
 *                      consumer reads must actually appear in its source. A
 *                      frontend reading `dependencies` off a payload carrying
 *                      `relationships` fails here.
 *
 * The bug lived in the gap between two things that were each individually
 * right, so a test of either side alone would have passed through it exactly
 * as every existing test did.
 *
 * THE DATABASE
 *
 * Stubbed, deliberately. These are SHAPE assertions: what matters is that the
 * route assembles the response it promises, and that is true whether the store
 * holds zero rows or ten million. A test that needed a live Postgres would not
 * run in CI, and a contract test that does not run is not a contract.
 */

import type { Application } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);

/**
 * The platform owner this suite acts as.
 *
 * A real row shape through the real `authenticate` middleware and the real
 * `assertPlatformOwner` guard — the contract is only meaningful for a caller
 * the API would actually serve.
 */
const OWNER = {
  id: 'u-owner', email: 'owner@familista.test', role: 'SUPER_ADMIN',
  clubId: null, isActive: true, currentClubId: null, currentTeamId: null,
  tokenVersion: 0, platformAdmin: { isActive: true },
};

/**
 * A database that answers the shape of every query and the substance of none.
 *
 * An empty store is the hardest case for a shape contract, not the easiest: it
 * is where a route is most likely to return `undefined` instead of `[]`, or to
 * skip a field it only assembles when it has rows.
 */
jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$transaction') return async (fns: unknown) =>
        (Array.isArray(fns) ? [] : (fns as (tx: unknown) => unknown)({}));
      if (k === '$connect' || k === '$disconnect') return async () => {};
      if (k === 'user') return {
        findFirst: async () => OWNER, findUnique: async () => OWNER, count: async () => 1,
      };
      return new Proxy({}, { get: (_x, op: string) => async () => {
        if (op === 'count') return 0;
        if (op === 'findFirst' || op === 'findUnique') return null;
        if (op === 'aggregate') return { _count: 0, _sum: {}, _min: {}, _max: {} };
        return [];
      } });
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jwt = require('jsonwebtoken');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../src/app');

import {
  OWNER_API_CONTRACTS, envelope, InfraStreamFrameSchema, INFRA_STREAM_EVENT,
  InfraInventorySchema, InfraTopologySchema, InfraHealthSchema, VaultReplaySchema,
  InfraComponentSchema, MetricSchema,
  type ApiContract,
} from '../src/contracts/owner-api.contracts';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOf = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');

const TOKEN = jwt.sign({ sub: OWNER.id, role: OWNER.role }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const url = (c: ApiContract) => `/api/v1${c.endpoint}${c.query ?? ''}`;

let app: Application;
/** Captured once. Booting the app per assertion would dominate the runtime. */
const captured = new Map<string, { status: number; body: unknown }>();

beforeAll(async () => {
  app = createApp();
  for (const c of OWNER_API_CONTRACTS) {
    const res = await request(app).get(url(c)).set('Authorization', `Bearer ${TOKEN}`);
    captured.set(url(c), { status: res.status, body: res.body });
  }
}, 120_000);

/**
 * A failure a person can act on without opening the debugger.
 *
 * zod's default message names a path and a type. What an engineer needs at
 * 2am is the endpoint, the field, what was expected, what arrived, and WHICH
 * SCREEN breaks — the last of which zod cannot know and this can.
 */
function explain(c: ApiContract, err: z.ZodError, body: unknown): string {
  const data = (body as { data?: unknown })?.data;
  const lines = err.issues.slice(0, 12).map((i) => {
    const where = i.path.length ? i.path.join('.') : '(root)';
    let got: unknown = data;
    for (const seg of i.path) {
      got = got == null ? undefined : (got as Record<string, unknown>)[seg as string];
    }
    const received = got === undefined ? 'undefined'
      : got === null ? 'null'
        : Array.isArray(got) ? `Array(${got.length})`
          : `${typeof got}${typeof got === 'string' && got.length < 40 ? ` ${JSON.stringify(got)}` : ''}`;
    return `    expected  \`${where}\`  ${i.message}\n    received  ${received}`;
  });
  return [
    '',
    `${c.module} contract failed: ${c.endpoint}`,
    `    endpoint  GET ${url(c)}`,
    ...lines,
    `    consumer  ${c.consumer}`,
    '',
  ].join('\n');
}

function parseOrExplain(c: ApiContract): unknown {
  const hit = captured.get(url(c))!;
  expect(`${url(c)} → ${hit.status}`).toBe(`${url(c)} → 200`);
  const result = envelope(c.schema).safeParse(hit.body);
  if (!result.success) throw new Error(explain(c, result.error, hit.body));
  return (result.data as { data: unknown }).data;
}

// ── direction one: the backend returns what the contract promises ────────────

describe('every covered owner endpoint returns the shape its contract promises', () => {
  it.each(OWNER_API_CONTRACTS.map((c) => [`${c.module} · ${c.endpoint}`, c] as const))(
    '%s', (_name, c) => { parseOrExplain(c); },
  );

  it('wraps every response in the same envelope', () => {
    // Asserted once, explicitly: a route answering a bare object would break
    // every consumer at once, and nothing looked for it before.
    for (const c of OWNER_API_CONTRACTS) {
      const body = captured.get(url(c))!.body as Record<string, unknown>;
      expect(`${c.endpoint}: ${typeof body.success} ${typeof body.data}`)
        .toBe(`${c.endpoint}: boolean object`);
      expect(body.success).toBe(true);
    }
  });
});

// ── direction two: the frontend reads only what the contract promises ────────

describe('every consumer reads only fields its contract promises', () => {
  /** The keys a schema promises at the top level of `data`. */
  const topKeys = (schema: z.ZodTypeAny): Set<string> => {
    const s = schema as unknown as { _def?: { typeName?: string; shape?: () => Record<string, unknown> } };
    if (s._def?.typeName === 'ZodObject' && s._def.shape) return new Set(Object.keys(s._def.shape()));
    return new Set();
  };

  it.each(OWNER_API_CONTRACTS.filter((c) => c.reads.length)
    .map((c) => [`${c.module} · ${c.endpoint}`, c] as const))(
    '%s — declared reads exist in the schema', (_n, c) => {
      const promised = topKeys(c.schema);
      const missing = c.reads.filter((r) => !promised.has(r.split('.')[0]));
      if (missing.length) {
        throw new Error([
          '',
          `${c.module} contract failed: ${c.endpoint}`,
          `    endpoint  GET ${url(c)}`,
          ...missing.map((m) => `    expected  \`${m}\`  promised by the schema\n    received  not in the contract`),
          `    consumer  ${c.consumer}`,
          '',
        ].join('\n'));
      }
    },
  );

  it.each(OWNER_API_CONTRACTS.filter((c) => c.reads.length)
    .map((c) => [`${c.module} · ${c.endpoint}`, c] as const))(
    '%s — declared reads are really read by the consumer', (_n, c) => {
      // The other half of the pin. A `reads` list nobody checks against the
      // source rots into a wish list, and a rotted contract is worse than none.
      const src = codeOf(read(c.consumer!));
      const unread = c.reads.filter((r) => !new RegExp(`\\.${r.split('.')[0]}\\b`).test(src));
      expect({ endpoint: c.endpoint, consumer: c.consumer, declaredButNeverRead: unread })
        .toEqual({ endpoint: c.endpoint, consumer: c.consumer, declaredButNeverRead: [] });
    },
  );

  it('the City reads nothing off its manifest that the inventory does not send', () => {
    // THE REGRESSION TEST. This is the exact defect, generalised: every
    // `IC.manifest.X` in the source must be a field the inventory contract
    // promises. Re-introducing the bug — dropping `relationships` from the
    // route, or adding a read for a field the route never sends — fails here
    // rather than in a screenshot three days later.
    const src = codeOf(read('public/infrastructure-city/infrastructure-city.js'));
    const promised = topKeys(InfraInventorySchema);
    const reads = new Set<string>();
    for (const m of src.matchAll(/\bIC\.manifest\.([A-Za-z_$][\w$]*)/g)) reads.add(m[1]);

    expect(reads.size).toBeGreaterThan(3);
    const unpromised = [...reads].filter((r) => !promised.has(r)).sort();
    if (unpromised.length) {
      throw new Error([
        '',
        'Infrastructure inventory contract failed: /system/infrastructure',
        `    endpoint  GET /api/v1/system/infrastructure`,
        ...unpromised.map((f) => `    expected  \`${f}\`  sent by the endpoint\n    received  not in the response`),
        '    consumer  public/infrastructure-city/infrastructure-city.js',
        '',
      ].join('\n'));
    }
    // And the field whose absence caused the defect is present on both sides.
    expect(reads.has('relationships')).toBe(true);
    expect(promised.has('relationships')).toBe(true);
  });

  it('the City reads nothing off its health frame that the endpoint does not send', () => {
    const src = codeOf(read('public/infrastructure-city/infrastructure-city.js'));
    const promised = topKeys(InfraHealthSchema);
    const reads = new Set<string>();
    for (const m of src.matchAll(/\bIC\.health\.([A-Za-z_$][\w$]*)/g)) reads.add(m[1]);
    expect(reads.size).toBeGreaterThan(2);
    expect([...reads].filter((r) => !promised.has(r)).sort()).toEqual([]);
  });
});

// ── the defect, reproduced ───────────────────────────────────────────────────

describe('the Infrastructure City defect class, reproduced', () => {
  it('fails when a promised array is absent, exactly as it did', () => {
    // The payload the endpoint USED to return: everything except the roads.
    const withoutRelationships = { ...(parseOrExplain(OWNER_API_CONTRACTS[0]) as Record<string, unknown>) };
    delete withoutRelationships.relationships;

    const result = envelope(InfraInventorySchema).safeParse({ success: true, data: withoutRelationships });
    expect(result.success).toBe(false);
    const issue = (result as { error: z.ZodError }).error.issues
      .find((i) => i.path.join('.') === 'data.relationships');
    expect(issue).toBeDefined();
    expect(issue!.message).toMatch(/Required/i);
  });

  it('fails when a promised array is present but empty, which renders identically', () => {
    // The subtler half. `[]` and `undefined` draw the same empty panel, so a
    // contract that accepted an empty roads list would not have caught this.
    const empty = { ...(parseOrExplain(OWNER_API_CONTRACTS[0]) as Record<string, unknown>), relationships: [] };
    expect(envelope(InfraInventorySchema).safeParse({ success: true, data: empty }).success).toBe(false);
  });

  it('fails when a field is renamed rather than removed', () => {
    const data = parseOrExplain(OWNER_API_CONTRACTS[2]) as Record<string, unknown>;
    const renamed: Record<string, unknown> = { ...data, relationships: data.edges };
    delete renamed.edges;
    expect(InfraTopologySchema.safeParse(renamed).success).toBe(false);
  });

  it('produces a message naming the endpoint, the field and the consumer', () => {
    // §12: a failure nobody can act on is a failure that gets re-run.
    const c = OWNER_API_CONTRACTS[0];
    const broken = { ...(parseOrExplain(c) as Record<string, unknown>) };
    delete broken.relationships;
    const err = (envelope(c.schema).safeParse({ success: true, data: broken }) as { error: z.ZodError }).error;
    const msg = explain(c, err, { data: broken });
    expect(msg).toContain('Infrastructure City contract failed: /system/infrastructure');
    expect(msg).toContain('GET /api/v1/system/infrastructure');
    expect(msg).toContain('`data.relationships`');
    expect(msg).toContain('received  undefined');
    expect(msg).toContain('consumer  public/infrastructure-city/infrastructure-city.js');
  });
});

// ── drift detection ──────────────────────────────────────────────────────────

describe('contract drift is detected, and formatting is not', () => {
  const inventory = () => parseOrExplain(OWNER_API_CONTRACTS[0]) as Record<string, unknown>;

  it('a wrong type fails', () => {
    const d = inventory();
    expect(InfraInventorySchema.safeParse({ ...d, counts: [] }).success).toBe(false);
    expect(InfraInventorySchema.safeParse({ ...d, generatedAt: 1234 }).success).toBe(false);
  });

  it('unexpected nullability fails', () => {
    const d = inventory();
    const comps = (d.components as Record<string, unknown>[]).map((c, i) =>
      (i === 0 ? { ...c, id: null } : c));
    expect(InfraInventorySchema.safeParse({ ...d, components: comps }).success).toBe(false);
  });

  it('a nullable field accepts null, and that is not drift', () => {
    // The inverse mistake: a contract that forbade a legitimate null would
    // fail on a component with no provider, which most of them are.
    expect(InfraComponentSchema.safeParse({
      id: 'x', name: 'X', district: 'core', category: 'c', type: 't',
      version: null, status: 'ACTIVE', runtime: null, provider: null, region: null,
      repositoryPath: null, sourceEvidence: 'f', dependencies: [], healthKey: null, note: null,
    }).success).toBe(true);
  });

  it('a changed enum value fails', () => {
    const h = parseOrExplain(OWNER_API_CONTRACTS[1]) as Record<string, unknown>;
    const signals = (h.signals as Record<string, unknown>[]).map((s, i) =>
      (i === 0 ? { ...s, state: 'DEGRADED' } : s));            // plausible, and not ours
    expect(InfraHealthSchema.safeParse({ ...h, signals }).success).toBe(false);
    expect(InfraHealthSchema.safeParse({ ...h, overall: 'PARTIAL' }).success).toBe(false);
  });

  it('a changed nested shape fails', () => {
    const t = parseOrExplain(OWNER_API_CONTRACTS[2]) as Record<string, unknown>;
    const nodes = (t.nodes as Record<string, unknown>[]).map((n, i) =>
      (i === 0 ? { ...n, dependencies: 'postgres' } : n));      // string, not array
    expect(InfraTopologySchema.safeParse({ ...t, nodes }).success).toBe(false);
  });

  it('a changed pagination shape fails', () => {
    const page = OWNER_API_CONTRACTS.find((c) => c.endpoint === '/system/fabric/history')!;
    const d = parseOrExplain(page) as Record<string, unknown>;
    // Cursor → offset is the classic silent paging break: the consumer asks
    // for the next page with a value the server no longer understands.
    const offsetStyle = { ...d, nextCursor: undefined, nextOffset: 0 };
    expect(page.schema.safeParse(offsetStyle).success).toBe(false);
    expect(page.schema.safeParse({ ...d, more: 'no' }).success).toBe(false);
  });

  it('key ORDER is not a contract, and reordering never fails', () => {
    // §8: semantics, not JSON formatting. A route that assembles its object in
    // a different order is not a breaking change and must not be treated as one.
    const d = inventory();
    const reversed = Object.fromEntries(Object.entries(d).reverse());
    expect(InfraInventorySchema.safeParse(reversed).success).toBe(true);
  });

  it('an ADDED field is not a breaking change', () => {
    // Additive changes are how an API grows. A contract that failed on them
    // would be renamed "the thing everyone disables".
    const d = inventory();
    expect(InfraInventorySchema.safeParse({ ...d, somethingNew: 42 }).success).toBe(true);
  });

  it('but an added field in the environment summary IS breaking', () => {
    // The one strict object in the contract, and deliberately so: the summary
    // may carry names and a count. A `values` key appearing there is a leak,
    // not a feature.
    const d = inventory();
    const env = { ...(d.environment as Record<string, unknown>), values: { DATABASE_URL: 'x' } };
    expect(InfraInventorySchema.safeParse({ ...d, environment: env }).success).toBe(false);
  });
});

// ── SSE ──────────────────────────────────────────────────────────────────────

describe('the live stream frame is the health contract, and a bad frame cannot crash the city', () => {
  it('the frame the server writes is the shape the schema promises', () => {
    // The stream carries a full health frame under one event name, so the
    // frame contract IS the health contract rather than a copy of it.
    const routes = codeOf(read('src/routes/infrastructure.routes.ts'));
    expect(routes).toContain("send('health', await infrastructureHealth())");
    expect(INFRA_STREAM_EVENT).toBe('health');
    const frame = parseOrExplain(OWNER_API_CONTRACTS[1]);
    expect(InfraStreamFrameSchema.safeParse(frame).success).toBe(true);
  });

  it('the frame carries the fields the dashboard reads off it', () => {
    const frame = parseOrExplain(OWNER_API_CONTRACTS[1]) as Record<string, unknown>;
    for (const f of ['overall', 'signals', 'incidents', 'counts', 'measuredAt', 'scope']) {
      expect({ field: f, present: f in frame }).toEqual({ field: f, present: true });
    }
    const signal = (frame.signals as Record<string, unknown>[])[0];
    for (const f of ['key', 'state', 'summary', 'measurements', 'evidence', 'measuredAt']) {
      expect({ field: f, present: f in signal }).toEqual({ field: f, present: true });
    }
  });

  it('a truncated or malformed frame is skipped rather than thrown', () => {
    // The reader's own guarantee, asserted on the reader: a half-written frame
    // arrives whenever a connection drops mid-write, and a dashboard that
    // throws on one is a dashboard that dies during exactly the incident it
    // was opened to explain.
    const city = codeOf(read('public/infrastructure-city/infrastructure-city.js'));
    const reader = city.slice(city.indexOf('function startStream'), city.indexOf('function onHealthFrame'));
    expect(reader).toContain('JSON.parse(payload)');
    expect(reader).toMatch(/try\s*\{[\s\S]*JSON\.parse[\s\S]*\}\s*catch/);
    expect(reader).toContain("if (!payload) return;");
    // A frame that is not the health event is ignored, not assumed.
    expect(reader).toContain("if (name === 'health')");
  });

  it('the server writes the SSE framing the reader parses', () => {
    const routes = codeOf(read('src/routes/infrastructure.routes.ts'));
    expect(routes).toContain('res.write(`event: ${event}\\ndata: ${JSON.stringify(data)}\\n\\n`)');
    const city = codeOf(read('public/infrastructure-city/infrastructure-city.js'));
    expect(city).toContain("buf.split('\\n\\n')");
    expect(city).toContain("line.indexOf('event:') === 0");
    expect(city).toContain("line.indexOf('data:') === 0");
  });
});

// ── privacy ──────────────────────────────────────────────────────────────────

describe('no covered response carries a secret', () => {
  const SECRET_SHAPES: [string, RegExp][] = [
    ['a postgres connection string', /postgres(?:ql)?:\/\/[^\s"']+/i],
    ['a redis connection string', /redis(?:s)?:\/\/[^\s"']+/i],
    ['a mongo connection string', /mongodb(?:\+srv)?:\/\/[^\s"']+/i],
    ['an Anthropic-style key', /\bsk-[A-Za-z0-9_-]{16,}/],
    ['a Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{8,}/],
    ['an AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
    ['a GitHub token', /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/],
    ['a PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['a JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ];

  it.each(OWNER_API_CONTRACTS.map((c) => [`${c.module} · ${c.endpoint}`, c] as const))(
    '%s carries no secret-shaped value', (_n, c) => {
      const raw = JSON.stringify(captured.get(url(c))!.body);
      for (const [what, re] of SECRET_SHAPES) {
        expect({ endpoint: c.endpoint, leaked: what, found: re.test(raw) })
          .toEqual({ endpoint: c.endpoint, leaked: what, found: false });
      }
    },
  );

  it.each(OWNER_API_CONTRACTS.map((c) => [`${c.module} · ${c.endpoint}`, c] as const))(
    '%s carries no secret-shaped KEY', (_n, c) => {
      // The other half: a value can be benign today and the key that holds it
      // still be the wrong key to have. `password: null` is a field waiting to
      // be filled in.
      const bad: string[] = [];
      const walk = (v: unknown, at: string, depth = 0): void => {
        if (depth > 8 || v === null || typeof v !== 'object') return;
        if (Array.isArray(v)) { v.slice(0, 5).forEach((x, i) => walk(x, `${at}[${i}]`, depth + 1)); return; }
        for (const [k, val] of Object.entries(v)) {
          if (/^(password|passwd|secret|token|apiKey|api_key|privateKey|credential|databaseUrl|connectionString)$/i.test(k)) {
            bad.push(`${at}.${k}`);
          }
          walk(val, `${at}.${k}`, depth + 1);
        }
      };
      walk(captured.get(url(c))!.body, 'data');
      expect({ endpoint: c.endpoint, secretShapedKeys: bad }).toEqual({ endpoint: c.endpoint, secretShapedKeys: [] });
    },
  );

  it('the infrastructure environment summary reports names and a count, never a value', () => {
    const d = parseOrExplain(OWNER_API_CONTRACTS[0]) as Record<string, unknown>;
    const env = d.environment as Record<string, unknown>;
    expect(Object.keys(env).sort()).toEqual(['architectural', 'secretShapedCount', 'total']);
    for (const name of env.architectural as string[]) {
      expect({ name, secretShaped: /SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL|PRIVATE/i.test(name) })
        .toEqual({ name, secretShaped: false });
    }
  });
});

// ── the invariants the contract also protects ────────────────────────────────

describe('contract-level invariants that are not merely shapes', () => {
  it('replay still reports that it does nothing', () => {
    const replay = OWNER_API_CONTRACTS.find((c) => c.endpoint === '/system/fabric/history/replay')!;
    const d = parseOrExplain(replay) as Record<string, unknown>;
    expect(d.readOnly).toBe(true);
    expect(d.sideEffects).toBe('NONE');
    // And the schema makes them literals, so a change to either fails here and
    // not in a review comment.
    expect(VaultReplaySchema.safeParse({ ...d, sideEffects: 'WRITES' }).success).toBe(false);
  });

  it('acknowledgement scope travels with every incident response', () => {
    const inc = OWNER_API_CONTRACTS.find((c) => c.endpoint === '/system/infrastructure/incidents')!;
    const d = parseOrExplain(inc) as Record<string, unknown>;
    expect(d.scope).toBe('PROCESS');
    expect(String(d.scopeNote)).toMatch(/does not survive a restart/i);
  });

  it('deployment is reported UNVERIFIED wherever it is reported at all', () => {
    const changes = OWNER_API_CONTRACTS.find((c) => c.endpoint === '/system/infrastructure/changes')!;
    const d = parseOrExplain(changes) as Record<string, unknown>;
    expect((d.deployment as Record<string, unknown>).state).toBe('UNVERIFIED');
    const inv = parseOrExplain(OWNER_API_CONTRACTS[0]) as Record<string, unknown>;
    expect((inv.deployment as Record<string, unknown>).observable).toBe(false);
  });

  it('a SYSTEM metric that nothing measures is null with a reason, never a zero', () => {
    const ov = parseOrExplain(OWNER_API_CONTRACTS.find((c) => c.endpoint === '/system/overview')!) as Record<string, unknown>;
    const metrics = Object.values({ ...(ov.access as object), ...(ov.activity as object) }) as Record<string, unknown>[];
    expect(metrics.length).toBeGreaterThan(3);
    for (const m of metrics) {
      expect(MetricSchema.safeParse(m).success).toBe(true);
      if (m.source === 'NOT_INSTRUMENTED') {
        expect({ how: m.how, value: m.value }).toEqual({ how: m.how, value: null });
      }
    }
  });

  it('every covered endpoint refuses a caller with no token', () => {
    // The contract is only a contract for a caller the API would serve. If any
    // of these answered 200 unauthenticated, the shape would be the least of it.
    return Promise.all(OWNER_API_CONTRACTS.map(async (c) => {
      const res = await request(app).get(url(c));
      expect({ endpoint: c.endpoint, status: res.status }).toEqual({ endpoint: c.endpoint, status: 401 });
    }));
  }, 60_000);
});

// ── runtime validation, in the browser ───────────────────────────────────────

describe('a malformed payload that reaches production fails loudly, not blankly', () => {
  const city = codeOf(read('public/infrastructure-city/infrastructure-city.js'));

  it('the City names the fields it cannot draw without', () => {
    expect(city).toContain('var REQUIRED = {');
    expect(city).toContain("manifest: ['districts', 'components', 'relationships']");
    expect(city).toContain("health: ['overall', 'signals', 'counts']");
  });

  it('those fields are exactly what the contract promises, so the two cannot drift', () => {
    // The browser guard and the CI contract are two statements of one fact. If
    // they disagree, one of them is lying and nobody knows which — so the test
    // that keeps them equal is the thing that makes the guard trustworthy.
    const declared = (key: string): string[] => {
      const m = city.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
      return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
    };
    const inventory = OWNER_API_CONTRACTS.find((c) => c.endpoint === '/system/infrastructure')!;
    const health = OWNER_API_CONTRACTS.find((c) => c.endpoint === '/system/infrastructure/health')!;
    const promised = (schema: z.ZodTypeAny) => new Set(Object.keys(
      (schema as unknown as { _def: { shape: () => Record<string, unknown> } })._def.shape(),
    ));

    for (const f of declared('manifest')) {
      expect({ field: f, promisedBy: '/system/infrastructure', ok: promised(inventory.schema).has(f) })
        .toEqual({ field: f, promisedBy: '/system/infrastructure', ok: true });
    }
    for (const f of declared('health')) {
      expect({ field: f, promisedBy: '/system/infrastructure/health', ok: promised(health.schema).has(f) })
        .toEqual({ field: f, promisedBy: '/system/infrastructure/health', ok: true });
    }
    // And the field whose absence started this is in the browser guard too.
    expect(declared('manifest')).toContain('relationships');
  });

  it('reports absence, and never reports a measured empty as a fault', () => {
    // The distinction the whole feature turns on. `[]` is a real answer about a
    // real platform; `undefined` is the platform failing to answer.
    const fn = city.slice(city.indexOf('function missingFields'), city.indexOf('function contractError'));
    expect(fn).toContain('=== undefined');
    expect(fn).toContain('=== null');
    expect(fn).not.toMatch(/\.length\s*===\s*0/);
  });

  it('says CONTRACT ERROR with the endpoint and the missing fields', () => {
    const fn = city.slice(city.indexOf('function contractError'), city.indexOf('function loadManifest'));
    expect(fn).toContain("T('CONTRACT ERROR')");
    expect(fn).toContain('endpoint');
    expect(fn).toContain("missing.join(', ')");
    // Translated, like everything else the reader sees.
    for (const tag of ['en', 'de', 'ar']) {
      const cat = JSON.parse(read(`public/infrastructure-city/i18n/${tag}.json`));
      expect({ tag, has: 'CONTRACT ERROR' in cat }).toEqual({ tag, has: true });
      expect({ tag, has: 'the response did not carry:' in cat }).toEqual({ tag, has: true });
    }
  });

  it('refuses the payload rather than half-drawing it', () => {
    const loader = city.slice(city.indexOf('function loadManifest'), city.indexOf('function loadIncidents'));
    expect(loader).toContain('IC.manifest = null;');
    expect(loader).toContain('IC.health = null;');
    expect(loader).toContain('IC.error = contractError(');
    // And an error with no manifest is drawn as an explicit failure state.
    expect(city).toContain("if (IC.error && !IC.manifest) {");
    expect(city).toContain("emptyState('Infrastructure City could not be read', IC.error)");
  });

  it('drops a malformed stream frame instead of installing it over a good one', () => {
    // Blanking a dashboard mid-incident because one frame arrived short is the
    // worst possible moment to lose the screen.
    const reader = city.slice(city.indexOf('function startStream'), city.indexOf('function onHealthFrame'));
    expect(reader).toContain('if (missingFields(data, REQUIRED.health).length) return;');
  });

  it('exposes no raw exception to a reader', () => {
    // §7: an error message is for a person, not a stack trace for a log.
    expect(city).not.toMatch(/\.stack\b/);
    expect(city).not.toMatch(/JSON\.stringify\(\s*(e|err|error)\s*\)/);
  });
});

// ── the registry itself ──────────────────────────────────────────────────────

describe('the contract registry stays honest', () => {
  it('names a consumer file that exists, or honestly names none', () => {
    for (const c of OWNER_API_CONTRACTS) {
      const exists = c.consumer === null ? true : fs.existsSync(path.join(ROOT, c.consumer));
      expect({ endpoint: c.endpoint, consumer: c.consumer, exists })
        .toEqual({ endpoint: c.endpoint, consumer: c.consumer, exists: true });
      // A contract that claims reads must name who does the reading.
      if (c.reads.length) expect({ endpoint: c.endpoint, hasConsumer: c.consumer !== null })
        .toEqual({ endpoint: c.endpoint, hasConsumer: true });
    }
  });

  it('records which served endpoints no screen consumes', () => {
    // Not a failure — a fact, pinned so it stays deliberate. Two endpoints are
    // served, guarded and shape-verified with nothing reading them. They are
    // still worth a contract: the day a screen does read them, it reads a shape
    // somebody has already checked.
    const unconsumed = OWNER_API_CONTRACTS.filter((c) => c.consumer === null).map((c) => c.endpoint).sort();
    expect(unconsumed).toEqual([
      '/system/infrastructure/components/postgres',
      '/system/infrastructure/topology',
    ]);
  });

  it('covers the owner-critical modules', () => {
    const modules = new Set(OWNER_API_CONTRACTS.map((c) => c.module));
    expect([...modules].some((m) => m.includes('Infrastructure City'))).toBe(true);
    expect([...modules].some((m) => m.includes('Data Vault'))).toBe(true);
    expect([...modules].some((m) => m === 'SYSTEM')).toBe(true);
    expect(OWNER_API_CONTRACTS.length).toBeGreaterThanOrEqual(13);
  });

  it('covers every Infrastructure City read endpoint the router serves', () => {
    // The coverage ratchet. A new GET on the infrastructure router without a
    // contract fails here, so the layer cannot quietly fall behind the API it
    // exists to protect.
    const routes = codeOf(read('src/routes/infrastructure.routes.ts'));
    const served = [...routes.matchAll(/router\.get\('([^']+)'/g)].map((m) => m[1])
      .filter((p) => p !== '/stream');                       // SSE, covered by its own block
    const covered = new Set(OWNER_API_CONTRACTS
      .filter((c) => c.endpoint.startsWith('/system/infrastructure'))
      .map((c) => c.endpoint.replace('/system/infrastructure', '') || '/'));
    const uncovered = served.filter((p) => !covered.has(p)
      && !(p.includes(':') && [...covered].some((cv) => cv.split('/').length === p.split('/').length)));
    expect({ served, uncovered }).toEqual({ served, uncovered: [] });
  });

  it('declares no duplicate endpoint', () => {
    const keys = OWNER_API_CONTRACTS.map((c) => url(c));
    expect(keys.length).toBe(new Set(keys).size);
  });
});
