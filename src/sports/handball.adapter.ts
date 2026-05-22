// Familista — Handball SportAdapter (Phase G)
// Court 40 × 20 m, 7-a-side. hasSharedObject=true. Sides flip at half.

import { BaseSportAdapter } from './sport-adapter';
import type { SprintThresholdInput, TacticalThreatEvent, FormationTemplate } from './sport-adapter';
import type { TacticalGeometry } from '../spatial/types';

const COURT_W = 40, COURT_H = 20;

const SCORING = new Set(['GOAL','SEVEN_M_GOAL']);
const DEFENSIVE = new Set(['SAVE','BLOCK','STEAL']);

export class HandballSportAdapter extends BaseSportAdapter {
  readonly sport = 'HANDBALL' as const;

  geometry(): TacticalGeometry {
    return {
      sport:   'HANDBALL',
      widthM:  COURT_W,
      heightM: COURT_H,
      hasSharedObject: true,
      playersPerSide:  7,
      sidesFlipAtHalf: true,
      zones: [
        { id: 'six-home', label: '6 m (home)', side: 'HOME', poly: [[0,4],[6,4],[6,16],[0,16]] },
        { id: 'six-away', label: '6 m (away)', side: 'AWAY', poly: [[COURT_W-6,4],[COURT_W,4],[COURT_W,16],[COURT_W-6,16]] },
      ],
      targets: [
        { id: 'goal-home', label: 'Home goal', x: 0,       y: 10 },
        { id: 'goal-away', label: 'Away goal', x: COURT_W, y: 10 },
      ],
    };
  }

  playersPerSide(): number { return 7; }

  isSprinting(input: SprintThresholdInput): boolean {
    // Handball threshold similar to football: 6.5 m/s.
    return input.speedMps > 6.5;
  }

  classifyEvent(kind: string): TacticalThreatEvent {
    if (SCORING.has(kind))   return { kind, isThreat: true,  polarity: 'OFFENSE', scoreDelta: 1 };
    if (DEFENSIVE.has(kind)) return { kind, isThreat: false, polarity: 'DEFENSE' };
    return { kind, isThreat: false, polarity: 'NEUTRAL' };
  }

  formations(): FormationTemplate[] {
    const six_zero = [
      { role: 'GK', x: 1,  y: 10 },
      { role: 'LW', x: 7,  y: 2  }, { role: 'LB', x: 9, y: 7 }, { role: 'CB', x: 9, y: 10 },
      { role: 'RB', x: 9,  y: 13 }, { role: 'RW', x: 7, y: 18 }, { role: 'P',  x: 6, y: 10 },
    ];
    return [{ name: '6-0', spots: six_zero }];
  }
}
