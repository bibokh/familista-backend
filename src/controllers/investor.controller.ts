// Familista — Global Investor Layer
// File location: src/controllers/investor.controller.ts
//
// HTTP handlers for the investor stack. Sections (ToC):
//   1. Investor profiles + KYC
//   2. Investment entities + share classes + valuations
//   3. Rounds
//   4. Investments + SAFE conversion
//   5. Cap table + share transfers + dilution preview
//   6. Governance — rights + board seats
//   7. Agreements
//   8. Exits + waterfall
//   9. Distributions
//  10. Performance dashboard + entity roll-ups
//  11. Executive PDF reports
//  12. Audit
//  13. Bootstrap

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import * as profileSvc from '../services/investor-profile.service';
import * as entitySvc from '../services/investor-entity.service';
import * as roundSvc from '../services/investor-round.service';
import * as investmentSvc from '../services/investor-investment.service';
import * as captableSvc from '../services/investor-captable.service';
import * as governanceSvc from '../services/investor-governance.service';
import * as agreementSvc from '../services/investor-agreement.service';
import * as exitSvc from '../services/investor-exit.service';
import * as distributionSvc from '../services/investor-distribution.service';
import * as performanceSvc from '../services/investor-performance.service';
import * as pdfSvc from '../services/investor-pdf.service';
import * as auditSvc from '../services/investor-audit.service';

import {
  assertEntityAccess,
  assertInvestorAccess,
  effectiveEntityScope,
  effectiveInvestorScope,
} from '../middleware/investor-access.middleware';

import {
  createInvestorProfileSchema,
  updateInvestorProfileSchema,
  updateKycStatusSchema,
  createInvestmentEntitySchema,
  updateInvestmentEntitySchema,
  setValuationSchema,
  createShareClassSchema,
  updateShareClassSchema,
  createRoundSchema,
  updateRoundSchema,
  openRoundSchema,
  closeRoundSchema,
  createInvestmentSchema,
  fundInvestmentSchema,
  cancelInvestmentSchema,
  initiateShareTransferSchema,
  cancelShareTransferSchema,
  grantRightSchema,
  updateRightSchema,
  appointBoardSeatSchema,
  vacateBoardSeatSchema,
  createAgreementSchema,
  updateAgreementSchema,
  signAgreementSchema,
  createExitSchema,
  decideExitSchema,
  recordInvestorDistributionSchema,
  auditQuerySchema,
} from '../utils/investor.validators';

import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { BadRequestError, ForbiddenError } from '../utils/errors';

