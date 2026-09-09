// What the Data Fabric can honestly say about itself
// ─────────────────────────────────────────────────────────────────────────────
// A read-only contract, not a page. The brief is explicit that SYSTEM is not to
// be redesigned in this task, so this is the shape a future Data Fabric module
// would render — nothing more. It is built now, while the fabric is small,
// because a status surface written after the fact reports what is easy to
// measure rather than what matters.
//
// Every figure is counted from a real table in this process. Where nothing
// measures a thing yet, the answer is null with a reason — the same rule the
// rest of SYSTEM already follows. A platform dashboard that invents a number is
// worse than a blank one, because somebody will make a decision on it.

import { prisma } from '../config/database';
import { assertPlatformOwner } from '../platform/system.service';
import type { PlatformActor } from '../platform/access-levels';
import { currentTransport } from './event-bus';
import { registeredEventTypes } from './event-taxonomy';
import { getObjectStore } from './media/object-store';
import { LEGACY_IMAGE_COLUMNS, LEGACY_IMAGE_MIGRATION } from './media/legacy-media';

export interface FabricStatus {
  generatedAt: string;
  events: {
    transport: string | null;
    registeredTypes: number;
    total: number;
    unpublished: number;
    /** Types actually seen, with counts. The taxonomy in use, as opposed to declared. */
    byType: Array<{ eventType: string; count: number }>;
  };
  media: {
    objectStoreProvider: string;
    /** True only when the store can mint a genuinely signed, expiring URL. */
    signedReads: boolean;
    assets: number;
    bytes: number;
    byStatus: Array<{ status: string; count: number }>;
  };
  legacyMedia: {
    /** Columns that can still hold base64 image data. */
    columns: Array<{ table: string; column: string; cap: string }>;
    migration: { status: string; reversibleUntil: string; steps: string[] };
  };
}

/**
 * The fabric's own status. Platform authority only — these figures are
 * cross-tenant by construction and belong to nobody's club.
 */
export async function fabricStatus(actor: PlatformActor): Promise<FabricStatus> {
  await assertPlatformOwner(actor);

  const [total, unpublished, grouped, assets, byStatus, sizes] = await Promise.all([
    prisma.eventOutbox.count(),
    prisma.eventOutbox.count({ where: { publishedAt: null } }),
    prisma.eventOutbox.groupBy({ by: ['kind'], _count: { _all: true } }),
    prisma.mediaAsset.count({ where: { deletedAt: null } }),
    prisma.mediaAsset.groupBy({ by: ['processingStatus'], _count: { _all: true } }),
    prisma.mediaAsset.aggregate({ _sum: { sizeBytes: true }, where: { deletedAt: null } }),
  ]);

  const store = getObjectStore();
  const probe = await store.getSignedReadUrl('__probe__', 1).catch(() => null);

  return {
    generatedAt: new Date().toISOString(),
    events: {
      transport: currentTransport()?.name ?? null,
      registeredTypes: registeredEventTypes().length,
      total,
      unpublished,
      byType: grouped
        .map((g) => ({ eventType: String(g.kind), count: g._count._all }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 25),
    },
    media: {
      objectStoreProvider: store.provider,
      signedReads: probe?.signed ?? false,
      assets,
      bytes: sizes._sum.sizeBytes ?? 0,
      byStatus: byStatus.map((g) => ({ status: String(g.processingStatus), count: g._count._all })),
    },
    legacyMedia: {
      columns: LEGACY_IMAGE_COLUMNS.map((c) => ({ table: c.table, column: c.column, cap: c.cap })),
      migration: {
        status: LEGACY_IMAGE_MIGRATION.status,
        reversibleUntil: LEGACY_IMAGE_MIGRATION.reversibleUntil,
        steps: [...LEGACY_IMAGE_MIGRATION.steps],
      },
    },
  };
}
