// Familista — Franchise Expansion Engine
// File location: src/routes/franchise.routes.ts
//
// Mount under /api/v1/franchise. Every route requires auth + franchise context;
// per-unit access is enforced inside controllers via assertUnitAccess so it can
// vary by mode (read | write | primary).

import { Router } from 'express';

import * as ctrl from '../controllers/franchise.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { attachFranchiseContext, requireFranchiseContext } from '../middleware/franchise-access.middleware';

const router = Router();

router.use(authenticate, attachFranchiseContext, requireFranchiseContext);

// ── Territories ─────────────────────────────────────────────────────────────
router.get('/territories', ctrl.listTerritories);
router.get('/territories/tree', ctrl.getTerritoryTree);
router.get('/territories/opportunities', ctrl.listExpansionOpportunities);
router.get('/territories/:id', ctrl.getTerritoryPath);
router.post('/territories', ctrl.createTerritory);
router.patch('/territories/:id', ctrl.updateTerritory);
router.delete('/territories/:id', ctrl.deleteTerritory);

// ── Territory rights ────────────────────────────────────────────────────────
router.get('/territory-rights', ctrl.listTerritoryRights);
router.post('/units/:unitId/territory-rights', ctrl.grantTerritoryRight);
router.patch('/territory-rights/:rightId', ctrl.updateTerritoryRight);
router.delete('/territory-rights/:rightId', ctrl.revokeTerritoryRight);

// ── Units ───────────────────────────────────────────────────────────────────
router.get('/units', ctrl.listUnits);
router.post('/units', ctrl.createUnit);
router.get('/units/:id', ctrl.getUnit);
router.get('/units/:id/tree', ctrl.getUnitTree);
router.patch('/units/:id', ctrl.updateUnit);
router.post('/units/:id/status', ctrl.setUnitStatus);
router.post('/units/:id/clubs', ctrl.attachClub);
router.delete('/units/:id/clubs/:clubId', ctrl.detachClub);

// ── Owners + ownership + cap table ──────────────────────────────────────────
router.get('/owners', ctrl.listOwners);
router.post('/owners', ctrl.createOwner);
router.get('/owners/:id', ctrl.getOwner);
router.patch('/owners/:id', ctrl.updateOwner);

router.get('/units/:id/cap-table', ctrl.getCapTable);
router.post('/units/:id/ownerships', ctrl.grantOwnership);
router.post('/ownerships/:ownershipId/revoke', ctrl.revokeOwnership);

// ── Transfers ───────────────────────────────────────────────────────────────
router.get('/transfers', ctrl.listTransfers);
router.post('/units/:id/transfers', ctrl.initiateTransfer);
router.post('/transfers/:transferId/approve', ctrl.approveTransfer);
router.post('/transfers/:transferId/execute', ctrl.executeTransfer);
router.post('/transfers/:transferId/cancel', ctrl.cancelTransfer);

// ── Expansion requests ──────────────────────────────────────────────────────
router.get('/expansion-requests', ctrl.listExpansionRequests);
router.post('/expansion-requests', ctrl.createExpansionRequest);
router.post('/expansion-requests/:id/decide', ctrl.decideExpansionRequest);
router.post('/expansion-requests/:id/complete', ctrl.completeExpansionRequest);

// ── Acquisitions ────────────────────────────────────────────────────────────
router.get('/acquisitions', ctrl.listAcquisitions);
router.post('/acquisitions', ctrl.createAcquisition);
router.post('/acquisitions/:id/submit', ctrl.submitAcquisition);
router.post('/acquisitions/:id/decide', ctrl.decideAcquisition);

// ── Revenue split rules ─────────────────────────────────────────────────────
router.get('/split-rules', ctrl.listSplitRules);
router.get('/split-rules/:id', ctrl.getSplitRule);
router.post('/units/:unitId/split-rules', ctrl.createSplitRule);
router.put('/split-rules/:id', ctrl.updateSplitRule);
router.post('/split-rules/:id/deactivate', ctrl.deactivateSplitRule);

// ── Distributions ───────────────────────────────────────────────────────────
router.get('/distributions', ctrl.searchDistributions);
router.post('/distributions/preview', ctrl.previewDistribution);
router.post('/distributions', ctrl.recordDistribution);
router.get('/distributions/:id', ctrl.getDistribution);
router.post('/distributions/:id/execute', ctrl.executeDistribution);
router.post('/distributions/:id/reverse', ctrl.reverseDistribution);
router.get('/units/:id/revenue-summary', ctrl.getUnitRevenueSummary);

// ── Contracts ───────────────────────────────────────────────────────────────
router.get('/contracts', ctrl.listContracts);
router.post('/units/:unitId/contracts', ctrl.createContract);
router.get('/contracts/:id', ctrl.getContract);
router.patch('/contracts/:id', ctrl.updateContract);
router.post('/contracts/:id/submit', ctrl.submitForSignature);
router.post('/contracts/:id/sign', ctrl.signContract);

// ── Renewals + terminations ─────────────────────────────────────────────────
router.post('/contracts/:id/renewals', ctrl.requestRenewal);
router.post('/renewals/:renewalId/decide', ctrl.decideRenewal);
router.post('/renewals/:renewalId/execute', ctrl.executeRenewal);
router.post('/contracts/:id/terminations', ctrl.initiateTermination);
router.post('/terminations/:terminationId/decide', ctrl.decideTermination);
router.post('/terminations/:terminationId/execute', ctrl.executeTermination);

// ── Violations + compliance ─────────────────────────────────────────────────
router.get('/violations', ctrl.listViolations);
router.post('/units/:id/violations', ctrl.reportViolation);
router.patch('/violations/:violationId', ctrl.updateViolation);
router.get('/units/:id/compliance', ctrl.listComplianceChecks);
router.put('/units/:id/compliance', ctrl.upsertComplianceCheck);
router.get('/units/:id/compliance/summary', ctrl.getComplianceSummary);

// ── Performance ─────────────────────────────────────────────────────────────
router.get('/units/:id/performance', ctrl.getLivePerformance);
router.post('/units/:id/performance/snapshot', ctrl.generateSnapshot);
router.get('/units/:id/performance/snapshots', ctrl.listSnapshots);
router.get('/network/health', authorize('SUPER_ADMIN'), ctrl.getNetworkHealth);

// ── Audit ───────────────────────────────────────────────────────────────────
router.get('/audit', ctrl.searchAudit);
router.get('/audit/summary', ctrl.summarizeAudit);

// ── Bootstrap seeds ─────────────────────────────────────────────────────────
router.post('/seed/territories', ctrl.seedTerritories);

export default router;
