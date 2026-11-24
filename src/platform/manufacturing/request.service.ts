/**
 * Familista Manufacturing (M4) — requests for quotation, quotations and orders, owner-brokered.
 *
 * A club submits a request from one of its collections and a roster: the request keeps a frozen specification (each
 * design at its saved revision and hash; the roster's names, numbers, sizes and sets) and nothing about it changes again.
 * The Platform Owner reviews it, records the quotations real suppliers give (each with the supplier's own reference and
 * how it was received), and publishes them to the club; the club accepts one or declines; the Owner confirms the order
 * with the supplier and records production, shipping and delivery. Every move is a step of state.ts, made in one
 * transaction with its immutable event and its audit entry, and conditional on the status it starts from, so two moves
 * racing on one request cannot both land.
 *
 * Club functions take the club the routes resolved from the session, and filter by it (row-level security holds the same
 * line underneath). Owner functions run behind assertPlatformOwner on the system path and reach every club's requests.
 * Nothing here moves money or contacts anyone: an accepted quotation is not a payment, and an order is the Owner's record
 * of one confirmed outside the platform.
 */
import { ManufacturingActorKind, ManufacturingQuoteStatus as Q, ManufacturingRequestStatus as S, ManufacturingSupplierStatus, Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { clubAudit } from '../product-design/club-audit';
import { templateForm } from '../product-design/core';
import { rosterSummary, validateRosterEntries, type RosterEntry } from '../product-design/roster-core';
import type { DesignActor } from '../product-design/service';
import { approvalsFor } from '../product-design/review.service';
import { isCurrency, isMinor } from './money';
import { FINAL, step, type Action } from './state';
import { ownerAudit } from './supplier.service';

/** At most this many open requests in a club at once. */
export const OPEN_REQUEST_LIMIT = 50;

export interface SpecGarment {
  projectId: string; name: string; role: string; templateKey: string; templateVersion: number; form: 'top' | 'shorts' | 'socks';
  revision: number; sha256: string; sizes: Array<{ size: string; sets: number }>; sets: number;
  /** M7b: the club administrator's decision on that version when the request was sent, or null (not reviewed). */
  approval: { decision: 'APPROVED' | 'CHANGES_REQUESTED'; at: string } | null;
}
export interface RequestSpec {
  format: 'familista.manufacturing-spec'; version: 1;
  collection: { id: string; name: string; season: string | null };
  roster: { id: string; name: string; version: number };
  garments: SpecGarment[]; entries: RosterEntry[]; sets: number;
}
export interface QuoteInput {
  supplierId: string; currency: string; totalMinor: number; lines: Array<{ projectId: string; unitMinor: number; sets: number }>;
  leadTimeDays: number; validUntil: string; supplierReference: string; evidence: string;
}

/** A request the club cannot submit as it is: the collection, its roster or their sizes are not ready. */
export class RequestRefusedError extends ConflictError {
  readonly code: 'REQUEST_INCOMPLETE' | 'REQUEST_LIMIT';
  readonly reason: string;
  constructor(code: 'REQUEST_INCOMPLETE' | 'REQUEST_LIMIT', reason: string, message: string) { super(message); this.code = code; this.reason = reason; }
}
/** A step the workflow does not allow from where the request is (or no longer is). */
export class RequestStepError extends ConflictError {
  readonly code = 'REQUEST_STEP_REFUSED';
  readonly reason: string;
  readonly status: S | null;
  constructor(reason: string, status: S | null) { super(`This step is not possible now (${reason})`); this.reason = reason; this.status = status; }
}
/** A quotation the service will not keep as sent. */
export class QuoteInvalidError extends Error {
  readonly code: string; readonly path: string;
  constructor(code: string, at: string) { super(`${code} at ${at}`); this.name = 'QuoteInvalidError'; this.code = code; this.path = at; }
}

const today = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };
const dateOnly = (v: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null; const d = new Date(v + 'T00:00:00Z'); return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d; };
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
function noteOf(v: string | null | undefined, max = 1000): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).normalize('NFC').trim();
  if (!s) return null;
  if (Array.from(s).length > max || CONTROL.test(s)) throw new QuoteInvalidError('bad-note', 'note');
  return s;
}

