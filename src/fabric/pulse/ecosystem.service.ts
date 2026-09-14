// Familista — the ecosystem footprint behind the Live Data Flow board
// ─────────────────────────────────────────────────────────────────────────────
// "Five continents, twenty-eight countries, two thousand clubs" is the kind of
// line a dashboard invents. This file exists so that it cannot: every figure
// below is a COUNT over a real table, and the geography is derived from the
// `country` column clubs already carry rather than from a number somebody liked
// the look of.
//
// WHAT IS MEASURED AND WHAT IS DERIVED
//
//   clubs       COUNT(Club). One aggregate, one table — the SAME definition
//               `platformOverview` uses for "Total Clubs", so the two screens
//               cannot disagree about how many clubs Familista has.
//   people      COUNT(User). One aggregate, one table.
//   countries   COUNT(DISTINCT Club.country). A decision — a country with one
//               club counts the same as a country with four hundred — so it
//               travels with its definition.
//   continents  the distinct continents of the countries the ATLAS below can
//               place. A country the atlas does not know is counted in
//               `countries`, named in `unplaced`, and cannot raise this number.
//               So this is a floor, and it says so.
//
// WHY AN ATLAS AT ALL
//
// `Club.country` is free text. To draw a club on a map something has to turn
// "Germany" into a coordinate, and the only honest way is a reference table
// that is obviously reference data: a country's continent and its approximate
// centroid are facts about the world, not measurements of Familista. A country
// the table does not carry is never guessed at and never plotted — it appears
// in `unplaced` so the interface can say how many clubs it could not place.
//
// The coordinate is a COUNTRY centroid, deliberately. Familista does not need,
// and this endpoint must never return, the position of a person.

import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';

export interface EcosystemRegion {
  /** The country exactly as the club records it. */
  country: string;
  /** The continent the atlas places it on, or null when it does not know it. */
  continent: string | null;
  clubs: number;
  /** Approximate country centroid, or null when the atlas cannot place it. */
  lat: number | null;
  lon: number | null;
}

export interface EcosystemFootprint {
  generatedAt: string;
  /** Every figure is null when its table could not be read — never zero. */
  clubs: number | null;
  people: number | null;
  countries: number | null;
  /** A floor: only countries the atlas can place contribute. */
  continents: number | null;
  regions: EcosystemRegion[];
  /** Countries the atlas cannot place, named rather than silently dropped. */
  unplaced: string[];
  /** One line per figure, so the screen can say what it is showing. */
  how: Record<string, string>;
}

/**
 * Country → continent and approximate centroid.
 *
 * Reference data. Extending it is a geography edit, not a product decision, and
 * an absent country degrades to "counted but not plotted" rather than to a
 * wrong pin. Keys are lower-cased and punctuation-stripped by `normalise`, so
 * "United Kingdom", "united kingdom" and "UNITED-KINGDOM" all resolve.
 */
