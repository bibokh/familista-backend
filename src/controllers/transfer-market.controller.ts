// Familista — club-to-club transfer market controller
// Delegates every decision to transfer-market.service.ts

import { Request, Response, NextFunction } from 'express';
import * as svc from '../transfer-market/transfer-market.service';
import { sendSuccess, sendCreated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUUID(id: string | undefined, name: string): string {
  if (!id || !UUID_RE.test(id)) throw new BadRequestError(`${name} must be a valid UUID`);
  return id;
}
function actor(req: Request): svc.MarketActor {
  return { userId: req.user!.id, clubId: req.user!.clubId, role: req.user!.role };
}

// ── TEMPORARY · bootstrap failure diagnostic ─────────────────────────────────
// Production answers "Internal server error" and keeps the exception in a log
// this environment cannot read, so a 500 here cannot be identified from
// outside. This names the failure — and only the failure — to the authenticated
// club operator who caused it: what threw, the Prisma code, the model and field
// it names, where in our own source it happened, and the validation sentence.
//
// It returns nothing that is not about the failure itself. No environment, no
// connection string, no headers, no cookies, no token — and deliberately not
// the rejected payload either: Prisma prints the whole batch of players into
// its message, and those rows are dropped here rather than handed to the
// browser. What is left is the sentence that says what was wrong.
//
// Remove once the current failure is identified.
const CREDENTIALS_IN_TEXT = /\b[a-z+]+:\/\/[^\s"']*@[^\s"']*/gi;

// Prisma's message is a rejected-object dump with the real complaint inside it.
// These are the lines of the dump: `field: value,` entries and the braces and
// brackets around them. Everything else is prose about what went wrong.
const PAYLOAD_LINE = /^[+~?-]?\s*(?:[A-Za-z_][A-Za-z0-9_]*|"[^"]*")\s*:\s|^[{}[\],\s]+$|^\.\.\.$/;

function safeDiagnostic(err: unknown, req: Request) {
  const e = err as { name?: string; message?: string; stack?: string; code?: string;
                     meta?: Record<string, unknown>; constructor?: { name?: string } };
  const scrub = (s: string) => s.replace(CREDENTIALS_IN_TEXT, '[redacted-url]');

  const raw   = String(e?.message ?? '');
  const prose = raw.split('\n').map((l) => l.trim())
    .filter((l) => l && !PAYLOAD_LINE.test(l))
    .slice(0, 8).join(' ');

  // `Invalid \`prisma.player.createMany()\` invocation` names the model and the
  // operation. The field is named in whichever way Prisma phrased the
  // complaint — "Argument `number`:", "for argument `position`", "Unknown arg
  // `nickname`" — and its structured meta carries the same thing for
  // database-level errors, so take whichever exists.
  const invocation = raw.match(/`prisma\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\(\)`/);
  const argument   = raw.match(/(?:[Aa]rgument|Unknown (?:arg|field)) `([^`]+)`/);
  const meta       = (e?.meta ?? {}) as Record<string, unknown>;
  const first      = (...vs: unknown[]) => vs.find((v) => typeof v === 'string' && v) ?? null;

  const ours = String(e?.stack ?? '').split('\n')
    .filter((l) => /\.(t|j)s:\d+/.test(l) && !l.includes('node_modules') && !l.includes('node:'))
    .slice(0, 4).map((l) => scrub(l.trim()));

  return {
    name:      e?.constructor?.name ?? e?.name ?? 'Error',
    code:      e?.code ?? null,                                   // Prisma P-code, if any
    model:     first(meta.modelName, meta.model, invocation?.[1]),
    operation: invocation ? `${invocation[1]}.${invocation[2]}()` : null,
    field:     first(meta.column, meta.field_name, meta.target, argument?.[1]),
    at:        ours[0] ?? null,                                   // our own file:line
    frames:    ours,
    message:   scrub(prose).slice(0, 400),                        // the validation sentence
    // which build answered, so a 500 from an older deploy is not mistaken for
    // a 500 from this one. A commit sha, nothing more.
    commit:    (process.env.RENDER_GIT_COMMIT ?? '').slice(0, 7) || null,
    actor:     { role: req.user?.role ?? null, clubId: req.user?.clubId ?? null },
  };
}

export async function readMarket(req: Request, res: Response, next: NextFunction) {
  try {
    const page  = req.query.page  ? parseInt(String(req.query.page), 10)  : 1;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    return sendSuccess(res, await svc.readMarket(actor(req), { page, limit }));
  } catch (err) { return next(err); }
}

export async function readOwnListings(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.readOwnListings(actor(req))); }
  catch (err) { return next(err); }
}

export async function getBalance(req: Request, res: Response, next: NextFunction) {
  try { return sendSuccess(res, await svc.getBalance(req.user!.clubId)); }
  catch (err) { return next(err); }
}

export async function listPlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = req.body as svc.ListDto;
    requireUUID(dto?.playerId, 'playerId');
    return sendCreated(res, await svc.listPlayer(actor(req), dto));
  } catch (err) { return next(err); }
}

export async function delistPlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.listingId, 'listingId');
    return sendSuccess(res, await svc.delistPlayer(actor(req), id));
  } catch (err) { return next(err); }
}

export async function purchase(req: Request, res: Response, next: NextFunction) {
  try {
    const id = requireUUID(req.params.listingId, 'listingId');
    return sendSuccess(res, await svc.purchase(actor(req), id));
  } catch (err) { return next(err); }
}

export async function bootstrapRoster(req: Request, res: Response, next: NextFunction) {
  try {
    const teams = (req.body?.teams ?? []) as svc.BootstrapTeamDto[];
    return sendSuccess(res, await svc.bootstrapRoster(actor(req), teams));
  } catch (err) {
    // A refusal or a bad request already says what went wrong and keeps its
    // normal handling. Only the unexpected failure — the one that would arrive
    // as a bare "Internal server error" — is described. TEMPORARY.
    const status = (err as { statusCode?: number })?.statusCode;
    if (status && status < 500) return next(err);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      diagnostic: safeDiagnostic(err, req),   // TEMPORARY — see safeDiagnostic
    });
  }
}
