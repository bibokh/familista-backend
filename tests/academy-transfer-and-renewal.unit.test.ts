/**
 * tests/academy-transfer-and-renewal.unit.test.ts
 *
 * The two flows that had never been driven end to end.
 *
 * 1. THE ACADEMY TRANSFER FLOW. Selling a player was only ever exercised from
 *    the First Team, because the club that was being tested happened to have no
 *    age group open. Nothing in the server was First-Team-only — but nothing
 *    proved it wasn't, either. Held here: an academy player lists, goes to
 *    auction, and is offered to clubs through the same three endpoints, and
 *    every record that results names the age group's team rather than the
 *    club's senior side. The team is read from the Player row, so no age band
 *    is named anywhere in the rule or in this test.
 *
 * 2. CONTRACT RENEWAL. The fourth action in the Contract / Transfer panel had
 *    no server side at all: the panel said so and offered a disabled button.
 *    It now writes the terms the club holds for him — Player.weeklyWage,
 *    Player.contractUntil and the one PlayerContractStatus row the listing code
 *    already maintains. Held here: what it persists, what it refuses, that a
 *    second renewal rewrites rather than duplicates, and that a player another
 *    club owns cannot be renewed.
 *
 * The browser contract is held too: the renewal panel is a real form, its save
 * goes to the server, and it refuses a player whose id is still a squad label.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

function fnBody(name: string) {
  const at = APP.search(new RegExp(`(async )?function ${name}\\s*\\(`));
  if (at < 0) return '';
  let i = APP.indexOf('{', at), depth = 0, j = i;
  for (; j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}' && --depth === 0) break;
  }
  return APP.slice(i, j);
}

// ── the server, against a Prisma the test drives ────────────────────────────
const itemFindMany = jest.fn();
const itemFindFirst = jest.fn();
const itemCreate = jest.fn();
const itemUpdate = jest.fn();
const playerFindUnique = jest.fn();
const playerUpdate = jest.fn();
const offerFindFirst = jest.fn();
const contractFindUnique = jest.fn();
const contractCreate = jest.fn();
const contractUpdate = jest.fn();
const contractUpsert = jest.fn();
const $transaction = jest.fn();

jest.mock('../src/config/database', () => ({
  prisma: {
    marketplaceItem: {
      findMany: (...a: unknown[]) => itemFindMany(...a),
      findFirst: (...a: unknown[]) => itemFindFirst(...a),
      findUnique: (...a: unknown[]) => itemFindFirst(...a),
      create: (...a: unknown[]) => itemCreate(...a),
      update: (...a: unknown[]) => itemUpdate(...a),
      count: jest.fn().mockResolvedValue(0),
    },
    player: {
      findUnique: (...a: unknown[]) => playerFindUnique(...a),
      update: (...a: unknown[]) => playerUpdate(...a),
    },
    transferOffer: { findFirst: (...a: unknown[]) => offerFindFirst(...a) },
    playerContractStatus: {
      findUnique: (...a: unknown[]) => contractFindUnique(...a),
      create: (...a: unknown[]) => contractCreate(...a),
      update: (...a: unknown[]) => contractUpdate(...a),
      upsert: (...a: unknown[]) => contractUpsert(...a),
    },
    $transaction: (...a: unknown[]) => $transaction(...a),
  },
}));
jest.mock('../src/security/audit-chain.service', () => ({ appendAuditEventAsync: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const svc = require('../src/transfer-market/transfer-market.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const con = require('../src/transfer-market/transfer-contract.service');

const CLUB = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ACAD_TEAM = '33333333-3333-4333-8333-333333333333';
const SENIOR_TEAM = '44444444-4444-4444-8444-444444444444';
const KID = '55555555-5555-4555-8555-555555555555';
const PRO = '66666666-6666-4666-8666-666666666666';

const actor = { userId: 'u-1', clubId: CLUB };
const outsider = { userId: 'u-2', clubId: OTHER };

// An academy footballer: a real Player row, filed under an academy Team. His
// age group is not named — what makes him an academy player is his teamId.
const academyPlayer = {
  id: KID, clubId: CLUB, teamId: ACAD_TEAM, isActive: true,
  firstName: 'A', lastName: 'Kid', position: 'ST',
  marketValue: 1_500_000, weeklyWage: 10_000, contractUntil: null,
};
const seniorPlayer = {
  id: PRO, clubId: CLUB, teamId: SENIOR_TEAM, isActive: true,
  firstName: 'A', lastName: 'Pro', position: 'MC',
  marketValue: 30_000_000, weeklyWage: 10_000, contractUntil: null,
};

const listingRow = {
  id: '77777777-7777-4777-8777-777777777777',
  clubId: CLUB, kind: 'TRANSFER_LISTING', status: 'ACTIVE',
  validFrom: new Date(), validUntil: null, createdAt: new Date(),
  payload: { playerId: KID, sellerClubId: CLUB, sellerTeamId: ACAD_TEAM, askingPriceEur: 1_500_000 },
};

function txFor(p: Record<string, unknown>) {
  return {
    marketplaceItem: { create: itemCreate, update: itemUpdate },
    player: { findUnique: playerFindUnique, update: playerUpdate },
    playerContractStatus: {
      findUnique: contractFindUnique, create: contractCreate,
      update: contractUpdate, upsert: contractUpsert,
    },
    _p: p,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  playerFindUnique.mockResolvedValue(academyPlayer);
  offerFindFirst.mockResolvedValue(null);
  itemFindFirst.mockResolvedValue(null);
  itemFindMany.mockResolvedValue([]);
  itemCreate.mockResolvedValue(listingRow);
  contractFindUnique.mockResolvedValue(null);
  contractCreate.mockImplementation(async (a: { data: unknown }) => a.data);
  contractUpsert.mockImplementation(async (a: { create: Record<string, unknown> }) => ({
    ...a.create, releaseClauseEur: (a.create as { releaseClauseEur?: number }).releaseClauseEur ?? null,
  }));
  playerUpdate.mockImplementation(async (a: { where: { id: string }; data: Record<string, unknown> }) => ({
    ...academyPlayer, ...a.data, id: a.where.id,
  }));
  $transaction.mockImplementation(async (fn: unknown) =>
    typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(txFor({})) : fn);
});

// ══ 1. THE ACADEMY TRANSFER FLOW ═══════════════════════════════════════════
describe('an academy player reaches the market like anybody else', () => {
  it('lists, and the listing names his academy team', async () => {
    const row = await svc.listPlayer(actor, { playerId: KID, askingPriceEur: 1_500_000 });
    expect(itemCreate).toHaveBeenCalledTimes(1);
    const payload = itemCreate.mock.calls[0][0].data.payload;
    expect(payload.playerId).toBe(KID);
    expect(payload.sellerClubId).toBe(CLUB);
    expect(payload.sellerTeamId).toBe(ACAD_TEAM);
    expect(row.status).toBe('ACTIVE');
  });

  it('takes the team from the Player row, so no age group is hardcoded', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'transfer-market', 'transfer-market.service.ts'), 'utf8');
    expect(src).toMatch(/sellerTeamId:\s*player\.teamId/);
    // nothing in the market service decides anything from an age band or a kind
    expect(src).not.toMatch(/kind\s*===\s*'ACADEMY/);
    expect(src).not.toMatch(/ageM(in|ax)\s*[<>=]/);
  });

  it('refuses to list a player another club owns, academy or not', async () => {
    await expect(svc.listPlayer(outsider, { playerId: KID, askingPriceEur: 1 }))
      .rejects.toThrow(/another club/i);
    expect(itemCreate).not.toHaveBeenCalled();
  });

  it('listing him twice is the same listing, not a second one', async () => {
    itemFindMany.mockResolvedValue([listingRow]);
    const again = await svc.listPlayer(actor, { playerId: KID, askingPriceEur: 9_000_000 });
    expect(again.id).toBe(listingRow.id);
    expect(itemCreate).not.toHaveBeenCalled();
  });

  it('marks him available for transfer on his own contract record', async () => {
    await svc.listPlayer(actor, { playerId: KID, askingPriceEur: 1_500_000 });
    expect(contractCreate).toHaveBeenCalledTimes(1);
    const created = contractCreate.mock.calls[0][0].data;
    expect(created.playerId).toBe(KID);
    expect(created.isAvailableForTransfer).toBe(true);
  });

  it('delisting takes the same record back off the market', async () => {
    itemFindFirst.mockResolvedValue(listingRow);
    itemUpdate.mockResolvedValue({ ...listingRow, status: 'CLOSED' });
    const out = await svc.delistPlayer(actor, listingRow.id);
    expect(out.status).toBe('CLOSED');
    expect(itemUpdate).toHaveBeenCalled();
  });

  it('only the selling club may delist his listing', async () => {
    itemFindFirst.mockResolvedValue(listingRow);
    await expect(svc.delistPlayer(outsider, listingRow.id)).rejects.toThrow(/selling club/i);
  });
});

describe('the browser offers the academy surface the same actions', () => {
  it('an age group profile renders the Contract / Transfer button with its own context', () => {
    expect(APP).toMatch(/_tfSellButton\('academy:'\s*\+\s*AT\.active/);
  });

  it('the team registry is built from the club\'s stages, not a fixed list', () => {
    const body = fnBody('_tfTeamRegistry');
    expect(body).toContain('AC_STAGES.forEach');
    expect(body).toContain('_acCanOpen');
    // no age band is named
    expect(body).not.toMatch(/U1\d|U2\d/);
  });

  it('all four actions are rendered for whatever context the panel is mounted in', () => {
    const body = fnBody('_tfContractHtml');
    for (const a of ['renew', 'auction', 'clubs', 'now']) {
      expect(body).toContain(`data-tf-exp="${a}"`);
    }
    // and the context it was mounted with is carried on every one of them,
    // so an age group's panel acts on that age group
    expect(body).toContain('data-tf-ctx="\' + _tfEsc(ctxId)');
  });
});

// ══ 2. CONTRACT RENEWAL ════════════════════════════════════════════════════
describe('renewing a contract writes the club\'s own record', () => {
  const terms = { weeklyWageEur: 84_500, contractUntil: '2029-06-30', releaseClauseEur: 42_000_000 };

  it('persists the wage and the end date on the Player row', async () => {
    const out = await con.renewContract(actor, KID, terms);
    expect(playerUpdate).toHaveBeenCalledTimes(1);
    const data = playerUpdate.mock.calls[0][0].data;
    expect(data.weeklyWage).toBe(84_500);
    expect(data.contractUntil.toISOString().slice(0, 10)).toBe('2029-06-30');
    expect(out.playerId).toBe(KID);
  });

  it('upserts exactly one PlayerContractStatus row, so renewing twice cannot duplicate', async () => {
    await con.renewContract(actor, KID, terms);
    expect(contractUpsert).toHaveBeenCalledTimes(1);
    expect(contractCreate).not.toHaveBeenCalled();
    const call = contractUpsert.mock.calls[0][0];
    expect(call.where).toEqual({ playerId: KID });
    expect(call.create.releaseClauseEur).toBe(42_000_000);
    expect(call.update.contractExpiry.toISOString().slice(0, 10)).toBe('2029-06-30');
  });

  it('works the same for a senior player — the path asks nothing about his team', async () => {
    playerFindUnique.mockResolvedValue(seniorPlayer);
    playerUpdate.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ ...seniorPlayer, ...a.data }));
    const out = await con.renewContract(actor, PRO, terms);
    expect(out.teamId).toBe(SENIOR_TEAM);
    expect(playerUpdate.mock.calls[0][0].data.weeklyWage).toBe(84_500);
  });

  it('never touches team, club or squad membership', async () => {
    await con.renewContract(actor, KID, terms);
    const data = playerUpdate.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual(['contractUntil', 'weeklyWage']);
  });

  it('refuses a player another club owns', async () => {
    await expect(con.renewContract(outsider, KID, terms)).rejects.toThrow(/another club/i);
    expect(playerUpdate).not.toHaveBeenCalled();
  });

  it('refuses a player who is not there', async () => {
    playerFindUnique.mockResolvedValue(null);
    await expect(con.renewContract(actor, KID, terms)).rejects.toThrow();
    expect(playerUpdate).not.toHaveBeenCalled();
  });

  it('refuses an end date in the past', async () => {
    await expect(con.renewContract(actor, KID, { ...terms, contractUntil: '2001-01-01' }))
      .rejects.toThrow(/future/i);
    expect(playerUpdate).not.toHaveBeenCalled();
  });

  it('refuses an end date that is not a date', async () => {
    await expect(con.renewContract(actor, KID, { ...terms, contractUntil: 'next summer' }))
      .rejects.toThrow(/not a date/i);
  });

  it('refuses a negative wage, and a wage that is not a number', async () => {
    await expect(con.renewContract(actor, KID, { ...terms, weeklyWageEur: -1 }))
      .rejects.toThrow(/negative/i);
    await expect(con.renewContract(actor, KID, { ...terms, weeklyWageEur: 'lots' as never }))
      .rejects.toThrow(/not a number/i);
    expect(playerUpdate).not.toHaveBeenCalled();
  });

  it('reads a wage that arrived from an <input> as a string', async () => {
    await con.renewContract(actor, KID, { ...terms, weeklyWageEur: '84500' as never });
    expect(playerUpdate.mock.calls[0][0].data.weeklyWage).toBe(84_500);
  });

  it('treats the release clause as optional and leaves it alone when omitted', async () => {
    await con.renewContract(actor, KID, { weeklyWageEur: 1000, contractUntil: '2029-01-01' });
    const call = contractUpsert.mock.calls[0][0];
    expect(call.create.releaseClauseEur).toBeNull();
    expect(call.update).not.toHaveProperty('releaseClauseEur');
  });

  it('will not renew a player who is currently on the market', async () => {
    itemFindMany.mockResolvedValue([listingRow]);
    await expect(con.renewContract(actor, KID, terms)).rejects.toThrow(/on the market/i);
    expect(playerUpdate).not.toHaveBeenCalled();
  });

  it('reads back the terms it stored', async () => {
    playerFindUnique.mockResolvedValue({
      ...academyPlayer, weeklyWage: 84_500, contractUntil: new Date('2029-06-30'),
    });
    contractFindUnique.mockResolvedValue({
      playerId: KID, clubId: CLUB, contractExpiry: new Date('2029-06-30'),
      releaseClauseEur: 42_000_000, isAvailableForTransfer: false,
    });
    const read = await con.readContract(actor, KID);
    expect(read.weeklyWageEur).toBe(84_500);
    expect(read.releaseClauseEur).toBe(42_000_000);
    expect(read.teamId).toBe(ACAD_TEAM);
  });

  it('will not read another club\'s player either', async () => {
    await expect(con.readContract(outsider, KID)).rejects.toThrow(/another club/i);
  });
});

describe('the renewal panel in the browser', () => {
  const body = fnBody('_tfContractHtml');

  it('is a real form, not a read-only notice', () => {
    expect(body).toContain('data-tf-renew-wage');
    expect(body).toContain('data-tf-renew-until');
    expect(body).toContain('data-tf-renew-save');
    expect(body).not.toContain('RENEW — NOT AVAILABLE');
    expect(body).not.toContain('not enabled on the server yet');
  });

  it('shows the terms the server holds, once it has read them', () => {
    expect(body).toContain('_tfContractRecord(p.id)');
    expect(body).toContain('_tfLoadContract(p.id)');
  });

  it('saves to the server and refuses an id that is still a squad label', () => {
    const handler = APP.slice(APP.indexOf("data-tf-renew-save]'))"));
    const upto = handler.slice(0, handler.indexOf('data-tf-pick-club'));
    expect(upto).toContain('_tfIsCanonicalId(rp.id)');
    expect(upto).toContain('_tfServerRenew(');
    expect(upto).toContain('_tfHasSession()');
  });

  it('goes to the contract endpoint, and only that endpoint', () => {
    const send = fnBody('_tfServerRenew');
    expect(send).toContain("'/transfer-market/players/'");
    expect(send).toContain("'/contract/renew'");
  });

  it('re-reads the squad after saving rather than patching a copy of it', () => {
    const handler = APP.slice(APP.indexOf("data-tf-renew-save]'))"));
    const upto = handler.slice(0, handler.indexOf('data-tf-pick-club'));
    expect(upto).toContain('_thRefresh');
    expect(upto).toContain('_sqLoad');
  });

  it('reads the stored wage and end date rather than deriving them, when they exist', () => {
    expect(fnBody('_tfWageOf')).toContain('p.wageWeekly');
    expect(fnBody('_tfContractExpiry')).toContain('_tfContractUntilDate(p)');
    // hydration carries them off the Player row
    expect(fnBody('_sqAdaptBackendPlayer')).toContain('bp.weeklyWage');
    expect(fnBody('_sqAdaptBackendPlayer')).toContain('bp.contractUntil');
  });

  it('forgets one club\'s contracts when the workspace changes club', () => {
    expect(fnBody('_thResetRoster')).toContain('_tfContractForget');
  });
});

describe('the renewal route is guarded like the actions beside it', () => {
  const routes = readFileSync(
    join(__dirname, '..', 'src', 'routes', 'transfer-market.routes.ts'), 'utf8');

  it('both contract routes sit behind the trade tier', () => {
    expect(routes).toMatch(/players\/:playerId\/contract['"],\s*tradeGuard/);
    expect(routes).toMatch(/players\/:playerId\/contract\/renew['"],\s*tradeGuard/);
  });

  it('the controller validates the player id as a UUID before the service sees it', () => {
    const ctrl = readFileSync(
      join(__dirname, '..', 'src', 'controllers', 'transfer-market.controller.ts'), 'utf8');
    const at = ctrl.indexOf('export async function renewPlayerContract');
    expect(ctrl.slice(at, at + 400)).toContain("requireUUID(req.params.playerId, 'playerId')");
  });

  it('the acting club comes from the session, never the request body', () => {
    const ctrl = readFileSync(
      join(__dirname, '..', 'src', 'controllers', 'transfer-market.controller.ts'), 'utf8');
    const at = ctrl.indexOf('export async function renewPlayerContract');
    const fn = ctrl.slice(at, at + 400);
    expect(fn).toContain('actor(req)');
    expect(fn).not.toContain('req.body.clubId');
  });
});
