// Devices and their telemetry, as a Data Fabric producer
// ─────────────────────────────────────────────────────────────────────────────
// Four names that shipped with the taxonomy and never had a producer, and four
// flows that have been writing rows the whole time: a device is enrolled to a
// club, opens a session, closes it, and pushes batches of sensor packets in
// between. The Full Coverage & Integrity Audit found all four registered,
// exposed on the board and silent.
//
// WHY THIS IS A FILE OF ITS OWN AND NOT PART OF `system.producer.ts`
//
// Both belong to the `system` SOURCE — the registry maps the `device` and
// `telemetry` domains onto it, and `device.credential.*` already publishes
// there from `fabric/secrets/`. What they do not share is a payload shape.
// Every `system.*` schema is built from one `component` enum naming which part
// of the platform it is about, and a device is not a part of the platform: it
// is a thing in a bag on a touchline. Widening that enum to fit would loosen
// the v1 contract of nine existing types to accommodate four new ones.
//
// WHAT NEVER TRAVELS
//
// A device row holds an HMAC secret, and a session row holds a server-issued
// session key. Neither is on any event here, and neither can be: every helper
// takes typed parameters and builds its own payload, so there is no call site
// at which a caller could hand this module a credential.
//
// Nor does the SERIAL travel. A serial is the lookup key an HMAC verification
// is keyed by — it is not itself a secret, but it is half of a pair and the
// board has no use for it. Neither do `notes` or `metadata`, which are free
// text and an arbitrary JSON bag that a firmware team can put anything into.
//
// `DEVICE` is not a safe subject kind, so `project()` withholds the device id
// from the frame as well. What an operator sees is that a device of some model
// joined, left or sent data, in which club.
//
// ONE EVENT PER BATCH, NEVER PER PACKET
//
// `telemetry.batch.received` is the one name here with a flood risk behind it:
// a 100 Hz IMU burst is a hundred packets a second, and the ingest path already
// fans out one summary per batch rather than one per packet for exactly that
// reason. This follows the same rule — one event per `ingestBatch` call,
// carrying a count and the kinds, never a packet and never a payload.

import { z } from 'zod';
import { registerFabricSchema } from '../registry/schema-registry';
import { publishFabricEventDetached } from '../registry/publisher';

/** The source every event in this file belongs to. `device` and `telemetry` map to it. */
export const DEVICES_SOURCE_ID = 'system';

/** A hardware model name, as the device declared it. Bounded, never free text. */
const model = z.string().min(1).max(48).nullable();

/** A device status, as the platform's own column records it. `REGISTERED`, … */
const statusToken = z.string().min(1).max(32);

/** What a session was opened against, without naming which one. */
const attachment = z.enum(['MATCH', 'TRAINING', 'NONE']);

/** Sensor packet kinds, as tokens. The `SensorPacketKind` enum, never a payload. */
const kinds = z.array(z.string().min(1).max(32)).min(1).max(12);

export function registerDevicesProducer(): void {
  // None of the four is registered here — all four are in `event-taxonomy.ts`,
  // and `telemetry.batch.received` additionally carries the `SENSOR_PACKET`
  // legacy mapping, which is the reason it was registered there and must stay.
  // Only their payload shapes are declared, because this is now the file that
  // builds them.

  registerFabricSchema({
    eventType: 'device.registered', version: 1,
    describes: 'Which model was enrolled and in what state. Never the serial or the secret',
    schema: z.object({
      model,
      status: statusToken,
      /** Whether the credential reached the secret store, or fell back to the column. */
      credentialStored: z.boolean(),
      /** Whether it was enrolled against a squad, not which one. */
      teamScoped: z.boolean(),
    }).strict(),
  });

  registerFabricSchema({
    eventType: 'device.connected', version: 1,
    describes: 'That a capture session opened, and what kind of thing it is attached to',
    schema: z.object({
      model,
      attachedTo: attachment,
      firmwareDeclared: z.boolean(),
      teamScoped: z.boolean(),
    }).strict(),
  });

  registerFabricSchema({
    eventType: 'device.disconnected', version: 1,
    // A duration is the length of a training session or a match, both of which
    // are already operational facts the platform records openly.
    describes: 'That a capture session closed, and how long it ran',
    schema: z.object({
      model,
      attachedTo: attachment,
      durationSeconds: z.number().int().min(0).max(86_400).nullable(),
    }).strict(),
  });

  registerFabricSchema({
    eventType: 'telemetry.batch.received', version: 1,
    // A COUNT and the KINDS. Never a packet, never a payload, never a
    // signature. A sensor payload is a person's heart rate and position on a
    // pitch, and on an academy squad that person is a child.
    describes: 'How many samples arrived in one batch and of which kinds. Never a sample',
    schema: z.object({
      accepted: z.number().int().min(0).max(500),
      kinds,
      attachedTo: attachment,
    }).strict(),
  });
}

