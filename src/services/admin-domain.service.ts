// Familista — Super Admin White-label Control Panel
// File location: src/services/admin-domain.service.ts
//
// Cross-tenant domain management for operators: list every domain on the
// platform, search by hostname, force-verify (audited, ops-only), set arbitrary
// statuses, disable/enable, retire, and track SSL issuance state.

import { promises as dnsPromises } from 'dns';
import { prisma } from '../lib/prisma';
import {
  BadRequestError,
  NotFoundError,
} from '../utils/errors';
import { writePlatformAudit } from '../middleware/admin-rbac.middleware';
import type {
  ForceVerifyDomainInput,
  SetDomainStatusInput,
} from '../utils/admin.validators';
import type { PlatformActor } from '../types/admin.types';
import type { WhiteLabelDomain, WhiteLabelDomainStatus } from '@prisma/client';

const VERIFY_HOST_PREFIX = '_familista-verify';

export async function listAllDomains(opts: {
  status?: WhiteLabelDomainStatus;
  search?: string;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = await prisma.whiteLabelDomain.findMany({
    where: {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.search ? { hostname: { contains: opts.search.toLowerCase() } } : {}),
    },
    include: {
      config: {
        include: { club: { select: { id: true, name: true, plan: true } } },
      },
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function getDomain(domainId: string) {
  const domain = await prisma.whiteLabelDomain.findUnique({
    where: { id: domainId },
    include: { config: { include: { club: { select: { id: true, name: true } } } } },
  });
  if (!domain) throw new NotFoundError('Domain not found');
  return domain;
}

async function resolveTxtSafe(host: string): Promise<string[]> {
  try {
    const records = await dnsPromises.resolveTxt(host);
    return records.map((r) => r.join('').trim());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
    throw err;
  }
}

export async function adminVerifyDomain(
  actor: PlatformActor,
  domainId: string,
  input: ForceVerifyDomainInput,
): Promise<WhiteLabelDomain> {
  const domain = await prisma.whiteLabelDomain.findUnique({
    where: { id: domainId },
    include: { config: true },
  });
  if (!domain) throw new NotFoundError('Domain not found');
  if (domain.status === 'DISABLED') throw new BadRequestError('Domain is disabled');

  let matched = false;
  let failureReason: string | null = null;

  if (input.bypassDns) {
    matched = true;
    failureReason = null;
  } else {
    const verifyHost = domain.verifyHost ?? `${VERIFY_HOST_PREFIX}.${domain.hostname}`;
    const records = await resolveTxtSafe(verifyHost);
    matched = records.includes(domain.verifyToken);
    if (!matched) {
      failureReason =
        records.length === 0
          ? `No TXT record at ${verifyHost}`
          : `TXT at ${verifyHost} did not match expected token`;
    }
  }

  const result = await prisma.whiteLabelDomain.update({
    where: { id: domainId },
    data: matched
      ? { status: 'ACTIVE', verifiedAt: new Date(), lastCheckedAt: new Date(), failureReason: null }
      : { status: 'FAILED', lastCheckedAt: new Date(), failureReason },
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId: domain.config.clubId,
    action: input.bypassDns ? 'DOMAIN_FORCE_VERIFIED' : 'DOMAIN_VERIFY_RUN',
    category: 'DOMAIN',
    resourceType: 'WhiteLabelDomain',
    resourceId: domainId,
    metadata: {
      hostname: domain.hostname,
      bypassDns: input.bypassDns,
      reason: input.reason,
      matched,
      failureReason,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    result: matched ? 'SUCCESS' : 'FAILURE',
    message: failureReason,
  });

  return result;
}

export async function setDomainStatus(
  actor: PlatformActor,
  domainId: string,
  input: SetDomainStatusInput,
): Promise<WhiteLabelDomain> {
  const domain = await prisma.whiteLabelDomain.findUnique({
    where: { id: domainId },
    include: { config: true },
  });
  if (!domain) throw new NotFoundError('Domain not found');

  const result = await prisma.whiteLabelDomain.update({
    where: { id: domainId },
    data: {
      status: input.status,
      lastCheckedAt: new Date(),
      ...(input.status === 'ACTIVE' && !domain.verifiedAt ? { verifiedAt: new Date() } : {}),
      ...(input.status === 'FAILED' ? { failureReason: input.reason } : {}),
    },
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId: domain.config.clubId,
    action: 'DOMAIN_STATUS_SET',
    category: 'DOMAIN',
    resourceType: 'WhiteLabelDomain',
    resourceId: domainId,
    metadata: {
      hostname: domain.hostname,
      previousStatus: domain.status,
      newStatus: input.status,
      reason: input.reason,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return result;
}

export async function setSslIssuance(
  actor: PlatformActor,
  domainId: string,
  payload: { issuedAt: Date | null; expiresAt: Date | null },
): Promise<WhiteLabelDomain> {
  const domain = await prisma.whiteLabelDomain.findUnique({
    where: { id: domainId },
    include: { config: true },
  });
  if (!domain) throw new NotFoundError('Domain not found');

  const updated = await prisma.whiteLabelDomain.update({
    where: { id: domainId },
    data: { sslIssuedAt: payload.issuedAt, sslExpiresAt: payload.expiresAt },
  });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId: domain.config.clubId,
    action: 'DOMAIN_SSL_UPDATED',
    category: 'DOMAIN',
    resourceType: 'WhiteLabelDomain',
    resourceId: domainId,
    metadata: { hostname: domain.hostname, ...payload },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

export async function deleteDomain(actor: PlatformActor, domainId: string): Promise<void> {
  const domain = await prisma.whiteLabelDomain.findUnique({
    where: { id: domainId },
    include: { config: true },
  });
  if (!domain) throw new NotFoundError('Domain not found');

  await prisma.whiteLabelDomain.delete({ where: { id: domainId } });

  await writePlatformAudit({
    adminId: actor.adminId,
    userId: actor.userId,
    clubId: domain.config.clubId,
    action: 'DOMAIN_DELETED',
    category: 'DOMAIN',
    resourceType: 'WhiteLabelDomain',
    resourceId: domainId,
    metadata: { hostname: domain.hostname, status: domain.status },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}
