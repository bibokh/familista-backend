/**
 * tests/club-crest.unit.test.ts
 *
 * The invariants behind "one club, one crest".
 *
 * Three of them are the whole design:
 *
 *   The crest lives on the Club. Not on the user, not on a team, not in the
 *   browser — so the first team and every academy age group resolve the same
 *   image and there is nothing to keep in sync.
 *
 *   A crest is resolved by club id, never handed in by a caller. That is what
 *   makes it structurally impossible for one club's crest to appear under
 *   another club's name, which is the failure the old `club.emblem`-in-scope
 *   rendering actually produced.
 *
 *   Resolution never touches the network. The registry is filled from payloads
 *   the app already reads, so a table of two hundred crests costs no requests.
 *
 * And two that are easy to lose and expensive to notice: Familista serves a
 * Content-Security-Policy with no 'unsafe-inline', so a crest may carry neither
 * an inline `style` (its size would be silently ignored) nor an inline
 * `onerror` (its fallback would never run, and a dead URL would show the
 * browser's broken-image glyph — exactly what the fallback exists to prevent).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const root = (p: string) => join(__dirname, '..', p);
const read = (p: string) => readFileSync(root(p), 'utf8');

const APP = read('public/app.js');
const CSS = read('public/app.css');
const SCHEMA = read('prisma/schema.prisma');
const CTRL = read('src/controllers/club.controller.ts');

// The primitive, sliced out so a match cannot come from somewhere else.
const LOGO_FN = APP.slice(APP.indexOf('function clubLogoHtml('), APP.indexOf('function clubIdentityHtml('));

describe('the crest belongs to the club', () => {
  it('is a column on Club, and not on User or Team', () => {
    const club = SCHEMA.slice(SCHEMA.indexOf('model Club {'), SCHEMA.indexOf('model Club {') + 1400);
    expect(club).toMatch(/crestUrl\s+String\?/);
    const team = SCHEMA.slice(SCHEMA.indexOf('model Team {'), SCHEMA.indexOf('model Team {') + 1400);
    expect(team).not.toContain('crestUrl');
    const user = SCHEMA.slice(SCHEMA.indexOf('model User {'), SCHEMA.indexOf('model User {') + 2600);
    expect(user).not.toContain('crestUrl');
  });

  it('and ships a migration, so an existing database gets the column', () => {
    const m = 'prisma/migrations/20260828100000_add_club_crest/migration.sql';
    expect(existsSync(root(m))).toBe(true);
    expect(read(m)).toMatch(/ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "crestUrl"/);
  });

  it('travels with every club a client is shown, so opponents carry their own', () => {
    // A market or negotiation payload that names a club without its crest leaves
    // the client with only the reader's own — and that is how an opponent ends
    // up wearing it.
    expect(read('src/services/context.service.ts')).toContain('crestUrl: true');
    expect(read('src/services/membership.service.ts')).toContain('crestUrl: true');
    expect(read('src/transfer-market/public-player.ts')).toContain('crestUrl: true');
    expect(read('src/transfer-market/transfer-negotiation.service.ts')).toContain('crestUrl: true');
    expect(read('src/staff-market/staff-market.service.ts')).toContain('crestUrl: true');
    // …including the placeholder used for a club that cannot be read.
    expect(read('src/transfer-market/public-player.ts')).toMatch(/UNKNOWN_CLUB[\s\S]{0,220}crestUrl: null/);
  });
});

describe('the upload endpoint', () => {
  it('takes an uploaded image or an https URL, and nothing else', () => {
    expect(CTRL).toContain('crestUrl:       crestImage.nullable().optional()');
    expect(CTRL).toMatch(/CREST_DATA_URL = \/\^data:image\\\/\(png\|jpeg\|jpg\|webp\);base64,/);
    expect(CTRL).toContain("/^https:\\/\\//i.test(u)");
  });

  it('caps the payload below the body limit rather than answering 413', () => {
    expect(CTRL).toContain('MAX_CREST_CHARS = 400_000');
    const limit = read('src/app.ts').match(/express\.json\(\{\s*limit:\s*'(\d+)mb'/);
    expect(limit).not.toBeNull();
    // 400 000 characters of base64 is ~0.4 MB — comfortably inside the body cap.
    expect(400_000).toBeLessThan(Number(limit![1]) * 1024 * 1024);
  });

  it('treats an empty value as removal, stored as one thing and not two', () => {
    expect(CTRL).toContain(".transform((u) => (u === '' ? null : u))");
  });

  it('writes to the Club, not to the white-label brand', () => {
    // WhiteLabelConfig.logoUrl brands the product for a white-label deployment;
    // the crest identifies the football club. Different columns, deliberately.
    expect(CTRL).toContain("const BRAND_KEYS = ['logoUrl', 'primaryColor', 'secondaryColor', 'accentColor']");
    expect(CTRL).not.toMatch(/BRAND_KEYS[^;]*crestUrl/);
    expect(read('src/services/club.service.ts')).toMatch(/interface ClubCorePatch \{[\s\S]{0,400}crestUrl\?: string \| null;/);
  });

  it('and is still guarded by role and tenancy', () => {
    const R = read('src/routes/club.routes.ts');
    expect(R).toContain('authorize(UserRole.CLUB_ADMIN, UserRole.SUPER_ADMIN)');
    expect(R).toContain('ensureClubAccess');
  });
});

describe('one primitive resolves every crest, by id', () => {
  it('exists once, and takes a club id rather than an image', () => {
    expect(APP).toContain('function clubLogoHtml(clubId, opts)');
    expect(APP).toContain('function clubIdentityHtml(clubId, opts)');
    expect(APP.match(/function clubLogoHtml\(/g)).toHaveLength(1);
    // The crest comes from the registry keyed by that id — a caller cannot pass
    // an image in, so it cannot pass the wrong club's image in.
    expect(LOGO_FN).toContain('var crest = _clubCrestUrl(clubId);');
    expect(LOGO_FN).not.toMatch(/opts\.(crest|src|url|image)/);
  });

  it('resolves without a request, so a table of crests costs nothing', () => {
    for (const forbidden of ['FamilistaAPI', 'fetch(', 'await ', 'ClubAPI']) {
      expect(LOGO_FN).not.toContain(forbidden);
    }
    const resolver = APP.slice(APP.indexOf('function _clubCrestUrl('), APP.indexOf('function _clubNameOf('));
    expect(resolver).not.toContain('FamilistaAPI');
  });

  it('prefers the uploaded crest and falls back to the legacy emblem', () => {
    const put = APP.slice(APP.indexOf('function _clubIdentPut('), APP.indexOf('function _clubIdentPutAll('));
    expect(put).toContain('c.crestUrl != null ? c.crestUrl');
    expect(put).toContain('c.emblem');
    // An explicit removal must clear the cached image; a payload that simply
    // does not carry one must not.
    expect(put).toContain("e.crest = crest ? String(crest) : '';");
    expect(put).toContain('if (crest !== undefined)');
  });

  it('is emptied on sign-out, so nobody inherits another user\'s clubs', () => {
    expect(APP).toContain('function _clubIdentReset() { CLUB_IDENT = Object.create(null); }');
    const logout = APP.slice(APP.indexOf('function doLogout()'), APP.indexOf('function doLogout()') + 1600);
    expect(logout).toContain('_clubIdentReset()');
  });

  it('and is filled from the payloads the app already reads', () => {
    // The context is every club the user may act for; the market rows are the
    // clubs they may see. Neither read exists for the crest's benefit.
    expect(APP).toContain('_clubIdentPutAll(_ctx.availableClubs)');
    expect(APP).toContain('_clubIdentPutAll(_CO.clubs)');
  });
});

describe('the Content-Security-Policy is not worked around, it is respected', () => {
  it('style-src and script-src still refuse inline', () => {
    const A = read('src/app.ts');
    expect(A).toMatch(/styleSrc:\s*\["'self'"/);
    expect(A).not.toMatch(/styleSrc:[^\]]*unsafe-inline/);
    expect(A).not.toMatch(/scriptSrc:[^\]]*unsafe-inline/);
  });

  it('so the size is a class — an inline style would be silently dropped', () => {
    expect(LOGO_FN).not.toContain('style=');
    expect(LOGO_FN).toContain("'club-logo club-logo--s' + px");
    // Every step the resolver can produce must have a rule, or that size is a
    // crest rendered at the default one.
    const steps = APP.match(/var _CLUB_LOGO_STEPS = \[([^\]]+)\]/)![1].split(',').map((n) => n.trim());
    for (const s of steps) expect(CSS).toContain(`.club-logo--s${s}{ --club-logo-size:${s}px; }`);
  });

  it('and the broken-image fallback is a delegated listener, not an onerror attribute', () => {
    expect(APP).not.toContain('onerror="_clubLogoFallback');
    expect(LOGO_FN).not.toContain('onerror');
    // `error` does not bubble; it has to be caught in the capture phase.
    expect(APP).toMatch(/document\.addEventListener\('error', function \(e\) \{[\s\S]{0,220}club-logo-img[\s\S]{0,120}\}, true\)/);
  });
});

describe('a crest is never stretched, and never shifts the page', () => {
  it('the box is square and the image is contained inside it', () => {
    const block = CSS.slice(CSS.indexOf('CLUB LOGO / CLUB IDENTITY'), CSS.indexOf('RIGHT-TO-LEFT'));
    expect(block).toMatch(/\.club-logo\{[\s\S]*?width:var\(--club-logo-size\);\s*height:var\(--club-logo-size\)/);
    expect(block).toMatch(/\.club-logo-img\{[\s\S]*?object-fit:contain/);
    expect(block).not.toMatch(/\.club-logo-img\{[\s\S]*?object-fit:cover/);
  });

  it('and the placeholder sits behind the image at full size from the start', () => {
    // Not "render nothing, then swap in an image" — that is the reflow.
    expect(LOGO_FN).toContain('_clubShieldSvg()');
    expect(LOGO_FN.indexOf('_clubShieldSvg()')).toBeLessThan(LOGO_FN.indexOf('club-logo-img'));
    const block = CSS.slice(CSS.indexOf('CLUB LOGO / CLUB IDENTITY'), CSS.indexOf('RIGHT-TO-LEFT'));
    expect(block).toMatch(/\.club-logo-ph\{[\s\S]*?position:absolute/);
  });
});

describe('teams inherit the club crest; they do not own one', () => {
  it('the badge resolves the active club, and there is no per-team upload', () => {
    expect(APP).toContain('function _teamClubBadgeHtml()');
    const badge = APP.slice(APP.indexOf('function _teamClubBadgeHtml()'), APP.indexOf('function _acTeamCard(s)'));
    expect(badge).toContain('_famActiveClubId()');
    // One upload surface in the whole client, and it is the club's.
    expect(APP.match(/data-action="clubCrestPick"/g)).toHaveLength(1);
    expect(APP.match(/function clubCrestSave\(/g)).toHaveLength(1);
  });

  it('and it is used by the first team and by an academy age group', () => {
    expect(APP).toContain("document.getElementById('sq-hub-club')");        // First Team
    expect(APP).toContain("class=\"at-head-kicker\">' + _teamClubBadgeHtml()");  // age-group workspace
    expect(APP).toContain("class=\"at-ident-kicker\">' + _teamClubBadgeHtml()"); // age-group identity strip
  });
});

describe('an opponent never wears the reader\'s crest', () => {
  it('the fixture draws each side from its own club id', () => {
    const mc = APP.slice(APP.indexOf('var ourCrest'), APP.indexOf('var ourCrest') + 700);
    expect(mc).toContain('_clubCrestUrl(clubId)');
    expect(mc).toContain('_clubCrestUrl(oppClubId)');
    // The opponent id is settled where it is read, above this block: a fixture
    // that records our own club on both sides yields no opponent crest rather
    // than ours twice.
    expect(APP).toContain('if (oppClubId === clubId) oppClubId = null;');
    // The old form — our crest chosen by which side we are on — is gone.
    expect(APP).not.toContain('var awayEmblemHTML = clubEmblem && !isHome');
  });
});

describe('a club switch reaches every worker', () => {
  // Not strictly the crest, but found by it: uploading a crest for the second
  // club was refused because the worker handling the write had not heard about
  // the switch. The identity cache is per-process and holds for five seconds,
  // and its invalidation used to be per-process too — so for those five seconds
  // another worker was still scoping, authorising and WRITING as the club the
  // user had just left.
  const AUTH = read('src/middleware/auth.middleware.ts');
  const BRIDGE = read('src/infra/channel-bridge.ts');

  it('a forget is announced to the other processes', () => {
    expect(AUTH).toContain('export function forgetIdentityLocal');
    expect(AUTH).toMatch(/export function forgetIdentity\([\s\S]{0,320}forgetIdentityLocal\(userId\);[\s\S]{0,200}remoteForget\(/);
  });

  it('and a received forget is applied locally only, so it cannot loop', () => {
    expect(BRIDGE).toContain('identity.forgetIdentityLocal(');
    expect(BRIDGE).not.toContain('identity.forgetIdentity(');
  });

  it('over a channel the bridge actually subscribes to', () => {
    expect(BRIDGE).toContain("const IDENTITY_CHANNEL = rkey('ch', 'identity');");
    expect(BRIDGE).toMatch(/sub\.subscribe\([^)]*IDENTITY_CHANNEL\)/);
    expect(BRIDGE).toContain('identity.setRemoteIdentityPublisher((userId) => send(IDENTITY_CHANNEL');
  });

  it('and the middleware itself stays free of Redis', () => {
    // The publisher is injected, so one process with no bridge behaves exactly
    // as it did before.
    expect(AUTH).not.toContain("from '../infra/redis'");
    expect(AUTH).toContain('export function setRemoteIdentityPublisher');
  });
});
