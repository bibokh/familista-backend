# Familista — Architecture Contract v1.0

The boundaries below are permanent. Code is what enforces them; this document is
what they mean. Where the two disagree, the code is the truth and this file is
the bug.

Every claim here names the file that keeps it, so a reader can check rather than
trust.

---

## 1. SYSTEM and CLUBS are two products

| | SYSTEM / FOS | CLUBS |
|---|---|---|
| Audience | the platform owner | club staff |
| Contains | the operation of Familista itself | football operations |
| Route | `/api/v1/system/*` | everything else |
| Declared in | `src/platform/system-modules.ts` → `SYSTEM_MODULES` | → `CLUB_MODULES` |

Platform-owner infrastructure never appears inside a club workspace, and club
operational modules never appear inside SYSTEM. The two lists are asserted to be
disjoint (`tests/platform-architecture.unit.test.ts`).

**No invented metrics.** Every SYSTEM module declares `readiness`: `LIVE`,
`PARTIAL` or `NOT_INSTRUMENTED`, and what backs it. A metric nothing measures is
returned as `{ value: null, unavailable: "<why>" }` and rendered as an explicit
empty state (`src/platform/system.service.ts`). A dashboard that lies is worse
than a blank one, because somebody will act on it.

---

## 2. Identity

A **person** is one account with one password. A person does not belong to a
club by existing.

```
User  →  Membership(club, team, role, status)  →  what they may do
```

The same account travels: viewer → invited → coach at Club A → viewer again →
coach at Club B. No second account is ever created, and no password is ever
changed by a club.

### The four access levels — `src/platform/access-levels.ts`

| Level | Comes from | Reaches |
|---|---|---|
| `PLATFORM_OWNER` | `UserRole.SUPER_ADMIN` or an active `PlatformAdmin` | the platform, under governance |
| `CLUB_OWNER` | an active `CLUB_OWNER` membership | that club, all its teams |
| `CLUB_STAFF` | any other active membership | the teams that membership names |
| `VIEWER` | no active membership | public data, in any club |

**Platform ownership is not club ownership**, in either direction, and never
becomes one by accident: they are separate grants, separately audited.

---

## 3. Authorization

```
WHO  +  WHERE  +  WHAT RESOURCE  +  ACTION  +  CLASSIFICATION  +  JURISDICTION
```

- **WHO / WHERE** — `src/identity/team-access.service.ts` (`canView`,
  `canViewPrivate`, `canManage`) and `src/middleware/tenant-guard.middleware.ts`.
- **Applied to routes** — `guardTeamScopedRouter` in
  `src/middleware/team-scope.middleware.ts`, installed via `router.param` because
  `req.params` is empty before a route matches.
- **WHAT** — `src/platform/data-classification.ts`.
- **JURISDICTION** — `src/platform/governance/policy.ts`.

Enforcement is server-side. UI hiding is a courtesy, never a control. A team id,
player id, match id or club id supplied by a browser is a question, never an
answer.

### Data classification

| Class | Examples | Who |
|---|---|---|
| `PUBLIC` | results, tables, fixtures, club identity, published profiles | anyone signed in |
| `INTERNAL` | squad, training, attendance, lineups, tactics, preparation, video | the team's own people |
| `CONFIDENTIAL` | contracts, salaries, valuations, staff matters | club owner and those trusted with them |
| `RESTRICTED` | medical detail, a child's private data, security material | above every level's ceiling; explicit governance only |

An unregistered resource is `INTERNAL`. Lookups fail towards privacy.

---

## 4. Membership lifecycle

- **Invite** — `src/identity/invitation.service.ts`. 32 random bytes; only the
  SHA-256 is stored; the token is returned once, to be mailed. Seven-day expiry,
  single use, resend mints a new token and retires the old one.
  **No password field exists anywhere in this path.**
- **Accept** — the signed-in account's email must be the invited one. Membership
  is created by the existing `grantMembership`, so audit and uniqueness are the
  club's usual ones.
- **Suspend / reactivate / change team / change role** —
  `src/services/membership.service.ts`, each audited.
- **Final owner protection** — `assertNotLastOwner` refuses to revoke, suspend or
  demote a club's last active `CLUB_OWNER`.
- **Leaving ends the session, not the account** — `endClubSession` clears a stale
  `currentClub`/`currentTeam`, deletes refresh tokens and bumps
  `User.tokenVersion`; `authenticate` refuses an access token minted before the
  bump. The password is untouched.

---

## 5. Events, audit and analytics

