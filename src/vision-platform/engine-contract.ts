// FAMILISTA VISION — the seam between the platform and wherever inference runs
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE DECISION THIS FILE EXISTS TO MAKE REVERSIBLE
//
// Today the Vision Engine runs in this environment. Tomorrow it runs on a
// Familista Vision Hub bolted to a floodlight pylon at the side of a pitch.
// Between those two facts, nothing in the Familista UI, the Fabric events, the
// Data Vault records or the Source Core lineage may have to change — and the
// only way to guarantee that is for none of them to know which one is true.
//
// So the platform never calls the engine. It calls a `VisionEngine`, and a
// processing target decides which one answers.
//
//     Familista Vision module
//            ↓
//     VisionEngine  ← this contract
//            ↓
//     LOCAL_SERVER            VISION_HUB
//     (reads artefacts        (HTTP to the device,
//      the engine wrote)       NOT IMPLEMENTED)
//
// WHY THE HUB ADAPTER IS A REFUSAL AND NOT A SIMULATION
//
// There is no Vision Hub. A stub that returned plausible-looking device
// readings would be the single most damaging thing in this module, because
// every screen downstream would render them as measurements and nobody would
// know. `VisionHubEngine` therefore answers `NOT_IMPLEMENTED` to everything and
// says why. The day the hardware exists, this is the only file that changes.
//
// WHAT AN ENGINE OWES THE PLATFORM
//
// Sessions, and the truth about itself. It does not own club scoping, does not
// publish events and does not persist anything — those are platform concerns
// and they stay on this side of the seam, so an engine on a device at a pitch
// does not need to know what a Familista club is.

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Where inference runs for this deployment. */
export type ProcessingTarget = 'LOCAL_SERVER' | 'VISION_HUB';

/**
 * The status vocabulary, shared by every Vision surface.
 *
 * `NOT_IMPLEMENTED` and `NOT_AVAILABLE` are different answers and the
 * difference is the point: the first means nobody has built it, the second
 * means it exists and is not reachable right now. Collapsing them would tell an
 * operator to go looking for a fault in something that was never written.
 */
export type VisionStatus =
  | 'LIVE' | 'READY' | 'PROCESSING' | 'DEGRADED'
  | 'OFFLINE' | 'ERROR' | 'NOT_AVAILABLE' | 'NOT_IMPLEMENTED';

/** Why a capability is not answering. Never inferred, always stated. */
export interface VisionUnavailable {
  status: Extract<VisionStatus, 'NOT_AVAILABLE' | 'NOT_IMPLEMENTED' | 'ERROR' | 'OFFLINE'>;
  reason: string;
}

export interface EngineIdentity {
  /** Stable id for this engine deployment. */
  deviceId: string;
  /** `SOFTWARE DEVICE` today; a hardware serial when a Hub exists. */
  deviceKind: 'SOFTWARE_DEVICE' | 'VISION_HUB';
  target: ProcessingTarget;
  /** The engine's own pipeline version, as the engine reports it. */
  pipelineVersion: string | null;
  status: VisionStatus;
  reason?: string;
}

/**
 * A session artefact, exactly as the engine produced it.
 *
 * Deliberately `unknown` in shape at this boundary: the engine's schema is the
 * engine's business, and the platform's normaliser is the one place that knows
 * how to read it. A typed mirror here would be a second copy of a schema that
 * already versions itself, and the two would drift.
 */
export interface EngineSessionArtefact {
  sessionRef: string;
  schema: string;
  document: Record<string, unknown>;
  /** Side documents the engine wrote beside the main one, keyed by kind. */
  companions: Record<string, Record<string, unknown>>;
  /** Bytes on the engine's side, for the operator's benefit. */
  sizeBytes: number;
}

export interface VisionEngine {
  identify(): Promise<EngineIdentity>;
  /** Session references this engine can serve, newest first where known. */
  listSessions(): Promise<string[] | VisionUnavailable>;
  readSession(sessionRef: string): Promise<EngineSessionArtefact | VisionUnavailable>;
  /** Live host readings, or an honest absence. Never invented. */
  telemetry(): Promise<EngineTelemetry | VisionUnavailable>;
}

