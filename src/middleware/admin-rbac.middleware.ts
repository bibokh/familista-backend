// Familista — Super Admin White-label Control Panel
// File location: src/middleware/admin-rbac.middleware.ts
//
// Operator-side RBAC: role gate, capability matrix, IP allowlist, optional
// step-up MFA assertion. Populates `req.platformActor` for downstream handlers
// and emits a `PlatformAuditLog` on every gated request.

import type { Request, Response, NextFunction } from 'express';
import net from 'net';

import { prisma } from '../lib/prisma';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import type { Capability, PlatformActor } from '../types/admin.types';
import type { PlatformRole } from '@prisma/client';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      platformActor?: PlatformActor;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability matrix
// ─────────────────────────────────────────────────────────────────────────────

const ALL_CAPS: ReadonlyArray<Capability> = [
  'branding:read', 'branding:write',
  'asset:upload', 'asset:delete',
  'palette:read', 'palette:write',
  'domain:read', 'domain:write', 'domain:force-verify',
  'org:read', 'org:write', 'org:suspend', 'org:restore', 'limits:write',
  'billing:read', 'billing:override',
  'license:read', 'license:write',
  'feature-flag:read', 'feature-flag:write',
  'impersonate:start', 'impersonate:end',
  'audit:read',
  'platform-admin:read', 'platform-admin:write',
  // ── Admin dashboard surface ──
  'dashboard:read',
  'players:read',
  'coaches:read',
  'managers:read',
  'investor-profile:read', 'investor-profile:write',
  'franchise-unit:read', 'franchise-unit:write',
  'subscription:read',
  'payment:read', 'payment:adjust',
  'ai-engine:read',
  'vision-engine:read',
];

const READ_CAPS: ReadonlyArray<Capability> = ALL_CAPS.filter((c) => c.endsWith(':read'));

const ROLE_CAPABILITIES: Record<PlatformRole, ReadonlySet<Capability>> = {
  PLATFORM_OWNER: new Set(ALL_CAPS),

  PLATFORM_ADMIN: new Set<Capability>([
    'branding:read', 'branding:write',
    'asset:upload', 'asset:delete',
    'palette:read', 'palette:write',
    'domain:read', 'domain:write', 'domain:force-verify',
    'org:read', 'org:write', 'org:suspend', 'org:restore', 'limits:write',
    'billing:read', 'billing:override',
    'license:read', 'license:write',
    'feature-flag:read', 'feature-flag:write',
    'impersonate:start', 'impersonate:end',
    'audit:read',
    'platform-admin:read',
    // dashboard surface — operational write where appropriate
    'dashboard:read',
    'players:read',
    'coaches:read',
    'managers:read',
    'investor-profile:read', 'investor-profile:write',
    'franchise-unit:read', 'franchise-unit:write',
    'subscription:read',
    'payment:read', 'payment:adjust',
    'ai-engine:read',
    'vision-engine:read',
  ]),

  PLATFORM_SUPPORT: new Set<Capability>([
    'branding:read', 'branding:write',
    'asset:upload',
    'palette:read',
    'domain:read', 'domain:write',
    'org:read',
    'license:read',
    'feature-flag:read',
    'impersonate:start', 'impersonate:end',
    'audit:read',
    'platform-admin:read',
    // dashboard surface — read-only, no destructive writes for support
    'dashboard:read',
    'players:read',
    'coaches:read',
    'managers:read',
    'investor-profile:read',
    'franchise-unit:read',
    'subscription:read',
    'payment:read',
    'ai-engine:read',
    'vision-engine:read',
  ]),

  PLATFORM_BILLING: new Set<Capability>([
    'org:read',
    'billing:read', 'billing:override',
    'license:read', 'license:write',
    'limits:write',
    'feature-flag:read',
    'audit:read',
    'platform-admin:read',
    // dashboard surface — billing-relevant reads + payment adjustments
    'dashboard:read',
    'subscription:read',
    'payment:read', 'payment:adjust',
    'franchise-unit:read',
  ]),

  PLATFORM_READ_ONLY: new Set<Capability>(READ_CAPS),
};

export function hasCapability(role: PlatformRole, cap: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.has(cap) ?? false;
}

