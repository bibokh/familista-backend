import { Router } from 'express';
import * as ctrl from '../controllers/training.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

router.get('/',       ctrl.getSessions);
router.get('/form',   ctrl.getForm);
router.post('/',      authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.createSession);
router.get('/:id',    ctrl.getSession);
router.put('/:id',    authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.updateSession);
router.patch('/:id',  authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.updateSession);
router.delete('/:id', authorize('CLUB_ADMIN'), ctrl.deleteSession);

export default router;
