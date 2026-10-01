/**
 * tests/deploy-gate.unit.test.ts
 *
 * Cyber Defense, R4 — production moves only after CI.
 *
 * Before: render.yaml set `autoDeploy: true`, so Render deployed every push to
 * main the moment it landed, whether CI then passed or failed. The deploy
 * workflow that waited for CI was a no-op: its hook was unset, and it said
 * "skipping" and went green.
 *
 * After: auto-deploy is off for every service; the only automatic deploy is the
 * workflow, after a successful `ci` run on main, for the commit that is still
 * main's head; without its hook it fails instead of passing. The posture
 * control `deploy-gated-by-ci` pins all of it.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const RENDER = read('render.yaml');
const DEPLOY = read('.github/workflows/deploy.yml');

/** The body of the `run: |` block of the step with this name. */
function stepScript(name: string): string {
  const lines = DEPLOY.split('\n');
  const step = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  const start = lines.findIndex((l, i) => i > step && /^\s+run: \|\s*$/.test(l));
  const indent = lines[start + 1].search(/\S/);
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() && l.search(/\S/) < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

describe('render.yaml', () => {
  it('turns auto-deploy off for every service Render builds from the repository', () => {
    const services = RENDER.match(/^\s*-\s*type:\s*(?:web|worker|pserv|cron)\s*$/gm) ?? [];
    expect(services.length).toBeGreaterThan(0);
    expect(RENDER.match(/^\s+autoDeploy:\s*false\s*$/gm) ?? []).toHaveLength(services.length);
    expect(RENDER).not.toMatch(/autoDeploy:\s*true/);
  });
});

describe('deploy.yml', () => {
  const on = DEPLOY.slice(DEPLOY.indexOf('\non:'), DEPLOY.indexOf('\npermissions:'));

  it('runs only after ci completes on main, or by hand', () => {
    expect(on).toMatch(/workflow_run:\s*\n\s+workflows:\s*\['ci'\]\s*\n\s+types:\s*\[completed\]\s*\n\s+branches:\s*\[main\]/);
    expect(on).toMatch(/^\s+workflow_dispatch:/m);
    expect(on).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule):/m);
  });

  it('deploys only when that ci run succeeded on main', () => {
    expect(DEPLOY).toContain("github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'main'");
    expect(DEPLOY).toContain("if: steps.head.outputs.current == 'true'");
  });

  describe('the head check', () => {
    function runHead(env: Record<string, string>, mainHead: string) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-head-'));
      const out = path.join(dir, 'out');
      fs.writeFileSync(out, '');
      fs.writeFileSync(path.join(dir, 'curl'), `#!/bin/bash\nprintf '%s' '${mainHead}'\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 'step.sh'), stepScript("Check the tested commit is still main's head"));
      execFileSync('bash', [path.join(dir, 'step.sh')], {
        cwd: dir, encoding: 'utf8',
        env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: out, GH_TOKEN: 't', REPO: 'o/r', ...env },
      });
      const result = fs.readFileSync(out, 'utf8').trim();
      fs.rmSync(dir, { recursive: true, force: true });
      return result;
    }
    const A = 'a'.repeat(40);
    const B = 'b'.repeat(40);

    it('deploys the commit ci just passed when it is still main\'s head', () => {
      expect(runHead({ EVENT: 'workflow_run', TESTED_SHA: A }, A)).toBe('current=true');
    });
    it('stands down when main has moved on — that newer commit has not passed ci yet', () => {
      expect(runHead({ EVENT: 'workflow_run', TESTED_SHA: A }, B)).toBe('current=false');
    });
    it('stands down when the head cannot be read', () => {
      expect(runHead({ EVENT: 'workflow_run', TESTED_SHA: A }, '')).toBe('current=false');
    });
    it('a manual run is a deliberate decision and proceeds', () => {
      expect(runHead({ EVENT: 'workflow_dispatch', TESTED_SHA: '' }, B)).toBe('current=true');
    });
  });
});

describe('posture', () => {
  const manifest = JSON.parse(read('src/cyber-defense/generated/security-manifest.json'));
  const policy = JSON.parse(read('src/cyber-defense/posture-policy.json'));
  it('deploy-gated-by-ci is present and required', () => {
    expect(manifest.controls.find((c: { id: string }) => c.id === 'deploy-gated-by-ci')?.status).toBe('PRESENT');
    expect(policy.requiredControls).toContain('deploy-gated-by-ci');
  });
});
