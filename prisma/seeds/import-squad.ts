/**
 * import-squad.ts — Idempotent import of the client-side Squad into the backend.
 *
 * Converts the 16 client-side Squad players (the ones the Training / Lineup /
 * Formation / Tactics UI shows) into real backend `Player` rows for a club,
 * preserving every field. Safe to run repeatedly (upsert on the stable
 * `legacyId`), supports `--dry-run`, validates its inputs, prints the
 * old-id -> new-UUID mapping, and can be reversed with `--rollback`.
 *
 * Usage (run from the repo root, with DATABASE_URL pointing at the target DB):
 *   npx ts-node prisma/seeds/import-squad.ts --club "FC Familista" --dry-run
 *   npx ts-node prisma/seeds/import-squad.ts --club "FC Familista"
 *   npx ts-node prisma/seeds/import-squad.ts --club "FC Familista" --rollback
 *   (or pass --club-id <uuid> instead of --club <name>)
 *
 * The pure helpers (SQUAD, buildPlayerData, mapPosition, …) are exported so the
 * mapping can be unit-tested without a database (see import-squad.test.ts).
 */
import { PrismaClient, Prisma, PlayerPosition, Foot } from '@prisma/client';

// ── Canonical Squad dataset (mirrors SQ_DEMO_PLAYERS in public/app.js) ──
export interface SquadPlayer {
  legacyId: string; name: string; pos: string; num: number; natName: string; flag: string;
  age: number; value: string; cond: number; morale: string; qual: number; foot: string;
  height: string; captain?: boolean;  roles: string;
}
export const SQUAD: SquadPlayer[] = [
  { legacyId: 'sq-1',  pos: 'GK', num: 1,  name: 'Diego Marán',     roles: 'SK · GK',  flag: '🇦🇷', natName: 'Argentina',    age: 30, value: '€7.4M',  cond: 94, morale: 'Good',      qual: 84, foot: 'Right', height: '1.91m' },
  { legacyId: 'sq-2',  pos: 'GK', num: 13, name: 'Lukas Brenner',   roles: 'GK',       flag: '🇩🇪', natName: 'Germany',      age: 24, value: '€3.1M',  cond: 97, morale: 'Content',   qual: 78, foot: 'Right', height: '1.93m' },
  { legacyId: 'sq-3',  pos: 'RB', num: 2,  name: 'Tomás Oliveira',  roles: 'FB · WB',  flag: '🇵🇹', natName: 'Portugal',     age: 27, value: '€12.0M', cond: 88, morale: 'Good',      qual: 82, foot: 'Right', height: '1.79m' },
  { legacyId: 'sq-4',  pos: 'CB', num: 4,  name: 'Marco Vidalli',   roles: 'CD · BPD', flag: '🇮🇹', natName: 'Italy',        age: 29, value: '€18.5M', cond: 90, morale: 'Excellent', qual: 86, foot: 'Right', height: '1.88m' },
  { legacyId: 'sq-5',  pos: 'CB', num: 5,  name: 'Idris Bah',       roles: 'CD · NCB', flag: '🇸🇳', natName: 'Senegal',      age: 25, value: '€21.0M', cond: 85, morale: 'Good',      qual: 85, foot: 'Left',  height: '1.90m' },
  { legacyId: 'sq-6',  pos: 'LB', num: 3,  name: 'Yann Lefevre',    roles: 'FB · IWB', flag: '🇫🇷', natName: 'France',       age: 23, value: '€14.2M', cond: 91, morale: 'Good',      qual: 81, foot: 'Left',  height: '1.81m' },
  { legacyId: 'sq-7',  pos: 'DM', num: 6,  name: 'Sergio Bautista', roles: 'DLP · A',  flag: '🇪🇸', natName: 'Spain',        age: 28, value: '€22.5M', cond: 87, morale: 'Excellent', qual: 86, foot: 'Right', height: '1.83m' },
  { legacyId: 'sq-8',  pos: 'CM', num: 8,  name: 'Kenji Watanabe',  roles: 'BBM · CM', flag: '🇯🇵', natName: 'Japan',        age: 26, value: '€28.0M', cond: 89, morale: 'Excellent', qual: 88, foot: 'Right', height: '1.78m', captain: true },
  { legacyId: 'sq-9',  pos: 'CM', num: 10, name: 'Rafael Pinto',    roles: 'AP · MEZ', flag: '🇧🇷', natName: 'Brazil',       age: 24, value: '€34.0M', cond: 84, morale: 'Good',      qual: 87, foot: 'Left',  height: '1.75m' },
  { legacyId: 'sq-10', pos: 'LW', num: 11, name: 'Amir Haddad',     roles: 'IW · W',   flag: '🇲🇦', natName: 'Morocco',      age: 22, value: '€26.5M', cond: 92, morale: 'Good',      qual: 84, foot: 'Right', height: '1.74m' },
  { legacyId: 'sq-11', pos: 'RW', num: 7,  name: 'Niklas Sorensen', roles: 'W · IF',   flag: '🇩🇰', natName: 'Denmark',      age: 25, value: '€24.0M', cond: 86, morale: 'Content',   qual: 83, foot: 'Left',  height: '1.80m' },
  { legacyId: 'sq-12', pos: 'ST', num: 9,  name: 'Viktor Almeida',  roles: 'AF · PF',  flag: '🇧🇷', natName: 'Brazil',       age: 27, value: '€41.0M', cond: 88, morale: 'Excellent', qual: 89, foot: 'Right', height: '1.86m' },
  { legacyId: 'sq-13', pos: 'ST', num: 19, name: 'Owen Carter',     roles: 'PF · TF',  flag: '🇬🇧', natName: 'England',      age: 21, value: '€19.0M', cond: 95, morale: 'Good',      qual: 80, foot: 'Right', height: '1.89m' },
  { legacyId: 'sq-14', pos: 'CM', num: 14, name: 'Dragan Petrov',   roles: 'CM · B2B', flag: '🇷🇸', natName: 'Serbia',       age: 30, value: '€9.5M',  cond: 83, morale: 'Content',   qual: 79, foot: 'Right', height: '1.84m' },
  { legacyId: 'sq-15', pos: 'RB', num: 22, name: 'Leon Mbeki',      roles: 'WB · FB',  flag: '🇿🇦', natName: 'South Africa', age: 20, value: '€8.0M',  cond: 96, morale: 'Good',      qual: 76, foot: 'Right', height: '1.77m' },
  { legacyId: 'sq-16', pos: 'CB', num: 15, name: 'Janne Korhonen',  roles: 'CD',       flag: '🇫🇮', natName: 'Finland',      age: 28, value: '€6.5M',  cond: 90, morale: 'Content',   qual: 77, foot: 'Left',  height: '1.92m' },
];

