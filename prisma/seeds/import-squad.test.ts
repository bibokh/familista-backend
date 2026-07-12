/* Standalone test for import-squad.ts — runs against an in-memory mock Prisma client (no DB).
 * Run: npx ts-node prisma/seeds/import-squad.test.ts
 */
import {
  SQUAD, importSquad, rollbackSquad, buildPlayerData, validate, deriveViceId,
  mapPosition, mapFoot, parseValueToFloat, heightToCm,
} from './import-squad';

let fails = 0;
function chk(name: string, cond: boolean) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) fails++; }

function mockDb() {
  const players = new Map<string, any>();
  let seq = 0;
  return {
    _players: players,
    club: {
      findFirst: async () => ({ id: 'club-1', name: 'FC Familista', createdAt: new Date() }),
      findUnique: async ({ where }: any) => ({ id: where.id }),
    },
    player: {
      findUnique: async ({ where }: any) => players.get(where.legacyId) || null,
      upsert: async ({ where, create, update }: any) => {
        const ex = players.get(where.legacyId);
        if (ex) { Object.assign(ex, update); return ex; }
        const row = { id: 'uuid-' + (++seq), ...create }; players.set(where.legacyId, row); return row;
      },
      count: async ({ where }: any) => [...players.values()].filter((p) => where.legacyId.in.includes(p.legacyId)).length,
      deleteMany: async ({ where }: any) => { let n = 0; for (const id of where.legacyId.in) if (players.delete(id)) n++; return { count: n }; },
    },
  };
}

(async () => {
  // pure helpers
  chk('mapPosition CB->DC, CM->MC, LW->AML, ST->ST', mapPosition('CB') === 'DC' && mapPosition('CM') === 'MC' && mapPosition('LW') === 'AML' && mapPosition('ST') === 'ST');
  chk('mapFoot Right/Left', mapFoot('Right') === 'RIGHT' && mapFoot('Left') === 'LEFT');
  chk('parseValueToFloat €28.0M -> 28000000', parseValueToFloat('€28.0M') === 28000000);
  chk('heightToCm 1.78m -> 178', heightToCm('1.78m') === 178);
  chk('validate passes for canonical squad', validate(SQUAD).length === 0);
  chk('validate catches two captains', validate(SQUAD.map((p, i) => i === 0 ? { ...p, captain: true } : p)).length > 0);

  const vice = deriveViceId(SQUAD);
  chk('vice-captain = Almeida (sq-12, highest non-captain)', vice === 'sq-12');

  // field mapping (Watanabe / captain)
  const kw = buildPlayerData(SQUAD.find((p) => p.legacyId === 'sq-8')!, 'club-1', vice);
  chk('Watanabe maps: names/position/foot/ovr/condition/roles/trainedPositions/value/captain', kw.firstName === 'Kenji' && kw.lastName === 'Watanabe' && kw.position === 'MC' && kw.preferredFoot === 'RIGHT' && kw.overallRating === 88 && kw.condition === 89 && kw.roles === 'BBM · CM' && kw.trainedPositions === 'CM,DM,AM' && kw.marketValue === 28000000 && kw.isCaptain === true && kw.isViceCaptain === false && kw.legacyId === 'sq-8' && kw.morale === 'Excellent');
  const va = buildPlayerData(SQUAD.find((p) => p.legacyId === 'sq-12')!, 'club-1', vice);
  chk('Almeida is vice-captain, not captain', va.isViceCaptain === true && va.isCaptain === false);

  // dry-run writes nothing
  const db = mockDb();
  const dr = await importSquad(db as any, { dryRun: true });
  chk('dry-run: 0 written, 16 in mapping', db._players.size === 0 && dr.mapping.length === 16 && dr.dryRun === true);

  // real import: 16 created
  const r1 = await importSquad(db as any, {});
  chk('import: 16 created, 0 updated, all mapped to ids', r1.created === 16 && r1.updated === 0 && db._players.size === 16 && r1.mapping.every((m) => /uuid-/.test(m.id)));

  // idempotent re-run: 0 created, 16 updated, no duplicates
  const r2 = await importSquad(db as any, {});
  chk('re-import idempotent: 0 created, 16 updated, still 16 rows', r2.created === 0 && r2.updated === 16 && db._players.size === 16);

  // exactly one captain, one vice in the DB
  const rows = [...db._players.values()];
  chk('exactly 1 captain + 1 vice-captain persisted', rows.filter((p) => p.isCaptain).length === 1 && rows.filter((p) => p.isViceCaptain).length === 1);

  // rollback removes all 16
  const rb = await rollbackSquad(db as any, {});
  chk('rollback: deletes 16, DB empty', rb.deleted === 16 && db._players.size === 0);

  console.log(fails === 0 ? '\nALL IMPORT-SQUAD TESTS PASSED' : '\n' + fails + ' FAILED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
