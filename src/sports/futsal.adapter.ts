// Familista — Futsal SportAdapter (Phase N)
// Court 40 × 20 m, 5-a-side, hasSharedObject=true, no half flip.

import { BaseSportAdapter } from './sport-adapter';
import type { SprintThresholdInput, TacticalThreatEvent, FormationTemplate } from './sport-adapter';
import type { TacticalGeometry } from '../spatial/types';

const COURT_W = 40, COURT_H = 20;

const SCORING = new Set(['GOAL','PENALTY_SCORED']);
const DEFENSIVE = new Set(['BLOCK','TACKLE','INTERCEPTION']);

export class FutsalSportAdapter extends BaseSportAdapter {
  readonly sport = 'FUTSAL' as const;

  geometry(): TacticalGeometry {
    return {
      sport:   'FUTSAL',
      widthM:  COURT_W,
      heightM: COURT_H,
      hasSharedObject: true,
      playersPerSide:  5,
      sidesFlipAtHalf: true,
      zones: [
        { id: 'pbox-home', label: 'Penalty area (home)', side: 'HOME', poly: [[0,4],[6,4],[6,16],[0,16]] },
        { id: 'pbox-away', label: 'Penalty area (away)', side: 'AWAY', poly: [[34,4],[40,4],[40,16],[34,16]] },
      ],
      targets: [
        { id: 'goal-home', label: 'Home goal',  x: 0,  y: 10 },
        { id: 'goal-away', label: 'Away goal',  x: 40, y: 10 },
      ],
    };
  }

  playersPerSide(): number { return 5; }

  isSprinting(input: SprintThresholdInput): boolean {
    // Court is small; sprint threshold lower than football. ~6.0 m/s.
    return input.speedMps > 6.0;
  }

  classifyEvent(kind: string): TacticalThreatEvent {
    if (SCORING.has(kind))   return { kind, isThreat: true,  polarity: 'OFFENSE', scoreDelta: 1 };
    if (DEFENSIVE.has(kind)) return { kind, isThreat: false, polarity: 'DEFENSE' };
    return { kind, isThreat: false, polarity: 'NEUTRAL' };
  }

  formations(): FormationTemplate[] {
    // Standard 1-2-1 (diamond) + 2-2 (square) templates.
    const diamond = [
      { role: 'GK',     x: 3,  y: 10 },
      { role: 'FIXO',   x: 12, y: 10 },
      { role: 'ALA_L',  x: 22, y: 5  },
      { role: 'ALA_R',  x: 22, y: 15 },
      { role: 'PIVOT',  x: 32, y: 10 },
    ];
    const square = [
      { role: 'GK',     x: 3,  y: 10 },
      { role: 'BACK_L', x: 14, y: 6  },
      { role: 'BACK_R', x: 14, y: 14 },
      { role: 'FRONT_L', x: 26, y: 6  },
      { role: 'FRONT_R', x: 26, y: 14 },
    ];
    return [
      { name: '1-2-1', spots: diamond },
      { name: '2-2',   spots: square },
    ];
  }
}