export interface EngineTelemetry {
  /** Readings the host can actually produce. A field absent is a field unknown. */
  cpuCores?: number;
  loadAverage1m?: number;
  memoryTotalBytes?: number;
  memoryFreeBytes?: number;
  storageTotalBytes?: number;
  storageFreeBytes?: number;
  uptimeSeconds?: number;
  /**
   * Readings a Hub would have and a server does not. Present as explicit
   * absences so a screen can say NOT AVAILABLE rather than draw a zero.
   */
  gpu: VisionUnavailable | { name: string; memoryTotalBytes?: number };
  temperatureCelsius: VisionUnavailable | number;
  batteryPercent: VisionUnavailable | number;
  cameraLink: VisionUnavailable | { connected: number };
}

export function isUnavailable(v: unknown): v is VisionUnavailable {
  return !!v && typeof v === 'object' && 'status' in (v as Record<string, unknown>)
    && 'reason' in (v as Record<string, unknown>);
}

// ── LOCAL_SERVER ─────────────────────────────────────────────────────────────

/**
 * The engine as it runs today: a process that writes session artefacts, and a
 * directory the platform reads them from.
 *
 * It reads and never writes. The engine's output is ORIGINAL EVIDENCE, and a
 * platform that can modify the evidence it cites is a platform whose citations
 * mean nothing — see the Data Vault's own rule about never overwriting an
 * original when a newer model disagrees with it.
 */
export class LocalServerEngine implements VisionEngine {
  constructor(private readonly root: string, private readonly deviceId: string) {}

  async identify(): Promise<EngineIdentity> {
    let status: VisionStatus = 'READY';
    let reason: string | undefined;
    try {
      await fs.access(this.root);
    } catch {
      status = 'NOT_AVAILABLE';
      reason = `no session store at ${path.basename(this.root)}; the engine has not `
        + 'written here, or this deployment has no engine attached';
    }
    return {
      deviceId: this.deviceId,
      deviceKind: 'SOFTWARE_DEVICE',
      target: 'LOCAL_SERVER',
      pipelineVersion: null,
      status,
      ...(reason ? { reason } : {}),
    };
  }

  async listSessions(): Promise<string[] | VisionUnavailable> {
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch (err) {
      return {
        status: 'NOT_AVAILABLE',
        reason: `session store unreadable: ${(err as Error).message}`,
      };
    }
  }

  async readSession(sessionRef: string): Promise<EngineSessionArtefact | VisionUnavailable> {
    // A session reference is an identifier, never a path. Anything that could
    // escape the store is refused before it touches the filesystem.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionRef)) {
      return { status: 'ERROR', reason: 'malformed session reference' };
    }
    const dir = path.join(this.root, sessionRef);
    try {
      const names = await fs.readdir(dir);
      const companions: Record<string, Record<string, unknown>> = {};
      let main: Record<string, unknown> | null = null;
      let sizeBytes = 0;
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const full = path.join(dir, name);
        const [raw, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
        sizeBytes += stat.size;
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (name === 'session.json') main = parsed;
        else companions[name.replace(/\.json$/, '')] = parsed;
      }
      if (!main) {
        return { status: 'ERROR', reason: `session ${sessionRef} has no session.json` };
      }
      return {
        sessionRef,
        schema: String(main.schema ?? 'unknown'),
        document: main,
        companions,
        sizeBytes,
      };
    } catch (err) {
      return { status: 'NOT_AVAILABLE', reason: `session ${sessionRef}: ${(err as Error).message}` };
    }
  }

  async telemetry(): Promise<EngineTelemetry> {
    const os = await import('node:os');
    let storageTotalBytes: number | undefined;
    let storageFreeBytes: number | undefined;
    try {
      const s = await fs.statfs(this.root);
      storageTotalBytes = Number(s.blocks) * Number(s.bsize);
      storageFreeBytes = Number(s.bavail) * Number(s.bsize);
    } catch { /* statfs is not available everywhere; absence is the answer */ }
    return {
      cpuCores: os.cpus().length,
      loadAverage1m: os.loadavg()[0],
      memoryTotalBytes: os.totalmem(),
      memoryFreeBytes: os.freemem(),
      uptimeSeconds: Math.round(os.uptime()),
      ...(storageTotalBytes !== undefined ? { storageTotalBytes } : {}),
      ...(storageFreeBytes !== undefined ? { storageFreeBytes } : {}),
      // Four readings a server genuinely does not have. Saying so is the
      // feature: a dashboard that drew 0°C and 0% battery would be describing
      // a device that does not exist.
      gpu: { status: 'NOT_AVAILABLE', reason: 'no GPU is attached to this deployment' },
      temperatureCelsius: {
        status: 'NOT_AVAILABLE',
        reason: 'host exposes no thermal sensor to this process',
      },
      batteryPercent: {
        status: 'NOT_AVAILABLE',
        reason: 'mains-powered software deployment; there is no battery',
      },
      cameraLink: {
        status: 'NOT_IMPLEMENTED',
        reason: 'live camera attachment belongs to the Vision Hub; this deployment '
          + 'processes recorded sources only',
      },
    };
  }
}

