// FAMILISTA VISION — registered as an origin, not described as one
// ─────────────────────────────────────────────────────────────────────────────
// Source Core composes rather than discovers: it reads the Fabric's source
// registry and draws what it finds. So Vision does not get a hand-written entry
// on a Source Core screen — it REGISTERS, once, here, and appears in Source
// Core, in the lineage graph and in the consumer map with no edit anywhere
// else. A second description of Vision on a screen would be a second opinion,
// and the day it disagreed with this one somebody would trust the wrong one.
//
// WHY `vision` IS ITS OWN DOMAIN AND NOT PART OF `media` OR `system`
//
// `media` owns assets and their processing — an upload, a transcode, a
// thumbnail. `system` owns devices and capture. Vision owns neither: it takes a
// source that one of those produced and asserts FOOTBALL FINDINGS about it,
// with an error bar. That is a different kind of claim with a different
// consumer and a different failure mode, and giving it somebody else's lane
// would put a calibration rejection in a queue about video transcoding.

import { registerFabricSource, type FabricSourceSpec } from '../fabric/registry/source-registry';
import { VISION_SOURCE_ID } from './vision-events';

let registered: FabricSourceSpec | null = null;

/**
 * Put Vision on the Fabric's source registry.
 *
 * Idempotent: the registry refuses a DIFFERENT re-registration and accepts an
 * identical one, so importing this from a route, a worker and a test in the
 * same process is safe and cannot produce two Visions.
 */
export function registerVisionSource(): FabricSourceSpec {
  if (registered) return registered;
  registered = registerFabricSource({
    id: VISION_SOURCE_ID,
    name: 'Familista Vision',
    domain: 'vision',
    icon: 'vision',
    category: 'intelligence',
    // After AI (90) and before System (100): Vision produces evidence that
    // Familista Intelligence later consumes, so it sits beside the other
    // intelligence producer rather than among the platform's plumbing.
    order: 95,
    description: 'Computer-vision evidence from video and future field sensors: '
      + 'tracking, calibration, ball state and validated football findings',
    eventDomains: ['vision'],
  });
  return registered;
}
