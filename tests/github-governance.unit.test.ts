/**
 * tests/github-governance.unit.test.ts
 *
 * Development authority and approval authority, kept apart in what the
 * repository itself holds (docs/security/github-governance.md):
 *
 *   1. the proposed ruleset is exactly the configuration the publication gate
 *      calls enforced, and today's is not;
 *   2. the gate's required checks are ci.yml's jobs, so neither drifts alone;
 *   3. every sensitive path is code-owned by the Platform Owner alone, and no
 *      automation account is ever a code owner;
 *   4. no workflow can approve, push or write; every secret is read by a job
 *      that names an environment, which only main may use; and only the
 *      Platform Owner deploys by hand.
 *
 * What a repository cannot hold — the ruleset itself, the environments, who is
 * a collaborator — is the Platform Owner's to configure and verify, and the
 * document lists how.
 */

import fs from 'fs';
import path from 'path';
import { codeOwnersOf, enforcementOf, PUBLISHED_PATH, REQUIRED_CHECKS } from '../lab/orchestrator/publication-gate';

const ROOT = path.resolve(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CODEOWNERS = read('.github/CODEOWNERS');
const PROPOSED = JSON.parse(read('docs/security/ruleset-25019943.proposed.json')) as { bypass_actors: unknown[]; conditions: unknown; enforcement: string; rules: Array<{ type: string; parameters?: Record<string, unknown> }> };
const OBSERVED = JSON.parse(read('tests/fixtures/agents/github-rules-main.json')) as Array<{ type: string; parameters?: Record<string, unknown> }>;
const WORKFLOWS = fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml')).sort();
const wf = (f: string) => read(`.github/workflows/${f}`);

describe('1. the ruleset the gate calls enforced', () => {
  it('the proposed ruleset meets every requirement, with no bypass actor, active on main only', () => {
    const r = enforcementOf(PROPOSED.rules, CODEOWNERS, 'familista-automation');
    expect(r.findings.filter((f) => f.state === 'NOT_MET')).toEqual([]);
    expect(r.findings.filter((f) => f.state === 'UNVERIFIED').map((f) => f.requirement)).toEqual(['no actor may bypass the ruleset']);
    expect(r.ok).toBe(true);
    expect(PROPOSED.bypass_actors).toEqual([]);
    expect(PROPOSED.enforcement).toBe('active');
    expect(PROPOSED.conditions).toEqual({ ref_name: { include: ['refs/heads/main'], exclude: [] } });
  });

  it('it changes only what governance needs: the observed ruleset with review enforcement and up-to-date branches turned on', () => {
    const byType = (rules: Array<{ type: string; parameters?: Record<string, unknown> }>) => Object.fromEntries(rules.map((x) => [x.type, x.parameters ?? {}]));
    const was = byType(OBSERVED);
    const now = byType(PROPOSED.rules);
    expect(Object.keys(now).sort()).toEqual(Object.keys(was).sort());
    const changed = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
    expect(changed(was.pull_request, now.pull_request)).toEqual(['dismiss_stale_reviews_on_push', 'require_code_owner_review', 'require_last_push_approval', 'required_approving_review_count']);
    expect(changed(was.required_status_checks, now.required_status_checks)).toEqual(['strict_required_status_checks_policy']);
  });

  it('negative controls: today\'s ruleset is not enforced, and each requirement withdrawn alone is caught', () => {
    expect(enforcementOf(OBSERVED, CODEOWNERS, 'familista-automation').ok).toBe(false);
    const without = (type: string, key: string, value: unknown) => PROPOSED.rules.map((r) => (r.type === type ? { ...r, parameters: { ...r.parameters, [key]: value } } : r));
    for (const [type, key, value] of [
      ['pull_request', 'required_approving_review_count', 0], ['pull_request', 'require_code_owner_review', false],
      ['pull_request', 'require_last_push_approval', false], ['pull_request', 'dismiss_stale_reviews_on_push', false],
      ['required_status_checks', 'strict_required_status_checks_policy', false],
    ] as const) expect([key, enforcementOf(without(type, key, value), CODEOWNERS, 'familista-automation').ok]).toEqual([key, false]);
    const threeChecks = without('required_status_checks', 'required_status_checks', REQUIRED_CHECKS.slice(1).map((context) => ({ context, integration_id: 15368 })));
    expect(enforcementOf(threeChecks, CODEOWNERS, 'familista-automation').ok).toBe(false);
    const anySource = without('required_status_checks', 'required_status_checks', REQUIRED_CHECKS.map((context) => ({ context })));
    expect(enforcementOf(anySource, CODEOWNERS, 'familista-automation').ok).toBe(false);
    expect(enforcementOf(PROPOSED.rules.filter((r) => r.type !== 'non_fast_forward'), CODEOWNERS, 'familista-automation').ok).toBe(false);
    // The Platform Owner authoring a publication: the only code owner is the author, and an author never approves their own.
    expect(enforcementOf(PROPOSED.rules, CODEOWNERS, 'bibokh').ok).toBe(false);
  });
});

describe('2. the required checks are ci.yml\'s jobs', () => {
  it('the gate requires exactly the jobs ci.yml runs, under the names the ruleset requires them by', () => {
    const ci = wf('ci.yml');
    const names = [
      ...[...ci.matchAll(/^ {4}name: (.+)$/gm)].map((m) => m[1]).filter((n) => !n.includes('${{')),
      ...[...ci.matchAll(/^ {10}- shard: (.+)$/gm)].map((m) => `browser proof (${m[1]})`),
    ];
    expect([...names].sort()).toEqual([...REQUIRED_CHECKS].sort());
    const proposed = PROPOSED.rules.find((r) => r.type === 'required_status_checks')?.parameters?.required_status_checks as Array<{ context: string; integration_id: number }>;
    expect(proposed.map((c) => c.context)).toEqual([...REQUIRED_CHECKS]);
    expect(new Set(proposed.map((c) => c.integration_id))).toEqual(new Set([15368]));
  });
});

describe('3. code owners', () => {
  const SENSITIVE = [
    '.github/workflows/ci.yml', '.github/workflows/deploy.yml', '.github/CODEOWNERS',
    'src/security/ai-read-policy.ts', 'src/middleware/auth.middleware.ts', 'src/auth-prod/x.ts',
    'src/platform/agents/execution-evidence.ts', 'src/platform/agents/execution-provenance.ts', `${PUBLISHED_PATH}/approvals.json`,
    'lab/orchestrator/publication-gate.ts', 'lab/orchestrator/definitions/matchday-staff-notice.json',
    'src/platform/agents/catalog.ts', 'src/platform/intelligence/agents.ts', 'src/platform/environment.ts',
    'render.yaml', 'scripts/render-start.sh', 'scripts/db-migrate.js', 'scripts/backup-trigger.js', 'prisma/schema.prisma',
    'package.json', 'package-lock.json', 'scripts/npm-audit-gate.js', 'tools/components/lab-browser-proof.cjs',
    'docs/security/github-governance.md', 'SECURITY.md', 'CLAUDE.md',
  ];

  it.each(SENSITIVE)('%s is owned by the Platform Owner, and by no one else', (f) => {
    expect(fs.existsSync(path.join(ROOT, f)) || f === 'src/auth-prod/x.ts').toBe(true);
    expect(codeOwnersOf(CODEOWNERS, f)).toEqual(['bibokh']);
  });

  it('no line names any owner but the Platform Owner: an automation account is never a code owner', () => {
    const owners = new Set(CODEOWNERS.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean).flatMap((l) => l.split(/\s+/).slice(1)));
    expect([...owners]).toEqual(['@bibokh']);
    expect(CODEOWNERS).toMatch(/^\*\s+@bibokh$/m);
  });
});

