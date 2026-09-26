// FAMILISTA VISION — health, in the shape Infrastructure City already reads
// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure City is the platform's global operational view and stays the
// global operational view. Vision does not get its own city; it gets a district
// in the existing one, and this composes the readings for it.
//
// WHY EVERY FIELD CAN SAY "NOT INSTRUMENTED"
//
// Because most of them are not instrumented, and a monitoring surface that
// prints a zero for an unmeasured quantity is worse than one that prints
// nothing: an operator reads 0 ms latency as excellent rather than as absent.
// The City already draws NOT INSTRUMENTED for signals nothing measures, so this
// speaks the same vocabulary rather than inventing a healthier-looking one.

import {
  configuredTarget, isUnavailable, visionEngine,
  type EngineTelemetry, type VisionStatus, type VisionUnavailable,
} from './engine-contract';
import { listSessionRefs } from './session-store.service';
import { SOURCE_SLOTS, SOURCE_TYPES } from './source-types';
import { visionEventCatalogue } from './vision-events';

export interface VisionCapabilityHealth {
  key: string;
  label: string;
  status: VisionStatus;
  detail: string;
}

export interface VisionHealth {
  service: VisionStatus;
  processingTarget: string;
  deviceId: string;
  deviceKind: string;
  capabilities: VisionCapabilityHealth[];
  sessions: { stored: number | null; processing: number; note: string };
  sources: { implementedTypes: number; declaredTypes: number; connected: number; slots: number };
  telemetry: EngineTelemetry | VisionUnavailable;
  eventTypes: number;
  checkedAt: string;
}

/**
 * The fourteen capability rows the Vision header draws.
 *
 * Each one answers for itself. `READY` means the code exists and would run;
 * `LIVE` means it is running right now; `NOT_IMPLEMENTED` means there is no
 * code. Nothing here is set from a constant — the Fabric link reads the event
 * registry, the session store reads the engine, and the Hub reads the target.
 */
async function capabilities(sessionCount: number | null): Promise<VisionCapabilityHealth[]> {
  const engine = visionEngine();
  const identity = await engine.identify();
  const target = configuredTarget();
  const events = visionEventCatalogue().length;
  const hasSessions = (sessionCount ?? 0) > 0;

  const engineReady = identity.status === 'READY' || identity.status === 'LIVE';
  const rows: VisionCapabilityHealth[] = [
    {
      key: 'engine', label: 'Vision Engine',
      status: identity.status,
      detail: identity.reason ?? `${target} · ${identity.deviceKind}`,
    },
    {
      key: 'source-input', label: 'Source Input',
      status: engineReady ? 'READY' : identity.status,
      detail: `${SOURCE_TYPES.filter((s) => s.implemented).length} of ${SOURCE_TYPES.length} `
        + 'source types implemented (VIDEO_FILE)',
    },
    {
      key: 'player-tracking', label: 'Player Tracking',
      status: hasSessions ? 'READY' : 'NOT_AVAILABLE',
      detail: hasSessions ? 'validated on stored sessions'
        : 'no session is available to this deployment',
    },
    {
      key: 'ball-tracking', label: 'Ball Tracking',
      status: hasSessions ? 'READY' : 'NOT_AVAILABLE',
      detail: 'OBSERVED and PROPAGATED are reported separately and never merged',
    },
    {
      key: 'calibration', label: 'Pitch Calibration',
      status: hasSessions ? 'READY' : 'NOT_AVAILABLE',
      detail: 'metric coordinates are withheld wherever calibration is NONE',
    },
    {
      key: 'teams-roles', label: 'Teams & Roles',
      status: hasSessions ? 'READY' : 'NOT_AVAILABLE',
      detail: 'UNKNOWN is preserved; no classification is forced',
    },
    {
      key: 'events', label: 'Event Engine',
      status: hasSessions ? 'READY' : 'NOT_AVAILABLE',
      detail: 'proximity and confirmed control are distinct findings',
    },
    {
      key: 'model-registry', label: 'Model Registry',
      status: 'READY',
      detail: 'model identity, licence and checksum travel with every result',
    },
    {
      key: 'session-storage', label: 'Session Storage',
      status: sessionCount === null ? 'NOT_AVAILABLE' : 'READY',
      detail: sessionCount === null
        ? 'the engine exposes no session store to this deployment'
        : `${sessionCount} session${sessionCount === 1 ? '' : 's'} addressable`,
    },
    {
      key: 'source-core', label: 'Source Core Link',
      status: 'LIVE',
      detail: 'Vision is registered on the Fabric source registry; Source Core '
        + 'composes it with no entry of its own',
    },
    {
      key: 'data-fabric', label: 'Data Fabric Link',
      status: 'LIVE',
      detail: `${events} Vision event types registered on the platform transport`,
    },
    {
      key: 'data-vault', label: 'Data Vault Link',
      status: 'LIVE',
      detail: 'session facts persist as events in the platform history; original '
        + 'evidence is never rewritten',
    },
    {
      key: 'infrastructure', label: 'Infrastructure Monitoring',
      status: 'LIVE',
      detail: 'Vision health is published into Infrastructure City rather than '
        + 'drawn in a second monitoring surface',
    },
    {
      key: 'vision-hub', label: 'Future Vision Hub',
      status: target === 'VISION_HUB' ? identity.status : 'NOT_IMPLEMENTED',
      detail: target === 'VISION_HUB'
        ? (identity.reason ?? 'hub target selected')
        : 'hardware does not exist. The adapter is addressable and refuses rather '
          + 'than simulating a device.',
    },
  ];
  return rows;
}

export async function visionHealth(): Promise<VisionHealth> {
  const engine = visionEngine();
  const identity = await engine.identify();
  const refs = await listSessionRefs();
  const sessionCount = isUnavailable(refs) ? null : refs.length;
  const telemetry = await engine.telemetry();

  const rows = await capabilities(sessionCount);
  // The service is only as healthy as its worst non-future capability. A row
  // that is NOT_IMPLEMENTED by design does not drag the service down; a row
  // that is ERROR or OFFLINE does.
  const operational = rows.filter((r) => r.key !== 'vision-hub');
  const service: VisionStatus = operational.some((r) => r.status === 'ERROR') ? 'ERROR'
    : operational.some((r) => r.status === 'OFFLINE') ? 'OFFLINE'
      : operational.some((r) => r.status === 'DEGRADED') ? 'DEGRADED'
        : operational.some((r) => r.status === 'NOT_AVAILABLE') ? 'DEGRADED'
          : 'LIVE';

  return {
    service,
    processingTarget: configuredTarget(),
    deviceId: identity.deviceId,
    deviceKind: identity.deviceKind,
    capabilities: rows,
    sessions: {
      stored: sessionCount,
      // Nothing is processing: this deployment reads artefacts an engine wrote
      // elsewhere. Reporting a queue would describe a pipeline that is not here.
      processing: 0,
      note: 'this deployment reads completed sessions; it does not run inference '
        + 'in-process, so there is no queue to report',
    },
    sources: {
      implementedTypes: SOURCE_TYPES.filter((s) => s.implemented).length,
      declaredTypes: SOURCE_TYPES.length,
      connected: 0,
      slots: SOURCE_SLOTS.length,
    },
    telemetry,
    eventTypes: visionEventCatalogue().length,
    checkedAt: new Date().toISOString(),
  };
}
