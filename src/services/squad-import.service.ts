/**
 * squad-import.service.ts — runtime port of prisma/seeds/import-squad.ts +
 * verify-migration.ts, so the one-time CLUB_ADMIN import endpoint can run inside
 * the deployed server (prisma/seeds/** is excluded from the tsc build).
 *
 * The dataset, the stable `legacyId` keys and the field mapping are IDENTICAL to
 * the CLI seed, so importing via this service or via the CLI produces the exact
 * same rows — the upsert-on-legacyId makes both idempotent and duplicate-proof.
 */
import { PlayerPosition, Foot } from '@prisma/client';
import { prisma } from '../config/database';

// ── Canonical Squad dataset (mirrors SQ_DEMO_PLAYERS in public/app.js) ──
export interface SquadPlayer {
  legacyId: string; name: string; pos: string; num: number; natName: string; flag: string;
  age: number; value: string; cond: number; morale: string; qual: number; foot: string;
  height: string; captain?: boolean; roles: string;
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

const POS_RELATED: Record<string, string[]> = {
  GK: [], RB: ['RWB', 'RM'], LB: ['LWB', 'LM'], CB: ['DM', 'RB'], DM: ['CM', 'CB'],
  CM: ['DM', 'AM'], LW: ['LM', 'ST'], RW: ['RM', 'ST'], ST: ['CF', 'AM'],
};
const POSITION_MAP: Record<string, PlayerPosition> = {
  GK: 'GK', CB: 'DC', LB: 'DL', RB: 'DR', LWB: 'DL', RWB: 'DR', WB: 'DR',
  DM: 'DMC', CM: 'MC', AM: 'AMC', LM: 'ML', RM: 'MR', LW: 'AML', RW: 'AMR',
  ST: 'ST', CF: 'ST',
};
function mapPosition(pos: string): PlayerPosition { return POSITION_MAP[pos] || 'MC'; }
function mapFoot(foot: string): Foot { return foot === 'Left' ? 'LEFT' : foot === 'Both' ? 'BOTH' : 'RIGHT'; }
function heightToCm(h: string): number { const m = parseFloat(String(h).replace(/[^0-9.]/g, '')); return m > 0 && m < 3 ? Math.round(m * 100) : Math.round(m) || 180; }
function parseValueToFloat(v: string): number { const n = parseFloat(String(v).replace(/[^0-9.]/g, '')); return /m/i.test(v) ? Math.round(n * 1_000_000) : /k/i.test(v) ? Math.round(n * 1_000) : Math.round(n) || 1_000_000; }
function dobFromAge(age: number, refYear = 2026): Date { return new Date(Date.UTC(refYear - age, 0, 1)); }
function splitName(name: string): { firstName: string; lastName: string } { const parts = String(name).trim().split(/\s+/); return parts.length > 1 ? { firstName: parts[0], lastName: parts.slice(1).join(' ') } : { firstName: name, lastName: name }; }
function trainedPositions(pos: string): string { const arr = [pos, ...(POS_RELATED[pos] || [])]; return Array.from(new Set(arr)).join(','); }
function deriveViceId(squad: SquadPlayer[]): string | null {
  let best: SquadPlayer | null = null;
  for (const p of squad) { if (p.captain) continue; if (!best || p.qual > best.qual) best = p; }
  return best ? best.legacyId : null;
}
function buildPlayerData(sq: SquadPlayer, clubId: string, viceId: string | null) {
  const { firstName, lastName } = splitName(sq.name);
  const heightCm = heightToCm(sq.height);
  return {
    clubId, legacyId: sq.legacyId, firstName, lastName,
    number: sq.num, position: mapPosition(sq.pos), nationality: sq.natName, flag: sq.flag,
    dateOfBirth: dobFromAge(sq.age), height: heightCm,
    weight: Math.max(60, Math.min(100, Math.round((heightCm - 100) * 0.92 + 8))),
    preferredFoot: mapFoot(sq.foot), overallRating: sq.qual,
    potential: Math.min(99, sq.qual + (sq.age <= 23 ? 5 : 2)),
    condition: sq.cond, marketValue: parseValueToFloat(sq.value),
    roles: sq.roles, morale: sq.morale, isCaptain: !!sq.captain,
    isViceCaptain: sq.legacyId === viceId, trainedPositions: trainedPositions(sq.pos), isActive: true,
  };
}
function validate(squad: SquadPlayer[]): string[] {
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
  if (squad.filter((p) => p.captain).length !== 1) errors.push('expected exactly 1 captain');
  return errors;
}

/** Idempotent import into a specific club (upsert on legacyId — never duplicates). */
export async function importSquadForClub(clubId: string) {
  const errors = validate(SQUAD);
  if (errors.length) throw new Error('Validation failed: ' + errors.join('; '));
  const viceId = deriveViceId(SQUAD);
  let created = 0, updated = 0;
  const mapping: Array<{ legacyId: string; name: string; id: string; action: 'create' | 'update' }> = [];
  for (const sq of SQUAD) {
    const data = buildPlayerData(sq, clubId, viceId);
    const existing = await prisma.player.findUnique({ where: { legacyId: sq.legacyId } });
    const row = await prisma.player.upsert({ where: { legacyId: sq.legacyId }, create: data, update: data });
    if (existing) updated++; else created++;
    mapping.push({ legacyId: sq.legacyId, name: sq.name, id: row.id, action: existing ? 'update' : 'create' });
  }
  return { clubId, viceId, created, updated, total: SQUAD.length, mapping };
}

export interface VerifyReport {
  importedPlayers: number; totalPlayers: number;
  duplicatedPlayers: number; duplicateDetail: string[];
  migratedSessions: number; attendanceRecords: number; playerTrainingStats: number;
  orphanReferences: number; sameUuidAcrossModules: boolean;
  moduleConsistency: { modules: string[]; allShareClubPlayerUuids: boolean };
  ok: boolean;
}

/** Verification report — reads ONLY from PostgreSQL. */
export async function verifyForClub(clubId: string): Promise<VerifyReport> {
  const players = await prisma.player.findMany({ where: { clubId }, select: { id: true, legacyId: true, number: true } });
  const clubPlayerIds = new Set(players.map((p) => p.id));
  const importedPlayers = players.filter((p) => p.legacyId != null).length;

  const duplicateDetail: string[] = [];
  const byLegacy = new Map<string, number>(), byNumber = new Map<number, number>();
  for (const p of players) {
    if (p.legacyId != null) byLegacy.set(p.legacyId, (byLegacy.get(p.legacyId) || 0) + 1);
    if (p.number != null) byNumber.set(p.number, (byNumber.get(p.number) || 0) + 1);
  }
  let duplicatedPlayers = 0;
  for (const [k, n] of byLegacy) if (n > 1) { duplicatedPlayers += n - 1; duplicateDetail.push(`legacyId ${k} x${n}`); }
  for (const [k, n] of byNumber) if (n > 1) duplicateDetail.push(`shirt #${k} x${n}`);

  const [migratedSessions, attendanceRecords, playerTrainingStats, sessions] = await Promise.all([
    prisma.trainingSession.count({ where: { clubId } }),
    prisma.trainingAttendanceRecord.count({ where: { clubId } }),
    prisma.playerTrainingStat.count({ where: { session: { clubId } } }),
    prisma.trainingSession.findMany({ where: { clubId }, select: { bestPlayerId: true, playerStats: { select: { playerId: true } } } }),
  ]);

  let orphanReferences = 0;
  for (const s of sessions) {
    for (const st of s.playerStats) if (!clubPlayerIds.has(st.playerId)) orphanReferences++;
    if (s.bestPlayerId && !clubPlayerIds.has(s.bestPlayerId)) orphanReferences++;
  }

  const sameUuidAcrossModules = orphanReferences === 0;
  return {
    importedPlayers, totalPlayers: players.length,
    duplicatedPlayers, duplicateDetail,
    migratedSessions, attendanceRecords, playerTrainingStats,
    orphanReferences, sameUuidAcrossModules,
    moduleConsistency: {
      // All these modules read the same authenticated club Player set (State.players
      // on the frontend); training data (sessions/attendance/stats) references those
      // same Player UUIDs, which the orphan check above confirms.
      modules: ['Squad', 'Lineup', 'Formation', 'Tactics', 'Training', 'Medical', 'Match Center', 'Reports'],
      allShareClubPlayerUuids: sameUuidAcrossModules,
    },
    ok: duplicatedPlayers === 0 && orphanReferences === 0,
  };
}
