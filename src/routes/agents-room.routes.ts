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
//   GET /system/agents/publications   (AI-0.5) LAB executions the Platform Owner
//                                 approved for publication (v2 evidence), verified
//   GET /system/agents/cost       paid AI execution: the owner's switch, the
//                                 configured limits and prices, and what the
//                                 execution gate has counted — platform-wide,
//                                 never by club, and estimates, never billing
//
// There is no write. A manifest changes in a reviewed pull request
// (src/platform/agents/catalog.ts), never by a request; the kill switch stays
// where it always was (POST /system/agents/kill-switch, system.routes.ts), and
// so does the AI EXECUTION switch (POST /system/agents/ai-execution).
// What travels: manifests and computed checks. No club, person or record.

import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import { operationsRoomAgent, operationsRoomOverview } from '../platform/agents/operations-room.service';
import { orchestrationRoomView } from '../platform/agents/orchestration-evidence';
import { publicationsRoomView } from '../platform/agents/execution-evidence';
import { platformAgentRegistry } from '../platform/agents/catalog';
import { aiCostRoomView } from '../platform/intelligence/ai-cost-view';
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

/** Paid AI execution, read-only: the switch, limits, prices and counted usage (ai-cost-view.ts). Before /:agentId. */
router.get('/cost', async (_req: Request, res: Response, next) => {
  try {
    res.json({ success: true, data: await aiCostRoomView() });
  } catch (err) { next(err); }
});

/**
 * AI-0.5: the LAB executions approved for publication (execution-evidence.ts). The approval is the Platform
 * Owner's merge of the pull request that carried each one; this server reads what that build shipped,
 * verifies it again and runs nothing. There is no write: a publication arrives in a reviewed pull request.
 */
router.get('/publications', (_req: Request, res: Response, next) => {
  try {
    res.json({ success: true, data: publicationsRoomView(platformAgentRegistry()) });
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