const SUMMARY = { id: true, status: true, setsTotal: true, neededBy: true, createdAt: true, updatedAt: true, version: true, spec: true } as const;
function summaryView(r: { id: string; status: S; setsTotal: number; neededBy: Date | null; createdAt: Date; updatedAt: Date; version: number; spec: Prisma.JsonValue }) {
  const spec = r.spec as unknown as RequestSpec;
  return { id: r.id, status: r.status, sets: r.setsTotal, neededBy: r.neededBy, createdAt: r.createdAt, updatedAt: r.updatedAt, version: r.version,
    collection: spec.collection, roster: { id: spec.roster.id, name: spec.roster.name }, garments: spec.garments.length };
}
const EVENT_SELECT = { action: true, fromStatus: true, toStatus: true, actorKind: true, note: true, createdAt: true } as const;
const CLUB_QUOTE_SELECT = {
  id: true, status: true, currency: true, totalMinor: true, lines: true, leadTimeDays: true, validUntil: true, publishedAt: true,
  supplier: { select: { name: true, country: true } },
} as const;

// ── the club's side ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Build the frozen specification from a collection and a roster of the club's, or say what is missing. */
async function buildSpec(tx: Prisma.TransactionClient, clubId: string, collectionId: string, rosterIdIn: string | null): Promise<RequestSpec> {
  const coll = await tx.designCollection.findFirst({
    where: { id: collectionId, clubId },
    select: { id: true, name: true, season: true, rosterId: true, archivedAt: true,
      items: { orderBy: { position: 'asc' }, select: { projectId: true, role: true, project: { select: { name: true, templateKey: true, templateVersion: true, headRevision: true } } } } },
  });
  if (!coll) throw new NotFoundError('Collection');
  const refuse = (reason: string, message: string) => new RequestRefusedError('REQUEST_INCOMPLETE', reason, message);
  if (coll.archivedAt) throw refuse('collection-archived', 'This collection is archived');
  if (!coll.items.length) throw refuse('no-designs', 'This collection has no designs');
  const rosterId = rosterIdIn ?? coll.rosterId;
  if (!rosterId) throw refuse('no-roster', 'Choose the roster the kit is made for');
  const roster = await tx.designRoster.findFirst({ where: { id: rosterId, clubId }, select: { id: true, name: true, version: true, entries: true, archivedAt: true } });
  if (!roster) throw new NotFoundError('Roster');
  if (roster.archivedAt) throw refuse('roster-archived', 'This roster is archived');
  const entries = validateRosterEntries(roster.entries);
  const sum = rosterSummary(entries);
  if (!sum.sets) throw refuse('empty-roster', 'The roster has no entries');
  const garments: SpecGarment[] = [];
  const approvals = await approvalsFor(tx, clubId, coll.items.map((i) => ({ projectId: i.projectId, revision: i.project.headRevision })));
  for (const item of coll.items) {
    const form = templateForm(item.project.templateKey, item.project.templateVersion);
    if (!form) throw refuse('not-released', 'A design is not of a released garment');
    if (sum.unsized[form] > 0) throw refuse('unsized', 'Some entries have no size for a garment of the collection');
    const head = await tx.designRevision.findUnique({ where: { projectId_number: { projectId: item.projectId, number: item.project.headRevision } }, select: { sha256: true } });
    if (!head) throw refuse('no-revision', 'A design has no saved revision');
    garments.push({ projectId: item.projectId, name: item.project.name, role: item.role, templateKey: item.project.templateKey, templateVersion: item.project.templateVersion,
      form, revision: item.project.headRevision, sha256: head.sha256, sizes: sum.sizes[form], sets: sum.sets,
      approval: ((a) => (a ? { decision: a.decision, at: a.at.toISOString() } : null))(approvals.get(`${item.projectId}@${item.project.headRevision}`)) });
  }
  return { format: 'familista.manufacturing-spec', version: 1, collection: { id: coll.id, name: coll.name, season: coll.season },
    roster: { id: roster.id, name: roster.name, version: roster.version }, garments, entries, sets: sum.sets };
}

async function event(tx: Prisma.TransactionClient, r: { id: string; clubId: string }, action: Action, from: S | null, to: S, kind: ManufacturingActorKind, actor: DesignActor, note: string | null) {
  await tx.manufacturingRequestEvent.create({ data: { clubId: r.clubId, requestId: r.id, action, fromStatus: from, toStatus: to, actorKind: kind, actorUserId: actor.userId, note } });
}

