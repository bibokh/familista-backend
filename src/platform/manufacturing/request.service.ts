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
import { ManufacturingActorKind, ManufacturingPersonState, ManufacturingQuoteStatus as Q, ManufacturingRequestStatus as S, ManufacturingSupplierStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../config/database';
import { ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors';
import { tenantAudit } from '../product-design/club-audit';
import { ownerColumns, tenantWhere, type Tenant } from '../tenancy/tenant';
import { templateForm } from '../product-design/core';
import { rosterCsv, rosterCsvFileName, rosterSummary, validateRosterEntries, youthEntries } from '../product-design/roster-core';
import type { DesignActor } from '../product-design/service';
import { approvalsFor } from '../product-design/review.service';
import { isCurrency, isMinor } from './money';
import { FINAL, step, type Action } from './state';
import { byFit, supplierFit, type FitRequest } from './fit';
import { ownerAudit } from './supplier.service';
import { buildTechPack, techPackCsv, type TechPackDoc } from '../commercial/tech-pack';

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
  garments: SpecGarment[]; entries: SpecEntry[]; sets: number;
}
/** P1: one roster entry as the specification freezes it: everything but the person's name, which is kept apart. */
export interface SpecEntry { position: number; number: number | null; top: string | null; shorts: string | null; socks: string | null; qty: number }
/** P1: what became of the names of a request's entries. */
export interface PeopleView { kept: number; withheld: number; erased: number; minors: boolean; minorsConsent: boolean }
export interface QuoteInput {
  supplierId: string; currency: string; totalMinor: number; lines: Array<{ projectId: string; unitMinor: number; sets: number }>;
  leadTimeDays: number; validUntil: string; supplierReference: string; evidence: string;
  /** P7: the conditions the supplier attached; optional, frozen once published. */
  terms?: string | null;
}

/**
 * P7: a decision on quotations — accepting one, or declining them all — commits the club, so in a club only its
 * administrators take it (a manager sees the quotations and is told who decides); a creator decides on their own.
 */
export class DecisionRoleError extends ForbiddenError {
  readonly code = 'MANUFACTURING_ADMIN_REQUIRED';
  constructor() { super('Only a club administrator accepts or declines quotations'); }
}
export function assertMayDecide(tenant: Tenant, role: UserRole | string | undefined): void {
  if (tenant.kind === 'club' && role !== UserRole.CLUB_ADMIN) throw new DecisionRoleError();
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
  id: true, status: true, currency: true, totalMinor: true, lines: true, leadTimeDays: true, validUntil: true, publishedAt: true, terms: true,
  supplier: { select: { name: true, country: true } },
} as const;

// ── the club's side ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Build the frozen specification from a collection and a roster of the club's, or say what is missing. */
async function buildSpec(tx: Prisma.TransactionClient, tenant: Tenant, collectionId: string, rosterIdIn: string | null): Promise<{ spec: RequestSpec; names: string[]; minors: boolean }> {
  const coll = await tx.designCollection.findFirst({
    where: { id: collectionId, ...tenantWhere(tenant) },
    select: { id: true, name: true, season: true, rosterId: true, archivedAt: true,
      items: { orderBy: { position: 'asc' }, select: { projectId: true, role: true, project: { select: { name: true, templateKey: true, templateVersion: true, headRevision: true } } } } },
  });
  if (!coll) throw new NotFoundError('Collection');
  const refuse = (reason: string, message: string) => new RequestRefusedError('REQUEST_INCOMPLETE', reason, message);
  if (coll.archivedAt) throw refuse('collection-archived', 'This collection is archived');
  if (!coll.items.length) throw refuse('no-designs', 'This collection has no designs');
  const rosterId = rosterIdIn ?? coll.rosterId;
  if (!rosterId) throw refuse('no-roster', 'Choose the roster the kit is made for');
  const roster = await tx.designRoster.findFirst({ where: { id: rosterId, ...tenantWhere(tenant) }, select: { id: true, name: true, version: true, entries: true, archivedAt: true, includesMinors: true } });
  if (!roster) throw new NotFoundError('Roster');
  if (roster.archivedAt) throw refuse('roster-archived', 'This roster is archived');
  const entries = validateRosterEntries(roster.entries);
  const sum = rosterSummary(entries);
  if (!sum.sets) throw refuse('empty-roster', 'The roster has no entries');
  const garments: SpecGarment[] = [];
  const approvals = await approvalsFor(tx, tenant, coll.items.map((i) => ({ projectId: i.projectId, revision: i.project.headRevision })));
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
  // The names stay out of the frozen specification (P1): they are kept apart, where they can be erased.
  const specEntries: SpecEntry[] = entries.map((e, position) => ({ position, number: e.number, top: e.top, shorts: e.shorts, socks: e.socks, qty: e.qty }));
  return {
    spec: { format: 'familista.manufacturing-spec', version: 1, collection: { id: coll.id, name: coll.name, season: coll.season },
      roster: { id: roster.id, name: roster.name, version: roster.version }, garments, entries: specEntries, sets: sum.sets },
    names: entries.map((e) => e.name), minors: roster.includesMinors || youthEntries(entries) > 0,
  };
}

/** P1: how many of a request's names are kept, withheld and erased. */
async function peopleOf(tx: Prisma.TransactionClient, r: { id: string; minors: boolean; minorsConsentAt: Date | null }): Promise<PeopleView> {
  const rows = await tx.manufacturingRequestPerson.groupBy({ by: ['state'], where: { requestId: r.id }, _count: { _all: true } });
  const n = (k: 'KEPT' | 'WITHHELD' | 'ERASED') => rows.find((x) => x.state === k)?._count._all ?? 0;
  return { kept: n('KEPT'), withheld: n('WITHHELD'), erased: n('ERASED'), minors: r.minors, minorsConsent: !!r.minorsConsentAt };
}

type Owned = { id: string; clubId: string | null; creatorId: string | null };
async function event(tx: Prisma.TransactionClient, r: Owned, action: Action, from: S | null, to: S, kind: ManufacturingActorKind, actor: DesignActor, note: string | null) {
  await tx.manufacturingRequestEvent.create({ data: { clubId: r.clubId, creatorId: r.creatorId, requestId: r.id, action, fromStatus: from, toStatus: to, actorKind: kind, actorUserId: actor.userId, note } });
}

/** Submit a request for quotation from one of the club's collections. */
export async function submitRequest(tenant: Tenant, actor: DesignActor & { role?: UserRole }, input: { collectionId: string; rosterId: string | null; note: string | null; neededBy: string | null; minorsConsent?: boolean }) {
  const note = noteOf(input.note);
  const neededBy = input.neededBy ? dateOnly(input.neededBy) : null;
  if (input.neededBy && (!neededBy || neededBy < today())) throw new QuoteInvalidError('bad-date', 'neededBy');
  return prisma.$transaction(async (tx) => {
    const open = await tx.manufacturingRequest.count({ where: { ...tenantWhere(tenant), status: { notIn: [...FINAL] } } });
    if (open >= OPEN_REQUEST_LIMIT) throw new RequestRefusedError('REQUEST_LIMIT', 'too-many-open', `A club has at most ${OPEN_REQUEST_LIMIT} open requests`);
    const { spec, names, minors } = await buildSpec(tx, tenant, input.collectionId, input.rosterId);
    // P1: a minor's name is kept only when a club administrator attests a guardian's consent; otherwise it is never stored.
    const consent = minors && input.minorsConsent === true;
    // A club's attestation is its administrator's; a creator (an adult, by the sign-up's age confirmation) attests their own.
    if (consent && tenant.kind === 'club' && actor.role !== UserRole.CLUB_ADMIN) throw new ForbiddenError('Only a club administrator attests a guardian’s consent');
    const req = await tx.manufacturingRequest.create({
      data: { ...tenantWhere(tenant), collectionId: spec.collection.id, spec: spec as unknown as Prisma.InputJsonValue, setsTotal: spec.sets, clubNote: note, neededBy, createdById: actor.userId,
        minors, ...(consent ? { minorsConsentAt: new Date(), minorsConsentById: actor.userId } : {}) },
      select: { id: true, clubId: true, creatorId: true },
    });
    await tx.manufacturingRequestPerson.createMany({
      data: names.map((name, position) => (minors && !consent) || !name ? { ...tenantWhere(tenant), requestId: req.id, position, name: null, state: ManufacturingPersonState.WITHHELD }
        : { ...tenantWhere(tenant), requestId: req.id, position, name, state: ManufacturingPersonState.KEPT }),
    });
    await event(tx, req, 'submit', null, S.SUBMITTED, 'CLUB', actor, note);
    await tenantAudit(tx, tenant, actor, { action: 'manufacturing.request.submitted', resourceType: 'ManufacturingRequest', resourceId: req.id,
      metadata: { garments: spec.garments.length, sets: spec.sets, entries: spec.entries.length, minors, minorsConsent: consent }, message: 'A request for quotation was submitted' });
    return getClubRequestTx(tx, tenant, req.id);
  });
}

export async function listClubRequests(tenant: Tenant) {
  const rows = await prisma.manufacturingRequest.findMany({ where: { ...tenantWhere(tenant) }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 200, select: SUMMARY });
  return { requests: rows.map(summaryView) };
}

async function getClubRequestTx(tx: Prisma.TransactionClient, tenant: Tenant, id: string) {
  const r = await tx.manufacturingRequest.findFirst({
    where: { id, ...tenantWhere(tenant) },
    select: { ...SUMMARY, clubNote: true, acceptedQuoteId: true, minors: true, minorsConsentAt: true,
      events: { orderBy: { createdAt: 'asc' }, select: EVENT_SELECT },
      quotes: { where: { status: { in: [Q.PUBLISHED, Q.ACCEPTED, Q.SUPERSEDED] } }, orderBy: { publishedAt: 'asc' }, select: CLUB_QUOTE_SELECT } },
  });
  if (!r) throw new NotFoundError('Request');
  return { request: { ...summaryView(r), spec: r.spec, clubNote: r.clubNote, acceptedQuoteId: r.acceptedQuoteId, events: r.events, quotes: r.quotes, people: await peopleOf(tx, r) } };
}
export async function getClubRequest(tenant: Tenant, id: string) { return getClubRequestTx(prisma, tenant, id); }

/** Move a request one step, conditional on the status it starts from. Returns the status it now has. */
async function move(tx: Prisma.TransactionClient, r: Owned & { status: S }, action: Action, kind: ManufacturingActorKind, actor: DesignActor, note: string | null, to?: S) {
  const s = step(action, kind, r.status, note);
  if ('refused' in s) throw new RequestStepError(s.refused, r.status);
  const next = to ?? (s.to === 'same' ? r.status : s.to);
  const moved = await tx.manufacturingRequest.updateMany({ where: { id: r.id, status: r.status }, data: { status: next, version: { increment: 1 } } });
  if (moved.count !== 1) throw new RequestStepError('moved', r.status);
  await event(tx, r, action, r.status, next, kind, actor, note);
  return next;
}

/** The club's own steps: cancel, decline every quotation, or confirm delivery. */
export async function clubStep(tenant: Tenant, actor: DesignActor, id: string, action: 'cancel' | 'decline' | 'deliver', noteIn: string | null) {
  const note = noteOf(noteIn);
  return prisma.$transaction(async (tx) => {
    const r = await tx.manufacturingRequest.findFirst({ where: { id, ...tenantWhere(tenant) }, select: { id: true, clubId: true, creatorId: true, status: true } });
    if (!r) throw new NotFoundError('Request');
    const to = await move(tx, r, action, 'CLUB', actor, note);
    if (action === 'cancel' || action === 'decline') await tx.manufacturingQuote.updateMany({ where: { requestId: id, ...tenantWhere(tenant), status: Q.PUBLISHED }, data: { status: Q.SUPERSEDED } });
    await tenantAudit(tx, tenant, actor, { action: `manufacturing.request.${action}`, resourceType: 'ManufacturingRequest', resourceId: id, metadata: { from: r.status, to }, message: `The club took the step ${action}` });
    return getClubRequestTx(tx, tenant, id);
  });
}

/** Accept one published, still valid quotation: the others are superseded. Nothing is charged. */
export async function acceptQuote(tenant: Tenant, actor: DesignActor, id: string, quoteId: string) {
  return prisma.$transaction(async (tx) => {
    // The request's row is locked first (FOR UPDATE), so two acceptances of one request take turns: the second waits for
    // the first to commit and then reads the request as it now is. Without the lock, under READ COMMITTED, the second
    // could read the request before the first committed (still QUOTED, so allowed) and its quotation after (already set
    // aside), and answer 'not found' where the truth is the conflict. Row-level security applies to the locking read too.
    const own = tenant.kind === 'club' ? Prisma.sql`"clubId" = ${tenant.clubId}` : Prisma.sql`"creatorId" = ${tenant.creatorId}`;
    const locked = await tx.$queryRaw<Array<Owned & { status: S }>>`
      SELECT "id", "clubId", "creatorId", "status"::text AS "status" FROM "ManufacturingRequest" WHERE "id" = ${id} AND ${own} FOR UPDATE`;
    const r = locked[0];
    if (!r) throw new NotFoundError('Request');
    // The workflow first: once a request has left QUOTED (accepted, declined, cancelled), any acceptance is the conflict it
    // is, whichever quotation it names, never a 'not found' for a quotation that was set aside meanwhile.
    const allowed = step('accept', 'CLUB', r.status, null);
    if ('refused' in allowed) throw new RequestStepError(allowed.refused, r.status);
    const q = await tx.manufacturingQuote.findFirst({ where: { id: quoteId, requestId: id, ...tenantWhere(tenant) }, select: { status: true, validUntil: true, totalMinor: true, currency: true, supplier: { select: { status: true } } } });
    if (!q || q.status !== Q.PUBLISHED) throw new NotFoundError('Quotation');
    if (q.validUntil < today()) throw new RequestStepError('quote-expired', r.status);
    // A supplier suspended since it quoted cannot be accepted (the database refuses it too).
    if (q.supplier.status !== ManufacturingSupplierStatus.VERIFIED) throw new RequestStepError('supplier-not-verified', r.status);
    await move(tx, r, 'accept', 'CLUB', actor, null);
    await tx.manufacturingQuote.updateMany({ where: { requestId: id, ...tenantWhere(tenant), status: Q.PUBLISHED, id: { not: quoteId } }, data: { status: Q.SUPERSEDED } });
    await tx.manufacturingQuote.update({ where: { id: quoteId }, data: { status: Q.ACCEPTED } });
    await tx.manufacturingRequest.update({ where: { id }, data: { acceptedQuoteId: quoteId } });
    await tenantAudit(tx, tenant, actor, { action: 'manufacturing.quote.accepted', resourceType: 'ManufacturingRequest', resourceId: id,
      metadata: { quoteId, currency: q.currency, totalMinor: q.totalMinor }, message: 'The club accepted a quotation' });
    return getClubRequestTx(tx, tenant, id);
  });
}

// ── the Platform Owner's side ───────────────────────────────────────────────────────────────────────────────────────

/** Who asked: a club or a creator (P2). A deleted creator's account keeps no name: null. */
const REQUESTER_SELECT = { clubId: true, creatorId: true, club: { select: { name: true } }, creator: { select: { displayName: true } } } as const;
function requesterView(r: { clubId: string | null; creatorId: string | null; club: { name: string } | null; creator: { displayName: string | null } | null }) {
  const requester = r.clubId ? { kind: 'club' as const, id: r.clubId, name: r.club?.name ?? null } : { kind: 'creator' as const, id: r.creatorId as string, name: r.creator?.displayName ?? null };
  return { requester, club: r.clubId ? { id: r.clubId, name: r.club?.name ?? null } : null };
}

const OWNER_QUOTE_SELECT = {
  id: true, status: true, currency: true, totalMinor: true, lines: true, leadTimeDays: true, validUntil: true, supplierReference: true, evidence: true, terms: true,
  publishedAt: true, createdAt: true, supplierId: true, supplier: { select: { name: true, country: true, status: true } },
} as const;

/** Every club's requests, newest change first, optionally of one status. */
export async function listAllRequests(status?: S) {
  const rows = await prisma.manufacturingRequest.findMany({
    where: status ? { status } : {}, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 300,
    select: { ...SUMMARY, ...REQUESTER_SELECT },
  });
  return { requests: rows.map((r) => ({ ...summaryView(r), ...requesterView(r) })) };
}

export async function getRequest(id: string) { return getRequestTx(prisma, id); }

/**
 * M7d: how each verified supplier fits a request, from what the Owner recorded about it and what the request froze
 * (see fit.ts). The Owner's alone: a club never sees another supplier than the one on a published quotation.
 */
export async function requestFit(id: string) {
  const r = await prisma.manufacturingRequest.findUnique({ where: { id }, select: { id: true, spec: true, setsTotal: true, neededBy: true } });
  if (!r) throw new NotFoundError('Request');
  const spec = r.spec as unknown as RequestSpec;
  const want: FitRequest = { forms: spec.garments.map((g) => g.form), sets: r.setsTotal, neededBy: r.neededBy };
  const suppliers = await prisma.manufacturingSupplier.findMany({
    where: { status: ManufacturingSupplierStatus.VERIFIED }, take: 200,
    select: { id: true, name: true, country: true, forms: true, methods: true, minOrderSets: true, leadTimeDays: true },
  });
  const on = today();
  return {
    requestId: r.id, at: on.toISOString().slice(0, 10), forms: [...new Set(want.forms)].sort(), sets: want.sets, neededBy: r.neededBy ? r.neededBy.toISOString().slice(0, 10) : null,
    suppliers: suppliers.map((s) => ({ id: s.id, name: s.name, country: s.country, methods: s.methods, fit: supplierFit(s, want, on) })).sort(byFit),
  };
}
async function getRequestTx(tx: Prisma.TransactionClient, id: string) {
  const r = await tx.manufacturingRequest.findUnique({
    where: { id },
    select: { ...SUMMARY, ...REQUESTER_SELECT, clubNote: true, acceptedQuoteId: true, minors: true, minorsConsentAt: true,
      events: { orderBy: { createdAt: 'asc' }, select: EVENT_SELECT },
      quotes: { orderBy: { createdAt: 'asc' }, select: OWNER_QUOTE_SELECT } },
  });
  if (!r) throw new NotFoundError('Request');
  return { request: { ...summaryView(r), ...requesterView(r), spec: r.spec, clubNote: r.clubNote, acceptedQuoteId: r.acceptedQuoteId, events: r.events, quotes: r.quotes,
    people: await peopleOf(tx, r) } };
}

/** The Owner's steps that need nothing but a note: review, refuse, order, production, shipping, delivery. */
export async function ownerStep(actor: DesignActor, id: string, action: 'review' | 'refuse' | 'order' | 'produce' | 'ship' | 'deliver', noteIn: string | null) {
  const note = noteOf(noteIn);
  return prisma.$transaction(async (tx) => {
    const r = await tx.manufacturingRequest.findUnique({ where: { id }, select: { id: true, clubId: true, creatorId: true, status: true } });
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
  const t = typeof input.terms === 'string' ? input.terms.normalize('NFC').trim() : '';
  if (Array.from(t).length > 1000 || CONTROL.test(t.replace(/\n/g, ''))) throw new QuoteInvalidError('bad-terms', 'terms');
  return { ...input, supplierReference: ref, evidence, terms: t || null, validDate };
}

/** Record a quotation a verified supplier gave, as a draft only the Owner sees. */
export async function recordQuote(actor: DesignActor, id: string, input: QuoteInput) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.manufacturingRequest.findUnique({ where: { id }, select: { id: true, clubId: true, creatorId: true, status: true, spec: true } });
    if (!r) throw new NotFoundError('Request');
    if (r.status !== S.IN_REVIEW && r.status !== S.QUOTED) throw new RequestStepError('wrong-status', r.status);
    const q = cleanQuote(input, r.spec as unknown as RequestSpec);
    const supplier = await tx.manufacturingSupplier.findUnique({ where: { id: q.supplierId }, select: { status: true } });
    if (!supplier) throw new QuoteInvalidError('unknown-supplier', 'supplierId');
    if (supplier.status !== ManufacturingSupplierStatus.VERIFIED) throw new QuoteInvalidError('supplier-not-verified', 'supplierId');
    const quote = await tx.manufacturingQuote.create({
      // P7: a creator's request is quoted as the creator's (one owner, as the request; it was left unset before, which the
      // database's one-owner check refused, so a creator's request could not be quoted at all).
      data: { clubId: r.clubId, creatorId: r.creatorId, requestId: id, supplierId: q.supplierId, currency: q.currency, totalMinor: q.totalMinor, lines: q.lines as unknown as Prisma.InputJsonValue,
        leadTimeDays: q.leadTimeDays, validUntil: q.validDate, supplierReference: q.supplierReference, evidence: q.evidence, terms: q.terms ?? null, recordedById: actor.userId },
      select: { id: true },
    });
    await ownerAudit(tx, actor, { action: 'manufacturing.quote.recorded', resourceType: 'ManufacturingQuote', resourceId: quote.id, clubId: r.clubId,
      metadata: { requestId: id, supplierId: q.supplierId, currency: q.currency, totalMinor: q.totalMinor, terms: q.terms !== null, creatorId: r.creatorId }, message: 'A supplier quotation was recorded' });
    return getRequestTx(tx, id);
  });
}

