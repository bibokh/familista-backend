/**
 * tests/club-needs-marketplace.unit.test.ts
 *
 * A published recruitment need is a public statement; a squad is not.
 *
 * The board every club reads and the matches it is shown come from the same
 * two service functions, and both have to hold the same line: every club sees
 * every open need, only the author may change one, an expired need is not
 * open, and the players scored against a need are always the caller's own —
 * never the author's, and never a club the caller does not belong to.
 *
 * Prisma is mocked in the way the other unit suites here mock it: the point is
 * the decision each function makes, not the database. The clubs and players are
 * fixtures of this test file, so nothing depends on seeded data.
 */

const needFindMany = jest.fn();
const needFindUnique = jest.fn();
const needUpdate = jest.fn();
const playerFindMany = jest.fn();
const clubFindUnique = jest.fn();

jest.mock('../src/config/database', () => ({
  prisma: {
    clubRecruitmentNeed: {
      findMany:   (...a: unknown[]) => needFindMany(...a),
      findUnique: (...a: unknown[]) => needFindUnique(...a),
      update:     (...a: unknown[]) => needUpdate(...a),
    },
    player: { findMany: (...a: unknown[]) => playerFindMany(...a) },
    club:   { findUnique: (...a: unknown[]) => clubFindUnique(...a) },
    playerOfferToClub: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}));

jest.mock('../src/security/audit-chain.service', () => ({ appendAuditEventAsync: jest.fn() }));
jest.mock('./../src/transfer-market/transfer-market.service', () => ({
  getBalance: jest.fn().mockResolvedValue({ availableEur: 50_000_000 }),
}));

import {
  readMarketNeeds, matchesForNeed, updateNeed, deleteNeed, matchPlayerToNeed,
} from '../src/transfer-market/transfer-negotiation.service';

const CLUB_A = 'club-a';   // publishes the need
const CLUB_B = 'club-b';   // reads the board and owns the striker
const CLUB_C = 'club-c';   // reads the same board, owns nobody suitable

const actor = (clubId: string) => ({ clubId, userId: 'user-' + clubId, role: 'HEAD_COACH' as never });

const born = (age: number) => new Date(Date.now() - age * 365.25 * 24 * 3600 * 1000);

/** FC A wants a young striker, 75+, up to €12M, right-footed. */
const NEED = {
  id: 'need-1', clubId: CLUB_A, positions: 'ST,LW',
  ageMin: 18, ageMax: 24, ratingMin: 75, ratingMax: null,
  budgetMinEur: 5_000_000n, budgetMaxEur: 12_000_000n,
  nationality: null, preferredFoot: 'RIGHT', playstyle: null, contractPreference: 'PERMANENT',
  priority: 'HIGH', note: 'Only our club sees this.', isActive: true,
  expiresAt: new Date(Date.now() + 48 * 3600_000), createdAt: new Date(), updatedAt: new Date(),
  createdById: 'u1',
};

/** Club B's squad: one who fits, one who does not. */
const STRIKER = {
  id: 'p-fit', firstName: 'Match', lastName: 'Striker', position: 'ST', trainedPositions: 'LW',
  roles: null, dateOfBirth: born(21), overallRating: 81, marketValue: 8_400_000,
  preferredFoot: 'RIGHT', nationality: 'Brazil', flag: '🇧🇷', avatar: null, jerseyNumber: 9,
};
const KEEPER = {
  id: 'p-unfit', firstName: 'Wrong', lastName: 'Keeper', position: 'GK', trainedPositions: null,
  roles: null, dateOfBirth: born(33), overallRating: 62, marketValue: 900_000,
  preferredFoot: 'LEFT', nationality: 'Germany', flag: '🇩🇪', avatar: null, jerseyNumber: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  clubFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve({ id: where.id, name: where.id.toUpperCase(), logo: null, city: null, country: null }));
  needFindUnique.mockResolvedValue(NEED);
  needFindMany.mockResolvedValue([NEED]);
  playerFindMany.mockResolvedValue([STRIKER, KEEPER]);
});

describe('a published need is public', () => {
  it('club B reads the need club A published', async () => {
    const board = await readMarketNeeds(actor(CLUB_B));
    expect(board.items).toHaveLength(1);
    expect(board.items[0].id).toBe('need-1');
    expect(board.items[0].club.id).toBe(CLUB_A);
    expect(board.items[0].isMine).toBe(false);
  });

  it('and club A sees the same one marked as its own', async () => {
    const board = await readMarketNeeds(actor(CLUB_A));
    expect(board.items[0].isMine).toBe(true);
  });

  it('the private note travels only to the author', async () => {
    const mine = await readMarketNeeds(actor(CLUB_A));
    const theirs = await readMarketNeeds(actor(CLUB_B));
    expect((mine.items[0] as { note?: string }).note).toBe('Only our club sees this.');
    expect((theirs.items[0] as { note?: string }).note).toBeUndefined();
  });

  it('only open needs are asked for at all', async () => {
    await readMarketNeeds(actor(CLUB_B));
    const where = needFindMany.mock.calls[0][0].where;
    expect(where.isActive).toBe(true);
    expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
  });
});