`src/platform/events/` — contracts, then a bus.

Two streams that are never one table:

- **AUDIT** — who changed what. Attributable, kept, never sampled.
- **ANALYTICS** — what is being used. Aggregate, may be sampled, may expire.

Every event carries `version`, `environment`, `correlationId`, an actor (`USER`,
`PLATFORM_OWNER`, `SYSTEM`, `AI_AGENT`) and a scope. Publishing never fails the
caller, and a payload carrying a credential-shaped key is refused before any
subscriber sees it. The transport is in-process today and may become a queue
without a domain service changing.

---

## 6. Intelligence

```
product module → AI Gateway → model router → provider
```

Never product module → provider SDK. `src/platform/intelligence/gateway.ts`
centralises model selection, provider routing, jurisdiction restrictions, usage
and fallback. An unconfigured platform **refuses** rather than erroring, and
never silently substitutes a model a jurisdiction forbids.

### Agents — `src/platform/intelligence/agents.ts`

```
agent → tool registry → authorization → governance → domain service → audit
```

There is no path from an agent to the database. An agent is an identity with a
status, an environment, a scope, a tool list and an autonomy level:

| Level | Name | May |
|---|---|---|
| 0 | OBSERVE | read |
| 1 | RECOMMEND | recommend |
| 2 | PREPARE | draft, committing nothing |
| 3 | ACT | perform allowlisted low-risk actions |
| 4 | APPROVE | prepare; a person approves |
| 5 | PROTECTED | never autonomous |

`deleteClub`, `changeClubOwner`, `deleteUser`, `changeGlobalPermissions` are
`PROTECTED`: refused at every autonomy level, by name.

**Kill switch** — `engageKillSwitch(reason)` stops autonomous *actions*.
Reading and recommending continue and Familista stays up; a switch that takes
the platform down is a switch nobody uses.

**Super AI** is an orchestration layer above specialists, not an unrestricted
agent. It passes through the same tools, authorization, governance, approvals
and audit as any other agent.

---

## 7. Governance

`src/platform/governance/policy.ts`. One decision point, not scattered country
checks:

```
actor + jurisdiction + resource + classification + action + minor? + AI?
  → ALLOW | DENY | REQUIRE_APPROVAL | NOT_VALIDATED
```

**Familista is not automatically compliant anywhere.** It is compliance-*ready*:
jurisdiction packs are versioned data, and a jurisdiction with no pack returns
`NOT_VALIDATED` — never `ALLOW`. Silence is not permission.

Children's data is first-class: a minor's data under a pack requiring guardian
consent is denied without a recorded consent.

---

## 8. Innovation, flags and experiments

Environments — `src/platform/environment.ts`: `PRODUCTION`, `STAGING`, `LAB`,
`PREVIEW`. Resolved from the process, never from a request. An unlabelled
process is `PREVIEW`, never `LAB`.

**Experimental is hidden by default.** `src/platform/innovation/flags.ts`
returns `false` for an unknown flag, a disabled flag, or a flag whose
environments exclude this one. Audiences: `OWNER_ONLY`, `INTERNAL`,
`SELECTED_USERS`, `SELECTED_CLUBS`, `PERCENTAGE_ROLLOUT`, `PUBLIC`. There is no
path where forgetting something turns a feature on.

`src/platform/innovation/experiments.ts` keeps hypothesis, metrics, model
versions, decision and status through a fixed transition table. A rejected
experiment's history survives the feature's removal.

---

## 9. Data continuity

Separate lifetimes, separate stores: live data · version history · audit ·
events · analytics · media · AI history · experiment history · release history ·
backup. Retention is configurable by type, classification, jurisdiction,
minority, legal basis and consent — never "keep everything forever".

A backup whose restore has never been tested is not a backup. Restore testing is
never destructive against production.

---

## 10. Migration principles

Additive wherever possible · backwards compatible · reversible where practical ·
safe against existing rows · tested · explicit.

Never: drop a production column · destructively rename · remove legacy
compatibility before its replacement is proven · change `User.clubId`
destructively · mass-change existing users · bulk-convert demo accounts · assign
a club owner by guessing.

---

## 11. Modular monolith

Clear domain boundaries and event contracts inside one deployable. Microservices
are an extraction to be earned later — analytics, notifications, AI runtime,
video, event processing are the candidates — and the product contracts do not
change when one is extracted.

---

## 12. Human control

AI executes. Familista is accountable. The platform owner is the human control
plane. Critical and high-impact actions keep an explicit human in them, whatever
the platform's staffing becomes.
