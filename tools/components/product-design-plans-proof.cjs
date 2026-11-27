/**
 * Design Studio browser proof, P28 — plans, billing and the professional tools (P5, P6), on the compiled application with a
 * real PostgreSQL database. The Platform Owner's plans are configured through the routes; then, in the browser:
 *
 *   · a creator on the free default plan finds the Production pack locked and says why; the Plan & billing panel floats
 *     over the studio (nothing beneath moves), shows the plan, its features and the plans on offer with their prices,
 *     and says plainly that online payment is not set up; asking for Premium issues an open invoice and charges nothing;
 *   · the Owner's Plans & billing console lists the plans, creates one through its form (a price typed in euros is kept
 *     in cents), shows the open invoice and that no payment provider is configured, and grants Premium with a note;
 *   · the creator, now on Premium, downloads the tech pack (CSV) and the print sheet (SVG, every view), each recorded;
 *   · a club manager sees the club's plan but is not offered to change it;
 *   · Arabic right to left; axe finds no WCAG 2.2 A/AA violation (English and Arabic); no CSP violation, no page error.
 */
'use strict';

module.exports = async function p28(H) {
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
  // The harness aborts Google Fonts (offline by design); Chromium reports that aborted stylesheet as connect-src. In the
  // platform's shell (the Owner's and a club's room) only what the room itself does is the room's, as in P21.
  const csp = (pg) => pg.evaluate(() => (window.__csp || []).filter((c) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(c.uri)));
  const roomCsp = (pg) => pg.evaluate(() => (window.__csp || []).filter((c) => c.inRoom || /product-design/.test(c.src + c.uri)));
  const words = (code) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/i18n', code + '.json'), 'utf8'));
  const R = '#pd-creator-root';
  const tag = crypto.randomBytes(3).toString('hex');
  const PW = 'a long creator passphrase';
  const owner = (method, url, body) => fetch(BASE + '/api/v1/system/product-design' + url, { method, headers: { Authorization: 'Bearer ' + TOKENS.owner, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  const box = (pg, sel) => pg.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }, sel);
  const metrics = (pg) => pg.evaluate(() => window.__familistaProductDesignMetrics());

  // The Owner's plans, configured through the Owner's routes: a free default for creators, Premium, and a club plan.
  const made = [
    await owner('POST', '/plans', { key: `p28-free-${tag}`, audience: 'CREATOR', name: 'Starter', features: ['team_kit', 'brand_studio', 'reviews', 'collaboration', 'manufacturing'], isDefault: true }),
    await owner('POST', '/plans', { key: `p28-premium-${tag}`, audience: 'CREATOR', name: 'Premium', description: 'Every tool, the professional exports included.',
      features: ['team_kit', 'brand_studio', 'reviews', 'collaboration', 'manufacturing', 'pro_export', 'manufacturing_prep'], priceMinor: 900, currency: 'EUR', interval: 'MONTH', sortOrder: 1 }),
    await owner('POST', '/plans', { key: `p28-club-${tag}`, audience: 'CLUB', name: 'Club Pro tools', features: ['pro_export', 'manufacturing_prep'], priceMinor: 4900, currency: 'EUR', interval: 'MONTH' }),
  ];
  if (!made.every((m) => m && m.success)) { fail('P28 the plans could not be configured', made); return; }
  const PREMIUM = `p28-premium-${tag}`;

  const email = `p28-${tag}@example.com`;
  const inv = await owner('POST', '/creators/invites', { email, note: 'P28', maxUses: 1, days: 7 });
  const reg = await fetch(BASE + '/api/v1/creator/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteCode: inv.data.code, email, password: PW, displayName: 'Rosa Plans', ageConfirmed: true }) }).then((r) => r.json());
  const creatorId = reg.data.creator.id;

  async function signedIn(locale) {
    const s = await open({ width: 1672, height: 941 }, locale, { as: 'owner', hash: '/creator', wait: false });
    await s.page.waitForFunction(() => { const g = window.__familistaCreatorGateMetrics && window.__familistaCreatorGateMetrics(); return !!g && g.email !== null; }, null, { timeout: 60000 });
    await s.page.fill(R + ' [data-pd-gate-in="email"]', email);
    await s.page.fill(R + ' [data-pd-gate-in="password"]', PW);
    await s.page.click(R + ' .pd-gate-submit');
    await s.page.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && m.workspace === 'PERSONAL' && !!m.plan; }, null, { timeout: 60000 });
    await s.page.waitForTimeout(300);
    return s;
  }
  async function openPlan(pg) {
    await pg.click(R + ' .pd-side [data-pd-act="plan"]');
    await pg.waitForFunction(() => { const p = window.__familistaProductDesignMetrics().plan; return p.open && p.state === 'ready'; }, null, { timeout: 15000 });
    await pg.waitForTimeout(450); // the panel has finished opening (opacity and transform only) before anything is measured
  }

  // ── 1. the creator, on the free default plan ──────────────────────────────────────────────────────────────────────
  const a = await signedIn('en-GB');
  let projectId = null;
  try {
    const pg = a.page;
    await pg.click(R + ' [data-pd-act="save"]');
    await pg.waitForFunction(() => { const s = window.__familistaProductDesignMetrics().server; return s.state === 'saved' && s.linked && !s.busy; }, null, { timeout: 30000 });
    projectId = (await metrics(pg)).server.projectId;
    await pg.click(R + ' .pd-actions [data-pd-act="production"]');
    await pg.waitForSelector(R + ' .pd-dock [data-pd-tool="pro_export"]', { timeout: 15000 });
    const locked = await pg.evaluate((sel) => [...document.querySelectorAll(sel + ' .pd-dock [data-pd-tool]')].map((t) => [t.getAttribute('data-pd-tool'), t.getAttribute('data-included'), !!t.querySelector('button')]), R);
    const m0 = await metrics(pg);
    check('P28 on the free default plan the Production pack shows the print sheet and the tech pack as not in the plan, with no button to press, and offers the plans',
      JSON.stringify(locked) === JSON.stringify([['pro_export', 'false', false], ['manufacturing_prep', 'false', false]]) && m0.parts.proExport === false && m0.parts.mfgPrep === false
        && !!(await pg.$(R + ' .pd-dock [data-pd-act="pp-plans"]')), { locked, parts: m0.parts });

    const work = await box(pg, R + ' .pd-work');
    await pg.click(R + ' .pd-dock [data-pd-act="pp-plans"]');
    await pg.waitForFunction(() => { const p = window.__familistaProductDesignMetrics().plan; return p.open && p.state === 'ready'; }, null, { timeout: 15000 });
    await pg.waitForTimeout(450);
    const v = await pg.evaluate((sel) => {
      const el = document.querySelector(sel + ' #pd-plan');
      return { pos: getComputedStyle(el).position, name: el.querySelector('.pd-plan-current .pd-acct-name').textContent, source: el.querySelector('[data-pd-plan-source]').getAttribute('data-pd-plan-source'),
        offers: [...el.querySelectorAll('[data-pd-plan]')].map((o) => [o.querySelector('strong').textContent, o.querySelector('.pd-plan-price').textContent]),
        payments: !!el.querySelector('[data-pd-payments="not-configured"]'), dock: document.querySelector(sel + ' .pd-dock').getAttribute('data-open') };
    }, R);
    check('P28 the Plan & billing panel floats over the studio, which does not move: the Starter plan, the plans with their prices in the room’s language, and that online payment is not set up',
      v.pos === 'fixed' && JSON.stringify(work) === JSON.stringify(await box(pg, R + ' .pd-work')) && v.name === 'Starter' && v.source === 'default-plan'
        && v.offers.length === 2 && v.offers[1][0] === 'Premium' && /€9\.00/.test(v.offers[1][1]) && /month/.test(v.offers[1][1]) && v.payments && v.dock === 'false', v);
    if (fs.existsSync(axePath)) { const x = await runAxe(pg, R + ' #pd-plan'); check('P28 en: axe finds no WCAG 2.2 A/AA violation in the Plan & billing panel', x.length === 0, x); }

    await pg.click(R + ` [data-pd-plan-choose="${PREMIUM}"]`);
    await pg.waitForSelector(R + ' [data-pd-act="plan-confirm"]', { timeout: 5000 });
    const said = await pg.evaluate((sel) => document.querySelector(sel + ' .pd-plan-confirm .pd-note').textContent, R);
    await pg.click(R + ' [data-pd-act="plan-confirm"]');
    await pg.waitForFunction(() => window.__familistaProductDesignMetrics().plan.subscription === 'PENDING', null, { timeout: 15000 });
    const invRow = await db.commercialInvoice.findFirst({ where: { creatorId }, select: { status: true, totalMinor: true, currency: true, taxMinor: true, number: true } });
    const m1 = (await metrics(pg)).plan;
    check('P28 asking for Premium says what happens, issues one open invoice of €9.00 without tax invented, and changes nothing yet: the plan is still Starter',
      /€9\.00/.test(said) && /Nothing is charged/.test(said) && !!invRow && invRow.status === 'OPEN' && invRow.totalMinor === 900 && invRow.currency === 'EUR' && invRow.taxMinor === null
        && m1.plan === `p28-free-${tag}` && JSON.stringify(m1.invoices) === '["OPEN"]', { said, invRow, m1 });
    const pay = await pg.evaluate((sel) => { const b = document.querySelector(sel + ' [data-pd-act="plan-pay"]'); return b && { disabled: b.getAttribute('aria-disabled'), why: b.getAttribute('data-pd-why') }; }, R);
    await pg.click(R + ' [data-pd-act="plan-pay"]', { force: true }); // unavailable to a pointer as to assistive technology; pressed anyway, it says why
    await pg.waitForTimeout(200);
    const told = await pg.evaluate(() => (document.querySelector('#pd-creator-root .pd-sr[role="status"]') || {}).textContent || '');
    const events = await db.paymentEvent.count({ where: { creatorId } });
    check('P28 “Pay online” is offered but unavailable, and pressed it says that online payment is not set up; no payment is recorded',
      !!pay && pay.disabled === 'true' && /not set up/.test(pay.why) && /not set up/.test(told) && events === 0, { pay, told, events });
    await pg.screenshot({ path: path.join(OUT, 'p28-creator-plan-en.png') });
    check('P28 creator: no CSP violation and no page error', (await csp(pg)).length === 0 && a.log.errors.length === 0, { csp: await csp(pg), errors: a.log.errors });
  } finally { await a.ctx.close(); }

  // ── 2. the Owner's console: the plans, a new one through the form, the invoice, a grant ───────────────────────────
  const o = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'owner' });
  try {
    const pg = o.page, ROOM = '#pd-root';
    await pg.click(ROOM + ' .pd-side [data-pd-act="bl"]');
    await pg.waitForFunction(() => { const b = window.__familistaProductDesignMetrics().billing; return !!b && b.open && b.state === 'ready'; }, null, { timeout: 15000 });
    // Every plan the Owner configured, offered or not (a section before this one may have withdrawn its own).
    const known = await db.commercialPlan.count();
    const listed = (await metrics(pg)).billing.plans;
    await pg.click(ROOM + ' [data-pd-act="bl-new"]');
    await pg.fill(ROOM + ' [data-pd-bl-in="key"]', `p28-team-${tag}`);
    await pg.fill(ROOM + ' [data-pd-bl-in="name"]', 'Team');
    await pg.check(ROOM + ' [data-pd-bl-in="feature-team_kit"]');
    await pg.fill(ROOM + ' [data-pd-bl-in="price"]', '4.50');
    await pg.fill(ROOM + ' [data-pd-bl-in="maxProjects"]', '12');
    await pg.click(ROOM + ' [data-pd-act="bl-save"]');
    await pg.waitForFunction((n) => { const b = window.__familistaProductDesignMetrics().billing; return b.form === null && b.state === 'ready' && b.plans && b.plans.length === n; }, known + 1, { timeout: 15000 });
    const team = await db.commercialPlan.findUnique({ where: { key: `p28-team-${tag}` }, select: { priceMinor: true, currency: true, interval: true, features: true, maxProjects: true, isDefault: true } });
    check('P28 the Owner’s console lists the plans and creates one through its form: €4.50 a month is kept as 450 cents, with its feature and limit',
      listed.length === known && [`p28-free-${tag}`, PREMIUM, `p28-club-${tag}`].every((k) => listed.includes(k)) && !!team && team.priceMinor === 450 && team.currency === 'EUR' && team.interval === 'MONTH' && JSON.stringify(team.features) === '["team_kit"]' && team.maxProjects === 12 && team.isDefault === false, { listed, team });

    await pg.click(ROOM + ' [data-pd-act="bl-tab-billing"]');
    await pg.waitForSelector(ROOM + ' #pd-billing [data-pd-payments]', { timeout: 5000 });
    const b = await pg.evaluate((sel) => { const el = document.querySelector(sel + ' #pd-billing'); return { payments: el.querySelector('[data-pd-payments]').getAttribute('data-pd-payments'),
      invoices: [...el.querySelectorAll('[data-pd-invoice]')].map((r) => r.querySelector('[data-status]').getAttribute('data-status')), subs: el.querySelectorAll('[data-pd-sub]').length,
      pending: [...el.querySelectorAll('[data-pd-sub] [data-status="PENDING"]')].length }; }, ROOM);
    // Every workspace's subscriptions are listed (a section before this one may have granted its own); this creator's is the pending one.
    const allSubs = await db.commercialSubscription.count();
    check('P28 the Billing tab says no payment provider is configured and shows the creator’s pending subscription and open invoice', b.payments === 'not-configured' && JSON.stringify(b.invoices) === '["OPEN"]' && b.subs === allSubs && b.pending === 1, { ...b, allSubs });
    if (fs.existsSync(axePath)) { const x = await runAxe(pg, ROOM + ' #pd-billing'); check('P28 en: axe finds no WCAG 2.2 A/AA violation in the Owner’s Plans & billing', x.length === 0, x); }

    await pg.click(ROOM + ' [data-pd-act="bl-grant"]');
    await pg.waitForSelector(ROOM + ' [data-pd-bl-in="tenantId"]', { timeout: 10000 });
    await pg.selectOption(ROOM + ' [data-pd-bl-in="tenantId"]', creatorId);
    await pg.selectOption(ROOM + ' [data-pd-bl-in="planKey"]', PREMIUM);
    await pg.fill(ROOM + ' [data-pd-bl-in="months"]', '3');
    await pg.fill(ROOM + ' [data-pd-bl-in="note"]', 'P28 pilot, agreed in person');
    await pg.click(ROOM + ' [data-pd-act="bl-grant-save"]');
    await pg.waitForFunction((n) => { const x = window.__familistaProductDesignMetrics().billing; return !x.grant && x.state === 'ready' && x.subscriptions === n; }, allSubs + 1, { timeout: 15000 });
    const subs = await db.commercialSubscription.findMany({ where: { creatorId }, orderBy: { createdAt: 'asc' }, select: { status: true, source: true, note: true } });
    const voided = await db.commercialInvoice.findFirst({ where: { creatorId }, select: { status: true } });
    check('P28 the Owner grants Premium for three months with a note: the pending request is cancelled, its invoice void, the grant active',
      subs.length === 2 && subs[0].status === 'CANCELED' && subs[1].status === 'ACTIVE' && subs[1].source === 'OWNER_GRANT' && subs[1].note === 'P28 pilot, agreed in person' && voided.status === 'VOID', { subs, voided });
    await pg.screenshot({ path: path.join(OUT, 'p28-owner-billing-en.png') });
    check('P28 owner: no CSP violation in the room and no page error', (await roomCsp(pg)).length === 0 && o.log.errors.length === 0, { csp: await roomCsp(pg), errors: o.log.errors });
  } finally { await o.ctx.close(); }

  // ── 3. the creator on Premium, in Arabic: the professional tools ──────────────────────────────────────────────────
  const c = await signedIn('ar');
  try {
    const pg = c.page, W = words('ar');
    await openPlan(pg);
    const m = await metrics(pg);
    const v = await pg.evaluate((sel) => { const el = document.querySelector(sel + ' #pd-plan'); return { dir: getComputedStyle(el).direction, title: el.querySelector('#pd-plan-title span').textContent,
      included: [...el.querySelectorAll('[data-pd-feature]')].filter((f) => f.getAttribute('data-included') === 'true').length }; }, R);
    check('P28 ar: on Premium the room offers the professional tools; the panel reads right to left in the room’s words, all seven features included',
      m.parts.proExport === true && m.parts.mfgPrep === true && m.plan.source === 'subscription' && v.dir === 'rtl' && v.title === W['Plan & billing'] && v.included === 7, { parts: m.parts, v });
    if (fs.existsSync(axePath)) { const x = await runAxe(pg, R + ' #pd-plan'); check('P28 ar: axe finds no WCAG 2.2 A/AA violation in the Plan & billing panel', x.length === 0, x); }
    await pg.screenshot({ path: path.join(OUT, 'p28-creator-premium-ar.png') });
    await pg.keyboard.press('Escape');

    // The saved design from section 1, then the Production pack.
    await pg.click(R + ' .pd-actions [data-pd-act="projects"]');
    await pg.waitForSelector(R + ` [data-pd-act="open-project"][data-pd-id="${projectId}"]`, { timeout: 15000 });
    await pg.click(R + ` [data-pd-act="open-project"][data-pd-id="${projectId}"]`);
    await pg.waitForFunction(() => { const s = window.__familistaProductDesignMetrics().server; return s.state === 'saved' && s.linked; }, null, { timeout: 20000 });
    await pg.click(R + ' .pd-actions [data-pd-act="production"]');
    await pg.waitForSelector(R + ' .pd-dock [data-pd-act="pp-csv"]', { timeout: 15000 });
    const [csvDl] = await Promise.all([pg.waitForEvent('download', { timeout: 20000 }), pg.click(R + ' .pd-dock [data-pd-act="pp-csv"]')]);
    const csv = fs.readFileSync(await csvDl.path(), 'utf8');
    await pg.waitForFunction(() => window.__familistaProductDesignMetrics().production.busy === null, null, { timeout: 15000 });
    const [svgDl] = await Promise.all([pg.waitForEvent('download', { timeout: 20000 }), pg.click(R + ' .pd-dock [data-pd-act="pp-sheet"]')]);
    const svg = fs.readFileSync(await svgDl.path(), 'utf8');
    const views = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/product-design/templates/football-jersey.json'), 'utf8')).views.length;
    const nested = (svg.match(/<svg/g) || []).length - 1;
    const audit = await db.platformAuditLog.findMany({ where: { resourceId: projectId, action: { in: ['design.tech-pack.exported', 'design.export.created'] } }, select: { action: true } });
    check('P28 ar: the tech pack downloads as CSV (BOM, its header) and the print sheet as one SVG with every view, each recorded in the audit',
      csv.charCodeAt(0) === 0xFEFF && csv.split('\r\n')[0].slice(1) === 'surface,element,type,text,font,colour,hex,x_mm,y_mm,width_mm,height_mm,rotation_deg,printed'
        && /^<\?xml/.test(svg) && nested === views && /-tech-pack\.csv$/.test(csvDl.suggestedFilename()) && /-print-sheet\.svg$/.test(svgDl.suggestedFilename())
        && audit.filter((x) => x.action === 'design.tech-pack.exported').length === 1 && audit.filter((x) => x.action === 'design.export.created').length === 1,
      { head: csv.split('\r\n')[0], nested, views, files: [csvDl.suggestedFilename(), svgDl.suggestedFilename()], audit });
    if (fs.existsSync(axePath)) { const x = await runAxe(pg, R + ' .pd-dock'); check('P28 ar: axe finds no WCAG 2.2 A/AA violation in the Production pack', x.length === 0, x); }
    check('P28 ar: no CSP violation and no page error', (await csp(pg)).length === 0 && c.log.errors.length === 0, { csp: await csp(pg), errors: c.log.errors });
  } finally { await c.ctx.close(); }

  // ── 4. a club manager sees the club's plan, and is not offered to change it ───────────────────────────────────────
  const k = await open({ width: 1672, height: 941 }, 'en-GB', { as: 'clubManager', hash: '/#club-design', wait: false });
  try {
    const pg = k.page, CR = '#pd-club-root';
    await pg.waitForFunction(() => { const m = window.__familistaProductDesignMetrics && window.__familistaProductDesignMetrics(); return !!m && !!m.plan; }, null, { timeout: 60000 });
    await pg.click(CR + ' .pd-side [data-pd-act="plan"]');
    await pg.waitForFunction(() => { const p = window.__familistaProductDesignMetrics().plan; return p.open && p.state === 'ready'; }, null, { timeout: 15000 });
    const v = await pg.evaluate((sel) => { const el = document.querySelector(sel + ' #pd-plan'); return { features: el.querySelectorAll('[data-pd-feature]').length, offers: el.querySelectorAll('[data-pd-plan]').length,
      choose: el.querySelectorAll('[data-pd-act="plan-choose"]').length, note: /Only a club administrator/.test(el.textContent) }; }, CR);
    const m = await metrics(pg);
    check('P28 a club manager sees the club’s plan (the two professional tools, the club plan on offer) and is not offered to change it; the room keeps the tools locked',
      v.features === 2 && v.offers === 1 && v.choose === 0 && v.note && m.parts.proExport === false && m.parts.mfgPrep === false, { v, parts: m.parts });
    check('P28 club: no CSP violation in the room and no page error', (await roomCsp(pg)).length === 0 && k.log.errors.length === 0, { csp: await roomCsp(pg), errors: k.log.errors });
  } finally { await k.ctx.close(); }
};
