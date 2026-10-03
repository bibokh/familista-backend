// The Cybersecurity Control Plane — one read model over the evidence
// ─────────────────────────────────────────────────────────────────────────────
// Composes what the Cyber Defense work already proves (coverage map, posture
// manifest, posture policy) with what the running platform recorded (runtime
// snapshot) into the views the Command Center draws.
//
// THE RULES THIS FILE KEEPS, IN ONE PLACE
//
//   PROTECTION is evidence-only. A domain or area is PROTECTED when every trust
//   boundary it answers for is covered (C) AND every control on them is PRESENT
//   in the manifest. One partial boundary or control makes it PARTIAL; an
//   uncovered boundary or a missing required control makes it AT RISK; evidence
//   that cannot be read makes it UNKNOWN. Nothing is protected by default.
//
//   OBSERVING is a rollout stage, said explicitly: the RLS pilot with its
//   context switched on but enforcement off is OBSERVING — neither "protected"
//   nor "broken".
//
//   LIVE is separate from protection. A domain whose runtime is not measured is
//   NOT INSTRUMENTED, never green; one enforced only at build time is NOT
//   APPLICABLE at runtime; a read that failed is UNAVAILABLE.
//
// Everything returned is metadata, counts and instants. No id, user, club, IP
// address, payload, query, environment value or secret reaches a response.

import {
  SECURITY_DOMAINS, PLATFORM_AREAS, AREA_GROUPS, SECURITY_LIFECYCLE, METRIC_LABELS, EVENT_KIND_LABELS,
  WARNING_TEXT, CONFIG_LABELS, NO_LIVE_TEXT, RLS_STAGES, domainById,
  type DomainDecl, type AreaGroup, type ConfigValue,
} from './registry';
import {
  postureEvidence, coverageEvidence, policyEvidence,
  type PostureEvidence, type CoverageEvidence, type PolicyEvidence, type BoundaryRow,
} from './posture-source';
import { runtimeSnapshot, recentEvents, recentSignals, type RuntimeSnapshot } from './runtime';
import { SECURITY_EVENT_TYPES } from '../security-event-schema';
import { RLS_PILOT_MODELS } from '../../security/db-context';

// ── vocabulary ───────────────────────────────────────────────────────────────

export type ProtectionState = 'PROTECTED' | 'PARTIAL' | 'OBSERVING' | 'AT_RISK' | 'UNKNOWN';
export type LiveState = 'LIVE' | 'WARNING' | 'NOT_INSTRUMENTED' | 'NOT_APPLICABLE' | 'UNAVAILABLE';
export type StageState = ProtectionState | 'NOT_INSTRUMENTED' | 'INFO';
export type FigureKind = 'count' | 'flag' | 'instant' | 'hours' | 'text';
export type FigureSource = 'build' | 'runtime' | 'process';

