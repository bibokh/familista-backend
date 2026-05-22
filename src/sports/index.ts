// Familista — Sport Adapter registry (Phase G)
// ─────────────────────────────────────────────────────────────────────────
// Single entry point: `getSportAdapter('FOOTBALL')` → typed adapter.
//
// The registry is built once at module load. Adding a new sport is a
// 3-line change: import the adapter and put it in the map.

import type { SportKind } from '@prisma/client';
import type { SportAdapter } from './sport-adapter';

import { FootballSportAdapter   } from './football.adapter';
import { BasketballSportAdapter } from './basketball.adapter';
import { TennisSportAdapter     } from './tennis.adapter';
import { HandballSportAdapter   } from './handball.adapter';
import { AthleticsSportAdapter  } from './athletics.adapter';
// Phase N additions — additive, do not modify existing adapter behaviour.
import { FutsalSportAdapter     } from './futsal.adapter';
import { VolleyballSportAdapter } from './volleyball.adapter';

const REGISTRY: Partial<Record<SportKind, SportAdapter>> = {
  FOOTBALL:   new FootballSportAdapter(),
  BASKETBALL: new BasketballSportAdapter(),
  TENNIS:     new TennisSportAdapter(),
  HANDBALL:   new HandballSportAdapter(),
  ATHLETICS:  new AthleticsSportAdapter(),
  FUTSAL:     new FutsalSportAdapter(),
  VOLLEYBALL: new VolleyballSportAdapter(),
};

/** Default fallback when the sport can't be resolved. */
const DEFAULT = REGISTRY.FOOTBALL!;

export function getSportAdapter(sport: SportKind | string | null | undefined): SportAdapter {
  if (!sport) return DEFAULT;
  const key = String(sport).toUpperCase() as SportKind;
  return REGISTRY[key] ?? DEFAULT;
}

/** Enumerate all registered adapters — used by /api/v1/sports. */
export function listSports(): Array<{
  sport:           SportKind;
  playersPerSide:  number;
  widthM:          number;
  heightM:         number;
  hasSharedObject: boolean;
  sidesFlipAtHalf: boolean;
}> {
  return Object.values(REGISTRY).filter(Boolean).map((a) => {
    const g = a!.geometry();
    return {
      sport: a!.sport,
      playersPerSide: a!.playersPerSide(),
      widthM: g.widthM,
      heightM: g.heightM,
      hasSharedObject: g.hasSharedObject,
      sidesFlipAtHalf: g.sidesFlipAtHalf,
    };
  });
}

export type { SportAdapter } from './sport-adapter';
