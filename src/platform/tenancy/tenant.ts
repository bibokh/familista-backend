/**
 * Familista tenancy (Creator Studio, P2) — who owns a Design Studio or manufacturing record: one club, or one creator.
 *
 * Every such row has exactly one owner (the database holds it: a CHECK on every table, composite keys from each child to
 * its parent and that parent's owner, and row-level security by either). A service takes the tenant the routes resolved
 * from the session — the signed-in user's own club, or the signed-in creator — never one a request names, and every
 * query it makes carries it: a row of another tenant is not found, whatever its id.
 */

export type Tenant =
  | { readonly kind: 'club'; readonly clubId: string }
  | { readonly kind: 'creator'; readonly creatorId: string };

export function clubTenant(clubId: string): Tenant {
  if (typeof clubId !== 'string' || !clubId) throw new Error('A club tenant needs the club');
  return Object.freeze({ kind: 'club' as const, clubId });
}

export function creatorTenant(creatorId: string): Tenant {
  if (typeof creatorId !== 'string' || !creatorId) throw new Error('A creator tenant needs the creator');
  return Object.freeze({ kind: 'creator' as const, creatorId });
}

/** The filter every query of a tenant's rows carries. */
export function tenantWhere(t: Tenant): { clubId: string } | { creatorId: string } {
  return t.kind === 'club' ? { clubId: t.clubId } : { creatorId: t.creatorId };
}

/** The owner columns a new row is written with: exactly one of them set. */
export function ownerColumns(t: Tenant): { clubId: string | null; creatorId: string | null } {
  return t.kind === 'club' ? { clubId: t.clubId, creatorId: null } : { clubId: null, creatorId: t.creatorId };
}

/** The tenant a stored row belongs to. A row with neither owner (or both) is refused: the database never holds one. */
export function tenantOf(row: { clubId: string | null; creatorId: string | null }): Tenant {
  if (row.clubId && !row.creatorId) return clubTenant(row.clubId);
  if (row.creatorId && !row.clubId) return creatorTenant(row.creatorId);
  throw new Error('A tenant row has exactly one owner');
}

/** The club, when the tenant is one; null for a creator. */
export function clubIdOf(t: Tenant): string | null { return t.kind === 'club' ? t.clubId : null; }
export function creatorIdOf(t: Tenant): string | null { return t.kind === 'creator' ? t.creatorId : null; }