// ─────────────────────────────────────────────────────────────────────────────
// IP allowlist (supports IPv4/IPv6 exact match and CIDR ranges)
// ─────────────────────────────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  if (cidr === ip) return true;
  if (!cidr.includes('/')) return false;

  const [base, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  if (!Number.isInteger(bits)) return false;

  if (net.isIPv4(base) && net.isIPv4(ip)) {
    if (bits < 0 || bits > 32) return false;
    const a = ipv4ToInt(ip);
    const b = ipv4ToInt(base);
    if (a == null || b == null) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
    return (a & mask) === (b & mask);
  }

  // IPv6: exact prefix match on string form. Sufficient for /128 and for
  // operator-configured allowlists. For broader v6 ranges, swap in `ipaddr.js`.
  if (net.isIPv6(base) && net.isIPv6(ip)) {
    if (bits === 128) return base === ip;
    return false;
  }

  return false;
}

function extractClientIp(req: Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? null;
}

function isIpAllowed(ip: string | null, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true; // empty = open
  if (!ip) return false;
  return allowlist.some((entry) => inCidr(ip, entry));
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit log writer (best-effort; never throws back into the request path)
// ─────────────────────────────────────────────────────────────────────────────

import type { PlatformAuditCategory, PlatformAuditResult } from '@prisma/client';

export async function writePlatformAudit(opts: {
  adminId?: string | null;
  userId?: string | null;
  clubId?: string | null;
  action: string;
  category: PlatformAuditCategory;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  result?: PlatformAuditResult;
  message?: string | null;
}): Promise<void> {
  try {
    await prisma.platformAuditLog.create({
      data: {
        adminId: opts.adminId ?? null,
        userId: opts.userId ?? null,
        clubId: opts.clubId ?? null,
        action: opts.action,
        category: opts.category,
        resourceType: opts.resourceType ?? null,
        resourceId: opts.resourceId ?? null,
        metadata:
          opts.metadata === undefined || opts.metadata === null
            ? undefined
            : (opts.metadata as object),
        ipAddress: opts.ipAddress ?? null,
        userAgent: opts.userAgent ?? null,
        result: opts.result ?? 'SUCCESS',
        message: opts.message ?? null,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('platform audit write failed', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware: requirePlatformRole
// Loads PlatformAdmin row, enforces IP allowlist + optional MFA freshness,
// populates req.platformActor.
// ─────────────────────────────────────────────────────────────────────────────

const MFA_FRESHNESS_MS = 15 * 60 * 1000;

export async function requirePlatformRole(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError('Authentication required');

    const admin = await prisma.platformAdmin.findUnique({
      where: { userId: req.user.id },
    });
    if (!admin || !admin.isActive) {
      throw new ForbiddenError('Not a platform administrator');
    }

    const ip = extractClientIp(req);
    if (!isIpAllowed(ip, admin.ipAllowlist)) {
      await writePlatformAudit({
        adminId: admin.id,
        userId: req.user.id,
        action: 'ACCESS_DENIED_IP',
        category: 'ACCESS',
        ipAddress: ip,
        userAgent: req.headers['user-agent'] ?? null,
        result: 'REJECTED',
        message: `IP ${ip ?? 'unknown'} not in allowlist`,
      });
      throw new ForbiddenError('IP address not permitted');
    }

    const mfaAt = (req.user as unknown as { mfaVerifiedAt?: string | Date | null }).mfaVerifiedAt;
    const mfaDate = mfaAt ? new Date(mfaAt) : null;
    if (admin.mfaEnforced) {
      if (!mfaDate || mfaDate.getTime() < Date.now() - MFA_FRESHNESS_MS) {
        await writePlatformAudit({
          adminId: admin.id,
          userId: req.user.id,
          action: 'ACCESS_DENIED_MFA',
          category: 'ACCESS',
          ipAddress: ip,
          userAgent: req.headers['user-agent'] ?? null,
          result: 'REJECTED',
          message: 'MFA verification required or stale',
        });
        throw new ForbiddenError('MFA verification required for platform actions');
      }
    }

    req.platformActor = {
      adminId: admin.id,
      userId: req.user.id,
      role: admin.role,
      ipAddress: ip,
      userAgent: req.headers['user-agent'] ?? null,
      mfaVerifiedAt: mfaDate,
    };

    prisma.platformAdmin
      .update({ where: { id: admin.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);

    return next();
  } catch (err) {
    return next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware: requireCapability — chain after requirePlatformRole
// ─────────────────────────────────────────────────────────────────────────────

export function requireCapability(cap: Capability) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = req.platformActor;
      if (!actor) throw new UnauthorizedError('Platform context not established');
      if (!hasCapability(actor.role, cap)) {
        await writePlatformAudit({
          adminId: actor.adminId,
          userId: actor.userId,
          action: 'CAPABILITY_DENIED',
          category: 'ACCESS',
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          result: 'REJECTED',
          message: `Missing capability: ${cap}`,
        });
        throw new ForbiddenError(`Missing capability: ${cap}`);
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
