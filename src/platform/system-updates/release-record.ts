/**
 * The release record: what System Updates knows about the build, written once
 * at build time (scripts/system-updates-build.js, after tsc) from the checkout
 * being deployed, and read by the owner-only API without touching the
 * repository again.
 *
 * The composer is pure. The build script hands it two readers: `git(args)`,
 * which answers a git command's output or null, and `read(path)`, which answers
 * a repository file's text or null. So nothing in src runs a process, and the
 * tests drive every branch with plain strings.
 *
 * Exposure: a commit contributes its hash, its committer date, the first line of
 * its message and the pull request that line names. Never the body, the author
 * or an e-mail address (one in a subject is masked). The repository is kept as
 * "owner/name" only, never as a remote URL, which can carry a credential.
 */
import { createHash } from 'crypto';
import {
  RECORD_SCHEMA_VERSION, type ChangeItem, type DeployFact, type Evidence, type ReleaseRecord,
} from './model';

export type GitReader = (args: string[]) => string | null;
export type FileReader = (relPath: string) => string | null;

export const HISTORY_LIMIT = 15;
export const SUBJECT_LIMIT = 200;
const SHA = /^[0-9a-f]{40}$/;
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/g;
const TAG = /^[A-Za-z0-9._\/-]{1,100}$/;

export const DEPLOY_FILES = { render: 'render.yaml', workflow: '.github/workflows/deploy.yml' } as const;

/** Each fact, the file it is read from, and the exact rule a line must meet. */
const FACT_RULES: Array<{ fact: DeployFact; file: keyof typeof DEPLOY_FILES; rule: RegExp }> = [
  { fact: 'AUTO_DEPLOY_OFF', file: 'render', rule: /^\s*(?:-\s+)?autoDeploy:\s*false\s*(#.*)?$/ },
  { fact: 'AUTO_DEPLOY_ON', file: 'render', rule: /^\s*(?:-\s+)?autoDeploy:\s*true\s*(#.*)?$/ },
  { fact: 'DEPLOY_AFTER_CI', file: 'workflow', rule: /^\s*workflows:\s*\[\s*['"]ci['"]\s*\]\s*(#.*)?$/ },
  { fact: 'DEPLOY_MAIN_ONLY', file: 'workflow', rule: /^\s*branches:\s*\[\s*['"]?main['"]?\s*\]\s*(#.*)?$/ },
  { fact: 'DEPLOY_REQUIRES_SUCCESS', file: 'workflow', rule: /github\.event\.workflow_run\.conclusion\s*==\s*'success'/ },
  { fact: 'DEPLOY_REQUIRES_HEAD', file: 'workflow', rule: /^\s*-\s*name:\s*Check the tested commit is still main's head\s*$/ },
  { fact: 'MANUAL_DEPLOY', file: 'workflow', rule: /^\s*workflow_dispatch:\s*(#.*)?$/ },
];

/** The "owner/name" a remote names, or null. Accepts only that shape, so no URL part (or credential) survives. */
export function repositorySlug(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const m = /([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?\s*$/.exec(remote.trim());
  if (!m) return null;
  const slug = m[1] + '/' + m[2];
  return SLUG.test(slug) ? slug : null;
}

/** The first line of a commit message, masked and bounded. */
export function subjectOf(raw: string): string {
  const first = String(raw).split(/\r?\n/)[0].replace(EMAIL, '…').replace(/\s+/g, ' ').trim();
  return first.length > SUBJECT_LIMIT ? first.slice(0, SUBJECT_LIMIT - 1) + '…' : first;
}

/** The pull request a squash merge names at the end of its subject: "… (#152)". */
export function pullRequestOf(subject: string): number | null {
  const m = /\(#(\d{1,7})\)\s*$/.exec(subject);
  return m ? Number(m[1]) : null;
}

function history(git: GitReader): ReleaseRecord['history'] {
  const out = git(['log', '-n', String(HISTORY_LIMIT), '--format=%H%x1f%cI%x1f%s%x1e', 'HEAD']);
  if (out == null) return { state: 'UNAVAILABLE', reason: 'NO_REPOSITORY_HISTORY' };
  const items: ChangeItem[] = [];
  for (const rec of out.split('\x1e')) {
    const [sha, date, subj] = rec.replace(/^\s+/, '').split('\x1f');
    if (!sha || !SHA.test(sha) || !date || Number.isNaN(Date.parse(date))) continue;
    const subject = subjectOf(subj ?? '');
    items.push({ sha, date: new Date(date).toISOString(), subject, pr: pullRequestOf(subject) });
  }
  if (!items.length) return { state: 'UNAVAILABLE', reason: 'NO_REPOSITORY_HISTORY' };
  const shallow = git(['rev-parse', '--is-shallow-repository']);
  return { state: 'RECORDED', shallow: shallow == null ? null : shallow.trim() === 'true', items };
}

function deployPath(read: FileReader): ReleaseRecord['deployPath'] {
  const facts: Array<{ fact: DeployFact; evidence: Evidence }> = [];
  const files: Array<{ path: string; sha256: string }> = [];
  for (const key of Object.keys(DEPLOY_FILES) as Array<keyof typeof DEPLOY_FILES>) {
    const p = DEPLOY_FILES[key];
    const text = read(p);
    if (text == null) continue;
    files.push({ path: p, sha256: createHash('sha256').update(text).digest('hex') });
    const lines = text.split(/\r?\n/);
    for (const r of FACT_RULES.filter((f) => f.file === key)) {
      const i = lines.findIndex((l) => r.rule.test(l));
      if (i >= 0) facts.push({ fact: r.fact, evidence: { path: p, line: i + 1 } });
    }
  }
  if (!files.length) return { state: 'UNAVAILABLE', reason: 'NO_DEPLOY_CONFIGURATION' };
  return { state: 'RECORDED', facts, files };
}

export function composeReleaseRecord(
  io: { git: GitReader; read: FileReader; env?: NodeJS.ProcessEnv; now?: Date },
): ReleaseRecord {
  const env = io.env ?? process.env;
  const head = (io.git(['rev-parse', 'HEAD']) ?? '').trim();
  const commit = SHA.test(head) ? head : (env.RENDER_GIT_COMMIT && SHA.test(env.RENDER_GIT_COMMIT) ? env.RENDER_GIT_COMMIT : null);
  const tag = (io.git(['tag', '--points-at', 'HEAD']) ?? '').split(/\r?\n/).map((t) => t.trim()).filter((t) => TAG.test(t)).sort()[0] ?? null;
  const repository = repositorySlug(env.RENDER_GIT_REPO_SLUG) ?? repositorySlug(io.git(['remote', 'get-url', 'origin']));
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    builtAt: (io.now ?? new Date()).toISOString(),
    commit,
    tag,
    repository,
    history: history(io.git),
    deployPath: deployPath(io.read),
  };
}