/** Publish a draft quotation to the club. The request becomes QUOTED. */
export async function publishQuote(actor: DesignActor, id: string, quoteId: string) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.manufacturingRequest.findUnique({ where: { id }, select: { id: true, clubId: true, creatorId: true, status: true } });
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
    const r = await tx.manufacturingRequest.findUnique({ where: { id }, select: { id: true, clubId: true, creatorId: true, status: true } });
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
export async function specDesign(actor: DesignActor, id: string, projectId: string) {
  const r = await prisma.manufacturingRequest.findUnique({ where: { id }, select: { spec: true, clubId: true } });
  if (!r) throw new NotFoundError('Request');
  const g = (r.spec as unknown as RequestSpec).garments.find((x) => x.projectId === projectId);
  if (!g) throw new NotFoundError('Design');
  const rev = await prisma.designRevision.findUnique({ where: { projectId_number: { projectId, number: g.revision } }, select: { document: true, sha256: true } });
  if (!rev || rev.sha256 !== g.sha256) throw new NotFoundError('Design revision');
  // A design leaves the platform only through here, and is recorded when it does (it holds no person's data).
  await prisma.$transaction((tx) => ownerAudit(tx, actor, { action: 'manufacturing.design.exported', resourceType: 'ManufacturingRequest', resourceId: id, clubId: r.clubId,
    metadata: { projectId, revision: g.revision, sha256: rev.sha256 }, message: 'A design was exported as the request froze it' }));
  return { design: { projectId, revision: g.revision, sha256: rev.sha256, document: rev.document } };
}