describe('4. workflows: write access is not production access', () => {
  it('no workflow, and no job in one, asks for a token that could approve, push or write', () => {
    for (const f of WORKFLOWS) {
      const src = wf(f);
      expect([f, src.match(/^permissions:\n {2}contents: read$/m) !== null]).toEqual([f, true]);
      expect([f, src.match(/:\s*write\b/g)]).toEqual([f, null]);
      expect([f, /pull_request_target/.test(src)]).toEqual([f, false]);
    }
  });

  it('every job that reads a secret names an environment, which only main may use; ci reads none', () => {
    const readers: Record<string, string[]> = {};
    for (const f of WORKFLOWS) {
      const src = wf(f);
      const jobs = src.slice(src.indexOf('\njobs:')).split(/\n(?= {2}[a-z][a-z0-9-]*:\n)/).slice(1);
      for (const job of jobs) {
        if (!/secrets\.[A-Z_]+/.test(job)) continue;
        const env = /^ {4}environment: ([a-z-]+)$/m.exec(job)?.[1] ?? null;
        readers[`${f}:${job.split(':')[0].trim()}`] = [env ?? 'NONE'];
      }
    }
    expect(readers).toEqual({ 'backup.yml:backup': ['backup'], 'deploy.yml:trigger-render': ['production'], 'restore-drill.yml:drill': ['restore-drill'] });
    expect(wf('ci.yml')).not.toMatch(/secrets\./);
  });

  it('by hand, only the Platform Owner moves production', () => {
    const deploy = wf('deploy.yml');
    expect(deploy).toContain("(github.event_name == 'workflow_dispatch' && github.triggering_actor == 'bibokh')");
    expect(deploy).not.toMatch(/github\.event_name == 'workflow_dispatch' \|\|/);
  });
});
