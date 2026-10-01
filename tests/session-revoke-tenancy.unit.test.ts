/**
 * tests/session-revoke-tenancy.unit.test.ts
 *
 * Cyber Defense, R2 — a club administrator ends sessions in their own club only.
 *
 * Before: `revoke` and `revokeAllForUser` let any CLUB_ADMIN act on any user
 * id, so an administrator of one club could sign out every user of another
 * club (or the platform owner) through
 * DELETE /phase-o/auth/users/:userId/sessions.
 *
 * After: the person themselves, the platform administrator, or a CLUB_ADMIN
 * whose club is the target user's home club or an active membership of theirs.
 */

const CLUB_A = 'club-a';
const CLUB_B = 'club-b';
const users: Record<string, { clubId: string }> = { 'u-a': { clubId: CLUB_A }, 'u-b': { clubId: CLUB_B }, 'u-multi': { clubId: CLUB_B } };
const memberships = [{ userId: 'u-multi', clubId: CLUB_A, isActive: true }];
const sessions: Record<string, { id: string; userId: string; status: string }> = {
  's-b': { id: 's-b', userId: 'u-b', status: 'ACTIVE' },
  's-a': { id: 's-a', userId: 'u-a', status: 'ACTIVE' },
};
const writes: string[] = [];

jest.mock('../src/config/database', () => ({
  prisma: {
    user: { findFirst: async ({ where }: { where: { id: string; clubId: string } }) => (users[where.id]?.clubId === where.clubId ? { id: where.id } : null) },
    membership: {
      findFirst: async ({ where }: { where: { userId: string; clubId: string } }) =>
        memberships.find((m) => m.userId === where.userId && m.clubId === where.clubId && m.isActive) ?? null,
    },
    authSession: {
      findUnique: async ({ where }: { where: { id: string } }) => sessions[where.id] ?? null,
      update: async ({ where }: { where: { id: string } }) => { writes.push(`revoke ${where.id}`); return { ...sessions[where.id], status: 'REVOKED' }; },
      updateMany: async ({ where }: { where: { userId: string } }) => { writes.push(`revokeAll ${where.userId}`); return { count: 1 }; },
    },
  },
}));
jest.mock('../src/security/audit-chain.service', () => ({ appendAuditEventAsync: () => undefined }));

import { revoke, revokeAllForUser } from '../src/auth-prod/session.service';
import { ForbiddenError } from '../src/utils/errors';

const adminA = { userId: 'admin-a', clubId: CLUB_A, role: 'CLUB_ADMIN' };

beforeEach(() => { writes.length = 0; });

describe('revokeAllForUser', () => {
  it('refuses a club admin acting on another club\'s user, and writes nothing', async () => {
    await expect(revokeAllForUser(adminA, 'u-b')).rejects.toBeInstanceOf(ForbiddenError);
    expect(writes).toEqual([]);
  });

  it('allows a club admin for a user of their own club, by home club or by membership', async () => {
    await revokeAllForUser(adminA, 'u-a');
    await revokeAllForUser(adminA, 'u-multi');
    expect(writes).toEqual(['revokeAll u-a', 'revokeAll u-multi']);
  });

  it('allows the person themselves and the platform administrator; refuses other roles', async () => {
    await revokeAllForUser({ userId: 'u-b', clubId: CLUB_B, role: 'HEAD_COACH' }, 'u-b');
    await revokeAllForUser({ userId: 'root', clubId: CLUB_A, role: 'SUPER_ADMIN' }, 'u-b');
    await expect(revokeAllForUser({ userId: 'coach', clubId: CLUB_A, role: 'HEAD_COACH' }, 'u-a')).rejects.toBeInstanceOf(ForbiddenError);
    expect(writes).toEqual(['revokeAll u-b', 'revokeAll u-b']);
  });
});

describe('revoke (one session)', () => {
  it('refuses a club admin ending another club\'s user\'s session', async () => {
    await expect(revoke(adminA, 's-b')).rejects.toBeInstanceOf(ForbiddenError);
    expect(writes).toEqual([]);
  });

  it('allows it inside the admin\'s own club', async () => {
    await revoke(adminA, 's-a');
    expect(writes).toEqual(['revoke s-a']);
  });
});
