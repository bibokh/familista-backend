import { Router } from 'express';
import * as ctrl from '../controllers/match.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

router.get('/',           ctrl.getMatches);
router.get('/results',    ctrl.getResults);
router.post('/',          authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.createMatch);
router.get('/:id',        ctrl.getMatch);
router.put('/:id',        authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.updateMatch);
router.delete('/:id',     authorize('CLUB_ADMIN'), ctrl.deleteMatch);

export default router;
