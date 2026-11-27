/**
 * Design Studio browser proof, P18 — the Club Design Studio (M2), in a real browser on the compiled application with a
 * real PostgreSQL database under row-level security, the application sending its context as production does.
 *
 *   · An entitled club's administrator finds the Design Studio in the club's sidebar and opens it in the club's own
 *     workspace: the club's name and the role, no platform-owner navigation, the club's studio the one open and the
 *     platform's not offered.
 *   · A save lands in the club's workspace: the club's own route, a CLUB project of that club in the database, the
 *     club's own draft in this browser (the platform's untouched), and nothing the platform owner's list shows.
 *   · A coach of the same club, and the administrator of a club that is not entitled, are not offered it; the coach who
 *     types its address lands on the club's home, and the other club is refused by the server.
 *   · No Content-Security-Policy violation and no page error; German throughout.
 * Each refusal is paired with the admission it mirrors (the negative controls).
 */
'use strict';

module.exports = async function p18(H) {
  const { open, M, check, OUT, db, BASE, TOKENS } = H;
  const path = require('path');
  const metricsReady = (pg) => pg.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && m.workspace === 'CLUB'; }, null, { timeout: 60000 });
  const navOffered = (pg) => pg.evaluate(() => !!document.querySelector('[data-nav="club-design"]'));
  const csp = (pg) => pg.evaluate(() => (window.__csp || []).filter((c) => c.inRoom || /product-design/.test(c.src + c.uri)));
  const api = (who, url) => fetch(BASE + url, { headers: { Authorization: 'Bearer ' + TOKENS[who], Accept: 'application/json' } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  // ── the entitled club's administrator ───────────────────────────────────────────────────────────────────────────
  const { ctx, page, log } = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'clubAdmin', hash: '/#club-home', wait: false });
  try {
    await page.waitForSelector('[data-nav="club-design"]', { timeout: 30000 }).catch(() => null);
    const offered = await navOffered(page);
    check('P18 an entitled club’s administrator finds the Design Studio in the club’s sidebar', offered);
    await page.click('[data-nav="club-design"]');
    await metricsReady(page);
    await page.waitForTimeout(600);
    const shell = await page.evaluate(() => {
      const root = document.getElementById('pd-club-root'), q = (s) => root.querySelector(s);
      return {
        club: (q('.pd-owner-club') || {}).textContent, role: (q('.pd-owner-role') || {}).textContent,
        ownerNav: root.querySelectorAll('nav.pd-ownernav').length, platformRoom: !!document.querySelector('#pd-root .pd-shell'),
        tiles: [...root.querySelectorAll('.pd-ctx')].map((b) => [b.querySelector('strong').textContent, b.classList.contains('is-active')]),
        side: [...root.querySelectorAll('.pd-side-btn')].map((b) => [b.textContent.trim(), b.getAttribute('aria-current') === 'page']).slice(0, 2),
        card: (q('.pd-ctxcard-text strong') || {}).textContent, hash: location.hash,
      };
    });
    await page.screenshot({ path: path.join(OUT, 'p18-club-design.png') });
    // The room's own styles reach the club's page too: its text is the room's light text, never the browser's default black.
    const ink = await page.evaluate(() => {
      const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
      return ['.pd-layer-name span', '[data-pd-act="save"] + .pd-btn', '.pd-h2', '.pd-card-label'].map((sel) => {
        const e = document.querySelector('#pd-club-root ' + sel); return e ? [sel, +lum(getComputedStyle(e).color).toFixed(2)] : [sel, null];
      });
    });
    check('P18 the room’s own styles reach the club’s page: its text is light on its dark surfaces, never the browser default', ink.every((x) => x[1] !== null && x[1] > 0.3), ink);
    check('P18 it opens in the club’s own workspace: the club and the role, no platform-owner navigation, the club’s studio open and the platform’s not offered',
      shell.club === 'Home FC' && shell.role === 'Club administrator' && shell.ownerNav === 0 && !shell.platformRoom && shell.card === 'Home FC'
        && JSON.stringify(shell.tiles) === JSON.stringify([['Club', true], ['Individuals & public', false]])
        && JSON.stringify(shell.side) === JSON.stringify([['Club home', false], ['Design Studio', true]]) && shell.hash === '#club-design', shell);

    // ── a save lands in the club's workspace ────────────────────────────────────────────────────────────────────────
    const platformDraft = await page.evaluate(() => localStorage.getItem('familista_product_design_draft_v1'));
    await page.click('#pd-club-root [data-pd-act="save"]');
    await page.waitForFunction(() => { const s = window.__familistaProductDesignMetrics().server; return s.state === 'saved' && s.linked && !s.busy; }, null, { timeout: 30000 });
    const srv = (await M(page)).server;
    const row = await db.designProject.findUnique({ where: { id: srv.projectId || '' } });
    const stored = await page.evaluate(() => ({ club: !!localStorage.getItem('familista_product_design_draft_v1_club_club-1'), platform: localStorage.getItem('familista_product_design_draft_v1'),
      link: !!localStorage.getItem('familista_product_design_link_v1_club_club-1'), platformLink: localStorage.getItem('familista_product_design_link_v1') }));
    const calls = log.requests.filter((r) => /\/api\/v1\/(club-design|system\/product-design)\//.test(r.path)).map((r) => r.method + ' ' + r.path);
    check('P18 a save lands in the club’s workspace: the club’s route only, a CLUB project of this club, the club’s own draft and record in this browser, the platform’s untouched',
      !!row && row.ownerKind === 'CLUB' && row.clubId === 'club-1' && calls.length > 0 && calls.every((c) => c.includes('/api/v1/club-design/'))
        && calls.includes('POST /api/v1/club-design/projects') && stored.club && stored.link && stored.platform === platformDraft && stored.platformLink === null,
      { row: row && { ownerKind: row.ownerKind, clubId: row.clubId }, calls, stored: { ...stored, platform: stored.platform === platformDraft } });
    const ownerList = await api('owner', '/api/v1/system/product-design/projects');
    const clubList = await api('clubAdmin', '/api/v1/club-design/projects');
    check('P18 the platform owner’s list does not show the club’s design; the club’s list shows it and nothing of the platform’s',
      ownerList.status === 200 && !ownerList.body.data.projects.some((p) => p.id === srv.projectId)
        && clubList.status === 200 && clubList.body.data.projects.map((p) => p.id).join() === srv.projectId,
      { owner: ownerList.status, club: clubList.status, clubIds: clubList.body.data && clubList.body.data.projects.map((p) => p.id) });
    // ── the club's brand kit (M2c) ──────────────────────────────────────────────────────────────────────────────────
    const sharp = require('sharp');
    const fs = require('fs');
    const logo = path.join(OUT, 'p18-crest.png');
    fs.writeFileSync(logo, Buffer.concat([await sharp({ create: { width: 600, height: 700, channels: 4, background: { r: 31, g: 79, b: 214, alpha: 1 } } }).png().toBuffer(), Buffer.from('appended-marker')]));
    const svg = path.join(OUT, 'p18-evil.svg');
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
    await page.click('#pd-club-root [data-pd-libtab="brand"]');
    await page.waitForFunction(() => window.__familistaProductDesignMetrics().brand.state === 'ready', null, { timeout: 30000 });
    const empty = await page.evaluate(() => (document.querySelector('#pd-club-root .pd-brandkit .pd-empty') || {}).textContent || '');
    await page.fill('#pd-club-root [data-pd-brand-name]', 'Home crest');
    await page.setInputFiles('#pd-club-root [data-pd-brand-file]', logo);
    await page.waitForFunction(() => { const b = window.__familistaProductDesignMetrics().brand; return b.state === 'ready' && b.assets === 1 && !b.busy; }, null, { timeout: 30000 });
    await page.waitForFunction(() => { const i = document.querySelector('#pd-club-root [data-pd-brand-img]'); return !!i && i.complete && i.naturalWidth > 0; }, null, { timeout: 30000 });
    const tile = await page.evaluate(() => {
      const i = document.querySelector('#pd-club-root [data-pd-brand-img]');
      return { name: (document.querySelector('#pd-club-root .pd-brand-card figcaption') || {}).textContent, src: i.getAttribute('src').slice(0, 5), natural: [i.naturalWidth, i.naturalHeight],
        status: (document.querySelector('#pd-club-root [data-pd-brand-status]') || {}).textContent };
    });
    const kept = await db.designBrandAsset.findFirst({ where: { clubId: 'club-1' }, select: { width: true, height: true, png: true } });
    check('P18 a club’s logo uploads into its brand kit, kept and shown only as the server’s re-encoded PNG',
      /No logos yet/.test(empty) && tile.name === 'Home crest' && tile.src === 'blob:' && tile.natural[0] === 600 && tile.natural[1] === 700 && tile.status === 'Logo added.'
        && !!kept && kept.width === 600 && !Buffer.from(kept.png).includes(Buffer.from('appended-marker')), { empty, tile, kept: kept && { w: kept.width, h: kept.height } });
    await page.setInputFiles('#pd-club-root [data-pd-brand-file]', svg);
    await page.waitForFunction(() => /refused/.test((document.querySelector('#pd-club-root [data-pd-brand-status]') || {}).textContent || ''), null, { timeout: 30000 });
    const refusal = await page.evaluate(() => ({ status: document.querySelector('#pd-club-root [data-pd-brand-status]').textContent, assets: window.__familistaProductDesignMetrics().brand.assets }));
    check('P18 an SVG is refused, in the room’s own words, and the kit keeps only the one logo (negative control)',
      refusal.status === 'The image was refused: it is not a PNG or JPEG file.' && refusal.assets === 1 && (await db.designBrandAsset.count({ where: { clubId: 'club-1' } })) === 1, refusal);
    await page.click('#pd-club-root [data-pd-act="brand-save-colours"]');
    await page.waitForFunction(() => window.__familistaProductDesignMetrics().brand.colours > 0, null, { timeout: 30000 });
    const kit = await db.designBrandKit.findUnique({ where: { clubId: 'club-1' }, select: { colours: true } });
    const palette = (await M(page)).palette;
    check('P18 the design’s palette is saved as the club’s colours, in the club’s kit', Array.isArray(kit && kit.colours) && kit.colours.length > 0
      && (palette === undefined || kit.colours.length === palette), { colours: kit && kit.colours.length, palette });
    await page.screenshot({ path: path.join(OUT, 'p18-brand-kit.png') });

    // ── M2c-2: the logo on the garment, in 2D and in 3D, saved in the club's workspace ──────────────────────────────
    await page.click('#pd-club-root [data-pd-act="brand-place"]');
    await page.waitForFunction(() => !!document.querySelector('#pd-club-root .pd-canvas image[href^="data:image/png"]'), null, { timeout: 30000 });
    const placed = await page.evaluate(() => {
      const m = window.__familistaProductDesignMetrics(), i = document.querySelector('#pd-club-root .pd-canvas image[href^="data:image/png"]');
      return { selected: m.selected, w: Number(i.getAttribute('width')), h: Number(i.getAttribute('height')), dpi: (document.querySelector('#pd-club-root [data-pd-dpi]') || {}).getAttribute && document.querySelector('#pd-club-root [data-pd-dpi]').getAttribute('data-pd-dpi') };
    });
    await page.click('#pd-club-root [data-pd-act="save"]');
    await page.waitForFunction(() => { const s = window.__familistaProductDesignMetrics().server; return s.state === 'saved' && !s.busy; }, null, { timeout: 30000 });
    const head = await db.designProject.findUnique({ where: { id: (await M(page)).server.projectId }, select: { headRevision: true, clubId: true } });
    const rev = head && await db.designRevision.findUnique({ where: { projectId_number: { projectId: (await M(page)).server.projectId, number: head.headRevision } }, select: { document: true } });
    const logoLayer = rev && rev.document.surfaces.flatMap((sf) => sf.layers).find((l) => l.type === 'image');
    const crestRow = await db.designBrandAsset.findFirst({ where: { clubId: 'club-1', name: 'Home crest' }, select: { id: true, width: true, height: true } });
    check('P18 a logo is placed on the garment from the brand kit, drawn from its PNG, and saved in the club’s design naming the club’s own logo',
      !!placed.selected && placed.w > 0 && Math.abs(placed.h / placed.w - 700 / 600) < 0.01 && Number(placed.dpi) >= 150
        && !!logoLayer && !!crestRow && logoLayer.asset === crestRow.id && logoLayer.px[0] === crestRow.width && logoLayer.px[1] === crestRow.height && head.clubId === 'club-1',
      { placed, layer: logoLayer && { asset: logoLayer.asset === (crestRow && crestRow.id), px: logoLayer.px }, head });
    await page.click('#pd-club-root [data-pd-mode="3d"]');
    await page.waitForFunction(() => { const t = window.__familistaProductDesignMetrics().three; return (t.state === 'ready' && t.engine && !t.engine.pending) || !!t.failed; }, null, { timeout: 90000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'p18-logo-3d.png') });
    const three = (await M(page)).three;
    check('P18 the garment with its logo opens in 3D', three.state === 'ready' && !three.failed, { state: three.state, failed: three.failed });
    await page.click('#pd-club-root [data-pd-mode="2.5d"]');
    check('P18 no CSP violation and no page error in the club’s room', (await csp(page)).length === 0 && log.errors.length === 0, { csp: await csp(page), errors: log.errors });
  } finally {
    await ctx.close();
  }

  // ── not offered: a coach of the same club, and the administrator of a club that is not entitled ──────────────────
  {
    const { ctx: c2, page: coach } = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'coach', hash: '/#club-home', wait: false });
    try {
      await coach.waitForSelector('.nav-item--workspace', { timeout: 30000 }).catch(() => null);
      const offered = await navOffered(coach);
      await coach.evaluate(() => { location.hash = '#club-design'; });
      await coach.waitForTimeout(2500);
      // The shell keeps the typed address and shows the club's home instead (it does not rewrite the hash on a gated redirect).
      const landed = await coach.evaluate(() => ({ active: (document.querySelector('.page.active') || {}).id, room: !!document.querySelector('#pd-club-root .pd-shell') }));
      const r = await api('coach', '/api/v1/club-design/projects');
      check('P18 a coach of the same club is not offered it, lands on the club’s home when typing its address, and the server refuses him (negative control)',
        !offered && !landed.room && landed.active === 'pg-club-home' && r.status === 403, { offered, landed, status: r.status });
    } finally { await c2.close(); }
    const { ctx: c3, page: other } = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'otherAdmin', hash: '/#club-home', wait: false });
    try {
      await other.waitForSelector('.nav-item--workspace', { timeout: 30000 }).catch(() => null);
      const offered = await navOffered(other);
      const r = await api('otherAdmin', '/api/v1/club-design/projects');
      check('P18 the administrator of a club that is not entitled is not offered it, and the server says why (negative control)',
        !offered && r.status === 403 && r.body.code === 'DESIGN_STUDIO_NOT_ENABLED', { offered, status: r.status, code: r.body.code });
    } finally { await c3.close(); }
  }

  // ── in German ────────────────────────────────────────────────────────────────────────────────────────────────────
  const { ctx: c4, page: de } = await open({ width: 1672, height: 941 }, 'de-DE', { as: 'clubAdmin', hash: '/#club-design', wait: false });
  try {
    await metricsReady(de);
    await de.waitForTimeout(600);
    const words = await de.evaluate(() => {
      const root = document.getElementById('pd-club-root');
      return { role: (root.querySelector('.pd-owner-role') || {}).textContent, home: ((root.querySelector('.pd-side-btn') || {}).textContent || '').trim(),
        card: (root.querySelector('.pd-ctxcard-text span') || {}).textContent, club: (root.querySelector('.pd-owner-club') || {}).textContent };
    });
    check('P18 de-DE: the club’s room is in German, and the club’s name stays the club’s own',
      words.role === 'Vereinsadministrator' && words.home === 'Vereinsstartseite' && words.card === 'Vereinsdesigns, gespeichert im Arbeitsbereich des Vereins' && words.club === 'Home FC', words);
  } finally {
    await c4.close();
  }
};