// Allowed / trained positions per primary position (mirrors POS_RELATED in app.js).
const POS_RELATED: Record<string, string[]> = {
  GK: [], RB: ['RWB', 'RM'], LB: ['LWB', 'LM'], CB: ['DM', 'RB'], DM: ['CM', 'CB'],
  CM: ['DM', 'AM'], LW: ['LM', 'ST'], RW: ['RM', 'ST'], ST: ['CF', 'AM'],
};

// Squad position code -> backend PlayerPosition enum.
const POSITION_MAP: Record<string, PlayerPosition> = {
  GK: 'GK', CB: 'DC', LB: 'DL', RB: 'DR', LWB: 'DL', RWB: 'DR', WB: 'DR',
  DM: 'DMC', CM: 'MC', AM: 'AMC', LM: 'ML', RM: 'MR', LW: 'AML', RW: 'AMR',
  ST: 'ST', CF: 'ST',
};

export function mapPosition(pos: string): PlayerPosition { return POSITION_MAP[pos] || 'MC'; }
export function mapFoot(foot: string): Foot { return foot === 'Left' ? 'LEFT' : foot === 'Both' ? 'BOTH' : 'RIGHT'; }
export function heightToCm(h: string): number { const m = parseFloat(String(h).replace(/[^0-9.]/g, '')); return m > 0 && m < 3 ? Math.round(m * 100) : Math.round(m) || 180; }
export function parseValueToFloat(v: string): number { const n = parseFloat(String(v).replace(/[^0-9.]/g, '')); return /m/i.test(v) ? Math.round(n * 1_000_000) : /k/i.test(v) ? Math.round(n * 1_000) : Math.round(n) || 1_000_000; }
export function dobFromAge(age: number, refYear = 2026): Date { return new Date(Date.UTC(refYear - age, 0, 1)); }
export function splitName(name: string): { firstName: string; lastName: string } { const parts = String(name).trim().split(/\s+/); return parts.length > 1 ? { firstName: parts[0], lastName: parts.slice(1).join(' ') } : { firstName: name, lastName: name }; }
export function trainedPositions(pos: string): string { const arr = [pos, ...(POS_RELATED[pos] || [])]; return Array.from(new Set(arr)).join(','); }
// Vice-captain = highest-quality non-captain (mirrors the Squad/Formation derivation).
export function deriveViceId(squad: SquadPlayer[]): string | null {
  let best: SquadPlayer | null = null;
  for (const p of squad) { if (p.captain) continue; if (!best || p.qual > best.qual) best = p; }
  return best ? best.legacyId : null;
}