export interface Figure {
  key: string;
  label: string;
  value: number | string | boolean | null;
  kind: FigureKind;
  source: FigureSource;
  /** Why `value` is null. Absent when there is a value. */
  why: string | null;
}
export interface ConfigItem { key: string; label: string; value: ConfigValue }
export interface Warning { key: string; text: string }
export interface ControlView {
  id: string;
  status: 'PRESENT' | 'PARTIAL' | 'ABSENT' | 'MISSING';
  required: boolean;
  knownGap: string | null;
  evidence: string | null;
  note: string | null;
}
export interface RowView {
  id: number; name: string; coverage: 'C' | 'P' | 'U'; boundaryType: string;
  flow: string; owner: string; dataClass: string;
  controls: string[]; reason: string | null; plannedIn: string | null;
}
export interface SignalTypeView {
  type: string; category: string; describes: string; produced: boolean;
  count24h: number | null; count7d: number | null;
}
export interface DomainEventsView {
  state: LiveState;
  kinds: Array<{ kind: string; label: string; count24h: number | null; count7d: number | null; critical24h: number | null }>;
  signals: SignalTypeView[];
  total24h: number | null;
  total7d: number | null;
  why: string | null;
}
export interface DomainSummary {
  id: string; title: string; protects: string;
  state: ProtectionState;
  protection: ProtectionState;
  live: LiveState;
  liveWhy: string | null;
  rows: number[];
  controls: { total: number; present: number; partial: number; absent: number };
  figures: Figure[];
  config: ConfigItem[];
  warnings: Warning[];
  events: DomainEventsView;
  areas: string[];
}
export interface DomainDetail extends DomainSummary {
  controlList: ControlView[];
  rowList: RowView[];
  recentEvents: { state: 'READ' | 'UNAVAILABLE' | 'NOT_INSTRUMENTED'; items: Array<{ kind: string; label: string; severity: string; at: string }>; why: string | null };
  recentSignals: { state: 'READ' | 'UNAVAILABLE' | 'NOT_INSTRUMENTED'; items: Array<{ type: string; at: string }>; why: string | null };
}
export interface AreaApiView {
  routers: number; handlers: number; publicHandlers: number; routerWideAuth: number;
  authz: Record<string, number>;
  tenancy: { guarded: number; exempt: number; unguarded: number };
}
export interface AreaView {
  id: string; title: string; group: AreaGroup;
  state: ProtectionState;
  rows: number[];
  gaps: RowView[];
  domains: string[];
  routers: string[];
  api: AreaApiView | null;
  note: string | null;
}
export interface StageView {
  id: string; title: string; describes: string;
  state: StageState;
  controls: Array<{ id: string; status: ControlView['status'] }>;
  figures: Figure[];
  outsideView: string | null;
}
export interface RlsView {
  state: ProtectionState;
  mode: 'off' | 'observe' | 'on';
  enforced: boolean | null;
  stage: { index: number; id: string; title: string; describes: string };
  stages: Array<{ id: string; title: string; describes: string; reached: boolean; current: boolean }>;
  tables: string[];
  systemPaths: Array<{ reason: string; review: string }>;
  observations: Array<{ model: string; operation: string; firstSeenAt: string }>;
  windowStart: string;
  warnings: Warning[];
}
export interface EventsOverview {
  state: LiveState;
  why: string | null;
  total24h: number | null; total7d: number | null; critical24h: number | null; warning24h: number | null;
  /** Null counts when the read failed: an unread figure is not a zero. */
  kinds: Array<{ kind: string; label: string; count24h: number | null; count7d: number | null; critical24h: number | null }>;
  signals: SignalTypeView[];
  alerts: { dispatcherRunning: boolean; recipientConfigured: boolean };
}
export interface PostureView {
  verdict: ProtectionState;
  boundaries: { total: number; C: number; P: number; U: number };
  controls: { total: number; present: number; partial: number; absent: number };
  required: { total: number; present: number };
  knownGaps: Array<{ id: string; status: ControlView['status']; text: string }>;
  domains: Record<ProtectionState, number>;
  generatedAt: string;
  generator: string;
}
export interface CommandCenterOverview {
  state: 'READY' | 'NOT_GENERATED';
  reason: string | null;
  generatedAt: string | null;
  measuredAt: string;
  instance: { startedAt: string; uptimeHours: number };
  posture: PostureView | null;
  groups: Array<{ id: AreaGroup; title: string }>;
  domains: DomainSummary[];
  areas: AreaView[];
  lifecycle: StageView[];
  boundaries: RowView[];
  rls: RlsView | null;
  events: EventsOverview;
  unassignedRouters: string[];
}

// ── state arithmetic ─────────────────────────────────────────────────────────

const RANK: Record<ProtectionState, number> = { AT_RISK: 0, UNKNOWN: 1, PARTIAL: 2, OBSERVING: 3, PROTECTED: 4 };
function worst(states: ProtectionState[]): ProtectionState {
  return states.reduce<ProtectionState>((w, s) => (RANK[s] < RANK[w] ? s : w), 'PROTECTED');
}
function rowState(c: BoundaryRow['coverage']): ProtectionState {
  return c === 'C' ? 'PROTECTED' : c === 'P' ? 'PARTIAL' : 'AT_RISK';
}
function controlState(c: ControlView): ProtectionState {
  if (c.status === 'PRESENT') return 'PROTECTED';
  if (c.status === 'PARTIAL') return 'PARTIAL';
  if (c.status === 'MISSING') return 'UNKNOWN';
  return c.required ? 'AT_RISK' : 'PARTIAL';
}

interface Evidence { posture: PostureEvidence; coverage: CoverageEvidence; policy: PolicyEvidence }

function evidence(): Evidence | { reason: string } {
  const p = postureEvidence(); const c = coverageEvidence(); const pol = policyEvidence();
  if (p.state !== 'READY') return { reason: p.reason };
  if (c.state !== 'READY') return { reason: c.reason };
  if (pol.state !== 'READY') return { reason: pol.reason };
  return { posture: p.value, coverage: c.value, policy: pol.value };
}

function controlView(ev: Evidence, id: string): ControlView {
  const c = ev.posture.controls.find((x) => x.id === id);
  const gap = ev.policy.knownGaps[id];
  return {
    id,
    status: c ? c.status : 'MISSING',
    required: ev.policy.requiredControls.includes(id),
    knownGap: gap ?? null,
    evidence: c?.evidence ?? null,
    note: c?.note ?? null,
  };
}

function rowView(r: BoundaryRow): RowView {
  return {
    id: r.id, name: r.name, coverage: r.coverage, boundaryType: r.boundaryType, flow: r.flow,
    owner: r.owner, dataClass: r.dataClass, controls: [...r.controls], reason: r.reason, plannedIn: r.plannedIn,
  };
}

const rowsOf = (ev: Evidence, ids: number[]) => ev.coverage.rows.filter((r) => ids.includes(r.id));

