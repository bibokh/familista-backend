/**
 * tests/coaches-redesign.unit.test.ts
 *
 * Coaches, laid out for a desk rather than for a column.
 *
 * The directory was correct and unreadable: four club cards in four narrow
 * tracks with half the screen empty beside them, six full-width progress bars
 * on every card, a team card that was a row of statistics, and a 1120×820
 * profile with a 172px tab column and a form in the rest of it.
 *
 * What is asserted here is the shape, not the styling: the grids fill the
 * width they are given, the club card says coverage in chips rather than in
 * bars, the team card carries its unit post by post, the staff card has the
 * market control on it, and the profile opens on a board instead of a form.
 * None of it may reach into the Coach Market or Transfers.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');
const SVC = readFileSync(join(__dirname, '..', 'src', 'staff-market', 'staff-market.service.ts'), 'utf8');

function appFn(name: string, until: string) {
  return APP.slice(APP.indexOf(`function ${name}`), APP.indexOf(`function ${until}`));
}
function rule(sel: string) {
  const at = CSS.indexOf(sel);
  if (at < 0) return '';
  return CSS.slice(at, CSS.indexOf('}', at));
}

// The span arithmetic is the one piece of real logic in the layout, so it is
// exercised rather than read: every row of the twelve-column grid must come out
// exactly full, whatever the departments happen to hold.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _coSpans: (counts: number[]) => number[] = (() => {
  const src = APP.slice(APP.indexOf('function _coSpans('), APP.indexOf('// TeamKind as it is stored'));
  // eslint-disable-next-line no-new-func
  return new Function(src + '; return _coSpans;')();
})();

describe('the departments tile the desk', () => {
  it('every row comes out exactly twelve columns', () => {
    const cases = [[1], [6, 1], [3, 3], [2, 4, 1], [4, 2, 2, 1], [3, 3, 2, 2, 1], [5, 2, 2, 1, 1, 1], [4, 3, 2, 2, 1, 1, 1]];
    cases.forEach((counts) => {
      const spans = _coSpans(counts);
      expect(spans).toHaveLength(counts.length);
      const perRow = counts.length <= 4 ? counts.length : (counts.length <= 6 ? 3 : 4);
      for (let i = 0; i < spans.length; i += perRow) {
        const row = spans.slice(i, i + perRow);
        expect(row.reduce((a, b) => a + b, 0)).toBe(12);
      }
    });
  });

  it('and one department alone takes the whole width', () => {
    expect(_coSpans([4])).toEqual([12]);
    expect(_coSpans([])).toEqual([]);
  });

  it('a wider department is given more of the row than a smaller one', () => {
    const [big, small] = _coSpans([6, 1]);
    expect(big).toBeGreaterThan(small);
    expect(small).toBeGreaterThanOrEqual(3);
  });

  it('the view hands each department its span', () => {
    const v = appFn('_coTeamViewHtml', '_coSpans');
    expect(v).toContain('var spans = _coSpans(');
    expect(v).toContain("'<section class=\"co-dept\" style=\"--span:' + spans[i] + '\">'");
    expect(rule('.co-cmd{')).toContain('repeat(12,1fr)');
    expect(rule('.co-dept{')).toContain('span var(--span');
  });
});

describe('the club card is read at a glance, not down a column of bars', () => {
  it('coverage is chips with segments, and the six bars are gone', () => {
    const c = appFn('_coClubCardHtml', '_coClubViewHtml');
    expect(c).toContain('_coPips(r.filled, r.of)');
    expect(c).toContain('CO_POST_ABBR[r.label]');
    expect(c).not.toContain('co-cc-role-t');            // the old full-width track
    expect(CSS).not.toContain('.co-cc-role-t');
    expect(rule('.co-cc-roles{')).toContain('flex-wrap:wrap');
    expect(CSS).toContain('.co-pips i{');
  });

  it('the pips are a count, never more than a short indicator', () => {
    const f = appFn('_coPips', '_coClubCardHtml');
    expect(f).toContain('Math.min(of || 0, 5)');
    // a partly-covered role never lights every segment, and a covered one is
    // never shown dark
    expect(f).toContain('if (filled > 0 && lit === 0) lit = 1;');
    expect(f).toContain('if (filled < of && lit === n) lit = n - 1;');
  });

  it('and the club still says what it runs and where it is short', () => {
    const c = appFn('_coClubCardHtml', '_coClubViewHtml');
    ['Teams', 'Technical staff', 'First team', 'Academy'].forEach((l) => expect(c).toContain(l));
    expect(c).toContain('% staffed');
    expect(c).toContain('Open technical staff');
  });
});

describe('the team card is a technical unit', () => {
  it('it carries the post strip and the head coach, and no wall of figures', () => {
    const c = appFn('_coTeamCardHtml', '_coTeamViewHtml');
    expect(c).toContain('g.roleStrip');
    expect(c).toContain('co-tc-badge');
    expect(c).toContain('Head coach');
    expect(c).toContain("'✓'");
    expect(CSS).toContain('.co-post.is-on{');
    expect(CSS).toContain('.co-post.is-off{');
  });

  it('the strip is served as counts and holds nobody', () => {
    const dir = SVC.slice(SVC.indexOf('export async function coachesDirectory'));
    expect(dir).toContain('const roleStrip = STAFF_POSTS');
    expect(dir).toContain('expected: roles.filter((r) => runs.includes(r)).length');
    expect(SVC).toContain('export const STAFF_POSTS');
    // still nothing about a person on the level that draws team cards
    const teams = SVC.slice(SVC.indexOf('export async function coachesClubTeams'),
      SVC.indexOf('export async function coachesTeamStaff'));
    expect(teams).toContain('const { staff, ...rest } = g as');
  });
});

describe('the staff card carries the market control', () => {
  it('three zones, and the status is the way into his market panel', () => {
    const c = appFn('_coStaffCardHtml', '_coProfileHtml');
    expect(c).toContain('class="co-sc-main"');
    expect(c).toContain('class="co-sc-mkt"');
    expect(c).toContain('data-co-tabto="market"');
    expect(c).toContain('CO_STATUS_SHORT[st]');
    // and still nothing about money on the front of a directory card
    expect(c).not.toContain('_stMoney');
    expect(c).not.toContain('expectedSalary');
  });

  it('the control opens the one canonical record, it does not write a listing', () => {
    const c = appFn('_coStaffCardHtml', '_coProfileHtml');
    expect(c).toContain('data-st-open="');
    const wire = APP.slice(APP.indexOf('(function _coWire() {'));
    expect(wire).toContain("_CO.tab = el.getAttribute('data-co-tabto') || 'overview';");
    // and setting a status is a PATCH of the profile the market reads
    expect(wire).toContain("_stApi('PATCH', '/staff/' + encodeURIComponent(msid), { availability: mv })");
  });
});

describe('the profile opens on a board', () => {
  it('a hero with a rail, and tabs across the top rather than down the side', () => {
    const c = appFn('_coProfileHtml', '_coF');
    expect(c).toContain('class="co-hero');
    expect(c).toContain('class="co-hero-rail"');
    expect(c).toContain("'<nav class=\"co-ptabs\">' + tabs + '</nav>'");
    const tabs = rule('.co-ptabs{');
    expect(tabs).toContain('display:flex');
    expect(tabs).not.toContain('flex-direction:column');
    expect(tabs).not.toContain('width:172px');
  });

  it('the overview is a dashboard, and only becomes a form under edit', () => {
    expect(APP).toContain('function _coOverviewHtml(d)');
    const p = appFn('_coPanel', '_coOverviewHtml');
    expect(p).toContain('if (_CO.editing) {');
    expect(p).toContain('return _coOverviewHtml(d);');
    const o = appFn('_coOverviewHtml', '_coWords');
    ['Standing', 'Contract', 'Qualification', 'Experience', 'Career', 'Tactical', 'Honours', 'Our note']
      .forEach((t) => expect(o).toContain(`_coCard('${t}'`));
    // every card leads into the tab that owns it
    ['market', 'contract', 'qualifications', 'experience', 'career', 'tactics', 'achievements', 'notes']
      .forEach((t) => expect(o).toContain(`{ to: '${t}' }`));
    expect(CSS).toContain('.co-dash{');
    expect(CSS).toContain('.co-card{');
  });

  it('career is a timeline, qualifications and honours are tiles', () => {
    const c = appFn('_coCareerPanel', '_coAchievementsPanel');
    expect(c).toContain('class="co-tl"');
    expect(c).toContain('co-tl-mark');
    expect(CSS).toContain('.co-tl-mark::after{');
    const a = appFn('_coAchievementsPanel', '_coAddHtml');
    expect(a).toContain('co-quals');
    expect(CSS).toContain('.co-qual{');
  });

  it('the contract tab leads with what is left to run', () => {
    const panel = appFn('_coPanel', '_coOverviewHtml');
    const p = panel.slice(panel.indexOf("if (t === 'contract')"), panel.indexOf("if (t === 'market')"));
    expect(p).toContain('_coMonthsLeft(c && c.endsAt)');
    expect(p).toContain('months remaining');
    expect(CSS).toContain('.co-cdash{');
    // it is read from the stored date, never guessed
    const f = appFn('_coMonthsLeft', '_coPanel');
    expect(f).toContain('if (!endsAt) return null;');
  });

  it('and the market tab says where the one status puts him', () => {
    const m = appFn('_coMarketPanel', '_coCareerPanel');
    expect(m).toContain('Where he appears on the Coach Market');
    expect(m).toContain("data-co-mset=");
    expect(m).toContain('co-where');
    // the panel derives it, it does not keep a second copy
    expect(m).toContain("var listed = ['OPEN_TO_OFFERS', 'ACTIVELY_LOOKING', 'CONTRACT_ENDING_SOON'].indexOf(st) >= 0;");
  });
});

describe('the notes screen is a record, not one textarea', () => {
  it('entries are dated and read back from the one stored note', () => {
    expect(APP).toContain('function _coNoteEntries(body)');
    const f = appFn('_coNoteEntries', '_coNotesPanel');
    expect(f).toContain('/^\\[(\\d{4}-\\d{2}-\\d{2})\\]');
    // a note written before the log existed is still shown, undated
    expect(f).toContain('else if (chunk.trim()) out.push({ on: null, body: chunk.trim() });');
    const p = appFn('_coNotesPanel', '_coMarketPanel');
    expect(p).toContain('class="co-log"');
    expect(p).toContain('data-co-noteadd');
    expect(p).toContain('data-co-newnote');
    expect(CSS).toContain('.co-log-i{');
  });

  it('an added entry is stamped and prepended to the same private note', () => {
    const wire = APP.slice(APP.indexOf('(function _coWire() {'));
    expect(wire).toContain("var body = '[' + stamp + '] ' + text + (prev ? '\\n' + prev : '');");
    expect(wire).toContain("_stApi('PUT', '/notes/' + encodeURIComponent(aid), { body: body })");
    // one record per club per person — nothing here creates a second
    expect(wire).not.toContain("'/notes/' + encodeURIComponent(aid) + '/new'");
  });
});

describe('and none of it reaches the other two modules', () => {
  it('no Coach Market function and no Transfers rule was touched', () => {
    // the redesigned Coaches block owns only .co-* selectors
    const block = CSS.slice(CSS.indexOf('COACHES · club → team → person → profile'),
      CSS.indexOf('FAMILISTA COACH EXCHANGE'));
    const selectors = [...block.matchAll(/^\.([a-z-]+)/gm)].map((m) => m[1]);
    expect(selectors.length).toBeGreaterThan(40);
    selectors.forEach((s) => expect(s.startsWith('co-')).toBe(true));
  });

  it('the directory still reads the market its own way and writes nothing of its own', () => {
    const wire = APP.slice(APP.indexOf('(function _coWire() {'));
    expect(wire).toContain("if (!t.closest('#pg-coaches')) return;");
    expect(APP).toContain('function _coStaffCardHtml(m)');
    // it opens _TF_ST.detail — the canonical record — rather than a copy
    expect(appFn('_coProfileHtml', '_coF')).toContain('var d = _TF_ST.detail[id];');
  });
});