/** P1: the states in which an order is confirmed with its supplier, the only time the production sheet may leave. */
const SHEET_STATES: ReadonlySet<S> = new Set([S.ORDERED, S.IN_PRODUCTION, S.SHIPPED, S.DELIVERED]);
/** A production sheet asked for before the order is confirmed with its supplier. */
export class SheetRefusedError extends ConflictError {
  readonly code = 'SHEET_NOT_AVAILABLE';
  readonly status: S;
  constructor(status: S) { super('The production sheet is available once the order is confirmed with the supplier'); this.status = status; }
}

/**
 * P1: the production sheet, for the supplier of the accepted quotation, built on the server from the frozen entries and
 * the names still kept. Only once the order is confirmed with that supplier; every export is recorded with it. A withheld
 * or erased name is an empty name: the number and sizes are what the supplier needs.
 */
export async function productionSheet(actor: DesignActor, id: string) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.manufacturingRequest.findUnique({ where: { id }, select: { id: true, status: true, spec: true, acceptedQuoteId: true, ...REQUESTER_SELECT } });
    if (!r) throw new NotFoundError('Request');
    if (!SHEET_STATES.has(r.status) || !r.acceptedQuoteId) throw new SheetRefusedError(r.status);
    const quote = await tx.manufacturingQuote.findUnique({ where: { id: r.acceptedQuoteId }, select: { supplierId: true, supplier: { select: { name: true } } } });
    if (!quote) throw new SheetRefusedError(r.status);
    const spec = r.spec as unknown as RequestSpec;
    const persons = await tx.manufacturingRequestPerson.findMany({ where: { requestId: id }, select: { position: true, name: true, state: true } });
    const nameAt = new Map(persons.map((p) => [p.position, p.name ?? '']));
    const rows = spec.entries.map((e) => ({ name: nameAt.get(e.position) ?? '', number: e.number, top: e.top, shorts: e.shorts, socks: e.socks, qty: e.qty }));
    const kept = persons.filter((p) => p.state === ManufacturingPersonState.KEPT).length;
    await ownerAudit(tx, actor, { action: 'manufacturing.sheet.exported', resourceType: 'ManufacturingRequest', resourceId: id, clubId: r.clubId,
      metadata: { supplierId: quote.supplierId, entries: rows.length, names: kept }, message: 'A production sheet was exported for the order’s supplier' });
    return { sheet: { csv: rosterCsv(rows), fileName: rosterCsvFileName(`${requesterView(r).requester.name ?? 'Familista'} ${spec.collection.name} production sheet`), entries: rows.length, names: kept,
      supplier: { id: quote.supplierId, name: quote.supplier.name } } };
  });
}

