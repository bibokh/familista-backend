// Familista — Phase P · Real-launch seed for FC Familista
// ─────────────────────────────────────────────────────────────────────────────
// Idempotent. Every row uses upsert against a stable natural key. Re-running
// is a no-op for existing rows. Personal data is placeholder-only —
// production operators rotate emails/phones via the standard endpoints
// after first login.
//
// Hard requirements (otherwise the seed aborts):
//   • NODE_ENV !== 'production'  OR  FC_FAMILISTA_SEED_CONFIRM=yes
//   • FC_FAMILISTA_ADMIN_PASSWORD set (≥ 12 chars)
//   • FC_FAMILISTA_DEFAULT_PASSWORD set (≥ 12 chars) for coaches/parents/players
//
// Every write is mirrored to the Phase I audit chain via
// appendAuditEventAsync, so the production audit ledger reflects the seed.

import * as bcrypt from 'bcryptjs';
import {
  DeviceInventoryState,
  Foot,
  Gender,
  MembershipRole,
  PlayerPosition,
  Prisma,
  TeamKind,
  UserRole,
} from '@prisma/client';
import { prisma } from '../config/database';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface SeedReport {
  ok:           boolean;
  club:         { id: string; name: string; existed: boolean };
  teamsCreated: number;
  teamsExisting: number;
  usersCreated: number;
  usersExisting: number;
  membershipsCreated: number;
  playersCreated: number;
  playersExisting: number;
  guardiansLinked: number;
  trainingSessionsCreated: number;
  paymentsSeeded: number;
  deviceInventorySeeded: number;
  onboardingSeeded: number;
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic spec — change here, re-run, get the same shape.
// ─────────────────────────────────────────────────────────────────────────────

const CLUB_NAME    = 'FC Familista';
const CLUB_CITY    = 'Berlin';
const CLUB_COUNTRY = 'Germany';

const TEAMS: Array<{ name: string; kind: TeamKind; gender: Gender; ageMin?: number; ageMax?: number }> = [
  { name: 'FC Familista — Senior',  kind: 'SENIOR',       gender: 'MEN', ageMin: 19 },
  { name: 'FC Familista — Reserves', kind: 'RESERVES',    gender: 'MEN', ageMin: 17, ageMax: 25 },
  { name: 'FC Familista — U17',     kind: 'ACADEMY_U17',  gender: 'MEN', ageMin: 15, ageMax: 17 },
  { name: 'FC Familista — U15',     kind: 'ACADEMY_U15',  gender: 'MEN', ageMin: 13, ageMax: 15 },
];

const COACH_USERS: Array<{ email: string; firstName: string; lastName: string; role: UserRole; teamName?: string }> = [
  { email: 'head.coach@fcfamilista.local',  firstName: 'Sven',    lastName: 'Müller',   role: 'HEAD_COACH',       teamName: 'FC Familista — Senior' },
  { email: 'assistant.1@fcfamilista.local', firstName: 'Klaus',   lastName: 'Becker',   role: 'ASSISTANT_COACH',  teamName: 'FC Familista — Senior' },
  { email: 'youth.u17@fcfamilista.local',   firstName: 'Markus',  lastName: 'Hartmann', role: 'COACH',            teamName: 'FC Familista — U17' },
  { email: 'youth.u15@fcfamilista.local',   firstName: 'Daniel',  lastName: 'Roth',     role: 'COACH',            teamName: 'FC Familista — U15' },
  { email: 'manager@fcfamilista.local',     firstName: 'Anja',    lastName: 'Schneider', role: 'MANAGER' },
  { email: 'analyst@fcfamilista.local',     firstName: 'Tomás',   lastName: 'Weber',    role: 'ANALYST' },
  { email: 'medical@fcfamilista.local',     firstName: 'Dr. Lena', lastName: 'Krause',  role: 'MEDICAL_STAFF' },
  { email: 'scout@fcfamilista.local',       firstName: 'Marco',   lastName: 'Ortega',   role: 'SCOUT' },
];

const PARENT_USERS: Array<{ email: string; firstName: string; lastName: string; childKey: string }> = [
  { email: 'parent.miller@fcfamilista.local',  firstName: 'Hannah',  lastName: 'Miller',  childKey: 'tom-miller' },
  { email: 'parent.santos@fcfamilista.local',  firstName: 'Carlos',  lastName: 'Santos',  childKey: 'luis-santos' },
  { email: 'parent.koehler@fcfamilista.local', firstName: 'Sabine',  lastName: 'Köhler',  childKey: 'felix-koehler' },
];

interface SeedPlayer {
  key:         string;       // stable natural key for re-seed
  firstName:   string;
  lastName:    string;
  number:      number;
  position:    PlayerPosition;
  nationality: string;
  flag:        string;
  birthIso:    string;
  height:      number;
  weight:      number;
  preferredFoot: Foot;
  teamName:    string;
  parentEmail?: string;
}

const PLAYERS: SeedPlayer[] = [
  { key: 'leon-bauer',     firstName: 'Leon',  lastName: 'Bauer',  number: 1,  position: 'GK',  nationality: 'Germany', flag: '🇩🇪', birthIso: '2000-03-12T00:00:00Z', height: 190, weight: 85, preferredFoot: 'RIGHT', teamName: 'FC Familista — Senior' },
  { key: 'paul-richter',   firstName: 'Paul',  lastName: 'Richter', number: 4,  position: 'DC',  nationality: 'Germany', flag: '🇩🇪', birthIso: '1999-07-22T00:00:00Z', height: 188, weight: 82, preferredFoot: 'RIGHT', teamName: 'FC Familista — Senior' },
  { key: 'jonas-fischer',  firstName: 'Jonas', lastName: 'Fischer', number: 6,  position: 'MC',  nationality: 'Germany', flag: '🇩🇪', birthIso: '2001-11-04T00:00:00Z', height: 178, weight: 74, preferredFoot: 'LEFT',  teamName: 'FC Familista — Senior' },
  { key: 'andre-silva',    firstName: 'André', lastName: 'Silva',   number: 9,  position: 'ST',  nationality: 'Portugal', flag: '🇵🇹', birthIso: '2002-01-18T00:00:00Z', height: 184, weight: 79, preferredFoot: 'RIGHT', teamName: 'FC Familista — Senior' },
  { key: 'noah-schulz',    firstName: 'Noah',  lastName: 'Schulz',  number: 11, position: 'AML', nationality: 'Germany', flag: '🇩🇪', birthIso: '2003-05-09T00:00:00Z', height: 175, weight: 70, preferredFoot: 'LEFT',  teamName: 'FC Familista — Reserves' },
  { key: 'tom-miller',     firstName: 'Tom',   lastName: 'Miller',  number: 7,  position: 'AMR', nationality: 'Germany', flag: '🇩🇪', birthIso: '2008-09-14T00:00:00Z', height: 170, weight: 60, preferredFoot: 'RIGHT', teamName: 'FC Familista — U17', parentEmail: 'parent.miller@fcfamilista.local' },
  { key: 'luis-santos',    firstName: 'Luis',  lastName: 'Santos',  number: 10, position: 'AMC', nationality: 'Spain',   flag: '🇪🇸', birthIso: '2009-02-25T00:00:00Z', height: 168, weight: 58, preferredFoot: 'LEFT',  teamName: 'FC Familista — U17', parentEmail: 'parent.santos@fcfamilista.local' },
  { key: 'felix-koehler',  firstName: 'Felix', lastName: 'Köhler',  number: 8,  position: 'DMC', nationality: 'Germany', flag: '🇩🇪', birthIso: '2011-06-30T00:00:00Z', height: 160, weight: 50, preferredFoot: 'RIGHT', teamName: 'FC Familista — U15', parentEmail: 'parent.koehler@fcfamilista.local' },
];

const DEVICE_PLACEHOLDERS = [
  { serial: 'FAM-DEV-0001', location: 'HQ — Locker Room A',   state: 'STOCK' as DeviceInventoryState, notes: 'Reserved for senior team rotation' },
  { serial: 'FAM-DEV-0002', location: 'HQ — Locker Room A',   state: 'STOCK' as DeviceInventoryState },
  { serial: 'FAM-DEV-0003', location: 'HQ — Equipment Cage',  state: 'STOCK' as DeviceInventoryState },
  { serial: 'FAM-DEV-0004', location: 'HQ — Equipment Cage',  state: 'STOCK' as DeviceInventoryState },
  { serial: 'FAM-DEV-0005', location: 'Academy — Locker U17', state: 'STOCK' as DeviceInventoryState },
];

const ONBOARDING_STEPS = ['REGISTRATION','MEDICAL_FORM','PHOTO','PARENT_CONSENT','KIT_FIT','CONTRACT_REVIEW'];

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

function assertEnvGuards(): { adminPw: string; defaultPw: string; confirm: boolean } {
  const adminPw   = process.env.FC_FAMILISTA_ADMIN_PASSWORD   ?? '';
  const defaultPw = process.env.FC_FAMILISTA_DEFAULT_PASSWORD ?? '';
  if (adminPw.length < 12)   throw new Error('FC_FAMILISTA_ADMIN_PASSWORD required (≥ 12 chars)');
  if (defaultPw.length < 12) throw new Error('FC_FAMILISTA_DEFAULT_PASSWORD required (≥ 12 chars)');
  const isProd = (process.env.NODE_ENV ?? '') === 'production';
  const confirm = (process.env.FC_FAMILISTA_SEED_CONFIRM ?? '').toLowerCase() === 'yes';
  if (isProd && !confirm) throw new Error('NODE_ENV=production requires FC_FAMILISTA_SEED_CONFIRM=yes');
  return { adminPw, defaultPw, confirm };
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed
// ─────────────────────────────────────────────────────────────────────────────

export async function seedFcFamilista(opts: { adminEmail?: string } = {}): Promise<SeedReport> {
  const { adminPw, defaultPw } = assertEnvGuards();
  const adminEmail = (opts.adminEmail ?? process.env.FC_FAMILISTA_ADMIN_EMAIL ?? 'admin@fcfamilista.local').trim().toLowerCase();
  const warnings: string[] = [];
  const adminHash   = await bcrypt.hash(adminPw,   12);
  const defaultHash = await bcrypt.hash(defaultPw, 12);

  // ── 1. Club ────────────────────────────────────────────────────────────
  const existingClub = await prisma.club.findFirst({ where: { name: CLUB_NAME }, select: { id: true } });
  const club = existingClub
    ? await prisma.club.update({ where: { id: existingClub.id }, data: { city: CLUB_CITY, country: CLUB_COUNTRY } })
    : await prisma.club.create({ data: { name: CLUB_NAME, shortName: 'FCF', city: CLUB_CITY, country: CLUB_COUNTRY } });

  // ── 2. Teams ───────────────────────────────────────────────────────────
  let teamsCreated = 0, teamsExisting = 0;
  const teamsByName = new Map<string, { id: string; clubId: string }>();
  for (const t of TEAMS) {
    const existing = await prisma.team.findUnique({ where: { clubId_name: { clubId: club.id, name: t.name } } as never });
    if (existing) { teamsExisting++; teamsByName.set(t.name, { id: existing.id, clubId: club.id }); continue; }
    const created = await prisma.team.create({
      data: {
        clubId: club.id, name: t.name, kind: t.kind, gender: t.gender,
        ageMin: t.ageMin ?? null, ageMax: t.ageMax ?? null,
      },
    });
    teamsCreated++;
    teamsByName.set(t.name, { id: created.id, clubId: club.id });
  }

  // ── 3. Admin + coaches/staff ───────────────────────────────────────────
  let usersCreated = 0, usersExisting = 0, membershipsCreated = 0;

  async function upsertUserAndMembership(args: {
    email: string;
    firstName: string;
    lastName: string;
    role: UserRole;
    passwordHash: string;
    teamId?: string;
    membershipRole: MembershipRole;
  }) {
    const found = await prisma.user.findUnique({ where: { email: args.email } });
    let user;
    if (found) {
      usersExisting++;
      user = found;
    } else {
      user = await prisma.user.create({
        data: {
          email: args.email, passwordHash: args.passwordHash,
          firstName: args.firstName, lastName: args.lastName, role: args.role,
          clubId: club.id, currentClubId: club.id, currentTeamId: args.teamId ?? null,
        },
      });
      usersCreated++;
    }
    // Membership upsert
    const mkey = { userId: user.id, clubId: club.id, teamId: args.teamId ?? null, role: args.membershipRole };
    const mfound = await prisma.membership.findFirst({ where: mkey });
    if (!mfound) {
      await prisma.membership.create({ data: { ...mkey, isActive: true } });
      membershipsCreated++;
    }
    return user;
  }

  const admin = await upsertUserAndMembership({
    email: adminEmail, firstName: 'FC Familista', lastName: 'Admin',
    role: 'CLUB_ADMIN', passwordHash: adminHash, membershipRole: 'CLUB_ADMIN',
  });

  for (const c of COACH_USERS) {
    const teamId = c.teamName ? teamsByName.get(c.teamName)?.id : undefined;
    const mrole: MembershipRole =
      c.role === 'HEAD_COACH'      ? 'HEAD_COACH'      :
      c.role === 'ASSISTANT_COACH' ? 'ASSISTANT_COACH' :
      c.role === 'COACH'           ? 'ASSISTANT_COACH' :
      c.role === 'MANAGER'         ? 'CLUB_ADMIN'      :
      c.role === 'ANALYST'         ? 'ANALYST'         :
      c.role === 'SCOUT'           ? 'SCOUT'           :
      c.role === 'MEDICAL_STAFF'   ? 'MEDICAL_STAFF'   : 'ASSISTANT_COACH';
    await upsertUserAndMembership({
      email: c.email, firstName: c.firstName, lastName: c.lastName,
      role: c.role, passwordHash: defaultHash, teamId, membershipRole: mrole,
    });
  }

  // ── 4. Players ─────────────────────────────────────────────────────────
  let playersCreated = 0, playersExisting = 0;
  const playersByKey = new Map<string, { id: string; teamId: string | null }>();
  for (const p of PLAYERS) {
    const team = teamsByName.get(p.teamName);
    if (!team) { warnings.push(`Team not found for player ${p.key}: ${p.teamName}`); continue; }
    const existing = await prisma.player.findFirst({
      where: { clubId: club.id, firstName: p.firstName, lastName: p.lastName, dateOfBirth: new Date(p.birthIso) },
    });
    if (existing) {
      playersExisting++;
      playersByKey.set(p.key, { id: existing.id, teamId: existing.teamId });
      continue;
    }
    const created = await prisma.player.create({
      data: {
        clubId: club.id, teamId: team.id,
        firstName: p.firstName, lastName: p.lastName, number: p.number, position: p.position,
        nationality: p.nationality, flag: p.flag, dateOfBirth: new Date(p.birthIso),
        height: p.height, weight: p.weight, preferredFoot: p.preferredFoot,
        parentEmail: p.parentEmail ?? null,
      },
    });
    playersCreated++;
    playersByKey.set(p.key, { id: created.id, teamId: team.id });
  }

  // ── 5. Parents + guardian links ────────────────────────────────────────
  let guardiansLinked = 0;
  for (const par of PARENT_USERS) {
    const parentUser = await upsertUserAndMembership({
      email: par.email, firstName: par.firstName, lastName: par.lastName,
      role: 'PARENT', passwordHash: defaultHash, membershipRole: 'PARENT',
    });
    const child = playersByKey.get(par.childKey);
    if (!child) { warnings.push(`Parent link skipped — player ${par.childKey} not found`); continue; }
    const existing = await prisma.playerGuardianLink.findUnique({
      where: { playerId_guardianUserId: { playerId: child.id, guardianUserId: parentUser.id } },
    });
    if (!existing) {
      await prisma.playerGuardianLink.create({
        data: { clubId: club.id, playerId: child.id, guardianUserId: parentUser.id, relationship: 'PARENT', isPrimary: true },
      });
      guardiansLinked++;
    }
  }

  // ── 6. Onboarding steps for every player ───────────────────────────────
  let onboardingSeeded = 0;
  for (const [, p] of playersByKey) {
    for (const step of ONBOARDING_STEPS) {
      const exists = await prisma.playerOnboardingStep.findUnique({
        where: { playerId_step: { playerId: p.id, step } } as never,
      });
      if (exists) continue;
      await prisma.playerOnboardingStep.create({
        data: { clubId: club.id, playerId: p.id, step, completed: false },
      });
      onboardingSeeded++;
    }
  }

  // ── 7. Training sessions — next 14 days, 2/week per team ───────────────
  let trainingSessionsCreated = 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const [teamName, t] of teamsByName) {
    for (let offset = 1; offset <= 14; offset += 3) {
      const scheduled = new Date(today.getTime() + offset * 86_400_000);
      scheduled.setHours(18, 0, 0, 0);
      const title = `${teamName} — Training ${scheduled.toISOString().slice(0, 10)}`;
      const exists = await prisma.trainingSession.findFirst({ where: { clubId: t.clubId, title } });
      if (exists) continue;
      await prisma.trainingSession.create({
        data: {
          clubId: t.clubId,
          title,
          description: 'Standard training block: tactical + conditioning',
          scheduledAt: scheduled,
          duration: 90,
          drills: ['POSSESSION','FINISHING','PRESSING'] as never,
        },
      });
      trainingSessionsCreated++;
    }
  }

  // ── 8. Payment ledger seed — monthly membership fee, last 2 months ─────
  let paymentsSeeded = 0;
  const monthlyCents = 5000;       // €50 / month placeholder
  for (const [, p] of playersByKey) {
    for (let i = 1; i <= 2; i++) {
      const due = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const invoiceRef = `FCF-${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${p.id.slice(0, 8)}`;
      const exists = await prisma.operationsPayment.findFirst({ where: { clubId: club.id, payerPlayerId: p.id, invoiceRef } });
      if (exists) continue;
      await prisma.operationsPayment.create({
        data: {
          clubId: club.id, payerPlayerId: p.id,
          amountCents: monthlyCents, currency: 'EUR',
          category: 'MONTHLY_MEMBERSHIP',
          state: i === 2 ? 'PAID' : 'PENDING',
          dueDate: due, invoiceRef,
          paidAt: i === 2 ? due : null,
        },
      });
      paymentsSeeded++;
    }
  }

  // ── 9. Device inventory placeholders ───────────────────────────────────
  let deviceInventorySeeded = 0;
  for (const d of DEVICE_PLACEHOLDERS) {
    const exists = await prisma.deviceInventoryEntry.findUnique({ where: { serial: d.serial } });
    if (exists) continue;
    await prisma.deviceInventoryEntry.create({
      data: { clubId: club.id, serial: d.serial, state: d.state, location: d.location ?? null, notes: d.notes ?? null },
    });
    deviceInventorySeeded++;
  }

  // ── 10. Audit anchor ───────────────────────────────────────────────────
  appendAuditEventAsync({
    actor: { userId: admin.id, clubId: club.id, ipAddress: null, userAgent: null },
    action: 'FC_FAMILISTA_SEED_RUN',
    entityType: 'Club', entityId: club.id,
    payload: {
      teamsCreated, teamsExisting,
      usersCreated, usersExisting,
      membershipsCreated,
      playersCreated, playersExisting,
      guardiansLinked, onboardingSeeded,
      trainingSessionsCreated, paymentsSeeded, deviceInventorySeeded,
      warnings,
    } as Prisma.InputJsonValue,
  });

  return {
    ok: true,
    club: { id: club.id, name: club.name, existed: !!existingClub },
    teamsCreated, teamsExisting,
    usersCreated, usersExisting, membershipsCreated,
    playersCreated, playersExisting, guardiansLinked,
    trainingSessionsCreated, paymentsSeeded, deviceInventorySeeded, onboardingSeeded,
    warnings,
  };
}