function domainControlIds(ev: Evidence, d: DomainDecl): string[] {
  const ids = new Set<string>();
  for (const r of rowsOf(ev, d.rows)) r.controls.forEach((c) => ids.add(c));
  d.extraControls.forEach((c) => ids.add(c));
  return [...ids];
}

// ── figures ─────────────────────────────────────────────────────────────────

function fig(key: string, value: Figure['value'], kind: FigureKind, source: FigureSource, why: string | null = null): Figure {
  return { key, label: METRIC_LABELS[key] ?? key, value, kind, source, why: value === null ? (why ?? 'Not measured.') : null };
}
const UNAVAILABLE_WHY = 'The platform could not read this just now.';
const cfg = (key: string, value: ConfigValue): ConfigItem => ({ key, label: CONFIG_LABELS[key] ?? key, value });
const warn = (key: string): Warning => ({ key, text: WARNING_TEXT[key] ?? key });

interface AdapterOut { figures: Figure[]; config: ConfigItem[]; warnings: Warning[]; live: 'runtime' | 'process' | 'build' | 'build-time' | 'none' | 'see-infrastructure'; failed: boolean }

function adapter(d: DomainDecl, ev: Evidence, rt: RuntimeSnapshot): AdapterOut {
  const api = ev.posture.api;
  const p = rt.process;
  const out: AdapterOut = { figures: [], config: [], warnings: [], live: 'build', failed: false };
  switch (d.adapter) {
    case 'identity':
      out.figures.push(
        fig('api.handlers', api.handlers, 'count', 'build'),
        fig('authz.roles', api.authzByKind.roles ?? 0, 'count', 'build'),
        fig('authz.scoped', api.authzByKind.scoped ?? 0, 'count', 'build'),
        fig('authz.member', api.authzByKind.member ?? 0, 'count', 'build'),
        fig('authz.owner', api.authzByKind['platform-owner'] ?? 0, 'count', 'build'),
        fig('authz.public', api.authzByKind.public ?? 0, 'count', 'build'),
      );
      out.live = 'none';
      break;
    case 'mfa': {
      const m = rt.mfa;
      out.figures.push(
        fig('mfa.requiredForAdmins', p.mfaRequiredForAdmins, 'flag', 'process'),
        fig('mfa.admins', m.value?.admins ?? null, 'count', 'runtime', m.reason ?? UNAVAILABLE_WHY),
        fig('mfa.adminsEnrolled', m.value?.adminsEnrolled ?? null, 'count', 'runtime', m.reason ?? UNAVAILABLE_WHY),
      );
      out.config.push(cfg('mfa.requiredForAdmins', p.mfaRequiredForAdmins ? 'On' : 'Off'));
      if (p.mfaRequiredForAdmins && m.value && m.value.adminsEnrolled < m.value.admins) out.warnings.push(warn('mfa.adminsNotEnrolled'));
      out.live = 'runtime'; out.failed = m.state !== 'READ';
      break;
    }
    case 'tenancy':
      out.figures.push(
        fig('tenancy.idParameters', api.tenancy.idParameters, 'count', 'build'),
        fig('tenancy.guarded', api.tenancy.guarded, 'count', 'build'),
        fig('tenancy.exempt', api.tenancy.exempt, 'count', 'build'),
        fig('tenancy.unguarded', api.tenancy.unguarded, 'count', 'build'),
      );
      if (api.tenancy.unguarded > 0) out.warnings.push(warn('tenancy.unguarded'));
      if ((rt.events.value?.byKind24h.TENANT_MISMATCH ?? 0) > 0) out.warnings.push(warn('events.tenantMismatch'));
      out.live = 'none';
      break;
    case 'rls': {
      const r = rlsView(ev, rt);
      out.figures.push(
        fig('rls.mode', p.rlsMode, 'text', 'process'),
        fig('rls.enforced', r.enforced, 'flag', 'runtime', rt.rlsEnforced.reason ?? UNAVAILABLE_WHY),
        fig('rls.tables', r.tables.length, 'count', 'build'),
        fig('rls.systemPaths', r.systemPaths.length, 'count', 'build'),
        fig('rls.observations', r.observations.length, 'count', 'process'),
      );
      out.config.push(
        cfg('rls.mode', p.rlsMode === 'on' ? 'On' : p.rlsMode === 'observe' ? 'Observe' : 'Off'),
        cfg('rls.enforcement', r.enforced === true ? 'Enforced' : r.enforced === false ? 'Not enforced' : 'Unknown'),
      );
      out.warnings.push(...r.warnings);
      out.live = 'process'; out.failed = rt.rlsEnforced.state !== 'READ';
      break;
    }
    case 'api':
      out.figures.push(
        fig('api.routers', api.routers, 'count', 'build'),
        fig('api.handlers', api.handlers, 'count', 'build'),
        fig('api.public', api.publicHandlers, 'count', 'build'),
        fig('api.routerWideAuth', ev.posture.mounts.filter((m) => m.routerWideAuth).length, 'count', 'build'),
        fig('api.dormant', api.dormantModules, 'count', 'build'),
        fig('api.outbound', api.outboundCallSites, 'count', 'build'),
      );
      out.live = 'none';
      break;
    case 'ai': {
      const a = rt.ai;
      out.figures.push(
        fig('ai.calls24h', a.value?.calls24h ?? null, 'count', 'runtime', a.reason ?? UNAVAILABLE_WHY),
        fig('ai.refused24h', a.value?.refused24h ?? null, 'count', 'runtime', a.reason ?? UNAVAILABLE_WHY),
        fig('ai.failed24h', a.value?.failed24h ?? null, 'count', 'runtime', a.reason ?? UNAVAILABLE_WHY),
        fig('ai.pendingApprovals', a.value?.pendingApprovals ?? null, 'count', 'runtime', a.reason ?? UNAVAILABLE_WHY),
      );
      out.live = 'runtime'; out.failed = a.state !== 'READ';
      break;
    }
    case 'devices': {
      const dv = rt.devices;
      out.figures.push(
        fig('devices.events24h', dv.value?.events24h ?? null, 'count', 'runtime', dv.reason ?? UNAVAILABLE_WHY),
        fig('devices.events7d', dv.value?.events7d ?? null, 'count', 'runtime', dv.reason ?? UNAVAILABLE_WHY),
      );
      out.live = 'runtime'; out.failed = dv.state !== 'READ';
      break;
    }
    case 'webhooks':
      out.config.push(
        cfg('webhooks.vision', p.visionWebhookConfigured ? 'Open — signed callbacks only' : 'Closed — no secret configured'),
        cfg('webhooks.clip', p.clipWebhookConfigured ? 'Open — signed callbacks only' : 'Closed — no secret configured'),
      );
      out.live = 'none';
      break;
    case 'crypto':
      out.figures.push(
        fig('crypto.primitives', ev.posture.crypto.length, 'count', 'build'),
      );
      out.live = 'none';
      break;
    case 'secrets':
      out.figures.push(
        fig('secrets.declared', ev.posture.secrets.declared, 'count', 'build'),
        fig('secrets.secretNamed', ev.posture.secrets.secretNamed, 'count', 'build'),
        fig('secrets.inline', ev.posture.secrets.inline, 'count', 'build'),
      );
      if (ev.posture.secrets.inline > 0) out.warnings.push(warn('secrets.inline'));
      out.live = 'none';
      break;
    case 'storage':
    case 'video':
      out.live = 'none';
      break;
    case 'backups': {
      const b = rt.backups;
      const last = b.value?.lastSuccessAt ?? null;
      const age = last ? Math.floor((Date.parse(rt.measuredAt) - Date.parse(last)) / 3_600_000) : null;
      out.figures.push(
        fig('backups.lastSuccess', last, 'instant', 'runtime', b.state === 'READ' ? 'No successful scheduled backup is recorded.' : (b.reason ?? UNAVAILABLE_WHY)),
        fig('backups.ageHours', age, 'hours', 'runtime', b.state === 'READ' ? 'No successful scheduled backup is recorded.' : (b.reason ?? UNAVAILABLE_WHY)),
        fig('backups.failed7d', b.value?.failed7d ?? null, 'count', 'runtime', b.reason ?? UNAVAILABLE_WHY),
      );
      if (b.state === 'READ') {
        if (!last) out.warnings.push(warn('backups.never'));
        else if (age !== null && age >= p.backupStaleAfterHours) out.warnings.push(warn('backups.stale'));
        if ((b.value?.failed7d ?? 0) > 0) out.warnings.push(warn('backups.failed'));
      }
      out.live = 'runtime'; out.failed = b.state !== 'READ';
      break;
    }
    case 'audit': {
      const a = rt.audit;
      out.figures.push(
        fig('audit.chainEvents', a.value?.appended7d ?? null, 'count', 'runtime', a.reason ?? UNAVAILABLE_WHY),
        fig('audit.lastAppended', a.value?.lastAppendedAt ?? null, 'instant', 'runtime', a.state === 'READ' ? 'No audit event has been appended yet.' : (a.reason ?? UNAVAILABLE_WHY)),
        fig('audit.egressRecords', a.value?.egress7d ?? null, 'count', 'runtime', a.reason ?? UNAVAILABLE_WHY),
      );
      if ((rt.events.value?.byKind24h.AUDIT_CHAIN_BROKEN ?? 0) > 0) out.warnings.push(warn('audit.chainBroken'));
      out.live = 'runtime'; out.failed = a.state !== 'READ';
      break;
    }
    case 'events': {
      const e = rt.events;
      const s = rt.signals;
      const signals24h = s.value ? Object.values(s.value.byType24h).reduce((n, v) => n + v, 0) : null;
      out.figures.push(
        fig('events.total24h', e.value?.total24h ?? null, 'count', 'runtime', e.reason ?? UNAVAILABLE_WHY),
        fig('events.critical24h', e.value?.critical24h ?? null, 'count', 'runtime', e.reason ?? UNAVAILABLE_WHY),
        fig('events.warning24h', e.value?.warning24h ?? null, 'count', 'runtime', e.reason ?? UNAVAILABLE_WHY),
        fig('events.total7d', e.value?.total7d ?? null, 'count', 'runtime', e.reason ?? UNAVAILABLE_WHY),
        fig('events.signals24h', signals24h, 'count', 'runtime', s.reason ?? UNAVAILABLE_WHY),
      );
      out.config.push(
        cfg('alerts.dispatcher', p.alertDispatcherRunning ? 'Running' : 'Not running'),
        cfg('alerts.recipient', p.alertRecipientConfigured ? 'Configured' : 'Not configured'),
      );
      if (!p.alertRecipientConfigured) out.warnings.push(warn('alerts.noRecipient'));
      else if (!p.alertDispatcherRunning) out.warnings.push(warn('alerts.stopped'));
      if ((e.value?.critical24h ?? 0) > 0) out.warnings.push(warn('events.critical'));
      out.live = 'runtime'; out.failed = e.state !== 'READ';
      break;
    }
    case 'supply-chain': {
      const sc = ev.posture.supplyChain;
      const n = (k: string) => (typeof sc[k] === 'number' ? sc[k] as number : null);
      out.figures.push(
        fig('supply.packages', n('lockfilePackages'), 'count', 'build'),
        fig('supply.integrity', n('lockfileIntegrity'), 'count', 'build'),
        fig('supply.actionsPinned', n('actionsPinnedBySha'), 'count', 'build'),
      );
      if ((n('lockfileIntegrity') ?? 0) < (n('lockfilePackages') ?? 0)) out.warnings.push(warn('supply.integrity'));
      out.live = 'build-time';
      break;
    }
    case 'infrastructure': {
      const ds = ev.posture.datastores;
      out.figures.push(fig('infra.datastores', ds.filter((d) => d.privateNetworkOnly).length, 'count', 'build'));
      if (ds.some((d) => !d.privateNetworkOnly)) out.warnings.push(warn('infra.publicDatastore'));
      out.live = 'see-infrastructure';
      break;
    }
    case 'monitoring':
      out.figures.push(
        fig('monitor.written', p.collectors.written, 'count', 'process'),
        fig('monitor.suppressed', p.collectors.suppressed, 'count', 'process'),
        fig('monitor.overCap', p.collectors.overCap, 'count', 'process'),
        fig('monitor.refused', p.collectors.refused, 'count', 'process'),
        fig('monitor.uptimeHours', p.uptimeHours, 'hours', 'process'),
      );
      out.config.push(
        cfg('alerts.dispatcher', p.alertDispatcherRunning ? 'Running' : 'Not running'),
        cfg('alerts.recipient', p.alertRecipientConfigured ? 'Configured' : 'Not configured'),
      );
      if (p.collectors.refused > 0) out.warnings.push(warn('monitor.refused'));
      out.live = 'process';
      break;
  }
  return out;
}