function actorOf(req: Request) {
  if (!req.investorActor) throw new ForbiddenError('Investor context required');
  return req.investorActor;
}
function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.join('.') || 'body'}: ${e.message}`).join(', '));
}

// ─── 1. Investor profiles + KYC ──────────────────────────────────────────────

export async function listProfiles(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    return sendSuccess(res, await profileSvc.listProfiles({
      type: req.query.type as never,
      kycStatus: req.query.kycStatus as never,
      countryCode: req.query.countryCode as string | undefined,
      search: req.query.search as string | undefined,
      activeOnly: req.query.activeOnly === 'false' ? false : true,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getMyProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (actor.scope.isPlatformAdmin) {
      return sendSuccess(res, { isPlatformAdmin: true, investorId: null });
    }
    if (!actor.scope.investorId) {
      return sendSuccess(res, null);
    }
    return sendSuccess(res, await profileSvc.getProfile(actor.scope.investorId));
  } catch (err) { return next(err); }
}

export async function getProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertInvestorAccess(actor, req.params.id, 'read');
    return sendSuccess(res, await profileSvc.getProfile(req.params.id));
  } catch (err) { return next(err); }
}

export async function createProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = createInvestorProfileSchema.parse(req.body);
    return sendCreated(res, await profileSvc.createProfile(actor, input), 'Investor profile created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = updateInvestorProfileSchema.parse(req.body);
    return sendSuccess(res, await profileSvc.updateProfile(actor, req.params.id, input), 'Investor profile updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateKycStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = updateKycStatusSchema.parse(req.body);
    return sendSuccess(res, await profileSvc.updateKycStatus(actor, req.params.id, input), 'KYC status updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 2. Investment entities + share classes ──────────────────────────────────

export async function listEntities(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await entitySvc.listEntities({
      type: req.query.type as never,
      search: req.query.search as string | undefined,
      scopeEntityIds: effectiveEntityScope(actor),
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getEntity(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertEntityAccess(actor, req.params.id, 'read');
    return sendSuccess(res, await entitySvc.getEntity(req.params.id));
  } catch (err) { return next(err); }
}

export async function createEntity(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = createInvestmentEntitySchema.parse(req.body);
    return sendCreated(res, await entitySvc.createEntity(actor, input), 'Investment entity created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateEntity(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = updateInvestmentEntitySchema.parse(req.body);
    return sendSuccess(res, await entitySvc.updateEntity(actor, req.params.id, input), 'Entity updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function setValuation(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = setValuationSchema.parse(req.body);
    return sendSuccess(res, await entitySvc.setValuation(actor, req.params.id, input), 'Valuation updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function listShareClasses(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertEntityAccess(actor, req.params.id, 'read');
    return sendSuccess(res, await entitySvc.listShareClasses(req.params.id));
  } catch (err) { return next(err); }
}

export async function createShareClass(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = createShareClassSchema.parse(req.body);
    return sendCreated(res, await entitySvc.createShareClass(actor, req.params.id, input), 'Share class created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateShareClass(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = updateShareClassSchema.parse(req.body);
    return sendSuccess(res, await entitySvc.updateShareClass(actor, req.params.classId, input), 'Share class updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 3. Rounds ───────────────────────────────────────────────────────────────

export async function listRounds(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await roundSvc.listRounds({
      entityId: req.query.entityId as string | undefined,
      status: req.query.status as never,
      type: req.query.type as never,
      scopeEntityIds: effectiveEntityScope(actor),
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getRound(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await roundSvc.getRound(req.params.id)); }
  catch (err) { return next(err); }
}

export async function createRound(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = createRoundSchema.parse(req.body);
    return sendCreated(res, await roundSvc.createRound(actor, req.params.entityId, input), 'Round created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateRound(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = updateRoundSchema.parse(req.body);
    return sendSuccess(res, await roundSvc.updateRound(actor, req.params.id, input), 'Round updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function openRound(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = openRoundSchema.parse(req.body ?? {});
    return sendSuccess(res, await roundSvc.openRound(actor, req.params.id, input), 'Round opened');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function closeRound(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = closeRoundSchema.parse(req.body ?? {});
    return sendSuccess(res, await roundSvc.closeRound(actor, req.params.id, input), 'Round closed');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function cancelRound(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const reason = String(req.body?.reason ?? '');
    if (!reason) throw new BadRequestError('reason required');
    return sendSuccess(res, await roundSvc.cancelRound(actor, req.params.id, reason), 'Round cancelled');
  } catch (err) { return next(err); }
}

export async function convertSafes(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    return sendSuccess(res, await investmentSvc.convertOutstandingSafes(actor, req.params.id), 'SAFEs converted');
  } catch (err) { return next(err); }
}

// ─── 4. Investments ──────────────────────────────────────────────────────────

export async function listInvestments(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await investmentSvc.listInvestments({
      investorId: req.query.investorId as string | undefined,
      entityId: req.query.entityId as string | undefined,
      roundId: req.query.roundId as string | undefined,
      instrumentType: req.query.instrumentType as never,
      status: req.query.status as never,
      scopeInvestorId: effectiveInvestorScope(actor),
      scopeEntityIds: effectiveEntityScope(actor),
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getInvestment(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const inv = await investmentSvc.getInvestment(req.params.id);
    if (!actor.scope.isPlatformAdmin) {
      if (actor.scope.investorId !== inv.investorId && !actor.scope.ownedEntityIds.has(inv.entityId)) {
        throw new ForbiddenError('Investment is outside your scope');
      }
    }
    return sendSuccess(res, inv);
  } catch (err) { return next(err); }
}

export async function createInvestment(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = createInvestmentSchema.parse(req.body);
    return sendCreated(res, await investmentSvc.createInvestment(actor, input), 'Investment committed');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function fundInvestment(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = fundInvestmentSchema.parse(req.body);
    return sendSuccess(res, await investmentSvc.fundInvestment(actor, req.params.id, input), 'Investment funded');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function cancelInvestment(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = cancelInvestmentSchema.parse(req.body);
    return sendSuccess(res, await investmentSvc.cancelInvestment(actor, req.params.id, input), 'Investment cancelled');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 5. Cap table + share transfers ──────────────────────────────────────────

export async function getCapTable(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertEntityAccess(actor, req.params.id, 'read');
    const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : undefined;
    return sendSuccess(res, await captableSvc.getCapTable(req.params.id, asOf));
  } catch (err) { return next(err); }
}

export async function previewDilution(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertEntityAccess(actor, req.params.id, 'read');
    const sharesToIssue = Number(req.query.shares ?? 0);
    const pricePerShare = req.query.pricePerShare != null ? Number(req.query.pricePerShare) : null;
    if (!sharesToIssue || sharesToIssue <= 0) throw new BadRequestError('shares query param required');
    return sendSuccess(res, await captableSvc.previewDilution(req.params.id, sharesToIssue, pricePerShare));
  } catch (err) { return next(err); }
}

export async function listShareTransfers(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await captableSvc.listShareTransfers({
      entityId: req.query.entityId as string | undefined,
      investorId: req.query.investorId as string | undefined,
      status: req.query.status as never,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function initiateShareTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = initiateShareTransferSchema.parse(req.body);
    return sendCreated(res, await captableSvc.initiateShareTransfer(actor, req.params.id, input), 'Share transfer initiated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function approveShareTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    return sendSuccess(res, await captableSvc.approveShareTransfer(actor, req.params.transferId), 'Transfer approved');
  } catch (err) { return next(err); }
}

export async function executeShareTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    return sendSuccess(res, await captableSvc.executeShareTransfer(actor, req.params.transferId), 'Transfer executed');
  } catch (err) { return next(err); }
}

export async function cancelShareTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = cancelShareTransferSchema.parse(req.body);
    return sendSuccess(res, await captableSvc.cancelShareTransfer(actor, req.params.transferId, input), 'Transfer cancelled');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 6. Governance — rights + board ──────────────────────────────────────────

export async function listRights(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await governanceSvc.listRights({
      entityId: req.query.entityId as string | undefined,
      investorId: req.query.investorId as string | undefined,
      type: req.query.type as never,
      activeOnly: req.query.activeOnly === 'false' ? false : true,
    }));
  } catch (err) { return next(err); }
}

export async function grantRight(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = grantRightSchema.parse(req.body);
    return sendCreated(res, await governanceSvc.grantRight(actor, req.params.entityId, input), 'Right granted');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateRight(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = updateRightSchema.parse(req.body);
    return sendSuccess(res, await governanceSvc.updateRight(actor, req.params.rightId, input), 'Right updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function revokeRight(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    await governanceSvc.revokeRight(actor, req.params.rightId);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

export async function listBoardSeats(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await governanceSvc.listBoardSeats({
      entityId: req.query.entityId as string | undefined,
      investorId: req.query.investorId as string | undefined,
      role: req.query.role as never,
      activeOnly: req.query.activeOnly === 'false' ? false : true,
    }));
  } catch (err) { return next(err); }
}

export async function appointBoardSeat(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = appointBoardSeatSchema.parse(req.body);
    return sendCreated(res, await governanceSvc.appointBoardSeat(actor, req.params.entityId, input), 'Board seat appointed');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function vacateBoardSeat(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = vacateBoardSeatSchema.parse(req.body);
    return sendSuccess(res, await governanceSvc.vacateBoardSeat(actor, req.params.seatId, input), 'Board seat vacated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function getGovernanceSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertEntityAccess(actor, req.params.id, 'read');
    return sendSuccess(res, await governanceSvc.getEntityGovernanceSummary(req.params.id));
  } catch (err) { return next(err); }
}

// ─── 7. Agreements ───────────────────────────────────────────────────────────

export async function listAgreements(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await agreementSvc.listAgreements({
      entityId: req.query.entityId as string | undefined,
      investmentId: req.query.investmentId as string | undefined,
      investorId: req.query.investorId as string | undefined,
      type: req.query.type as never,
      status: req.query.status as never,
      scopeEntityIds: effectiveEntityScope(actor),
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getAgreement(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await agreementSvc.getAgreement(req.params.id)); }
  catch (err) { return next(err); }
}

export async function createAgreement(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = createAgreementSchema.parse(req.body);
    return sendCreated(res, await agreementSvc.createAgreement(actor, req.params.entityId, input), 'Agreement created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateAgreement(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = updateAgreementSchema.parse(req.body);
    return sendSuccess(res, await agreementSvc.updateAgreement(actor, req.params.id, input), 'Agreement updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function submitAgreement(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    return sendSuccess(res, await agreementSvc.submitForSignature(actor, req.params.id), 'Agreement submitted');
  } catch (err) { return next(err); }
}

export async function signAgreement(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = signAgreementSchema.parse(req.body);
    return sendSuccess(res, await agreementSvc.signAgreement(actor, req.params.id, input), 'Agreement signed');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function terminateAgreement(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const reason = String(req.body?.reason ?? '');
    if (!reason) throw new BadRequestError('reason required');
    return sendSuccess(res, await agreementSvc.terminateAgreement(actor, req.params.id, reason), 'Agreement terminated');
  } catch (err) { return next(err); }
}

// ─── 8. Exits + waterfall ────────────────────────────────────────────────────

export async function listExits(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await exitSvc.listExitEvents({
      entityId: req.query.entityId as string | undefined,
      status: req.query.status as never,
      type: req.query.type as never,
      scopeEntityIds: effectiveEntityScope(actor),
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getExit(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await exitSvc.getExitEvent(req.params.id)); }
  catch (err) { return next(err); }
}

export async function createExit(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = createExitSchema.parse(req.body);
    return sendCreated(res, await exitSvc.createExit(actor, req.params.entityId, input), 'Exit proposed');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function decideExit(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = decideExitSchema.parse(req.body);
    return sendSuccess(res, await exitSvc.decideExit(actor, req.params.id, input), 'Exit decided');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function previewWaterfall(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertEntityAccess(actor, req.params.id, 'read');
    const proceeds = Number(req.query.proceeds ?? 0);
    const currency = (req.query.currency as string | undefined) ?? 'EUR';
    if (!proceeds || proceeds <= 0) throw new BadRequestError('proceeds query param required');
    return sendSuccess(res, await exitSvc.previewWaterfall(req.params.id, proceeds, currency));
  } catch (err) { return next(err); }
}

export async function computeWaterfall(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await exitSvc.computeWaterfall(req.params.id));
  } catch (err) { return next(err); }
}

export async function executeExit(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    return sendSuccess(res, await exitSvc.executeExit(actor, req.params.id), 'Exit executed');
  } catch (err) { return next(err); }
}

// ─── 9. Distributions ────────────────────────────────────────────────────────

export async function listDistributions(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await distributionSvc.listDistributions({
      investorId: req.query.investorId as string | undefined,
      investmentId: req.query.investmentId as string | undefined,
      type: req.query.type as never,
      status: req.query.status as never,
      from: req.query.from ? new Date(String(req.query.from)) : undefined,
      to: req.query.to ? new Date(String(req.query.to)) : undefined,
      scopeInvestorId: effectiveInvestorScope(actor),
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function recordDistribution(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = recordInvestorDistributionSchema.parse(req.body);
    return sendCreated(res, await distributionSvc.recordDistribution(actor, input), 'Distribution recorded');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function payDistribution(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    return sendSuccess(res, await distributionSvc.payDistribution(actor, req.params.id), 'Distribution paid');
  } catch (err) { return next(err); }
}

export async function reverseDistribution(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const reason = String(req.body?.reason ?? '');
    if (!reason) throw new BadRequestError('reason required');
    return sendSuccess(res, await distributionSvc.reverseDistribution(actor, req.params.id, reason), 'Distribution reversed');
  } catch (err) { return next(err); }
}

// ─── 10. Performance dashboard ───────────────────────────────────────────────

export async function getPortfolio(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertInvestorAccess(actor, req.params.id, 'read');
    return sendSuccess(res, await performanceSvc.getInvestorPortfolio(req.params.id));
  } catch (err) { return next(err); }
}

export async function getDashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertInvestorAccess(actor, req.params.id, 'read');
    return sendSuccess(res, await performanceSvc.getInvestorDashboard(req.params.id));
  } catch (err) { return next(err); }
}

export async function getMyDashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.investorId) throw new ForbiddenError('No investor profile linked to this user');
    return sendSuccess(res, await performanceSvc.getInvestorDashboard(actor.scope.investorId));
  } catch (err) { return next(err); }
}

export async function getEntityRollUp(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertEntityAccess(actor, req.params.id, 'read');
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;
    return sendSuccess(res, await performanceSvc.getEntityRollUp(req.params.id, { from, to }));
  } catch (err) { return next(err); }
}

// ─── 11. Executive PDF reports ───────────────────────────────────────────────

export async function downloadStatement(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertInvestorAccess(actor, req.params.id, 'read');
    const period = (req.query.period as string | undefined) ?? undefined;
    const clubId = (req.query.clubId as string | undefined) ?? null;
    const buf = await pdfSvc.generateInvestorStatement(actor, req.params.id, { period, clubId });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="investor-statement-${req.params.id}.pdf"`);
    return res.send(buf);
  } catch (err) { return next(err); }
}

export async function downloadCapTableReport(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertEntityAccess(actor, req.params.id, 'read');
    const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : undefined;
    const clubId = (req.query.clubId as string | undefined) ?? null;
    const buf = await pdfSvc.generateCapTableReport(actor, req.params.id, { asOf, clubId });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cap-table-${req.params.id}.pdf"`);
    return res.send(buf);
  } catch (err) { return next(err); }
}

// ─── 12. Audit ───────────────────────────────────────────────────────────────

export async function searchAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const q = auditQuerySchema.parse(req.query);
    const scope = actor.scope.isPlatformAdmin
      ? undefined
      : { investorId: actor.scope.investorId, entityIds: actor.scope.ownedEntityIds };
    return sendSuccess(res, await auditSvc.searchAudit(q, scope));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 13. Bootstrap ───────────────────────────────────────────────────────────

export async function ensurePlatformEntity(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const entity = await entitySvc.ensurePlatformEntity();
    return sendSuccess(res, entity, 'Platform entity ready');
  } catch (err) { return next(err); }
}
