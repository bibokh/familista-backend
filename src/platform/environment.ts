// Which Familista this process is
// ─────────────────────────────────────────────────────────────────────────────
// One codebase runs in several worlds, and a great deal of the platform's
// safety rests on each of them knowing which it is:
//
//   PRODUCTION  the clubs' Familista. Real people, real data.
//   STAGING     a rehearsal of production.
//   LAB         the owner's workshop. Experiments live here and are invisible
//               everywhere else by default.
//   PREVIEW     a branch, deployed for a look.
//
// Resolved from the environment, never from a request: a header claiming to be
// the Lab is a request from the internet, not a fact about this process.

export type FamilistaEnvironment = 'PRODUCTION' | 'STAGING' | 'LAB' | 'PREVIEW';

const VALID: FamilistaEnvironment[] = ['PRODUCTION', 'STAGING', 'LAB', 'PREVIEW'];

/**
 * The environment this process runs in.
 *
 * `FAMILISTA_ENV` decides when it is set. Otherwise NODE_ENV=production means
 * PRODUCTION and anything else means PREVIEW — never LAB, because defaulting to
 * the Lab would make experimental code visible on a box nobody labelled.
 */
export function currentEnvironment(env: NodeJS.ProcessEnv = process.env): FamilistaEnvironment {
  const named = String(env.FAMILISTA_ENV ?? '').toUpperCase();
  if ((VALID as string[]).includes(named)) return named as FamilistaEnvironment;
  return env.NODE_ENV === 'production' ? 'PRODUCTION' : 'PREVIEW';
}

export function isProduction(env?: NodeJS.ProcessEnv): boolean {
  return currentEnvironment(env) === 'PRODUCTION';
}

export function isLab(env?: NodeJS.ProcessEnv): boolean {
  return currentEnvironment(env) === 'LAB';
}
