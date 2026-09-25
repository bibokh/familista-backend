/**
 * tests/data-vault.unit.test.ts
 *
 * The Platform Owner Data Vault — the product layer over the historical store.
 *
 * Four properties, and they are the whole reason this module is allowed to
 * exist beside the store rather than inside it:
 *
 *   · It OWNS no storage. Every figure comes from the historical API, every
 *     aggregate is computed in SQL, and the module issues no write of any kind.
 *   · It INVENTS no activity. A measured zero renders as a zero; an absent
 *     figure renders as a dash with a reason. There is no demo telemetry — no
 *     event counts, uptimes, byte totals or continent counts that the backend
 *     does not actually return.
 *   · It REVEALS nothing the write path withheld. The inspector draws an
 *     explicit field list, so a column added to the API tomorrow cannot appear
 *     on screen without a person adding it here.
 *   · It is GUARDED by the platform, not by the navigation. Hiding a card is a
 *     courtesy; the routes refuse a club account whatever is drawn.
 *
 * The frontend half is asserted by reading the source. That is deliberate: the
 * rules above are structural claims — "no write verb exists", "no second source
 * list exists" — and a rendering test would prove them only for the one path it
 * happened to walk.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const VAULT_JS = path.join(ROOT, 'public/data-vault/data-vault.js');
const VAULT_CSS = path.join(ROOT, 'public/data-vault/data-vault.css');
const APP_JS = path.join(ROOT, 'public/app.js');
const APP_CSS = path.join(ROOT, 'public/app.css');
const INDEX = path.join(ROOT, 'public/index.html');
const I18N_DIR = path.join(ROOT, 'public/data-vault/i18n');
const ROUTES = path.join(ROOT, 'src/routes/fabric.routes.ts');
const STATS = path.join(ROOT, 'src/fabric/history/history-stats.service.ts');

const read = (p: string) => fs.readFileSync(p, 'utf8');

/**
 * The file with its comments removed.
 *
 * Several assertions below are of the form "this word never appears". The Data
 * Vault's own header explains at length WHY a password can never reach the
 * historical store, so a naive search finds the word in the paragraph promising
 * it is absent. Stripping comments first is the difference between testing the
 * code and testing the prose about the code.
 */
const codeOf = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');

// ── the backend aggregate service ────────────────────────────────────────────
// A real mock: every aggregate call is recorded, so a test can assert that the
// service asked the DATABASE to count rather than fetching rows and counting
// them itself. A page that downloaded history to total it would pass a value
// assertion and fail this one, which is the point.

type Call = { model: string; op: string; args: any };
const calls: Call[] = [];

const historyRows = {
  groupBy: [] as any[],
  groupByToday: [] as any[],
  groupByEntity: [] as any[],
  groupByEntityWithId: [] as any[],
  counts: { total: 0, today: 0, month: 0, year: 0 },
  aggregate: {} as any,
};

let groupByCall = 0;

const fabricEventHistory = {
  count: async (args: any) => {
    calls.push({ model: 'fabricEventHistory', op: 'count', args });
    const where = args?.where?.occurredAt?.gte as Date | undefined;
    if (!where) return historyRows.counts.total;
    // The three calendar buckets are distinguished by how far back they reach.
    const now = new Date();
    if (where.getUTCMonth() === 0 && where.getUTCDate() === 1) return historyRows.counts.year;
    if (where.getUTCDate() === 1) return historyRows.counts.month;
    void now;
    return historyRows.counts.today;
  },
  groupBy: async (args: any) => {
    calls.push({ model: 'fabricEventHistory', op: 'groupBy', args });
    groupByCall += 1;
    if (args?.by?.[0] === 'entityType') {
      return args?.where?.entityId ? historyRows.groupByEntityWithId : historyRows.groupByEntity;
    }
    if (args?.where?.occurredAt) return historyRows.groupByToday;
    return historyRows.groupBy;
  },
  aggregate: async (args: any) => {
    calls.push({ model: 'fabricEventHistory', op: 'aggregate', args });
    return historyRows.aggregate;
  },
  findMany: async (args: any) => {
    calls.push({ model: 'fabricEventHistory', op: 'findMany', args });
    return [];
  },
};

jest.mock('../src/config/database', () => ({ prisma: { fabricEventHistory } }));

import {
  historyStats, clubHistorySummary, entityTypesInHistory, boundsUtc,
} from '../src/fabric/history/history-stats.service';
import { fabricSources } from '../src/fabric/registry/source-registry';

// The registry populates itself at module load, exactly as the running server
// does it, so importing the service above is enough for these tests to see the
// real source and event taxonomy. Registering again would throw: a schema is a
// historical contract and the registry refuses to have one replaced.

beforeEach(() => {
  calls.length = 0;
  groupByCall = 0;
  historyRows.groupBy = [];
  historyRows.groupByToday = [];
  historyRows.groupByEntity = [];
  historyRows.groupByEntityWithId = [];
  historyRows.counts = { total: 0, today: 0, month: 0, year: 0 };
  historyRows.aggregate = { _count: { _all: 0 }, _min: { occurredAt: null }, _max: { occurredAt: null } };
});