/**
 * P7: the tech pack of one design as the request froze it (its revision, checked against the hash the request kept), for
 * the order's supplier: only once the order is confirmed with that supplier, like the production sheet; every export is
 * recorded with the supplier. It holds no person's data: names and numbers come from the production sheet.
 */
export async function productionTechPack(actor: DesignActor, id: string, projectId: string, format: 'json' | 'csv') {
  return prisma.$transaction(async (tx) => {
    const r = await tx.manufacturingRequest.findUnique({ where: { id }, select: { id: true, status: true, spec: true, acceptedQuoteId: true, clubId: true } });
    if (!r) throw new NotFoundError('Request');
    if (!SHEET_STATES.has(r.status) || !r.acceptedQuoteId) throw new SheetRefusedError(r.status);
    const quote = await tx.manufacturingQuote.findUnique({ where: { id: r.acceptedQuoteId }, select: { supplierId: true, supplier: { select: { name: true } } } });
    if (!quote) throw new SheetRefusedError(r.status);
    const g = (r.spec as unknown as RequestSpec).garments.find((x) => x.projectId === projectId);
    if (!g) throw new NotFoundError('Design');
    const rev = await tx.designRevision.findUnique({ where: { projectId_number: { projectId, number: g.revision } }, select: { number: true, sha256: true, document: true, createdAt: true } });
    if (!rev || rev.sha256 !== g.sha256) throw new NotFoundError('Design revision');
    const pack = buildTechPack({ id: projectId, name: g.name }, rev, rev.document as unknown as TechPackDoc);
    const csv = format === 'csv' ? techPackCsv(pack.elements) : null;
    await ownerAudit(tx, actor, { action: 'manufacturing.techpack.exported', resourceType: 'ManufacturingRequest', resourceId: id, clubId: r.clubId,
      metadata: { projectId, revision: g.revision, sha256: rev.sha256, format, supplierId: quote.supplierId }, message: 'A tech pack was exported for the order’s supplier' });
    return { techPack: pack, csv, fileName: `${g.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'design'} v${g.revision} tech pack.${format}`, supplier: { id: quote.supplierId, name: quote.supplier.name } };
  });
}

/** P1: a closed request's kept names, erased for good; the entries' numbers, sizes and sets stay. */
export async function eraseRequestNames(actor: DesignActor, id: string, noteIn: string) {
  const note = noteOf(noteIn);
  if (!note) throw new RequestStepError('note-required', null);
  return prisma.$transaction(async (tx) => {
    const r = await tx.manufacturingRequest.findUnique({ where: { id }, select: { id: true, clubId: true, creatorId: true, status: true } });
    if (!r) throw new NotFoundError('Request');
    if (!FINAL.has(r.status)) throw new RequestStepError('not-closed', r.status);
    const n = await tx.manufacturingRequestPerson.updateMany({ where: { requestId: id, state: ManufacturingPersonState.KEPT }, data: { state: ManufacturingPersonState.ERASED, name: null, erasedAt: new Date() } });
    await ownerAudit(tx, actor, { action: 'manufacturing.names.erased', resourceType: 'ManufacturingRequest', resourceId: id, clubId: r.clubId,
      metadata: { erased: n.count, note }, message: 'The names of a closed request were erased' });
    return getRequestTx(tx, id);
  });
}