/** Pure mapping: SquadPlayer -> the data used for Prisma create/update. No DB, no side effects. */
export function buildPlayerData(sq: SquadPlayer, clubId: string, viceId: string | null) {
  const { firstName, lastName } = splitName(sq.name);
  const heightCm = heightToCm(sq.height);
  return {
    clubId,
    legacyId: sq.legacyId,
    firstName, lastName,
    number: sq.num,
    position: mapPosition(sq.pos),
    nationality: sq.natName,
    flag: sq.flag,
    dateOfBirth: dobFromAge(sq.age),
    height: heightCm,
    weight: Math.max(60, Math.min(100, Math.round((heightCm - 100) * 0.92 + 8))),
    preferredFoot: mapFoot(sq.foot),
    overallRating: sq.qual,
    potential: Math.min(99, sq.qual + (sq.age <= 23 ? 5 : 2)),
    condition: sq.cond,
    marketValue: parseValueToFloat(sq.value),
    roles: sq.roles,
    morale: sq.morale,
    isCaptain: !!sq.captain,
    isViceCaptain: sq.legacyId === viceId,
    trainedPositions: trainedPositions(sq.pos),
    isActive: true,
  };
}

export function validate(squad: SquadPlayer[]): string[] {
  const errors: string[] = [];
  const seenLegacy = new Set<string>(), seenNum = new Set<number>();
  for (const p of squad) {
    if (!p.legacyId) errors.push(`player "${p.name}" has no legacyId`);
    if (seenLegacy.has(p.legacyId)) errors.push(`duplicate legacyId ${p.legacyId}`);
    seenLegacy.add(p.legacyId);
    if (seenNum.has(p.num)) errors.push(`duplicate shirt number ${p.num} (${p.name})`);
    seenNum.add(p.num);
    if (!POSITION_MAP[p.pos]) errors.push(`unknown position "${p.pos}" for ${p.name}`);
    if (!(p.qual >= 40 && p.qual <= 99)) errors.push(`quality out of range for ${p.name}`);
  }
  const caps = squad.filter((p) => p.captain);
  if (caps.length !== 1) errors.push(`expected exactly 1 captain, found ${caps.length}`);
  return errors;
}

