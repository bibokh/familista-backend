// Familista — realtime connection tickets (Cyber Defense R7)
// Mounted at /api/v1/realtime.
//
// A signed-in page asks for a ticket here and opens its WebSocket with
// `?ticket=`, so the session token never travels in a URL. See
// src/realtime/ws-ticket.ts for what a ticket is and how it is spent.

import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { issueWsTicket } from '../realtime/ws-ticket';

const router = Router();
router.use(authenticate);

router.post('/ticket', (req: Request, res: Response) => {
  const r = req as Request & { user: { id: string }; sessionTokenVersion?: number | null; sessionPassedCode?: boolean };
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, data: issueWsTicket(r.user.id, r.sessionTokenVersion ?? null, r.sessionPassedCode === true) });
});

export default router;
