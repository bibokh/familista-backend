/**
 * tests/player-photo-persists.unit.test.ts
 *
 * A player's photograph is his record's, not his tab's.
 *
 * Before the roster was hydrated from the server, the Squad's edit form saved
 * through _sqSave() into the browser's own copy, and a photograph survived a
 * refresh because that copy did. Hydration deliberately turned _sqSave() into a
 * no-op — a stale local squad must never put a sold player back — and that was
 * the whole of the form's persistence. Every edit after it, the photograph
 * included, lived in one JavaScript object until the next read from the server
 * replaced it. Upload a picture, refresh, and it was gone: the server had never
 * been told, and the adapter that builds a screen player from a Player row did
 * not read the column even when something else had filled it.
 *
 * Nothing new stores it. Player.avatar has always existed, PATCH /players/:id
 * has always accepted it, and the update is partial — these tests hold the
 * three places the value has to travel through, and hold the rule that saving a
 * picture may not rewrite anything else about the footballer.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

function bodyOf(name: string): string | null {
  const at = APP.indexOf(`\nfunction ${name}(`);
  const as = APP.indexOf(`\nasync function ${name}(`);
  const start = at >= 0 ? at : as;
  if (start < 0) return null;
  let i = APP.indexOf('{', start), depth = 0;
  for (let j = i; j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}') { depth--; if (depth === 0) return APP.slice(i, j + 1); }
  }
  return null;
}

// The patch builder, lifted out of the page and run for real rather than
// matched as text — what it decides to send is the whole point.
function loadPatchBuilder() {
  const at = APP.indexOf('var SQ_SERVER_FIELDS = [');
  const fields = APP.slice(at, APP.indexOf('];', at) + 2);
  const src = 'function _sqServerPatch(before, data, photo) ' + bodyOf('_sqServerPatch');
  const factory = new Function('_thBackendPos', fields + '\n' + src + '\nreturn _sqServerPatch;');
  return factory((p: string) => (({ GK: 'GK', ST: 'ST', CM: 'MC', CB: 'DC' } as Record<string, string>)[p] || 'MC'));
}

const PLAYER = {
  id: '59f8be4f-5456-41da-9fd8-32285edb89b3',
  name: 'Diego Marán', num: 1, pos: 'GK', natName: 'Argentina', nat: '🇦🇷',
  qual: 84, cond: 94, foot: 'Right', height: '1.91m', photo: '',
};
const formData = (over: Record<string, unknown> = {}) => ({
  name: PLAYER.name, num: PLAYER.num, pos: PLAYER.pos, natName: PLAYER.natName, nat: PLAYER.nat,
  qual: PLAYER.qual, cond: PLAYER.cond, foot: PLAYER.foot, height: PLAYER.height, ...over,
});

describe('an edit reaches the server at all', () => {
  it('the form asks the players endpoint to store what changed', () => {
    const persist = bodyOf('_sqPersistPlayer');
    expect(persist).toBeTruthy();
    expect(persist).toContain("_thApi('PATCH', '/players/'");
    // and only for a real Player row, which is the only thing with a server id
    expect(persist).toContain('_thIsHydrated');
  });

  it('the save path builds that patch before it mutates the player', () => {
    const save = bodyOf('sqFormSave');
    expect(save).toContain('_sqServerPatch(p, data, photo)');
    expect(save).toContain('_sqPersistPlayer(p, patch)');
    // built from the player as he was, so "changed" means changed
    expect(save!.indexOf('_sqServerPatch(p, data, photo)'))
      .toBeLessThan(save!.indexOf('for (var k in data)'));
  });
});

describe('what the patch contains', () => {
  const build = loadPatchBuilder();

  it('a new photograph, and nothing else', () => {
    const patch = build(PLAYER, formData(), 'data:image/jpeg;base64,AAAA');
    expect(patch).toEqual({ avatar: 'data:image/jpeg;base64,AAAA' });
  });

  it('nothing at all when nothing was touched', () => {
    expect(build(PLAYER, formData(), '')).toEqual({});
  });

  it('a changed rating on its own', () => {
    expect(build(PLAYER, formData({ qual: 86 }), '')).toEqual({ overallRating: 86 });
  });

  it('a changed name as the two columns that hold it', () => {
    const patch = build(PLAYER, formData({ name: 'Diego Alberto Marán' }), '');
    expect(patch).toEqual({ firstName: 'Diego', lastName: 'Alberto Marán' });
  });

  it('never the date of birth — the form has a whole-number age, and a birthday is not recoverable from it', () => {
    const patch = build({ ...PLAYER, age: 30 }, formData({ age: 31 } as never), 'data:image/jpeg;base64,AAAA');
    expect(patch.dateOfBirth).toBeUndefined();
    expect(Object.keys(patch)).toEqual(['avatar']);
  });

  it('removing the photograph is a change too', () => {
    const patch = build({ ...PLAYER, photo: 'data:image/jpeg;base64,OLD' }, formData(), '');
    expect(patch).toEqual({ avatar: '' });
  });

  it('height travels as centimetres, and only when it moved', () => {
    expect(build(PLAYER, formData({ height: '1.91m' }), '')).toEqual({});
    expect(build(PLAYER, formData({ height: '1.95m' }), '')).toEqual({ height: 195 });
  });
});

describe('and the picture comes back', () => {
  it('the adapter reads the column every screen draws as `photo`', () => {
    expect(bodyOf('_sqAdaptBackendPlayer')).toContain('photo: bp.avatar || undefined');
  });

  it('a photo the browser already held goes up with the first lift', () => {
    expect(bodyOf('_thPlayerPayload')).toContain('avatar: p.photo || undefined');
  });

  it('and the lift writes it to the row it creates', () => {
    const svc = readFileSync(join(__dirname, '..', 'src', 'transfer-market', 'transfer-market.service.ts'), 'utf8');
    expect(svc).toContain('avatar: p.avatar ?? null');
    // declared on the shape the endpoint accepts, or it never arrives
    expect(svc).toContain('avatar?: string;');
  });
});
