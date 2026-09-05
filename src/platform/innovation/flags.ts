// Feature flags — hidden by default, everywhere that is not the workshop
// ─────────────────────────────────────────────────────────────────────────────
// The rule this file exists to keep: a president, a staff member or a normal
// user must never see an experiment. Not "should not by convention" — the
// resolver's default answer is OFF, and every path to ON is an explicit
// targeting decision somebody made.
//
// Targeting, in the order it is evaluated:
//
//   OWNER_ONLY          the platform owner, and nobody else.
//   INTERNAL            the platform owner and named internal accounts.
//   SELECTED_USERS      an explicit list.
//   SELECTED_CLUBS      an explicit list of clubs.
//   PERCENTAGE_ROLLOUT  a stable hash of the actor: the same person always
//                       gets the same answer, and the cohort only grows.
//   PUBLIC              everybody.
//
// The environment is checked first in every case. A flag enabled in the Lab is
// not enabled in production, whatever its targeting says.

import { createHash } from 'crypto';
import { currentEnvironment, type FamilistaEnvironment } from '../environment';

export type FlagAudience = 'OWNER_ONLY' | 'INTERNAL' | 'SELECTED_USERS' | 'SELECTED_CLUBS' | 'PERCENTAGE_ROLLOUT' | 'PUBLIC';

export interface FlagRule {
  key: string;
  description?: string;
  /** Where this flag may be on at all. */
  environments: FamilistaEnvironment[];
  audience: FlagAudience;
  userIds?: string[];
  clubIds?: string[];
  /** 0–100. Only meaningful for PERCENTAGE_ROLLOUT. */
  percentage?: number;
  /** A flag switched off here is off for everybody, immediately. */
  enabled: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
}

export interface FlagActor {
  userId?: string | null;
  clubId?: string | null;
  isPlatformOwner?: boolean;
  isInternal?: boolean;
}

const rules = new Map<string, FlagRule>();

export function defineFlag(rule: FlagRule): void { rules.set(rule.key, rule); }
export function listFlags(): FlagRule[] { return [...rules.values()]; }
export function resetFlags(): void { rules.clear(); }

/** Stable 0–99 bucket for one actor and one flag. */
function bucket(key: string, actorId: string): number {
  const digest = createHash('sha256').update(`${key}:${actorId}`).digest();
  return digest.readUInt16BE(0) % 100;
}

/**
 * Is this feature on, for this person, here, now?
 *
 * An unknown flag is OFF. A flag with no rule is OFF. A flag whose environment
 * does not include this one is OFF. There is no path where forgetting something
 * turns a feature on.
 */
export function isEnabled(key: string, actor: FlagActor = {}, env: FamilistaEnvironment = currentEnvironment()): boolean {
  const rule = rules.get(key);
  if (!rule || !rule.enabled) return false;
  if (!rule.environments.includes(env)) return false;

  const now = Date.now();
  if (rule.startsAt && now < rule.startsAt.getTime()) return false;
  if (rule.endsAt && now > rule.endsAt.getTime()) return false;

  switch (rule.audience) {
    case 'OWNER_ONLY':
      return !!actor.isPlatformOwner;
    case 'INTERNAL':
      return !!actor.isPlatformOwner || !!actor.isInternal;
    case 'SELECTED_USERS':
      return !!actor.userId && (rule.userIds ?? []).includes(actor.userId);
    case 'SELECTED_CLUBS':
      return !!actor.clubId && (rule.clubIds ?? []).includes(actor.clubId);
    case 'PERCENTAGE_ROLLOUT': {
      if (actor.isPlatformOwner) return true;
      const id = actor.userId ?? actor.clubId;
      if (!id) return false;
      return bucket(key, id) < Math.max(0, Math.min(100, rule.percentage ?? 0));
    }
    case 'PUBLIC':
      return true;
    default:
      return false;
  }
}
