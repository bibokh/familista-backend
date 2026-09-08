/**
 * tests/player-photo-preparation.unit.test.ts
 *
 * A photograph from a phone is a photograph the platform accepts.
 *
 * Picking a normal camera photo was refused outright: the academy card read the
 * file exactly as it stood and rejected anything over 220 KB — which is every
 * picture a phone takes — and told the user to go and find a smaller one. That
 * is not a size limit, it is a broken upload. The other two paths did resize,
 * to 320px and to 512px, and the 512px one then REFUSED what was still too big
 * rather than compressing it further.
 *
 * One preparer now serves all three. It caps the long edge, keeps the aspect
 * ratio, applies the orientation the photo was taken at, and steps the quality
 * down until the result fits the budget — and the budget is set BY the server's
 * limit rather than in place of it. `express.json` still takes 2 MB and is
 * untouched; the client's job is to arrive inside it.
 *
 * Measured in real Chromium before these tests were written: a 4032×3024 JPEG
 * comes out 1400×1050 at quality 0.85 as 219 KB of data URI — 18% of the
 * client budget and 11% of what the server accepts — with the ratio preserved.
 * The ladder below is exercised deterministically instead, because a unit test
 * that encodes JPEGs measures the machine it runs on.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

function between(from: string, to: string): string {
  const a = APP.indexOf(from);
  const b = APP.indexOf(to, a + 1);
  expect(`${from} found: ${a > -1}`).toBe(`${from} found: true`);
  expect(`${to} after it: ${b > a}`).toBe(`${to} after it: true`);
  return APP.slice(a, b);
}
const decomment = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const BLOCK = between('// ── preparing a personal photo for the record', 'function sqPickPhoto() {');

type Row = Record<string, any>;
type Draw = { w: number; h: number; quality: number };

/**
 * The real preparer, over a canvas whose encoder is a stand-in.
 *
 * `bytesFor` decides how big an encode comes out, so a test can describe a
 * photograph that fits at once, one that needs a lower quality, one that needs
 * a smaller size, and one that fits nowhere — and see which the preparer picks.
 */
function harness(bytesFor: (d: Draw) => number) {
  const draws: Draw[] = [];
  let lastDraw: Draw | null = null;
  const document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        drawImage(_src: unknown, _x: number, _y: number, w: number, h: number) {
          lastDraw = { w, h, quality: 0 };
        },
      }),
      toDataURL(_mime: string, quality: number) {
        const d = { ...(lastDraw as Draw), quality };
        draws.push(d);
        // A data URI of the size this encode is said to produce.
        return 'data:image/jpeg;base64,' + 'A'.repeat(Math.max(0, bytesFor(d) - 23));
      },
    }),
  };
  const api = new Function('document', 'FileReader', 'Image', 'createImageBitmap',
    `${BLOCK}\nreturn { _famPreparePhoto, _famPhotoFit, _famPhotoMessage, FAM_PHOTO };`)(
    document,
    undefined,
    undefined,
    // Decoding is not what these tests are about: it answers with the source
    // dimensions the file claims.
    (file: Row) => Promise.resolve({ width: file.width, height: file.height }),
  );
  return { ...api, draws };
}

const file = (width: number, height: number, type = 'image/jpeg') =>
  ({ width, height, type } as unknown as File);

const CAPS = harness(() => 1).FAM_PHOTO;

