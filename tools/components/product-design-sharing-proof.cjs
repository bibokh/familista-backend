/**
 * Design Studio browser proof, P27 — sharing between creators (P4), on the compiled application with a real PostgreSQL
 * database: one creator shares a saved design from its Review tab; another opens it from "Shared with me", sees it drawn
 * as its owner saved it, and adds a note; the owner sees the note and stops sharing; the collaborator no longer can.
 *
 *   · The owner's Review tab lists who the design is shared with and what they may do; sharing adds a row, nothing moves.
 *   · The collaborator's panel floats over the studio; the design is drawn view by view; a note lands on the owner's design
 *     as the collaborator's own, in the database too.
 *   · Stopping the share ends it: the collaborator's panel says so, and the server agrees.
 *   · Arabic right to left; axe finds no WCAG 2.2 A/AA violation (English and Arabic); no CSP violation, no page error.
 */
'use strict';

module.exports = async function p27(H) {
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
  // The harness aborts Google Fonts (offline by design); Chromium reports that aborted stylesheet as connect-src.
  const csp = (pg) => pg.evaluate(() => (window.__csp || []).filter((c) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(c.uri)));
  const R = '#pd-creator-root';
  const words = (code) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/i18n', code + '.json'), 'utf8'));
  const tag = crypto.randomBytes(3).toString('hex');
  const PW = 'a long creator passphrase';

  // Two creators, each with the Owner's invitation, opened through the creator's own routes.
  async function creator(name) {
    const email = `p27-${name.split(" ")[0].toLowerCase()}-${tag}@example.com`;
    const inv = await fetch(BASE + '/api/v1/system/product-design/creators/invites', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKENS.owner, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, note: 'P27', maxUses: 1, days: 7 }) }).then((r) => r.json());
    if (!inv || !inv.data) throw new Error('P27 invitation refused: ' + JSON.stringify(inv).slice(0, 300));
    const reg = await fetch(BASE + '/api/v1/creator/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteCode: inv.data.code, email, password: PW, displayName: name, ageConfirmed: true }) }).then((r) => r.json());
    return { email, id: reg.data.creator.id };
  }
  const owner = await creator('Olivia Owner');
  const peer = await creator('Pablo Peer');
  // Pilot readiness: sharing by address comes with a plan the Owner grants, never by default (receiving needs none). The
  // plan is withdrawn from offer once granted, so the sections after this one see the plans they configure themselves.
  const PD = BASE + '/api/v1/system/product-design';
  const asOwner = (method, url, body) => fetch(PD + url, { method, headers: { Authorization: 'Bearer ' + TOKENS.owner, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  const plan = { name: 'P27 sharing', features: ['team_kit', 'brand_studio', 'reviews', 'collaboration', 'manufacturing'] };
  const made = await asOwner('POST', '/plans', { key: `p27-share-${tag}`, audience: 'CREATOR', ...plan });
  const granted = made && made.success ? await asOwner('POST', '/billing/grant', { tenantKind: 'creator', tenantId: owner.id, planKey: `p27-share-${tag}`, months: null, note: 'P27 browser proof' }) : null;
  const withdrawn = granted && granted.success ? await asOwner('PUT', '/plans/' + made.data.plan.id, { ...plan, active: false }) : null;
  if (!withdrawn || !withdrawn.success) throw new Error('P27 the sharing plan could not be granted: ' + JSON.stringify({ made, granted, withdrawn }).slice(0, 400));

  async function signedIn(locale, who) {
    const s = await open({ width: 1672, height: 941 }, locale, { as: 'owner', hash: '/creator', wait: false });
    await s.page.waitForFunction(() => { const g = window.__familistaCreatorGateMetrics && window.__familistaCreatorGateMetrics(); return !!g && g.email !== null; }, null, { timeout: 60000 });
    await s.page.fill(R + ' [data-pd-gate-in="email"]', who.email);
    await s.page.fill(R + ' [data-pd-gate-in="password"]', PW);
    await s.page.click(R + ' .pd-gate-submit');
    await s.page.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && m.workspace === 'PERSONAL'; }, null, { timeout: 60000 });
    await s.page.waitForTimeout(300);
    return s;
  }
  const box = (pg, sel) => pg.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }, sel);

  // ── 1. the owner saves a design and shares it from its Review tab ─────────────────────────────────────────────────
  const own = await signedIn('en-GB', owner);
  let projectId = null;
  try {
    const pg = own.page;
    await pg.click(R + ' [data-pd-act="save"]');
    await pg.waitForFunction(() => { const s = window.__familistaProductDesignMetrics().server; return s.state === 'saved' && s.linked && !s.busy; }, null, { timeout: 30000 });
    projectId = (await pg.evaluate(() => window.__familistaProductDesignMetrics())).server.projectId;
    await pg.click(R + ' .pd-actions [data-pd-act="review"]');
    await pg.waitForFunction(() => { const r = window.__familistaProductDesignMetrics().review; return !!r && r.state === 'ready' && !!r.shares && r.shares.state === 'ready'; }, null, { timeout: 20000 });
    const empty = await pg.evaluate((sel) => document.querySelector(sel + ' .pd-rv-share .pd-empty').textContent, R);
    await pg.waitForTimeout(450); // the dock has finished opening (opacity and transform only) before anything is measured
    const before = await box(pg, R + ' .pd-dock');
    await pg.fill(R + ' [data-pd-rv="share-email"]', peer.email);
    await pg.selectOption(R + ' [data-pd-rv="share-role"]', 'COMMENT');
    await pg.click(R + ' [data-pd-act="rv-share"]');
    await pg.waitForSelector(R + ' [data-pd-rv-share]', { timeout: 10000 });
    const row = await pg.evaluate((sel) => { const li = document.querySelector(sel + ' [data-pd-rv-share]'); return { text: li.textContent, role: li.querySelector('.pd-chip').getAttribute('data-role') }; }, R);
    const kept = await db.designShare.findFirst({ where: { projectId, granteeId: peer.id, revokedAt: null }, select: { role: true, creatorId: true } });
    check('P27 the owner’s Review tab says the design is not shared, then shares it with a creator by address, to comment; the database holds the share',
      /Not shared/.test(empty) && /Pablo Peer/.test(row.text) && row.role === 'COMMENT' && !!kept && kept.role === 'COMMENT' && kept.creatorId === owner.id, { empty, row, kept });
    const after = await box(pg, R + ' .pd-dock');
    check('P27 sharing repaints the tab’s list; the panel itself does not move', JSON.stringify(before) === JSON.stringify(after), { before, after });
    if (fs.existsSync(axePath)) { const v = await runAxe(pg, R + ' .pd-dock'); check('P27 en: axe finds no WCAG 2.2 A/AA violation in the Review tab with its sharing', v.length === 0, v); }
    await pg.screenshot({ path: path.join(OUT, 'p27-owner-share-en.png') });
    check('P27 owner: no CSP violation and no page error', (await csp(pg)).length === 0 && own.log.errors.length === 0, { csp: await csp(pg), errors: own.log.errors });
  } finally { await own.ctx.close(); }

  // ── 2. the collaborator opens it and adds a note ──────────────────────────────────────────────────────────────────
  const col = await signedIn('en-GB', peer);
  try {
    const pg = col.page;
    const work = await box(pg, R + ' .pd-work');
    await pg.click(R + ' .pd-side [data-pd-act="shared"]');
    await pg.waitForFunction(() => { const s = window.__familistaProductDesignMetrics().shared; return !!s && s.open && s.list === 'ready'; }, null, { timeout: 15000 });
    const listed = await pg.evaluate((sel) => [...document.querySelectorAll(sel + ' [data-pd-shared]')].map((li) => ({ id: li.getAttribute('data-pd-shared'), text: li.textContent })), R);
    await pg.click(R + ` [data-pd-act="shared-open"][data-pd-id="${projectId}"]`);
    await pg.waitForFunction(() => window.__familistaProductDesignMetrics().shared.design === 'ready', null, { timeout: 15000 });
    const views = await pg.evaluate((sel) => ({ svgs: document.querySelectorAll(sel + ' .pd-shared-view svg').length, figs: document.querySelectorAll(sel + ' .pd-shared-view').length,
      pos: getComputedStyle(document.querySelector(sel + ' #pd-shared')).position }), R);
    check('P27 the collaborator’s Shared with me lists the design with its owner and what they may do, and opens it drawn view by view, floating over the studio, which does not move',
      listed.length === 1 && listed[0].id === projectId && /Olivia Owner/.test(listed[0].text) && /Can comment/.test(listed[0].text)
        && views.svgs > 0 && views.svgs === views.figs && views.pos === 'fixed' && JSON.stringify(work) === JSON.stringify(await box(pg, R + ' .pd-work')), { listed, views });
    await pg.fill(R + ' [data-pd-shared-in="body"]', 'Could the sleeve stripe be thinner?');
    await pg.click(R + ' [data-pd-act="shared-comment"]');
    await pg.waitForFunction(() => window.__familistaProductDesignMetrics().shared.notes === 1, null, { timeout: 15000 });
    const note = await db.designReviewComment.findFirst({ where: { projectId }, select: { creatorId: true, authorId: true, body: true } });
    check('P27 the collaborator’s note lands on the owner’s design as the collaborator’s own, and shows in the panel',
      !!note && note.creatorId === owner.id && note.authorId === peer.id && note.body === 'Could the sleeve stripe be thinner?', note);
    if (fs.existsSync(axePath)) { const v = await runAxe(pg, R + ' #pd-shared'); check('P27 en: axe finds no WCAG 2.2 A/AA violation in Shared with me', v.length === 0, v); }
    await pg.screenshot({ path: path.join(OUT, 'p27-collaborator-en.png') });
    check('P27 collaborator: no CSP violation and no page error', (await csp(pg)).length === 0 && col.log.errors.length === 0, { csp: await csp(pg), errors: col.log.errors });
  } finally { await col.ctx.close(); }

  // ── 3. Arabic, then the owner stops sharing and the collaborator no longer sees it ────────────────────────────────
  const ar = await signedIn('ar', peer);
  try {
    const pg = ar.page;
    await pg.click(R + ' .pd-side [data-pd-act="shared"]');
    await pg.waitForFunction(() => { const s = window.__familistaProductDesignMetrics().shared; return !!s && s.list === 'ready' && s.count === 1; }, null, { timeout: 15000 });
    await pg.click(R + ` [data-pd-act="shared-open"][data-pd-id="${projectId}"]`);
    await pg.waitForFunction(() => window.__familistaProductDesignMetrics().shared.design === 'ready', null, { timeout: 15000 });
    const W = words('ar');
    const v = await pg.evaluate((sel) => ({ dir: getComputedStyle(document.querySelector(sel + ' #pd-shared')).direction, title: document.querySelector(sel + ' #pd-shared-title span').textContent }), R);
    check('P27 ar: the shared design reads right to left, in the room’s own words', v.dir === 'rtl' && v.title === W['Shared design'], v);
    if (fs.existsSync(axePath)) { const a = await runAxe(pg, R + ' #pd-shared'); check('P27 ar: axe finds no WCAG 2.2 A/AA violation in Shared with me', a.length === 0, a); }
    await pg.screenshot({ path: path.join(OUT, 'p27-collaborator-ar.png') });

    // The owner stops sharing (through the owner's own route), and the open panel learns it at its next step.
    const o = await fetch(BASE + '/api/v1/creator/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: owner.email, password: PW }) }).then((r) => r.json());
    const auth = { Authorization: 'Bearer ' + o.data.accessToken, 'Content-Type': 'application/json' };
    const list = await fetch(BASE + `/api/v1/creator/projects/${projectId}/shares`, { headers: auth }).then((r) => r.json());
    await fetch(BASE + `/api/v1/creator/projects/${projectId}/shares/${list.data.shares[0].id}/revoke`, { method: 'POST', headers: auth, body: '{}' });
    await pg.fill(R + ' [data-pd-shared-in="body"]', 'One more');
    await pg.click(R + ' [data-pd-act="shared-comment"]');
    await pg.waitForFunction(() => window.__familistaProductDesignMetrics().shared.design === 'gone', null, { timeout: 15000 });
    await pg.click(R + ' [data-pd-act="shared-back"]');
    await pg.waitForFunction(() => { const s = window.__familistaProductDesignMetrics().shared; return s.list === 'ready' && s.count === 0; }, null, { timeout: 15000 });
    const notes = await db.designReviewComment.count({ where: { projectId } });
    check('P27 once the owner stops sharing, the collaborator’s next step is refused, the panel says so and lists nothing; no note was added', notes === 1, { notes });
    check('P27 ar: no CSP violation and no page error', (await csp(pg)).length === 0 && ar.log.errors.length === 0, { errors: ar.log.errors });
  } finally { await ar.ctx.close(); }
};
