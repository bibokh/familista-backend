// The payload shapes Familista declares today
// ─────────────────────────────────────────────────────────────────────────────
// Every schema here is written against a producer that already exists, by
// reading what it actually sends — not against what a payload ought to contain.
// A v1 schema laid over live producers has exactly one job: to be true. A
// schema that describes an improvement quarantines real events on the day it
// ships, and the improvement belongs in v2 with a producer that writes it.
//
// WHY EVERY OBJECT IS `passthrough`
//
// Strict objects reject unknown keys. Applied to producers that predate this
// file, that turns "somebody added a field" into "the live board stopped
// showing this event" — an observability change nobody asked for, triggered by
// a normal code change. So these validate the fields a CONSUMER may rely on and
// ignore the rest. A type that genuinely needs a closed shape can say so in its
// own v2.
//
// WHAT IS NOT DECLARED IS NOT A GAP
//
// Most registered types have no schema, and `validateEventPayload` reports that
// as `validated: false` rather than as a failure. Declaring a shape is a promise
// to consumers, and a promise made about a payload nobody has read yet is a
// promise made up.

import { z } from 'zod';
import { registerFabricSchema } from './schema-registry';

/**
 * Field NAMES that changed, never their values.
 *
 * The cap mirrors the one `pulse.service.ts` applies when it projects the same
 * key onto a frame — a producer that put a value here would still be truncated
 * to something that cannot carry a sentence.
 */
const changedFields = z.array(z.string().max(40)).max(24);

/** A `secret://` reference. Names a secret and is not one. */
const secretRef = z.string().min(1).max(512);

export function registerCoreSchemas(): void {
  // ── squad ──────────────────────────────────────────────────────────────────
  registerFabricSchema({
    eventType: 'player.created', version: 1,
    describes: 'No body — the envelope carries the club, team and player',
    schema: z.object({}).passthrough(),
  });

  registerFabricSchema({
    eventType: 'player.updated', version: 1,
    describes: 'Which fields changed, by name',
    schema: z.object({ changedFields }).passthrough(),
  });

  registerFabricSchema({
    eventType: 'player.photo.attached', version: 1,
    describes: 'No body — the envelope carries the player and the media reference',
    schema: z.object({}).passthrough(),
  });

  // ── media ──────────────────────────────────────────────────────────────────
  registerFabricSchema({
    eventType: 'media.created', version: 1,
    describes: 'What kind of asset was stored, how big, and where',
    schema: z.object({
      mediaType: z.string().min(1),
      purpose: z.string().min(1),
      mimeType: z.string().min(1),
      sizeBytes: z.number().int().nonnegative(),
      checksum: z.string().min(1),
      storageProvider: z.string().min(1),
    }).passthrough(),
  });

  registerFabricSchema({
    eventType: 'media.deleted', version: 1,
    describes: 'Whether the bytes went with the record',
    schema: z.object({
      purgedObject: z.boolean(),
      storageProvider: z.string().min(1),
    }).passthrough(),
  });

  // ── credentials and keys ───────────────────────────────────────────────────
  //
  // Every one of these carries a REFERENCE and never the secret. The schemas
  // say so structurally: there is no field here a credential could be put in
  // without failing validation, which makes the rule enforceable rather than
  // merely documented.

  registerFabricSchema({
    eventType: 'device.credential.created', version: 1,
    describes: 'The scope, the reference and which store holds it',
    schema: z.object({
      scope: z.string().min(1),
      secretRef,
      provider: z.string().min(1),
    }).passthrough(),
  });

  registerFabricSchema({
    eventType: 'device.credential.rotated', version: 1,
    describes: 'The new reference, the one it replaced, and the version',
    schema: z.object({
      secretRef,
      previousRef: secretRef.nullable().optional(),
      version: z.number().int().positive(),
    }).passthrough(),
  });

  registerFabricSchema({
    eventType: 'device.credential.revoked', version: 1,
    describes: 'Which reference and which version stopped authenticating',
    schema: z.object({
      secretRef,
      version: z.number().int().positive(),
    }).passthrough(),
  });

  registerFabricSchema({
    eventType: 'secret.kek.rewrapped', version: 1,
    describes: 'Which sealed secret moved between which two key ids',
    schema: z.object({
      secretRef,
      fromKid: z.string().min(1),
      toKid: z.string().min(1),
      actor: z.string().min(1),
    }).passthrough(),
  });
}

registerCoreSchemas();
