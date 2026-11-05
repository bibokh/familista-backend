/**
 * Familista System Updates — the contract of GET /system/updates.
 *
 * What the platform is running, how a change reaches production, what changed
 * recently, and what waits for the platform owner's approval. Read-only: the
 * room shows these and changes nothing.
 *
 * Every figure is either read from a named source or reported as not connected
 * or unknown, with a reason code the room words in the reader's language. The
 * server never fills a gap by inference: a deploy that probably passed CI is
 * not a deploy that is known to have passed it.
 *
 * Sources, all of them already in the platform:
 *   · the release record — written at build time (scripts/system-updates-build.js)
 *     from the checkout being deployed: its commit, its recent history, its tag,
 *     and the deployment path as render.yaml and .github/workflows/deploy.yml
 *     declare it, each fact with the file and line it was read from;
 *   · the Render build environment (RENDER_GIT_COMMIT, RENDER_GIT_BRANCH);
 *   · this server process (environment, start time, Node.js version);
 *   · the algorithms registry and its candidate evidence (src/algorithms), for
 *     changes at the human-approval stage.
 *
 * Not connected, by design: the CI provider, the hosting provider's API and the
 * code-review queue. The server holds no credential for any of them, so it can
 * say nothing about them, and says so.
 *
 * Modular on purpose: each section carries its own state, so a later phase can
 * add one (proposed updates, version comparison, test results, approval) without
 * changing the meaning of the ones here.
 */

export const UPDATES_SCHEMA_VERSION = 1 as const;
export const RECORD_SCHEMA_VERSION = 1 as const;

/** Why a section, or a figure in it, has no value. The room words each one; the server sends no prose. */
export const UPDATE_REASONS = [
  'NO_BUILD_RECORD',          // this server was not built with a release record (a developer's server, a test)
  'NO_REPOSITORY_HISTORY',    // the build that wrote the record had no repository history to read
  'NO_DEPLOY_CONFIGURATION',  // the build found neither render.yaml nor the deploy workflow
  'NO_CI_CONNECTION',         // the server holds no credential for the CI provider
  'NO_PROVIDER_CONNECTION',   // the server holds no credential for the hosting provider's API
  'NO_CODE_REVIEW_CONNECTION',// the server does not read the code-review queue (pull requests)
  'REGISTRY_UNAVAILABLE',     // the algorithms registry or its candidate evidence could not be read
] as const;
export type UpdateReason = typeof UPDATE_REASONS[number];

/**
 * A fact about how a change reaches production, read from the repository's own
 * configuration. Each is detected by an exact rule over one file (release-record.ts)
 * and carries the line it was read from; a fact the rule does not find is absent,
 * never assumed.
 */
export const DEPLOY_FACTS = [
  'AUTO_DEPLOY_OFF',          // render.yaml: autoDeploy: false — a push alone deploys nothing
  'AUTO_DEPLOY_ON',           // render.yaml: autoDeploy: true — every push to the branch deploys
  'DEPLOY_AFTER_CI',          // deploy.yml runs when the ci workflow completes
  'DEPLOY_MAIN_ONLY',         // … for the main branch only
  'DEPLOY_REQUIRES_SUCCESS',  // … and only when that ci run succeeded
  'DEPLOY_REQUIRES_HEAD',     // … and only for the commit still at main's head
  'MANUAL_DEPLOY',            // a deliberate manual run of the deploy workflow is also possible
] as const;
export type DeployFact = typeof DEPLOY_FACTS[number];

export interface Evidence { path: string; line: number }

/** One commit in the release's recent history: never its body, author or e-mail. */
export interface ChangeItem {
  sha: string;              // the full commit hash
  date: string;             // the committer date, ISO 8601
  subject: string;          // the first line of the message, at most 200 characters
  pr: number | null;        // the pull request a squash merge names in its subject, "(#152)"
}

/** What the build wrote, once, from the checkout being deployed. */
export interface ReleaseRecord {
  schemaVersion: typeof RECORD_SCHEMA_VERSION;
  builtAt: string;
  commit: string | null;
  tag: string | null;                 // a tag on exactly this commit; null when there is none
  repository: string | null;          // "owner/name", for links only
  history:
    | { state: 'RECORDED'; shallow: boolean | null; items: ChangeItem[] }
    | { state: 'UNAVAILABLE'; reason: 'NO_REPOSITORY_HISTORY' };
  deployPath:
    | { state: 'RECORDED'; facts: Array<{ fact: DeployFact; evidence: Evidence }>; files: Array<{ path: string; sha256: string }> }
    | { state: 'UNAVAILABLE'; reason: 'NO_DEPLOY_CONFIGURATION' };
}

export type Connection = { state: 'NOT_CONNECTED'; reason: UpdateReason };

export interface ApprovalCount {
  state: 'AVAILABLE' | 'UNAVAILABLE';
  awaiting: number | null;      // at the human-approval stage now
  total: number | null;         // of how many
  reason: UpdateReason | null;
}

export interface SystemUpdatesView {
  schemaVersion: typeof UPDATES_SCHEMA_VERSION;
  measuredAt: string;
  mode: 'READ_ONLY';
  running: {
    commit: string | null;        // what Render says it deployed (RENDER_GIT_COMMIT)
    builtCommit: string | null;   // what the build record was written from
    branch: string | null;        // RENDER_GIT_BRANCH
    onRender: boolean;
    environment: string;
    builtAt: string | null;
    startedAt: string;            // when this server process started
    node: string;
    tag: string | null;
    record: 'PRESENT' | 'ABSENT';
    reason: UpdateReason | null;  // why builtAt, builtCommit and tag are unknown
  };
  deployPath: ReleaseRecord['deployPath'] | { state: 'UNAVAILABLE'; reason: 'NO_BUILD_RECORD' };
  ci: Connection;
  provider: Connection;
  changes: ReleaseRecord['history'] | { state: 'UNAVAILABLE'; reason: 'NO_BUILD_RECORD' };
  approvals: {
    algorithms: ApprovalCount;    // registered algorithm versions waiting for the owner
    candidates: ApprovalCount;    // proposed algorithm changes waiting for the owner
    code: Connection;             // pull requests: not read by the server
  };
  repository: string | null;
}
