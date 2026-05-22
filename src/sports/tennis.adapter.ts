// Familista — Tennis SportAdapter (Phase G)
// Court 23.77 × 10.97 m (doubles). Singles play uses inner tramlines (8.23 m wide).
// Two players (singles) or four (doubles). hasSharedObject=true (ball).

import { BaseSportAdapter } from './sport-adapter';
import type { SprintThresholdInput, TacticalThreatEvent, FormationTemplate } from './sport-adapter';
import type { TacticalGeometry } from '../spatial/types';

const COURT_W = 23.77, COURT_H = 10.97;

const SCORING_KINDS = new Set(['ACE','WINNER','POINT_WON']);
const ERROR_KINDS   = new Set(['DOUBLE_FAULT','UNFORCED_ERROR','FORCED_ERROR']);

export class TennisSportAdapter extends BaseSportAdapter {
  readonly sport = 'TENNIS' as const;

  geometry(): TacticalGeometry {
    return {
      sport:   'TENNIS',
      widthM:  COURT_W,
      heightM: COURT_H,
      hasSharedObject: true,
      playersPerSide:  1,         // singles default; doubles override at runtime
      sidesFlipAtHalf: false,     // sides actually swap each odd game — handled by realtime layer
      zones: [
        { id: 'service-home-deuce', label: 'Service box deuce (home)', side: 'HOME', poly: [[5.485,5.485],[11.885,5.485],[11.885,10.97],[5.485,10.97]] },
        { id: 'service-home-ad',    label: 'Service box ad (home)',    side: 'HOME', poly: [[5.485,0],[11.885,0],[11.885,5.485],[5.485,5.485]] },
        { id: 'service-away-deuce', label: 'Service box deuce (away)', side: 'AWAY', poly: [[11.885,0],[18.285,0],[18.285,5.485],[11.885,5.485]] },
        { id: 'service-away-ad',    label: 'Service box ad (away)',    side: 'AWAY', poly: [[11.885,5.485],[18.285,5.485],[18.285,10.97],[11.885,10.97]] },
      ],
      targets: [
        { id: 'baseline-home', label: 'Home baseline', x: 0,        y: 5.485 },
        { id: 'baseline-away', label: 'Away baseline', x: COURT_W, y: 5.485 },
      ],
    };
  }

  playersPerSide(): number { return 1; }

  isSprinting(input: SprintThresholdInput): boolean {
    // Tennis bursts are very short; threshold ~6.5 m/s + high accel.
    return input.speedMps > 6.5 || (input.accelMagMps2 ?? 0) > 25;
  }

  classifyEvent(kind: string): TacticalThreatEvent {
    if (kind === 'ACE')                  return { kind, isThreat: true, polarity: 'OFFENSE', scoreDelta: 1 };
    if (SCORING_KINDS.has(kind))         return { kind, isThreat: true, polarity: 'OFFENSE', scoreDelta: 1 };
    if (ERROR_KINDS.has(kind))           return { kind, isThreat: true, polarity: 'DEFENSE' };
    return { kind, isThreat: false, polarity: 'NEUTRAL' };
  }

  formations(): FormationTemplate[] {
    return [
      { name: 'Baseline',  spots: [{ role: 'P1', x: 1,             y: 5.485 }, { role: 'P2', x: COURT_W - 1,  y: 5.485 }] },
      { name: 'Serve & Volley', spots: [{ role: 'P1', x: 9,        y: 5.485 }, { role: 'P2', x: COURT_W - 9,  y: 5.485 }] },
    ];
  }
}
