/**
 * Cyber Defense · Step 9 — CI and supply-chain hardening
 *
 * Pins what the workflows, Dependabot, CODEOWNERS and the secret-scan baseline
 * must keep saying, and proves the checks catch what they exist for: a
 * movable action tag, a write-scoped token, an audit that cannot fail, a scan
 * that runs an unverified binary, and an expression expanded into a shell
 * script. The deploy step's script is executed with a stand-in `curl` to show
 * a hostile dispatch input stays data.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const checks = require('../scripts/lib/workflow-checks') as {
  expressionInScript(src: string): boolean;
  leastPrivilege(src: string): boolean;
  actionRefs(src: string): Array<{ ref: string; pinned: boolean }>;
};

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CI = read('.github/workflows/ci.yml');
const DEPLOY = read('.github/workflows/deploy.yml');
const BACKUP = read('.github/workflows/backup.yml');
const RESTORE = read('.github/workflows/restore-drill.yml');
const WORKFLOWS = fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f));

describe('every workflow', () => {
  it('is one of the four reviewed workflows (a new one needs these checks too)', () => {
    expect(WORKFLOWS.sort()).toEqual(['backup.yml', 'ci.yml', 'deploy.yml', 'restore-drill.yml']);
  });

  it.each([['ci.yml', CI], ['deploy.yml', DEPLOY], ['backup.yml', BACKUP], ['restore-drill.yml', RESTORE]])('%s runs with a read-only token', (_f, src) => {
    expect(checks.leastPrivilege(src)).toBe(true);
    expect(src).not.toMatch(/permissions:\s*write-all|:\s*write\b/);
  });

  it.each([['ci.yml', CI], ['deploy.yml', DEPLOY], ['backup.yml', BACKUP], ['restore-drill.yml', RESTORE]])('%s pins every action to a full commit SHA with its release named', (_f, src) => {
    for (const line of src.split('\n').filter((l) => /uses:/.test(l))) {
      expect(line).toMatch(/uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+\s*$/);
    }
    expect(checks.actionRefs(src).every((r) => r.pinned)).toBe(true);
  });

  it.each([['ci.yml', CI], ['deploy.yml', DEPLOY], ['backup.yml', BACKUP], ['restore-drill.yml', RESTORE]])('%s expands no expression inside a shell script', (_f, src) => {
    expect(checks.expressionInScript(src)).toBe(false);
  });

  it.each([['ci.yml', CI], ['backup.yml', BACKUP], ['restore-drill.yml', RESTORE]])('%s: no checkout leaves the token behind in the working copy', (_f, src) => {
    const checkouts = src.split('uses: actions/checkout@').slice(1);
    expect(checkouts.length).toBeGreaterThan(0);
    for (const c of checkouts) expect(c.slice(0, 200)).toMatch(/persist-credentials:\s*false/);
  });

  it.each([['ci.yml', CI], ['backup.yml', BACKUP], ['restore-drill.yml', RESTORE]])('nothing in %s is allowed to fail quietly', (_f, src) => {
    const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/continue-on-error:\s*true/);
    expect(code).not.toMatch(/\|\|\s*true/);
  });
});

describe('the checks catch what they exist for', () => {
  const bad = {
    inline: 'steps:\n  - run: echo ${{ github.event.inputs.reason }}\n',
    block: 'steps:\n  - name: x\n    run: |\n      echo start\n      curl -d "${{ github.event.pull_request.title }}"\n',
    // The deploy step as it was before Step 9.
    before: [
      '      - name: Trigger Render deploy hook',
      '        env:',
      '          RENDER_DEPLOY_HOOK_URL: ${{ secrets.RENDER_DEPLOY_HOOK_URL }}',
      '        run: |',
      '          echo "Triggering Render deploy (reason: ${{ github.event.inputs.reason || \'ci-success\' }})"',
    ].join('\n'),
  };
  it.each(Object.entries(bad))('flags an expression in a script (%s)', (_k, src) => {
    expect(checks.expressionInScript(src)).toBe(true);
  });

  it('does not flag expressions in values, conditions or comments', () => {
    const ok = [
      'jobs:', '  a:', '    if: ${{ github.event_name == \'push\' }}', '    steps:',
      '      - name: y', '        env:', '          X: ${{ secrets.X }}',
      '        run: |', '          # a comment may mention ${{ github.sha }}', '          echo "$X"',
      '      - name: z', '        with:', '          ref: ${{ github.sha }}',
    ].join('\n');
    expect(checks.expressionInScript(ok)).toBe(false);
  });

  it('flags a movable tag and a write-scoped token', () => {
    expect(checks.actionRefs('uses: actions/checkout@v4').every((r) => r.pinned)).toBe(false);
    expect(checks.actionRefs('uses: actions/checkout@main').every((r) => r.pinned)).toBe(false);
    expect(checks.leastPrivilege('permissions:\n  contents: write\n')).toBe(false);
    expect(checks.leastPrivilege('on: push\njobs: {}\n')).toBe(false);
    expect(checks.leastPrivilege('permissions:\n  contents: read\njobs:\n  a:\n    permissions:\n      pull-requests: write\n')).toBe(false);
  });
});

describe('the dependency audit', () => {
  it('blocks on high and critical advisories', () => {
    expect(CI).toMatch(/run:\s*npm audit --audit-level=high\s*$/m);
  });
});

describe('the secret scan', () => {
  const job = CI.slice(CI.indexOf('secret-scan:'));

  it('scans the whole history, redacted, and fails on a finding', () => {
    expect(job).toMatch(/fetch-depth:\s*0/);
    expect(job).toMatch(/gitleaks" git \. --redact --no-banner --exit-code 1/);
  });

  it('runs only a pinned release whose checksum was verified first', () => {
    expect(job).toMatch(/GITLEAKS_VERSION:\s*\d+\.\d+\.\d+\s*$/m);
    expect(job).toMatch(/GITLEAKS_SHA256:\s*[0-9a-f]{64}\s*$/m);
    const verify = job.indexOf('sha256sum --check --strict');
    const extract = job.indexOf('tar -xzf');
    const run = job.indexOf('gitleaks" git');
    expect(verify).toBeGreaterThan(0);
    expect(verify).toBeLessThan(extract);
    expect(extract).toBeLessThan(run);
    expect(job).toMatch(/https:\/\/github\.com\/gitleaks\/gitleaks\/releases\/download\/v\$\{GITLEAKS_VERSION\}\//);
    expect(job).toMatch(/set -euo pipefail/);
  });

  it('the baseline holds reviewed fixture fingerprints only — no values, no new files', () => {
    const entries = read('.gitleaksignore').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    const reviewed = new Set([
      'README.md',
      'tests/fabric-gap-closure.unit.test.ts',
      'tests/fabric-system-producer.unit.test.ts',
      'tests/owner-trace-panel.unit.test.ts',
      'tests/secrets-by-reference.unit.test.ts',
    ]);
    expect(entries).toHaveLength(10);
    for (const e of entries) {
      const m = /^([0-9a-f]{40}):([^:]+):([a-z0-9-]+):(\d+)$/.exec(e);
      expect(m).not.toBeNull();
      expect(reviewed.has(m![2])).toBe(true);
    }
  });
});

describe('the deploy step keeps a dispatch input as data', () => {
  const script = (() => {
    const lines = DEPLOY.split('\n');
    const step = lines.findIndex((l) => /name: Trigger Render deploy hook\s*$/.test(l));
    const start = lines.findIndex((l, i) => i > step && /^\s+run: \|\s*$/.test(l));
    const indent = lines[start + 1].search(/\S/);
    const body: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (l.trim() && l.search(/\S/) < indent) break;
      body.push(l.slice(indent));
    }
    return body.join('\n');
  })();

  function runDeploy(env: Record<string, string>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-step-'));
    const argsFile = path.join(dir, 'curl-args');
    fs.writeFileSync(path.join(dir, 'curl'), `#!/bin/bash\nprintf '%s\\n' "$@" > "${argsFile}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'step.sh'), script);
    let out = '';
    let status = 0;
    try {
      out = execFileSync('bash', [path.join(dir, 'step.sh')], {
        cwd: dir,
        env: { PATH: `${dir}:${process.env.PATH}`, ...env },
        encoding: 'utf8',
      });
    } catch (err) {
      const e = err as { status: number; stdout: string };
      status = e.status; out = String(e.stdout ?? '');
    }
    const args = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').split('\n') : null;
    const created = fs.readdirSync(dir).filter((f) => !['curl', 'curl-args', 'step.sh'].includes(f));
    fs.rmSync(dir, { recursive: true, force: true });
    return { out, args, created, status };
  }

  it('without a hook it calls nothing and FAILS — auto-deploy is off, so a skip is a missed deploy (R4)', () => {
    const r = runDeploy({ RENDER_DEPLOY_HOOK_URL: '', DEPLOY_REASON: 'x', DEPLOY_REF: 'a'.repeat(40) });
    expect(r.args).toBeNull();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error::RENDER_DEPLOY_HOOK_URL is not set; nothing was deployed/);
  });

  it('a hostile reason cannot run a command or break the JSON body', () => {
    const hostile = '"; touch pwned1; echo "$(touch pwned2)`touch pwned3`\\\n{"x":1}';
    const r = runDeploy({ RENDER_DEPLOY_HOOK_URL: 'https://hook.invalid/deploy', DEPLOY_REASON: hostile, DEPLOY_REF: `${'b'.repeat(40)};id` });
    expect(r.created).toEqual([]);
    const body = r.args![r.args!.indexOf('-d') + 1];
    const parsed = JSON.parse(body);
    expect(parsed.reason).toMatch(/^[A-Za-z0-9._ -]{1,80}$/);
    expect(parsed.ref).toBe('b'.repeat(40));
    expect(r.args).toContain('https://hook.invalid/deploy');
  });

  it('an empty reason becomes ci-success', () => {
    const r = runDeploy({ RENDER_DEPLOY_HOOK_URL: 'https://hook.invalid/deploy', DEPLOY_REASON: '', DEPLOY_REF: 'c'.repeat(40) });
    expect(JSON.parse(r.args![r.args!.indexOf('-d') + 1])).toEqual({ reason: 'ci-success', ref: 'c'.repeat(40) });
  });
});

describe('Dependabot', () => {
  const cfg = read('.github/dependabot.yml');
  it('proposes npm and GitHub Actions updates, weekly, as pull requests', () => {
    expect(cfg).toMatch(/^version:\s*2\s*$/m);
    for (const eco of ['npm', 'github-actions']) {
      const block = cfg.slice(cfg.indexOf(`package-ecosystem: ${eco}`));
      expect(block).toMatch(/interval:\s*weekly/);
      const limit = Number(/open-pull-requests-limit:\s*(\d+)/.exec(block)![1]);
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(5);
    }
  });
  it('never merges anything by itself', () => {
    expect(cfg).not.toMatch(/auto-?merge/i);
    expect(read('.github/workflows/ci.yml')).not.toMatch(/dependabot\/fetch-metadata|gh pr merge/);
  });
});

describe('CODEOWNERS', () => {
  const owners = read('.github/CODEOWNERS');
  const rules = owners.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split(/\s+/));
  it('has a default owner and names the security-critical paths', () => {
    expect(rules[0]).toEqual(['*', '@bibokh']);
    for (const p of ['/src/auth-prod/', '/src/services/auth.service.ts', '/src/security/', '/src/cyber-defense/',
      '/src/fabric/secrets/', '/prisma/', '/.github/', '/package-lock.json', '/.gitleaksignore']) {
      expect(rules.map((r) => r[0])).toContain(p);
    }
  });
  it('every path it names exists (a renamed path silently loses its owner)', () => {
    for (const [p] of rules.filter((r) => r[0] !== '*')) {
      expect(`${p}: ${fs.existsSync(path.join(ROOT, p))}`).toBe(`${p}: true`);
    }
  });
});