const ATLAS: Record<string, { continent: string; lat: number; lon: number }> = {
  // ── Europe
  albania: { continent: 'Europe', lat: 41.0, lon: 20.0 },
  austria: { continent: 'Europe', lat: 47.5, lon: 14.5 },
  belarus: { continent: 'Europe', lat: 53.7, lon: 28.0 },
  belgium: { continent: 'Europe', lat: 50.6, lon: 4.6 },
  bosniaandherzegovina: { continent: 'Europe', lat: 44.0, lon: 18.0 },
  bulgaria: { continent: 'Europe', lat: 42.8, lon: 25.3 },
  croatia: { continent: 'Europe', lat: 45.1, lon: 15.5 },
  cyprus: { continent: 'Europe', lat: 35.1, lon: 33.2 },
  czechia: { continent: 'Europe', lat: 49.8, lon: 15.5 },
  czechrepublic: { continent: 'Europe', lat: 49.8, lon: 15.5 },
  denmark: { continent: 'Europe', lat: 56.0, lon: 10.0 },
  estonia: { continent: 'Europe', lat: 58.7, lon: 25.5 },
  finland: { continent: 'Europe', lat: 62.5, lon: 26.0 },
  france: { continent: 'Europe', lat: 46.6, lon: 2.4 },
  germany: { continent: 'Europe', lat: 51.2, lon: 10.4 },
  greece: { continent: 'Europe', lat: 39.1, lon: 22.0 },
  hungary: { continent: 'Europe', lat: 47.2, lon: 19.4 },
  iceland: { continent: 'Europe', lat: 64.9, lon: -18.6 },
  ireland: { continent: 'Europe', lat: 53.2, lon: -8.0 },
  italy: { continent: 'Europe', lat: 42.8, lon: 12.6 },
  kosovo: { continent: 'Europe', lat: 42.6, lon: 20.9 },
  latvia: { continent: 'Europe', lat: 56.9, lon: 24.6 },
  lithuania: { continent: 'Europe', lat: 55.2, lon: 23.9 },
  luxembourg: { continent: 'Europe', lat: 49.8, lon: 6.1 },
  malta: { continent: 'Europe', lat: 35.9, lon: 14.4 },
  moldova: { continent: 'Europe', lat: 47.2, lon: 28.5 },
  montenegro: { continent: 'Europe', lat: 42.7, lon: 19.4 },
  netherlands: { continent: 'Europe', lat: 52.2, lon: 5.3 },
  northmacedonia: { continent: 'Europe', lat: 41.6, lon: 21.7 },
  norway: { continent: 'Europe', lat: 62.0, lon: 9.5 },
  poland: { continent: 'Europe', lat: 52.1, lon: 19.4 },
  portugal: { continent: 'Europe', lat: 39.6, lon: -8.0 },
  romania: { continent: 'Europe', lat: 45.9, lon: 25.0 },
  russia: { continent: 'Europe', lat: 56.0, lon: 40.0 },
  serbia: { continent: 'Europe', lat: 44.2, lon: 20.9 },
  slovakia: { continent: 'Europe', lat: 48.7, lon: 19.5 },
  slovenia: { continent: 'Europe', lat: 46.1, lon: 14.8 },
  spain: { continent: 'Europe', lat: 40.2, lon: -3.6 },
  sweden: { continent: 'Europe', lat: 62.0, lon: 15.5 },
  switzerland: { continent: 'Europe', lat: 46.8, lon: 8.2 },
  turkey: { continent: 'Europe', lat: 39.0, lon: 35.0 },
  ukraine: { continent: 'Europe', lat: 49.0, lon: 31.5 },
  unitedkingdom: { continent: 'Europe', lat: 54.0, lon: -2.4 },
  england: { continent: 'Europe', lat: 52.5, lon: -1.5 },
  scotland: { continent: 'Europe', lat: 56.8, lon: -4.2 },
  wales: { continent: 'Europe', lat: 52.3, lon: -3.7 },
  northernireland: { continent: 'Europe', lat: 54.6, lon: -6.6 },

  // ── Africa
  algeria: { continent: 'Africa', lat: 28.0, lon: 2.6 },
  angola: { continent: 'Africa', lat: -11.2, lon: 17.9 },
  cameroon: { continent: 'Africa', lat: 5.7, lon: 12.7 },
  ivorycoast: { continent: 'Africa', lat: 7.5, lon: -5.5 },
  cotedivoire: { continent: 'Africa', lat: 7.5, lon: -5.5 },
  drcongo: { continent: 'Africa', lat: -3.0, lon: 23.6 },
  egypt: { continent: 'Africa', lat: 26.8, lon: 30.8 },
  ethiopia: { continent: 'Africa', lat: 9.1, lon: 40.5 },
  ghana: { continent: 'Africa', lat: 7.9, lon: -1.0 },
  kenya: { continent: 'Africa', lat: 0.2, lon: 37.9 },
  libya: { continent: 'Africa', lat: 26.3, lon: 17.2 },
  morocco: { continent: 'Africa', lat: 31.8, lon: -7.1 },
  nigeria: { continent: 'Africa', lat: 9.1, lon: 8.7 },
  senegal: { continent: 'Africa', lat: 14.5, lon: -14.5 },
  southafrica: { continent: 'Africa', lat: -28.5, lon: 24.7 },
  tanzania: { continent: 'Africa', lat: -6.4, lon: 34.9 },
  tunisia: { continent: 'Africa', lat: 33.9, lon: 9.6 },
  uganda: { continent: 'Africa', lat: 1.4, lon: 32.3 },
  zambia: { continent: 'Africa', lat: -13.1, lon: 27.8 },

  // ── Asia
  china: { continent: 'Asia', lat: 35.9, lon: 104.2 },
  india: { continent: 'Asia', lat: 21.0, lon: 78.9 },
  indonesia: { continent: 'Asia', lat: -2.5, lon: 118.0 },
  iran: { continent: 'Asia', lat: 32.4, lon: 53.7 },
  iraq: { continent: 'Asia', lat: 33.2, lon: 43.7 },
  israel: { continent: 'Asia', lat: 31.4, lon: 35.0 },
  japan: { continent: 'Asia', lat: 36.2, lon: 138.3 },
  jordan: { continent: 'Asia', lat: 30.6, lon: 36.2 },
  kazakhstan: { continent: 'Asia', lat: 48.0, lon: 66.9 },
  malaysia: { continent: 'Asia', lat: 4.2, lon: 102.0 },
  pakistan: { continent: 'Asia', lat: 30.4, lon: 69.3 },
  philippines: { continent: 'Asia', lat: 12.9, lon: 121.8 },
  qatar: { continent: 'Asia', lat: 25.4, lon: 51.2 },
  saudiarabia: { continent: 'Asia', lat: 23.9, lon: 45.1 },
  singapore: { continent: 'Asia', lat: 1.35, lon: 103.8 },
  southkorea: { continent: 'Asia', lat: 36.5, lon: 127.9 },
  korea: { continent: 'Asia', lat: 36.5, lon: 127.9 },
  thailand: { continent: 'Asia', lat: 15.9, lon: 101.0 },
  unitedarabemirates: { continent: 'Asia', lat: 24.0, lon: 54.0 },
  uae: { continent: 'Asia', lat: 24.0, lon: 54.0 },
  uzbekistan: { continent: 'Asia', lat: 41.4, lon: 64.6 },
  vietnam: { continent: 'Asia', lat: 14.1, lon: 108.3 },

  // ── North & Central America
  canada: { continent: 'North America', lat: 56.1, lon: -106.3 },
  costarica: { continent: 'North America', lat: 9.7, lon: -83.8 },
  cuba: { continent: 'North America', lat: 21.5, lon: -77.8 },
  jamaica: { continent: 'North America', lat: 18.1, lon: -77.3 },
  mexico: { continent: 'North America', lat: 23.6, lon: -102.6 },
  panama: { continent: 'North America', lat: 8.5, lon: -80.8 },
  unitedstates: { continent: 'North America', lat: 39.8, lon: -98.6 },
  usa: { continent: 'North America', lat: 39.8, lon: -98.6 },
  unitedstatesofamerica: { continent: 'North America', lat: 39.8, lon: -98.6 },

  // ── South America
  argentina: { continent: 'South America', lat: -38.4, lon: -63.6 },
  bolivia: { continent: 'South America', lat: -16.3, lon: -63.6 },
  brazil: { continent: 'South America', lat: -14.2, lon: -51.9 },
  chile: { continent: 'South America', lat: -35.7, lon: -71.5 },
  colombia: { continent: 'South America', lat: 4.6, lon: -74.3 },
  ecuador: { continent: 'South America', lat: -1.8, lon: -78.2 },
  paraguay: { continent: 'South America', lat: -23.4, lon: -58.4 },
  peru: { continent: 'South America', lat: -9.2, lon: -75.0 },
  uruguay: { continent: 'South America', lat: -32.5, lon: -55.8 },
  venezuela: { continent: 'South America', lat: 6.4, lon: -66.6 },

  // ── Oceania
  australia: { continent: 'Oceania', lat: -25.3, lon: 133.8 },
  newzealand: { continent: 'Oceania', lat: -41.0, lon: 174.9 },
};

