// Familista — the AI Agents Operations Room API
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Foundation, AI-0.1. Two reads, both the platform owner's,
// behind the SAME guard as SYSTEM, CYBERSECURITY, the Algorithms room and the
// Design System room. The room is the platform's, never a club's: no club
// role reaches it however senior it is inside its club, and no Club Workspace
// links to it.
//
//   GET /system/agents            the room: the registry's digest and counts,
//                                 the invariants it holds against the egress
//                                 profiles and the read policy, every agent
//   GET /system/agents/:agentId   one agent's manifest in full: its tools, the
//                                 records it writes and who may read them
//   GET /system/agents/orchestration  (AI-0.3) the LAB orchestrator's published
//                                 evidence, verified: synthetic runs, never live
//
// There is no write. A manifest changes in a reviewed pull request
// (src/platform/agents/catalog.ts), never by a request; the kill switch stays
// where it always was (POST /system/agents/kill-switch, system.routes.ts).
// What travels: manifests and computed checks. No club, person or record.

import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import { operationsRoomAgent, operationsRoomOverview } from '../platform/agents/operations-room.service';
import { orchestrationRoomView } from '../platform/agents/orchestration-evidence';
import { platformAgentRegistry } from '../platform/agents/catalog';
import { NotFoundError } from '../utils/errors';

const router = Router();
router.use(authenticate);

router.use(async (req: Request, res: Response, next) => {
  try {
    const u = (req as Request & { user?: { id?: string; clubId?: string; role?: string } }).user;
    await assertPlatformOwner({ userId: u?.id ?? '', clubId: u?.clubId ?? null, role: u?.role });
    res.setHeader('Cache-Control', 'no-store');
    next();
  } catch (err) { next(err); }
});

router.get('/', (_req: Request, res: Response, next) => {
  try {
    res.json({ success: true, data: operationsRoomOverview() });
  } catch (err) { next(err); }
});

/**
 * AI-0.3: the LAB orchestration evidence, verified (orchestration-evidence.ts). Synthetic runs the Lab
 * published as data; this server reads them and runs nothing. Declared before /:agentId, which it is not.
 */
router.get('/orchestration', (_req: Request, res: Response, next) => {
  try {
    res.json({ success: true, data: orchestrationRoomView(platformAgentRegistry()) });
  } catch (err) { next(err); }
});

/** One agent. The id is a manifest id, never a row id. */
router.get('/:agentId', (req: Request, res: Response, next) => {
  try {
    const found = operationsRoomAgent(String(req.params.agentId));
    if (!found) throw new NotFoundError('Agent');
    res.json({ success: true, data: found });
  } catch (err) { next(err); }
});

export default router;