/** Submit a request for quotation from one of the club's collections. */
export async function submitRequest(clubId: string, actor: DesignActor, input: { collectionId: string; rosterId: string | null; note: string | null; neededBy: string | null }) {
  const note = noteOf(input.note);
  const neededBy = input.neededBy ? dateOnly(input.neededBy) : null;
  if (input.neededBy && (!neededBy || neededBy < today())) throw new QuoteInvalidError('bad-date', 'neededBy');
  return prisma.$transaction(async (tx) => {
    const open = await tx.manufacturingRequest.count({ where: { clubId, status: { notIn: [...FINAL] } } });
    if (open >= OPEN_REQUEST_LIMIT) throw new RequestRefusedError('REQUEST_LIMIT', 'too-many-open', `A club has at most ${OPEN_REQUEST_LIMIT} open requests`);
    const spec = await buildSpec(tx, clubId, input.collectionId, input.rosterId);
    const req = await tx.manufacturingRequest.create({
      data: { clubId, collectionId: spec.collection.id, spec: spec as unknown as Prisma.InputJsonValue, setsTotal: spec.sets, clubNote: note, neededBy, createdById: actor.userId },
      select: { id: true, clubId: true },
    });
    await event(tx, req, 'submit', null, S.SUBMITTED, 'CLUB', actor, note);
    await clubAudit(tx, clubId, actor, { action: 'manufacturing.request.submitted', resourceType: 'ManufacturingRequest', resourceId: req.id,
      metadata: { garments: spec.garments.length, sets: spec.sets, entries: spec.entries.length }, message: 'A request for quotation was submitted' });
    return getClubRequestTx(tx, clubId, req.id);
  });
}

export async function listClubRequests(clubId: string) {
  const rows = await prisma.manufacturingRequest.findMany({ where: { clubId }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 200, select: SUMMARY });
  return { requests: rows.map(summaryView) };
}

async function getClubRequestTx(tx: Prisma.TransactionClient, clubId: string, id: string) {
  const r = await tx.manufacturingRequest.findFirst({
    where: { id, clubId },
    select: { ...SUMMARY, clubNote: true, acceptedQuoteId: true,
      events: { orderBy: { createdAt: 'asc' }, select: EVENT_SELECT },
      quotes: { where: { status: { in: [Q.PUBLISHED, Q.ACCEPTED, Q.SUPERSEDED] } }, orderBy: { publishedAt: 'asc' }, select: CLUB_QUOTE_SELECT } },
  });
  if (!r) throw new NotFoundError('Request');
  return { request: { ...summaryView(r), spec: r.spec, clubNote: r.clubNote, acceptedQuoteId: r.acceptedQuoteId, events: r.events, quotes: r.quotes } };
}
export async function getClubRequest(clubId: string, id: string) { return getClubRequestTx(prisma, clubId, id); }

/** Move a request one step, conditional on the status it starts from. Returns the status it now has. */
async function move(tx: Prisma.TransactionClient, r: { id: string; clubId: string; status: S }, action: Action, kind: ManufacturingActorKind, actor: DesignActor, note: string | null, to?: S) {
  const s = step(action, kind, r.status, note);
  if ('refused' in s) throw new RequestStepError(s.refused, r.status);
  const next = to ?? (s.to === 'same' ? r.status : s.to);
  const moved = await tx.manufacturingRequest.updateMany({ where: { id: r.id, status: r.status }, data: { status: next, version: { increment: 1 } } });
  if (moved.count !== 1) throw new RequestStepError('moved', r.status);
  await event(tx, r, action, r.status, next, kind, actor, note);
  return next;
}

/** The club's own steps: cancel, decline every quotation, or confirm delivery. */
export async function clubStep(clubId: string, actor: DesignActor, id: string, action: 'cancel' | 'decline' | 'deliver', noteIn: string | null) {
  const note = noteOf(noteIn);
  return prisma.$transaction(async (tx) => {
    const r = await tx.manufacturingRequest.findFirst({ where: { id, clubId }, select: { id: true, clubId: true, status: true } });
    if (!r) throw new NotFoundError('Request');
    const to = await move(tx, r, action, 'CLUB', actor, note);
    if (action === 'cancel' || action === 'decline') await tx.manufacturingQuote.updateMany({ where: { requestId: id, clubId, status: Q.PUBLISHED }, data: { status: Q.SUPERSEDED } });
    await clubAudit(tx, clubId, actor, { action: `manufacturing.request.${action}`, resourceType: 'ManufacturingRequest', resourceId: id, metadata: { from: r.status, to }, message: `The club took the step ${action}` });
    return getClubRequestTx(tx, clubId, id);
  });
}