describe('only the author may change a need', () => {
  it('club B cannot edit club A’s need', async () => {
    await expect(updateNeed(actor(CLUB_B), 'need-1', { ratingMin: 40 })).rejects.toThrow(/another club/i);
    expect(needUpdate).not.toHaveBeenCalled();
  });

  it('club B cannot deactivate it either', async () => {
    await expect(deleteNeed(actor(CLUB_B), 'need-1')).rejects.toThrow(/another club/i);
    expect(needUpdate).not.toHaveBeenCalled();
  });

  it('club A can edit and deactivate its own', async () => {
    needUpdate.mockResolvedValue({ ...NEED, ratingMin: 80 });
    await expect(updateNeed(actor(CLUB_A), 'need-1', { ratingMin: 80 })).resolves.toMatchObject({ ratingMin: 80 });
    needUpdate.mockResolvedValue({ ...NEED, isActive: false });
    await expect(deleteNeed(actor(CLUB_A), 'need-1')).resolves.toEqual({ id: 'need-1', isActive: false });
  });
});

describe('an expired need is not open', () => {
  it('cannot be matched against', async () => {
    needFindUnique.mockResolvedValue({ ...NEED, expiresAt: new Date(Date.now() - 1000) });
    await expect(matchesForNeed(actor(CLUB_B), 'need-1')).rejects.toThrow(/no longer open/i);
    expect(playerFindMany).not.toHaveBeenCalled();
  });

  it('and neither can a deactivated one', async () => {
    needFindUnique.mockResolvedValue({ ...NEED, isActive: false });
    await expect(matchesForNeed(actor(CLUB_B), 'need-1')).rejects.toThrow(/no longer open/i);
    expect(playerFindMany).not.toHaveBeenCalled();
  });
});

describe('matching a need against the caller’s own squad', () => {
  it('returns the player who satisfies it', async () => {
    const out = await matchesForNeed(actor(CLUB_B), 'need-1');
    expect(out.items.map((i) => i.player.id)).toEqual(['p-fit']);
    expect(out.items[0].matchPct).toBeGreaterThanOrEqual(80);
  });

  it('excludes the one who does not', async () => {
    const out = await matchesForNeed(actor(CLUB_B), 'need-1');
    expect(out.items.map((i) => i.player.id)).not.toContain('p-unfit');
  });

  it('scores the caller’s squad and nobody else’s', async () => {
    await matchesForNeed(actor(CLUB_B), 'need-1');
    expect(playerFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { clubId: CLUB_B, isActive: true },
    }));
    // never the club that wrote the need, and never a club id off the request
    const asked = playerFindMany.mock.calls.map((c) => c[0].where.clubId);
    expect(asked).not.toContain(CLUB_A);
  });

  it('tells the author nothing about anyone’s squad', async () => {
    const out = await matchesForNeed(actor(CLUB_A), 'need-1');
    expect(out.isMine).toBe(true);
    expect(out.items).toEqual([]);
    expect(playerFindMany).not.toHaveBeenCalled();
  });

  it('a different club gets a different answer from the same need', async () => {
    playerFindMany.mockResolvedValue([KEEPER]);            // club C owns only the keeper
    const out = await matchesForNeed(actor(CLUB_C), 'need-1');
    expect(out.items).toEqual([]);
  });

  it('the reasons are the real values, criterion by criterion', async () => {
    const out = await matchesForNeed(actor(CLUB_B), 'need-1');
    const by = Object.fromEntries(out.items[0].criteria.map((c) => [c.key, c]));
    expect(by.position.ok).toBe(true);                     // ST is named by the need
    expect(by.age.ok).toBe(true);                          // 21 sits inside 18–24
    expect(by.rating.ok).toBe(true);                       // 81 clears 75
    expect(by.budget.ok).toBe(true);                       // €8.4M inside €5–12M
    expect(by.foot.ok).toBe(true);                         // right-footed, as asked
    expect(by.rating.detail).toContain('81');
  });

  it('a criterion the need did not state is not invented', async () => {
    const out = await matchesForNeed(actor(CLUB_B), 'need-1');
    const keys = out.items[0].criteria.map((c) => c.key);
    expect(keys).not.toContain('nationality');             // the need left it blank
    expect(keys).not.toContain('playstyle');
  });
});

describe('the board carries the count without a request per card', () => {
  it('counts only the reader’s own matching players', async () => {
    const board = await readMarketNeeds(actor(CLUB_B));
    expect(board.items[0].myMatches).toBe(1);
    // one query for the needs, one for the squad — not one per need
    expect(needFindMany).toHaveBeenCalledTimes(1);
    expect(playerFindMany).toHaveBeenCalledTimes(1);
  });

  it('a club is never counted against its own need', async () => {
    const board = await readMarketNeeds(actor(CLUB_A));
    expect(board.items[0].myMatches).toBe(0);
  });

  it('the count follows the squad, not the need', async () => {
    playerFindMany.mockResolvedValue([KEEPER]);
    const board = await readMarketNeeds(actor(CLUB_C));
    expect(board.items[0].myMatches).toBe(0);
  });
});

describe('the scoring itself is deterministic', () => {
  const spec = {
    positions: ['ST'], ageMin: 18, ageMax: 24, ratingMin: 75, ratingMax: null,
    budgetMinEur: null, budgetMaxEur: 12_000_000, nationality: null, preferredFoot: 'RIGHT', playstyle: null,
  };
  it('gives the same player the same number every time', () => {
    const a = matchPlayerToNeed(STRIKER, spec);
    const b = matchPlayerToNeed(STRIKER, spec);
    expect(a.pct).toBe(b.pct);
    expect(a.pct).toBe(100);
  });
  it('and drops the number when a criterion fails', () => {
    const older = matchPlayerToNeed({ ...STRIKER, dateOfBirth: born(31) }, spec);
    expect(older.pct).toBeLessThan(100);
    expect(older.criteria.find((c) => c.key === 'age')!.ok).toBe(false);
  });
});
