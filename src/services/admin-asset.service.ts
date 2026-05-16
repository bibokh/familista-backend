// Familista — Super Admin White-label Control Panel
// File location: src/services/admin-asset.service.ts
//
// Asset upload pipeline: MIME + size validation, sha256 checksum, optional
// image dimension probe (uses `sharp` if installed, else stores without dims),
// storage write via the configured adapter, atomic DB insert, audit entry.
//
// Required dep:  npm i multer @types/multer
// Optional dep:  npm i sharp           (for dimension extraction)

import crypto from 'crypto';
import path from 'path';
import { prisma } from '../lib/prisma';
import {
  BadRequestError,
  NotFoundError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
} from '../utils/errors';
import { getStorageAdapter } from '../lib/storage/storage.adapter';
import { writePlatformAudit } from '../middleware/admin-rbac.middleware';
import {
  ASSET_MIME_WHITELIST,
  ASSET_MAX_BYTES,
} from '../utils/admin.validators';
import type { AssetUploadMetaInput } from '../utils/admin.validators';
import type { AssetType, WhiteLabelAsset, AssetStorage } from '@prisma/client';
import type { PlatformActor } from '../types/admin.types';

// Structural type — avoids hard `import` dependency on the optional `sharp` package.
type SharpInstance = { metadata(): Promise<{ width?: number; height?: number }> };
type SharpFactory = (input?: Buffer | string) => SharpInstance;
let sharpModule: SharpFactory | null | undefined;
function loadSharp(): SharpFactory | null {
  if (sharpModule !== undefined) return sharpModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sharpModule = require('sharp') as SharpFactory;
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

async function probeDimensions(
  buffer: Buffer,
  contentType: string,
): Promise<{ width: number | null; height: number | null }> {
  if (contentType === 'image/svg+xml') return { width: null, height: null };
  const sharp = loadSharp();
  if (!sharp) return { width: null, height: null };
  try {
    const meta = await sharp(buffer).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

const ASSET_FIELD_MAP: Record<AssetType, keyof WLConfigUpdate> = {
  LOGO_LIGHT: 'logoUrl',
  LOGO_DARK: 'logoDarkUrl',
  FAVICON: 'faviconUrl',
  OG_IMAGE: 'ogImageUrl',
  PDF_HEADER: 'logoUrl',
  PDF_FOOTER: 'logoUrl',
  EMAIL_HEADER_BG: 'logoUrl',
};

type WLConfigUpdate = {
  logoUrl?: string;
  logoDarkUrl?: string;
  faviconUrl?: string;
  ogImageUrl?: string;
};

function extensionFromContentType(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    case 'image/x-icon':
    case 'image/vnd.microsoft.icon':
      return 'ico';
    default:
      return 'bin';
  }
}

export async function uploadAsset(
  actor: PlatformActor,
  clubId: string,
  meta: AssetUploadMetaInput,
  file: { buffer: Buffer; mimetype: string; originalname?: string },
): Promise<WhiteLabelAsset> {
  if (!file?.buffer || !file.buffer.length) {
    throw new BadRequestError('File payload missing or empty');
  }

  const whitelist = ASSET_MIME_WHITELIST[meta.type];
  if (!whitelist.includes(file.mimetype)) {
    throw new UnsupportedMediaTypeError(
      `${meta.type} only accepts: ${whitelist.join(', ')} (received ${file.mimetype})`,
    );
  }

  const maxBytes = ASSET_MAX_BYTES[meta.type];
  if (file.buffer.length > maxBytes) {
    throw new PayloadTooLargeError(
      `${meta.type} exceeds max size ${(maxBytes / 1024).toFixed(0)} KB`,
    );
  }

  let cfg = await prisma.whiteLabelConfig.findUnique({ where: { clubId } });
  if (!cfg) {
    const club = await prisma.club.findUnique({ where: { id: clubId } });
    if (!club) throw new NotFoundError('Club not found');
    cfg = await prisma.whiteLabelConfig.create({
      data: { clubId, productName: club.name, isActive: true },
    });
  }

  const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const ext = extensionFromContentType(file.mimetype);
  const filename = `${meta.type.toLowerCase()}-${checksum.slice(0, 12)}.${ext}`;
  const storageKey = path.posix.join('whitelabel', cfg.id, filename);

  const storage = getStorageAdapter();
  const putResult = await storage.put(storageKey, file.buffer, file.mimetype);

  const dims = await probeDimensions(file.buffer, file.mimetype);

  const result = await prisma.$transaction(async (tx) => {
    if (meta.setAsActive !== false) {
      await tx.whiteLabelAsset.updateMany({
        where: { configId: cfg!.id, type: meta.type, isActive: true },
        data: { isActive: false },
      });
    }

    const asset = await tx.whiteLabelAsset.create({
      data: {
        configId: cfg!.id,
        type: meta.type,
        storage: putResult.storage as AssetStorage,
        bucket: putResult.bucket,
        storageKey: putResult.key,
        url: putResult.url,
        contentType: putResult.contentType,
        bytes: putResult.bytes,
        width: dims.width,
        height: dims.height,
        checksum: putResult.checksum,
        uploadedBy: actor.userId,
        isActive: meta.setAsActive !== false,
      },
    });

    if (meta.setAsActive !== false) {
      const field = ASSET_FIELD_MAP[meta.type];
      const update: WLConfigUpdate = { [field]: putResult.url };
      await tx.whiteLabelConfig.update({
        where: { id: cfg!.id },
        data: { ...update, updatedBy: actor.userId, version: { increment: 1 } },
      });
    }

    return asset;
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId,
    action: 'ASSET_UPLOADED',
    category: 'ASSET',
    resourceType: 'WhiteLabelAsset',
    resourceId: result.id,
    metadata: {
      type: meta.type,
      bytes: result.bytes,
      contentType: result.contentType,
      storage: result.storage,
      checksum: result.checksum,
      originalname: file.originalname ?? null,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return result;
}

export async function listAssets(clubId: string, type?: AssetType): Promise<WhiteLabelAsset[]> {
  const cfg = await prisma.whiteLabelConfig.findUnique({ where: { clubId } });
  if (!cfg) return [];
  return await prisma.whiteLabelAsset.findMany({
    where: { configId: cfg.id, ...(type ? { type } : {}) },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function deleteAsset(
  actor: PlatformActor,
  clubId: string,
  assetId: string,
): Promise<void> {
  const asset = await prisma.whiteLabelAsset.findUnique({
    where: { id: assetId },
    include: { config: true },
  });
  if (!asset || asset.config.clubId !== clubId) {
    throw new NotFoundError('Asset not found');
  }

  if (asset.storage !== 'EXTERNAL_URL' && asset.storageKey) {
    try {
      await getStorageAdapter().delete(asset.storageKey);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('asset storage delete failed', err);
    }
  }

  await prisma.whiteLabelAsset.delete({ where: { id: asset.id } });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId,
    action: 'ASSET_DELETED',
    category: 'ASSET',
    resourceType: 'WhiteLabelAsset',
    resourceId: assetId,
    metadata: { type: asset.type, storage: asset.storage, bytes: asset.bytes },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

export async function getActiveAssetBuffer(
  clubId: string,
  type: AssetType,
): Promise<{ buffer: Buffer; mime: string } | null> {
  const cfg = await prisma.whiteLabelConfig.findUnique({ where: { clubId } });
  if (!cfg) return null;
  const asset = await prisma.whiteLabelAsset.findFirst({
    where: { configId: cfg.id, type, isActive: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!asset) return null;

  if (asset.storage === 'LOCAL' && asset.storageKey) {
    try {
      const { promises: fsp } = await import('fs');
      const root = process.env.WL_ASSETS_DIR ?? path.resolve(process.cwd(), 'uploads');
      const filePath = path.resolve(root, asset.storageKey);
      if (!filePath.startsWith(path.resolve(root))) return null;
      const buffer = await fsp.readFile(filePath);
      return { buffer, mime: asset.contentType };
    } catch {
      return null;
    }
  }
  return null;
}
