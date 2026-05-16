// Familista — Franchise Expansion Engine
// File location: src/controllers/franchise.controller.ts
//
// Consolidated HTTP handlers for the franchise stack. Sections (ToC):
//   1. Territory + territory rights
//   2. Franchise units
//   3. Owners, ownerships, cap-table
//   4. Transfers
//   5. Expansion requests
//   6. Acquisition workflow
//   7. Revenue split rules
//   8. Revenue distributions
//   9. Contracts
//  10. Renewals + terminations
//  11. Violations + compliance
//  12. Performance dashboard
//  13. Audit
//  14. Seed

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import * as territory from '../services/franchise-territory.service';
import * as unit from '../services/franchise-unit.service';
import * as ownership from '../services/franchise-ownership.service';
import * as expansion from '../services/franchise-expansion.service';
import * as revenue from '../services/franchise-revenue.service';
import * as contract from '../services/franchise-contract.service';
import * as compliance from '../services/franchise-compliance.service';
import * as performance from '../services/franchise-performance.service';
import * as audit from '../services/franchise-audit.service';
import { seedSystemTerritories } from '../data/franchise-seed';

import {
  assertUnitAccess,
  effectiveScopeForReads,
} from '../middleware/franchise-access.middleware';

import {
  createTerritorySchema,
  updateTerritorySchema,
  createFranchiseUnitSchema,
  updateFranchiseUnitSchema,
  setUnitStatusSchema,
  createOwnerSchema,
  updateOwnerSchema,
  grantOwnershipSchema,
  revokeOwnershipSchema,
  initiateTransferSchema,
  cancelTransferSchema,
  grantTerritoryRightSchema,
  updateTerritoryRightSchema,
  createExpansionRequestSchema,
  decideExpansionRequestSchema,
  completeExpansionRequestSchema,
  createAcquisitionRequestSchema,
  decideAcquisitionSchema,
  upsertRevenueSplitRuleSchema,
  recordDistributionSchema,
  reverseDistributionSchema,
  distributionQuerySchema,
  createContractSchema,
  updateContractSchema,
  signContractSchema,
  requestRenewalSchema,
  decideRenewalSchema,
  initiateTerminationSchema,
  decideTerminationSchema,
  reportViolationSchema,
  updateViolationSchema,
  upsertComplianceCheckSchema,
  generateSnapshotSchema,
  auditQuerySchema,
} from '../utils/franchise.validators';

import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { BadRequestError, ForbiddenError } from '../utils/errors';