// ── DB operations (accept any Prisma-shaped client so tests can inject a mock) ──
type Db = { player: any; club: any };

async function resolveClubId(prisma: Db, opts: { clubId?: string; clubName?: string }): Promise<string> {
  if (opts.clubId) { const c = await prisma.club.findUnique({ where: { id: opts.clubId } }); if (!c) throw new Error(`Club id ${opts.clubId} not found`); return c.id; }
  if (opts.clubName) { const c = await prisma.club.findFirst({ where: { name: opts.clubName } }); if (!c) throw new Error(`Club "${opts.clubName}" not found`); return c.id; }
  const first = await prisma.club.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!first) throw new Error('No club found — pass --club "<name>" or --club-id <uuid>');
  return first.id;
}

export async function importSquad(prisma: Db, opts: { clubId?: string; clubName?: string; dryRun?: boolean; squad?: SquadPlayer[] } = {}) {
  const squad = opts.squad || SQUAD;
  const errors = validate(squad);
  if (errors.length) throw new Error('Validation failed:\n  - ' + errors.join('\n  - '));
  const clubId = await resolveClubId(prisma, opts);
  const viceId = deriveViceId(squad);
  const mapping: Array<{ legacyId: string; name: string; id: string; action: 'create' | 'update' | 'dry' }> = [];
  let created = 0, updated = 0;
  for (const sq of squad) {
    const data = buildPlayerData(sq, clubId, viceId);
    const existing = await prisma.player.findUnique({ where: { legacyId: sq.legacyId } });
    if (opts.dryRun) { mapping.push({ legacyId: sq.legacyId, name: sq.name, id: existing?.id || '(new)', action: 'dry' }); continue; }
    const row = await prisma.player.upsert({ where: { legacyId: sq.legacyId }, create: data, update: data });
    if (existing) updated++; else created++;
    mapping.push({ legacyId: sq.legacyId, name: sq.name, id: row.id, action: existing ? 'update' : 'create' });
  }
  return { clubId, viceId, created, updated, total: squad.length, dryRun: !!opts.dryRun, mapping };
}

export async function rollbackSquad(prisma: Db, opts: { squad?: SquadPlayer[]; dryRun?: boolean } = {}) {
  const squad = opts.squad || SQUAD;
  const ids = squad.map((p) => p.legacyId);
  if (opts.dryRun) { const n = await prisma.player.count({ where: { legacyId: { in: ids } } }); return { deleted: 0, wouldDelete: n, dryRun: true }; }
  const res = await prisma.player.deleteMany({ where: { legacyId: { in: ids } } });
  return { deleted: res.count, dryRun: false };
}

// ── CLI ──
async function main() {
  const args = process.argv.slice(2);
  const has = (f: string) => args.includes(f);
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const opts = { dryRun: has('--dry-run'), clubName: val('--club'), clubId: val('--club-id') };
  const prisma = new PrismaClient();
  try {
    if (has('--rollback')) {
      const r = await rollbackSquad(prisma, { dryRun: opts.dryRun });
      console.log(opts.dryRun ? `[dry-run] would delete ${r.wouldDelete} imported player(s)` : `Rolled back: deleted ${r.deleted} player(s)`);
    } else {
      const r = await importSquad(prisma, opts);
      console.log(`Club: ${r.clubId}`);
      console.log(opts.dryRun ? `[dry-run] would import ${r.total} players (no writes performed)` : `Imported: ${r.created} created, ${r.updated} updated (${r.total} total). Vice-captain: ${r.viceId}`);
      console.log('legacyId -> Player UUID:');
      for (const m of r.mapping) console.log(`  ${m.legacyId.padEnd(6)} ${m.name.padEnd(18)} -> ${m.id}`);
    }
  } catch (e) { console.error('IMPORT FAILED:', (e as Error).message); process.exitCode = 1; }
  finally { await (prisma as any).$disconnect?.(); }
}
if (require.main === module) main();
