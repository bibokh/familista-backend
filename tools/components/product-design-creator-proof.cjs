/**
 * Design Studio browser proof, P26 — the Creator Studio (P3), on the compiled application with a real PostgreSQL database:
 * a person invited by the Platform Owner opens their own account at /creator and designs in a personal workspace.
 *
 *   · The gate: sign in and open an account on one card; the age is confirmed or nothing is sent; the platform says when
 *     it cannot send email, instead of promising a link.
 *   · Signed up with the Owner's invitation, the person is in the Design Studio's own room in a PERSONAL workspace: no
 *     club and no Owner navigation, their name, Account in the side rail; a save lands as a PERSONAL project of theirs,
 *     on the creator's routes only, with the club session in the same browser never sent.
 *   · The account panel floats over the studio and moves nothing; asking for the confirmation link again says the
 *     platform cannot send email (it is not configured here). Signing out returns to the gate.
 *   · In Arabic, the gate and the studio read right to left in the room's own words; signing back in works.
 *   · The Owner's console lists the creator and issues an invitation whose code is shown once and kept only as a hash.
 *   · axe finds no WCAG 2.2 A/AA violation (gate, studio with the account panel, console tab; English and Arabic); no CSP
 *     violation, no page error.
 */
'use strict';

module.exports = async function p26(H) {
  const { open, check, OUT, ROOT, db, BASE, TOKENS } = H;
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
  const runAxe = (pg, scope) => pg.evaluate(async ([src, sel]) => {
    if (!window.axe) (0, eval)(src); // eslint-disable-line no-eval -- this script's own tool, never the page's code
    const r = await window.axe.run({ include: [sel] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  }, [fs.readFileSync(axePath, 'utf8'), scope]);
  // The harness aborts every Google Fonts request (open(), offline by design), and Chromium reports that aborted stylesheet
  // as a connect-src violation of the document; the other sections filter it the same way. Anything else counts.
  const csp = (pg) => pg.evaluate(() => (window.__csp || []).filter((c) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(c.uri)));
  const ROOTSEL = '#pd-creator-root';
  const GATE = ROOTSEL + ' .pd-gate';
  const words = (code) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/i18n', code + '.json'), 'utf8'));
  const email = 'p26-' + crypto.randomBytes(3).toString('hex') + '@example.com';
  const PW = 'a long creator passphrase';

  // The Owner's invitation, through the Owner's own route.
  const inv = await fetch(BASE + '/api/v1/system/product-design/creators/invites', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKENS.owner, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, note: 'P26 proof', maxUses: 1, days: 7 }) }).then((r) => r.json());
  const code = inv && inv.data ? inv.data.code : '';
  check('P26 the Owner issues an invitation bound to one address; its code is returned once and the database keeps only its hash',
    /^FAM-/.test(code) && !(await db.creatorInvite.findFirst({ where: { codeHash: code } })) && !!(await db.creatorInvite.findFirst({ where: { email } })), { code: !!code });

  const gate = async (locale) => {
    // `as: 'owner'` leaves the Owner's club session cookie in this browser: the creator's page must never use it.
    const s = await open({ width: 1440, height: 900 }, locale, { as: 'owner', hash: '/creator', wait: false });
    await s.page.waitForFunction(() => { const g = window.__familistaCreatorGateMetrics && window.__familistaCreatorGateMetrics(); return !!g && g.email !== null; }, null, { timeout: 60000 });
    return s;
  };

  // ── 1. the gate, in English ──────────────────────────────────────────────────────────────────────────────────────
  const en = await gate('en-GB');
  const pg = en.page;
  try {
    const first = await pg.evaluate((sel) => ({
      tab: document.querySelector(sel + ' [role="tab"][aria-selected="true"]').textContent, title: document.querySelector(sel + ' .pd-gate-title').textContent,
      aside: document.querySelectorAll(sel + ' .pd-gate-list:not(.pd-gate-services) li').length, services: document.querySelectorAll(sel + ' .pd-gate-services li').length,
      gm: window.__familistaCreatorGateMetrics() }), GATE);
    await pg.click(GATE + ' [data-pd-act="gate-signup"]');
    const signup = await pg.evaluate((sel) => ({ warn: (document.querySelector(sel + ' .pd-note--warn') || {}).textContent || '', age: (document.querySelector(sel + ' .pd-team-check span') || {}).textContent || '',
      fields: [...document.querySelectorAll(sel + ' [data-pd-gate-in]')].map((i) => i.getAttribute('data-pd-gate-in')) }), GATE);
    check('P26 the gate opens on sign-in, lists what the studio does, and its sign-up says the platform cannot send email (none is configured here) and asks for the age',
      first.tab === 'Sign in' && first.title === 'Sign in to the Creator Studio' && first.aside === 4 && first.services === 3 && first.gm.minimumAge === 18 && first.gm.email === false
        && /cannot send email yet/.test(signup.warn) && signup.age === 'I am at least 18 years old.' && signup.fields.join() === 'inviteCode,displayName,email,password,age', { first, signup });

    await pg.fill(GATE + ' [data-pd-gate-in="inviteCode"]', code.toLowerCase());
    await pg.fill(GATE + ' [data-pd-gate-in="displayName"]', 'Proof Creator');
    await pg.fill(GATE + ' [data-pd-gate-in="email"]', email);
    await pg.fill(GATE + ' [data-pd-gate-in="password"]', PW);
    const workBefore = await pg.evaluate((sel) => { const r = document.querySelector(sel + ' .pd-gate-card').getBoundingClientRect(); return [r.x, r.y, r.width]; }, GATE);
    await pg.click(GATE + ' .pd-gate-submit');
    await pg.waitForFunction((sel) => !!document.querySelector(sel + ' [data-pd-gate-error]').textContent, GATE, { timeout: 10000 });
    const refused = await pg.evaluate((sel) => document.querySelector(sel + ' [data-pd-gate-error]').textContent, GATE);
    const workAfter = await pg.evaluate((sel) => { const r = document.querySelector(sel + ' .pd-gate-card').getBoundingClientRect(); return [r.x, r.y, r.width]; }, GATE);
    check('P26 without the age confirmed nothing is sent, the card says why, and nothing moves', refused === 'Confirm your age to open an account.'
      && (await db.creatorAccount.count({ where: { email } })) === 0 && JSON.stringify(workBefore) === JSON.stringify(workAfter), { refused, workBefore, workAfter });
    if (fs.existsSync(axePath)) { const v = await runAxe(pg, GATE); check('P26 en: axe finds no WCAG 2.2 A/AA violation in the gate', v.length === 0, v); }
    await pg.screenshot({ path: path.join(OUT, 'p26-gate-en.png') });

    await pg.check(GATE + ' [data-pd-gate-in="age"]');
    await pg.click(GATE + ' .pd-gate-submit');
    await pg.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && m.workspace === 'PERSONAL'; }, null, { timeout: 60000 });
    await pg.waitForTimeout(400);
    const room = await pg.evaluate((sel) => ({
      side: [...document.querySelectorAll(sel + ' .pd-side .pd-side-label')].map((s) => s.textContent),
      ownerNav: !!document.querySelector(sel + ' nav.pd-ownernav'), who: document.querySelector(sel + ' .pd-owner').textContent,
      card: document.querySelector(sel + ' .pd-ctxcard-text').textContent, live: document.querySelector(sel + ' .pd-sr[role="status"]').textContent,
      ctx: [...document.querySelectorAll(sel + ' .pd-ctx strong')].map((s) => s.textContent),
    }), ROOTSEL);
    const acc = await db.creatorAccount.findUnique({ where: { email } });
    check('P26 signed up with the invitation, the person is in the studio’s own room, in a personal workspace: no club, no Owner navigation, their name, Account in the rail; the account is theirs and not yet confirmed',
      !!acc && acc.displayName === 'Proof Creator' && !acc.emailVerifiedAt && !room.ownerNav && /Proof Creator/.test(room.who) && /Creator/.test(room.who)
        && room.side.join('|') === 'Design Studio|Getting started|Orders|Shared with me|Account|Plan & billing|Global Store' && room.ctx.join('|') === 'Individuals & public' && /Your designs, saved in your personal workspace/.test(room.card)
        && /cannot send email yet/.test(room.live), room);

    // A save lands as the creator's own project, on the creator's routes alone; the club session is never sent.
    const calls0 = en.log.requests.length;
    await pg.click(ROOTSEL + ' [data-pd-act="save"]');
    await pg.waitForFunction(() => { const s = window.__familistaProductDesignMetrics().server; return s.state === 'saved' && s.linked && !s.busy; }, null, { timeout: 30000 });
    const srv = (await pg.evaluate(() => window.__familistaProductDesignMetrics())).server;
    const row = await db.designProject.findUnique({ where: { id: srv.projectId || '' }, select: { ownerKind: true, creatorId: true, clubId: true } });
    const calls = en.log.requests.slice(calls0).filter((r) => r.path.startsWith('/api/')).map((r) => r.method + ' ' + r.path);
    const stored = await pg.evaluate((id) => ({ draft: !!localStorage.getItem('familista_product_design_draft_v1_creator_' + id), link: !!localStorage.getItem('familista_product_design_link_v1_creator_' + id) }), acc && acc.id);
    check('P26 a save lands as a PERSONAL project of this creator, on the creator’s routes only, kept in this browser under the creator’s own keys',
      !!row && row.ownerKind === 'PERSONAL' && row.creatorId === (acc && acc.id) && row.clubId === null && calls.includes('POST /api/v1/creator/projects')
        && calls.every((c) => c.includes('/api/v1/creator/')) && stored.draft && stored.link, { row, calls, stored });

    // The account panel: floats, moves nothing, and is honest about email.
    const box = (sel) => pg.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }, sel);
    const before = await box(ROOTSEL + ' .pd-work');
    await pg.click(ROOTSEL + ' .pd-side [data-pd-act="acct"]');
    await pg.waitForSelector(ROOTSEL + ' #pd-acct[data-open="true"]', { timeout: 10000 });
    await pg.waitForTimeout(350);
    const after = await box(ROOTSEL + ' .pd-work');
    const panel = await pg.evaluate((sel) => ({ pos: getComputedStyle(document.querySelector(sel + ' #pd-acct')).position, name: document.querySelector(sel + ' .pd-acct-name').textContent,
      chip: document.querySelector(sel + ' .pd-acct-state .pd-chip').getAttribute('data-verified'), expanded: document.querySelector(sel + ' .pd-side [data-pd-act="acct"]').getAttribute('aria-expanded') }), ROOTSEL);
    await pg.click(ROOTSEL + ' [data-pd-act="acct-resend"]');
    await pg.waitForSelector(ROOTSEL + ' [data-pd-acct-mail]', { timeout: 10000 });
    const mail = await pg.evaluate((sel) => document.querySelector(sel + ' [data-pd-acct-mail]').getAttribute('data-pd-acct-mail'), ROOTSEL);
    check('P26 the account panel floats over the studio and moves nothing; it shows the address unconfirmed, and sending the link again says the platform cannot send email',
      JSON.stringify(before) === JSON.stringify(after) && panel.pos === 'fixed' && panel.name === 'Proof Creator' && panel.chip === 'false' && panel.expanded === 'true' && mail === 'not-configured', { before, after, panel, mail });
    if (fs.existsSync(axePath)) { const v = await runAxe(pg, ROOTSEL + ' #pd-acct'); check('P26 en: axe finds no WCAG 2.2 A/AA violation in the account panel', v.length === 0, v); }
    await pg.screenshot({ path: path.join(OUT, 'p26-studio-account-en.png') });

    await pg.click(ROOTSEL + ' [data-pd-act="acct-signout"]');
    await pg.waitForFunction(() => { const g = window.__familistaCreatorGateMetrics && window.__familistaCreatorGateMetrics(); return !!g && g.view === 'signin'; }, null, { timeout: 30000 });
    const out = await fetch(BASE + '/api/v1/creator/me', { headers: { Cookie: (await en.ctx.cookies()).map((c) => c.name + '=' + c.value).join('; ') } }).then((r) => r.status);
    check('P26 signing out returns to the gate and ends the creator session (the club session in the same browser is no creator session)', out === 401, { out });
    check('P26 en: no CSP violation and no page error', (await csp(pg)).length === 0 && en.log.errors.length === 0, { csp: await csp(pg), errors: en.log.errors });
  } finally { await en.ctx.close(); }

  // ── 2. Arabic: the gate and the studio right to left ──────────────────────────────────────────────────────────────
  const ar = await gate('ar');
  try {
    const W = words('ar');
    const view = await ar.page.evaluate((sel) => ({ dir: getComputedStyle(document.querySelector(sel)).direction, title: document.querySelector(sel + ' .pd-gate-title').textContent }), GATE);
    check('P26 ar: the gate reads right to left, in the room’s own words', view.dir === 'rtl' && view.title === W['Sign in to the Creator Studio'], view);
    if (fs.existsSync(axePath)) { const v = await runAxe(ar.page, GATE); check('P26 ar: axe finds no WCAG 2.2 A/AA violation in the gate', v.length === 0, v); }
    await ar.page.screenshot({ path: path.join(OUT, 'p26-gate-ar.png') });
    await ar.page.fill(GATE + ' [data-pd-gate-in="email"]', email);
    await ar.page.fill(GATE + ' [data-pd-gate-in="password"]', PW);
    await ar.page.click(GATE + ' .pd-gate-submit');
    await ar.page.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && m.workspace === 'PERSONAL'; }, null, { timeout: 60000 });
    await ar.page.click(ROOTSEL + ' .pd-side [data-pd-act="acct"]');
    await ar.page.waitForSelector(ROOTSEL + ' #pd-acct[data-open="true"]', { timeout: 10000 });
    await ar.page.waitForTimeout(350);
    const st = await ar.page.evaluate((sel) => ({ dir: getComputedStyle(document.querySelector(sel + ' #pd-acct')).direction, title: document.querySelector(sel + ' #pd-acct-title span').textContent }), ROOTSEL);
    check('P26 ar: signing in again opens the studio, and the account panel reads right to left', st.dir === 'rtl' && st.title === W['Account'], st);
    if (fs.existsSync(axePath)) { const v = await runAxe(ar.page, ROOTSEL + ' #pd-acct'); check('P26 ar: axe finds no WCAG 2.2 A/AA violation in the account panel', v.length === 0, v); }
    await ar.page.screenshot({ path: path.join(OUT, 'p26-studio-account-ar.png') });
    check('P26 ar: no CSP violation and no page error', (await csp(ar.page)).length === 0 && ar.log.errors.length === 0, { errors: ar.log.errors });
  } finally { await ar.ctx.close(); }

  // ── 3. the Owner's console: the creator, and an invitation shown once ─────────────────────────────────────────────
  const OWNP = '#pd-root .pd-mfg';
  const own = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'owner', hash: '/#product-design', wait: false });
  try {
    const op = own.page;
    await op.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.mfg; }, null, { timeout: 60000 });
    await op.click('#pd-root .pd-side [data-pd-act="mfg"][data-pd-tab="requests"]');
    await op.click(OWNP + ' [data-pd-act="mfg-tab-creators"]');
    await op.waitForFunction(() => window.__familistaProductDesignMetrics().mfg.creators === 'ready', null, { timeout: 15000 });
    const acc = await db.creatorAccount.findUnique({ where: { email } });
    const listed = await op.evaluate(([sel, id]) => { const li = document.querySelector(sel + ' [data-pd-cr-creator="' + id + '"]'); return li ? li.textContent : null; }, [OWNP, acc.id]);
    await op.fill(OWNP + ' [data-pd-mfg-cr="note"]', 'second creator');
    await op.click(OWNP + ' [data-pd-act="mfg-cr-invite"]');
    await op.waitForSelector(OWNP + ' [data-pd-cr-code]', { timeout: 10000 });
    const shown = await op.evaluate((sel) => document.querySelector(sel + ' .pd-cr-code-text').textContent, OWNP);
    const hash = crypto.createHash('sha256').update('familista:creator:invite:v1:').update(shown).digest('hex');
    const kept = await db.creatorInvite.findFirst({ where: { note: 'second creator' }, select: { codeHash: true } });
    check('P26 the Owner’s console lists the creator, and a new invitation’s code is shown once and kept only as its hash',
      !!listed && /Proof Creator/.test(listed) && /Address not confirmed/.test(listed) && /^FAM-/.test(shown) && !!kept && kept.codeHash === hash && kept.codeHash !== shown, { listed, shown: !!shown });
    if (fs.existsSync(axePath)) { const v = await runAxe(op, OWNP); check('P26 en: axe finds no WCAG 2.2 A/AA violation in the console’s Creators tab', v.length === 0, v); }
    await op.screenshot({ path: path.join(OUT, 'p26-owner-creators-en.png') });
    check('P26 the console: no CSP violation and no page error', (await csp(op)).filter((c) => c.inRoom || /product-design/.test(c.src + c.uri)).length === 0 && own.log.errors.length === 0, own.log.errors);
  } finally { await own.ctx.close(); }
};
