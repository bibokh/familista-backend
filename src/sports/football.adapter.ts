// Familista — Football SportAdapter (Phase G)
// Pitch 105 × 68m, two halves, hasSharedObject=true, 11-a-side.

import { BaseSportAdapter } from './sport-adapter';
import type { SprintThresholdInput, TacticalThreatEvent, FormationTemplate } from './sport-adapter';
import type { TacticalGeometry } from '../spatial/types';

const PITCH_W = 105, PITCH_H = 68;

const ATTACKING = new Set([
  'SHOT','SHOT_ON_TARGET','SHOT_OFF_TARGET','GOAL','PENALTY_AWARDED','PENALTY_SCORED','CORNER','OWN_GOAL',
]);
const DEFENSIVE = new Set([
  'INTERCEPTION','TACKLE','BLOCK','CLEARANCE','SAVE',
]);
const NEUTRAL_KINDS = new Set([
  'NOTE','FORMATION_CHANGE','SUBSTITUTION','SUBSTITUTION_IN','SUBSTITUTION_OUT','THROW_IN','GOAL_KICK',
]);

export class FootballSportAdapter extends BaseSportAdapter {
  readonly sport = 'FOOTBALL' as const;

  geometry(): TacticalGeometry {
    return {
      sport:   'FOOTBALL',
      widthM:  PITCH_W,
      heightM: PITCH_H,
      hasSharedObject: true,
      playersPerSide:  11,
      sidesFlipAtHalf: true,
      zones: [
        { id: 'pbox-home', label: 'Penalty box (home)',  side: 'HOME', poly: [[0,13.85],[16.5,13.85],[16.5,54.15],[0,54.15]] },
        { id: 'pbox-away', label: 'Penalty box (away)',  side: 'AWAY', poly: [[88.5,13.85],[105,13.85],[105,54.15],[88.5,54.15]] },
        { id: 'mid-third', label: 'Middle third',         side: 'NEUTRAL', poly: [[35,0],[70,0],[70,68],[35,68]] },
      ],
      targets: [
        { id: 'goal-home', label: 'Home goal',  x: 0,       y: 34 },
        { id: 'goal-away', label: 'Away goal',  x: PITCH_W, y: 34 },
      ],
    };
  }

  playersPerSide(): number { return 11; }

  isSprinting(input: SprintThresholdInput): boolean {
    // Standard threshold: 7.0 m/s (≈ 25 km/h).
    return input.speedMps > 7.0;
  }

  classifyEvent(kind: string, _side: string): TacticalThreatEvent {
    if (kind === 'GOAL' || kind === 'PENALTY_SCORED') return { kind, isThreat: true,  polarity: 'OFFENSE', scoreDelta: 1 };
    if (kind === 'OWN_GOAL')                          return { kind, isThreat: true,  polarity: 'OFFENSE', scoreDelta: -1 };
    if (ATTACKING.has(kind))                          return { kind, isThreat: true,  polarity: 'OFFENSE' };
    if (DEFENSIVE.has(kind))                          return { kind, isThreat: false, polarity: 'DEFENSE' };
    if (NEUTRAL_KINDS.has(kind))                      return { kind, isThreat: false, polarity: 'NEUTRAL' };
    return { kind, isThreat: false, polarity: 'NEUTRAL' };
  }

  formations(): FormationTemplate[] {
    // Compact, deterministic library — used by the Predictive layer to
    // measure positional drift versus expected.
    const f433 = [
      { role: 'GK', x: 5,  y: 34 },
      { role: 'RB', x: 22, y: 10 }, { role: 'RCB', x: 22, y: 26 }, { role: 'LCB', x: 22, y: 42 }, { role: 'LB', x: 22, y: 58 },
      { role: 'RM', x: 50, y: 22 }, { role: 'CM',  x: 50, y: 34 }, { role: 'LM',  x: 50, y: 46 },
      { role: 'RW', x: 80, y: 14 }, { role: 'ST',  x: 90, y: 34 }, { role: 'LW',  x: 80, y: 54 },
    ];
    const f442 = [
      { role: 'GK', x: 5,  y: 34 },
      { role: 'RB', x: 22, y: 10 }, { role: 'RCB', x: 22, y: 26 }, { role: 'LCB', x: 22, y: 42 }, { role: 'LB', x: 22, y: 58 },
      { role: 'RM', x: 55, y: 14 }, { role: 'RCM', x: 50, y: 30 }, { role: 'LCM', x: 50, y: 38 }, { role: 'LM', x: 55, y: 54 },
      { role: 'RST', x: 85, y: 26 }, { role: 'LST', x: 85, y: 42 },
    ];
    return [
      { name: '4-3-3', spots: f433 },
      { name: '4-4-2', spots: f442 },
    ];
  }
}
