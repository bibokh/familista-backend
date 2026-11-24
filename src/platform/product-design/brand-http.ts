/**
 * Familista Design Studio — the HTTP handlers of a club's brand kit (M2c), mounted by src/routes/club-design.routes.ts
 * behind its gate (authenticate, the club roles that design kits, the club's entitlement). The club is the one the gate
 * resolved from the session (`res.locals.designScope`); a handler reached without a club scope refuses, never serves.
 */
import express, { type Request, type RequestHandler, type Response } from 'express';
import { designActorOf as actorOf, tenantOfRes } from './scope-http';
import type { Tenant } from '../tenancy/tenant';
import { DesignBrandAssetKind } from '@prisma/client';
import { z } from 'zod';
import { BrandImageError, UPLOAD_LIMITS } from './brand-image';
import { addBrandAsset, getBrandAssetImage, getBrandKit, setBrandAssetArchived, setBrandColours, validColours, BrandKitError } from './brand-kit.service';
import type { DesignActor, DesignScope } from './service';

const AssetId = z.string().guid();
const AddQuery = z.object({ kind: z.enum([DesignBrandAssetKind.CREST, DesignBrandAssetKind.SPONSOR, DesignBrandAssetKind.MARK]), name: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001F\u007F]+$/) }).strict();
const KitQuery = z.object({ state: z.enum(['active', 'archived']).default('active') }).strict();

function handler(work: (req: Request, res: Response, tenant: Tenant) => Promise<void>): RequestHandler {
  return async (req, res, next) => {
    try { await work(req, res, tenantOfRes(res)); } catch (err) {
      if (err instanceof BrandImageError) {
        res.status(err.code === 'too-large' ? 413 : err.code === 'unsupported-type' ? 415 : 400)
          .json({ success: false, code: 'BRAND_IMAGE_REFUSED', reason: err.code, message: err.message });
        return;
      }
      if (err instanceof BrandKitError) { res.status(409).json({ success: false, code: err.code, message: err.message }); return; }
      next(err);
    }
  };
}

const rawParser = express.raw({ type: ['image/png', 'image/jpeg', 'application/octet-stream'], limit: UPLOAD_LIMITS.bytes });
/**
 * The upload's bytes, at most UPLOAD_LIMITS.bytes, read by this route alone. A body over the limit is the brand kit's own
 * refusal (413 BRAND_IMAGE_REFUSED too-large), answered here: the body parser's error would otherwise reach the shared
 * error handler as a 500.
 */
export const rawBrandImage: RequestHandler = (req, res, next) => {
  rawParser(req, res, (err?: unknown) => {
    const e = err as { type?: string; status?: number } | undefined;
    if (e && (e.type === 'entity.too.large' || e.status === 413)) {
      res.status(413).json({ success: false, code: 'BRAND_IMAGE_REFUSED', reason: 'too-large', message: 'The image was refused: too-large' });
      return;
    }
    next(err as Error | undefined);
  });
};

export const readBrandKit = handler(async (req, res, tenant) => {
  const { state } = KitQuery.parse(req.query);
  res.json({ success: true, data: await getBrandKit(tenant, { archived: state === 'archived' }) });
});
export const saveBrandColours = handler(async (req, res, tenant) => {
  const body = z.object({ colours: z.unknown() }).strict().parse(req.body);
  const colours = validColours(body.colours);
  if (!colours) { res.status(400).json({ success: false, code: 'BRAND_COLOURS_INVALID', message: 'At most 24 colours, each a label of 1–40 characters and a #rrggbb colour' }); return; }
  res.json({ success: true, data: await setBrandColours(tenant, actorOf(req), colours) });
});
export const uploadBrandAsset = handler(async (req, res, tenant) => {
  const q = AddQuery.parse(req.query);
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  res.status(201).json({ success: true, data: await addBrandAsset(tenant, actorOf(req), { kind: q.kind, name: q.name, body }) });
});
export const brandAssetImage = handler(async (req, res, tenant) => {
  const img = await getBrandAssetImage(tenant, AssetId.parse(req.params.assetId));
  // Only ever the PNG the server made; never sniffed as anything else, never run as a document.
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline; filename="brand-asset.png"');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('ETag', `"${img.sha256}"`);
  res.status(200).end(img.png);
});
export const archiveBrandAsset = handler(async (req, res, tenant) => {
  res.json({ success: true, data: await setBrandAssetArchived(tenant, actorOf(req), AssetId.parse(req.params.assetId), true) });
});
export const unarchiveBrandAsset = handler(async (req, res, tenant) => {
  res.json({ success: true, data: await setBrandAssetArchived(tenant, actorOf(req), AssetId.parse(req.params.assetId), false) });
});