/** Accept one published, still valid quotation: the others are superseded. Nothing is charged. */
export async function acceptQuote(clubId: string, actor: DesignActor, id: string, quoteId: string) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.manufacturingRequest.findFirst({ where: { id, clubId }, select: { id: true, clubId: true, status: true } });
    if (!r) throw new NotFoundError('Request');
    // The workflow first: once a request has left QUOTED (accepted, declined, cancelled), any acceptance is the conflict it
    // is, whichever quotation it names, never a 'not found' for a quotation that was set aside meanwhile.
    const allowed = step('accept', 'CLUB', r.status, null);
    if ('refused' in allowed) throw new RequestStepError(allowed.refused, r.status);
    const q = await tx.manufacturingQuote.findFirst({ where: { id: quoteId, requestId: id, clubId }, select: { status: true, validUntil: true, totalMinor: true, currency: true, supplier: { select: { status: true } } } });
    if (!q || q.status !== Q.PUBLISHED) throw new NotFoundError('Quotation');
    if (q.validUntil < today()) throw new RequestStepError('quote-expired', r.status);
    // A supplier suspended since it quoted cannot be accepted (the database refuses it too).
    if (q.supplier.status !== ManufacturingSupplierStatus.VERIFIED) throw new RequestStepError('supplier-not-verified', r.status);
    await move(tx, r, 'accept', 'CLUB', actor, null);
    await tx.manufacturingQuote.updateMany({ where: { requestId: id, clubId, status: Q.PUBLISHED, id: { not: quoteId } }, data: { status: Q.SUPERSEDED } });
    await tx.manufacturingQuote.update({ where: { id: quoteId }, data: { status: Q.ACCEPTED } });
    await tx.manufacturingRequest.update({ where: { id }, data: { acceptedQuoteId: quoteId } });
    await clubAudit(tx, clubId, actor, { action: 'manufacturing.quote.accepted', resourceType: 'ManufacturingRequest', resourceId: id,
      metadata: { quoteId, currency: q.currency, totalMinor: q.totalMinor }, message: 'The club accepted a quotation' });
    return getClubRequestTx(tx, clubId, id);
  });
}

// ── the Platform Owner's side ───────────────────────────────────────────────────────────────────────────────────────

const OWNER_QUOTE_SELECT = {
  id: true, status: true, currency: true, totalMinor: true, lines: true, leadTimeDays: true, validUntil: true, supplierReference: true, evidence: true,
  publishedAt: true, createdAt: true, supplierId: true, supplier: { select: { name: true, country: true, status: true } },
} as const;

/** Every club's requests, newest change first, optionally of one status. */
export async function listAllRequests(status?: S) {
  const rows = await prisma.manufacturingRequest.findMany({
    where: status ? { status } : {}, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 300,
    select: { ...SUMMARY, clubId: true, club: { select: { name: true } } },
  });
  return { requests: rows.map((r) => ({ ...summaryView(r), club: { id: r.clubId, name: r.club.name } })) };
}

export async function getRequest(id: string) { return getRequestTx(prisma, id); }
async function getRequestTx(tx: Prisma.TransactionClient, id: string) {
  const r = await tx.manufacturingRequest.findUnique({
    where: { id },
    select: { ...SUMMARY, clubId: true, clubNote: true, acceptedQuoteId: true, club: { select: { name: true } },
      events: { orderBy: { createdAt: 'asc' }, select: EVENT_SELECT },
      quotes: { orderBy: { createdAt: 'asc' }, select: OWNER_QUOTE_SELECT } },
  });
  if (!r) throw new NotFoundError('Request');
  return { request: { ...summaryView(r), club: { id: r.clubId, name: r.club.name }, spec: r.spec, clubNote: r.clubNote, acceptedQuoteId: r.acceptedQuoteId, events: r.events, quotes: r.quotes } };
}

