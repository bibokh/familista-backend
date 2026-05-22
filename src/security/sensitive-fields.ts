// Familista — Sensitive Field Registry (Phase I)
// ─────────────────────────────────────────────────────────────────────────
// Single source of truth for which fields are PII / medical / biometric /
// financial. Used by:
//   - response-shaping helpers ("redact unless role X")
//   - GDPR export/delete tooling
//   - audit chain payload sanitisation (we hash sensitive fields, never
//     store them in the audit row)
//
// Fields are keyed by `entityType.fieldName` for cross-table lookup.

export type SensitivityClass =
  | 'PII'              // names, emails, phone, address — direct identifiers
  | 'CONTACT'          // parent/contact info
  | 'MEDICAL'          // injury history, medical status, biometric proxies
  | 'BIOMETRIC'        // raw biometric streams (HR, ECG, biochem)
  | 'FINANCIAL'        // payment, wage, transfer fee
  | 'CRED'             // hashed passwords, refresh tokens, hmac secrets
  | 'AUDIT_HASH_ONLY'; // never log in plain text — replaced by sha256 in audit chain

export interface FieldPolicy {
  field:         string;            // "Player.email" form
  class:         SensitivityClass;
  /** Roles allowed to see the raw value. Others get redacted. */
  allowedRoles:  string[];
  /** True if even the audit chain should store only the hash. */
  hashInAudit:   boolean;
  /** GDPR right-to-be-forgotten erases this column (or hashes it). */
  gdprErasable:  boolean;
}

const ADMIN = ['SUPER_ADMIN', 'CLUB_ADMIN'];
const COACH = [...ADMIN, 'HEAD_COACH', 'ASSISTANT_COACH'];
const MEDIC = [...ADMIN, 'MEDICAL_STAFF'];
const ANALYST_PLUS = [...COACH, 'ANALYST'];

export const REGISTRY: ReadonlyArray<FieldPolicy> = [
  // Player PII
  { field: 'Player.firstName',     class: 'PII',       allowedRoles: ANALYST_PLUS, hashInAudit: false, gdprErasable: true  },
  { field: 'Player.lastName',      class: 'PII',       allowedRoles: ANALYST_PLUS, hashInAudit: false, gdprErasable: true  },
  { field: 'Player.dateOfBirth',   class: 'PII',       allowedRoles: ANALYST_PLUS, hashInAudit: true,  gdprErasable: true  },
  { field: 'Player.email',         class: 'PII',       allowedRoles: ADMIN,        hashInAudit: true,  gdprErasable: true  },
  { field: 'Player.parentName',    class: 'CONTACT',   allowedRoles: ADMIN,        hashInAudit: true,  gdprErasable: true  },
  { field: 'Player.parentEmail',   class: 'CONTACT',   allowedRoles: ADMIN,        hashInAudit: true,  gdprErasable: true  },
  { field: 'Player.parentPhone',   class: 'CONTACT',   allowedRoles: ADMIN,        hashInAudit: true,  gdprErasable: true  },

  // Medical
  { field: 'Player.medicalStatus', class: 'MEDICAL',   allowedRoles: MEDIC,        hashInAudit: false, gdprErasable: false },
  { field: 'Player.isInjured',     class: 'MEDICAL',   allowedRoles: MEDIC,        hashInAudit: false, gdprErasable: false },
  { field: 'PlayerInjury.*',       class: 'MEDICAL',   allowedRoles: MEDIC,        hashInAudit: false, gdprErasable: true  },

  // Biometric streams
  { field: 'SensorPacket.payload.bpm',   class: 'BIOMETRIC', allowedRoles: MEDIC, hashInAudit: true, gdprErasable: false },
  { field: 'SensorPacket.payload.ecg',   class: 'BIOMETRIC', allowedRoles: MEDIC, hashInAudit: true, gdprErasable: false },
  { field: 'SensorPacket.payload.lactateMmol', class: 'BIOMETRIC', allowedRoles: MEDIC, hashInAudit: true, gdprErasable: false },

  // Financial
  { field: 'Player.marketValue',   class: 'FINANCIAL', allowedRoles: ADMIN,        hashInAudit: false, gdprErasable: false },
  { field: 'Player.weeklyWage',    class: 'FINANCIAL', allowedRoles: ADMIN,        hashInAudit: false, gdprErasable: false },
  { field: 'Transaction.*',        class: 'FINANCIAL', allowedRoles: ADMIN,        hashInAudit: false, gdprErasable: false },

  // Credentials — NEVER in plain text anywhere
  { field: 'User.password',        class: 'CRED',      allowedRoles: [],           hashInAudit: true, gdprErasable: false },
  { field: 'Device.hmacSecret',    class: 'CRED',      allowedRoles: [],           hashInAudit: true, gdprErasable: false },
  { field: 'Camera.hmacSecret',    class: 'CRED',      allowedRoles: [],           hashInAudit: true, gdprErasable: false },
  { field: 'DeviceSession.sessionKey', class: 'CRED',  allowedRoles: [],           hashInAudit: true, gdprErasable: false },
];

const byField: Record<string, FieldPolicy> = Object.fromEntries(REGISTRY.map((p) => [p.field, p]));

export function policyFor(field: string): FieldPolicy | undefined {
  return byField[field];
}

export function roleCanRead(field: string, role: string | undefined | null): boolean {
  const p = byField[field];
  if (!p) return true;                            // unregistered → public
  if (!role) return false;
  return p.allowedRoles.includes(role);
}

/** Returns a shallow copy of `obj` with sensitive fields redacted for the given role. */
export function redactForRole<T extends Record<string, unknown>>(entityType: string, obj: T, role: string | undefined | null): T {
  const out: Record<string, unknown> = { ...obj };
  for (const [k] of Object.entries(out)) {
    const policy = byField[`${entityType}.${k}`];
    if (policy && !policy.allowedRoles.includes(role ?? '')) {
      out[k] = '[redacted]';
    }
  }
  return out as T;
}

/** Returns the list of GDPR-erasable fields for a given entity type. */
export function gdprErasableFields(entityType: string): string[] {
  return REGISTRY
    .filter((p) => p.gdprErasable && p.field.startsWith(entityType + '.'))
    .map((p) => p.field.substring(entityType.length + 1));
}
