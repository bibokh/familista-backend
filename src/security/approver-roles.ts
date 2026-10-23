// Who may decide an AI approval — the one list, with no dependencies
// ─────────────────────────────────────────────────────────────────────────────
// The AI Approval Gate (ai-approval.service.ts) enforces it on every decision,
// and the LAB orchestrator (lab/orchestrator) applies the same list to the
// decisions in its simulations. It lives apart from the service so that a
// reader of the rule does not also load the database client.

/** Who may decide an approval: the same roles routes/security.routes.ts admits. */
export const APPROVER_ROLES: readonly string[] = Object.freeze(['SUPER_ADMIN', 'CLUB_ADMIN', 'HEAD_COACH']);
