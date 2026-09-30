/**
 * Cyber Defense · Step 1 — the security posture is pinned
 *
 * `scripts/security-discover.js` reads the repository and writes what the
 * security surface IS: `src/cyber-defense/generated/security-manifest.json`.
 * `src/cyber-defense/posture-policy.json` records what has been REVIEWED. This
 * suite fails when they disagree, so a new unauthenticated route, a newly
 * mounted dormant module, a control that disappears or a supply-chain
 * regression cannot land without somebody deciding it should.
 *
 * Nothing here changes runtime behaviour; the manifest is read by tests only.
 */

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { spawnSync } from 'child_process';

const ROOT = path.join(__dirname, '..');
const GENERATOR = path.join(ROOT, 'scripts', 'security-discover.js');
const MANIFEST_PATH = path.join(ROOT, 'src', 'cyber-defense', 'generated', 'security-manifest.json');
const POLICY_PATH = path.join(ROOT, 'src', 'cyber-defense', 'posture-policy.json');

const generatorSrc = fs.readFileSync(GENERATOR, 'utf8');
const manifestRaw = fs.readFileSync(MANIFEST_PATH, 'utf8');
const manifest = JSON.parse(manifestRaw);
const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));

interface Route { route: string; file: string; line: number }
interface Control { id: string; status: 'PRESENT' | 'PARTIAL' | 'ABSENT'; evidence: string; note: string }

const control = (id: string): Control => {
  const c = (manifest.controls as Control[]).find((x) => x.id === id);
  if (!c) throw new Error(`control ${id} is not in the manifest`);
  return c;
};
const firstNumber = (s: string): number => Number((s.match(/\d+/) || ['NaN'])[0]);

