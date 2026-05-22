// Familista — Basketball SportAdapter (Phase G)
// Court 28 × 15 m (FIBA), 5-a-side, no half-flip, hasSharedObject=true.

import { BaseSportAdapter } from './sport-adapter';
import type { SprintThresholdInput, TacticalThreatEvent, FormationTemplate } from './sport-adapter';
import type { TacticalGeometry } from '../spatial/types';

const COURT_W = 28, COURT_H = 15;

const SCORING = new Set(['FIELD_GOAL','THREE_POINT','FREE_THROW','DUNK','LAYUP']);
const DEFENSIVE = new Set(['BLOCK','STEAL','REBOUND','CHARGE']);

export class BasketballSportAdapter extends BaseSportAdapter {
  readonly sport = 'BASKETBALL' as const;

  geometry(): TacticalGeometry {
    return {
      sport:   'BASKETBALL',
      widthM:  COURT_W,
      heightM: COURT_H,
      hasSharedObject: true,
      playersPerSide:  5,
      sidesFlipAtHalf: false,
      zones: [
        { id: 'paint-home', label: 'Paint (home)', side: 'HOME', poly: [[0,4.075],[5.8,4.075],[5.8,10.925],[0,10.925]] },
        { id: 'paint-away', label: 'Paint (away)', side: 'AWAY', poly: [[22.2,4.075],[28,4.075],[28,10.925],[22.2,10.925]] },
      ],
      targets: [
        { id: 'hoop-home', label: 'Home hoop', x: 1.575, y: 7.5 },
        { id: 'hoop-away', label: 'Away hoop', x: 26.425, y: 7.5 },
      ],
    };
  }

  playersPerSide(): number { return 5; }

  isSprinting(input: SprintThresholdInput): boolean {
    // Basketball threshold lower — court is smaller. ~5.5 m/s.
    return input.speedMps > 5.5;
  }

  classifyEvent(kind: string): TacticalThreatEvent {
    if (SCORING.has(kind))   return { kind, isThreat: true,  polarity: 'OFFENSE', scoreDelta: kind === 'THREE_POINT' ? 3 : kind === 'FREE_THROW' ? 1 : 2 };
    if (DEFENSIVE.has(kind)) return { kind, isThreat: false, polarity: 'DEFENSE' };
    return { kind, isThreat: false, polarity: 'NEUTRAL' };
  }

  formations(): FormationTemplate[] {
    // Halfcourt offence templates.
    const fiveOut = [
      { role: 'PG', x: 7,    y: 7.5 },
      { role: 'SG', x: 9,    y: 2 },
      { role: 'SF', x: 9,    y: 13 },
      { role: 'PF', x: 18,   y: 4 },
      { role: 'C',  x: 18,   y: 11 },
    ];
    return [{ name: '5-out', spots: fiveOut }];
  }
}
