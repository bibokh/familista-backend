// src/gps/gps-status.service.ts
// Phase 14 — GPS Fleet Status Service
// Queries GpsDevice table for the club's tracker fleet.
// Adds deterministic staleness classification using lastSeenAt threshold.
// Pure computation function (computeDeviceStatus) is exported for unit testing.

import { prisma } from '../config/database';

// ── Types ──────────────────────────────────────────────────────────────────────

export type DeviceStatusLabel = 'online' | 'stale' | 'offline';

export interface DeviceFleetItem {
  id:            string;
  serialNumber:  string;
  firmware:      string;
  batteryLevel:  number;
  signalQuality: number;
  lastSeenAt:    string | null;   // ISO string or null
  isOnline:      boolean;
  status:        DeviceStatusLabel;
  player:        { id: string; name: string; position: string | null } | null;
}

export interface GpsFleetStatus {
  clubId:  string;
  total:   number;
  online:  number;
  stale:   number;
  offline: number;
  devices: DeviceFleetItem[];
}

// ── Staleness threshold ────────────────────────────────────────────────────────
// A device that has isOnline=true but whose lastSeenAt is older than this
// threshold is classified as 'stale' — the heartbeat flag was never cleared
// because there is no background sweep.

export const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ── Pure deterministic classifier ─────────────────────────────────────────────
// Exported so unit tests can verify it without DB access.
//
// Rules:
//   isOnline=false                           → 'offline'
//   isOnline=true  + lastSeenAt=null         → 'stale'  (inconsistent state)
//   isOnline=true  + lastSeenAt > threshold  → 'stale'
//   isOnline=true  + lastSeenAt ≤ threshold  → 'online'

export function computeDeviceStatus(
  lastSeenAt: Date | null,
  isOnline:   boolean,
  nowMs:      number = Date.now(),
): DeviceStatusLabel {
  if (!isOnline)           return 'offline';
  if (lastSeenAt === null) return 'stale';
  const ageMs = nowMs - lastSeenAt.getTime();
  return ageMs > STALE_THRESHOLD_MS ? 'stale' : 'online';
}

// ── DB query ───────────────────────────────────────────────────────────────────

export async function getFleetStatus(clubId: string): Promise<GpsFleetStatus> {
  const rows = await prisma.gpsDevice.findMany({
    where: { clubId },
    select: {
      id:            true,
      serialNumber:  true,
      firmware:      true,
      batteryLevel:  true,
      signalQuality: true,
      isOnline:      true,
      lastSeenAt:    true,
      player: {
        select: { id: true, firstName: true, lastName: true, position: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const nowMs = Date.now();
  const devices: DeviceFleetItem[] = rows.map(r => {
    const status = computeDeviceStatus(r.lastSeenAt, r.isOnline, nowMs);
    return {
      id:            r.id,
      serialNumber:  r.serialNumber,
      firmware:      r.firmware,
      batteryLevel:  r.batteryLevel,
      signalQuality: r.signalQuality,
      lastSeenAt:    r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
      isOnline:      r.isOnline,
      status,
      player:        r.player
        ? {
            id:       r.player.id,
            name:     `${r.player.firstName} ${r.player.lastName}`.trim(),
            position: r.player.position ?? null,
          }
        : null,
    };
  });

  const online  = devices.filter(d => d.status === 'online').length;
  const stale   = devices.filter(d => d.status === 'stale').length;
  const offline = devices.filter(d => d.status === 'offline').length;

  return { clubId, total: devices.length, online, stale, offline, devices };
}
