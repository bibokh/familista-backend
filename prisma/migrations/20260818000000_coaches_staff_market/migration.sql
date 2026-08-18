-- CreateEnum
CREATE TYPE "StaffAvailability" AS ENUM ('FREE_AGENT', 'EMPLOYED', 'OPEN_TO_OFFERS', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "StaffTrophyKind" AS ENUM ('LEAGUE', 'CUP', 'CONTINENTAL', 'PROMOTION', 'YOUTH', 'OTHER');

-- CreateEnum
CREATE TYPE "StaffNeedPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "StaffApproachStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'NEGOTIATING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'COMPLETED');

-- CreateTable
CREATE TABLE "StaffProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nationality" TEXT,
    "secondNationality" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "level" INTEGER NOT NULL DEFAULT 60,
    "yearsExperience" INTEGER NOT NULL DEFAULT 0,
    "availability" "StaffAvailability" NOT NULL DEFAULT 'EMPLOYED',
    "wageExpectation" BIGINT,
    "tacticalKnowledge" INTEGER NOT NULL DEFAULT 60,
    "trainingQuality" INTEGER NOT NULL DEFAULT 60,
    "playerDevelopment" INTEGER NOT NULL DEFAULT 60,
    "manManagement" INTEGER NOT NULL DEFAULT 60,
    "matchPreparation" INTEGER NOT NULL DEFAULT 60,
    "analysis" INTEGER NOT NULL DEFAULT 60,
    "leadership" INTEGER NOT NULL DEFAULT 60,
    "specialities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "philosophy" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dominantPhilosophy" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trainingMethods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "primaryFormation" TEXT,
    "secondaryFormations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "nationalTeamExperience" BOOLEAN NOT NULL DEFAULT false,
    "youthNationalTeamExperience" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffLicence" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "obtainedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffLicence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffTrophy" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "competition" TEXT NOT NULL,
    "clubName" TEXT NOT NULL,
    "clubId" TEXT,
    "season" TEXT NOT NULL,
    "kind" "StaffTrophyKind" NOT NULL,
    "level" TEXT,
    "roleHeld" "MembershipRole",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffTrophy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffSeason" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "clubName" TEXT NOT NULL,
    "clubId" TEXT,
    "season" TEXT NOT NULL,
    "league" TEXT,
    "country" TEXT,
    "role" "MembershipRole",
    "finalPosition" INTEGER,
    "played" INTEGER,
    "won" INTEGER,
    "drawn" INTEGER,
    "lost" INTEGER,
    "goalsFor" INTEGER,
    "goalsAgainst" INTEGER,
    "promoted" BOOLEAN NOT NULL DEFAULT false,
    "relegated" BOOLEAN NOT NULL DEFAULT false,
    "competitionProgress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffSeason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffEngagement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "teamLabel" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "salary" BIGINT,
    "contractEndsAt" TIMESTAMP(3),
    "clubName" TEXT,
    "country" TEXT,
    "league" TEXT,
    "matches" INTEGER,
    "points" INTEGER,
    "achievements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffEngagement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffNeed" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "priority" "StaffNeedPriority" NOT NULL DEFAULT 'NORMAL',
    "minLicence" TEXT,
    "minLevel" INTEGER,
    "salaryMin" BIGINT,
    "salaryMax" BIGINT,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffNeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffApproach" (
    "id" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "fromClubId" TEXT NOT NULL,
    "currentClubId" TEXT,
    "proposedRole" "MembershipRole" NOT NULL,
    "salary" BIGINT,
    "durationMonths" INTEGER,
    "compensation" BIGINT,
    "message" TEXT,
    "status" "StaffApproachStatus" NOT NULL DEFAULT 'DRAFT',
    "decidedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffApproach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffApproachMessage" (
    "id" TEXT NOT NULL,
    "approachId" TEXT NOT NULL,
    "fromClubId" TEXT,
    "body" TEXT NOT NULL,
    "salary" BIGINT,
    "durationMonths" INTEGER,
    "compensation" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffApproachMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffProfile_userId_key" ON "StaffProfile"("userId");

-- CreateIndex
CREATE INDEX "StaffProfile_availability_idx" ON "StaffProfile"("availability");

-- CreateIndex
CREATE INDEX "StaffProfile_level_idx" ON "StaffProfile"("level");

-- CreateIndex
CREATE INDEX "StaffLicence_profileId_idx" ON "StaffLicence"("profileId");

-- CreateIndex
CREATE INDEX "StaffLicence_code_idx" ON "StaffLicence"("code");

-- CreateIndex
CREATE INDEX "StaffLicence_rank_idx" ON "StaffLicence"("rank");

-- CreateIndex
CREATE INDEX "StaffTrophy_profileId_idx" ON "StaffTrophy"("profileId");

-- CreateIndex
CREATE INDEX "StaffTrophy_kind_idx" ON "StaffTrophy"("kind");

-- CreateIndex
CREATE INDEX "StaffSeason_profileId_idx" ON "StaffSeason"("profileId");

-- CreateIndex
CREATE INDEX "StaffSeason_season_idx" ON "StaffSeason"("season");

-- CreateIndex
CREATE INDEX "StaffEngagement_userId_idx" ON "StaffEngagement"("userId");

-- CreateIndex
CREATE INDEX "StaffEngagement_clubId_idx" ON "StaffEngagement"("clubId");

-- CreateIndex
CREATE INDEX "StaffEngagement_isActive_idx" ON "StaffEngagement"("isActive");

-- CreateIndex
CREATE INDEX "StaffEngagement_userId_isActive_idx" ON "StaffEngagement"("userId", "isActive");

-- CreateIndex
CREATE INDEX "StaffNeed_clubId_idx" ON "StaffNeed"("clubId");

-- CreateIndex
CREATE INDEX "StaffNeed_role_idx" ON "StaffNeed"("role");

-- CreateIndex
CREATE INDEX "StaffNeed_isActive_idx" ON "StaffNeed"("isActive");

-- CreateIndex
CREATE INDEX "StaffApproach_staffUserId_idx" ON "StaffApproach"("staffUserId");

-- CreateIndex
CREATE INDEX "StaffApproach_fromClubId_idx" ON "StaffApproach"("fromClubId");

-- CreateIndex
CREATE INDEX "StaffApproach_currentClubId_idx" ON "StaffApproach"("currentClubId");

-- CreateIndex
CREATE INDEX "StaffApproach_status_idx" ON "StaffApproach"("status");

-- CreateIndex
CREATE INDEX "StaffApproachMessage_approachId_idx" ON "StaffApproachMessage"("approachId");

-- AddForeignKey
ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLicence" ADD CONSTRAINT "StaffLicence_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffTrophy" ADD CONSTRAINT "StaffTrophy_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffSeason" ADD CONSTRAINT "StaffSeason_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffEngagement" ADD CONSTRAINT "StaffEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffEngagement" ADD CONSTRAINT "StaffEngagement_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffNeed" ADD CONSTRAINT "StaffNeed_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffApproach" ADD CONSTRAINT "StaffApproach_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffApproach" ADD CONSTRAINT "StaffApproach_fromClubId_fkey" FOREIGN KEY ("fromClubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffApproachMessage" ADD CONSTRAINT "StaffApproachMessage_approachId_fkey" FOREIGN KEY ("approachId") REFERENCES "StaffApproach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

