import { Router } from 'express';
import * as ctrl from '../controllers/player.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.get('/',                ctrl.getPlayers);
router.post('/',               authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.createPlayer);
router.get('/:id',             ctrl.getPlayer);
router.put('/:id',             authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.updatePlayer);
router.delete('/:id',          authorize('CLUB_ADMIN'), ctrl.deletePlayer);
router.post('/:id/gps',        ctrl.addGpsData);
router.get('/:id/stats',       ctrl.getPlayerStats);
router.post('/:id/ai-analysis',ctrl.analyzePlayer);

export default router;
