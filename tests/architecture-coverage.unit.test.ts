/**
 * tests/architecture-coverage.unit.test.ts
 *
 * Cyber Defense, R5 — nothing can exist outside Cyber Defense.
 *
 * Before: about half the platform was in no inventory at all. The
 * infrastructure manifest had no AI agents, model registry, ML features,
 * federated learning, knowledge graph, video intelligence, devices, cameras or
 * edge nodes, and nothing tied a router, a package or a worker to a trust
 * boundary, so no control could be measured against them.
 *
 * After: scripts/security-discover.js reads twelve kinds of component from the
 * code; every one must be declared in src/cyber-defense/coverage-map.json
 * against the 38 trust-boundary rows; a covered row's controls must be
 * present; partial and uncovered rows say why and which batch closes them; the
 * number of weak rows may only fall. The city shows each component's coverage.
 */

import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkCoverage, ratchetHolds } = require('../scripts/lib/coverage-check');

const root = path.join(__dirname, '..');
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const manifest = read('src/cyber-defense/generated/security-manifest.json');
const policy = read('src/cyber-defense/posture-policy.json');
const map = read('src/cyber-defense/coverage-map.json');
const infra = read('src/infra/generated/infrastructure-manifest.json');

describe('the rule (fixtures)', () => {
  const fixtureMap = () => ({
    boundaries: {
      1: { coverage: 'C', controls: ['ctl-a'] },
      2: { coverage: 'P', controls: [], reason: 'not yet', plannedIn: 'Batch 9' },
    },
    components: {
      routers: { 'a.routes': [1] },
      packages: { express: [1] },
      srcDomains: { billing: [2] },
    },
  });
  const status = { 'ctl-a': 'PRESENT', 'ctl-b': 'PARTIAL' };
  const ok = { routers: ['a.routes'], packages: ['express'], srcDomains: ['billing'] };
  const yes = () => true;

  it('a fully declared fixture is clean', () => {
    expect(checkCoverage(ok, fixtureMap(), status, yes)).toMatchObject({ unmapped: [], stale: [], badRow: [], rowProblems: [] });
  });

  it('a new router, a new SDK import or a new src/ directory without a map entry fails', () => {
    const r = checkCoverage({ routers: ['a.routes', 'payouts.routes'], packages: ['express', 'axios'], srcDomains: ['billing', 'payments'] },
      fixtureMap(), status, yes);
    expect(r.unmapped).toEqual(['routers: payouts.routes', 'packages: axios', 'srcDomains: payments']);
  });

  it('a map entry for something the code no longer has fails as stale', () => {
    expect(checkCoverage({ routers: [], packages: ['express'], srcDomains: ['billing'] }, fixtureMap(), status, yes).stale)
      .toEqual(['routers: a.routes']);
  });

  it('a component declared against a row that does not exist fails', () => {
    const m = fixtureMap(); m.components.routers['a.routes'] = [99];
    expect(checkCoverage(ok, m, status, yes).badRow).toEqual(['routers: a.routes → row 99']);
  });

  it('a row cannot claim coverage its controls do not give', () => {
    const m = fixtureMap() as any;
    m.boundaries[2] = { coverage: 'C', controls: ['ctl-b'] };
    m.boundaries[3] = { coverage: 'C', controls: [] };
    m.boundaries[4] = { coverage: 'C', controls: [], pinnedBy: ['tests/missing.test.ts'] };
    m.boundaries[5] = { coverage: 'C', controls: ['ctl-nope'] };
    const r = checkCoverage(ok, m, status, (f: string) => f !== 'tests/missing.test.ts');
    expect(r.rowProblems).toEqual([
      'row 2: covered, but ctl-b is PARTIAL',
      'row 3: covered with no control and no pinning test',
      'row 4: covered with no control and no pinning test',
      'row 4: a pinning test does not exist',
      'row 5: unknown control ctl-nope',
    ]);
  });

  it('a partial or uncovered row must say why and which batch closes it', () => {
    const m = fixtureMap() as any; delete m.boundaries[2].plannedIn;
    expect(checkCoverage(ok, m, status, yes).rowProblems).toEqual(['row 2: P needs a reason and the batch that closes it']);
  });

  it('the ratchet only moves down', () => {
    expect(ratchetHolds({ C: 10, P: 5, U: 3 }, { P: 5, U: 3 })).toBe(true);
    expect(ratchetHolds({ C: 11, P: 5, U: 2 }, { P: 5, U: 3 })).toBe(true);   // U closed to P
    expect(ratchetHolds({ C: 10, P: 4, U: 4 }, { P: 5, U: 3 })).toBe(false);  // P regressed to U
    expect(ratchetHolds({ C: 9, P: 6, U: 3 }, { P: 5, U: 3 })).toBe(false);   // C regressed to P
    expect(ratchetHolds({ C: 9, P: 6, U: 3 }, {})).toBe(false);
  });
});

