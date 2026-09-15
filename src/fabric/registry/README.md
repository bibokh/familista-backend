# Joining the Familista Data Fabric

Four calls. Nothing downstream needs editing — not the Live Data Flow page, not
the pulse service, not the routes. A module that makes these calls appears on
the board, in the catalogues and in the metrics on its own.

```ts
import {
  registerFabricSource, registerFabricEvent, registerFabricSchema, publishFabricEvent,
} from '../fabric/registry';
import { z } from 'zod';
```

## 1 · Declare the source — once, at module load

Only when you are adding a whole **platform domain**. A new feature inside an
existing domain is not a source; see *Features are not sources* below.

```ts
registerFabricSource({
  id: 'finance',                    // lower-case, dash-separated, stable forever
  name: 'Finance',                  // the lane label; also a join key, so renaming is breaking
  domain: 'commerce',
  icon: 'invoice',                  // a key in public/system/system-icons.js
  description: 'Invoices, payouts and settlement',
  category: 'commerce',
  order: 110,                       // board position; core sources use 10…100
  enabled: true,
  showInLiveDataFlow: true,         // false registers it without drawing a lane
  eventDomains: ['finance', 'invoice'],  // the event-name prefixes it owns
});
```

`eventDomains` is what routes an event to a lane. One prefix belongs to exactly
one source; claiming a prefix another source already owns is refused.

## 2 · Declare the event types — once, at module load

```ts
registerFabricEvent({
  type: 'finance.invoice.issued',   // <domain>.<entity>.<past-tense-verb>
  describes: 'An invoice was issued to a club',
  classification: 'CONFIDENTIAL',
  schemaVersion: 1,
  entityType: 'CLUB',
  exposeInLiveStream: true,
  auditRelevant: true,
});
```

The source is derived from the name's first segment, so `finance.*` lands on
Finance without being told. Register the source first.

`exposeInLiveStream: false` withholds the type from the live board **without
affecting durability** — the event is still written to the outbox and still
readable by anything with authority to read it. Use it for a type that is real
and recorded but has no business on a firehose.

## 3 · Declare the payload schema — once, at module load

```ts
registerFabricSchema({
  eventType: 'finance.invoice.issued',
  version: 1,
  describes: 'Invoice identity and amount, no line items',
  schema: z.object({
    invoiceId: z.string().uuid(),
    currency: z.string().length(3),
    amountMinor: z.number().int().nonnegative(),
  }).passthrough(),
});
```

**Versions are immutable.** A second registration for the same
`(eventType, version)` with a different schema is refused. Historical events
were written against v1 and are still in the outbox; if v1 could be edited, a
replay would validate yesterday's events against today's opinion and reject
facts that were correct when they happened. A payload change is a **new
version**: v1, v2 and v3 coexist, producers move forward when ready, consumers
keep reading the versions they understand.

Prefer `.passthrough()` for a v1 laid over a producer that already exists —
a strict object turns "somebody added a field" into "the board stopped showing
this event".

Declaring a schema is optional. `validateEventPayload` reports an undeclared
shape as `validated: false`, not as a failure.

## 4 · Publish — wherever the thing happens

```ts
await publishFabricEvent({
  eventType: 'finance.invoice.issued',
  clubId: club.id,
  actorUserId: actor.userId,
  subjectType: 'CLUB',
  subjectId: club.id,
  sourceType: 'SERVICE',
  payload: { invoiceId, currency, amountMinor },
});
```

Or `publishFabricEventDetached(...)` from a request path that must not wait on
the outbox write. It consumes its own rejection, which matters: an unhandled
rejection from a fire-and-forget publish terminates the process on Node 15+.

### What publishing does, and what it will not do to you

| Situation | What happens |
| --- | --- |
| Name not registered | Counted, logged once per name (ERROR outside production, WARN in it). **Published anyway.** |
| Payload fails its schema | Counted, logged with issue *paths* and never values. Published, marked `schemaInvalid`, **withheld from the live board**. |
| `exposeInLiveStream: false` | Published and stored; the board does not draw it. |
| Transport append fails | `stored: false` in the result; logged. |

`publishFabricEvent` **resolves** in all four cases. It does not throw, because
a module calls it from inside a business operation and an observability problem
must never fail a user's action. A caller that would rather fail than publish
something it cannot stand behind passes `{ strict: true }`.

The one thing that still rejects is a malformed **envelope** — a missing type, a
nonsensical time. That is a producer calling the function wrong, and it surfaces
in development long before a user sees it.

## Features are not sources

Adding `user.preferences.updated` to Users is a **new event on an existing
source**. Register the event; do not register a source. It appears under the
Users lane because `user` is one of Users' `eventDomains`.

A new source is for a new platform domain — Finance, Scouting, Ticketing. The
distinction comes from what you register, never from how you name the event.

## What the board and the catalogues do with all this

- `GET /api/v1/system/fabric/sources` — every registered source, its metadata,
  how many event types it owns, and this instance's per-lane counts.
  `?visible=1` narrows to the lanes the board draws.
- `GET /api/v1/system/fabric/events/catalog` — every registered type, what it is
  about, how sensitive it is, which versions have declared schemas.
  `?source=finance` narrows to one domain.
- `GET /api/v1/system/fabric/schemas` — which shapes are declared, by version.

All three are platform-owner only, through the same `assertPlatformOwner` guard
the rest of SYSTEM uses. All three return **metadata** — never a payload, never
a schema's field list, never anything a user typed.

## What never reaches the monitoring view

The Live Data Flow board receives `PulseFrame`s, built by `project()` in
`pulse/pulse.service.ts` from an **allow-list** of envelope fields. It never
touches `payload` and never touches `metadata` — not redacted, not summarised,
not key-counted. The one exception is `payload.changedFields`, read by name,
strings only, capped at 24 entries of 40 characters: a date of birth's *name* is
not a date of birth.

Personal identifiers are withheld even from the platform owner. `subjectId`
travels only for subject kinds in `SAFE_SUBJECT_IDS` — clubs, teams,
competitions, fixtures, models. A `USER`, `PLAYER` or `MEDICAL_RECORD` id is
never put on the stream, because "the owner could look it up anyway" is an
argument for using the screen that has an access log, not for putting personal
identifiers into a firehose that has none.

This matters more here than in most platforms: Familista holds records about
children.

## Nothing here is persisted

These are platform contracts, not data. They are true because this build says
so, and a row in a table saying otherwise would be a second, disagreeing answer.
Registration happens once at module load, never per request. There is no
migration, and adding a source or an event type needs none.
