// Deterministic inputs for the golden snapshots and for the stories.
// No dates, no randomness, no network: the same call must always produce the
// same bytes. Club and player names here are sample data, not production data.

export const CREST_DATA_URI = 'data:image/svg+xml;utf8,'
  + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 26"><path d="M12 1.6 22 5v8.2c0 5.6-4 9.4-10 11.2C6 22.6 2 18.8 2 13.2V5z" fill="#fbbf24" fill-opacity=".9"/><path d="M12 7.4v10M7.2 10.2h9.6" stroke="#09090B" stroke-width="1.6" stroke-linecap="round"/></svg>');

// Seeds the registry app.js fills at login, with two sample clubs.
export function seedClubs(lg) {
  for (const k of Object.keys(lg.CLUB_IDENT)) delete lg.CLUB_IDENT[k];
  lg.CLUB_IDENT.riverside = { name: 'Riverside FC', short: 'RFC', crest: CREST_DATA_URI };
  lg.CLUB_IDENT.northgate = { name: 'Northgate United', short: 'NGU', crest: '' };
  return lg;
}

const fmtPct = (v) => v + '%';

export const CASES = {
  _lgCrest: {
    'with crest': (l) => l._lgCrest('riverside', 'Riverside FC', 30),
    'with crest, 44px': (l) => l._lgCrest('riverside', 'Riverside FC', 44),
    'known club without crest': (l) => l._lgCrest('northgate', 'Northgate United', 30),
    'unknown club, initials mark': (l) => l._lgCrest('nobody', 'Eastfield Athletic', 30),
    'no name, no club': (l) => l._lgCrest(null, '', 30),
    'single word name': (l) => l._lgCrest(null, 'Westvale', 24),
    'default size': (l) => l._lgCrest(null, 'Harbour United'),
  },
  _lgIdent: {
    'crest, name and sub line': (l) => l._lgIdent({ clubId: 'riverside', name: 'Riverside FC', sub: 'Familista League · 3rd' }),
    'no sub line': (l) => l._lgIdent({ clubId: 'riverside', name: 'Riverside FC' }),
    'initials fallback': (l) => l._lgIdent({ clubId: 'nobody', name: 'Eastfield Athletic', sub: 'Away' }),
    'custom class and size': (l) => l._lgIdent({ clubId: 'northgate', name: 'Northgate United', size: 44, cls: 'lg-ident--hero' }),
    'markup in the name is escaped': (l) => l._lgIdent({ name: '<b>Bad</b> & "Co"', sub: '<i>x</i>' }),
    'empty': (l) => l._lgIdent({}),
  },
  _lgChip: {
    'label and value': (l) => l._lgChip('Form', 'WWDLW'),
    'value only': (l) => l._lgChip('', '2 – 1'),
    'label only': (l) => l._lgChip('Imported', null),
    'zero is a value': (l) => l._lgChip('Goals', 0),
    'with modifier: up': (l) => l._lgChip('Kick-off', '15:00', 'up'),
    'with modifier: live': (l) => l._lgChip('', 'LIVE', 'live'),
    'with modifier: done': (l) => l._lgChip('', 'FT', 'done'),
  },
  _lgStatusChip: Object.fromEntries(
    ['SCHEDULED', 'LIVE', 'HALFTIME', 'PLAYED', 'FT', 'POSTPONED', 'CANCELLED', 'ABANDONED', 'live', 'nonsense', '']
      .map((s) => [s === '' ? 'empty falls back to upcoming' : s, (l) => l._lgStatusChip(s)])),
  _lgForm: {
    'five results': (l) => l._lgForm(['W', 'W', 'D', 'L', 'W']),
    'lowercase input': (l) => l._lgForm(['w', 'd', 'l']),
    'one result': (l) => l._lgForm(['L']),
    'empty list is a dash': (l) => l._lgForm([]),
    'null is a dash': (l) => l._lgForm(null),
  },
  _lgMetric: {
    'value': (l) => l._lgMetric('Minutes played', '1,284'),
    'with sub line': (l) => l._lgMetric('High-speed distance', '812 m', 'last 28 days'),
    'measured zero renders 0': (l) => l._lgMetric('Sprints', 0),
    'null renders a dash': (l) => l._lgMetric('Peak heart rate', null, 'No ECG device paired'),
    'empty string renders a dash': (l) => l._lgMetric('Distance', ''),
    'with modifier class': (l) => l._lgMetric('Readiness', '86', 'Ready', 'lg-metric--hero'),
  },
  _lgPanel: {
    'title and body': (l) => l._lgPanel('Standings', '', '<p>Body</p>'),
    'with sub line': (l) => l._lgPanel('Standings', 'Matchday 12', '<p>Body</p>'),
    'table panel': (l) => l._lgPanel('Player stats', '', '<table class="lg-t"><tr><td>1</td></tr></table>', 'lg-panel--table'),
    'fill panel': (l) => l._lgPanel('Pitch', '', '<div>pitch</div>', 'lg-panel--fill'),
    'empty body': (l) => l._lgPanel('Fixtures', '', ''),
  },
  _lgEmpty: {
    'title and sub': (l) => l._lgEmpty('No fixtures yet', 'Fixtures appear once the season is scheduled.'),
    'title only': (l) => l._lgEmpty('Nothing to show'),
    'ignores icon argument': (l) => l._lgEmpty('No data', 'Not recorded', 'trophy'),
  },
  _lgFloat: {
    'head and body': (l) => l._lgFloat({ close: 'closeFloat', head: '<span class="lg-float-t">Match details</span>', body: '<p>Body</p>' }),
    'with footer': (l) => l._lgFloat({ close: 'closeFloat', head: '<span class="lg-float-t">Edit</span>', body: '<p>Body</p>', foot: '<button type="button">Save</button>' }),
    'medium width class': (l) => l._lgFloat({ close: 'closeFloat', cls: 'lg-float--md', head: 'H', body: 'B' }),
    'large width class': (l) => l._lgFloat({ close: 'closeFloat', cls: 'lg-float--lg', head: 'H', body: 'B' }),
    'no options': (l) => l._lgFloat(),
  },
  _lgVersus: {
    'a leads': (l) => l._lgVersus('Possession', 58, 42, { fmt: fmtPct }),
    'b leads': (l) => l._lgVersus('Shots', 7, 14),
    'level': (l) => l._lgVersus('Corners', 5, 5),
    'both zero is flat': (l) => l._lgVersus('Red cards', 0, 0),
    'one side missing': (l) => l._lgVersus('xG', null, 1.4),
    'both missing draws nothing': (l) => l._lgVersus('Distance', null, null),
    'both missing, shown as unavailable': (l) => l._lgVersus('Distance', null, null, { showUnavailable: true }),
    'lower is better, a leads': (l) => l._lgVersus('Fouls', 8, 14, { lowerIsBetter: true }),
    'lower is better, b leads': (l) => l._lgVersus('Fouls', 14, 8, { lowerIsBetter: true }),
    'custom formatter': (l) => l._lgVersus('Pass accuracy', 91, 84, { fmt: fmtPct }),
  },
  // M3/S2.1b. Every icon the shared sanitizer can carry. `lock` is excluded on
  // purpose: it draws a <rect>, which the sanitizer does not allow, and the
  // sanitizer is not widened for a preview.
  _lgIcon: {
    'back': (l) => l._lgIcon('back'),
    'info': (l) => l._lgIcon('info'),
    'teams': (l) => l._lgIcon('teams'),
    'trophy': (l) => l._lgIcon('trophy'),
    'cup': (l) => l._lgIcon('cup'),
    'friendly': (l) => l._lgIcon('friendly'),
    'preseason': (l) => l._lgIcon('preseason'),
    'preparation': (l) => l._lgIcon('preparation'),
    'fixture': (l) => l._lgIcon('fixture'),
    'clock': (l) => l._lgIcon('clock'),
    'weather': (l) => l._lgIcon('weather'),
    'unknown name draws nothing': (l) => l._lgIcon('not-an-icon'),
  },
  // title:false throughout, as fourteen of the fifteen production call sites
  // pass it: the default writes a title attribute the sanitizer does not allow.
  clubLogoHtml: {
    'with crest, default size': (l) => l.clubLogoHtml('riverside', { title: false }),
    'with crest, plain, 44px': (l) => l.clubLogoHtml('riverside', { size: 44, cls: 'club-logo--plain', title: false }),
    'plain and round, 56px': (l) => l.clubLogoHtml('riverside', { size: 56, cls: 'club-logo--plain club-logo--round', title: false }),
    'ring, named size lg': (l) => l.clubLogoHtml('riverside', { size: 'lg', cls: 'club-logo--ring', title: false }),
    'off-ladder size snaps to the nearest step': (l) => l.clubLogoHtml('riverside', { size: 70, title: false }),
    'named size xs': (l) => l.clubLogoHtml('riverside', { size: 'xs', cls: 'club-logo--plain', title: false }),
    'known club without crest': (l) => l.clubLogoHtml('northgate', { size: 34, title: false }),
    'unknown club, shield placeholder': (l) => l.clubLogoHtml('nobody', { size: 'sm', title: false }),
    'no club, plain, 88px': (l) => l.clubLogoHtml(null, { size: 88, cls: 'club-logo--plain', title: false }),
  },
  // The exported component; public/app.js has no caller for it today.
  clubIdentityHtml: {
    'crest, name and sub line': (l) => l.clubIdentityHtml('riverside', { sub: 'Familista League · 3rd' }),
    'no sub line': (l) => l.clubIdentityHtml('riverside'),
    'known club without crest': (l) => l.clubIdentityHtml('northgate', { size: 'lg', sub: 'Away' }),
    'unknown club falls back to Club': (l) => l.clubIdentityHtml('nobody'),
    'name from the caller': (l) => l.clubIdentityHtml('nobody', { name: 'Eastfield Athletic', sub: 'Trialist club' }),
    'logo only': (l) => l.clubIdentityHtml('riverside', { showName: false }),
    'name only': (l) => l.clubIdentityHtml('riverside', { showLogo: false, sub: 'Home' }),
    'markup in the name is escaped': (l) => l.clubIdentityHtml(null, { name: '<b>Bad</b> & "Co"', sub: '<i>x</i>' }),
  },
};
