const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Familista database...');

  const club = await prisma.club.upsert({
    where: { id: 'fam-hsr-berlin-001' },
    update: {},
    create: {
      id: 'fam-hsr-berlin-001',
      name: 'Familista HSR',
      shortName: 'FHSR',
      emblem: '🔴',
      city: 'Berlin',
      country: 'Germany',
      founded: new Date('2023-10-15'),
      stadium: 'النادي هرتا برلي',
      capacity: 32350,
      level: 33,
      overallRating: 108.9,
      leaguePosition: 1,
      plan: 'ACADEMY',
      subscriptionStatus: 'ACTIVE',
      currentPeriodEnd: new Date('2025-12-31'),
    },
  });
  console.log('✅ Club: ' + club.name);

  const adminHash = await bcrypt.hash('Familista2024!', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'khatab@familista.io' },
    update: {},
    create: {
      email: 'khatab@familista.io',
      passwordHash: adminHash,
      firstName: 'Khatab',
      lastName: 'Atiya',
      role: 'CLUB_ADMIN',
      clubId: club.id,
    },
  });
  console.log('✅ Admin: ' + admin.email);

  const coachHash = await bcrypt.hash('Coach2024!', 12);
  const coach = await prisma.user.upsert({
    where: { email: 'coach@familista.io' },
    update: {},
    create: {
      email: 'coach@familista.io',
      passwordHash: coachHash,
      firstName: 'Thomas',
      lastName: 'Mueller',
      role: 'HEAD_COACH',
      clubId: club.id,
    },
  });
  console.log('✅ Coach: ' + coach.email);

  const playerDefs = [
    { fn:'Pavel', ln:'Barkov', num:1, pos:'GK', nat:'Russia', flag:'🇷🇺', dob:'1996-03-12', h:188, w:84, ovr:109, pot:114, cnd:95, mv:26208000, wage:196 },
    { fn:'Daan', ln:'de Meijer', num:2, pos:'DC', nat:'Netherlands', flag:'🇳🇱', dob:'1998-07-21', h:184, w:82, ovr:110, pot:116, cnd:88, mv:26400000, wage:198 },
    { fn:'Juan', ln:'Caceres', num:5, pos:'DC', nat:'Argentina', flag:'🇦🇷', dob:'1995-11-03', h:181, w:78, ovr:99, pot:103, cnd:72, mv:23760000, wage:178 },
    { fn:'Ramzi', ln:'Jebali', num:6, pos:'DC', nat:'Tunisia', flag:'🇹🇳', dob:'1999-05-18', h:183, w:80, ovr:103, pot:108, cnd:90, mv:24720000, wage:185 },
    { fn:'Tobias', ln:'Schroden', num:23, pos:'DMC', nat:'Germany', flag:'🇩🇪', dob:'2000-02-14', h:180, w:75, ovr:121, pot:128, cnd:68, mv:29040000, wage:218 },
    { fn:'David', ln:'Grahl', num:8, pos:'ML', nat:'Germany', flag:'🇩🇪', dob:'1997-09-27', h:177, w:72, ovr:109, pot:113, cnd:86, mv:26160000, wage:196 },
    { fn:'Tim', ln:'Hanke', num:4, pos:'MC', nat:'Germany', flag:'🇩🇪', dob:'2001-06-08', h:179, w:74, ovr:98, pot:106, cnd:92, mv:23520000, wage:176 },
    { fn:'Ahmed', ln:'Kabar', num:14, pos:'MC', nat:'Germany', flag:'🇩🇪', dob:'1999-12-01', h:180, w:76, ovr:123, pot:130, cnd:95, mv:29520000, wage:222 },
    { fn:'Oliver', ln:'Frings', num:15, pos:'MR', nat:'Germany', flag:'🇩🇪', dob:'1998-04-22', h:176, w:71, ovr:124, pot:130, cnd:94, mv:29760000, wage:224 },
    { fn:'Christopher', ln:'Lowens', num:11, pos:'AMC', nat:'Germany', flag:'🇩🇪', dob:'2000-08-15', h:174, w:70, ovr:99, pot:108, cnd:88, mv:23760000, wage:178 },
    { fn:'Naoki', ln:'Fujita', num:20, pos:'ST', nat:'Japan', flag:'🇯🇵', dob:'2002-01-30', h:172, w:68, ovr:96, pot:104, cnd:82, mv:23040000, wage:172 },
  ];

  const players = [];
  for (const p of playerDefs) {
    const player = await prisma.player.upsert({
      where: { id: 'player-' + p.num + '-fhsr' },
      update: { condition: p.cnd },
      create: {
        id: 'player-' + p.num + '-fhsr',
        firstName: p.fn,
        lastName: p.ln,
        number: p.num,
        position: p.pos,
        nationality: p.nat,
        flag: p.flag,
        dateOfBirth: new Date(p.dob),
        height: p.h,
        weight: p.w,
        overallRating: p.ovr,
        potential: p.pot,
        condition: p.cnd,
        marketValue: p.mv,
        weeklyWage: p.wage,
        preferredFoot: 'RIGHT',
        contractUntil: new Date('2026-12-31'),
        clubId: club.id,
      },
    });

    await prisma.playerGpsData.create({
      data: {
        playerId: player.id,
        sessionType: 'match',
        topSpeed: 25 + Math.random() * 10,
        avgSpeed: 10 + Math.random() * 4,
        distance: 8 + Math.random() * 5,
        sprintCount: Math.floor(10 + Math.random() * 15),
        heartRateAvg: Math.floor(155 + Math.random() * 25),
        heartRateMax: Math.floor(180 + Math.random() * 15),
        playerLoad: 80 + Math.random() * 60,
        riskScore: Math.random() * 80,
      },
    });

    await prisma.gpsDevice.upsert({
      where: { serialNumber: 'FAM-' + player.id.toUpperCase() + '-2025' },
      update: { isOnline: true },
      create: {
        serialNumber: 'FAM-' + player.id.toUpperCase() + '-2025',
        firmware: 'v1.2',
        isOnline: true,
        batteryLevel: 85,
        signalQuality: 100,
        clubId: club.id,
        playerId: player.id,
        lastSeenAt: new Date(),
      },
    });

    players.push(player);
  }
  console.log('✅ ' + players.length + ' players with GPS data');

  // Injuries
  await prisma.playerInjury.upsert({
    where: { id: 'inj-caceres-001' },
    update: {},
    create: {
      id: 'inj-caceres-001',
      playerId: 'player-5-fhsr',
      bodyPart: 'Hamstring',
      injuryType: 'Hamstring Strain',
      severity: 'CRITICAL',
      injuredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      expectedReturn: new Date(Date.now() + 11 * 24 * 60 * 60 * 1000),
    },
  });
  await prisma.player.update({ where: { id: 'player-5-fhsr' }, data: { isInjured: true } });
  console.log('✅ Injuries seeded');

  // Matches
  const matchData = [
    { ht:'Familista HSR', at:'KawasakiFrontale', hs:4, as:1, r:'WIN', comp:'LEAGUE', daysAgo:3 },
    { ht:'Familista HSR', at:'Manchester City', hs:7, as:0, r:'WIN', comp:'ELITE', daysAgo:4 },
    { ht:'สโมสร 44945', at:'Familista HSR', hs:2, as:1, r:'LOSS', comp:'CUP', daysAgo:5 },
    { ht:'Familista HSR', at:'Pandawa Fc', hs:5, as:0, r:'WIN', comp:'ELITE', daysAgo:6 },
    { ht:'Familista HSR', at:'Cozea FC', hs:3, as:2, r:'WIN', comp:'LEAGUE', daysAgo:7 },
  ];

  for (let i = 0; i < matchData.length; i++) {
    const m = matchData[i];
    const scheduledAt = new Date(Date.now() - m.daysAgo * 24 * 60 * 60 * 1000);
    await prisma.match.upsert({
      where: { id: 'match-' + (i + 1) + '-fhsr' },
      update: {},
      create: {
        id: 'match-' + (i + 1) + '-fhsr',
        clubId: club.id,
        homeTeam: m.ht,
        awayTeam: m.at,
        homeScore: m.hs,
        awayScore: m.as,
        result: m.r,
        isHome: m.ht.includes('Familista'),
        competition: m.comp,
        scheduledAt,
        playedAt: scheduledAt,
      },
    });
  }

  await prisma.match.upsert({
    where: { id: 'match-next-fhsr' },
    update: {},
    create: {
      id: 'match-next-fhsr',
      clubId: club.id,
      homeTeam: 'marachy fc',
      awayTeam: 'Familista HSR',
      isHome: false,
      competition: 'LEAGUE',
      scheduledAt: new Date(new Date().setHours(14, 30, 0, 0)),
      venue: 'Herta Stadium, Berlin',
    },
  });
  console.log('✅ Matches seeded');

  // Tournaments
  const tourns = [
    { id:'tourn-l33', name:'League Level 33', type:'LEAGUE', teams:14, pos:1, pts:21, w:7, d:0, l:0, gf:34, ga:2 },
    { id:'tourn-el', name:'Elite League', type:'ELITE', teams:14, pos:4, pts:21, w:7, d:0, l:0, gf:28, ga:12 },
    { id:'tourn-cup', name:'Cup Season 207', type:'CUP', teams:64, pos:null, pts:null, w:2, d:0, l:1, gf:7, ga:2 },
    { id:'tourn-asso', name:'Association Tournament', type:'ASSOCIATION', teams:8, pos:1, pts:12, w:4, d:0, l:0, gf:22, ga:5 },
  ];
  for (const t of tourns) {
    await prisma.tournament.upsert({
      where: { id: t.id },
      update: {},
      create: { ...t, clubId: club.id, played: t.w + t.d + t.l },
    });
  }
  console.log('✅ Tournaments seeded');

  // Financials
  const fins = [
    { t:'INCOME', cat:'Investment', amt:26000000 },
    { t:'INCOME', cat:'Ticket Sales', amt:26800000 },
    { t:'INCOME', cat:'Sponsorship', amt:130000000 },
    { t:'EXPENSE', cat:'Player Wages', amt:63400000 },
    { t:'EXPENSE', cat:'Staff Wages', amt:8200000 },
  ];
  for (let i = 0; i < fins.length; i++) {
    const f = fins[i];
    await prisma.financial.upsert({
      where: { id: 'fin-' + (i+1) + '-fhsr' },
      update: {},
      create: { id: 'fin-' + (i+1) + '-fhsr', clubId: club.id, type: f.t, category: f.cat, amount: f.amt, date: new Date() },
    });
  }
  console.log('✅ Financials seeded');

  console.log('\n🎉 Seed complete!\n');
  console.log('Admin:  khatab@familista.io / Familista2024!');
  console.log('Coach:  coach@familista.io / Coach2024!\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
