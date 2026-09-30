// Cyber Defense, Step 10 — which backup is the newest one worth restoring
// ─────────────────────────────────────────────────────────────────────────────
// Reads the store's listing (with the Read Only restore key; listing names is
// all it does) and picks the newest backup that is complete: a `.fbk` object
// whose signed `.fbk.manifest.json` is beside it. A manifest is never a
// candidate, a `.fbk` without its manifest is skipped (an interrupted upload),
// and a name the drill would refuse is skipped too. Choosing is not trusting:
// the drill still verifies the manifest's signature, the hash, the size and
// the key before restoring anything.

import type { BackupStore, StoredObject } from './backup-store';

export class NoBackupError extends Error {
  constructor(message: string) { super(message); this.name = 'NoBackupError'; }
}

const BACKUP_KEY = /^[A-Za-z0-9._\-/]+\.fbk$/;
const MANIFEST_SUFFIX = '.manifest.json';

export interface LatestBackup { objectKey: string; lastModified: string; size: number; complete: number }

/** A key the drill accepts as a backup object (and so never a manifest). */
export function isBackupKey(key: string): boolean {
  return BACKUP_KEY.test(key) && !key.includes('..') && !key.startsWith('/') && !key.endsWith(MANIFEST_SUFFIX);
}

export function pickLatest(objects: StoredObject[]): LatestBackup {
  const names = new Set(objects.map((o) => o.key));
  const backups = objects.filter((o) => isBackupKey(o.key));
  if (backups.length === 0) throw new NoBackupError('no .fbk backup under the configured prefix');
  const complete = backups.filter((o) => o.size > 0 && names.has(`${o.key}${MANIFEST_SUFFIX}`));
  if (complete.length === 0) throw new NoBackupError('no complete backup: every .fbk found lacks its signed manifest');
  // Newest by the store's own time; the key (which starts with the UTC date
  // and time it was taken) breaks a tie.
  complete.sort((a, b) => (b.lastModified.getTime() - a.lastModified.getTime()) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const top = complete[0];
  return { objectKey: top.key, lastModified: top.lastModified.toISOString(), size: top.size, complete: complete.length };
}

export async function findLatestBackup(store: BackupStore): Promise<LatestBackup> {
  if (!store.list) throw new NoBackupError('this store cannot be listed');
  return pickLatest(await store.list());
}
