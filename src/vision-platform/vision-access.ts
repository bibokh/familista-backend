// FAMILISTA VISION — who may see a session, decided by the platform's own rules
// ─────────────────────────────────────────────────────────────────────────────
// There is no Vision authentication, no Vision role and no Vision permission
// table. There is the platform's `authenticate`, the platform's roles, and the
// platform's club scoping, and this file joins a Vision session to them.
//
// THE DEFAULT IS THE IMPORTANT PART
//
// A session with no declared club is PLATFORM-SCOPED: the platform owner sees
// it and nobody else does. Not "everybody", not "the first club that asks" —
// the narrow answer, because a session whose ownership nobody recorded is a
// session whose ownership nobody knows, and handing it to a club on a guess is
// how one club's footage ends up on another club's screen.
//
// A CLUB PRESIDENT IS NOT A SMALL PLATFORM OWNER
//
// They see their own club's sessions completely and other clubs' sessions not
// at all — not greyed out, not counted, not present. The list they receive is
// filtered before it leaves the server, so a client that ignores its own UI
// cannot enumerate what it was not given.

export type VisionViewerRole = 'PLATFORM_OWNER' | 'CLUB' | 'NONE';

export interface VisionViewer {
  userId: string;
  clubId: string | null;
  role: string | null;
  isPlatformOwner: boolean;
}

export interface ScopedLike {
  clubId: string | null;
  teamId?: string | null;
}

/**
 * May this viewer see this session?
 *
 * Deliberately total and deliberately boring: three cases, no options, no
 * override flag. An access rule with a bypass parameter is an access rule that
 * will one day be called with the bypass set.
 */
export function maySeeSession(viewer: VisionViewer, session: ScopedLike): boolean {
  if (viewer.isPlatformOwner) return true;
  if (session.clubId === null) return false;
  return !!viewer.clubId && viewer.clubId === session.clubId;
}

export function visibleSessions<T extends ScopedLike>(viewer: VisionViewer, all: T[]): T[] {
  return all.filter((s) => maySeeSession(viewer, s));
}

/**
 * Whether this viewer may operate Vision rather than merely read it.
 *
 * Operational controls — starting a session, attaching a source, changing the
 * processing target — are the platform owner's. A club reads its own evidence;
 * it does not run the platform's engine.
 */
export function mayOperateVision(viewer: VisionViewer): boolean {
  return viewer.isPlatformOwner;
}

export function viewerRole(viewer: VisionViewer): VisionViewerRole {
  if (viewer.isPlatformOwner) return 'PLATFORM_OWNER';
  if (viewer.clubId) return 'CLUB';
  return 'NONE';
}
