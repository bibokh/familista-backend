/**
 * Familista commercial plans (P5) — the Design Studio features a plan can include. A feature is enforced on the server:
 * the route that serves it refuses a tenant whose entitlements do not include it (403 PLAN_FEATURE_REQUIRED).
 *
 *   team_kit             team rosters, collections and their order sheets
 *   brand_studio         the brand kit: colours and logos
 *   reviews              review notes and approvals of versions
 *   collaboration        sharing a design with another creator (creators only)
 *   manufacturing        quotation requests through Familista
 *   pro_export           the professional export: every view of a saved version as one print sheet (SVG), recorded
 *   manufacturing_prep   the manufacturing preparation pack: a version's tech pack (colours, placements in mm), JSON or CSV
 */
export const FEATURES = ['team_kit', 'brand_studio', 'reviews', 'collaboration', 'manufacturing', 'pro_export', 'manufacturing_prep'] as const;
export type Feature = typeof FEATURES[number];
export const isFeature = (v: unknown): v is Feature => typeof v === 'string' && (FEATURES as readonly string[]).includes(v);

/**
 * What a creator has when no plan applies (no subscription and no default creator plan configured): everything the
 * Creator Studio shipped with (P3, P4). The professional tools come only with a plan that includes them.
 */
export const BUILT_IN_CREATOR: readonly Feature[] = Object.freeze(['team_kit', 'brand_studio', 'reviews', 'collaboration', 'manufacturing']);
/** A club's core studio parts are its plan's and the Owner's releases (M7a, M8a); a club plan adds the professional tools. */
export const BUILT_IN_CLUB: readonly Feature[] = Object.freeze([]);
/** The features a club plan can carry: the professional tools (the core parts stay with M7a's mechanism). */
export const CLUB_PLAN_FEATURES: readonly Feature[] = Object.freeze(['pro_export', 'manufacturing_prep']);