// ── events per domain ─────────────────────────────────────────────────────────

/** A domain's `security.*` signals: the ones the schema declares it evidences. */
function signalTypesOf(d: DomainDecl): typeof SECURITY_EVENT_TYPES {
  return d.allSignals ? SECURITY_EVENT_TYPES : SECURITY_EVENT_TYPES.filter((t) => t.evidences === d.id);
}

function domainEvents(d: DomainDecl, rt: RuntimeSnapshot): DomainEventsView {
  const all = d.eventKinds.includes('*');
  const kinds = all ? Object.keys(EVENT_KIND_LABELS) : d.eventKinds;
  const types = signalTypesOf(d);
  const e = rt.events.value; const s = rt.signals.value;
  const signals: SignalTypeView[] = types.map((t) => ({
    type: t.type, category: t.category, describes: t.describes, produced: t.produced,
    count24h: s ? (s.byType24h[t.type] ?? 0) : null,
    count7d: s ? (s.byType7d[t.type] ?? 0) : null,
  }));
  const kindViews = kinds.map((k) => ({
    kind: k, label: EVENT_KIND_LABELS[k] ?? k,
    count24h: e ? (e.byKind24h[k] ?? 0) : null,
    count7d: e ? (e.byKind7d[k] ?? 0) : null,
    critical24h: e ? (e.critical24hByKind[k] ?? 0) : null,
  }));
  const instrumented = kinds.length > 0 || signals.some((x) => x.produced);
  if (!instrumented) {
    return {
      state: 'NOT_INSTRUMENTED', kinds: kindViews, signals, total24h: null, total7d: null,
      why: signals.length ? NO_LIVE_TEXT['declared-not-produced'] : NO_LIVE_TEXT['no-events'],
    };
  }
  if (rt.events.state !== 'READ' && kinds.length) {
    return { state: 'UNAVAILABLE', kinds: kindViews, signals, total24h: null, total7d: null, why: rt.events.reason ?? UNAVAILABLE_WHY };
  }
  const sum = (f: (k: typeof kindViews[number]) => number | null, g: (x: SignalTypeView) => number | null) =>
    kindViews.reduce((n, k) => n + (f(k) ?? 0), 0) + signals.reduce((n, x) => n + (g(x) ?? 0), 0);
  const critical = kindViews.reduce((n, k) => n + (k.critical24h ?? 0), 0);
  return {
    state: critical > 0 ? 'WARNING' : 'LIVE', kinds: kindViews, signals,
    total24h: sum((k) => k.count24h, (x) => x.count24h), total7d: sum((k) => k.count7d, (x) => x.count7d), why: null,
  };
}