/** Free text to an atlas key. Case, spacing and punctuation are not data. */
function normalise(country: string): string {
  return String(country ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

export function placeCountry(country: string): { continent: string; lat: number; lon: number } | null {
  return ATLAS[normalise(country)] ?? null;
}

/** How many countries the atlas carries. Used by the test that pins its shape. */
export const ATLAS_SIZE = Object.keys(ATLAS).length;

/**
 * One read, cached briefly.
 *
 * An owner watching the board must not be a load on the database: the footprint
 * changes when a club is created, which is a rare event, so a minute-old answer
 * is a correct answer. The cache is per-process and deliberately tiny.
 */
const TTL_MS = 60_000;
let cache: { at: number; value: EcosystemFootprint } | null = null;

export function resetEcosystemCache(): void {
  cache = null;
}

export async function ecosystemFootprint(): Promise<EcosystemFootprint> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.value;

  const how = {
    clubs: 'COUNT(Club) — the same definition the Platform Command Center uses',
    people: 'COUNT(User)',
    countries: 'COUNT(DISTINCT Club.country) — a country with one club counts once',
    continents: 'distinct continents of the countries the atlas can place — a floor, not a total',
    regions: 'clubs grouped by their recorded country; plotted at the country centroid, never a person',
  };

  let grouped: Array<{ country: string; clubs: number }> = [];
  let clubs: number | null = null;
  let people: number | null = null;

  try {
    const rows = await prisma.club.groupBy({
      by: ['country'],
      _count: { _all: true },
    });
    grouped = rows
      .map((r) => ({ country: String(r.country ?? '').trim(), clubs: r._count._all }))
      .filter((r) => r.country.length > 0)
      .sort((a, b) => b.clubs - a.clubs);
    clubs = grouped.reduce((sum, r) => sum + r.clubs, 0);
  } catch (err) {
    logger.warn('[ecosystem] could not group clubs by country', { err: (err as Error).message });
  }

  try {
    people = await prisma.user.count();
  } catch (err) {
    logger.warn('[ecosystem] could not count users', { err: (err as Error).message });
  }

  const regions: EcosystemRegion[] = grouped.map((r) => {
    const place = placeCountry(r.country);
    return {
      country: r.country,
      continent: place ? place.continent : null,
      clubs: r.clubs,
      lat: place ? place.lat : null,
      lon: place ? place.lon : null,
    };
  });

  const unplaced = regions.filter((r) => r.continent === null).map((r) => r.country);
  const continents = new Set(regions.map((r) => r.continent).filter((c): c is string => c !== null));

  const value: EcosystemFootprint = {
    generatedAt: new Date().toISOString(),
    clubs,
    people,
    countries: grouped.length ? grouped.length : clubs === null ? null : 0,
    continents: grouped.length ? continents.size : clubs === null ? null : 0,
    regions,
    unplaced,
    how,
  };

  cache = { at: now, value };
  return value;
}
