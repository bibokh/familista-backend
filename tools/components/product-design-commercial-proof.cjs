/**
 * Design Studio browser proof, P29 — the commercial experience (P8), on the compiled application with a real PostgreSQL
 * database:
 *
 *   · the Creator Studio's sign-in page (by invitation, not indexed) shows anyone the creator plans on offer, as the Owner
 *     configured them, and says plainly which services work today: email, online payment, quotations — each as the
 *     server's configuration and the database's verified suppliers say, never assumed;
 *   · a new creator's Getting started lists their first steps from their own records; a step's button takes them where
 *     it is done (saving the design marks it done); the panel floats, nothing beneath moves;
 *   · the Owner's Readiness tab measures what commercial access depends on, row by row, as the server reports it;
 *   · Arabic right to left; axe finds no WCAG 2.2 A/AA violation (English and Arabic); no CSP violation, no page error.
 */
'use strict';

module.exports = async function p29(H) {
  const { open, check, fail, OUT, ROOT, db, BASE, TOKENS } = H;
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const axePath = process.env.AXE_CORE || path.join(ROOT, 'tools/components/node_modules/axe-core/axe.min.js');
  const runAxe = (pg, scope) => pg.evaluate(async ([src, sel]) => {
    if (!window.axe) (0, eval)(src); // eslint-disable-line no-eval -- this script's own tool, never the page's code
    const r = await window.axe.run({ include: [sel] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  }, [fs.readFileSync(axePath, 'utf8'), scope]);
  const csp = (pg) => pg.evaluate(() => (window.__csp || []).filter((c) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(c.uri)));
  const roomCsp = (pg) => pg.evaluate(() => (window.__csp || []).filter((c) => c.inRoom || /product-design/.test(c.src + c.uri)));
  const words = (code) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/i18n', code + '.json'), 'utf8'));
  const R = '#pd-creator-root';
  const tag = crypto.randomBytes(3).toString('hex');
  const PW = 'a long creator passphrase';
  const owner = (method, url, body) => fetch(BASE + '/api/v1/system/product-design' + url, { method, headers: { Authorization: 'Bearer ' + TOKENS.owner, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  const box = (pg, sel) => pg.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }, sel);
  const metrics = (pg) => pg.evaluate(() => window.__familistaProductDesignMetrics());

  const made = await owner('POST', '/plans', { key: `p29-studio-${tag}`, audience: 'CREATOR', name: 'Studio', description: 'For creators who design every week.',
    features: ['team_kit', 'brand_studio', 'reviews', 'collaboration', 'manufacturing'], priceMinor: 1200, currency: 'EUR', interval: 'YEAR', sortOrder: 5 });
  if (!made || !made.success) { fail('P29 the plan could not be configured', made); return; }
  const offered = (await db.commercialPlan.findMany({ where: { audience: 'CREATOR', active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { key: true } })).map((p) => p.key);
  const verified = await db.manufacturingSupplier.count({ where: { status: 'VERIFIED' } });

  // ── 1. the sign-in page: the offer and what works today ───────────────────────────────────────────────────────────
  async function gatePage(locale) {
    const s = await open({ width: 1440, height: 900 }, locale, { as: 'owner', hash: '/creator', wait: false });
    await s.page.waitForFunction(() => { const g = window.__familistaCreatorGateMetrics && window.__familistaCreatorGateMetrics(); return !!g && !!g.services; }, null, { timeout: 60000 });
    return s;
  }
  const g = await gatePage('en-GB');
  try {
    const pg = g.page;
    const v = await pg.evaluate((sel) => ({
      plans: [...document.querySelectorAll(sel + ' [data-pd-gate-plan]')].map((p) => [p.getAttribute('data-pd-gate-plan'), p.querySelector('.pd-gate-plan-price').textContent]),
      services: Object.fromEntries([...document.querySelectorAll(sel + ' [data-pd-service]')].map((x) => [x.getAttribute('data-pd-service'), x.getAttribute('data-ready')])),
      robots: (document.querySelector('meta[name="robots"]') || {}).content, signup: /Sign-up is by invitation from Familista/.test(document.querySelector(sel + ' .pd-gate-aside').textContent),
    }), R);
    const studio = v.plans.find((p) => p[0] === `p29-studio-${tag}`);
    check('P29 the sign-in page shows the creator plans on offer as the Owner configured them, and is not indexed; sign-up stays by invitation',
      JSON.stringify(v.plans.map((p) => p[0])) === JSON.stringify(offered) && !!studio && /€12\.00 per year/.test(studio[1]) && v.robots === 'noindex, nofollow' && v.signup, v);
    check('P29 it says which services work today, as configured: email and online payment not set up; quotations as the verified suppliers allow',
      v.services.email === 'false' && v.services.payments === 'false' && v.services.quotations === String(verified > 0), { services: v.services, verified });
    if (fs.existsSync(axePath)) { const x = await runAxe(pg, R + ' .pd-gate'); check('P29 en: axe finds no WCAG 2.2 A/AA violation on the sign-in page with its offer', x.length === 0, x); }
    await pg.screenshot({ path: path.join(OUT, 'p29-gate-en.png') });
    check('P29 sign-in page: no CSP violation and no page error', (await csp(pg)).length === 0 && g.log.errors.length === 0, { csp: await csp(pg), errors: g.log.errors });
  } finally { await g.ctx.close(); }
  const ga = await gatePage('ar');
  try {
    const pg = ga.page, W = words('ar');
    const v = await pg.evaluate((sel) => ({ dir: getComputedStyle(document.querySelector(sel + ' .pd-gate')).direction, sub: [...document.querySelectorAll(sel + ' .pd-gate-sub')].map((x) => x.textContent) }), R);
    check('P29 ar: the offer reads right to left, in the room’s words', v.dir === 'rtl' && v.sub.includes(W['What works today']), v);
    if (fs.existsSync(axePath)) { const x = await runAxe(pg, R + ' .pd-gate'); check('P29 ar: axe finds no WCAG 2.2 A/AA violation on the sign-in page with its offer', x.length === 0, x); }
    await pg.screenshot({ path: path.join(OUT, 'p29-gate-ar.png') });
  } finally { await ga.ctx.close(); }

  // ── 2. a new creator's first steps ────────────────────────────────────────────────────────────────────────────────
  const email = `p29-${tag}@example.com`;
  const inv = await owner('POST', '/creators/invites', { email, note: 'P29', maxUses: 1, days: 7 });
  await fetch(BASE + '/api/v1/creator/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteCode: inv.data.code, email, password: PW, displayName: 'Nadia Steps', ageConfirmed: true }) });
  async function signedIn(locale) {
    const s = await open({ width: 1672, height: 941 }, locale, { as: 'owner', hash: '/creator', wait: false });
    await s.page.waitForFunction(() => { const g = window.__familistaCreatorGateMetrics && window.__familistaCreatorGateMetrics(); return !!g && g.email !== null; }, null, { timeout: 60000 });
    await s.page.fill(R + ' [data-pd-gate-in="email"]', email);
    await s.page.fill(R + ' [data-pd-gate-in="password"]', PW);
    await s.page.click(R + ' .pd-gate-submit');
    await s.page.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && m.workspace === 'PERSONAL' && !!m.start; }, null, { timeout: 60000 });
    await s.page.waitForTimeout(300);
    return s;
  }
  const openStart = async (pg) => {
    await pg.click(R + ' .pd-side [data-pd-act="start"]');
    await pg.waitForFunction(() => { const s = window.__familistaProductDesignMetrics().start; return s.open && s.state === 'ready'; }, null, { timeout: 15000 });
    await pg.waitForTimeout(450);
  };
  const c = await signedIn('en-GB');
  try {
    const pg = c.page;
    const work = await box(pg, R + ' .pd-work');
    await openStart(pg);
    const first = (await metrics(pg)).start.steps;
    const pos = await pg.evaluate((sel) => getComputedStyle(document.querySelector(sel + ' #pd-start')).position, R);
    check('P29 a new creator’s Getting started lists every first step their plan includes, none done, floating over the studio, which does not move',
      JSON.stringify(first) === JSON.stringify(['address:todo', 'design:todo', 'brand:todo', 'roster:todo', 'collection:todo', 'request:todo'])
        && pos === 'fixed' && JSON.stringify(work) === JSON.stringify(await box(pg, R + ' .pd-work')), { first, pos });
    if (fs.existsSync(axePath)) { const x = await runAxe(pg, R + ' #pd-start'); check('P29 en: axe finds no WCAG 2.2 A/AA violation in Getting started', x.length === 0, x); }
    await pg.screenshot({ path: path.join(OUT, 'p29-start-en.png') });
    await pg.click(R + ' [data-pd-act="start-go"][data-pd-step="design"]');
    await pg.waitForFunction(() => { const s = window.__familistaProductDesignMetrics().server; return s.state === 'saved' && s.linked && !s.busy; }, null, { timeout: 30000 });
    const closed = !(await metrics(pg)).start.open;
    await openStart(pg);
    const after = (await metrics(pg)).start.steps;
    const account = await db.creatorAccount.findUnique({ where: { email }, select: { id: true } });
    const saved = await db.designProject.count({ where: { creatorId: account.id } });
    check('P29 “Save design” on its step closes the panel and saves the design on the server; reopened, the step is done',
      closed && after[1] === 'design:done' && after.filter((x) => /done$/.test(x)).length === 1 && saved === 1, { closed, after, saved });
    await pg.click(R + ' [data-pd-act="start-go"][data-pd-step="roster"]');
    await pg.waitForFunction(() => { const m = window.__familistaProductDesignMetrics(); return !m.start.open && !!m.team && m.team.open; }, null, { timeout: 15000 });
    check('P29 “Open Team” on its step opens the Team panel in its place', true);
    check('P29 creator: no CSP violation and no page error', (await csp(pg)).length === 0 && c.log.errors.length === 0, { csp: await csp(pg), errors: c.log.errors });
  } finally { await c.ctx.close(); }
  const ca = await signedIn('ar');
  try {
    const pg = ca.page, W = words('ar');
    await openStart(pg);
    const v = await pg.evaluate((sel) => ({ dir: getComputedStyle(document.querySelector(sel + ' #pd-start')).direction, title: document.querySelector(sel + ' #pd-start-title span').textContent }), R);
    check('P29 ar: Getting started reads right to left, in the room’s words', v.dir === 'rtl' && v.title === W['Getting started'], v);
    if (fs.existsSync(axePath)) { const x = await runAxe(pg, R + ' #pd-start'); check('P29 ar: axe finds no WCAG 2.2 A/AA violation in Getting started', x.length === 0, x); }
    await pg.screenshot({ path: path.join(OUT, 'p29-start-ar.png') });
  } finally { await ca.ctx.close(); }

  // ── 3. the Owner's readiness ──────────────────────────────────────────────────────────────────────────────────────
  const o = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'owner' });
  try {
    const pg = o.page, ROOM = '#pd-root';
    await pg.click(ROOM + ' .pd-side [data-pd-act="bl"]');
    await pg.waitForFunction(() => { const b = window.__familistaProductDesignMetrics().billing; return !!b && b.open && b.state === 'ready'; }, null, { timeout: 15000 });
    await pg.click(ROOM + ' [data-pd-act="bl-tab-readiness"]');
    await pg.waitForSelector(ROOM + ' #pd-billing [data-pd-ready="email"]', { timeout: 5000 });
    const rows = await pg.evaluate((sel) => Object.fromEntries([...document.querySelectorAll(sel + ' #pd-billing [data-pd-ready]')].map((r) => [r.getAttribute('data-pd-ready'), r.getAttribute('data-ready')])), ROOM);
    const api = await owner('GET', '/readiness');
    check('P29 the Owner’s Readiness tab measures what commercial access depends on, row by row, as the server reports it',
      rows.email === String(api.data.email.configured) && rows.payments === String(api.data.payments.configured) && rows.suppliers === String(api.data.suppliers.verified > 0)
        && rows.plans === String(api.data.plans.creator + api.data.plans.club > 0) && api.data.email.configured === false && api.data.payments.configured === false, { rows, api: api.data });
    if (fs.existsSync(axePath)) { const x = await runAxe(pg, ROOM + ' #pd-billing'); check('P29 en: axe finds no WCAG 2.2 A/AA violation in Readiness', x.length === 0, x); }
    await pg.screenshot({ path: path.join(OUT, 'p29-owner-readiness-en.png') });
    check('P29 owner: no CSP violation in the room and no page error', (await roomCsp(pg)).length === 0 && o.log.errors.length === 0, { csp: await roomCsp(pg), errors: o.log.errors });
  } finally { await o.ctx.close(); }
};