/** The Owner's steps that need nothing but a note: review, refuse, order, production, shipping, delivery. */
export async function ownerStep(actor: DesignActor, id: string, action: 'review' | 'refuse' | 'order' | 'produce' | 'ship' | 'deliver', noteIn: string | null) {
  const note = noteOf(noteIn);
  return prisma.$transaction(async (tx) => {
    const r = await tx.manufacturingRequest.findUnique({ where: { id }, select: { id: true, clubId: true, status: true } });
    if (!r) throw new NotFoundError('Request');
    const to = await move(tx, r, action, 'OWNER', actor, note);
    await ownerAudit(tx, actor, { action: `manufacturing.request.${action}`, resourceType: 'ManufacturingRequest', resourceId: id, clubId: r.clubId,
      metadata: { from: r.status, to }, message: `The Platform Owner took the step ${action}` });
    return getRequestTx(tx, id);
  });
}

function cleanQuote(input: QuoteInput, spec: RequestSpec): QuoteInput & { validDate: Date } {
  if (!isCurrency(input.currency)) throw new QuoteInvalidError('bad-currency', 'currency');
  if (!isMinor(input.totalMinor)) throw new QuoteInvalidError('bad-amount', 'totalMinor');
  if (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 1 || input.leadTimeDays > 365) throw new QuoteInvalidError('bad-lead-time', 'leadTimeDays');
  const validDate = dateOnly(input.validUntil);
  if (!validDate || validDate < today()) throw new QuoteInvalidError('bad-valid-until', 'validUntil');
  const ref = input.supplierReference.normalize('NFC').trim();
  if (!ref || Array.from(ref).length > 80 || CONTROL.test(ref)) throw new QuoteInvalidError('bad-reference', 'supplierReference');
  const evidence = input.evidence.normalize('NFC').trim();
  if (Array.from(evidence).length < 10 || Array.from(evidence).length > 500 || CONTROL.test(evidence)) throw new QuoteInvalidError('bad-evidence', 'evidence');
  const designs = new Set(spec.garments.map((g) => g.projectId));
  if (input.lines.length > spec.garments.length) throw new QuoteInvalidError('bad-lines', 'lines');
  input.lines.forEach((l, i) => {
    if (!designs.has(l.projectId)) throw new QuoteInvalidError('unknown-design', `lines[${i}].projectId`);
    if (!isMinor(l.unitMinor)) throw new QuoteInvalidError('bad-amount', `lines[${i}].unitMinor`);
    if (!Number.isInteger(l.sets) || l.sets < 1 || l.sets > 100000) throw new QuoteInvalidError('bad-sets', `lines[${i}].sets`);
  });
  return { ...input, supplierReference: ref, evidence, validDate };
}

/** Record a quotation a verified supplier gave, as a draft only the Owner sees. */
export async function recordQuote(actor: DesignActor, id: string, input: QuoteInput) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.manufacturingRequest.findUnique({ where: { id }, select: { id: true, clubId: true, status: true, spec: true } });
    if (!r) throw new NotFoundError('Request');
    if (r.status !== S.IN_REVIEW && r.status !== S.QUOTED) throw new RequestStepError('wrong-status', r.status);
    const q = cleanQuote(input, r.spec as unknown as RequestSpec);
    const supplier = await tx.manufacturingSupplier.findUnique({ where: { id: q.supplierId }, select: { status: true } });
    if (!supplier) throw new QuoteInvalidError('unknown-supplier', 'supplierId');
    if (supplier.status !== ManufacturingSupplierStatus.VERIFIED) throw new QuoteInvalidError('supplier-not-verified', 'supplierId');
    const quote = await tx.manufacturingQuote.create({
      data: { clubId: r.clubId, requestId: id, supplierId: q.supplierId, currency: q.currency, totalMinor: q.totalMinor, lines: q.lines as unknown as Prisma.InputJsonValue,
        leadTimeDays: q.leadTimeDays, validUntil: q.validDate, supplierReference: q.supplierReference, evidence: q.evidence, recordedById: actor.userId },
      select: { id: true },
    });
    await ownerAudit(tx, actor, { action: 'manufacturing.quote.recorded', resourceType: 'ManufacturingQuote', resourceId: quote.id, clubId: r.clubId,
      metadata: { requestId: id, supplierId: q.supplierId, currency: q.currency, totalMinor: q.totalMinor }, message: 'A supplier quotation was recorded' });
    return getRequestTx(tx, id);
  });
}

