/**
 * tests/system-command-center.unit.test.ts
 *
 * The command centre: real or explicitly absent, and no dead controls.
 *
 * The screen is the platform owner's only view of the platform, so the two
 * properties that matter are that it never invents a number and never offers a
 * button that does nothing. Both are checked against the code that would have
 * to change to break them.
 */

import fs from 'fs';
import path from 'path';
import { CAPABILITIES, capabilitySummary, capabilitiesFor, capability } from '../src/platform/capabilities';
import { SYSTEM_MODULES, CLUB_MODULES } from '../src/platform/system-modules';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SYS_JS = read('public/system/system.js');
const SYS_CSS = read('public/system/system.css');
const APP = read('public/app.js');
const INDEX = read('public/index.html');
const ROUTES = read('src/routes/system.routes.ts');
const CTRL = read('src/controllers/system.controller.ts');
const SERVICE = read('src/platform/system.service.ts');

describe('every control tells the truth about itself', () => {
  it('declares a status, a risk and a reason', () => {
    for (const c of CAPABILITIES) {
      expect(['LIVE', 'PARTIAL', 'NOT_AVAILABLE']).toContain(c.status);
      expect(['SAFE', 'SENSITIVE', 'CRITICAL', 'PROTECTED']).toContain(c.risk);
      expect(`${c.key}:${c.note.length > 20}`).toBe(`${c.key}:true`);
    }
    const summary = capabilitySummary();
    expect(summary.LIVE + summary.PARTIAL + summary.NOT_AVAILABLE).toBe(CAPABILITIES.length);
    expect(summary.LIVE).toBeGreaterThan(0);
  });

  it('a LIVE control names the endpoint that performs it', () => {
    for (const c of CAPABILITIES.filter((x) => x.status === 'LIVE')) {
      // Either it is served by an endpoint, or it is a rule that runs on its
      // own — and those say so in the note rather than pretending to a route.
      const served = !!c.endpoint || /automatically|refused|invisible/i.test(c.note);
      expect(`${c.key}:${served}`).toBe(`${c.key}:true`);
    }
  });

  it('and a NOT_AVAILABLE control has no endpoint at all', () => {
    for (const c of CAPABILITIES.filter((x) => x.status === 'NOT_AVAILABLE')) {
      expect(`${c.key}:${c.endpoint ?? 'none'}`).toBe(`${c.key}:none`);
    }
    // The destructive ones that do not exist are PROTECTED, not merely absent.
    expect(capability('club.suspend')).toMatchObject({ status: 'NOT_AVAILABLE', risk: 'PROTECTED' });
    expect(capability('backup.verify')).toMatchObject({ status: 'NOT_AVAILABLE', risk: 'PROTECTED' });
  });

  it('every module the interface offers has controls or a stated readiness', () => {
    for (const m of SYSTEM_MODULES) {
      const has = capabilitiesFor(m.key).length > 0;
      expect(`${m.key}:${has || m.readiness === 'NOT_INSTRUMENTED' || !!m.backing}`).toBe(`${m.key}:true`);
    }
  });
});

