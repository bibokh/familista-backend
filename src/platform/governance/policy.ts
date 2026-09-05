// The policy engine — one decision point, not a thousand country checks
// ─────────────────────────────────────────────────────────────────────────────
// Familista will operate under rules that differ by country, by the age of the
// person the data is about, by what the data is and by what is being done with
// it. Written as conditionals at call sites, that becomes hundreds of
// `if (country === ...)` nobody can audit. Written here, it is one function
// with one shape of input and one shape of answer.
//
//   actor + jurisdiction + resource + classification + action + purpose + AI?
//     → ALLOW | DENY | REQUIRE_APPROVAL | NOT_VALIDATED
//
// ── What this file explicitly does NOT claim
//
// It does not make Familista legally compliant anywhere. It makes Familista
// COMPLIANCE-READY: a place where a jurisdiction's rules can be expressed,
// versioned and evidenced. A jurisdiction with no pack returns
// NOT_VALIDATED — never ALLOW. Silence is not permission.

import { type DataClassification, classify } from '../data-classification';

export type PolicyOutcome = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'NOT_VALIDATED';

export interface PolicyRequest {
  actorLevel: 'PLATFORM_OWNER' | 'CLUB_OWNER' | 'CLUB_STAFF' | 'VIEWER' | 'AI_AGENT';
  /** ISO country or region code the data subject falls under. */
  jurisdiction?: string | null;
  resource: string;
  action: 'READ' | 'WRITE' | 'EXPORT' | 'DELETE';
  purpose?: string;
  /** True when the data subject is a minor. */
  subjectIsMinor?: boolean;
  /** Whether an AI system is involved in this decision. */
  aiInvolved?: boolean;
  /** Whether a valid, current consent covers this purpose. */
  consentGiven?: boolean;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  classification: DataClassification;
  /** Why, in a sentence a compliance reviewer can read. */
  reason: string;
  /** The pack that decided, so an answer can be traced to a rule. */
  policyPack: string;
  policyVersion: string;
}

export interface JurisdictionPack {
  id: string;
  version: string;
  /** Jurisdiction codes this pack answers for. */
  covers: string[];
  /** Classifications this pack forbids exporting out of the jurisdiction. */
  noExport?: DataClassification[];
  /** Whether processing a minor's data requires recorded guardian consent. */
  minorConsentRequired: boolean;
  /** Whether an AI decision about a person requires human oversight. */
  aiHumanOversight: boolean;
}

const packs = new Map<string, JurisdictionPack>();

export function registerPack(pack: JurisdictionPack): void {
  packs.set(pack.id, pack);
}

export function listPacks(): JurisdictionPack[] {
  return [...packs.values()];
}

export function resetPacks(): void {
  packs.clear();
  registerDefaultPacks();
}

/**
 * The packs Familista ships with.
 *
 * Deliberately few and deliberately conservative. They are a starting point for
 * a lawyer to correct, not a legal opinion: what matters architecturally is
 * that they exist, are versioned, and are the only place these rules live.
 */
export function registerDefaultPacks(): void {
  registerPack({
    id: 'EU-GDPR', version: '2024.1',
    covers: ['EU', 'DE', 'FR', 'ES', 'IT', 'NL', 'PT', 'PL', 'SE', 'DK', 'FI', 'IE', 'AT', 'BE', 'GR', 'CZ', 'RO'],
    noExport: ['RESTRICTED'],
    minorConsentRequired: true,
    aiHumanOversight: true,
  });
  registerPack({
    id: 'UK', version: '2024.1',
    covers: ['GB', 'UK'],
    noExport: ['RESTRICTED'],
    minorConsentRequired: true,
    aiHumanOversight: true,
  });
  registerPack({
    id: 'US', version: '2024.1',
    covers: ['US'],
    minorConsentRequired: true,     // COPPA-shaped; states differ and packs can split later
    aiHumanOversight: false,
  });
}
registerDefaultPacks();

function packFor(jurisdiction: string | null | undefined): JurisdictionPack | null {
  if (!jurisdiction) return null;
  const code = jurisdiction.toUpperCase();
  return [...packs.values()].find((p) => p.covers.includes(code)) ?? null;
}

/**
 * Decide.
 *
 * The order matters: an unknown jurisdiction is answered before anything else,
 * because every rule below it is a rule of some particular place.
 */
export function decide(req: PolicyRequest): PolicyDecision {
  const classification = classify(req.resource);
  const pack = packFor(req.jurisdiction);

  if (!pack) {
    return {
      outcome: 'NOT_VALIDATED',
      classification,
      reason: req.jurisdiction
        ? `No policy pack covers "${req.jurisdiction}". Familista is not validated for commercial launch there.`
        : 'No jurisdiction was supplied, so no policy pack could answer. Silence is not permission.',
      policyPack: 'NONE',
      policyVersion: '—',
    };
  }

  const base = { classification, policyPack: pack.id, policyVersion: pack.version };

  if (classification === 'RESTRICTED' && req.action === 'EXPORT' && pack.noExport?.includes('RESTRICTED')) {
    return { ...base, outcome: 'DENY', reason: `${pack.id} forbids exporting restricted data out of the jurisdiction.` };
  }
  if (req.subjectIsMinor && pack.minorConsentRequired && req.consentGiven !== true) {
    return { ...base, outcome: 'DENY', reason: `${pack.id} requires recorded guardian consent before processing a minor's data.` };
  }
  if (req.actorLevel === 'VIEWER' && classification !== 'PUBLIC') {
    return { ...base, outcome: 'DENY', reason: 'A viewer reaches public data only.' };
  }
  if (req.actorLevel === 'AI_AGENT' && req.aiInvolved && pack.aiHumanOversight && req.action !== 'READ') {
    return { ...base, outcome: 'REQUIRE_APPROVAL', reason: `${pack.id} requires human oversight of an AI decision about a person.` };
  }
  if (classification === 'RESTRICTED' && req.actorLevel !== 'CLUB_OWNER' && req.action !== 'READ') {
    return { ...base, outcome: 'REQUIRE_APPROVAL', reason: 'Restricted data is changed with explicit authority.' };
  }
  return { ...base, outcome: 'ALLOW', reason: `${pack.id} permits this.` };
}