registerDevicesProducer();

// ── the helpers the device services call ─────────────────────────────────────

/** Which club, and who asked. Common to every helper below. */
export interface DeviceContext {
  clubId: string;
  teamId?: string | null;
  /** The device or session row. Withheld from the frame — `DEVICE` is not a safe kind. */
  deviceId: string;
  actorUserId?: string | null;
}

/**
 * `DEVICE` for all four.
 *
 * A capture session has no subject kind of its own and does not need one: the
 * envelope's subject is the hardware, and `subjectId` carries whichever row the
 * event is really about — the device for an enrolment, the session for the
 * three that follow. `DEVICE` is not in `SAFE_SUBJECT_IDS`, so `project()`
 * withholds that id from the board either way, and a consumer reading the
 * outbox has the type name to tell which of the two it is holding.
 */
function publish(
  eventType: string,
  ctx: DeviceContext,
  payload: Record<string, unknown>,
): void {
  publishFabricEventDetached({
    eventType,
    clubId: ctx.clubId,
    teamId: ctx.teamId ?? null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'DEVICE',
    subjectId: ctx.deviceId,
    // `DEVICE`, and not `USER`, even though a person pressed the button:
    // `sourceType` is what produced the data, and every one of these is about
    // hardware. The person who did it is on `actorUserId` where there is one.
    sourceType: 'DEVICE',
    payload,
  });
}

/** Which of the three a session is attached to. `NONE` when it is free-standing. */
export function attachmentOf(matchId: string | null, trainingSessionId: string | null): 'MATCH' | 'TRAINING' | 'NONE' {
  if (matchId) return 'MATCH';
  if (trainingSessionId) return 'TRAINING';
  return 'NONE';
}

/** A device was enrolled to a club. Published after the row exists. */
export function publishDeviceRegistered(
  ctx: DeviceContext,
  modelName: string | null,
  status: string,
  credentialStored: boolean,
): void {
  publish('device.registered', ctx, {
    model: modelName ? String(modelName).slice(0, 48) : null,
    status: String(status).slice(0, 32),
    credentialStored: !!credentialStored,
    teamScoped: !!ctx.teamId,
  });
}

/** A device opened a capture session. Published after the row exists. */
export function publishDeviceConnected(
  ctx: DeviceContext,
  modelName: string | null,
  attachedTo: 'MATCH' | 'TRAINING' | 'NONE',
  firmwareDeclared: boolean,
): void {
  publish('device.connected', ctx, {
    model: modelName ? String(modelName).slice(0, 48) : null,
    attachedTo,
    firmwareDeclared: !!firmwareDeclared,
    teamScoped: !!ctx.teamId,
  });
}

/**
 * A device's capture session ended.
 *
 * Not published when the session was already closed: `closeSession` returns the
 * existing row untouched in that case, and a second close is not a second
 * disconnection.
 */
export function publishDeviceDisconnected(
  ctx: DeviceContext,
  modelName: string | null,
  attachedTo: 'MATCH' | 'TRAINING' | 'NONE',
  startedAt: Date | null,
  endedAt: Date | null,
): void {
  const seconds = startedAt && endedAt
    ? Math.max(0, Math.min(86_400, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)))
    : null;
  publish('device.disconnected', ctx, {
    model: modelName ? String(modelName).slice(0, 48) : null,
    attachedTo,
    durationSeconds: Number.isFinite(seconds as number) ? seconds : null,
  });
}

/**
 * A batch of sensor samples was stored.
 *
 * ONE call per batch. The ingest path caps a batch at 500 packets and refuses
 * an empty one, so this is bounded by construction on both sides.
 */
export function publishTelemetryBatchReceived(
  ctx: DeviceContext,
  accepted: number,
  packetKinds: readonly string[],
  attachedTo: 'MATCH' | 'TRAINING' | 'NONE',
): void {
  const distinct = [...new Set(packetKinds.map((k) => String(k).slice(0, 32)).filter(Boolean))].slice(0, 12);
  if (!distinct.length) return;
  publish('telemetry.batch.received', ctx, {
    accepted: Math.max(0, Math.min(500, Math.trunc(accepted))),
    kinds: distinct,
    attachedTo,
  });
}