/** Publish a draft quotation to the club. The request becomes QUOTED. */
export async function publishQuote(actor: DesignActor, id: string, quoteId: string) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.manufacturingRequest.findUnique({ where: { id }, select: { id: true, clubId: true, status: true } });
    if (!r) throw new NotFoundError('Request');
    const q = await tx.manufacturingQuote.findFirst({ where: { id: quoteId, requestId: id }, select: { status: true, validUntil: true, supplier: { select: { status: true } } } });
    if (!q || q.status !== Q.DRAFT) throw new NotFoundError('Draft quotation');
    if (q.supplier.status !== ManufacturingSupplierStatus.VERIFIED) throw new QuoteInvalidError('supplier-not-verified', 'supplierId');
    if (q.validUntil < today()) throw new QuoteInvalidError('bad-valid-until', 'validUntil');
    await move(tx, r, 'quote', 'OWNER', actor, null);
    await tx.manufacturingQuote.update({ where: { id: quoteId }, data: { status: Q.PUBLISHED, publishedAt: new Date() } });
    await ownerAudit(tx, actor, { action: 'manufacturing.quote.published', resourceType: 'ManufacturingQuote', resourceId: quoteId, clubId: r.clubId, metadata: { requestId: id }, message: 'A quotation was published to the club' });
    return getRequestTx(tx, id);
  });
}

/** Withdraw a published quotation (the supplier withdrew it). With none left, the request returns to review. */
export async function withdrawQuote(actor: DesignActor, id: string, quoteId: string, noteIn: string) {
  const note = noteOf(noteIn);
  return prisma.$transaction(async (tx) => {
    const r = await tx.manufacturingRequest.findUnique({ where: { id }, select: { id: true, clubId: true, status: true } });
    if (!r) throw new NotFoundError('Request');
    const q = await tx.manufacturingQuote.findFirst({ where: { id: quoteId, requestId: id }, select: { status: true } });
    if (!q || q.status !== Q.PUBLISHED) throw new NotFoundError('Published quotation');
    const left = await tx.manufacturingQuote.count({ where: { requestId: id, status: Q.PUBLISHED, id: { not: quoteId } } });
    await move(tx, r, 'withdraw', 'OWNER', actor, note, left ? undefined : S.IN_REVIEW);
    await tx.manufacturingQuote.update({ where: { id: quoteId }, data: { status: Q.WITHDRAWN } });
    await ownerAudit(tx, actor, { action: 'manufacturing.quote.withdrawn', resourceType: 'ManufacturingQuote', resourceId: quoteId, clubId: r.clubId, metadata: { requestId: id, note }, message: 'A quotation was withdrawn' });
    return getRequestTx(tx, id);
  });
}

/** Discard a draft quotation that was never published. */
export async function discardDraft(actor: DesignActor, id: string, quoteId: string) {
  return prisma.$transaction(async (tx) => {
    const q = await tx.manufacturingQuote.findFirst({ where: { id: quoteId, requestId: id }, select: { status: true, clubId: true } });
    if (!q || q.status !== Q.DRAFT) throw new NotFoundError('Draft quotation');
    await tx.manufacturingQuote.delete({ where: { id: quoteId } });
    await ownerAudit(tx, actor, { action: 'manufacturing.quote.discarded', resourceType: 'ManufacturingQuote', resourceId: quoteId, clubId: q.clubId, metadata: { requestId: id }, message: 'A draft quotation was discarded' });
    return getRequestTx(tx, id);
  });
}

/** A design as the request froze it: the document of the revision the specification names, for production. */
export async function specDesign(id: string, projectId: string) {
  const r = await prisma.manufacturingRequest.findUnique({ where: { id }, select: { spec: true } });
  if (!r) throw new NotFoundError('Request');
  const g = (r.spec as unknown as RequestSpec).garments.find((x) => x.projectId === projectId);
  if (!g) throw new NotFoundError('Design');
  const rev = await prisma.designRevision.findUnique({ where: { projectId_number: { projectId, number: g.revision } }, select: { document: true, sha256: true } });
  if (!rev || rev.sha256 !== g.sha256) throw new NotFoundError('Design revision');
  return { design: { projectId, revision: g.revision, sha256: rev.sha256, document: rev.document } };
}
