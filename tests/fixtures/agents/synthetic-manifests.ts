/**
 * SYNTHETIC agent manifests, for tests only.
 *
 * None of these agents exists. They are invented to prove the registry holds
 * agents for every part of the platform — education, commerce, vision, media,
 * platform operations — under the same rules as the agents that run, and to
 * give every validation rule a valid starting point to break. No real club,
 * person or record appears here, and nothing here is ever registered by the
 * application itself.
 */

import { AutonomyLevel } from '../../../src/platform/intelligence/agents';
import type { AgentManifest } from '../../../src/platform/agents/manifest';

export const SYNTHETIC_LAB_MANIFESTS: AgentManifest[] = [
  {
    id: 'club.synthetic-education-tutor', version: '0.1.0', title: 'Synthetic Education Tutor', domain: 'EDUCATION', scope: 'CLUB',
    lifecycle: 'LAB', autonomyCeiling: AutonomyLevel.RECOMMEND, supervisor: 'HEAD_COACH',
    purpose: 'SYNTHETIC. Recommends a learning path from a course catalogue; touches no person\'s record.',
    tools: ['getClub', 'getTeam'], data: { reads: ['PUBLIC'], writes: ['PUBLIC'] }, outputs: [],
  },
  {
    id: 'club.synthetic-commerce-assistant', version: '0.1.0', title: 'Synthetic Commerce Assistant', domain: 'COMMERCE', scope: 'CLUB',
    lifecycle: 'DRAFT', autonomyCeiling: AutonomyLevel.PREPARE, supervisor: 'CLUB_ADMIN',
    purpose: 'SYNTHETIC. Drafts a teamwear order for a person to place.',
    tools: ['getClub', 'getTeam', 'createReport'], data: { reads: ['PUBLIC', 'INTERNAL'], writes: ['INTERNAL'] }, outputs: [],
  },
  {
    id: 'club.synthetic-vision-analyst', version: '0.1.0', title: 'Synthetic Vision Analyst', domain: 'VISION', scope: 'CLUB',
    lifecycle: 'LAB', autonomyCeiling: AutonomyLevel.OBSERVE, supervisor: 'ANALYST',
    purpose: 'SYNTHETIC. Observes a recorded match and reports what it saw.',
    tools: ['getMatch'], data: { reads: ['INTERNAL'], writes: ['INTERNAL'] }, outputs: [],
  },
  {
    id: 'club.synthetic-media-editor', version: '0.1.0', title: 'Synthetic Media Editor', domain: 'MEDIA', scope: 'CLUB',
    lifecycle: 'DRAFT', autonomyCeiling: AutonomyLevel.PREPARE, supervisor: 'CLUB_ADMIN',
    purpose: 'SYNTHETIC. Drafts a match highlight description for a person to publish.',
    tools: ['getMatch', 'createReport'], data: { reads: ['PUBLIC', 'INTERNAL'], writes: ['INTERNAL'] }, outputs: [],
  },
  {
    id: 'platform.synthetic-registry-auditor', version: '0.1.0', title: 'Synthetic Registry Auditor', domain: 'PLATFORM_OPERATIONS', scope: 'PLATFORM',
    lifecycle: 'LAB', autonomyCeiling: AutonomyLevel.OBSERVE, supervisor: 'PLATFORM_OWNER',
    purpose: 'SYNTHETIC. Reads the registry and reports drift to the Platform Owner.',
    tools: [], data: { reads: ['INTERNAL'], writes: ['INTERNAL'] }, outputs: [],
  },
];

/** A fresh copy of a valid synthetic manifest, to break one rule at a time. */
export const validSynthetic = (): AgentManifest => JSON.parse(JSON.stringify(SYNTHETIC_LAB_MANIFESTS[1]));