// ── RLS ─────────────────────────────────────────────────────────────────────

function rlsView(ev: Evidence, rt: RuntimeSnapshot): RlsView {
  const mode = rt.process.rlsMode;
  const enforced = rt.rlsEnforced.state === 'READ' ? rt.rlsEnforced.value : null;
  let index = mode === 'on' ? 2 : mode === 'observe' ? 1 : 0;
  if (enforced === true) index = 3;
  const warnings: Warning[] = [];
  if (enforced === true && mode !== 'on') warnings.push(warn('rls.enforcedWithoutContext'));
  if (rt.process.rlsObservations.length > 0) warnings.push(warn('rls.observations'));
  const tables = ev.policy.rlsPilotTables.length ? [...ev.policy.rlsPilotTables] : [...RLS_PILOT_MODELS];
  let state: ProtectionState;
  if (warnings.some((w) => w.key === 'rls.enforcedWithoutContext')) state = 'AT_RISK';
  else if (enforced === true && mode === 'on') state = 'PROTECTED';
  else if (enforced === null) state = 'UNKNOWN';
  else if (mode === 'off') state = 'PARTIAL';
  else state = 'OBSERVING';
  const stage = RLS_STAGES[index];
  return {
    state, mode, enforced,
    stage: { index, ...stage },
    stages: RLS_STAGES.map((s, i) => ({ ...s, reached: i <= index, current: i === index })),
    tables,
    systemPaths: Object.entries(ev.policy.rlsSystemPaths).map(([reason, review]) => ({ reason, review })),
    observations: rt.process.rlsObservations.map((o) => ({ ...o })),
    windowStart: rt.process.rlsObservationWindowStart,
    warnings,
  };
}