// ─────────────────────────────────────────────────────────────────────────────
describe('1 · a large normal photo is prepared, not refused', () => {
  it('a 4032×3024 phone photo is resized to the cap and accepted', async () => {
    // Every encode at the cap fits — the ordinary case, and the one that was
    // being rejected outright.
    const h = harness(() => 220000);
    const out = await h._famPreparePhoto(file(4032, 3024));
    expect(out.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(CAPS.MAX_CHARS);
    expect(h.draws[0]).toEqual({ w: 1400, h: 1050, quality: 0.85 });
    // One encode: it fit at the first quality, so nothing was degraded further.
    expect(h.draws).toHaveLength(1);
  });

  it('and the 220 KB refusal that used to stop it is gone', () => {
    const handler = between("if (e.target.getAttribute && e.target.getAttribute('data-at-photo')", '// Coaching-staff photo upload');
    expect(handler).toContain('_famPreparePhoto(file)');
    expect(handler).not.toContain('220000');
    expect(handler).not.toContain('Image too large — use a smaller photo');
    // And the persistence fix is still on the far side of it.
    expect(handler).toContain('_atPersistPhoto(_pid, url);');
    expect(handler).toContain('_atSave();');
  });

  it('a stubborn image drops quality, then size, before it gives up', async () => {
    // Only a small drawing at a low quality fits.
    const h = harness((d) => (d.w <= 350 && d.quality <= 0.65 ? 900000 : 3000000));
    const out = await h._famPreparePhoto(file(4032, 3024));
    expect(out.length).toBeLessThanOrEqual(CAPS.MAX_CHARS);
    // Every quality at 1400, then every quality at 700, then 350 until one fits.
    expect(h.draws.map((d: Draw) => `${d.w}@${d.quality}`)).toEqual([
      '1400@0.85', '1400@0.75', '1400@0.65', '1400@0.55',
      '700@0.85', '700@0.75', '700@0.65', '700@0.55',
      '350@0.85', '350@0.75', '350@0.65',
    ]);
  });

  it('and when nothing fits it says exactly that, localized', async () => {
    const h = harness(() => 9000000);
    await expect(h._famPreparePhoto(file(6000, 6000))).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n/catalogue/en-GB.json'), 'utf8'));
    expect(typeof cat['This image is still too large after compression — please use a different photo'])
      .toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2 · an image that is already small is left alone', () => {
  it('a 400×500 picture is drawn at 400×500 — never enlarged', async () => {
    const h = harness(() => 90000);
    await h._famPreparePhoto(file(400, 500));
    expect(h.draws[0]).toEqual({ w: 400, h: 500, quality: 0.85 });
  });

  it('and it is encoded once, at the best quality, not squeezed for no reason', async () => {
    const h = harness(() => 90000);
    await h._famPreparePhoto(file(600, 400));
    expect(h.draws).toHaveLength(1);
    expect(h.draws[0].quality).toBe(CAPS.QUALITIES[0]);
  });

  it('an image exactly at the cap is not touched either', () => {
    const { _famPhotoFit } = harness(() => 1);
    expect(_famPhotoFit(1400, 900, 1400)).toEqual({ w: 1400, h: 900 });
    expect(_famPhotoFit(80, 1400, 1400)).toEqual({ w: 80, h: 1400 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3 · the aspect ratio survives, so a face is never stretched', () => {
  const { _famPhotoFit } = harness(() => 1);

  it('landscape, portrait and square all keep their proportions', () => {
    for (const [w, h] of [[4032, 3024], [3024, 4032], [3000, 3000], [2600, 1400], [1920, 1080]]) {
      const out = _famPhotoFit(w, h, 1400);
      expect(`${w}x${h} long edge: ${Math.max(out.w, out.h)}`).toBe(`${w}x${h} long edge: 1400`);
      // Within one pixel of the original ratio — the difference is the rounding
      // to whole pixels and nothing else.
      const drift = Math.abs(out.w / out.h - w / h);
      expect(`${w}x${h} ratio drift < 0.002: ${drift < 0.002}`).toBe(`${w}x${h} ratio drift < 0.002: true`);
    }
  });

  it('and an extreme panorama still comes back with both edges real', () => {
    const out = _famPhotoFit(8000, 200, 1400);
    expect(out.w).toBe(1400);
    expect(out.h).toBeGreaterThanOrEqual(1);
    expect(_famPhotoFit(1, 1, 1400)).toEqual({ w: 1, h: 1 });
  });

  it('the drawing is one call at those exact numbers, so nothing distorts it', () => {
    const src = decomment(BLOCK);
    expect(src).toContain('ctx.drawImage(src, 0, 0, fit.w, fit.h);');
    expect((src.match(/drawImage\(/g) || []).length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4 · the formats a camera produces, and only those', () => {
  it('JPEG, PNG and WebP are accepted', async () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      const h = harness(() => 200000);
      await expect(h._famPreparePhoto(file(2000, 1500, type))).resolves.toContain('data:image/jpeg;base64,');
    }
  });

  it('and anything else is refused by type, with its own message', async () => {
    for (const type of ['image/gif', 'application/pdf', 'text/plain', 'image/svg+xml', '']) {
      const h = harness(() => 200000);
      await expect(h._famPreparePhoto(file(100, 100, type)))
        .rejects.toMatchObject({ code: 'TYPE' });
    }
    const h = harness(() => 200000);
    await expect(h._famPreparePhoto(null as unknown as File)).rejects.toMatchObject({ code: 'TYPE' });
    const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n/catalogue/en-GB.json'), 'utf8'));
    expect(typeof cat['That file type is not supported — use a JPEG, PNG or WebP image']).toBe('string');
  });

  it('the orientation the photo was taken at is the one that is stored', () => {
    const src = decomment(BLOCK);
    expect(src).toContain("createImageBitmap(file, { imageOrientation: 'from-image' })");
    // And a browser without it falls back rather than failing.
    expect(src).toContain('_famPhotoDecodeImg(file)');
  });

  it('and every one of those sentences is translated into every locale', () => {
    const dir = path.join(ROOT, 'public/i18n/catalogue');
    // en-US is deliberately sparse — only what differs from the base — and
    // anything absent falls through to en-GB.
    const locales = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('_') && f !== 'en-US.json');
    expect(locales.length).toBeGreaterThan(1);
    for (const f of locales) {
      const cat = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const s of [
        'That file type is not supported — use a JPEG, PNG or WebP image',
        'This image is still too large after compression — please use a different photo',
        'Could not read that image',
      ]) {
        expect(`${f} · ${s}: ${typeof cat[s] === 'string' && !!cat[s]}`).toBe(`${f} · ${s}: true`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('5 · the server\'s limit is met, never moved', () => {
  it('express.json still takes 2 MB, and nothing here raised it', () => {
    const app = fs.readFileSync(path.join(ROOT, 'src/app.ts'), 'utf8');
    expect(app).toContain("app.use(express.json({ limit: '2mb' }));");
  });

  it('and the client budget sits inside it with room to spare', () => {
    // Base64 carries four bytes for every three, and the JSON envelope and its
    // escaping cost a little more. The budget must clear all of that.
    expect(CAPS.MAX_CHARS).toBeLessThan(2 * 1024 * 1024 * 0.8);
    expect(CAPS.MAX_DIM).toBeGreaterThanOrEqual(1200);
    expect(CAPS.MAX_DIM).toBeLessThanOrEqual(1600);
  });

  it('nothing the preparer returns can exceed the budget', async () => {
    for (const size of [1, 500000, CAPS.MAX_CHARS, CAPS.MAX_CHARS + 1]) {
      const h = harness(() => size);
      if (size <= CAPS.MAX_CHARS) {
        const out = await h._famPreparePhoto(file(3000, 2000));
        expect(out.length).toBeLessThanOrEqual(CAPS.MAX_CHARS);
      } else {
        await expect(h._famPreparePhoto(file(3000, 2000))).rejects.toMatchObject({ code: 'TOO_LARGE' });
      }
    }
  });

  it('and the validator the field goes through is unchanged', () => {
    const ctrl = fs.readFileSync(path.join(ROOT, 'src/controllers/player.controller.ts'), 'utf8');
    expect(ctrl).toContain("avatar:       z.string().url().optional().or(z.literal('')),");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('6 · every player-photo path prepares, persists and reloads the same way', () => {
  it('all three call the one preparer, and the old private resizers are gone', () => {
    // The Squad editor.
    const sq = between('function _sqReadPhoto(file) {', 'function _sqUpdatePhotoPreview() {');
    expect(sq).toContain('_famPreparePhoto(file)');
    expect(sq).not.toContain('var max = 320');
    // The Player Center.
    const pc = between('async function pcUploadPhoto(playerId) {', 'function _pcPosGradient(pos) {');
    expect(pc).toContain('await _famPreparePhoto(file)');
    expect(pc).not.toContain('1.5 * 1024 * 1024');
    // The academy card.
    expect(APP).toContain('_famPreparePhoto(file).then(function (url) {');
    // And the resizer that only the Player Center had is no longer in the file.
    expect(APP).not.toContain('_pcResizeImage');
  });

  it('and the record is what is written — never the browser', () => {
    // Player Center and Squad already PATCHed; the academy card does now.
    expect(APP).toContain('SquadAPI.update(playerId, { avatar: dataUrl })');
    expect(APP).toContain("['photo',  'avatar',");
    const persist = between('function _atPersistPhoto(playerId, dataUrl) {', 'function _atOverlay(id) {');
    expect(persist).toContain("_thApi('PATCH', '/players/' + encodeURIComponent(playerId), { avatar: dataUrl })");
    // The record is what is written, and what comes BACK from the record is
    // what the screen is then set to — the persisted row, not the payload the
    // browser happened to send. localStorage carries that answer onward; it is
    // never where the answer comes from.
    expect(persist).toContain('var saved = res && res.data;');
    expect(persist).toContain("var stored = (saved && saved.avatar) || dataUrl;");
    expect(persist).not.toContain('localStorage');
  });

  it('and the reload reads the persisted server value', () => {
    const svc = fs.readFileSync(path.join(ROOT, 'src/services/player.service.ts'), 'utf8');
    expect(svc).toContain("...(dto.avatar        !== undefined && { avatar:        dto.avatar }),");
    // The roster read returns whole rows, so the stored photo comes back with
    // it, and the client maps that column onto the card.
    const list = svc.slice(svc.indexOf('export async function getPlayers('), svc.indexOf('export async function getPlayerById('));
    const call = list.slice(list.indexOf('prisma.player.findMany({'));
    expect(call.slice(0, call.indexOf('orderBy'))).not.toMatch(/\n\s{6}select: \{/);
    expect(APP).toContain('photo: bp.avatar || undefined,');
  });

  it('and none of it decides anything about authorization', () => {
    const src = decomment(BLOCK);
    expect(src).not.toMatch(/CLUB_ADMIN|HEAD_COACH|SUPER_ADMIN|CLUB_OWNER|effectiveAccess|currentClubRole|Membership/);
    // The route and its guard are exactly what they were.
    const routes = fs.readFileSync(path.join(ROOT, 'src/routes/player.routes.ts'), 'utf8');
    expect(routes).toContain("router.patch('/:id',            authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.updatePlayer);");
    expect(routes).toContain("router.put('/:id',              authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.updatePlayer);");
  });

  it('and no delay was added to make any of it feel different', () => {
    expect(decomment(BLOCK)).not.toMatch(/setTimeout|setInterval/);
  });
});
