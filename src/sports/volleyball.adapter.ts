// Familista — Volleyball SportAdapter (Phase N)
// Court 18 × 9 m, 6-a-side, hasSharedObject=true (ball), no half flip.

import { BaseSportAdapter } from './sport-adapter';
import type { SprintThresholdInput, TacticalThreatEvent, FormationTemplate } from './sport-adapter';
import type { TacticalGeometry } from '../spatial/types';

const COURT_W = 18, COURT_H = 9;

const SCORING = new Set(['POINT','ACE','KILL']);
const DEFENSIVE = new Set(['BLOCK','DIG','RECEPTION']);
const ERRORS    = new Set(['NET_FAULT','OUT','DOUBLE_HIT']);

export class VolleyballSportAdapter extends BaseSportAdapter {
  readonly sport = 'VOLLEYBALL' as const;

  geometry(): TacticalGeometry {
    return {
      sport:   'VOLLEYBALL',
      widthM:  COURT_W,
      heightM: COURT_H,
      hasSharedObject: true,
      playersPerSide:  6,
      sidesFlipAtHalf: false,
      zones: [
        // 3 m attack line on each side.
        { id: 'attack-home', label: 'Attack zone (home)', side: 'HOME', poly: [[6,0],[9,0],[9,9],[6,9]] },
        { id: 'attack-away', label: 'Attack zone (away)', side: 'AWAY', poly: [[9,0],[12,0],[12,9],[9,9]] },
        { id: 'back-home',   label: 'Back zone (home)',    side: 'HOME', poly: [[0,0],[6,0],[6,9],[0,9]] },
        { id: 'back-away',   label: 'Back zone (away)',    side: 'AWAY', poly: [[12,0],[18,0],[18,9],[12,9]] },
      ],
      targets: [
        { id: 'net', label: 'Net', x: 9, y: 4.5 },
      ],
    };
  }

  playersPerSide(): number { return 6; }

  isSprinting(input: SprintThresholdInput): boolean {
    // Volleyball is explosive in short bursts; threshold ~5.0 m/s.
    return input.speedMps > 5.0 || (input.accelMagMps2 ?? 0) > 20;
  }

  classifyEvent(kind: string): TacticalThreatEvent {
    if (SCORING.has(kind))    return { kind, isThreat: true,  polarity: 'OFFENSE', scoreDelta: 1 };
    if (DEFENSIVE.has(kind))  return { kind, isThreat: false, polarity: 'DEFENSE' };
    if (ERRORS.has(kind))     return { kind, isThreat: true,  polarity: 'DEFENSE' };
    return { kind, isThreat: false, polarity: 'NEUTRAL' };
  }

  formations(): FormationTemplate[] {
    // Standard 5-1 rotation (5 attackers + 1 setter) and 4-2.
    const five_one = [
      { role: 'S',  x: 7,  y: 4.5 },
      { role: 'OH1', x: 4,  y: 1.5 },
      { role: 'OH2', x: 4,  y: 7.5 },
      { role: 'MB1', x: 8,  y: 3.0 },
      { role: 'MB2', x: 8,  y: 6.0 },
      { role: 'OPP', x: 8,  y: 4.5 },
    ];
    const four_two = [
      { role: 'S1', x: 6,  y: 3.0 },
      { role: 'S2', x: 6,  y: 6.0 },
      { role: 'OH1', x: 4, y: 1.5 },
      { role: 'OH2', x: 4, y: 7.5 },
      { role: 'MB1', x: 8, y: 3.0 },
      { role: 'MB2', x: 8, y: 6.0 },
    ];
    return [
      { name: '5-1', spots: five_one },
      { name: '4-2', spots: four_two },
    ];
  }
}
