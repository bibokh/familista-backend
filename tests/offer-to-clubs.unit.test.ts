/**
 * tests/offer-to-clubs.unit.test.ts
 *
 * Offering a player to clubs, completed.
 *
 * The write already existed — PlayerOfferToClub, one row per club approached —
 * but nothing read it back, so a published player was invisible to the clubs he
 * had been offered to and the seller had no way to manage or withdraw the
 * approach. What is added here is the two reads, the manage pair, and the terms
 * the approach is published with. The lifecycle is untouched: status still says
 * where an approach stands, an expiry is read from the clock rather than being
 * a sixth status, and the negotiation that answers an approach is the
 * TransferOffer chain that already existed.
 *
 * Held here: that the board can only ever be the caller's, that a club is never
 * shown its own player as an opportunity, that publishing twice does not
 * duplicate, that a published player is neither a listing nor an auction, and
 * that the browser sends the canonical UUID and reads one record per question.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const SVC = readFileSync(
  join(__dirname, '..', 'src', 'transfer-market', 'transfer-negotiation.service.ts'), 'utf8');
const ROUTES = readFileSync(
  join(__dirname, '..', 'src', 'routes', 'transfer-market.routes.ts'), 'utf8');
const CTRL = readFileSync(
  join(__dirname, '..', 'src', 'controllers', 'transfer-market.controller.ts'), 'utf8');
const SCHEMA = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');

function fnBody(src: string, name: string) {
  const at = src.search(new RegExp(`(export )?(async )?function ${name}\\s*\\(`));
  if (at < 0) return '';
  let i = src.indexOf('{', at), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) break;
  }
  return src.slice(i, j);
}

describe('the record the approach is published as', () => {
  it('carries the terms, all of them optional', () => {
    const model = SCHEMA.slice(SCHEMA.indexOf('model PlayerOfferToClub'));
    const body = model.slice(0, model.indexOf('}'));
    for (const f of ['minAcceptableEur BigInt?', 'allowNegotiation Boolean?',
                     'preferredDate    DateTime?', 'expiresAt        DateTime?']) {
      expect(body.replace(/\s+/g, ' ')).toContain(f.replace(/\s+/g, ' '));
    }
  });

  it('and a bid carries what rides with its fee, also optional', () => {
    const model = SCHEMA.slice(SCHEMA.indexOf('model TransferOffer'));
    const body = model.slice(0, model.indexOf('}')).replace(/\s+/g, ' ');
    expect(body).toContain('addOnsEur BigInt?');
    expect(body).toContain('sellOnPct Int?');
    expect(body).toContain('preferredDate DateTime?');
  });

  it('no existing column or status changed', () => {
    const model = SCHEMA.slice(SCHEMA.indexOf('model PlayerOfferToClub'));
    const body = model.slice(0, model.indexOf('}')).replace(/\s+/g, ' ');
    expect(body).toContain('status TransferInterestStatus @default(OPEN)');
    // the lifecycle enum gained nothing
    const en = SCHEMA.slice(SCHEMA.indexOf('enum TransferInterestStatus'));
    const vals = en.slice(0, en.indexOf('}'));
    expect(vals).not.toMatch(/EXPIRED|WITHDRAWN/);
  });
});

describe('the board is the caller\'s and only the caller\'s', () => {
  const read = fnBody(SVC, 'readOfferedToClubs');

  it('is scoped to the club it was asked by, inside the service', () => {
    expect(read).toContain('toClubId: actor.clubId');
  });

  it('and can never return a player the caller itself offered', () => {
    expect(read).toContain('fromClubId: { not: actor.clubId }');
  });

  it('drops an approach whose expiry has passed, without writing a status', () => {
    expect(read).toContain('notExpired()');
    expect(fnBody(SVC, 'notExpired')).toContain('expiresAt: { gt: new Date() }');
  });

  it('drops a player who no longer belongs to the club that offered him', () => {
    expect(read).toContain('o.clubId === i.fromClub.id');
  });

  it('reads the negotiation for its status rather than keeping a second copy', () => {
    // hydrateApproach takes an inline object type, so brace-matching from the
    // declaration lands in the parameter, not the body: read the declaration
    // through to the function that follows it instead.
    const at = SVC.indexOf('async function hydrateApproach');
    const h = SVC.slice(at, SVC.indexOf('export async function readOfferedToClubs', at));
    expect(h).toContain('prisma.transferOffer.findMany');
    expect(h).toContain('AGREEMENT_REACHED');
    expect(h).toContain('NEGOTIATING');
    expect(h).toContain('OFFER_RECEIVED');
    // a counter is itself PENDING, so an exchange is what makes it negotiating
    expect(h).toContain('parentOfferId');
  });
});

describe('publishing and managing', () => {
  it('refuses a player another club owns, on every write', () => {
    for (const f of ['offerPlayerToClubs', 'updateOfferToClubs', 'withdrawOfferToClubs']) {
      expect(fnBody(SVC, f)).toContain('belongs to another club');
    }
  });

  it('resolves "all eligible clubs" on the server, never from the request', () => {
    expect(fnBody(SVC, 'offerPlayerToClubs')).toContain('eligibleTargetClubs(actor.clubId)');
    expect(fnBody(SVC, 'eligibleTargetClubs')).toContain('id: { not: ownerClubId }');
  });

  it('does not approach the same club twice about the same player', () => {
    const body = fnBody(SVC, 'offerPlayerToClubs');
    expect(body).toContain('playerOfferToClub.findFirst');
    expect(body).toContain("status: { in: ['OPEN', 'INVITED'] }");
  });

  it('withdrawing closes the approaches and moves nobody', () => {
    const body = fnBody(SVC, 'withdrawOfferToClubs');
    expect(body).toContain("status: 'CLOSED'");
    expect(body).not.toContain('player.update');
    expect(body).not.toContain('teamId');
  });

  it('editing rewrites this club\'s approaches and creates none', () => {
    const body = fnBody(SVC, 'updateOfferToClubs');
    expect(body).toContain('updateMany');
    expect(body).toContain('fromClubId: actor.clubId');
    expect(body).not.toContain('.create(');
  });

  it('refuses an expiry in the past', () => {
    expect(fnBody(SVC, 'offerPlayerToClubs')).toContain('expiresAt must be in the future');
  });
});

describe('the routes are guarded like the actions beside them', () => {
  it('reads are open to the tier that may read the market; writes are trade actions', () => {
    expect(ROUTES).toMatch(/get\('\/offered-to-clubs',\s+ctrl\.readOfferedToClubs\)/);
    expect(ROUTES).toMatch(/patch\('\/offer-to-clubs\/:playerId',\s+tradeGuard/);
    expect(ROUTES).toMatch(/delete\('\/offer-to-clubs\/:playerId',\s+tradeGuard/);
  });

  it('every player-addressed handler validates the UUID first', () => {
    for (const f of ['readMyOfferForPlayer', 'updateOfferToClubs', 'withdrawOfferToClubs']) {
      const at = CTRL.indexOf(`export async function ${f}`);
      expect(CTRL.slice(at, at + 320)).toContain("requireUUID(req.params.playerId, 'playerId')");
    }
  });

  it('and the acting club always comes from the session', () => {
    for (const f of ['readOfferedToClubs', 'readMyOffersToClubs', 'updateOfferToClubs', 'withdrawOfferToClubs']) {
      const at = CTRL.indexOf(`export async function ${f}`);
      const fn = CTRL.slice(at, at + 320);
      expect(fn).toContain('actor(req)');
      expect(fn).not.toContain('req.body.clubId');
    }
  });
});

describe('the browser surface', () => {
  it('Market carries Offered to Clubs as a section of its one screen', () => {
    // The four boards became one screen, so this is a section of the market
    // rather than a page beside it — and the 'offered' key still resolves.
    expect(APP).toMatch(/\['offered',\s+'Offered to clubs'/);
    expect(APP).toMatch(/offered: 'offered'/);
    const m = fnBody(APP, '_tfMarketOneHtml');
    expect(m).toContain('_tfMkOffered()');
    expect(m).toContain("'Offered to your club'");
    expect(fnBody(APP, '_tfMkOffered')).toContain('_TF_O2C.board');
  });

  it('the board is drawn by the same card builders every other board card uses', () => {
    const card = fnBody(APP, '_tfO2CCardHtml');
    expect(card).toContain('_tfxIdentityHtml');
    expect(card).toContain('_tfxPriceHtml');
    expect(card).toContain('data-tf-o2c-offer');
    expect(card).toContain('data-tf-disc-open');
    expect(card).toContain('data-tf-short');
  });

  it('and never claims an empty board before the read has answered', () => {
    const b = fnBody(APP, '_tfOfferedBoardHtml');
    expect(b).toContain('if (b === null)');
    expect(b).toContain('tfx-c--skel');
  });

  it('the publish panel asks for every term the record stores', () => {
    const f = fnBody(APP, '_tfO2CFormHtml');
    for (const a of ['data-tf-o2c-ask', 'data-tf-o2c-min', 'data-tf-o2c-date',
                     'data-tf-o2c-expiry', 'data-tf-o2c-neg', 'data-tf-o2c-note']) {
      expect(f).toContain(a);
    }
  });

  it('publishing refuses an id that is still a squad label', () => {
    const at = APP.indexOf("data-tf-o2c-publish]'))");
    const h = APP.slice(at, APP.indexOf("data-tf-o2c-edit]'))", at));
    expect(h).toContain('_tfIsCanonicalId(op.id)');
    expect(h).toContain('_tfHasSession()');
  });

  it('the profile button says he is published, without a second store', () => {
    const b = fnBody(APP, '_tfSellButton');
    expect(b).toContain('_tfO2CPublished(player.id)');
    expect(b).toContain('Manage club offer');
    expect(fnBody(APP, '_tfO2CPublished')).toContain('_TF_O2C.byPlayer');
  });

  it('one club\'s approaches are dropped when the workspace changes club', () => {
    expect(fnBody(APP, '_thResetRoster')).toContain('_tfO2CForget');
  });

  it('MAKE OFFER opens the offer panel every other approach uses', () => {
    const at = APP.indexOf("data-tf-o2c-offer]'))");
    const h = APP.slice(at, at + 900);
    expect(h).toContain('_tfFormOpenOffer(');
    // not a second offer form
    expect(APP).not.toContain('_tfO2COfferFormHtml');
  });

  it('and the offer carries its extras through to the same endpoints', () => {
    expect(APP).toContain("_tfNegApi('POST', '/offers', Object.assign({ playerId: f.playerId, feeEur: fee }, xtra))");
    expect(APP).toContain("'/offers/' + f.offerId + '/counter', Object.assign({ feeEur: fee }, xtra)");
  });
});