describe('the repository', () => {
  const a = manifest.architecture;

  it('discovers all twelve kinds of component from the code', () => {
    expect(Object.keys(a.components).sort()).toEqual(['envVars', 'infrastructureComponents', 'leasedWorkers', 'outboundCallSites',
      'packages', 'prismaSections', 'realtimeEndpoints', 'renderServices', 'routers', 'srcDomains', 'workerFiles', 'workflows']);
    expect(a.components.routers).toBe(manifest.apiSurface.mounts.length);
    expect(a.components.srcDomains).toBeGreaterThan(50);
  });

  it('every discovered component is declared, nothing declared is gone, and every row is honest', () => {
    expect(a.unmapped).toEqual([]);
    expect(a.stale).toEqual([]);
    expect(a.badRow).toEqual([]);
    expect(a.rowProblems).toEqual([]);
  });

  it('carries all 38 audit rows, each with an owner, a data class and a boundary type', () => {
    expect(Object.keys(map.boundaries).map(Number).sort((x, y) => x - y)).toEqual(Array.from({ length: 38 }, (_, i) => i + 1));
    for (const [id, row] of Object.entries(map.boundaries) as Array<[string, any]>) {
      for (const f of ['name', 'flow', 'trustBoundary', 'owner', 'dataClass', 'boundaryType']) expect(`${id}.${f}: ${!!row[f]}`).toBe(`${id}.${f}: true`);
    }
  });

  it('the coverage counts match the ratchet exactly (tighten it when a row closes)', () => {
    expect(a.coverage).toEqual({ C: 32, P: 6, U: 0 });
    expect(map.ratchet).toEqual({ U: a.coverage.U, P: a.coverage.P });
  });

  it('rows closed by Batch 6 (R9, R10, R12, R13) are covered, and say by which control', () => {
    const covered = (id: number, ctl: string) => {
      expect(map.boundaries[id].coverage).toBe('C');
      expect(map.boundaries[id].controls).toContain(ctl);
    };
    covered(19, 'redis-private-only');
    covered(20, 'storage-key-club-prefixed');
    covered(21, 'worker-channel-authenticated');
    covered(26, 'email-transport-tls');
    covered(28, 'secret-rotation-runbook');
    covered(32, 'media-dr-defined');
    covered(34, 'log-redaction');
    covered(35, 'db-audit-append-only');
    // PostgreSQL stays partial until RLS is enforced, but carries R9.
    expect(map.boundaries[18].coverage).toBe('P');
    expect(map.boundaries[18].controls).toContain('db-audit-append-only');
  });

  it('Batch 7 (R14) puts RLS on rows 5 and 18; Stage 4 enforces it, and the rows stay partial for the gaps RLS does not close', () => {
    for (const id of [5, 18]) {
      expect(map.boundaries[id].controls).toContain('db-rls-pilot');
      expect(map.boundaries[id].coverage).toBe('P');
      expect(map.boundaries[id].plannedIn).toMatch(/^Owner decision after Batch 7/);
    }
    expect(manifest.controls.find((c: { id: string }) => c.id === 'db-row-level-security')?.status).toBe('PRESENT');
    expect(map.boundaries[5].reason).toMatch(/ids in request bodies are not inventoried/);
    expect(map.boundaries[18].reason).toMatch(/the tables' owner, has full rights/);
    expect(manifest.controls.find((c: { id: string }) => c.id === 'db-rls-pilot')?.status).toBe('PRESENT');
  });

  it('rows closed by R1a–R2 and Batches 1, 4 and 5 are covered, and say by which control', () => {
    const covered = (id: number, ctl: string) => {
      expect(map.boundaries[id].coverage).toBe('C');
      expect(map.boundaries[id].controls).toContain(ctl);
    };
    covered(27, 'outbound-url-guard');
    covered(30, 'deploy-gated-by-ci');
    covered(36, 'security-alert-delivery');
    covered(6, 'authz-declared-per-handler');
    covered(7, 'owner-rooms-pinned');
    covered(33, 'worker-callback-authenticated');
    // Batch 4 (R7): JWT verification
    for (const ctl of ['jwt-algorithm-pinned', 'jwt-issuer-validated', 'jwt-key-id']) covered(3, ctl);
    // Batch 5 (R3 + R8): the AI layer
    for (const id of [9, 10]) for (const ctl of ['ai-single-egress', 'ai-egress-classification', 'ai-call-audited']) covered(id, ctl);
    covered(11, 'ai-actions-gated');
    covered(12, 'model-artifact-signed');
    covered(13, 'federated-default-deny');
    covered(13, 'federated-server-side-norm');
    covered(14, 'training-data-classified');
    covered(15, 'recommendation-signed');
  });

  it('both controls are present and required', () => {
    for (const id of ['architecture-fully-mapped', 'coverage-ratchet']) {
      expect(manifest.controls.find((c: { id: string }) => c.id === id)?.status).toBe('PRESENT');
      expect(policy.requiredControls).toContain(id);
    }
  });
});

describe('the infrastructure manifest shows the layers it used to miss', () => {
  it('has the intelligence and device components, each with evidence that exists', () => {
    const byId = Object.fromEntries(infra.components.map((c: { id: string }) => [c.id, c]));
    for (const id of ['ai-agents', 'model-registry', 'ml-features', 'federated-learning', 'knowledge-graph', 'video-intelligence']) {
      expect(byId[id]?.district).toBe('ai');
    }
    for (const id of ['device-fleet', 'camera-ingest', 'edge-nodes']) expect(byId[id]?.district).toBe('devices');
    for (const c of infra.components) {
      if (c.repositoryPath) expect(`${c.id}: ${fs.existsSync(path.join(root, c.repositoryPath))}`).toBe(`${c.id}: true`);
    }
    expect(infra.districts.map((d: { id: string }) => d.id)).toContain('devices');
  });

  it('its future zones are true today: nothing listed as missing that exists', () => {
    const ids = infra.future.map((f: { id: string }) => f.id);
    expect(ids).not.toContain('future-scouting');   // the Scouting module ships
    expect(ids).not.toContain('future-vuln-scan');  // npm audit blocks CI
    expect(ids).toEqual(expect.arrayContaining(['future-row-level-security', 'future-smart-ball']));
  });
});

describe('coverage per component (Infrastructure City)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { componentCoverage, resetComponentCoverage } = require('../src/infra/component-coverage');
  beforeEach(() => resetComponentCoverage());

  it('every component in the city has a coverage state', () => {
    const cov = componentCoverage();
    for (const c of infra.components) expect(`${c.id}: ${cov[c.id]?.state ?? 'none'}`).toMatch(/: [CPU]$/);
  });

  it('a component is as covered as its weakest trust boundary', () => {
    const cov = componentCoverage();
    expect(cov.stripe).toEqual({ state: 'C', rows: [{ id: 25, coverage: 'C' }] });
    expect(cov.anthropic.state).toBe('C'); // row 10, closed by R3 (Batch 5)
    expect(cov['platform-core']).toEqual({ state: 'P', rows: [{ id: 4, coverage: 'C' }, { id: 5, coverage: 'P' }, { id: 6, coverage: 'C' }] });
    expect(cov['object-store'].state).toBe('C'); // rows 20 and 32, closed by R10 (Batch 6)
  });

  it('the city shows it in the component inspector, translated', () => {
    const js = fs.readFileSync(path.join(root, 'public/infrastructure-city/infrastructure-city.js'), 'utf8');
    expect(js).toContain("esc(T('Cyber Defense coverage'))");
    expect(js).toMatch(/coverageHtml\(c\)/);
    for (const lang of ['en', 'de', 'ar']) {
      const dict = read(`public/infrastructure-city/i18n/${lang}.json`);
      for (const k of ['Cyber Defense coverage', 'Covered', 'Partially covered', 'Not covered', 'Trust boundaries',
        'Devices & Edge', 'AI Agents', 'Camera Ingest']) expect(`${lang}: ${k} ${!!dict[k]}`).toBe(`${lang}: ${k} true`);
    }
  });

  it('the build ships the map beside the compiled server', () => {
    expect(fs.readFileSync(path.join(root, 'scripts/copy-runtime-assets.js'), 'utf8')).toContain("'dist/cyber-defense/coverage-map.json'");
  });
});