// ── composition ─────────────────────────────────────────────────────────────

function areaRows(ev: Evidence, a: typeof PLATFORM_AREAS[number]): number[] {
  const ids = new Set<number>(a.rows);
  for (const r of a.routers) (ev.coverage.routers[r] ?? []).forEach((id) => ids.add(id));
  return [...ids].sort((x, y) => x - y);
}

function areaApi(ev: Evidence, a: typeof PLATFORM_AREAS[number]): AreaApiView | null {
  const all = a.id === 'apis';
  const mounts = all ? ev.posture.mounts : ev.posture.mounts.filter((m) => a.routers.includes(m.module));
  if (!mounts.length) return null;
  const authz: Record<string, number> = {};
  const tenancy = { guarded: 0, exempt: 0, unguarded: 0 };
  for (const m of mounts) {
    for (const [k, v] of Object.entries(ev.posture.api.authzByRouter[m.module] ?? {})) authz[k] = (authz[k] ?? 0) + v;
    const t = ev.posture.api.tenancyByRouter[m.module];
    if (t) { tenancy.guarded += t.guarded; tenancy.exempt += t.exempt; tenancy.unguarded += t.unguarded; }
  }
  return {
    routers: mounts.length,
    handlers: mounts.reduce((n, m) => n + m.handlers, 0),
    publicHandlers: mounts.reduce((n, m) => n + m.public, 0),
    routerWideAuth: mounts.filter((m) => m.routerWideAuth).length,
    authz, tenancy,
  };
}

