# Releasing the Club Design Studio to a club (M8a)

The studio is **off for every club and every plan** (`club_design_studio`, builtin flag `defaultEnabled: false`). The
Platform Owner releases it to invited clubs one at a time, from the Owner's Design Studio:

**Design Studio → Club releases** (the side rail), or `GET`/`PUT /api/v1/system/product-design/rollout[/:clubId]`.

## The five settings

| Key | What it controls | Off by default? |
|---|---|---|
| `club_design_studio` | The studio itself: every club route answers `DESIGN_STUDIO_NOT_ENABLED` without it | **Yes**, for every club and plan |
| `club_design_team_kit` | Rosters, collections and the order sheet | No: on wherever the studio is |
| `club_design_brand_kit` | Club colours and logos | No |
| `club_design_manufacturing` | Requests for quotation and orders (owner-brokered) | No |
| `club_design_reviews` | Comments and a club administrator's approval | No |

Each is set per club to **On for this club** (a club override that enables it), **Off for this club** (one that disables
it) or **As the plan says** (no override: the club's plan and the flag decide). A part is never on where the studio is
off. The change applies at once, touches only these five keys of the club's limits (every other feature of the club is
left as it is) and is written to the platform audit log as `design.rollout.changed` with the club, what changed, from
what and to what.

Evidence: `tests/product-design-persistence.integration.test.ts` (*the Owner’s rollout control (M8a)*) and browser proof
P24 (`tools/components/product-design-rollout-proof.cjs`).

## Before releasing to a club

1. The club, its administrator and its plan exist on the platform.
2. The legal drafts (`legal/`) have been reviewed by qualified counsel, and the club has the versions in force.
3. Decide the parts. If the club is not to request quotations yet, set **Requests for quotation and orders** to *Off*.
4. If it will request quotations: at least one supplier is **verified** in Factories & suppliers, with what was checked
   written down, and you are ready to broker its quotations. No supplier is a partner until an agreement says so.
5. Release: **Club Design Studio → On for this club**. The club sees the studio the next time its staff open it.
6. Send the invitation (`INVITATIONS.md`), adapted, by your own channel.

## Withdrawing

Set **Club Design Studio → Off for this club** (or *As the plan says*). The club's routes refuse at once; its designs,
rosters, requests and their history stay in the database, under row-level security, and return if the studio is
released again. Nothing is deleted by withdrawing.

## Not available here (yet)

- **Plan-wide rules.** Restricting a part for a whole plan is a change to its feature flag (`enabledForPlans`), which only
  the dormant admin router writes today; per-club settings cover the invited-club phase.
- **Bulk release.** One club at a time, on purpose, while clubs are invited individually.
