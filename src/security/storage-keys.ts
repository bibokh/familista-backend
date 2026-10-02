// Every object written to storage sits under its owner's prefix (Cyber Defense, R10)
// ─────────────────────────────────────────────────────────────────────────────
// Two key schemes carry a club, and both are checked here:
//
//   club/<clubId>/…    the Data Fabric's media (fabric/media/object-store.ts)
//   clubs/<clubId>/…   video: raw uploads, HLS output, thumbnails
//
// plus two owners that are not a club directly:
//
//   whitelabel/<configId>/…   a club's white-label assets; the config is the
//                             club's own (WhiteLabelConfig.clubId is unique)
//   year=YYYY/…               the Data Fabric's cold archive — platform data,
//                             written only by the archive exporter
//
// `assertStorageKey` is applied by every adapter on every put and delete (the
// shape and the root), and `assertClubKey` / `assertWhiteLabelKey` by every
// writer that knows whose object it is writing. A key outside these roots, a
// key for another club, or a key that tries to climb out of its folder is
// refused before the store is asked.

import { ForbiddenError } from '../utils/errors';

const SEGMENT = /^[A-Za-z0-9._=-]+$/;
const MAX_KEY = 1024;

export class StorageKeyRefused extends ForbiddenError {
  constructor(reason: string) { super(`Storage key refused: ${reason}`); this.name = 'StorageKeyRefused'; }
}

/** Relative, no empty or dot segments, a safe alphabet, a sane length. */
export function isWellFormedKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY) return false;
  if (key.startsWith('/') || key.endsWith('/')) return false;
  return key.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..' && SEGMENT.test(s));
}

/** The club a key belongs to under either club scheme, else null. */
export function clubOfKey(key: string): string | null {
  const m = /^clubs?\/([A-Za-z0-9._-]+)\/./.exec(key);
  return m ? m[1] : null;
}

/** The owning root of a key, or null when it is under none of them. */
export function rootOfKey(key: string): 'club' | 'whitelabel' | 'archive' | null {
  if (clubOfKey(key)) return 'club';
  if (/^whitelabel\/[A-Za-z0-9._-]+\/./.test(key)) return 'whitelabel';
  if (/^year=\d{4}\/./.test(key)) return 'archive';
  return null;
}

/** Every adapter, every put and delete: a well-formed key under a known root. */
export function assertStorageKey(key: unknown): asserts key is string {
  if (!isWellFormedKey(key)) throw new StorageKeyRefused('malformed key');
  if (!rootOfKey(key)) throw new StorageKeyRefused('not under a club, white-label or archive prefix');
}

/** A writer that knows the club: the key must be that club's. */
export function assertClubKey(key: unknown, clubId: string | null | undefined): asserts key is string {
  assertStorageKey(key);
  if (!clubId) throw new StorageKeyRefused('no club for a club object');
  if (clubOfKey(key) !== clubId) throw new StorageKeyRefused('the key is not under this club\'s prefix');
}

/** A white-label writer: the key must be under this (club-owned) config's folder. */
export function assertWhiteLabelKey(key: unknown, configId: string): asserts key is string {
  assertStorageKey(key);
  if (!key.startsWith(`whitelabel/${configId}/`)) throw new StorageKeyRefused('the key is not under this club\'s white-label prefix');
}