// ── VISION_HUB ───────────────────────────────────────────────────────────────

/**
 * The Familista Vision Hub, which does not exist yet.
 *
 * Every method refuses, and says the same thing: the hardware is not built.
 * This class is the proof that the seam holds — selecting it runs the whole
 * platform against a different processing target and produces NOT_IMPLEMENTED
 * everywhere a measurement would have been, rather than a plausible fiction.
 */
export class VisionHubEngine implements VisionEngine {
  private static readonly ABSENT: VisionUnavailable = {
    status: 'NOT_IMPLEMENTED',
    reason: 'the Familista Vision Hub is not built. This adapter exists so the '
      + 'platform can already address it; nothing behind it is simulated.',
  };

  constructor(private readonly endpoint: string | null, private readonly deviceId: string) {}

  async identify(): Promise<EngineIdentity> {
    return {
      deviceId: this.deviceId,
      deviceKind: 'VISION_HUB',
      target: 'VISION_HUB',
      pipelineVersion: null,
      status: 'NOT_IMPLEMENTED',
      reason: this.endpoint
        ? `configured at ${this.endpoint}, but no Vision Hub firmware exists to answer`
        : VisionHubEngine.ABSENT.reason,
    };
  }

  async listSessions(): Promise<VisionUnavailable> { return VisionHubEngine.ABSENT; }
  async readSession(): Promise<VisionUnavailable> { return VisionHubEngine.ABSENT; }
  async telemetry(): Promise<VisionUnavailable> { return VisionHubEngine.ABSENT; }
}

// ── selection ────────────────────────────────────────────────────────────────

export function configuredTarget(): ProcessingTarget {
  return process.env.FAMILISTA_VISION_TARGET === 'VISION_HUB' ? 'VISION_HUB' : 'LOCAL_SERVER';
}

export function sessionStoreRoot(): string {
  return process.env.FAMILISTA_VISION_SESSIONS
    ?? path.join(process.cwd(), 'vision-sessions');
}

let cached: { target: ProcessingTarget; engine: VisionEngine } | null = null;

/**
 * The engine this deployment talks to.
 *
 * Cached per target, so a test can flip `FAMILISTA_VISION_TARGET` and get the
 * other adapter rather than a stale one.
 */
export function visionEngine(): VisionEngine {
  const target = configuredTarget();
  if (cached && cached.target === target) return cached.engine;
  const deviceId = process.env.FAMILISTA_VISION_DEVICE_ID ?? 'familista-vision-local-1';
  const engine: VisionEngine = target === 'VISION_HUB'
    ? new VisionHubEngine(process.env.FAMILISTA_VISION_HUB_ENDPOINT ?? null, deviceId)
    : new LocalServerEngine(sessionStoreRoot(), deviceId);
  cached = { target, engine };
  return engine;
}

/** For tests that change the environment between cases. */
export function resetVisionEngine(): void { cached = null; }
