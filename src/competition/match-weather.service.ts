// Match weather — the integration boundary, and nothing behind it yet
// ─────────────────────────────────────────────────────────────────────────────
// The Match Center is built to show the weather at a venue at kickoff. No
// weather provider is configured for this platform, so it shows that it does
// not know — and this file is the one place a real provider is wired in when
// there is one.
//
// What it never does is invent a forecast. A temperature nobody measured, shown
// beside a kickoff a coach is planning around, is worse than a blank: it looks
// exactly like a fact. `describe()` returns null until `isConfigured()` is true,
// and the screen renders "Weather unavailable" from that null.

export interface WeatherReading {
  /** Celsius, as the provider reported it. */
  temperatureC: number;
  /** A provider-neutral token the interface maps to an icon. */
  condition: 'CLEAR' | 'CLOUDY' | 'RAIN' | 'SNOW' | 'STORM' | 'FOG' | 'WIND';
  /** The provider's own words, for the tooltip. */
  summary: string;
  /** Who said so, so a reading is always attributable. */
  provider: string;
  observedAt: string;
}

export interface WeatherQuery {
  venue: string | null;
  city: string | null;
  country: string | null;
  timeZone: string;
  kickoffAt: Date;
}

/**
 * Is there a provider to ask? Read from the environment rather than assumed, so
 * turning one on is configuration and not a deployment of new code.
 */
export function isConfigured(): boolean {
  return !!(process.env.WEATHER_PROVIDER && process.env.WEATHER_PROVIDER !== 'NONE');
}

/**
 * The reading for one fixture, or null when there is nothing to report.
 *
 * Null is the honest answer in three cases and they are deliberately not
 * distinguished to the caller: no provider configured, a provider that has no
 * forecast this far out, and a provider that failed. All three mean the same
 * thing to a coach — the platform does not know — and the screen says so.
 */
export async function describe(_query: WeatherQuery): Promise<WeatherReading | null> {
  if (!isConfigured()) return null;
  // A provider is named but no adapter has been written for it yet. Returning
  // null keeps the contract: the screen says the weather is unavailable rather
  // than showing something nobody measured.
  return null;
}