describe('the security manifest is current and was produced safely', () => {
  it('matches what the generator reads from the repository today', () => {
    const run = spawnSync(process.execPath, [GENERATOR, '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('never reads the process environment — secrets are reported by name only', () => {
    expect(generatorSrc).not.toMatch(/process\.env/);
    // The capture group is the variable NAME; widening it to the value is the
    // edit that would break the guarantee.
    expect(generatorSrc).toContain('/^\\s*-\\s*key:\\s*([A-Z0-9_]+)\\s*$/');
  });

  it('refuses to write a secret-shaped value instead of redacting it', () => {
    const start = generatorSrc.indexOf('const SECRET_SHAPES');
    const end = generatorSrc.indexOf('// ── helpers');
    expect(start).toBeGreaterThan(-1);
    const sanitiser = generatorSrc.slice(start, end);
    expect(sanitiser).not.toMatch(/\breplace\s*\(/);

    const ctx: Record<string, unknown> = {};
    vm.createContext(ctx);
    vm.runInContext(`${sanitiser}\nthis.assertNoSecrets = assertNoSecrets;`, ctx);
    const assertNoSecrets = ctx.assertNoSecrets as (s: string) => void;

    // Synthetic shapes assembled at runtime so this file holds no literal.
    const samples = [
      ['postgres', '://u:p@h:5432/db'].join(''),
      ['sk_live_', 'A'.repeat(24)].join(''),
      ['whsec_', 'B'.repeat(24)].join(''),
      ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join(''),
      ['AKIA', 'C'.repeat(16)].join(''),
    ];
    for (const s of samples) expect(() => assertNoSecrets(`{"x":"${s}"}`)).toThrow(/Nothing was written/);
    expect(() => assertNoSecrets(manifestRaw)).not.toThrow();
  });

  it('holds variable names and supply modes, never values', () => {
    for (const v of manifest.secrets.envVars) {
      expect(Object.keys(v).sort()).toEqual(['name', 'secretNamed', 'supply']);
      expect(['dashboard', 'generated', 'linked', 'inline', 'unknown']).toContain(v.supply);
    }
  });
});

describe('every route reachable without a session has been reviewed', () => {
  it('the public API handlers are exactly the reviewed set', () => {
    const actual = (manifest.apiSurface.publicRoutes as Route[]).map((r) => r.route).sort();
    expect(actual).toEqual(Object.keys(policy.publicRoutes).sort());
  });

  it('the app-level routes are exactly the reviewed set', () => {
    const actual = (manifest.apiSurface.appLevelRoutes as Route[]).map((r) => r.route).sort();
    expect(actual).toEqual(Object.keys(policy.appLevelRoutes).sort());
  });

  it('every reviewed route says why it is public', () => {
    for (const reason of [...Object.values(policy.publicRoutes), ...Object.values(policy.appLevelRoutes)]) {
      expect(typeof reason).toBe('string');
      expect((reason as string).trim().length).toBeGreaterThan(20);
    }
  });
});

describe('every outbound HTTP call site has been reviewed (R1b)', () => {
  it('the files that open outbound requests are exactly the reviewed set', () => {
    expect([...manifest.apiSurface.outboundCallSites].sort()).toEqual(Object.keys(policy.outboundCallSites).sort());
  });

  it('every reviewed call site says whose URL it calls', () => {
    for (const reason of Object.values(policy.outboundCallSites) as string[]) {
      expect(reason).toMatch(/operator|guard|fixed/i);
    }
  });
});

describe('dormant route modules stay dormant', () => {
  it('the unmounted modules are exactly the reviewed set', () => {
    expect([...manifest.apiSurface.dormantRouteModules].sort()).toEqual(Object.keys(policy.dormantRouteModules).sort());
  });

  it('none of them is mounted', () => {
    const mounted = new Set((manifest.apiSurface.mounts as { module: string }[]).map((m) => m.module));
    for (const mod of Object.keys(policy.dormantRouteModules)) expect(mounted.has(mod)).toBe(false);
  });
});

describe('the controls the platform relies on are still there', () => {
  it.each(policy.requiredControls as string[])('%s is PRESENT', (id) => {
    expect(control(id).status).toBe('PRESENT');
  });

  it('every control is either required or a documented gap — nothing unaccounted for', () => {
    const accounted = new Set([...policy.requiredControls, ...Object.keys(policy.knownGaps)]);
    for (const c of manifest.controls as Control[]) expect(accounted.has(c.id)).toBe(true);
    for (const id of accounted) expect(() => control(id as string)).not.toThrow();
  });

  it('a known gap that has been closed is promoted, not left listed as a gap', () => {
    // When a later step fixes a gap, the manifest says PRESENT and this fails
    // until the control moves into requiredControls — so it can never regress.
    for (const id of Object.keys(policy.knownGaps)) expect(control(id).status).not.toBe('PRESENT');
  });
});

describe('ratchets — the posture may improve, never regress', () => {
  it('no secret-named variable is committed inline in render.yaml', () => {
    expect(manifest.secrets.secretNamedInline.length).toBeLessThanOrEqual(policy.ratchets.maxSecretNamedInline);
  });

  it('the private datastores stay off the public internet', () => {
    expect(manifest.datastores.length).toBeGreaterThan(0);
    for (const d of manifest.datastores) expect(d.privateNetworkOnly).toBe(true);
  });

  it('every lockfile package carries an integrity hash', () => {
    expect(manifest.supplyChain.lockfileIntegrity).toBe(manifest.supplyChain.lockfilePackages);
  });

  it('packages resolved from outside registry.npmjs.org do not grow', () => {
    const nonNpmjs = Object.entries(manifest.supplyChain.registries as Record<string, number>)
      .filter(([host]) => host !== 'registry.npmjs.org')
      .reduce((n, [, count]) => n + count, 0);
    expect(nonNpmjs).toBeLessThanOrEqual(policy.ratchets.maxNonNpmjsLockfilePackages);
  });

  it('the audit chain and security event log keep their call sites', () => {
    expect(firstNumber(control('audit-hash-chain').note)).toBeGreaterThanOrEqual(policy.ratchets.minAuditHashChainSites);
    expect(firstNumber(control('security-event-log').note)).toBeGreaterThanOrEqual(policy.ratchets.minSecurityEventSites);
  });
});
