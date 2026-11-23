/**
 * Familista Design Studio — the team roster core, on the server (M3).
 *
 * The server validates a roster with the very file the editor runs: public/product-design/pd-roster.js (pure,
 * deterministic, no DOM, no clock). One validator, so an entry the server stores is one the editor shows, and nothing
 * the editor refuses can be stored. Read once, from the repository's public directory.
 */
import path from 'path';

/** One entry of a roster, as pd-roster.js keeps it. */
export interface RosterEntry {
  name: string;
  number: number | null;
  top: string | null;
  shorts: string | null;
  socks: string | null;
  qty: number;
}

/** Sets per size for each form, weighted by quantity, and the sets with no size given (pd-roster.js summary). */
export interface RosterSummary {
  entries: number;
  sets: number;
  sizes: Record<'top' | 'shorts' | 'socks', Array<{ size: string; sets: number }>>;
  unsized: Record<'top' | 'shorts' | 'socks', number>;
}

interface PdRoster {
  LIMITS: { entries: number; name: number; rosterName: number; qty: number; number: number; csvBytes: number };
  validateEntries(input: unknown): RosterEntry[];
  validateRosterName(input: unknown): string;
  summary(entries: RosterEntry[]): RosterSummary;
}

const FILE = path.join(__dirname, '..', '..', '..', 'public', 'product-design', 'pd-roster.js');
let loaded: PdRoster | null = null;
function core(): PdRoster {
  // The editor's own core, required as the CommonJS module its UMD wrapper exports.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  if (!loaded) loaded = require(FILE) as PdRoster;
  return loaded;
}

/** A roster the core refused: its code and the path it is about. */
export class RosterInvalidError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, at: string) {
    super(`${code} at ${at || 'roster'}`);
    this.name = 'RosterInvalidError';
    this.code = code;
    this.path = at;
  }
}

function checked<T>(work: () => T): T {
  try { return work(); } catch (err) {
    const e = err as { name?: unknown; code?: unknown; path?: unknown };
    if (e && e.name === 'RosterError' && typeof e.code === 'string') throw new RosterInvalidError(e.code, String(e.path || ''));
    throw err;
  }
}

/** The roster's limits, for the routes' own envelope checks. */
export function rosterLimits(): PdRoster['LIMITS'] { return core().LIMITS; }
/** The entries as kept. Throws RosterInvalidError. */
export function validateRosterEntries(input: unknown): RosterEntry[] { return checked(() => core().validateEntries(input)); }
/** What a roster amounts to, by the editor's own rule. */
export function rosterSummary(entries: RosterEntry[]): RosterSummary { return core().summary(entries); }
/** The roster's name as kept. Throws RosterInvalidError. */
export function validateRosterName(input: unknown): string { return checked(() => core().validateRosterName(input)); }
