// Familista — Athletics SportAdapter (Phase G)
// Track 84.39 × 36.5 m (standard 400m oval bounding box). Variable
// playersPerSide (sprint, middle-distance, marathon). hasSharedObject=false.

import { BaseSportAdapter } from './sport-adapter';
import type { SprintThresholdInput, TacticalThreatEvent, FormationTemplate } from './sport-adapter';
import type { TacticalGeometry } from '../spatial/types';

const TRACK_W = 84.39, TRACK_H = 36.5;

export class AthleticsSportAdapter extends BaseSportAdapter {
  readonly sport = 'ATHLETICS' as const;

  geometry(): TacticalGeometry {
    return {
      sport:   'ATHLETICS',
      widthM:  TRACK_W,
      heightM: TRACK_H,
      hasSharedObject: false,
      playersPerSide:  8,                // standard sprint lanes
      sidesFlipAtHalf: false,
      zones: [
        { id: 'straight-back',  label: 'Back straight',  side: 'NEUTRAL', poly: [[0,0],[TRACK_W,0],[TRACK_W,TRACK_H/2],[0,TRACK_H/2]] },
        { id: 'straight-front', label: 'Front straight', side: 'NEUTRAL', poly: [[0,TRACK_H/2],[TRACK_W,TRACK_H/2],[TRACK_W,TRACK_H],[0,TRACK_H]] },
      ],
      targets: [
        { id: 'start', label: 'Start line',  x: 0,        y: TRACK_H / 2 },
        { id: 'finish', label: 'Finish line', x: TRACK_W, y: TRACK_H / 2 },
      ],
    };
  }

  playersPerSide(): number { return 8; }

  isSprinting(input: SprintThresholdInput): boolean {
    // Athletics: any forward locomotion above 8 m/s is sprint pace.
    return input.speedMps > 8.0;
  }

  classifyEvent(kind: string): TacticalThreatEvent {
    if (kind === 'LAP_COMPLETE' || kind === 'PB' || kind === 'FINISH') {
      return { kind, isThreat: true, polarity: 'OFFENSE' };
    }
    if (kind === 'FALSE_START' || kind === 'DQ') {
      return { kind, isThreat: true, polarity: 'DEFENSE' };
    }
    return { kind, isThreat: false, polarity: 'NEUTRAL' };
  }

  formations(): FormationTemplate[] {
    // One spot per lane.
    const lanes = Array.from({ length: 8 }, (_, i) => ({
      role: `LANE${i + 1}`,
      x:    1,
      y:    (i + 1) * (TRACK_H / 9),
    }));
    return [{ name: 'Sprint Start (8 lanes)', spots: lanes }];
  }
}
