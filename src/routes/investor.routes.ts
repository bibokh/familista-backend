// Familista — Global Investor Layer
// File location: src/routes/investor.routes.ts
//
// Mount under /api/v1/investor. Every route is authenticated; per-entity /
// per-investor access is enforced inside the controllers via assertEntityAccess
// and assertInvestorAccess so that platform admins, investors, and
// out-of-scope users see different surfaces of the same endpoints.

import { Router } from 'express';

import * as ctrl from '../controllers/investor.controller';
import { authenticate } from '../middleware/auth.middleware';
import { attachInvestorContext, requireInvestorContext } from '../middleware/investor-access.middleware';

const router = Router();

router.use(authenticate, attachInvestorContext, requireInvestorContext);

// ── Profiles + KYC ──────────────────────────────────────────────────────────
router.get('/profiles', ctrl.listProfiles);
router.get('/profiles/me', ctrl.getMyProfile);
router.post('/profiles', ctrl.createProfile);
router.get('/profiles/:id', ctrl.getProfile);
router.patch('/profiles/:id', ctrl.updateProfile);
router.post('/profiles/:id/kyc', ctrl.updateKycStatus);

// ── Investment entities + share classes ─────────────────────────────────────
router.get('/entities', ctrl.listEntities);
router.post('/entities', ctrl.createEntity);
router.get('/entities/:id', ctrl.getEntity);
router.patch('/entities/:id', ctrl.updateEntity);
router.post('/entities/:id/valuation', ctrl.setValuation);

router.get('/entities/:id/share-classes', ctrl.listShareClasses);
router.post('/entities/:id/share-classes', ctrl.createShareClass);
router.patch('/share-classes/:classId', ctrl.updateShareClass);

// ── Rounds ──────────────────────────────────────────────────────────────────
router.get('/rounds', ctrl.listRounds);
router.post('/entities/:entityId/rounds', ctrl.createRound);
router.get('/rounds/:id', ctrl.getRound);
router.patch('/rounds/:id', ctrl.updateRound);
router.post('/rounds/:id/open', ctrl.openRound);
router.post('/rounds/:id/close', ctrl.closeRound);
router.post('/rounds/:id/cancel', ctrl.cancelRound);
router.post('/rounds/:id/convert-safes', ctrl.convertSafes);

// ── Investments ─────────────────────────────────────────────────────────────
router.get('/investments', ctrl.listInvestments);
router.post('/investments', ctrl.createInvestment);
router.get('/investments/:id', ctrl.getInvestment);
router.post('/investments/:id/fund', ctrl.fundInvestment);
router.post('/investments/:id/cancel', ctrl.cancelInvestment);

// ── Cap table + share transfers ─────────────────────────────────────────────
router.get('/entities/:id/cap-table', ctrl.getCapTable);
router.get('/entities/:id/cap-table/dilution', ctrl.previewDilution);

router.get('/share-transfers', ctrl.listShareTransfers);
router.post('/entities/:id/share-transfers', ctrl.initiateShareTransfer);
router.post('/share-transfers/:transferId/approve', ctrl.approveShareTransfer);
router.post('/share-transfers/:transferId/execute', ctrl.executeShareTransfer);
router.post('/share-transfers/:transferId/cancel', ctrl.cancelShareTransfer);

// ── Governance — rights + board ─────────────────────────────────────────────
router.get('/rights', ctrl.listRights);
router.post('/entities/:entityId/rights', ctrl.grantRight);
router.patch('/rights/:rightId', ctrl.updateRight);
router.delete('/rights/:rightId', ctrl.revokeRight);

router.get('/board-seats', ctrl.listBoardSeats);
router.post('/entities/:entityId/board-seats', ctrl.appointBoardSeat);
router.post('/board-seats/:seatId/vacate', ctrl.vacateBoardSeat);

router.get('/entities/:id/governance', ctrl.getGovernanceSummary);

// ── Agreements ──────────────────────────────────────────────────────────────
router.get('/agreements', ctrl.listAgreements);
router.post('/entities/:entityId/agreements', ctrl.createAgreement);
router.get('/agreements/:id', ctrl.getAgreement);
router.patch('/agreements/:id', ctrl.updateAgreement);
router.post('/agreements/:id/submit', ctrl.submitAgreement);
router.post('/agreements/:id/sign', ctrl.signAgreement);
router.post('/agreements/:id/terminate', ctrl.terminateAgreement);

// ── Exits + waterfall ───────────────────────────────────────────────────────
router.get('/exits', ctrl.listExits);
router.post('/entities/:entityId/exits', ctrl.createExit);
router.get('/exits/:id', ctrl.getExit);
router.post('/exits/:id/decide', ctrl.decideExit);
router.get('/exits/:id/waterfall', ctrl.computeWaterfall);
router.post('/exits/:id/execute', ctrl.executeExit);
router.get('/entities/:id/waterfall-preview', ctrl.previewWaterfall);

// ── Distributions ───────────────────────────────────────────────────────────
router.get('/distributions', ctrl.listDistributions);
router.post('/distributions', ctrl.recordDistribution);
router.post('/distributions/:id/pay', ctrl.payDistribution);
router.post('/distributions/:id/reverse', ctrl.reverseDistribution);

// ── Performance dashboard ───────────────────────────────────────────────────
router.get('/profiles/:id/portfolio', ctrl.getPortfolio);
router.get('/profiles/:id/dashboard', ctrl.getDashboard);
router.get('/dashboard/me', ctrl.getMyDashboard);
router.get('/entities/:id/roll-up', ctrl.getEntityRollUp);

// ── Executive PDF reports ───────────────────────────────────────────────────
router.get('/profiles/:id/statement.pdf', ctrl.downloadStatement);
router.get('/entities/:id/cap-table.pdf', ctrl.downloadCapTableReport);

// ── Audit ───────────────────────────────────────────────────────────────────
router.get('/audit', ctrl.searchAudit);

// ── Bootstrap ───────────────────────────────────────────────────────────────
router.post('/bootstrap/platform-entity', ctrl.ensurePlatformEntity);

export default router;
