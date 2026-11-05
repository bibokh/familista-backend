/**
 * System Updates — the answer GET /system/updates gives the platform owner.
 *
 * Composed per request from what is already known: the release record the
 * build wrote (read once and kept), the Render build environment, this
 * process, and the algorithms registry's own counts. Nothing is fetched from
 * outside, and nothing is written.
 */
import * as fs from 'fs';
import * as path from 'path';
import { algorithmsOverview } from '../../algorithms/algorithms.service';
import { algorithmCandidates } from '../../algorithms/candidates';
import {
  RECORD_SCHEMA_VERSION, UPDATES_SCHEMA_VERSION,
  type ApprovalCount, type ReleaseRecord, type SystemUpdatesView,
} from './model';

export const RELEASE_RECORD_FILE = path.join(__dirname, 'generated', 'release-record.json');
const SHA = /^[0-9a-f]{40}$/;

let cached: { record: ReleaseRecord | null } | null = null;

/** The record the build wrote, or null when this server was not built with one (or it does not read as one). */
export function loadReleaseRecord(file: string = RELEASE_RECORD_FILE): ReleaseRecord | null {
  if (cached && file === RELEASE_RECORD_FILE) return cached.record;
  let record: ReleaseRecord | null = null;
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as ReleaseRecord;
    if (r && r.schemaVersion === RECORD_SCHEMA_VERSION && typeof r.builtAt === 'string') record = r;
  } catch { record = null; }
  if (file === RELEASE_RECORD_FILE) cached = { record };
  return record;
}

/** For the tests: forget the record read so far. */
export function resetReleaseRecordCache(): void { cached = null; }

function algorithmApprovals(): ApprovalCount {
  try {
    const o = algorithmsOverview();
    if (o.state !== 'READY' || !o.totals) return { state: 'UNAVAILABLE', awaiting: null, total: null, reason: 'REGISTRY_UNAVAILABLE' };
    return { state: 'AVAILABLE', awaiting: o.totals.awaitingApproval, total: o.totals.registered, reason: null };
  } catch {
    return { state: 'UNAVAILABLE', awaiting: null, total: null, reason: 'REGISTRY_UNAVAILABLE' };
  }
}

function candidateApprovals(): ApprovalCount {
  try {
    const c = algorithmCandidates();
    if (c.state !== 'READY') return { state: 'UNAVAILABLE', awaiting: null, total: null, reason: 'REGISTRY_UNAVAILABLE' };
    return { state: 'AVAILABLE', awaiting: c.counts.awaitingApproval, total: c.counts.candidates, reason: null };
  } catch {
    return { state: 'UNAVAILABLE', awaiting: null, total: null, reason: 'REGISTRY_UNAVAILABLE' };
  }
}

export function systemUpdates(opts: {
  env?: NodeJS.ProcessEnv; now?: Date; uptimeSec?: number; record?: ReleaseRecord | null;
} = {}): SystemUpdatesView {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const uptime = opts.uptimeSec ?? process.uptime();
  const record = opts.record !== undefined ? opts.record : loadReleaseRecord();
  const deployed = env.RENDER_GIT_COMMIT && SHA.test(env.RENDER_GIT_COMMIT) ? env.RENDER_GIT_COMMIT : null;
  const branch = env.RENDER_GIT_BRANCH && /^[A-Za-z0-9._\/-]{1,200}$/.test(env.RENDER_GIT_BRANCH) ? env.RENDER_GIT_BRANCH : null;
  return {
    schemaVersion: UPDATES_SCHEMA_VERSION,
    measuredAt: now.toISOString(),
    mode: 'READ_ONLY',
    running: {
      commit: deployed,
      builtCommit: record ? record.commit : null,
      branch,
      onRender: Boolean(deployed),
      environment: String(env.NODE_ENV || 'development'),
      builtAt: record ? record.builtAt : null,
      startedAt: new Date(now.getTime() - Math.round(uptime * 1000)).toISOString(),
      node: process.version,
      tag: record ? record.tag : null,
      record: record ? 'PRESENT' : 'ABSENT',
      reason: record ? null : 'NO_BUILD_RECORD',
    },
    deployPath: record ? record.deployPath : { state: 'UNAVAILABLE', reason: 'NO_BUILD_RECORD' },
    ci: { state: 'NOT_CONNECTED', reason: 'NO_CI_CONNECTION' },
    provider: { state: 'NOT_CONNECTED', reason: 'NO_PROVIDER_CONNECTION' },
    changes: record ? record.history : { state: 'UNAVAILABLE', reason: 'NO_BUILD_RECORD' },
    approvals: {
      algorithms: algorithmApprovals(),
      candidates: candidateApprovals(),
      code: { state: 'NOT_CONNECTED', reason: 'NO_CODE_REVIEW_CONNECTION' },
    },
    repository: record ? record.repository : null,
  };
}