function summarize(d: DomainDecl, ev: Evidence, rt: RuntimeSnapshot): DomainSummary {
  const rows = rowsOf(ev, d.rows);
  const controls = domainControlIds(ev, d).map((id) => controlView(ev, id));
  const protection = worst([...rows.map((r) => rowState(r.coverage)), ...controls.map(controlState)]);
  const a = adapter(d, ev, rt);
  const events = domainEvents(d, rt);
  let state = protection;
  if (d.adapter === 'rls') {
    const r = rlsView(ev, rt);
    // The rollout stage is the more specific truth while the evidence is partial.
    if (r.state === 'OBSERVING' && (protection === 'PARTIAL' || protection === 'OBSERVING')) state = 'OBSERVING';
    if (r.state === 'AT_RISK') state = 'AT_RISK';
  }

  let live: LiveState; let liveWhy: string | null = null;
  const warned = a.warnings.length > 0 || events.state === 'WARNING';
  if (warned) live = 'WARNING';
  else if (a.failed) { live = 'UNAVAILABLE'; liveWhy = UNAVAILABLE_WHY; }
  else if (a.live === 'runtime' || a.live === 'process' || events.state === 'LIVE') live = 'LIVE';
  else if (events.state === 'UNAVAILABLE') { live = 'UNAVAILABLE'; liveWhy = events.why; }
  else if (a.live === 'build-time') { live = 'NOT_APPLICABLE'; liveWhy = NO_LIVE_TEXT['build-time']; }
  else if (a.live === 'see-infrastructure') { live = 'NOT_INSTRUMENTED'; liveWhy = NO_LIVE_TEXT['see-infrastructure']; }
  else { live = 'NOT_INSTRUMENTED'; liveWhy = NO_LIVE_TEXT['not-instrumented']; }

  return {
    id: d.id, title: d.title, protects: d.protects,
    state, protection, live, liveWhy,
    rows: [...d.rows],
    controls: {
      total: controls.length,
      present: controls.filter((c) => c.status === 'PRESENT').length,
      partial: controls.filter((c) => c.status === 'PARTIAL').length,
      absent: controls.filter((c) => c.status === 'ABSENT' || c.status === 'MISSING').length,
    },
    figures: a.figures, config: a.config, warnings: a.warnings, events,
    areas: PLATFORM_AREAS.filter((ar) => areaRows(ev, ar).some((id) => d.rows.includes(id))).map((ar) => ar.id),
  };
}

function lifecycle(ev: Evidence): StageView[] {
  return SECURITY_LIFECYCLE.map((s) => {
    let ids = s.controls;
    const figures: Figure[] = [];
    if (s.id === 'controls') ids = [...ev.policy.requiredControls];
    if (s.id === 'develop') {
      const c = ev.posture.components;
      for (const [k, label] of [['routers', 'Routers'], ['prismaSections', 'Schema sections'], ['leasedWorkers', 'Background workers'], ['envVars', 'Settings']] as const) {
        if (typeof c[k] === 'number') figures.push({ key: `components.${k}`, label, value: c[k], kind: 'count', source: 'build', why: null });
      }
    }
    const controls = ids.map((id) => controlView(ev, id));
    let state: StageState;
    if (s.id === 'develop') state = 'INFO';
    else if (!controls.length) state = 'NOT_INSTRUMENTED';
    else state = worst(controls.map(controlState));
    return {
      id: s.id, title: s.title, describes: s.describes, state,
      controls: controls.map((c) => ({ id: c.id, status: c.status })),
      figures, outsideView: s.outsideView ?? null,
    };
  });
}

function eventsOverview(rt: RuntimeSnapshot): EventsOverview {
  const e = rt.events.value; const s = rt.signals.value;
  const kinds = Object.keys(EVENT_KIND_LABELS).map((k) => ({
    kind: k, label: EVENT_KIND_LABELS[k],
    count24h: e ? (e.byKind24h[k] ?? 0) : null,
    count7d: e ? (e.byKind7d[k] ?? 0) : null,
    critical24h: e ? (e.critical24hByKind[k] ?? 0) : null,
  }));
  const signals: SignalTypeView[] = SECURITY_EVENT_TYPES.map((t) => ({
    type: t.type, category: t.category, describes: t.describes, produced: t.produced,
    count24h: s ? (s.byType24h[t.type] ?? 0) : null, count7d: s ? (s.byType7d[t.type] ?? 0) : null,
  }));
  const failed = rt.events.state !== 'READ';
  return {
    state: failed ? 'UNAVAILABLE' : ((e?.critical24h ?? 0) > 0 ? 'WARNING' : 'LIVE'),
    why: failed ? (rt.events.reason ?? UNAVAILABLE_WHY) : null,
    total24h: e?.total24h ?? null, total7d: e?.total7d ?? null,
    critical24h: e?.critical24h ?? null, warning24h: e?.warning24h ?? null,
    kinds, signals,
    alerts: { dispatcherRunning: rt.process.alertDispatcherRunning, recipientConfigured: rt.process.alertRecipientConfigured },
  };
}

