import { UserRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id:    string;
        email: string;
        role:  UserRole;
        clubId: string;                  // Effective clubId (currentClubId ?? primaryClubId)

        // ── Phase A: multi-tenant context ──
        primaryClubId?: string;          // Original User.clubId — kept for back-compat
        currentClubId?: string | null;   // User-selected active club
        currentTeamId?: string | null;   // User-selected active team
        /**
         * Platform authority, resolved by `authenticate`.
         *
         * True for `SUPER_ADMIN` or an active PlatformAdmin row. It is an
         * account-level fact about Familista, deliberately separate from
         * `role` and from every club membership: a platform owner is not a
         * club owner, and this flag never grants a club role.
         */
        isPlatformOwner?: boolean;
        mfaVerifiedAt?: string | Date | null;
        impersonatedBy?: { adminId: string; userId: string } | null;
      };
      clubId?: string;
      /**
       * A signed-in creator (Creator Studio, P2), resolved by `authenticateCreator` from a token of the creator audience
       * alone. Never set together with `user`: a creator is not a club user, and no club route reads this.
       */
      creator?: { id: string; tokenVersion: number; emailVerified: boolean; locale: string };
    }
  }
}

export {};
