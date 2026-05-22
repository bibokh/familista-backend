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
        mfaVerifiedAt?: string | Date | null;
        impersonatedBy?: { adminId: string; userId: string } | null;
      };
      clubId?: string;
    }
  }
}

export {};
