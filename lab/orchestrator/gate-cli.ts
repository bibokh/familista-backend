// Familista — the publication gate, from the command line and in CI
// ─────────────────────────────────────────────────────────────────────────────
//   FAMILISTA_ENV=LAB npm run lab:publication-gate [-- --base <commit>]
//
// CI (.github/workflows/ci.yml, in the required validate check) passes the
// base: the pull request's base commit, or main before a push. It also passes
// the pull request's number and author. Locally the base defaults to
// origin/main. See publication-gate.ts for what is checked.
//
// The rules active on main are read from GitHub's public API
// (GET /repos/bibokh/familista-backend/rules/branches/main), with GITHUB_TOKEN
// when it is set. A commit the gate needs and the checkout lacks is fetched
// from origin, read-only.
//
// Exit codes: 0 passed, 2 failed (every failed check is printed), 1 could not run.

import '../../src/config/zod';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { currentEnvironment } from '../../src/platform/environment';
import { PROVENANCE_REPOSITORY } from '../../src/platform/agents/execution-provenance';
import { runPublicationGate, type GateGit, type GateReport } from './publication-gate';

const ROOT = path.join(__dirname, '..', '..');
const out = (s = '') => process.stdout.write(`${s}\n`);
const fail = (s: string, code = 1): never => { process.stderr.write(`${s}\n`); process.exit(code); };

if (currentEnvironment() !== 'LAB') fail(`refused ENVIRONMENT_NOT_LAB: the gate replays LAB executions, so it runs as the Lab (FAMILISTA_ENV=LAB); this process is ${currentEnvironment()}`, 2);

const args = process.argv.slice(2);
const flag = (name: string): string | null => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
const SHA = /^[0-9a-f]{40}$/;

function git(...a: string[]): string | null {
  try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); } catch { return null; }
}
const fetched = new Set<string>();
/** Fetch `rev` (and, once, the full history) from origin when the checkout does not have it: CI checks out one commit. */
function ensure(rev: string): boolean {
  if (git('cat-file', '-e', `${rev}^{commit}`) !== null) return true;
  if (!SHA.test(rev) || fetched.has(rev)) return false;
  fetched.add(rev);
  git('fetch', '--no-tags', '--quiet', 'origin', rev);
  return git('cat-file', '-e', `${rev}^{commit}`) !== null;
}
let unshallowed = false;
const realGit: GateGit = {
  show: (rev, file) => (ensure(rev) ? git('show', `${rev}:${file}`) : null),
  isCommit: (rev) => SHA.test(rev) && ensure(rev),
  isAncestor: (rev, of) => {
    if (!ensure(rev) || !ensure(of)) return false;
    if (!unshallowed && git('rev-parse', '--is-shallow-repository')?.trim() === 'true') { unshallowed = true; git('fetch', '--no-tags', '--quiet', '--unshallow', 'origin'); }
    try { execFileSync('git', ['merge-base', '--is-ancestor', rev, of], { cwd: ROOT, stdio: 'ignore' }); return true; } catch { return false; }
  },
};

const baseArg = flag('base') || process.env.GATE_BASE || '';
const base = SHA.test(baseArg) ? baseArg : (git('rev-parse', baseArg || 'origin/main') ?? '').trim();
if (!SHA.test(base)) fail(`could not resolve the base commit (${baseArg || 'origin/main'}); pass --base <commit>`);
if (!ensure(base)) fail(`the base commit ${base} is not available, even from origin`);

const prNumber = Number(process.env.GATE_PR_NUMBER || '');
const prAuthor = process.env.GATE_PR_AUTHOR || '';
const pullRequest = Number.isInteger(prNumber) && prNumber > 0 && prAuthor ? { number: prNumber, author: prAuthor } : null;

/** The repository is public, so the rules read without a token too; a token only lifts the rate limit, and one GitHub refuses is dropped. */
async function rules(): Promise<unknown> {
  const url = `https://api.github.com/repos/${PROVENANCE_REPOSITORY}/rules/branches/main`;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'familista-publication-gate' };
  const ask = (h: Record<string, string>) => fetch(url, { headers: h, signal: AbortSignal.timeout(20_000) });
  let res = await ask(process.env.GITHUB_TOKEN ? { ...headers, Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : headers);
  if (res.status === 401 && process.env.GITHUB_TOKEN) res = await ask(headers);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the rules on main`);
  return res.json();
}

function print(r: GateReport): void {
  out(`Publication gate — base ${base.slice(0, 12)}${pullRequest ? `, pull request #${pullRequest.number} by @${pullRequest.author}` : ''}`);
  out(`  candidates: ${r.candidates.join(', ') || 'none (no publication added or changed)'}${r.removed.length ? `; removed: ${r.removed.join(', ')}` : ''}`);
  for (const c of r.checks) out(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(24)} ${c.subject.padEnd(28)} ${c.detail}`);
  out(`  Platform Owner approval enforced by the repository: ${r.enforcement.ok ? 'yes' : 'NO'}${r.candidates.length ? '' : ' (reported only: there is nothing to publish)'}`);
  for (const f of r.enforcement.findings) out(`    ${f.state.padEnd(10)} ${f.requirement} — ${f.detail}`);
  out(r.ok ? 'PASSED' : 'FAILED: nothing in this change may be published');
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const lines = [`### Publication gate: ${r.ok ? 'passed' : 'FAILED'}`, '', `Candidates: ${r.candidates.join(', ') || 'none'}`, '',
      '| | check | subject | detail |', '|---|---|---|---|', ...r.checks.map((c) => `| ${c.ok ? 'pass' : '**FAIL**'} | ${c.id} | ${c.subject} | ${c.detail.replace(/\|/g, '\\|')} |`),
      '', `Owner approval enforced: **${r.enforcement.ok ? 'yes' : 'no'}**`, '', ...r.enforcement.findings.map((f) => `- ${f.state}: ${f.requirement} — ${f.detail.replace(/\|/g, '\\|')}`), ''];
    try { fs.appendFileSync(summary, `${lines.join('\n')}\n`); } catch { /* the summary is a courtesy */ }
  }
}

runPublicationGate({
  head: (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return null; } },
  base, git: realGit, pullRequest, rules,
}).then((r) => { print(r); process.exit(r.ok ? 0 : 2); }, (e) => fail(`the gate could not run: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
