// LAB scenarios — synthetic plans that exercise the orchestrator end to end
// ─────────────────────────────────────────────────────────────────────────────
// Every club, person and player here is a `lab-…` reference: invented, and
// refused anywhere a real one is expected. Each scenario routes over the real
// Agent Registry (src/platform/agents/catalog.ts) and the real tool registry,
// read matrix and approver roles, so what it shows is what the platform's own
// rules decide, not a fixture's.

import { ORCHESTRATION_CONTRACT, type ApprovalDecision, type PlanRequest } from './contracts';

export const LAB_CLUB = 'lab-club-north';
export const OTHER_LAB_CLUB = 'lab-club-south';
export const HEAD_COACH = { userId: 'lab-user-head-coach', role: 'HEAD_COACH', clubId: LAB_CLUB } as const;
export const CLUB_ADMIN = { userId: 'lab-user-club-admin', role: 'CLUB_ADMIN', clubId: LAB_CLUB } as const;
export const MEDICAL_STAFF = { userId: 'lab-user-physio', role: 'MEDICAL_STAFF', clubId: LAB_CLUB } as const;

const opponentInput = (opponent: string) => ({
  opponent,
  matches: [
    { goalsFor: 2, goalsAgainst: 1, pressingActions: 168, attacksLeft: 31, attacksRight: 18 },
    { goalsFor: 1, goalsAgainst: 1, pressingActions: 155, attacksLeft: 27, attacksRight: 21 },
    { goalsFor: 3, goalsAgainst: 0, pressingActions: 171, attacksLeft: 35, attacksRight: 16 },
  ],
});

const plan = (id: string, title: string, requestedBy: PlanRequest['requestedBy'], tasks: PlanRequest['tasks']): PlanRequest => ({
  contract: ORCHESTRATION_CONTRACT, id, title, scope: { kind: 'CLUB', clubId: LAB_CLUB }, requestedBy, tasks,
});

/** Three agents in sequence: tactical analysis → training draft → staff briefing. */
export const matchPreparation = (): PlanRequest => plan('match-preparation', 'Prepare for Saturday\'s fixture', { ...HEAD_COACH }, [
  { id: 'opponent', operation: 'tactics.opponent-profile@1', input: opponentInput('Lab Rovers'), dependsOn: [] },
  { id: 'session', operation: 'training.session-draft@1', input: { minutes: 90, squadSize: 22 }, dependsOn: ['opponent'] },
  { id: 'briefing', operation: 'operations.match-briefing@1', input: { fixture: 'Lab Rovers (home)' }, dependsOn: ['opponent', 'session'] },
]);

/** An action: the tactical agent proposes a live change, which waits for a person. */
export const liveAdjustment = (): PlanRequest => plan('live-adjustment', 'A change at half time', { ...HEAD_COACH }, [
  { id: 'opponent', operation: 'tactics.opponent-profile@1', input: opponentInput('Lab Rovers'), dependsOn: [] },
  { id: 'change', operation: 'tactics.live-change@1', input: { minute: 46, formation: '4-2-3-1' }, dependsOn: ['opponent'] },
]);
export const approveLiveChange = (): ApprovalDecision => ({ taskId: 'change', decision: 'APPROVED', by: { ...CLUB_ADMIN } });

/** Medical data stays with the medical agent, and a medical action waits for a person who may read it. */
export const medicalBoundary = (): PlanRequest => plan('medical-boundary', 'Squad availability and recommendations', { ...MEDICAL_STAFF }, [
  { id: 'availability', operation: 'medical.availability@1', input: { players: [
    { ref: 'lab-player-1', medicalStatus: 'FIT' }, { ref: 'lab-player-2', medicalStatus: 'INJURED' }, { ref: 'lab-player-3', medicalStatus: 'RECOVERING' },
  ] }, dependsOn: [] },
  { id: 'recommendation', operation: 'medical.recommendation@1', input: {}, dependsOn: ['availability'] },
]);

/** One branch fails on invalid input; what consumes it is skipped, the other branch completes. */
export const partialFailure = (): PlanRequest => plan('partial-failure', 'Two opponents, one with no recorded matches', { ...HEAD_COACH }, [
  { id: 'opponent-a', operation: 'tactics.opponent-profile@1', input: opponentInput('Lab Rovers'), dependsOn: [] },
  { id: 'opponent-b', operation: 'tactics.opponent-profile@1', input: { opponent: 'Lab United', matches: [] }, dependsOn: [] },
  { id: 'session-b', operation: 'training.session-draft@1', input: { minutes: 75, squadSize: 20 }, dependsOn: ['opponent-b'] },
]);
