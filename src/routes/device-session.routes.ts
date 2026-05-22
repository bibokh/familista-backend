// Familista — Device sessions + sensor packets + device auth (Phase B + C)
// Mounted under /api/v1/devices.
//
// Three auth surfaces:
//   1. Handshake `/auth/token`           PUBLIC — secured by HMAC + clock skew.
//   2. Session lifecycle (/sessions/*)   USER JWT only.
//   3. Sensor packet ingest              USER JWT *or* DEVICE JWT.

import { Router } from 'express';
import * as ctrl     from '../controllers/device-session.controller';
import * as authCtrl from '../controllers/device-auth.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { acceptUserOrDevice }      from '../middleware/device-auth.middleware';

const router = Router();

// ── 1. Public device handshake (NO auth middleware) ──────────────────────
router.post('/auth/token', authCtrl.issueToken);

// ── 3. Sensor packet ingest (user OR device JWT) ─────────────────────────
// Registered BEFORE the user-only block so requests carrying a device JWT
// are not rejected by `authenticate`.
router.post('/sessions/:id/packets',       acceptUserOrDevice, ctrl.ingestPacket);
router.post('/sessions/:id/packets/batch', acceptUserOrDevice, ctrl.ingestBatch);

// Phase E · Device-keyed alias — `/devices/:id/packet` mirrors the
// canonical `/devices/sessions/:id/packets` so wearables can use the
// shorter URL spec'd by the public device firmware API. The `:id`
// regex restricts matches to UUID-shaped strings so we never collide
// with the literal `/sessions/...` prefix.
router.post(
  '/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/packet',
  acceptUserOrDevice,
  ctrl.ingestPacket,
);

// ── 2. User-authenticated session lifecycle ──────────────────────────────
router.get('/sessions',                  authenticate, ctrl.listSessions);
router.post('/sessions',                 authenticate, authorize('CLUB_ADMIN','HEAD_COACH','MEDICAL_STAFF','ANALYST'), ctrl.openSession);
router.get('/sessions/:id',              authenticate, ctrl.getSession);
router.post('/sessions/:id/close',       authenticate, authorize('CLUB_ADMIN','HEAD_COACH','MEDICAL_STAFF','ANALYST'), ctrl.closeSession);
router.get('/sessions/:id/packets',      authenticate, ctrl.listPackets);

export default router;