// ─────────────────────────────────────────────────────────────────────────────
describe('historical aggregates are counted by the database', () => {
  it('never fetches rows to count them', async () => {
    historyRows.counts = { total: 4210, today: 12, month: 900, year: 4210 };
    await historyStats();
    const fetched = calls.filter((c) => c.op === 'findMany');
    expect(fetched).toHaveLength(0);
    expect(calls.filter((c) => c.op === 'count' || c.op === 'groupBy').length).toBeGreaterThan(0);
  });

  it('issues one grouped query for every source rather than one query per source', async () => {
    // The property that keeps this dashboard alive as sources are added: the
    // number of database round trips must not grow with the registry.
    await historyStats();
    const groupBys = calls.filter((c) => c.op === 'groupBy');
    expect(groupBys).toHaveLength(2);           // the rollup, and today's slice
    expect(fabricSources().length).toBeGreaterThan(2);
  });

  it('reports real totals and the calendar buckets it was given', async () => {
    historyRows.counts = { total: 4210, today: 12, month: 900, year: 4210 };
    const s = await historyStats();
    expect(s.total).toBe(4210);
    expect(s.today).toBe(12);
    expect(s.month).toBe(900);
    expect(s.year).toBe(4210);
  });

  it('buckets by UTC, so two readers in two zones agree what today counted', () => {
    const b = boundsUtc(new Date('2030-05-14T23:30:00Z'));
    expect(b.dayStart.toISOString()).toBe('2030-05-14T00:00:00.000Z');
    expect(b.monthStart.toISOString()).toBe('2030-05-01T00:00:00.000Z');
    expect(b.yearStart.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('the source list is the registry, never a second list', () => {
  it('returns one entry per registered source, even one that has recorded nothing', async () => {
    const s = await historyStats();
    expect(s.sources).toHaveLength(fabricSources().length);
    const ids = s.sources.map((x) => x.source).sort();
    expect(ids).toEqual(fabricSources().map((x) => x.id).sort());
  });

  it('gives a source with no history a measured zero, not an absent value', async () => {
    const s = await historyStats();
    const quiet = s.sources[0];
    expect(quiet.total).toBe(0);            // a real zero
    expect(quiet.earliest).toBeNull();      // and an honest absence
    expect(quiet.latest).toBeNull();
  });

  it('matches history rows on the source ID, which is what the column holds', async () => {
    // `history-record.ts` stores the event spec's `source`, and that is the id
    // (`clubs`), not the display name (`Clubs`). Keying on the name would show
    // every source as empty while the table was full.
    const first = fabricSources()[0];
    historyRows.groupBy = [{
      source: first.id,
      _count: { _all: 77 },
      _min: { occurredAt: new Date('2030-01-02T03:04:05Z') },
      _max: { occurredAt: new Date('2030-06-02T03:04:05Z') },
    }];
    historyRows.groupByToday = [{ source: first.id, _count: { _all: 5 } }];
    const s = await historyStats();
    const hit = s.sources.find((x) => x.source === first.id)!;
    expect(hit.total).toBe(77);
    expect(hit.today).toBe(5);
    expect(hit.earliest).toBe('2030-01-02T03:04:05.000Z');
    expect(hit.name).toBe(first.name);
  });

  it('reports history whose source the registry no longer declares rather than hiding it', async () => {
    historyRows.groupBy = [{
      source: 'a-source-that-was-removed',
      _count: { _all: 9 },
      _min: { occurredAt: new Date('2029-01-01T00:00:00Z') },
      _max: { occurredAt: new Date('2029-01-02T00:00:00Z') },
    }];
    const s = await historyStats();
    expect(s.unregisteredSources).toEqual([{ source: 'a-source-that-was-removed', total: 9 }]);
  });

  it('derives the window from the rollup rather than asking a third time', async () => {
    const [a, b] = fabricSources();
    historyRows.groupBy = [
      { source: a.id, _count: { _all: 2 }, _min: { occurredAt: new Date('2030-03-01T00:00:00Z') }, _max: { occurredAt: new Date('2030-03-09T00:00:00Z') } },
      { source: b.id, _count: { _all: 3 }, _min: { occurredAt: new Date('2030-01-15T00:00:00Z') }, _max: { occurredAt: new Date('2030-07-20T00:00:00Z') } },
    ];
    const s = await historyStats();
    expect(s.window.earliest).toBe('2030-01-15T00:00:00.000Z');
    expect(s.window.latest).toBe('2030-07-20T00:00:00.000Z');
  });
});

describe('an empty historical store reports emptiness honestly', () => {
  it('returns zero and two nulls rather than inventing a start date', async () => {
    const s = await historyStats();
    expect(s.total).toBe(0);
    expect(s.window.earliest).toBeNull();
    expect(s.window.latest).toBeNull();
    expect(s.unregisteredSources).toEqual([]);
  });

  it('gives a club with no recorded history a zero and two nulls', async () => {
    const c = await clubHistorySummary('club-with-no-history');
    expect(c.total).toBe(0);
    expect(c.earliest).toBeNull();
    expect(c.latest).toBeNull();
    expect(c.sources).toEqual([]);
  });

  it('refuses to query at all for an empty club id', async () => {
    const c = await clubHistorySummary('');
    expect(c.total).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('club history is scoped by the database, not by the caller', () => {
  it('puts the club id in the WHERE of every aggregate it runs', async () => {
    await clubHistorySummary('club-7');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.args.where.clubId).toBe('club-7');
  });

  it('orders the source distribution largest first', async () => {
    historyRows.aggregate = {
      _count: { _all: 30 },
      _min: { occurredAt: new Date('2030-01-01T00:00:00Z') },
      _max: { occurredAt: new Date('2030-02-01T00:00:00Z') },
    };
    historyRows.groupBy = [
      { source: 'training', _count: { _all: 4 }, _min: { occurredAt: null }, _max: { occurredAt: null } },
      { source: 'matches', _count: { _all: 26 }, _min: { occurredAt: null }, _max: { occurredAt: null } },
    ];
    const c = await clubHistorySummary('club-7');
    expect(c.sources.map((x) => x.source)).toEqual(['matches', 'training']);
    expect(c.total).toBe(30);
  });
});

describe('entity lookup is offered only where it can actually succeed', () => {
  it('marks a kind whose identifiers the store withholds as NOT searchable', async () => {
    // PLAYER rows carry the type and a null id by design, so an id lookup would
    // always be empty. Reporting that is the difference between a limitation
    // and a broken search box.
    historyRows.groupByEntity = [
      { entityType: 'PLAYER', _count: { _all: 900 } },
      { entityType: 'CLUB', _count: { _all: 40 } },
    ];
    historyRows.groupByEntityWithId = [{ entityType: 'CLUB', _count: { _all: 40 } }];
    const out = await entityTypesInHistory();
    expect(out.find((x) => x.entityType === 'PLAYER')!.idSearchable).toBe(false);
    expect(out.find((x) => x.entityType === 'CLUB')!.idSearchable).toBe(true);
  });

  it('measures searchability from the rows rather than copying an allow-list', async () => {
    historyRows.groupByEntity = [{ entityType: 'CLUB', _count: { _all: 3 } }];
    historyRows.groupByEntityWithId = [];
    const out = await entityTypesInHistory();
    expect(out[0].idSearchable).toBe(false);
  });
});

// ── authorization ────────────────────────────────────────────────────────────

describe('every Data Vault route is refused to anyone but the platform owner', () => {
  const src = read(ROUTES);

  it('declares the new routes AFTER the router-level platform gate', () => {
    const gate = src.indexOf('assertPlatformOwner');
    expect(gate).toBeGreaterThan(-1);
    for (const route of ['/history/stats', '/history/clubs/:clubId/summary', '/history/entity-types']) {
      const at = src.indexOf(`'${route}'`);
      expect(at).toBeGreaterThan(gate);
    }
  });

  it('uses no club-level guard anywhere on this router', () => {
    expect(src).not.toMatch(/requireClubRole|clubScope|guardTeamScoped|requireRole\(/);
  });

  it('adds only GET routes — the Vault has nothing to write', () => {
    expect(src).not.toMatch(/router\.(post|put|patch|delete)\(/);
  });

  it('leaves authorization to the route, so the aggregate service holds none', () => {
    // A clubId narrows what is counted; it is NOT the boundary. Putting a
    // second authorization model in the service is how the two drift apart.
    const stats = read(STATS);
    expect(stats).not.toMatch(/assertPlatformOwner|isPlatformOwner|req\.user|role/);
  });
});

// ── the frontend module, read as source ──────────────────────────────────────

describe('the Data Vault writes nothing, anywhere', () => {
  const src = read(VAULT_JS);

  it('never issues a non-GET request', () => {
    expect(src).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i);
    expect(src).not.toMatch(/\.(post|put|patch|delete)\(/);
  });

  it('has exactly one fetch to the platform API, and it passes no method', () => {
    // Two fetches exist: this one, and the locale catalogue loader below it.
    // Only one of them talks to the platform, and it never names a verb — so
    // every request the Vault makes of Familista is a GET.
    const apiFn = src.slice(src.indexOf('function api(path)'), src.indexOf('// ── navigation'));
    expect((apiFn.match(/\bfetch\s*\(/g) || [])).toHaveLength(1);
    expect(apiFn).not.toMatch(/method/);
    const catalogue = src.slice(src.indexOf('function loadDict'), src.indexOf('function setLocale'));
    expect(catalogue).toContain("'/data-vault/i18n/'");
    expect(catalogue).not.toMatch(/method/);
    // And nowhere else in the module.
    expect((src.match(/\bfetch\s*\(/g) || [])).toHaveLength(2);
  });

  it('calls only the historical read endpoints and the club list', () => {
    const paths = [...src.matchAll(/api\('(\/[^']*)'/g)].map((m) => m[1]);
    for (const p of paths) {
      expect(p.startsWith('/system/fabric/history') || p === '/system/clubs').toBe(true);
    }
  });
});

describe('replay is observational, and says so', () => {
  const src = read(VAULT_JS);

  it('drives replay from the read-only replay endpoint', () => {
    expect(src).toContain("/system/fabric/history/replay");
  });

  it('contains nothing that could re-run a business action', () => {
    for (const verb of ['sendMail', 'notify(', 'publishFabricEvent', 'emit(', 'createTransfer', 'savePlayer']) {
      expect(src).not.toContain(verb);
    }
  });

  it('steps a cursor over rows already in memory rather than polling', () => {
    // A transport that re-fetched on every tick would be a polling loop wearing
    // a play button.
    const playBlock = src.slice(src.indexOf('function togglePlay'), src.indexOf('function bind'));
    expect(playBlock).not.toContain('api(');
    expect(playBlock).not.toContain('fetch(');
  });

  it('has no interval anywhere except the replay transport, and tears it down', () => {
    const intervals = src.match(/setInterval\(/g) || [];
    expect(intervals).toHaveLength(1);
    expect(src).toContain('clearInterval(playTimer)');
    expect(src).toContain('window.teardownFamilistaDataVault');
  });

  it('surfaces the API\'s own read-only guarantee rather than asserting it in prose', () => {
    expect(src).toContain('sideEffects');
    expect(src).toContain('readOnly');
  });
});

describe('the inspector shows an explicit field list and nothing else', () => {
  const src = read(VAULT_JS);
  const block = src.slice(src.indexOf('var VISIBLE_FIELDS'), src.indexOf('function sourceLabel'));

  it('is a named list, not a spread of whatever the API returned', () => {
    expect(block).toMatch(/var VISIBLE_FIELDS = \[/);
    const inspector = src.slice(src.indexOf('function inspectorHtml'), src.indexOf('// ── TIMELINE'));
    expect(inspector).toContain('VISIBLE_FIELDS.map');
    expect(inspector).not.toMatch(/Object\.keys\(r\)|for \(var k in r\)|\.\.\.r\b/);
  });

  it('names no field the historical store was never given', () => {
    const forbidden = [
      'password', 'token', 'apiKey', 'secret', 'email', 'phone', 'address',
      'diagnosis', 'medical', 'prompt', 'response', 'salary', 'contract',
      'payload', 'notes', 'message', 'url', 'storageKey', 'iban',
    ];
    const code = codeOf(block).toLowerCase();
    for (const f of forbidden) {
      expect(code).not.toContain(`'${f.toLowerCase()}'`);
    }
  });

  it('reads only `changedFields` out of metadata, which is the one approved key', () => {
    const inspector = src.slice(src.indexOf('function inspectorHtml'), src.indexOf('// ── TIMELINE'));
    const metaReads = [...inspector.matchAll(/v\.([a-zA-Z]+)/g)].map((m) => m[1]);
    expect(new Set(metaReads)).toEqual(new Set(['changedFields', 'teamId']));
  });

  it('says plainly that the payload was never recorded', () => {
    expect(src).toContain('never the event payload');
  });
});

describe('no demo telemetry anywhere', () => {
  const src = read(VAULT_JS);
  const css = read(VAULT_CSS);

  it('contains none of the invented figures a dashboard reaches for', () => {
    for (const fake of ['1.2B', '99.99', '38 TB', '5 continents', '99.9%', 'TB', 'PB']) {
      expect(src).not.toContain(fake);
    }
  });

  it('has no hard-coded source names — the registry supplies them', () => {
    // A second list in the frontend is the thing that goes stale. The only
    // names allowed here are the architecture's own layer labels.
    for (const name of ["'Users'", "'Players'", "'Training'", "'Matches'", "'Transfers'",
      "'Coach Market'", "'Medical'", "'Media'"]) {
      expect(src).not.toContain(name);
    }
  });

  it('distinguishes a measured zero from an absent figure', () => {
    expect(src).toContain('function has(v) { return v !== null && v !== undefined; }');
    expect(src).toMatch(/function metricHtml[\s\S]*?has\(value\)\s*\?/);
    expect(css).toContain('.dv-none');
  });

  it('renders every absent figure with a reason a reader can read', () => {
    expect(src).toMatch(/function absent\(why\)[\s\S]*?title="/);
  });
});

describe('date navigation maps to explicit UTC bounds', () => {
  const src = read(VAULT_JS);

  it('offers every preset the owner was promised', () => {
    const presets = src.slice(src.indexOf('var PRESETS'), src.indexOf('function dateNavHtml'));
    for (const p of ['today', 'yesterday', 'last7', 'month', 'lastMonth', 'year', 'custom']) {
      expect(presets).toContain(`'${p}'`);
    }
  });

  it('resolves a preset with Date.UTC rather than local-time arithmetic', () => {
    const block = src.slice(src.indexOf('function utcBounds'), src.indexOf('function drillBounds'));
    expect(block).toContain('Date.UTC');
    expect(block).not.toMatch(/getFullYear\(\)|getMonth\(\)|getDate\(\)(?!.*UTC)/);
  });

  it('supports a year → month → day → hour drill-down', () => {
    const block = src.slice(src.indexOf('function drillBounds'), src.indexOf('function defaultFilters'));
    for (const part of ['year', 'month', 'day', 'hour']) expect(block).toContain(`sel.${part}`);
  });

  it('sends the bounds as ISO instants on the query string', () => {
    const block = src.slice(src.indexOf('function queryFrom'), src.indexOf('var PRESETS'));
    expect(block).toContain("put('from', b.from.toISOString())");
    expect(block).toContain("put('to', b.to.toISOString())");
  });

  it('sends only fields the historical API actually supports', () => {
    const block = src.slice(src.indexOf('function queryFrom'), src.indexOf('var PRESETS'));
    const sent = [...block.matchAll(/put\('([a-zA-Z]+)'/g)].map((m) => m[1]);
    const supported = ['from', 'to', 'source', 'eventType', 'clubId', 'entityType',
      'entityId', 'correlationId', 'retentionClass', 'limit', 'cursor'];
    for (const s of sent) expect(supported).toContain(s);
  });
});

describe('paging is by cursor and always bounded', () => {
  const src = read(VAULT_JS);

  it('pages forward with the cursor the server returned', () => {
    expect(src).toContain('DV.page.nextCursor');
    expect(src).toContain("put('cursor', cursor)");
  });

  it('keeps a cursor stack so Previous is a real step back', () => {
    expect(src).toContain('DV.pages.push');
    expect(src).toContain('DV.pages.pop()');
  });

  it('never asks for an unbounded page', () => {
    expect(src).toMatch(/put\('limit', String\(f\.limit \|\| 50\)\)/);
    const sizes = src.slice(src.indexOf('[25, 50, 100, 200]'), src.indexOf('[25, 50, 100, 200]') + 30);
    expect(sizes).toContain('200');           // the API's own ceiling
  });

  it('renders one row per returned event and never the whole table', () => {
    expect(src).toContain('rows.map(eventRowHtml)');
    expect(src).not.toMatch(/limit=\d{4,}/);
  });
});

describe('the archive and snapshots are represented as what they are', () => {
  const src = read(VAULT_JS);

  it('shows the archive as NOT CONFIGURED from the backend\'s own answer', () => {
    expect(src).toContain('h.archive');
    expect(src).toContain("'Not configured'");
    expect(src).toContain('archiveHtml');
  });

  it('never simulates an archived object or a Parquet file', () => {
    expect(src).not.toMatch(/\.parquet['"]/);
    expect(src).not.toMatch(/batchId:\s*['"]/);
    expect(src).not.toContain('fakeArchive');
  });

  it('states that nothing is exported and nothing is purged', () => {
    expect(src).toContain('Nothing is exported and nothing is purged');
  });

  it('shows snapshots as NOT IMPLEMENTED and does not claim replay reconstructs state', () => {
    expect(src).toContain("'Not implemented'");
    expect(src).toContain('It does not reconstruct system state');
  });
});

describe('retention is reported, never enforced from here', () => {
  const src = read(VAULT_JS);

  it('shows the classes the backend exposed rather than a list of its own', () => {
    expect(src).toContain('h.retention');
    expect(src).toContain('r.classes');
    expect(src).not.toMatch(/\['OPERATIONAL',\s*'AUDIT'/);
  });

  it('invents no retention duration', () => {
    // Scoped to the retention section on purpose: "Last 7 days" is a date
    // preset in the explorer, and a test that forbade it everywhere would be
    // forbidding the wrong thing.
    const block = src.slice(src.indexOf('function retentionHtml'), src.indexOf('// ── content switch'));
    expect(block).not.toMatch(/\b\d+\s*(days?|months?|years?|weeks?)\b/i);
    expect(block).toContain('None defined');
  });

  it('offers no deletion control', () => {
    expect(src).not.toMatch(/data-dv-(delete|purge|remove)/);
    expect(src).toContain('does not offer deletion');
  });

  it('says automatic deletion is disabled when no policy is configured', () => {
    expect(src).toContain('Disabled — no policy configured');
  });
});

describe('storage never exposes infrastructure secrets', () => {
  const src = read(VAULT_JS);

  it('names no connection string, host, credential or Render identifier', () => {
    const code = codeOf(src);
    for (const leak of ['DATABASE_URL', 'DIRECT_URL', 'postgres://', 'postgresql://',
      'RENDER_', 'onrender.com', 'password', 'SECRET', 'ACCESS_KEY', 'AWS_']) {
      expect(code).not.toContain(leak);
    }
  });

  it('reads no credential-shaped key off any response it receives', () => {
    // Everything EXCEPT the request builder. `api()` reads the session token
    // out of local storage to authenticate the call — that is the caller's own
    // credential going out, not a secret coming back — and it is the same
    // pattern SYSTEM uses. Every other line is fair game.
    const code = codeOf(src);
    const apiStart = code.indexOf('function api(path)');
    const apiEnd = code.indexOf('var MODULES');
    expect(apiStart).toBeGreaterThan(-1);
    expect(apiEnd).toBeGreaterThan(apiStart);
    const rendering = code.slice(0, apiStart) + code.slice(apiEnd);
    for (const key of ['.password', '.token', '.secret', '.apiKey', '.connectionString']) {
      expect(rendering).not.toContain(key);
    }
  });

  it('says so on the screen, so a reader knows it is a boundary not an omission', () => {
    expect(src).toContain('are never shown here and are not available to this interface');
  });
});

// ── localisation ─────────────────────────────────────────────────────────────

describe('the Data Vault speaks English, German and Arabic — and only those', () => {
  const en = JSON.parse(read(path.join(I18N_DIR, 'en.json')));
  const de = JSON.parse(read(path.join(I18N_DIR, 'de.json')));
  const ar = JSON.parse(read(path.join(I18N_DIR, 'ar.json')));
  const src = read(VAULT_JS);

  it('ships exactly three catalogues', () => {
    expect(fs.readdirSync(I18N_DIR).sort()).toEqual(['ar.json', 'de.json', 'en.json']);
  });

  it('declares the three locales and their directions', () => {
    expect(src).toContain("['en', 'English', 'ltr']");
    expect(src).toContain("['de', 'Deutsch', 'ltr']");
    expect(src).toContain("['ar', 'العربية', 'rtl']");
  });

  it('has a German and an Arabic entry for every English key', () => {
    const keys = Object.keys(en);
    expect(keys.length).toBeGreaterThan(200);
    expect(Object.keys(de).sort()).toEqual(keys.sort());
    expect(Object.keys(ar).sort()).toEqual(keys.sort());
  });

  it('actually translates — no German or Arabic value is the English', () => {
    // Except for the handful that are the same word in every language.
    const sameEverywhere = new Set(['Familista', 'Data Fabric', 'Audit', 'Format', 'Status',
      'Engine', 'Governance', 'Snapshots', 'PostgreSQL', 'April', 'August', 'November',
      'September', 'Januar', 'Status']);
    for (const [k, v] of Object.entries(de)) {
      if (sameEverywhere.has(k)) continue;
      expect(typeof v).toBe('string');
      expect((v as string).length).toBeGreaterThan(0);
    }
    const untranslatedAr = Object.entries(ar)
      .filter(([k, v]) => !sameEverywhere.has(k) && v === k);
    expect(untranslatedAr).toEqual([]);
  });

  it('writes Arabic in Arabic script', () => {
    expect(ar['Overview']).toMatch(/[\u0600-\u06FF]/);
    expect(ar['Historical Explorer']).toMatch(/[\u0600-\u06FF]/);
    expect(ar['Timeline & Replay']).toMatch(/[\u0600-\u06FF]/);
  });

  it('sets the document direction from the locale, so Arabic renders RTL', () => {
    expect(src).toContain("host.setAttribute('dir', DV_DIR)");
    expect(src).toContain('DV_DIR = l[2]');
  });

  it('lays the shell out for RTL rather than only flipping the text', () => {
    const css = read(VAULT_CSS);
    expect(css).toContain('[dir="rtl"] .dv-shell { flex-direction: row-reverse; }');
    expect(css).toContain('border-inline-end');
    expect(css).toContain('inset-inline-end');
    expect(css).toContain('padding-inline-start');
  });

  it('never translates data — a club name, a source name or an event type', () => {
    expect(src).toMatch(/data-user-content/);
    expect(src).toMatch(/dv-event-type[^>]*data-no-i18n/);
    // The translator itself must skip both marks.
    const walker = src.slice(src.indexOf('function dvTranslate'), src.indexOf('function languageSwitchHtml'));
    expect(walker).toContain("hasAttribute('data-no-i18n')");
    expect(walker).toContain("hasAttribute('data-user-content')");
  });

  it('keeps its catalogue out of the platform\'s club-facing locale files', () => {
    // The boundary that lets three languages live beside thirty-two: the page
    // root is data-no-i18n, so the platform pass rejects this subtree outright.
    const app = read(APP_JS);
    expect(app).toContain('<div class="page" id="pg-data-vault" data-no-i18n>');
    const clubCatalogue = JSON.parse(read(path.join(ROOT, 'public/i18n/catalogue/de-DE.json')));
    expect(clubCatalogue['Historical Explorer']).toBeUndefined();
    expect(clubCatalogue['Hot historical store']).toBeUndefined();
  });

  it('has a catalogue entry for every string the module asks it to translate', () => {
    // The platform's extractor deliberately does NOT scan this module — it has
    // an explicit source list, and SYSTEM is absent from it for the same reason
    // — so the platform ratchet cannot see a new Data Vault string. This is
    // that ratchet, for this module: every T('…') must exist in the catalogue,
    // or the next person to add a line of interface text ships it in English.
    const asked = new Set<string>();
    for (const m of src.matchAll(/\bT\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) {
      asked.add(m[1].replace(/\\'/g, "'"));
    }
    // And the T(variable) call sites too. Those are fed from the lists below,
    // and they are exactly the gap that let four diagram labels render in
    // English inside an Arabic page: a literal-only scan cannot see them.
    const listOf = (re: RegExp) => (src.match(re) || [''])[0];
    const lists = [
      listOf(/var MODULES = \[[\s\S]*?\];/),
      listOf(/var GROUP_LABEL = \{[\s\S]*?\};/),
      listOf(/var VISIBLE_FIELDS = \[[\s\S]*?\];/),
      listOf(/\[\s*'Familista modules'[\s\S]*?\]\s*\.map/),
    ];
    for (const block of lists) {
      expect(block.length).toBeGreaterThan(0);
      for (const m of block.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
        const v = m[1].replace(/\\'/g, "'");
        if (/^[A-Z]/.test(v) && /[a-z ]/.test(v)) asked.add(v);
      }
    }
    expect(asked.size).toBeGreaterThan(100);
    const missing = [...asked].filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });

  it('routes the architecture diagram\'s own labels through the translator', () => {
    // The regression this pins: these were plain strings passed to pillar(),
    // so they never reached the catalogue and an Arabic reader saw two English
    // titles in the middle of the diagram.
    for (const label of ['Live Data Fabric', 'Hot History Store', 'Long-Term Archive',
      'Historical Memory of the Platform']) {
      expect(src).toContain(`T('${label}')`);
      expect(en[label]).toBeDefined();
      expect(ar[label]).toBeDefined();
      expect(de[label]).toBeDefined();
    }
  });

  it('leaves no prose in the markup that the catalogue has never seen', () => {
    // The strongest of the three localisation ratchets, and the one that would
    // have caught every gap the others missed: a string sitting literally
    // between > and < in a markup template IS text the translator walks. If it
    // is not in the catalogue it renders in English, whatever the locale.
    //
    // Two escapes, both deliberate: a tag marked `data-no-i18n` is a brand or a
    // technical identifier (Familista, PostgreSQL) and must NOT be translated,
    // and anything that is already a catalogue key is fine by definition.
    const code = codeOf(src);
    const leaks: string[] = [];
    for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
      const lit = m[1];
      if (!lit.includes('>')) continue;
      for (const t of lit.matchAll(/(<[^<>]*>)([^<>]{3,})</g)) {
        const tag = t[1];
        const text = t[2].replace(/\\'/g, "'").trim();
        if (!text || !/[a-z]{3}/.test(text)) continue;
        if (/^[\s\d.,:%×\/→—·-]+$/.test(text)) continue;
        if (tag.includes('data-no-i18n') || tag.includes('data-user-content')) continue;
        if (text in en) continue;
        leaks.push(text);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('marks the product name as a brand rather than translating it', () => {
    // "Familista Data Vault" is a name. Translating a name is a bug, and the
    // same rule the platform applies to club and player names applies here.
    expect(src).toContain('<div class="dv-core-title" data-no-i18n>Familista Data Vault</div>');
    expect(src).toContain('<span class="dv-rail-title" data-no-i18n>Data Vault</span>');
  });

  it('is not scanned by the platform extractor, and that is deliberate', () => {
    // If this ever changes, the module's 274 strings land in the club product's
    // 31 locale files overnight. The boundary is the explicit source list.
    const extractor = read(path.join(ROOT, 'scripts/i18n-extract.js'));
    const sources = extractor.slice(extractor.indexOf('const SOURCES = ['), extractor.indexOf('const OUT'));
    expect(sources).not.toContain('data-vault');
    expect(sources).not.toContain('system.js');
  });

  it('falls through to English for a missing key rather than showing a blank', () => {
    const t = src.slice(src.indexOf('function T(text)'), src.indexOf('function dvTranslate'));
    expect(t).toContain('return s;');
    expect(t).toContain('hasOwnProperty.call(DV_DICT, s)');
  });
});

// ── the landing, and the two products that were already there ────────────────

describe('the Platform Owner landing offers five rooms around one core', () => {
  const app = read(APP_JS);
  const css = read(APP_CSS);
  const landing = app.slice(app.indexOf('function _ownerHomeForPlatformOwner'),
    app.indexOf('function _ownerHomeForClubMember'));

  it('renders SYSTEM, CLUBS, DATA VAULT, INFRASTRUCTURE CITY, SOURCE CORE and FAMILISTA VISION in one card grid', () => {
    for (const title of ['>SYSTEM<', '>CLUBS<', '>DATA VAULT<', '>INFRASTRUCTURE CITY<', '>SOURCE CORE<']) {
      expect(landing).toContain(title);
    }
    const cards = [...landing.matchAll(/class="oh-card oh-card--(\w+)"/g)].map((m) => m[1]);
    // FAMILISTA VISION joined as the sixth. It is appended rather than
    // inserted: the five that were here keep their order, so a reader who knew
    // where a room was still finds it there.
    expect(cards).toEqual(['system', 'clubs', 'vault', 'city', 'core', 'vision']);
  });

  it('gives the rooms the same grid track, so none is subordinate', () => {
    // The four original rooms occupy the two outer columns in two rows — the
    // same track as each other. SOURCE CORE is not one of them and is placed
    // deliberately differently: it answers where the other four came from, and
    // it spans the middle column across both rows. FAMILISTA VISION takes a
    // full-width band beneath them: it describes something the platform HAS,
    // like the outer four, but its subject is a pitch rather than the platform
    // itself, and a band of its own says that without making it subordinate.
    expect(css).toContain('"system core   clubs"');
    expect(css).toContain('"vault  core   city"');
    expect(css).toContain('"vision vision vision"');
    expect(css).toContain('body.club-theme .oh-cards--core .oh-card--vision{ grid-area: vision; }');
    expect(css).toContain('body.club-theme .oh-cards--core .oh-card--core{   grid-area: core; }');
    // The orphaned four-column rule is gone rather than left behind to rot.
    expect(css).not.toContain('oh-cards--four');
  });

  it('does not nest one product inside another', () => {
    // Each card is a direct sibling: six buttons, one container, no card
    // contains another.
    const row = landing.slice(landing.indexOf('oh-cards oh-cards--core'), landing.indexOf('oh-footer'));
    expect((row.match(/<button class="oh-card/g) || [])).toHaveLength(6);
    expect(row).not.toMatch(/<button class="oh-card[\s\S]*?<button class="oh-card[\s\S]*?<\/button>\s*<\/button>/);
  });

  it('carries the descriptions the five modules were given', () => {
    expect(landing).toContain('Platform Operations, Infrastructure, Intelligence &amp; Governance');
    expect(landing).toContain('Football Organizations, Teams, People &amp; Operations');
    expect(landing).toContain('Historical Data, Archive, Replay &amp; Governance');
    expect(landing).toContain('Live Infrastructure, Technology, Health &amp; Architecture');
    expect(landing).toContain('Origins, Provenance, Lineage &amp; Dependency');
  });

  it('shows a REAL historical status, fetched, never a fixed string', () => {
    const filler = app.slice(app.indexOf('function _fillVaultStatus'), app.indexOf('function _ownerHomeForPlatformOwner'));
    expect(filler).toContain('/system/fabric/history/health');
    expect(filler).toContain('No historical events yet');
    expect(filler).toContain('Historical store unreachable');
    // and nothing invented while it waits
    expect(landing).toContain('Checking historical store');
  });

  it('reserves the status slot so the answer does not resize the card', () => {
    expect(css).toContain('min-height: 26px');
  });

  it('shows the Vault to the platform owner only', () => {
    const member = app.slice(app.indexOf('function _ownerHomeForClubMember'), app.indexOf('function _ownerHomeForClubMember') + 4000);
    expect(member).not.toContain('DATA VAULT');
    expect(member).not.toContain("data-page=\"data-vault\"");
  });
});

describe('SYSTEM and CLUBS still work exactly as they did', () => {
  const app = read(APP_JS);

  it('leaves both entry points in the allow-list', () => {
    expect(app).toMatch(/'system': 1,/);
    expect(app).toMatch(/'owner-home': 1, 'clubs': 1,/);
  });

  it('adds the Vault to the allow-list rather than replacing anything', () => {
    expect(app).toMatch(/'data-vault': 1,/);
  });

  it('still mounts SYSTEM at its own root', () => {
    expect(app).toContain("case 'pg-system':             renderFamilistaSystem(document.getElementById('sy-root')); break;");
    expect(app).toContain('<div class="page" id="pg-system" data-no-i18n><div id="sy-root"></div></div>');
  });

  it('does not add the Vault to SYSTEM\'s navigation', () => {
    const system = read(path.join(ROOT, 'public/system/system.js'));
    const modules = system.slice(system.indexOf('var MODULES = ['), system.indexOf('var GROUP_ORDER'));
    expect(modules).not.toContain('data-vault');
  });

  it('keeps SYSTEM and the Vault in separate stylesheets and separate roots', () => {
    const css = read(VAULT_CSS);
    expect(css).not.toContain('#pg-system');
    expect(css).not.toMatch(/\.sy-/);
  });
});

describe('the Vault is routed and loaded like the product it is', () => {
  const app = read(APP_JS);
  const index = read(INDEX);

  it('is reachable through the router', () => {
    expect(app).toContain("'data-vault':                  renderDataVaultHTML,");
    expect(app).toContain("case 'pg-data-vault':         renderFamilistaDataVault(document.getElementById('dv-root')); break;");
  });

  it('takes the shell the way SYSTEM does, and gives it back on the way out', () => {
    expect(app).toContain("document.body.classList.toggle('dv-vault-open', page === 'data-vault')");
    expect(app).toContain('teardownFamilistaDataVault');
  });

  it('is loaded by the page', () => {
    expect(index).toContain('/data-vault/data-vault.js');
    expect(index).toContain('/data-vault/data-vault.css');
  });
});

// ── layout stability and scale ───────────────────────────────────────────────

describe('nothing moves that the reader did not move', () => {
  const css = read(VAULT_CSS);
  const src = read(VAULT_JS);

  it('scrolls the body inside a fixed-height column with a stable gutter', () => {
    expect(css).toMatch(/\.dv-body\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.dv-body\s*\{[^}]*scrollbar-gutter:\s*stable/);
    expect(css).toMatch(/\.dv-shell\s*\{[^}]*height:\s*100vh/);
  });

  it('floats the inspector rather than inserting it into the flow', () => {
    expect(css).toMatch(/\.dv-insp\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/@keyframes dv-slide[^}]*\{[^}]*transform/);
  });

  it('animates on opacity and transform only', () => {
    const anims = css.match(/@keyframes[\s\S]*?\n\}/g) || [];
    for (const a of anims) {
      expect(a).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding):/);
    }
  });

  it('repaints the body region rather than the whole workspace', () => {
    expect(src).toContain('function repaintBody');
    expect(src).toContain("host.querySelector('#dv-body')");
  });

  it('paints the top bar above the body, so the language menu is clickable', () => {
    // A regression with teeth: every .dv-panel carries a backdrop-filter, which
    // creates a stacking context, so without an explicit position and z-index
    // on .dv-top the panels paint over the language dropdown and a German or
    // Arabic reader cannot select their language at all.
    const top = css.slice(css.indexOf('.dv-top {'), css.indexOf('.dv-top-eyebrow'));
    expect(top).toMatch(/position:\s*relative/);
    expect(top).toMatch(/z-index:\s*\d+/);
    const z = Number((top.match(/z-index:\s*(\d+)/) || [])[1]);
    const menuZ = Number((css.match(/\.dv-lang-menu[^}]*z-index:\s*(\d+)/) || [])[1]);
    expect(z).toBeGreaterThan(menuZ);
  });

  it('respects a reader who asked for less motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(src).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
  });

  it('animates only while replay is actually playing', () => {
    expect(css).toMatch(/\.dv-stage \.dv-src-chip\.is-pulse/);
    expect(css).not.toMatch(/animation:[^;]*infinite/);
  });

  it('carries the workspace escape hatch at both bounds', () => {
    expect(css).toContain('@media (max-width: 980px), (max-height: 620px)');
    const hatch = css.slice(css.indexOf('@media (max-width: 980px), (max-height: 620px)'));
    expect(hatch).toContain('overflow: visible');
  });

  it('has the workstation breakpoints the owner\'s screens need', () => {
    expect(css).toContain('@media (max-width: 1536px)');
    expect(css).toContain('@media (max-width: 1280px)');
  });

  it('sizes its skeletons like the content they stand in for', () => {
    expect(css).toMatch(/\.dv-skel-row\s*\{[^}]*height:\s*\d+px/);
    expect(src).toContain('function skeleton(rows)');
  });
});

describe('the interface is built for a store that grows', () => {
  const src = read(VAULT_JS);

  it('computes no aggregate in the browser', () => {
    // No client-side totalling of history. The only reduce-shaped thing allowed
    // is a percentage of a server-provided total for one bar.
    expect(src).not.toMatch(/rows\.(reduce|filter)\([^)]*\)\.length\s*\)/);
    expect(src).not.toContain('.reduce(function (acc');
  });

  it('takes its counts from the server, not from the rows it happens to hold', () => {
    expect(src).toContain("api('/system/fabric/history/count'");
    expect(src).toContain('DV.countTotal');
  });

  it('asks for the aggregate endpoint rather than paging to build one', () => {
    expect(src).toContain("api('/system/fabric/history/stats')");
  });
});
