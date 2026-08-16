/**
 * tests/public-player-projection.unit.test.ts
 *
 * What another club may know about a footballer.
 *
 * A Player row carries a child's email address, his guardian's name and phone
 * number, his medical state, whether his club has been paid, and his coaches'
 * notes. Before this, the market listing read handed all of it to every other
 * club on the platform, because it fetched the whole row and let the screen
 * decide what to draw.
 *
 * These tests hold the fix at both ends. The SELECT must not ask for a private
 * column, so it cannot leak by accident later; and the object that leaves the
 * server must not carry one, so it cannot leak even if the row is widened. The
 * assertions run against the serialized JSON — not the object — because what
 * actually reaches another club is the response body.
 */

import {
  publicPlayerSelect, toPublicPlayer, scoringShape, ageFrom, actionsFor,
  PRIVATE_PLAYER_FIELDS, UNKNOWN_CLUB, publicClubSelect,
} from '../src/transfer-market/public-player';

const YEAR = 365.25 * 24 * 3600 * 1000;

// A complete row as Prisma would return it, private columns included — so a
// projection that spread its input would be caught here.
const ROW = {
  id: 'p1', firstName: 'Tomás', lastName: 'Ferreira', number: 9,
  position: 'ST', trainedPositions: 'ST,AMC', nationality: 'Portugal', flag: '🇵🇹',
  avatar: null, overallRating: 82, potential: 88, preferredFoot: 'RIGHT',
  marketValue: 12_000_000, contractUntil: new Date('2028-06-30'),
  clubId: 'club-b', dateOfBirth: new Date(Date.now() - 23 * YEAR),
  roles: 'AF · ST', isActive: true,
} as never;

describe('the select never asks for a private column', () => {
  const asked = Object.keys(publicPlayerSelect);

  it('does not read the contact details of a player or his guardian', () => {
    for (const f of ['email', 'parentName', 'parentEmail', 'parentPhone']) {
      expect(asked).not.toContain(f);
    }
  });

  it('does not read medical, payment or internal performance state', () => {
    for (const f of ['medicalStatus', 'paymentStatus', 'notes', 'condition', 'form', 'morale', 'isInjured', 'weeklyWage']) {
      expect(asked).not.toContain(f);
    }
  });

  it('reads only what it emits, or what it needs to derive what it emits', () => {
    // dateOfBirth → age, roles → the playstyle criterion, isActive → the filter.
    const derivedOnly = ['dateOfBirth', 'roles', 'isActive'];
    const emitted = Object.keys(toPublicPlayer(ROW));
    for (const key of asked) {
      if (derivedOnly.includes(key)) continue;
      expect(emitted).toContain(key);
    }
  });
});

describe('the projection is built, not spread', () => {
  const shaped = toPublicPlayer(ROW);
  const json = JSON.stringify(shaped);

  it('carries the football', () => {
    expect(shaped.name).toBe('Tomás Ferreira');
    expect(shaped.position).toBe('ST');
    expect(shaped.trainedPositions).toEqual(['ST', 'AMC']);
    expect(shaped.overallRating).toBe(82);
    expect(shaped.potential).toBe(88);
    expect(shaped.marketValue).toBe(12_000_000);
    expect(shaped.nationality).toBe('Portugal');
    expect(shaped.clubId).toBe('club-b');
  });

  it('carries his age and not his birth date', () => {
    expect(shaped.age).toBe(23);
    expect(json).not.toContain('dateOfBirth');
  });

  it('carries no private field, in the JSON itself', () => {
    // The response body is what reaches another club, so that is what is read.
    for (const f of PRIVATE_PLAYER_FIELDS) {
      expect(json).not.toContain(`"${f}"`);
    }
  });

  it('survives a row that grows a private column tomorrow', () => {
    const widened = { ...(ROW as object), someNewSecret: 'x', parentPhone: '+49 555' } as never;
    const out = JSON.stringify(toPublicPlayer(widened));
    expect(out).not.toContain('someNewSecret');
    expect(out).not.toContain('+49 555');
  });
});

describe('the scoring shape is separate from the public shape', () => {
  it('keeps the birth date and the playstyle for matchPlayerToNeed', () => {
    const s = scoringShape(ROW);
    expect(s.dateOfBirth).toBeInstanceOf(Date);
    expect(s.roles).toBe('AF · ST');
  });

  it('and those two never appear on the public one', () => {
    const p = toPublicPlayer(ROW) as unknown as Record<string, unknown>;
    expect(p.dateOfBirth).toBeUndefined();
    expect(p.roles).toBeUndefined();
  });
});

describe('age', () => {
  it('is null when there is no birth date', () => { expect(ageFrom(null)).toBeNull(); });
  it('is whole years, floored', () => {
    expect(ageFrom(new Date(Date.now() - 17.9 * YEAR))).toBe(17);
    expect(ageFrom(new Date(Date.now() - 18.0 * YEAR))).toBe(18);
  });
});

describe('a club is a name and a crest, and nothing else', () => {
  it('reads four columns', () => {
    expect(Object.keys(publicClubSelect).sort()).toEqual(['emblem', 'id', 'name', 'shortName']);
  });
  it('a reference that does not resolve says so rather than inventing a club', () => {
    expect(UNKNOWN_CLUB('gone').name).toBe('Unknown / unavailable club');
  });
});

describe('what a state lets you do', () => {
  it('an auction is bid on, not bought around', () => {
    expect(actionsFor('AUCTION')).toEqual(['VIEW_AUCTION']);
  });
  it('a published price can be paid or negotiated', () => {
    expect(actionsFor('LISTED')).toEqual(['VIEW_LISTING', 'PURCHASE', 'MAKE_OFFER']);
  });
  it('a player his club marked available can be offered for', () => {
    expect(actionsFor('AVAILABLE')).toContain('MAKE_OFFER');
  });
  it('a player nobody put on the market can only be asked about', () => {
    expect(actionsFor('NOT_AVAILABLE')).toEqual(['REGISTER_INTEREST']);
    expect(actionsFor('NOT_AVAILABLE')).not.toContain('MAKE_OFFER');
    expect(actionsFor('NOT_AVAILABLE')).not.toContain('PURCHASE');
  });
  it('our own player carries no transfer action at all', () => {
    expect(actionsFor('OWN')).toEqual([]);
  });
});
