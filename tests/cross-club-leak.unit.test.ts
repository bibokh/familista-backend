/**
 * tests/cross-club-leak.unit.test.ts
 *
 * The leak the Group 6 audit found, held shut.
 *
 * `GET /transfer-market/market` used to fetch the whole Player row for every
 * listing and hand it to whichever club was reading — which meant a child's
 * email address, his guardian's name, email and phone number, his medical and
 * payment status and his coaches' notes travelled to every other club on the
 * platform. The auction reads were narrower but still shipped a birth date.
 *
 * These tests do not check that the code calls a helper. They feed the mocked
 * database a row with every private column populated and then read the JSON the
 * service returns, because the response body is what actually leaves.
 */

const itemFindMany = jest.fn();
const itemCount = jest.fn();
const itemFindUnique = jest.fn();
const playerFindUnique = jest.fn();
const playerFindMany = jest.fn();
const clubFindUnique = jest.fn();
const clubFindMany = jest.fn();
const bidFindMany = jest.fn();

jest.mock('../src/config/database', () => ({
  prisma: {
    marketplaceItem: {
      findMany:   (...a: unknown[]) => itemFindMany(...a),
      count:      (...a: unknown[]) => itemCount(...a),
      findUnique: (...a: unknown[]) => itemFindUnique(...a),
    },
    player: {
      findUnique: (...a: unknown[]) => playerFindUnique(...a),
      findMany:   (...a: unknown[]) => playerFindMany(...a),
    },
    club: {
      findUnique: (...a: unknown[]) => clubFindUnique(...a),
      findMany:   (...a: unknown[]) => clubFindMany(...a),
    },
    transferBid: { findMany: (...a: unknown[]) => bidFindMany(...a) },
    clubTransferBalance: { upsert: jest.fn() },
  },
}));
jest.mock('../src/security/audit-chain.service', () => ({ appendAuditEventAsync: jest.fn() }));
jest.mock('../src/transfer-market/transfer-negotiation.service', () => ({
  notifyClub: jest.fn(), fmt: (n: number) => String(n),
}));

import { readMarket, readOwnListings } from '../src/transfer-market/transfer-market.service';
import { readAuctions, readAuction } from '../src/transfer-market/transfer-auction.service';

const YEAR = 365.25 * 24 * 3600 * 1000;

// Every private column populated with something unmistakable, so a leak is
// visible as a literal in the response.
const LEAKY = {
  id: 'p1', firstName: 'Tomás', lastName: 'Ferreira', number: 9,
  position: 'ST', trainedPositions: 'ST', nationality: 'Portugal', flag: '🇵🇹',
  avatar: null, overallRating: 82, potential: 88, preferredFoot: 'RIGHT',
  marketValue: 12_000_000, contractUntil: new Date('2028-06-30'),
  clubId: 'club-b', dateOfBirth: new Date(Date.now() - 23 * YEAR),
  roles: 'AF · ST', isActive: true,
  // ── none of this may travel ──
  email: 'tomas@example.com',
  parentName: 'Marta Ferreira',
  parentEmail: 'marta@example.com',
  parentPhone: '+351 900 000 000',
  notes: 'recurring knee complaint, monitor',
  medicalStatus: 'INJURED',
  paymentStatus: 'OVERDUE',
  condition: 58, form: 3, morale: 'Poor', isInjured: true,
  weeklyWage: 44_000, height: 186, weight: 79, legacyId: 'sq-9', teamId: 'team-b1',
};

const SECRETS = [
  'tomas@example.com', 'Marta Ferreira', 'marta@example.com', '+351 900 000 000',
  'recurring knee complaint', 'INJURED', 'OVERDUE', 'Poor', 'sq-9', 'team-b1',
];
const SECRET_KEYS = [
  '"email"', '"parentName"', '"parentEmail"', '"parentPhone"', '"notes"',
  '"medicalStatus"', '"paymentStatus"', '"condition"', '"form"', '"morale"',
  '"isInjured"', '"weeklyWage"', '"height"', '"weight"', '"legacyId"', '"teamId"',
  '"dateOfBirth"',
];

const expectClean = (json: string) => {
  for (const s of SECRETS) expect(json).not.toContain(s);
  for (const k of SECRET_KEYS) expect(json).not.toContain(k);
};

const ME = { userId: 'u1', clubId: 'club-a' };

beforeEach(() => {
  jest.clearAllMocks();
  // The database is told to hand back the full row whatever is asked for, so
  // these tests fail if the service ever stops projecting.
  playerFindUnique.mockResolvedValue(LEAKY);
  playerFindMany.mockResolvedValue([LEAKY]);
  clubFindUnique.mockResolvedValue({ id: 'club-b', name: 'FC Beispiel', shortName: 'BSP', emblem: null });
  clubFindMany.mockResolvedValue([{ id: 'club-b', name: 'FC Beispiel', shortName: 'BSP', emblem: null }]);
  bidFindMany.mockResolvedValue([]);
  itemCount.mockResolvedValue(1);
});

describe('the market listing read', () => {
  const LISTING = {
    id: 'l1', kind: 'TRANSFER_LISTING', clubId: 'club-b', status: 'ACTIVE',
    validUntil: new Date(Date.now() + 3600_000), createdAt: new Date(),
    payload: { playerId: 'p1', askingPriceEur: 9_000_000 },
  };

  it('publishes the football and nothing private', async () => {
    itemFindMany.mockResolvedValue([LISTING]);
    const out = await readMarket(ME);
    const row = out.items[0] as { player: { name: string; age: number } };
    expect(row.player.name).toBe('Tomás Ferreira');
    expect(row.player.age).toBe(23);
    expectClean(JSON.stringify(out));
  });

  it('holds the same line on a club\'s own listings', async () => {
    itemFindMany.mockResolvedValue([LISTING]);
    expectClean(JSON.stringify(await readOwnListings({ userId: 'u2', clubId: 'club-b' })));
  });
});

describe('the auction reads', () => {
  const AUCTION = {
    id: 'a1', kind: 'TRANSFER_LISTING', clubId: 'club-b', status: 'ACTIVE',
    validUntil: new Date(Date.now() + 3600_000), createdAt: new Date(),
    settledAt: null, winnerClubId: null, finalPriceEur: null,
    payload: { playerId: 'p1', mode: 'AUCTION', startingPriceEur: 5_000_000 },
  };

  it('the board carries no private field', async () => {
    // settleDueAuctions runs first and asks for due rows; then the board reads.
    itemFindMany.mockResolvedValueOnce([]).mockResolvedValue([AUCTION]);
    const out = await readAuctions(ME);
    expect((out.items[0] as { player: { name: string } }).player.name).toBe('Tomás Ferreira');
    expectClean(JSON.stringify(out));
  });

  it('one auction carries no private field either', async () => {
    itemFindMany.mockResolvedValue([]);
    itemFindUnique.mockResolvedValue(AUCTION);
    expectClean(JSON.stringify(await readAuction(ME, 'a1')));
  });
});
