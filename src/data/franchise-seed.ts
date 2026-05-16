// Familista — Franchise Expansion Engine
// File location: src/data/franchise-seed.ts
//
// Idempotent seed of system territories (countries + a few high-priority
// regions). Run once after `prisma migrate dev --name franchise_engine`, or via
// the seed endpoint exposed by the controller. Subsequent runs upsert without
// duplicating.

import { prisma } from '../lib/prisma';

type CountrySeed = {
  code: string;          // ISO 3166-1 alpha-2
  name: string;
  currency: string;      // ISO 4217
  timezone: string;
  population: number;
};

type RegionSeed = {
  countryCode: string;
  code: string;
  name: string;
  population?: number;
};

const COUNTRIES: ReadonlyArray<CountrySeed> = [
  { code: 'DE', name: 'Germany',        currency: 'EUR', timezone: 'Europe/Berlin',     population: 84_000_000 },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP', timezone: 'Europe/London',     population: 67_000_000 },
  { code: 'FR', name: 'France',         currency: 'EUR', timezone: 'Europe/Paris',      population: 68_000_000 },
  { code: 'ES', name: 'Spain',          currency: 'EUR', timezone: 'Europe/Madrid',     population: 48_000_000 },
  { code: 'IT', name: 'Italy',          currency: 'EUR', timezone: 'Europe/Rome',       population: 59_000_000 },
  { code: 'NL', name: 'Netherlands',    currency: 'EUR', timezone: 'Europe/Amsterdam',  population: 17_600_000 },
  { code: 'BE', name: 'Belgium',        currency: 'EUR', timezone: 'Europe/Brussels',   population: 11_700_000 },
  { code: 'PT', name: 'Portugal',       currency: 'EUR', timezone: 'Europe/Lisbon',     population: 10_300_000 },
  { code: 'AT', name: 'Austria',        currency: 'EUR', timezone: 'Europe/Vienna',     population: 9_100_000 },
  { code: 'CH', name: 'Switzerland',    currency: 'CHF', timezone: 'Europe/Zurich',     population: 8_800_000 },
  { code: 'PL', name: 'Poland',         currency: 'PLN', timezone: 'Europe/Warsaw',     population: 38_000_000 },
  { code: 'SE', name: 'Sweden',         currency: 'SEK', timezone: 'Europe/Stockholm',  population: 10_500_000 },
  { code: 'NO', name: 'Norway',         currency: 'NOK', timezone: 'Europe/Oslo',       population: 5_500_000 },
  { code: 'DK', name: 'Denmark',        currency: 'DKK', timezone: 'Europe/Copenhagen', population: 5_900_000 },
  { code: 'TR', name: 'Turkey',         currency: 'TRY', timezone: 'Europe/Istanbul',   population: 85_300_000 },
  { code: 'US', name: 'United States',  currency: 'USD', timezone: 'America/New_York',  population: 333_000_000 },
  { code: 'CA', name: 'Canada',         currency: 'CAD', timezone: 'America/Toronto',   population: 39_000_000 },
  { code: 'MX', name: 'Mexico',         currency: 'MXN', timezone: 'America/Mexico_City', population: 128_000_000 },
  { code: 'BR', name: 'Brazil',         currency: 'BRL', timezone: 'America/Sao_Paulo', population: 215_000_000 },
  { code: 'AR', name: 'Argentina',      currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', population: 46_000_000 },
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED', timezone: 'Asia/Dubai',  population: 9_900_000 },
  { code: 'SA', name: 'Saudi Arabia',   currency: 'SAR', timezone: 'Asia/Riyadh',       population: 36_000_000 },
  { code: 'EG', name: 'Egypt',          currency: 'EGP', timezone: 'Africa/Cairo',      population: 109_000_000 },
  { code: 'MA', name: 'Morocco',        currency: 'MAD', timezone: 'Africa/Casablanca', population: 37_000_000 },
  { code: 'NG', name: 'Nigeria',        currency: 'NGN', timezone: 'Africa/Lagos',      population: 218_000_000 },
  { code: 'ZA', name: 'South Africa',   currency: 'ZAR', timezone: 'Africa/Johannesburg', population: 60_000_000 },
  { code: 'JP', name: 'Japan',          currency: 'JPY', timezone: 'Asia/Tokyo',        population: 125_000_000 },
  { code: 'KR', name: 'South Korea',    currency: 'KRW', timezone: 'Asia/Seoul',        population: 52_000_000 },
  { code: 'CN', name: 'China',          currency: 'CNY', timezone: 'Asia/Shanghai',     population: 1_412_000_000 },
  { code: 'IN', name: 'India',          currency: 'INR', timezone: 'Asia/Kolkata',      population: 1_417_000_000 },
  { code: 'AU', name: 'Australia',      currency: 'AUD', timezone: 'Australia/Sydney',  population: 26_000_000 },
];

const REGIONS: ReadonlyArray<RegionSeed> = [
  { countryCode: 'DE', code: 'BY', name: 'Bavaria',           population: 13_400_000 },
  { countryCode: 'DE', code: 'NRW', name: 'North Rhine-Westphalia', population: 17_900_000 },
  { countryCode: 'DE', code: 'BW', name: 'Baden-Württemberg', population: 11_100_000 },
  { countryCode: 'DE', code: 'BE', name: 'Berlin',            population: 3_700_000 },
  { countryCode: 'GB', code: 'ENG', name: 'England',          population: 56_500_000 },
  { countryCode: 'GB', code: 'SCT', name: 'Scotland',         population: 5_500_000 },
  { countryCode: 'GB', code: 'WLS', name: 'Wales',            population: 3_100_000 },
  { countryCode: 'FR', code: 'IDF', name: 'Île-de-France',    population: 12_300_000 },
  { countryCode: 'ES', code: 'MD',  name: 'Madrid',           population: 6_700_000 },
  { countryCode: 'ES', code: 'CT',  name: 'Catalonia',        population: 7_700_000 },
  { countryCode: 'IT', code: 'LOM', name: 'Lombardy',         population: 10_000_000 },
  { countryCode: 'NL', code: 'NH',  name: 'North Holland',    population: 2_900_000 },
  { countryCode: 'US', code: 'CA',  name: 'California',       population: 39_000_000 },
  { countryCode: 'US', code: 'NY',  name: 'New York',         population: 19_500_000 },
  { countryCode: 'US', code: 'TX',  name: 'Texas',            population: 30_000_000 },
  { countryCode: 'US', code: 'FL',  name: 'Florida',          population: 22_000_000 },
  { countryCode: 'AE', code: 'DU',  name: 'Dubai',            population: 3_500_000 },
  { countryCode: 'AE', code: 'AD',  name: 'Abu Dhabi',        population: 2_800_000 },
  { countryCode: 'BR', code: 'SP',  name: 'São Paulo',        population: 46_000_000 },
];

function fullPathFor(countryCode: string, regionCode?: string): string {
  return regionCode
    ? `${countryCode.toLowerCase()}.${regionCode.toLowerCase()}`
    : countryCode.toLowerCase();
}

export async function seedSystemTerritories(): Promise<{ countries: number; regions: number }> {
  let countryCount = 0;
  let regionCount = 0;

  for (const c of COUNTRIES) {
    await prisma.territory.upsert({
      where: { fullPath: fullPathFor(c.code) },
      create: {
        type: 'COUNTRY',
        code: c.code,
        name: c.name,
        fullPath: fullPathFor(c.code),
        currency: c.currency,
        timezone: c.timezone,
        population: c.population,
      },
      update: {
        name: c.name,
        currency: c.currency,
        timezone: c.timezone,
        population: c.population,
      },
    });
    countryCount++;
  }

  for (const r of REGIONS) {
    const country = await prisma.territory.findUnique({
      where: { fullPath: fullPathFor(r.countryCode) },
    });
    if (!country) continue;
    await prisma.territory.upsert({
      where: { fullPath: fullPathFor(r.countryCode, r.code) },
      create: {
        type: 'REGION',
        code: r.code,
        name: r.name,
        fullPath: fullPathFor(r.countryCode, r.code),
        parentId: country.id,
        population: r.population ?? null,
      },
      update: {
        name: r.name,
        population: r.population ?? null,
      },
    });
    regionCount++;
  }

  return { countries: countryCount, regions: regionCount };
}
