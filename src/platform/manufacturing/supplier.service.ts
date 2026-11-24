/**
 * Familista Manufacturing (M4) — the suppliers the Platform Owner works with.
 *
 * Platform data with no club, reached only on the Owner's routes (behind assertPlatformOwner, on the system path). A
 * supplier starts as a PROSPECT; the Owner verifies it with a note of what was checked, and may suspend it. Only a
 * VERIFIED supplier's quotation is recorded or reaches a club (the service here, and a trigger in the database). No
 * supplier is seeded or presented as a partner: every row is one the Owner created.
 *
 * Ready for the Supplier Portal: `portalWorkspaceId` will name the supplier's own workspace; nothing sets or reads it yet.
 */
import { ManufacturingSupplierStatus, PlatformAuditCategory, Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { currentEnvironment } from '../environment';
import type { DesignActor } from '../product-design/service';

export const SUPPLIER_FORMS = Object.freeze(['top', 'shorts', 'socks'] as const);
export const SUPPLIER_METHODS = Object.freeze(['SUBLIMATION', 'SCREEN_PRINT', 'EMBROIDERY', 'HEAT_TRANSFER'] as const);

export interface SupplierInput {
  name: string; country: string; city: string | null; website: string | null; contactEmail: string | null;
  forms: string[]; methods: string[]; minOrderSets: number | null; leadTimeDays: number | null;
}
const SELECT = {
  id: true, name: true, country: true, city: true, website: true, contactEmail: true, forms: true, methods: true, minOrderSets: true,
  leadTimeDays: true, status: true, verificationNote: true, verifiedAt: true, version: true, createdAt: true, updatedAt: true,
} as const;

/** A supplier the service will not keep as sent. */
export class SupplierInvalidError extends Error {
  readonly code: string; readonly path: string;
  constructor(code: string, at: string) { super(`${code} at ${at}`); this.name = 'SupplierInvalidError'; this.code = code; this.path = at; }
}
/** A save based on a version the supplier has moved on from. */
export class SupplierConflictError extends ConflictError {
  readonly code = 'SUPPLIER_CONFLICT';
  readonly version: number;
  constructor(version: number) { super(`This supplier has a newer version (${version}) than the one this save was based on`); this.version = version; }
}

const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
function tidy(v: string | null, max: number, at: string, required = false): string | null {
  if (v === null || v === undefined) { if (required) throw new SupplierInvalidError('required', at); return null; }
  const s = String(v).normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!s) { if (required) throw new SupplierInvalidError('required', at); return null; }
  if (Array.from(s).length > max || CONTROL.test(s)) throw new SupplierInvalidError('bad-text', at);
  return s;
}
function clean(input: SupplierInput): SupplierInput {
  const name = tidy(input.name, 120, 'name', true) as string;
  if (!/^[A-Z]{2}$/.test(input.country)) throw new SupplierInvalidError('bad-country', 'country');
  const website = tidy(input.website, 200, 'website');
  if (website !== null && !/^https:\/\/[^\s/$.?#].[^\s]*$/i.test(website)) throw new SupplierInvalidError('bad-website', 'website');
  const contactEmail = tidy(input.contactEmail, 200, 'contactEmail');
  if (contactEmail !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw new SupplierInvalidError('bad-email', 'contactEmail');
  const forms = [...new Set(input.forms)];
  if (forms.some((f) => !(SUPPLIER_FORMS as readonly string[]).includes(f))) throw new SupplierInvalidError('bad-form', 'forms');
  const methods = [...new Set(input.methods)];
  if (methods.some((m) => !(SUPPLIER_METHODS as readonly string[]).includes(m))) throw new SupplierInvalidError('bad-method', 'methods');
  return { name, country: input.country, city: tidy(input.city, 80, 'city'), website, contactEmail, forms, methods, minOrderSets: input.minOrderSets, leadTimeDays: input.leadTimeDays };
}

/** One audit entry for a change the Platform Owner made in manufacturing, with the club when it concerns one. */
export async function ownerAudit(
  tx: Prisma.TransactionClient, actor: DesignActor,
  entry: { action: string; resourceType: string; resourceId: string; clubId?: string | null; metadata: Record<string, unknown>; message: string },
): Promise<void> {
  const admin = await tx.platformAdmin.findUnique({ where: { userId: actor.userId }, select: { id: true } });
  await tx.platformAuditLog.create({
    data: {
      adminId: admin?.id ?? null, userId: actor.userId, clubId: entry.clubId ?? null, action: entry.action, category: PlatformAuditCategory.OTHER,
      resourceType: entry.resourceType, resourceId: entry.resourceId, ipAddress: actor.ipAddress ?? undefined, userAgent: actor.userAgent ?? undefined,
      metadata: { ...entry.metadata, environment: currentEnvironment(), correlationId: actor.correlationId ?? null } as Prisma.InputJsonValue,
      message: entry.message,
    },
  });
}

export async function listSuppliers(status?: ManufacturingSupplierStatus) {
  const suppliers = await prisma.manufacturingSupplier.findMany({ where: status ? { status } : {}, orderBy: [{ status: 'asc' }, { name: 'asc' }, { id: 'asc' }], take: 500, select: SELECT });
  return { suppliers };
}
export async function getSupplier(id: string) {
  const supplier = await prisma.manufacturingSupplier.findUnique({ where: { id }, select: SELECT });
  if (!supplier) throw new NotFoundError('Supplier');
  return { supplier };
}

export async function createSupplier(actor: DesignActor, raw: SupplierInput) {
  const input = clean(raw);
  return prisma.$transaction(async (tx) => {
    const supplier = await tx.manufacturingSupplier.create({ data: { ...input, createdById: actor.userId }, select: SELECT });
    await ownerAudit(tx, actor, { action: 'manufacturing.supplier.created', resourceType: 'ManufacturingSupplier', resourceId: supplier.id, metadata: { country: input.country }, message: 'A supplier was recorded as a prospect' });
    return { supplier };
  });
}

export async function updateSupplier(actor: DesignActor, id: string, raw: SupplierInput & { version: number }) {
  const input = clean(raw);
  return prisma.$transaction(async (tx) => {
    const current = await tx.manufacturingSupplier.findUnique({ where: { id }, select: { version: true } });
    if (!current) throw new NotFoundError('Supplier');
    const moved = await tx.manufacturingSupplier.updateMany({ where: { id, version: raw.version }, data: { ...input, version: { increment: 1 } } });
    if (moved.count !== 1) throw new SupplierConflictError(current.version);
    const supplier = await tx.manufacturingSupplier.findUniqueOrThrow({ where: { id }, select: SELECT });
    await ownerAudit(tx, actor, { action: 'manufacturing.supplier.updated', resourceType: 'ManufacturingSupplier', resourceId: id, metadata: { version: supplier.version }, message: 'A supplier was updated' });
    return { supplier };
  });
}

/** Verify a supplier (from a prospect, or again after a suspension), suspend it, or return it to prospect. */
export async function setSupplierStatus(actor: DesignActor, id: string, to: ManufacturingSupplierStatus, note: string) {
  const text = tidy(note, 500, 'note', true) as string;
  if (to === ManufacturingSupplierStatus.VERIFIED && Array.from(text).length < 10) throw new SupplierInvalidError('note-too-short', 'note');
  return prisma.$transaction(async (tx) => {
    const current = await tx.manufacturingSupplier.findUnique({ where: { id }, select: { status: true } });
    if (!current) throw new NotFoundError('Supplier');
    if (current.status === to) throw new SupplierInvalidError('same-status', 'status');
    const data: Prisma.ManufacturingSupplierUpdateInput = to === ManufacturingSupplierStatus.VERIFIED
      ? { status: to, verificationNote: text, verifiedAt: new Date(), verifiedById: actor.userId, version: { increment: 1 } }
      : { status: to, version: { increment: 1 } };
    const supplier = await tx.manufacturingSupplier.update({ where: { id }, data, select: SELECT });
    await ownerAudit(tx, actor, {
      action: `manufacturing.supplier.${to.toLowerCase()}`, resourceType: 'ManufacturingSupplier', resourceId: id,
      metadata: { from: current.status, to, note: text }, message: `A supplier's status became ${to}`,
    });
    return { supplier };
  });
}
