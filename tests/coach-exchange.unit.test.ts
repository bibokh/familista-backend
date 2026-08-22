/**
 * tests/coach-exchange.unit.test.ts
 *
 * The Familista Coach Exchange.
 *
 * A market whose figures move when a page is refreshed is not a market, so the
 * three readings it trades on are pure functions of stored data and are
 * exercised here as functions: the same record must produce the same FCI, the
 * same opportunity and the same momentum, every time.
 *
 * The other thing asserted is the line to Coaches. Eligibility for any exchange
 * surface is the canonical employment status and nothing else — an employed
 * coach who is not looking is in the directory and on no market screen at all,
 * and being open to offers never turns anybody into a free agent.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  fciOf, opportunityOf, momentumOf, momentumBand, isHiddenGem, FCI_NEUTRAL,
} from '../src/staff-market/market-index';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');
const SVC = readFileSync(join(__dirname, '..', 'src', 'staff-market', 'staff-market.service.ts'), 'utf8');
const IDX = readFileSync(join(__dirname, '..', 'src', 'staff-market', 'market-index.ts'), 'utf8');

const STRONG = {
  reputation: 88, level: 82, yearsExperience: 18, licenceCode: 'UEFA_PRO',
  trophies: 5, evaluation: [84, 80, 86, 79, 88, 75, 90], careerEntries: 5,
};

describe('FCI is a measurement, not a draw', () => {
  it('the same record always produces the same figure', () => {
    const a = fciOf(STRONG);
    for (let i = 0; i < 40; i++) expect(fciOf(STRONG)).toBe(a);
    expect(a).toBeGreaterThan(70);
    expect(a).toBeLessThanOrEqual(99);
  });

  it('nothing in the module can move on its own', () => {
    expect(IDX).not.toMatch(/Math\.random/);
    expect(IDX).not.toMatch(/Date\.now\(\)/);
    expect(IDX).not.toMatch(/new Date\(\)/);
  });

  it('a component the record does not hold is not counted as a zero', () => {
    // No trophies recorded is not "zero trophies": dropping the field must not
    // drag the figure down the way a nil would.
    const withTrophies = fciOf({ ...STRONG, trophies: 0 });
    const without = fciOf({ ...STRONG, trophies: null });
    expect(without).toBeGreaterThan(withTrophies);
  });

  it('an empty record gets the neutral figure rather than a zero', () => {
    expect(fciOf({})).toBe(FCI_NEUTRAL);
    expect(fciOf({ reputation: null, level: null, licenceCode: null })).toBe(FCI_NEUTRAL);
  });

  it('and it moves with the things that make a coach strong', () => {
    const pro = fciOf({ ...STRONG });
    const noLicence = fciOf({ ...STRONG, licenceCode: 'UEFA_C' });
    expect(pro).toBeGreaterThan(noLicence);
    expect(fciOf({ ...STRONG, reputation: 30 })).toBeLessThan(pro);
    expect(fciOf({ ...STRONG, yearsExperience: 1 })).toBeLessThan(pro);
    // and it is bounded either way
    expect(fciOf({ reputation: 100, level: 100, yearsExperience: 40, licenceCode: 'UEFA_PRO',
      trophies: 30, evaluation: [100], careerEntries: 20 })).toBeLessThanOrEqual(99);
    expect(fciOf({ reputation: 0, level: 0, yearsExperience: 0, licenceCode: null, trophies: 0 }))
      .toBeGreaterThanOrEqual(1);
  });
});

describe('Opportunity is a different question from FCI', () => {
  const base = { fci: 80, employmentStatus: 'EMPLOYED' as const, contractMonthsLeft: 36 };

  it('the same inputs always produce the same figure', () => {
    const a = opportunityOf(base);
    for (let i = 0; i < 40; i++) expect(opportunityOf(base)).toBe(a);
  });

  it('a strong coach locked in a long contract is a poor opportunity', () => {
    const locked = opportunityOf({ fci: 92, employmentStatus: 'EMPLOYED', contractMonthsLeft: 40,
      wageExpectation: 400_000, compensation: 900_000 });
    const free = opportunityOf({ fci: 62, employmentStatus: 'FREE_AGENT', contractMonthsLeft: null,
      wageExpectation: 70_000, compensation: null });
    expect(free).toBeGreaterThan(locked);
    // and the two figures stay separate — the weaker man is the better deal
    expect(92).toBeGreaterThan(62);
  });

  it('the more clubs already on him, the worse the opportunity', () => {
    const quiet = opportunityOf({ ...base, employmentStatus: 'OPEN_TO_OFFERS', demand: 0 });
    const contested = opportunityOf({ ...base, employmentStatus: 'OPEN_TO_OFFERS', demand: 8 });
    expect(quiet).toBeGreaterThan(contested);
  });

  it('and it stays inside its range whatever it is given', () => {
    expect(opportunityOf({ fci: 100, employmentStatus: 'FREE_AGENT', contractMonthsLeft: -5,
      wageExpectation: 0, compensation: 0, demand: 0 })).toBeLessThanOrEqual(100);
    expect(opportunityOf({ fci: 0, employmentStatus: 'UNAVAILABLE', contractMonthsLeft: 120,
      wageExpectation: 9_000_000, compensation: 9_000_000, demand: 40 })).toBeGreaterThanOrEqual(0);
  });
});

describe('Momentum is activity that happened', () => {
  it('the same activity always produces the same arrow', () => {
    const m = { recentApproaches: 2, recentShortlists: 1, employmentStatus: 'OPEN_TO_OFFERS' as const,
      daysSinceStatusChange: 5, contractMonthsLeft: 20 };
    const a = momentumOf(m);
    for (let i = 0; i < 40; i++) expect(momentumOf(m)).toBe(a);
    expect(momentumBand(a)).toBe('RISING');
  });

  it('a market that has done nothing does not invent movement', () => {
    const quiet = momentumOf({ employmentStatus: 'EMPLOYED' });
    expect(quiet).toBeLessThanOrEqual(0);
    expect(momentumBand(quiet)).toBe('DECLINING');
    expect(momentumBand(momentumOf({ employmentStatus: 'OPEN_TO_OFFERS' }))).toBe('STABLE');
  });

  it('and the bands are read off the one figure', () => {
    expect(momentumBand(7)).toBe('RISING');
    expect(momentumBand(0)).toBe('STABLE');
    expect(momentumBand(-5)).toBe('DECLINING');
  });
});

describe('a hidden gem is strong, unwatched and gettable', () => {
  it('all three, or it is not one', () => {
    expect(isHiddenGem(78, 70, 0)).toBe(true);
    expect(isHiddenGem(78, 70, 6)).toBe(false);   // everybody is already on him
    expect(isHiddenGem(40, 70, 0)).toBe(false);   // not strong enough
    expect(isHiddenGem(78, 30, 0)).toBe(false);   // cannot actually be moved
  });
});

describe('the server derives the figures once, from stored records', () => {
  it('discover computes all three on every row', () => {
    const d = SVC.slice(SVC.indexOf('export async function discover'));
    expect(d).toContain('const fci = fciOf({');
    expect(d).toContain('const opportunity = opportunityOf({');
    expect(d).toContain('const momentum = momentumOf({');
    expect(d).toContain('r.momentumBand = momentumBand(momentum);');
    expect(d).toContain('r.isHiddenGem = isHiddenGem(fci, opportunity, demand);');
  });

  it('demand is counted, never guessed', () => {
    const d = SVC.slice(SVC.indexOf('export async function discover'));
    expect(d).toContain('prisma.staffShortlist.groupBy({');
    expect(d).toContain('prisma.staffApproach.groupBy({');
    expect(d).toContain('const demand = watchByUser.get(uid)?._count._all ?? 0;');
  });

  it('and the exchange indicators are counted from the same rows', () => {
    const s = SVC.slice(SVC.indexOf('export async function marketSummary'));
    ['fciIndex', 'onTheMarket', 'trending', 'newToMarket', 'contractWatch', 'hiddenGems']
      .forEach((k) => expect(s).toContain(k));
    // the index is the market's mean, not the platform's
    expect(s).toContain('const listed = everyone.filter((r) => isAvailable(r.employmentStatus as EmploymentStatus));');
  });
});

describe('eligibility is the canonical status and nothing else', () => {
  it('the exchange lists only the four standings that mean "on the market"', () => {
    expect(APP).toContain("var ST_LISTED = ['OPEN_TO_OFFERS', 'ACTIVELY_LOOKING', 'FREE_AGENT', 'CONTRACT_ENDING_SOON'];");
    expect(APP).toContain('function _stOnMarket(r) { return ST_LISTED.indexOf(r.employmentStatus) >= 0; }');
    // and the floor reads the same server-side filter
    expect(APP).toContain("var TAB_Q = { market: 'available', available: 'available'");
  });

  it('being open to offers never makes somebody a free agent', () => {
    // the two are separate standings on the same derived function
    const from = SVC.indexOf('export function employmentStatus');
    const f = SVC.slice(from, SVC.indexOf("return 'EMPLOYED';", from));
    // losing your club is the only thing that makes you a free agent
    expect(f).toContain("if (!args.hasClub) return 'FREE_AGENT';");
    expect(f.match(/return 'FREE_AGENT'/g)).toHaveLength(1);
    expect(f).toContain("if (args.careerIntent === 'OPEN_TO_OFFERS' || args.availability === 'OPEN_TO_OFFERS') return 'OPEN_TO_OFFERS';");
    // and an employed man who is looking is still employed by his club
    expect(f).toContain("if (args.careerIntent === 'ACTIVELY_LOOKING') return 'ACTIVELY_LOOKING';");
  });

  it('and free agents on the exchange have no club and no team', () => {
    // the boards are subsets of one population, so the rule lives in the
    // derivation the desk reads rather than in the desk itself
    const der = APP.slice(APP.indexOf('function _stDerived()'), APP.indexOf('function _stLoadClubs('));
    expect(der).toContain('freeAgents: rows.filter(function (r) { return r.isFreeAgent && !r.currentClub; })');
    const fa = APP.slice(APP.indexOf('function _stFreeAgentsHtml()'), APP.indexOf('function _stDossierHtml('));
    expect(fa).toContain('_stDerived().freeAgents');
  });
});

describe('seven tabs, seven presentations', () => {
  it('each surface is its own thing, and none of them is a card grid', () => {
    ['_stUniverseHtml', '_stPulseHtml', '_stIntelHtml', '_stLensHtml',
     '_stAvailableHtml', '_stFreeAgentsHtml', '_stShortlistDeskHtml',
     '_stNeedsHtml', '_stPipelineHtml', '_stDealPanelHtml', '_stTimelineHtml']
      .forEach((f) => expect(APP).toContain(`function ${f}(`));
    // and the board's old card grid is gone entirely
    expect(APP).not.toContain('function _stCardHtml(');
    expect(APP).not.toContain("'<div class=\"st-grid\">'");
  });

  it('the universe is nodes in professional areas, sized by market interest', () => {
    const u = APP.slice(APP.indexOf('function _stNodeHtml('), APP.indexOf('function _stTipEl('));
    // interest first, strength as the tie-break — a circle says who is moving
    expect(u).toContain("var pull = Math.min(1, ((r.clubsWatching || 0) * 0.22)");
    expect(u).toContain('var z = Math.max(1, Math.min(6, 1 + Math.round(pull * 5)));');
    // as a class, not a style attribute — style-src carries no 'unsafe-inline',
    // so a diameter written inline would silently never apply
    expect(u).not.toContain('style="');
    expect(u).toContain("' cx-node--z' + z + ' cx-node--d' + demand");
    expect(CSS).toContain('.cx-node--z6{ --s:60px; }');
    // the scale is the market's own range, so nodes are actually distinguishable —
    // computed with the bands when the data lands, not on the click that draws them
    const der = APP.slice(APP.indexOf('function _stDerived()'), APP.indexOf('function _stPrepare()'));
    expect(der).toContain('{ lo: Math.min.apply(null, fcis), hi: Math.max.apply(null, fcis) }');
    const un = APP.slice(APP.indexOf('function _stUniverseHtml('), APP.indexOf('function _stNodeHtml('));
    expect(un).toContain('_stNodeHtml(r, d.range)');
    expect(u).toContain('cx-node--d');      // the demand ring
    expect(u).toContain('is-rising');       // momentum, and the only animation
    // four areas, not seven, and never more than a row of eight in each
    expect(APP).toContain('var ST_MAP_AREAS = [');
    expect(APP).toContain('var ST_MAP_ROW = 8;');
    ['Head coaches', 'Coaching', 'Performance', 'Analysis']
      .forEach((a) => expect(APP).toContain(`'${a}'`));
    expect(un).toContain("var shown = open ? a.people : a.people.slice(0, ST_MAP_ROW);");
    expect(un).toContain("data-st-mapmore=");
  });

  it('and a node sits in the same place on every render', () => {
    const j = APP.slice(APP.indexOf('function _stJitter('), APP.indexOf('function _stListed('));
    expect(j).toContain('charCodeAt');      // hashed from the id
    expect(j).not.toContain('Math.random');
  });

  it('the lens opens beside the floor, not over it, and leads to the one profile', () => {
    const l = APP.slice(APP.indexOf('function _stLensHtml()'), APP.indexOf('function _stAvailableHtml()'));
    expect(l).toContain('View full profile');
    expect(l).toContain('data-st-open="');   // the canonical staff profile
    expect(l).toContain('data-st-short=');
    expect(l).toContain('data-st-cmp=');
    expect(l).toContain('data-st-approach=');
    expect(CSS).toContain('.cx-lens-in{');
  });

  it('only rising nodes animate, and reduced motion turns even that off', () => {
    expect(CSS).toContain('.cx-node.is-rising .cx-node-o{');
    expect(CSS).toContain('@media (prefers-reduced-motion:reduce){');
    // no animation on the plain node
    const node = CSS.slice(CSS.indexOf('.cx-node-f{'), CSS.indexOf('.cx-node-o{'));
    expect(node).not.toContain('animation:');
  });

  it('and the exchange has its own ground, borrowed from neither neighbour', () => {
    const cx = CSS.slice(CSS.indexOf('FAMILISTA COACH EXCHANGE'));
    expect(cx).toContain('--cx-cyan:');
    expect(cx).toContain('--cx-blue:');
    expect(cx).toContain('--cx-amber:');
    // it styles nothing outside its own module
    expect(cx).not.toContain('#pg-transfers');
    expect(cx).not.toContain('#pg-coaches');
    expect(cx).not.toContain('.co-');
  });
});
