/**
 * Familista Design Studio — a club's brand kit (M2c): its named colours and its logos.
 *
 * Every function takes the club it acts for, which the club routes resolve from the session, never from a request;
 * every query is filtered by that club, and the database holds the same line underneath (row-level security on both
 * tables, 20261123100000). An asset of another club is not found, whatever its id.
 *
 * Logos are kept only as the PNG brand-image.ts made from the upload. Every change writes its PlatformAuditLog entry,
 * with the club, in the same transaction: sizes and hashes, never the image.
 */
import { DesignBrandAssetKind, PlatformAuditCategory, Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { currentEnvironment } from '../environment';
import { normaliseBrandImage } from './brand-image';
import type { DesignActor } from './service';

/** At most this many logos in a club's kit at once (archived ones do not count). */
export const ACTIVE_ASSET_LIMIT = 50;
/** At most this many named colours in a kit. */
export const COLOUR_LIMIT = 24;

export interface BrandColour { label: string; srgb: string }
export interface BrandAssetView {
  id: string; kind: DesignBrandAssetKind; name: string; width: number; height: number; bytes: number; sha256: string;
  createdAt: Date; archivedAt: Date | null;
}
const ASSET_SELECT = { id: true, kind: true, name: true, width: true, height: true, bytes: true, sha256: true, createdAt: true, archivedAt: true } as const;

/** A request the kit cannot take: its colours are malformed, or the kit is full. */
export class BrandKitError extends ConflictError {
  readonly code: string;
  constructor(code: 'BRAND_KIT_FULL', message: string) { super(message); this.code = code; }
}

const HEX = /^#[0-9a-f]{6}$/;
const CONTROL = /[\u0000-\u001F\u007F]/;
/** The colours, as the kit keeps them, or null when any is malformed. Labels are trimmed; hex is lower case. */
export function validColours(input: unknown): BrandColour[] | null {
  if (!Array.isArray(input) || input.length > COLOUR_LIMIT) return null;
  const out: BrandColour[] = [];
  for (const c of input) {
    if (!c || typeof c !== 'object' || Object.keys(c).sort().join() !== 'label,srgb') return null;
    const { label, srgb } = c as Record<string, unknown>;
    if (typeof label !== 'string' || typeof srgb !== 'string') return null;
    const l = label.trim(), s = srgb.toLowerCase();
    if (!l || l.length > 40 || CONTROL.test(l) || !HEX.test(s)) return null;
    out.push({ label: l, srgb: s });
  }
  return out;
}

async function audit(tx: Prisma.TransactionClient, clubId: string, actor: DesignActor, action: string, resourceId: string, metadata: Record<string, unknown>, message: string) {
  await tx.platformAuditLog.create({
    data: {
      adminId: null, userId: actor.userId, clubId, action, category: PlatformAuditCategory.ASSET,
      resourceType: 'DesignBrandKit', resourceId, ipAddress: actor.ipAddress ?? undefined, userAgent: actor.userAgent ?? undefined,
      metadata: { ...metadata, environment: currentEnvironment(), correlationId: actor.correlationId ?? null } as Prisma.InputJsonValue,
      message,
    },
  });
}

async function kitOf(tx: Prisma.TransactionClient, clubId: string, actor: DesignActor) {
  return tx.designBrandKit.upsert({ where: { clubId }, create: { clubId, updatedById: actor.userId }, update: {}, select: { id: true } });
}

/** The club's kit: its colours and its logos (newest first; archived ones only when asked). */
export async function getBrandKit(clubId: string, opts: { archived?: boolean } = {}): Promise<{ colours: BrandColour[]; assets: BrandAssetView[]; limits: { assets: number; colours: number } }> {
  const kit = await prisma.designBrandKit.findUnique({ where: { clubId }, select: { colours: true } });
  const assets = await prisma.designBrandAsset.findMany({
    where: { clubId, archivedAt: opts.archived ? { not: null } : null },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: ACTIVE_ASSET_LIMIT * 2, select: ASSET_SELECT,
  });
  return { colours: (validColours(kit?.colours) ?? []), assets, limits: { assets: ACTIVE_ASSET_LIMIT, colours: COLOUR_LIMIT } };
}

/** Replace the kit's colours. */
export async function setBrandColours(clubId: string, actor: DesignActor, colours: BrandColour[]): Promise<{ colours: BrandColour[] }> {
  return prisma.$transaction(async (tx) => {
    const kit = await kitOf(tx, clubId, actor);
    await tx.designBrandKit.update({ where: { id: kit.id }, data: { colours: colours as unknown as Prisma.InputJsonValue, updatedById: actor.userId } });
    await audit(tx, clubId, actor, 'design.brand.colours.saved', kit.id, { colours: colours.length }, 'The club’s brand colours were saved');
    return { colours };
  });
}

/** Add a logo: the upload is made safe first (brand-image.ts), and only the result is kept. */
export async function addBrandAsset(clubId: string, actor: DesignActor, input: { kind: DesignBrandAssetKind; name: string; body: Buffer }): Promise<{ asset: BrandAssetView }> {
  const image = await normaliseBrandImage(input.body);
  return prisma.$transaction(async (tx) => {
    const kit = await kitOf(tx, clubId, actor);
    const active = await tx.designBrandAsset.count({ where: { clubId, archivedAt: null } });
    if (active >= ACTIVE_ASSET_LIMIT) throw new BrandKitError('BRAND_KIT_FULL', `A brand kit holds at most ${ACTIVE_ASSET_LIMIT} logos; archive one first`);
    const asset = await tx.designBrandAsset.create({
      data: {
        clubId, kitId: kit.id, kind: input.kind, name: input.name, png: image.png, width: image.width, height: image.height,
        bytes: image.bytes, sha256: image.sha256, createdById: actor.userId,
      },
      select: ASSET_SELECT,
    });
    await audit(tx, clubId, actor, 'design.brand.asset.added', asset.id,
      { kind: input.kind, width: image.width, height: image.height, bytes: image.bytes, sha256: image.sha256, uploadBytes: input.body.length },
      'A logo was added to the club’s brand kit');
    return { asset };
  });
}

/** The stored PNG of one of the club's logos (archived ones too: a saved design may still show it). */
export async function getBrandAssetImage(clubId: string, id: string): Promise<{ png: Buffer; sha256: string }> {
  const row = await prisma.designBrandAsset.findFirst({ where: { id, clubId }, select: { png: true, sha256: true } });
  if (!row) throw new NotFoundError('Brand asset');
  return { png: Buffer.from(row.png), sha256: row.sha256 };
}

/** Archive a logo, or return it to the kit. Its bytes are kept either way. */
export async function setBrandAssetArchived(clubId: string, actor: DesignActor, id: string, archived: boolean): Promise<{ asset: BrandAssetView }> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.designBrandAsset.findFirst({ where: { id, clubId }, select: ASSET_SELECT });
    if (!current) throw new NotFoundError('Brand asset');
    if (!!current.archivedAt === archived) return { asset: current };
    if (!archived && (await tx.designBrandAsset.count({ where: { clubId, archivedAt: null } })) >= ACTIVE_ASSET_LIMIT) {
      throw new BrandKitError('BRAND_KIT_FULL', `A brand kit holds at most ${ACTIVE_ASSET_LIMIT} logos; archive one first`);
    }
    await tx.designBrandAsset.updateMany({ where: { id, clubId }, data: { archivedAt: archived ? new Date() : null } });
    const asset = await tx.designBrandAsset.findFirstOrThrow({ where: { id, clubId }, select: ASSET_SELECT });
    await audit(tx, clubId, actor, archived ? 'design.brand.asset.archived' : 'design.brand.asset.unarchived', id, { kind: asset.kind },
      archived ? 'A logo was archived from the club’s brand kit' : 'A logo was returned to the club’s brand kit');
    return { asset };
  });
}