/** The whole Command Center in one read: posture, domains, areas, lifecycle, coverage, RLS, events. */
export async function commandCenterOverview(): Promise<CommandCenterOverview> {
  const rt = await runtimeSnapshot();
  const ev = evidence();
  const base = {
    measuredAt: rt.measuredAt,
    instance: { startedAt: rt.process.startedAt, uptimeHours: rt.process.uptimeHours },
    groups: AREA_GROUPS.map((g) => ({ ...g })),
    events: eventsOverview(rt),
  };
  if ('reason' in ev) {
    return {
      ...base, state: 'NOT_GENERATED', reason: ev.reason, generatedAt: null, posture: null,
      domains: [], areas: [], lifecycle: [], boundaries: [], rls: null, unassignedRouters: [],
    };
  }
  const domains = SECURITY_DOMAINS.map((d) => summarize(d, ev, rt));
  const areas: AreaView[] = PLATFORM_AREAS.map((a) => {
    const ids = areaRows(ev, a);
    const rows = rowsOf(ev, ids);
    return {
      id: a.id, title: a.title, group: a.group,
      state: rows.length ? worst(rows.map((r) => rowState(r.coverage))) : 'UNKNOWN',
      rows: ids,
      gaps: rows.filter((r) => r.coverage !== 'C').map(rowView),
      domains: SECURITY_DOMAINS.filter((d) => d.rows.some((id) => ids.includes(id))).map((d) => d.id),
      routers: [...a.routers],
      api: areaApi(ev, a),
      note: a.note ?? null,
    };
  });
  const assigned = new Set(PLATFORM_AREAS.flatMap((a) => a.routers));
  const controls = ev.posture.controls;
  const required = ev.policy.requiredControls;
  const byState = (s: ProtectionState) => domains.filter((d) => d.state === s).length;
  const rowsC = ev.coverage.rows.filter((r) => r.coverage === 'C').length;
  const rowsP = ev.coverage.rows.filter((r) => r.coverage === 'P').length;
  const rowsU = ev.coverage.rows.filter((r) => r.coverage === 'U').length;
  const posture: PostureView = {
    verdict: worst(ev.coverage.rows.map((r) => rowState(r.coverage))),
    boundaries: { total: ev.coverage.rows.length, C: rowsC, P: rowsP, U: rowsU },
    controls: {
      total: controls.length,
      present: controls.filter((c) => c.status === 'PRESENT').length,
      partial: controls.filter((c) => c.status === 'PARTIAL').length,
      absent: controls.filter((c) => c.status === 'ABSENT').length,
    },
    required: { total: required.length, present: required.filter((id) => controls.some((c) => c.id === id && c.status === 'PRESENT')).length },
    knownGaps: Object.entries(ev.policy.knownGaps).map(([id, text]) => ({ id, status: controlView(ev, id).status, text })),
    domains: { PROTECTED: byState('PROTECTED'), PARTIAL: byState('PARTIAL'), OBSERVING: byState('OBSERVING'), AT_RISK: byState('AT_RISK'), UNKNOWN: byState('UNKNOWN') },
    generatedAt: ev.posture.generatedAt,
    generator: ev.posture.generator,
  };
  return {
    ...base,
    state: 'READY', reason: null, generatedAt: ev.posture.generatedAt,
    posture, domains, areas,
    lifecycle: lifecycle(ev),
    boundaries: ev.coverage.rows.map(rowView),
    rls: rlsView(ev, rt),
    unassignedRouters: Object.keys(ev.coverage.routers).filter((r) => !assigned.has(r)).sort(),
  };
}

export type DomainLookup =
  | { state: 'READY'; detail: DomainDetail }
  | { state: 'UNKNOWN_DOMAIN' }
  | { state: 'NOT_GENERATED'; reason: string };

/** One domain in full: every control with its evidence, every boundary, the latest events. */
export async function commandCenterDomain(id: string): Promise<DomainLookup> {
  const d = domainById(id);
  if (!d) return { state: 'UNKNOWN_DOMAIN' };
  const ev = evidence();
  if ('reason' in ev) return { state: 'NOT_GENERATED', reason: ev.reason };
  const rt = await runtimeSnapshot();
  const summary = summarize(d, ev, rt);
  const instrumentedKinds = d.eventKinds.includes('*') ? '*' as const : d.eventKinds;
  const hasKinds = instrumentedKinds === '*' || instrumentedKinds.length > 0;
  const producedTypes = signalTypesOf(d).filter((t) => t.produced).map((t) => t.type);
  const [events, signals] = await Promise.all([
    hasKinds ? recentEvents(instrumentedKinds) : Promise.resolve(null),
    producedTypes.length ? recentSignals(d.allSignals ? '*' : producedTypes) : Promise.resolve(null),
  ]);
  return { state: 'READY', detail: {
    ...summary,
    controlList: domainControlIds(ev, d).map((cid) => controlView(ev, cid)),
    rowList: rowsOf(ev, d.rows).map(rowView),
    recentEvents: events === null
      ? { state: 'NOT_INSTRUMENTED', items: [], why: NO_LIVE_TEXT['no-events'] }
      : {
        state: events.state, why: events.state === 'READ' ? null : (events.reason ?? UNAVAILABLE_WHY),
        items: (events.value ?? []).map((x) => ({ ...x, label: EVENT_KIND_LABELS[x.kind] ?? x.kind })),
      },
    recentSignals: signals === null
      ? { state: 'NOT_INSTRUMENTED', items: [], why: NO_LIVE_TEXT['declared-not-produced'] }
      : { state: signals.state, items: signals.value ?? [], why: signals.state === 'READ' ? null : (signals.reason ?? UNAVAILABLE_WHY) },
  } };
}
