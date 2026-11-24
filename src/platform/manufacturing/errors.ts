/**
 * Familista Manufacturing (M4) — the refusals clients act on, answered the same way on the club's and the Owner's routes.
 */
import type { NextFunction, Response } from 'express';
import { QuoteInvalidError, RequestRefusedError, RequestStepError, SheetRefusedError } from './request.service';
import { SupplierConflictError, SupplierInvalidError } from './supplier.service';

export function refusals(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof RequestRefusedError) { res.status(409).json({ success: false, code: err.code, reason: err.reason, message: err.message }); return; }
  if (err instanceof RequestStepError) { res.status(409).json({ success: false, code: err.code, reason: err.reason, data: { status: err.status }, message: err.message }); return; }
  if (err instanceof QuoteInvalidError) { res.status(400).json({ success: false, code: 'QUOTE_INVALID', reason: err.code, path: err.path, message: err.message }); return; }
  if (err instanceof SupplierInvalidError) { res.status(400).json({ success: false, code: 'SUPPLIER_INVALID', reason: err.code, path: err.path, message: err.message }); return; }
  if (err instanceof SheetRefusedError) { res.status(409).json({ success: false, code: err.code, data: { status: err.status }, message: err.message }); return; }
  if (err instanceof SupplierConflictError) { res.status(409).json({ success: false, code: err.code, data: { version: err.version }, message: err.message }); return; }
  next(err);
}