function actorOf(req: Request) {
  if (!req.franchiseActor) throw new ForbiddenError('Franchise context required');
  return req.franchiseActor;
}
function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.join('.') || 'body'}: ${e.message}`).join(', '));
}

// ─── 1. Territory ────────────────────────────────────────────────────────────

export async function listTerritories(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await territory.listTerritories({
      type: req.query.type as never,
      parentId: req.query.parentId === 'null' ? null : (req.query.parentId as string | undefined),
      search: req.query.search as string | undefined,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getTerritoryTree(req: Request, res: Response, next: NextFunction) {
  try {
    const root = (req.query.rootId as string | undefined) ?? null;
    return sendSuccess(res, await territory.getTerritoryTree(root));
  } catch (err) { return next(err); }
}

export async function getTerritoryPath(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await territory.getTerritoryPath(req.params.id)); }
  catch (err) { return next(err); }
}

export async function createTerritory(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Only platform admins may create territories');
    const input = createTerritorySchema.parse(req.body);
    return sendCreated(res, await territory.createTerritory(actor, input), 'Territory created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateTerritory(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Only platform admins may update territories');
    const input = updateTerritorySchema.parse(req.body);
    return sendSuccess(res, await territory.updateTerritory(actor, req.params.id, input), 'Territory updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function deleteTerritory(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Only platform admins may delete territories');
    await territory.deleteTerritory(actor, req.params.id);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

export async function listExpansionOpportunities(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await territory.listExpansionOpportunities({
      type: req.query.type as never,
      parentId: req.query.parentId as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function listTerritoryRights(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await territory.listTerritoryRights({
      unitId: req.query.unitId as string | undefined,
      territoryId: req.query.territoryId as string | undefined,
      type: req.query.type as never,
      activeOnly: req.query.activeOnly === 'false' ? false : true,
    }));
  } catch (err) { return next(err); }
}

export async function grantTerritoryRight(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.unitId, 'write');
    const input = grantTerritoryRightSchema.parse(req.body);
    return sendCreated(res, await territory.grantTerritoryRight(actor, req.params.unitId, input), 'Territory right granted');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateTerritoryRight(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = updateTerritoryRightSchema.parse(req.body);
    return sendSuccess(res, await territory.updateTerritoryRight(actor, req.params.rightId, input), 'Territory right updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function revokeTerritoryRight(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await territory.revokeTerritoryRight(actor, req.params.rightId);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

// ─── 2. Franchise units ──────────────────────────────────────────────────────

export async function listUnits(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await unit.listUnits({
      level: req.query.level as never,
      status: req.query.status as never,
      parentUnitId: req.query.parentUnitId === 'null' ? null : (req.query.parentUnitId as string | undefined),
      territoryId: req.query.territoryId as string | undefined,
      search: req.query.search as string | undefined,
      scopeUnitIds: effectiveScopeForReads(actor),
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getUnit(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'read');
    return sendSuccess(res, await unit.getUnit(req.params.id));
  } catch (err) { return next(err); }
}

export async function getUnitTree(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'read');
    const depth = req.query.depth ? Math.min(Math.max(Number(req.query.depth), 1), 6) : 4;
    return sendSuccess(res, await unit.getUnitTree(req.params.id, depth));
  } catch (err) { return next(err); }
}

export async function createUnit(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = createFranchiseUnitSchema.parse(req.body);
    if (input.parentUnitId) assertUnitAccess(actor, input.parentUnitId, 'write');
    else if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Only platform admins may create top-level units');
    return sendCreated(res, await unit.createUnit(actor, input), 'Unit created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateUnit(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'write');
    const input = updateFranchiseUnitSchema.parse(req.body);
    return sendSuccess(res, await unit.updateUnit(actor, req.params.id, input), 'Unit updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function setUnitStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'write');
    const input = setUnitStatusSchema.parse(req.body);
    return sendSuccess(res, await unit.setUnitStatus(actor, req.params.id, input), 'Unit status changed');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function attachClub(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'write');
    const clubId = String(req.body?.clubId ?? '');
    if (!clubId) throw new BadRequestError('clubId required');
    await unit.attachClub(actor, req.params.id, clubId);
    return sendSuccess(res, { unitId: req.params.id, clubId }, 'Club attached');
  } catch (err) { return next(err); }
}

export async function detachClub(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'write');
    await unit.detachClub(actor, req.params.id, req.params.clubId);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

// ─── 3. Owners + ownerships + cap table ──────────────────────────────────────

export async function listOwners(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await ownership.listOwners({
      type: req.query.type as never,
      search: req.query.search as string | undefined,
      activeOnly: req.query.activeOnly === 'false' ? false : true,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getOwner(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await ownership.getOwner(req.params.id)); }
  catch (err) { return next(err); }
}

export async function createOwner(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Only platform admins may create owner records');
    const input = createOwnerSchema.parse(req.body);
    return sendCreated(res, await ownership.createOwner(actor, input), 'Owner created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateOwner(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Only platform admins may update owner records');
    const input = updateOwnerSchema.parse(req.body);
    return sendSuccess(res, await ownership.updateOwner(actor, req.params.id, input), 'Owner updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function getCapTable(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'read');
    const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : undefined;
    return sendSuccess(res, await ownership.getCapTable(req.params.id, asOf));
  } catch (err) { return next(err); }
}

export async function grantOwnership(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'primary');
    const input = grantOwnershipSchema.parse(req.body);
    return sendCreated(res, await ownership.grantOwnership(actor, req.params.id, input), 'Ownership granted');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function revokeOwnership(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = revokeOwnershipSchema.parse(req.body);
    return sendSuccess(res, await ownership.revokeOwnership(actor, req.params.ownershipId, input), 'Ownership revoked');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 4. Transfers ────────────────────────────────────────────────────────────

export async function listTransfers(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await ownership.listTransfers({
      unitId: req.query.unitId as string | undefined,
      ownerId: req.query.ownerId as string | undefined,
      status: req.query.status as never,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function initiateTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'primary');
    const input = initiateTransferSchema.parse(req.body);
    return sendCreated(res, await ownership.initiateTransfer(actor, req.params.id, input), 'Transfer initiated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function approveTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await ownership.approveTransfer(actor, req.params.transferId), 'Transfer approved');
  } catch (err) { return next(err); }
}

export async function executeTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await ownership.executeTransfer(actor, req.params.transferId), 'Transfer executed');
  } catch (err) { return next(err); }
}

export async function cancelTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = cancelTransferSchema.parse(req.body);
    return sendSuccess(res, await ownership.cancelTransfer(actor, req.params.transferId, input), 'Transfer cancelled');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 5. Expansion requests ──────────────────────────────────────────────────

export async function listExpansionRequests(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await expansion.listExpansionRequests({
      requestingUnitId: req.query.requestingUnitId as string | undefined,
      status: req.query.status as never,
      scopeUnitIds: effectiveScopeForReads(actor),
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function createExpansionRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = createExpansionRequestSchema.parse(req.body);
    assertUnitAccess(actor, input.requestingUnitId, 'write');
    return sendCreated(res, await expansion.createExpansionRequest(actor, input), 'Expansion request created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function decideExpansionRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = decideExpansionRequestSchema.parse(req.body);
    return sendSuccess(res, await expansion.decideExpansionRequest(actor, req.params.id, input), 'Decision recorded');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function completeExpansionRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = completeExpansionRequestSchema.parse(req.body);
    return sendSuccess(res, await expansion.completeExpansionRequest(actor, req.params.id, input), 'Expansion completed');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 6. Acquisitions ────────────────────────────────────────────────────────

export async function listAcquisitions(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await expansion.listAcquisitionRequests({
      targetUnitId: req.query.targetUnitId as string | undefined,
      acquirerOwnerId: req.query.acquirerOwnerId as string | undefined,
      status: req.query.status as never,
      scopeUnitIds: effectiveScopeForReads(actor),
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function createAcquisition(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = createAcquisitionRequestSchema.parse(req.body);
    return sendCreated(res, await expansion.createAcquisitionRequest(actor, input), 'Acquisition request created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function submitAcquisition(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await expansion.submitAcquisitionRequest(actor, req.params.id), 'Acquisition submitted');
  } catch (err) { return next(err); }
}

export async function decideAcquisition(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = decideAcquisitionSchema.parse(req.body);
    return sendSuccess(res, await expansion.decideAcquisition(actor, req.params.id, input), 'Acquisition decided');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 7. Revenue split rules ─────────────────────────────────────────────────

export async function listSplitRules(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await revenue.listSplitRules({
      unitId: req.query.unitId as string | undefined,
      activeOnly: req.query.activeOnly === 'false' ? false : true,
      category: req.query.category as never,
      scopeUnitIds: effectiveScopeForReads(actor),
    }));
  } catch (err) { return next(err); }
}

export async function getSplitRule(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await revenue.getSplitRule(req.params.id)); }
  catch (err) { return next(err); }
}

export async function createSplitRule(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.unitId, 'write', { category: 'REVENUE' });
    const input = upsertRevenueSplitRuleSchema.parse(req.body);
    return sendCreated(res, await revenue.createSplitRule(actor, req.params.unitId, input), 'Split rule created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateSplitRule(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = upsertRevenueSplitRuleSchema.parse(req.body);
    return sendSuccess(res, await revenue.updateSplitRule(actor, req.params.id, input), 'Split rule updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function deactivateSplitRule(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await revenue.deactivateSplitRule(actor, req.params.id), 'Split rule deactivated');
  } catch (err) { return next(err); }
}

// ─── 8. Distributions ───────────────────────────────────────────────────────

export async function previewDistribution(req: Request, res: Response, next: NextFunction) {
  try {
    const input = recordDistributionSchema.parse(req.body);
    return sendSuccess(res, await revenue.previewDistribution(input));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function recordDistribution(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = recordDistributionSchema.parse(req.body);
    assertUnitAccess(actor, input.unitId, 'write', { category: 'REVENUE' });
    return sendCreated(res, await revenue.computeAndRecordDistribution(actor, input), 'Distribution recorded');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function executeDistribution(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await revenue.executeDistribution(actor, req.params.id), 'Distribution executed');
  } catch (err) { return next(err); }
}

export async function reverseDistribution(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = reverseDistributionSchema.parse(req.body);
    return sendSuccess(res, await revenue.reverseDistribution(actor, req.params.id, input), 'Distribution reversed');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function searchDistributions(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const q = distributionQuerySchema.parse(req.query);
    return sendSuccess(res, await revenue.searchDistributions(q, effectiveScopeForReads(actor)));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function getDistribution(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await revenue.getDistribution(req.params.id)); }
  catch (err) { return next(err); }
}

export async function getUnitRevenueSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'read');
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    return sendSuccess(res, await revenue.getUnitRevenueSummary(req.params.id, from, to));
  } catch (err) { return next(err); }
}

// ─── 9. Contracts ────────────────────────────────────────────────────────────

export async function listContracts(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await contract.listContracts({
      unitId: req.query.unitId as string | undefined,
      status: req.query.status as never,
      type: req.query.type as never,
      scopeUnitIds: effectiveScopeForReads(actor),
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getContract(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await contract.getContract(req.params.id)); }
  catch (err) { return next(err); }
}

export async function createContract(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.unitId, 'write');
    const input = createContractSchema.parse(req.body);
    return sendCreated(res, await contract.createContract(actor, req.params.unitId, input), 'Contract created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateContract(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = updateContractSchema.parse(req.body);
    return sendSuccess(res, await contract.updateContract(actor, req.params.id, input), 'Contract updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function submitForSignature(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await contract.submitForSignature(actor, req.params.id), 'Contract submitted for signature');
  } catch (err) { return next(err); }
}

export async function signContract(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = signContractSchema.parse(req.body);
    return sendSuccess(res, await contract.signContract(actor, req.params.id, input), 'Contract signed');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 10. Renewals + terminations ────────────────────────────────────────────

export async function requestRenewal(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = requestRenewalSchema.parse(req.body);
    return sendCreated(res, await contract.requestRenewal(actor, req.params.id, input), 'Renewal requested');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function decideRenewal(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = decideRenewalSchema.parse(req.body);
    return sendSuccess(res, await contract.decideRenewal(actor, req.params.renewalId, input), 'Renewal decision recorded');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function executeRenewal(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await contract.executeRenewal(actor, req.params.renewalId), 'Renewal executed');
  } catch (err) { return next(err); }
}

export async function initiateTermination(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = initiateTerminationSchema.parse(req.body);
    return sendCreated(res, await contract.initiateTermination(actor, req.params.id, input), 'Termination initiated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function decideTermination(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = decideTerminationSchema.parse(req.body);
    return sendSuccess(res, await contract.decideTermination(actor, req.params.terminationId, input), 'Termination decision recorded');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function executeTermination(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await contract.executeTermination(actor, req.params.terminationId), 'Termination executed');
  } catch (err) { return next(err); }
}

// ─── 11. Violations + compliance ────────────────────────────────────────────

export async function listViolations(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await compliance.listViolations({
      unitId: req.query.unitId as string | undefined,
      status: req.query.status as never,
      severity: req.query.severity as never,
      scopeUnitIds: effectiveScopeForReads(actor),
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function reportViolation(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'write');
    const input = reportViolationSchema.parse(req.body);
    return sendCreated(res, await compliance.reportViolation(actor, req.params.id, input), 'Violation reported');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateViolation(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = updateViolationSchema.parse(req.body);
    return sendSuccess(res, await compliance.updateViolation(actor, req.params.violationId, input), 'Violation updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function listComplianceChecks(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'read');
    return sendSuccess(res, await compliance.listComplianceChecks({
      unitId: req.params.id,
      category: req.query.category as never,
      period: req.query.period as string | undefined,
    }));
  } catch (err) { return next(err); }
}

export async function upsertComplianceCheck(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'write');
    const input = upsertComplianceCheckSchema.parse(req.body);
    return sendSuccess(res, await compliance.upsertComplianceCheck(actor, req.params.id, input), 'Compliance check recorded');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function getComplianceSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'read');
    return sendSuccess(res, await compliance.getComplianceSummary(req.params.id));
  } catch (err) { return next(err); }
}

// ─── 12. Performance ─────────────────────────────────────────────────────────

export async function getLivePerformance(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'read');
    const period = String(req.query.period ?? 'current');
    const periodStartAt = new Date(String(req.query.periodStartAt ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)));
    const periodEndAt = new Date(String(req.query.periodEndAt ?? new Date()));
    const includeDescendants = req.query.includeDescendants === 'false' ? false : true;
    return sendSuccess(res, await performance.getLivePerformance(req.params.id, {
      period, periodStartAt, periodEndAt, includeDescendants,
    }));
  } catch (err) { return next(err); }
}

export async function generateSnapshot(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'write');
    const input = generateSnapshotSchema.parse(req.body);
    return sendCreated(res, await performance.generateSnapshot(actor, req.params.id, input), 'Snapshot generated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function listSnapshots(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertUnitAccess(actor, req.params.id, 'read');
    const limit = req.query.limit ? Number(req.query.limit) : 24;
    return sendSuccess(res, await performance.listSnapshots(req.params.id, limit));
  } catch (err) { return next(err); }
}

export async function getNetworkHealth(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Network-wide stats require platform-admin access');
    return sendSuccess(res, await performance.getNetworkHealth());
  } catch (err) { return next(err); }
}

// ─── 13. Audit ───────────────────────────────────────────────────────────────

export async function searchAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const q = auditQuerySchema.parse(req.query);
    return sendSuccess(res, await audit.searchAudit(q, effectiveScopeForReads(actor)));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function summarizeAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const q = auditQuerySchema.parse(req.query);
    return sendSuccess(res, await audit.summarizeAudit(q, effectiveScopeForReads(actor)));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 14. Seed ────────────────────────────────────────────────────────────────

export async function seedTerritories(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Only platform admins may seed system territories');
    const result = await seedSystemTerritories();
    return sendSuccess(res, result, 'System territories seeded');
  } catch (err) { return next(err); }
}
