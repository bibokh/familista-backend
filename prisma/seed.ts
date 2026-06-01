import { PrismaClient, UserRole, PlayerPosition, Foot, CompetitionType, MatchResult, InjurySeverity, DrillType, TransactionType, SubscriptionPlan, SubscriptionStatus, ScoutRecommendation, TeamKind, Gender, MembershipRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Familista database...');

  // ── Club ──────────────────────────────────────────────────
  const club = await prisma.club.upsert({
    where: { id: 'fam-hsr-berlin-001' },
    update: {},
    create: {
      id:             'fam-hsr-berlin-001',
      name:           'Familista HSR',
      shortName:      'FHSR',
      emblem:         '🔴',
      city:           'Berlin',
      country:        'Germany',
      founded:        new Date('2023-10-15'),
      stadium:        'النادي هرتا برلي',
      capacity:       32350,
      level:          33,
      overallRating:  108.9,
      leaguePosition: 1,
      fanClub:        'Familista Berlin',
      plan:           SubscriptionPlan.ACADEMY,
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      currentPeriodEnd: new Date('2025-12-31'),
    },
  });
  console.log(`✅ Club: ${club.name}`);

  // ── Admin user(s) ─────────────────────────────────────────
  const adminHash = await bcrypt.hash('Familista2024!', 12);

  // Original owner account (kept).
  const admin = await prisma.user.upsert({
    where: { email: 'khatab@familista.io' },
    update: {},
    create: {
      email:        'khatab@familista.io',
      passwordHash: adminHash,
      firstName:    'Khatab',
      lastName:     'Atiya',
      role:         UserRole.CLUB_ADMIN,
      clubId:       club.id,
    },
  });
  console.log(`✅ Admin: ${admin.email}`);

  // Public demo account — same password as the owner so docs can list one
  // canonical credential pair for screenshots / first-time testers.
  const demoAdmin = await prisma.user.upsert({
    where: { email: 'admin@familista.io' },
    update: { passwordHash: adminHash, isActive: true },
    create: {
      email:        'admin@familista.io',
      passwordHash: adminHash,
      firstName:    'Admin',
      lastName:     'Familista',
      role:         UserRole.CLUB_ADMIN,
      clubId:       club.id,
    },
  });
  console.log(`✅ Demo admin: ${demoAdmin.email}`);

  // ── Phase A — default Senior team + Memberships for demo users ─────────
  const seniorTeam = await prisma.team.upsert({
    where:  { clubId_name: { clubId: club.id, name: 'Senior' } },
    update: {},
    create: {
      clubId:   club.id,
      name:     'Senior',
      shortName:'1ST',
      kind:     TeamKind.SENIOR,
      gender:   Gender.MEN,
      color:    '#16A34A',
    },
  });
  console.log(`✅ Team:  ${seniorTeam.name} (${seniorTeam.id})`);

  // Memberships mirror legacy roles so the Phase A tenant middleware
  // accepts these users immediately after deploy.
  const membershipSpecs: Array<{ userId: string; role: MembershipRole }> = [
    { userId: admin.id,     role: MembershipRole.CLUB_OWNER },
    { userId: demoAdmin.id, role: MembershipRole.CLUB_ADMIN },
    { userId: coach.id,     role: MembershipRole.HEAD_COACH },
  ];
  for (const m of membershipSpecs) {
    const row = await prisma.membership.upsert({
      where: { userId_clubId_teamId_role: { userId: m.userId, clubId: club.id, teamId: null, role: m.role } },
      update: { isActive: true, leftAt: null },
      create: { userId: m.userId, clubId: club.id, teamId: null, role: m.role, isActive: true },
    });
    console.log(`✅ Membership: ${m.role} (${row.id})`);
  }

  // Set the active context for the demo accounts so the UI is pre-tenanted.
  await prisma.user.updateMany({
    where: { id: { in: [admin.id, demoAdmin.id, coach.id] } },
    data:  { currentClubId: club.id, currentTeamId: seniorTeam.id },
  });

  // Backfill: assign any existing players in this club without a team to Senior.
  // Idempotent — only touches rows where teamId IS NULL.
  const backfill = await prisma.player.updateMany({
    where: { clubId: club.id, teamId: null },
    data:  { teamId: seniorTeam.id },
  });
  if (backfill.count > 0) console.log(`✅ Backfilled ${backfill.count} player(s) → Senior team`);

  // Coach
  const coachHash = await bcrypt.hash('Coach2024!', 12);
  const coach = await prisma.user.upsert({
    where: { email: 'coach@familista.io' },
    update: {},
    create: {
      email:        'coach@familista.io',
      passwordHash: coachHash,
      firstName:    'Thomas',
      lastName:     'Mueller',
      role:         UserRole.HEAD_COACH,
      clubId:       club.id,
    },
  });
  console.log(`✅ Coach: ${coach.email}`);

  // ── Players ───────────────────────────────────────────────
  const playerDefs = [
    { fn:'Pavel',       ln:'Barkov',    num:1,  pos:PlayerPosition.GK,  nat:'Russia',      flag:'🇷🇺', dob:'1996-03-12', h:188, w:84, ovr:109, pot:114, cnd:95,  mv:26208000, wage:196, foot:Foot.RIGHT,
      def:{reflexes:112,gkPositioning:108,handling:106,kicking:98}, atk:{pace:72,shooting:55,passing:76,heading:88}, phy:{strength:86,stamina:88,agility:78,balance:82},
      gps:{topSpeed:24.1,avgSpeed:9.2,distance:6.2,sprintCount:8,heartRateAvg:154,heartRateMax:174,playerLoad:78,riskScore:12} },
    { fn:'Daan',        ln:'de Meijer', num:2,  pos:PlayerPosition.DC,  nat:'Netherlands', flag:'🇳🇱', dob:'1998-07-21', h:184, w:82, ovr:110, pot:116, cnd:88,  mv:26400000, wage:198, foot:Foot.RIGHT,
      def:{tackling:112,marking:110,heading:108,defPositioning:106}, atk:{pace:78,shooting:62,passing:84,crossing:70}, phy:{strength:104,stamina:92,agility:76,balance:88},
      gps:{topSpeed:29.4,avgSpeed:11.2,distance:10.8,sprintCount:14,heartRateAvg:168,heartRateMax:188,playerLoad:108,riskScore:28} },
    { fn:'Juan',        ln:'Cáceres',   num:5,  pos:PlayerPosition.DC,  nat:'Argentina',   flag:'🇦🇷', dob:'1995-11-03', h:181, w:78, ovr:99,  pot:103, cnd:72,  mv:23760000, wage:178, foot:Foot.LEFT,
      def:{tackling:102,marking:98,heading:96,defPositioning:100}, atk:{pace:74,shooting:58,passing:80,crossing:66}, phy:{strength:98,stamina:84,agility:72,balance:84},
      gps:{topSpeed:27.2,avgSpeed:10.4,distance:9.4,sprintCount:11,heartRateAvg:162,heartRateMax:182,playerLoad:96,riskScore:74} },
    { fn:'Ramzi',       ln:'Jebali',    num:6,  pos:PlayerPosition.DC,  nat:'Tunisia',     flag:'🇹🇳', dob:'1999-05-18', h:183, w:80, ovr:103, pot:108, cnd:90,  mv:24720000, wage:185, foot:Foot.RIGHT,
      def:{tackling:106,marking:104,heading:100,defPositioning:102}, atk:{pace:80,shooting:60,passing:82,crossing:68}, phy:{strength:100,stamina:90,agility:78,balance:86},
      gps:{topSpeed:28.8,avgSpeed:11.0,distance:10.2,sprintCount:13,heartRateAvg:166,heartRateMax:186,playerLoad:102,riskScore:32} },
    { fn:'Tobias',      ln:'Schroden',  num:23, pos:PlayerPosition.DMC, nat:'Germany',     flag:'🇩🇪', dob:'2000-02-14', h:180, w:75, ovr:121, pot:128, cnd:68,  mv:29040000, wage:218, foot:Foot.RIGHT,
      def:{tackling:120,interceptions:118,marking:116,heading:108}, atk:{pace:86,shooting:82,passing:118,dribbling:110}, phy:{strength:106,stamina:78,agility:92,balance:96},
      gps:{topSpeed:31.6,avgSpeed:12.4,distance:11.4,sprintCount:22,heartRateAvg:178,heartRateMax:196,playerLoad:142,riskScore:82} },
    { fn:'David',       ln:'Grahl',     num:8,  pos:PlayerPosition.ML,  nat:'Germany',     flag:'🇩🇪', dob:'1997-09-27', h:177, w:72, ovr:109, pot:113, cnd:86,  mv:26160000, wage:196, foot:Foot.LEFT,
      def:{tackling:104,interceptions:100,marking:98,defPositioning:102}, atk:{pace:108,shooting:96,passing:106,crossing:112}, phy:{strength:88,stamina:106,agility:110,balance:104},
      gps:{topSpeed:32.4,avgSpeed:12.8,distance:11.8,sprintCount:19,heartRateAvg:171,heartRateMax:191,playerLoad:118,riskScore:44} },
    { fn:'Tim',         ln:'Hanke',     num:4,  pos:PlayerPosition.MC,  nat:'Germany',     flag:'🇩🇪', dob:'2001-06-08', h:179, w:74, ovr:98,  pot:106, cnd:92,  mv:23520000, wage:176, foot:Foot.RIGHT,
      def:{tackling:98,interceptions:96,marking:94,defPositioning:98}, atk:{pace:90,shooting:88,passing:102,dribbling:96}, phy:{strength:92,stamina:100,agility:96,balance:98},
      gps:{topSpeed:29.8,avgSpeed:11.6,distance:10.6,sprintCount:15,heartRateAvg:165,heartRateMax:185,playerLoad:106,riskScore:36} },
    { fn:'Ahmed',       ln:'Kabar',     num:14, pos:PlayerPosition.MC,  nat:'Germany',     flag:'🇩🇪', dob:'1999-12-01', h:180, w:76, ovr:123, pot:130, cnd:95,  mv:29520000, wage:222, foot:Foot.RIGHT,
      def:{tackling:118,interceptions:116,marking:112,defPositioning:120}, atk:{pace:94,shooting:112,passing:124,dribbling:118}, phy:{strength:96,stamina:112,agility:108,balance:110},
      gps:{topSpeed:32.8,avgSpeed:12.6,distance:12.2,sprintCount:21,heartRateAvg:174,heartRateMax:193,playerLoad:122,riskScore:48} },
    { fn:'Oliver',      ln:'Frings',    num:15, pos:PlayerPosition.MR,  nat:'Germany',     flag:'🇩🇪', dob:'1998-04-22', h:176, w:71, ovr:124, pot:130, cnd:94,  mv:29760000, wage:224, foot:Foot.RIGHT,
      def:{tackling:106,interceptions:108,marking:100,defPositioning:112}, atk:{pace:124,shooting:116,passing:118,crossing:122}, phy:{strength:90,stamina:118,agility:126,balance:114},
      gps:{topSpeed:34.2,avgSpeed:13.4,distance:12.8,sprintCount:26,heartRateAvg:176,heartRateMax:194,playerLoad:128,riskScore:56} },
    { fn:'Christopher', ln:'Lowens',    num:11, pos:PlayerPosition.AMC, nat:'Germany',     flag:'🇩🇪', dob:'2000-08-15', h:174, w:70, ovr:99,  pot:108, cnd:88,  mv:23760000, wage:178, foot:Foot.RIGHT,
      def:{tackling:80,interceptions:84,marking:78,defPositioning:90}, atk:{pace:106,shooting:108,passing:112,dribbling:116}, phy:{strength:82,stamina:102,agility:118,balance:108},
      gps:{topSpeed:30.6,avgSpeed:12.2,distance:10.4,sprintCount:18,heartRateAvg:169,heartRateMax:189,playerLoad:104,riskScore:38} },
    { fn:'Naoki',       ln:'Fujita',    num:20, pos:PlayerPosition.ST,  nat:'Japan',       flag:'🇯🇵', dob:'2002-01-30', h:172, w:68, ovr:96,  pot:104, cnd:82,  mv:23040000, wage:172, foot:Foot.BOTH,
      def:{tackling:68,interceptions:72,marking:66,defPositioning:80}, atk:{pace:114,shooting:122,passing:94,heading:108}, phy:{strength:96,stamina:106,agility:112,balance:96},
      gps:{topSpeed:33.1,avgSpeed:13.0,distance:10.2,sprintCount:20,heartRateAvg:172,heartRateMax:190,playerLoad:110,riskScore:46} },
  ];

  const players = [];
  for (const p of playerDefs) {
    const { def, atk, phy, gps, ...rest } = p;
    // Lookup by (clubId, shirt number) instead of a literal id so Prisma's
    // @default(uuid()) generates real UUIDs on create. Literal ids of the
    // form `player-${num}-fhsr` are what caused POST /training to reject
    // playerIds with "Invalid uuid".
    const existing = await prisma.player.findFirst({
      where: { clubId: club.id, number: rest.num },
      select: { id: true },
    });
    const player = existing
      ? await prisma.player.update({
          where: { id: existing.id },
          data:  { condition: rest.cnd },
        })
      : await prisma.player.create({
          data: {
            firstName:    rest.fn,
            lastName:     rest.ln,
            number:       rest.num,
            position:     rest.pos,
            nationality:  rest.nat,
            flag:         rest.flag,
            dateOfBirth:  new Date(rest.dob),
            height:       rest.h,
            weight:       rest.w,
            overallRating:rest.ovr,
            potential:    rest.pot,
            condition:    rest.cnd,
            marketValue:  rest.mv,
            weeklyWage:   rest.wage,
            preferredFoot:rest.foot,
            contractUntil:new Date('2026-12-31'),
            clubId:       club.id,
          },
        });

    // Attributes — one row per player. Look up by playerId, not synthetic id.
    const existingAttr = await prisma.playerAttribute.findFirst({
      where: { playerId: player.id },
      select: { id: true },
    });
    if (!existingAttr) {
      await prisma.playerAttribute.create({
        data: {
          playerId: player.id,
          ...def as object,
          ...atk as object,
          ...phy as object,
        } as never,
      });
    }

    // GPS data (last 3 sessions)
    for (let i = 0; i < 3; i++) {
      const daysAgo = i * 3;
      await prisma.playerGpsData.create({
        data: {
          playerId:     player.id,
          sessionType:  i === 0 ? 'match' : 'training',
          topSpeed:     gps.topSpeed + (Math.random() - 0.5) * 2,
          avgSpeed:     gps.avgSpeed + (Math.random() - 0.5),
          distance:     gps.distance + (Math.random() - 0.5),
          sprintCount:  gps.sprintCount + Math.floor((Math.random() - 0.5) * 4),
          heartRateAvg: gps.heartRateAvg + Math.floor((Math.random() - 0.5) * 8),
          heartRateMax: gps.heartRateMax + Math.floor((Math.random() - 0.5) * 8),
          playerLoad:   gps.playerLoad + (Math.random() - 0.5) * 10,
          riskScore:    gps.riskScore + (Math.random() - 0.5) * 10,
          recordedAt:   new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
        },
      });
    }

    players.push(player);
  }
  // Shirt number → Player.id (UUID) lookup so the injury upserts below stop
  // hardcoding `player-N-fhsr` literals.
  const playerIdByNumber = new Map<number, string>(players.map(p => [p.number, p.id]));
  console.log(`✅ ${players.length} players with attributes and GPS data`);

  // ── GPS Devices ───────────────────────────────────────────
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    await prisma.gpsDevice.upsert({
      where: { serialNumber: `FAM-${p.id.toUpperCase()}-2025` },
      update: { isOnline: true, batteryLevel: 88 - i * 2 },
      create: {
        serialNumber: `FAM-${p.id.toUpperCase()}-2025`,
        firmware:     'v1.2',
        isOnline:     true,
        batteryLevel: 88 - i * 2,
        signalQuality:100,
        clubId:       club.id,
        playerId:     p.id,
        lastSeenAt:   new Date(),
      },
    });
  }
  console.log(`✅ ${players.length} GPS devices`);

  // ── Injuries ──────────────────────────────────────────────
  const caceresId  = playerIdByNumber.get(5);
  const schrodenId = playerIdByNumber.get(23);
  const fujitaId   = playerIdByNumber.get(20);
  if (!caceresId || !schrodenId || !fujitaId) {
    throw new Error('Seed: missing expected players (#5, #23, #20) — refusing to seed injuries with stale literal ids');
  }

  await prisma.playerInjury.upsert({
    where: { id: 'inj-caceres-001' },
    update: {},
    create: {
      id:             'inj-caceres-001',
      playerId:       caceresId,
      bodyPart:       'Hamstring',
      injuryType:     'Hamstring Strain',
      severity:       InjurySeverity.CRITICAL,
      injuredAt:      new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      expectedReturn: new Date(Date.now() + 11 * 24 * 60 * 60 * 1000),
    },
  });
  await prisma.player.update({ where: { id: caceresId }, data: { isInjured: true } });

  await prisma.playerInjury.upsert({
    where: { id: 'inj-schroden-001' },
    update: {},
    create: {
      id:             'inj-schroden-001',
      playerId:       schrodenId,
      bodyPart:       'General',
      injuryType:     'Fatigue Overload',
      severity:       InjurySeverity.MODERATE,
      injuredAt:      new Date(),
      expectedReturn: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    },
  });

  await prisma.playerInjury.upsert({
    where: { id: 'inj-fujita-001' },
    update: {},
    create: {
      id:             'inj-fujita-001',
      playerId:       fujitaId,
      bodyPart:       'Ankle',
      injuryType:     'Ankle Sprain',
      severity:       InjurySeverity.MINOR,
      injuredAt:      new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      expectedReturn: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    },
  });
  console.log('✅ Injuries seeded');

  // ── Matches ───────────────────────────────────────────────
  const matchData = [
    { ht:'Familista HSR', at:'KawasakiFrontale',  hs:4, as:1, r:MatchResult.WIN,  comp:CompetitionType.LEAGUE, daysAgo:3 },
    { ht:'Familista HSR', at:'Manchester City',   hs:7, as:0, r:MatchResult.WIN,  comp:CompetitionType.ELITE,  daysAgo:4 },
    { ht:'สโมสร 44945',  at:'Familista HSR',     hs:2, as:1, r:MatchResult.LOSS, comp:CompetitionType.CUP,    daysAgo:5 },
    { ht:'Familista HSR', at:'Pandawa Fc',        hs:5, as:0, r:MatchResult.WIN,  comp:CompetitionType.ELITE,  daysAgo:6 },
    { ht:'Familista HSR', at:'Cozea FC',          hs:3, as:2, r:MatchResult.WIN,  comp:CompetitionType.LEAGUE, daysAgo:7 },
    { ht:'AEK Athens',    at:'Familista HSR',     hs:1, as:4, r:MatchResult.WIN,  comp:CompetitionType.ELITE,  daysAgo:9 },
    { ht:'Familista HSR', at:'Atletico Madrid',   hs:6, as:0, r:MatchResult.WIN,  comp:CompetitionType.LEAGUE, daysAgo:11 },
    { ht:'Sporting CP',   at:'Familista HSR',     hs:2, as:2, r:MatchResult.DRAW, comp:CompetitionType.LEAGUE, daysAgo:14 },
  ];

  for (let i = 0; i < matchData.length; i++) {
    const m = matchData[i];
    const scheduledAt = new Date(Date.now() - m.daysAgo * 24 * 60 * 60 * 1000);
    const match = await prisma.match.upsert({
      where: { id: `match-${i + 1}-fhsr` },
      update: {},
      create: {
        id:              `match-${i + 1}-fhsr`,
        clubId:          club.id,
        homeTeam:        m.ht,
        awayTeam:        m.at,
        homeScore:       m.hs,
        awayScore:       m.as,
        result:          m.r,
        isHome:          m.ht.includes('Familista'),
        competition:     m.comp,
        scheduledAt,
        playedAt:        scheduledAt,
        possession:      55 + Math.random() * 20,
        shots:           Math.floor(10 + Math.random() * 10),
        shotsOnTarget:   Math.floor(4 + Math.random() * 6),
      },
    });

    // Player stats for each match
    for (const player of players) {
      await prisma.playerMatchStat.upsert({
        where: { matchId_playerId: { matchId: match.id, playerId: player.id } },
        update: {},
        create: {
          matchId:       match.id,
          playerId:      player.id,
          minutesPlayed: 90,
          goals:         player.position === 'ST' ? Math.floor(Math.random() * 2) : 0,
          assists:       Math.floor(Math.random() * 1.5),
          shots:         Math.floor(Math.random() * 4),
          passes:        Math.floor(40 + Math.random() * 30),
          passAccuracy:  75 + Math.random() * 20,
          tackles:       Math.floor(Math.random() * 5),
          rating:        6 + Math.random() * 3,
        },
      });
    }
  }

  // Upcoming match
  await prisma.match.upsert({
    where: { id: 'match-next-fhsr' },
    update: {},
    create: {
      id:          'match-next-fhsr',
      clubId:      club.id,
      homeTeam:    'marachy fc',
      awayTeam:    'Familista HSR',
      isHome:      false,
      competition: CompetitionType.LEAGUE,
      scheduledAt: new Date(new Date().setHours(14, 30, 0, 0)),
      venue:       'Herta Stadium, Berlin',
    },
  });
  console.log(`✅ ${matchData.length + 1} matches with player stats`);

  // ── Tournaments ───────────────────────────────────────────
  const tourns = [
    { id:'tourn-l33',  name:'League Level 33',       type:CompetitionType.LEAGUE,       teams:14, pos:1, pts:21, w:7, d:0, l:0, gf:34, ga:2 },
    { id:'tourn-el',   name:'Elite League',           type:CompetitionType.ELITE,        teams:14, pos:4, pts:21, w:7, d:0, l:0, gf:28, ga:12 },
    { id:'tourn-cup',  name:'Cup Season 207',         type:CompetitionType.CUP,          teams:64, pos:null, pts:null, w:2, d:0, l:1, gf:7, ga:2 },
    { id:'tourn-asso', name:'Association Tournament', type:CompetitionType.ASSOCIATION,  teams:8,  pos:1, pts:12, w:4, d:0, l:0, gf:22, ga:5 },
  ];
  for (const t of tourns) {
    await prisma.tournament.upsert({
      where:  { id: t.id },
      update: {},
      create: { ...t, clubId: club.id, played: t.w + t.d + t.l },
    });
  }
  console.log(`✅ ${tourns.length} tournaments`);

  // ── Training sessions ─────────────────────────────────────
  const trainingData = [
    { title:'Pre-match Activation', duration:60,  drills:[DrillType.TECHNICAL_PASSING, DrillType.SPRINT_INTERVALS], daysAgo:1 },
    { title:'Tactical Shape Work',  duration:90,  drills:[DrillType.DEFENSIVE_SHAPE,   DrillType.POSSESSION],       daysAgo:3 },
    { title:'Recovery Session',     duration:45,  drills:[DrillType.RECOVERY],                                      daysAgo:5 },
  ];
  for (let i = 0; i < trainingData.length; i++) {
    const t = trainingData[i];
    const session = await prisma.trainingSession.upsert({
      where: { id: `training-${i + 1}-fhsr` },
      update: {},
      create: {
        id:           `training-${i + 1}-fhsr`,
        clubId:       club.id,
        title:        t.title,
        duration:     t.duration,
        drills:       t.drills,
        scheduledAt:  new Date(Date.now() - t.daysAgo * 24 * 60 * 60 * 1000),
        attackForm:   14,
        defenseForm:  16,
        possession:   12,
        conditionForm:13,
      },
    });
    for (const player of players) {
      await prisma.playerTrainingStat.upsert({
        where: { sessionId_playerId: { sessionId: session.id, playerId: player.id } },
        update: {},
        create: { sessionId: session.id, playerId: player.id, attended: true, rating: 6 + Math.random() * 3 },
      });
    }
  }
  console.log('✅ Training sessions');

  // ── Scout reports ─────────────────────────────────────────
  const scouts = [
    { n:'M. Rodriguez', c:'FC Valencia',  pos:PlayerPosition.DMC, age:24, nat:'Spain',     flag:'🇪🇸', mv:2100000, r:4.0, rec:ScoutRecommendation.SIGN },
    { n:'B. Kowalski',  c:'Lech Poznan',  pos:PlayerPosition.DC,  age:22, nat:'Poland',    flag:'🇵🇱', mv:1400000, r:3.5, rec:ScoutRecommendation.SIGN },
    { n:'Y. Tanaka',    c:'Gamba Osaka',  pos:PlayerPosition.MC,  age:25, nat:'Japan',     flag:'🇯🇵', mv:3200000, r:4.0, rec:ScoutRecommendation.MONITOR },
    { n:'L. Santos',    c:'Benfica B',    pos:PlayerPosition.ST,  age:21, nat:'Brazil',    flag:'🇧🇷', mv:4800000, r:4.5, rec:ScoutRecommendation.MONITOR },
    { n:'K. Müller',    c:'Schalke 04',   pos:PlayerPosition.GK,  age:23, nat:'Germany',   flag:'🇩🇪', mv:1800000, r:3.5, rec:ScoutRecommendation.SKIP },
    { n:'A. Ibrahim',   c:'Al Ahly',      pos:PlayerPosition.ML,  age:26, nat:'Egypt',     flag:'🇪🇬', mv:2600000, r:4.0, rec:ScoutRecommendation.SIGN },
  ];
  for (let i = 0; i < scouts.length; i++) {
    const s = scouts[i];
    await prisma.scoutReport.upsert({
      where: { id: `scout-${i + 1}-fhsr` },
      update: {},
      create: {
        id:             `scout-${i + 1}-fhsr`,
        clubId:         club.id,
        targetName:     s.n,
        targetClub:     s.c,
        position:       s.pos,
        age:            s.age,
        nationality:    s.nat,
        flag:           s.flag,
        marketValue:    s.mv,
        rating:         s.r,
        recommendation: s.rec,
      },
    });
  }
  console.log('✅ Scout reports');

  // ── Financials ────────────────────────────────────────────
  const financialData = [
    { t:TransactionType.INCOME,  cat:'Investment',    amt:26000000  },
    { t:TransactionType.INCOME,  cat:'Ticket Sales',  amt:26800000  },
    { t:TransactionType.INCOME,  cat:'Sponsorship',   amt:130000000 },
    { t:TransactionType.INCOME,  cat:'Prize Money',   amt:5200000   },
    { t:TransactionType.EXPENSE, cat:'Player Wages',  amt:63400000  },
    { t:TransactionType.EXPENSE, cat:'Staff Wages',   amt:8200000   },
    { t:TransactionType.EXPENSE, cat:'Facilities',    amt:2000000   },
    { t:TransactionType.EXPENSE, cat:'Travel',        amt:1500000   },
  ];
  for (let i = 0; i < financialData.length; i++) {
    const f = financialData[i];
    await prisma.financial.upsert({
      where:  { id: `fin-${i + 1}-fhsr` },
      update: {},
      create: {
        id:      `fin-${i + 1}-fhsr`,
        clubId:  club.id,
        type:    f.t,
        category:f.cat,
        amount:  f.amt,
        date:    new Date(),
      },
    });
  }
  console.log('✅ Financial records');

  console.log('\n🎉 Seed complete!\n');
  console.log('┌─────────────────────────────────────────┐');
  console.log('│          DEMO CREDENTIALS               │');
  console.log('├─────────────────────────────────────────┤');
  console.log('│ Admin:  khatab@familista.io             │');
  console.log('│ Pass:   Familista2024!                  │');
  console.log('├─────────────────────────────────────────┤');
  console.log('│ Coach:  coach@familista.io              │');
  console.log('│ Pass:   Coach2024!                      │');
  console.log('└─────────────────────────────────────────┘\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