describe('the endpoints behind the controls exist', () => {
  it('every endpoint a capability names is routed', () => {
    const endpoints = CAPABILITIES.map((c) => c.endpoint).filter(Boolean) as string[];
    for (const ep of endpoints) {
      const [method, url] = ep.split(' ');
      if (!url.startsWith('/system')) continue;      // invitations/memberships are their own routers
      const segment = url.replace('/system', '').replace(/:\w+/g, ':');
      const verb = method.toLowerCase();
      const found = ROUTES.includes(`router.${verb}('${segment}`)
        || ROUTES.includes(`router.${verb}('${segment.replace(/:$/, '')}`)
        || new RegExp(`router\\.${verb}\\('${segment.split(':')[0]}`).test(ROUTES);
      expect(`${ep}:${found}`).toBe(`${ep}:true`);
    }
  });

  it('every control endpoint asserts platform authority before it acts', () => {
    const controls = ['killSwitch', 'setFlag', 'createExperiment', 'decideExperimentState'];
    for (const fn of controls) {
      const at = CTRL.indexOf(`export async function ${fn}`);
      expect(`${fn}:${at >= 0}`).toBe(`${fn}:true`);
      const body = CTRL.slice(at, CTRL.indexOf('\n}', at));
      expect(`${fn}:${body.includes('assertPlatformOwner')}`).toBe(`${fn}:true`);
      // And records what it did.
      expect(`${fn}:${body.includes('publish(')}`).toBe(`${fn}:true`);
    }
  });

  it('and the reads refuse anyone who does not own the platform', () => {
    // Every exported surface in the service goes through the same gate.
    for (const fn of ['platformOverview', 'listClubs', 'listPeople', 'platformSignals',
                      'controlSurface', 'intelligenceSurface', 'innovationSurface',
                      'securitySurface', 'auditSurface']) {
      const at = SERVICE.indexOf(`export async function ${fn}`);
      const body = SERVICE.slice(at, at + 400);
      expect(`${fn}:${body.includes('assertPlatformOwner')}`).toBe(`${fn}:true`);
    }
  });

  it('and no credential is ever selected by a SYSTEM read', () => {
    for (const forbidden of ['passwordHash', 'tokenHash: true', 'refreshToken', 'token: true']) {
      expect(`${forbidden}:${SERVICE.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

describe('the interface never invents a number', () => {
  it('renders an absent metric as an em dash with its reason', () => {
    expect(SYS_JS).toContain("return { text: '—', none: true");
    expect(SYS_JS).toContain('Not instrumented yet.');
    // A metric object is { value, unavailable } and null is not zero.
    expect(SYS_JS).toContain('if (!m || m.value == null)');
    expect(SERVICE).toContain('const notInstrumented = (why: string): Metric => ({ value: null, unavailable: why });');
  });

  it('and the modules that cannot be measured say which phase would fix them', () => {
    const sessions = SYSTEM_MODULES.find((m) => m.key === 'platform-analytics')!;
    expect(sessions.readiness).toBe('NOT_INSTRUMENTED');
    expect(SERVICE).toMatch(/No session analytics are collected yet/);
    expect(SERVICE).toMatch(/No feature-usage events are collected yet/);
  });

  it('signals are derived from rows, and an empty platform says so', () => {
    const at = SERVICE.indexOf('export async function platformSignals');
    const body = SERVICE.slice(at, SERVICE.indexOf('export interface ControlSurface'));
    // Each signal is conditional on a real count.
    expect(body).toContain('if (ownerless > 0)');
    expect(body).toContain('if (expiring > 0)');
    expect(body).toContain('killSwitchEngaged()');
    expect(SYS_JS).toContain('Nothing needs attention');
  });
});

describe('SYSTEM is its own product, and is the way in', () => {
  it('is the page the owner\'s SYSTEM card opens', () => {
    expect(APP).toContain('data-action="navTo" data-page="system"');
    expect(APP).toContain("'system': 1,");
    expect(APP).toContain('function renderSystemHTML()');
    // The legacy FOS pages remain reachable — nothing working was removed.
    expect(APP).toContain("'fos-core': 1,");
    expect(APP).toContain('function renderFOSCoreHTML()');
  });

  it('loads its own stylesheet and module, not the club\'s', () => {
    expect(INDEX).toContain('/system/system.css');
    expect(INDEX).toContain('/system/system.js');
    // Every SYSTEM class is namespaced, so nothing here can style a club screen.
    const classes = SYS_CSS.match(/\.[a-z][\w-]*/g) || [];
    const foreign = [...new Set(classes)].filter((c) => !c.startsWith('.sy-') && !c.startsWith('.is-'));
    expect(foreign).toEqual([]);
  });

  it('and the club modules are nowhere in it', () => {
    for (const club of CLUB_MODULES) {
      // The SYSTEM module never renders a club surface.
      expect(`${club}:${SYS_JS.includes(`'${club}'`)}`).toBe(`${club}:false`);
    }
  });

  it('a critical action asks before it happens', () => {
    expect(SYS_JS).toContain('function confirmCritical');
    // Stopping the platform's agents asks for a reason, and the reason is kept.
    expect(SYS_JS).toContain('Why are autonomous AI actions being stopped?');
    expect(SYS_JS).toMatch(/if \(!reason\.trim\(\)\) return;/);
    expect(CTRL).toContain('Say why: the reason is shown to anyone who finds an agent refused.');
  });

  it('and the interface reads authority from the server rather than deciding it', () => {
    expect(SYS_JS).toContain("api('/system/whoami')");
    // No client-side role test decides what SYSTEM shows.
    expect(SYS_JS).not.toMatch(/role\s*===\s*'SUPER_ADMIN'/);
  });
});
