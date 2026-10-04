/**
 * Published login credentials never come back.
 *
 * prisma/seed.ts used to hard-code the demo passwords and README.md listed them
 * next to their addresses. A production account seeded with one of them stayed
 * open to anybody who had read the repository. This pins the fix:
 *
 *   · neither password appears in any tracked file (this test spells them out
 *     only in pieces, and tests/login-form-hygiene keeps its own list);
 *   · the seed hashes no string literal, takes its passwords from the
 *     environment or generates them, and refuses production by default;
 *   · the README publishes no email/password pair.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// In pieces, so this file is not itself a copy of what it forbids.
const PUBLISHED = [['Familista', '2024!'].join(''), ['Coach', '2024!'].join('')];
// The one other place allowed to name them: the login-page hygiene test, whose
// whole purpose is to keep them out of what browsers receive.
const ALLOWED = new Set(['tests/login-form-hygiene.unit.test.ts']);

function trackedTextFiles(): string[] {
  const out = execSync('git ls-files -z', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  return out.split('\0').filter((f) => f && !ALLOWED.has(f)
    && !/\.(png|jpe?g|gif|webp|ico|zip|gz|pdf|mp4|mov|woff2?|ttf|otf|eot|bin|onnx|pt)$/i.test(f));
}

describe('published login credentials stay out of the repository', () => {
  it('no tracked file contains a password that was once published', () => {
    const hits: string[] = [];
    for (const f of trackedTextFiles()) {
      let text: string;
      try { text = read(f); } catch { continue; }
      for (const pw of PUBLISHED) if (text.includes(pw)) hits.push(f);
    }
    expect(hits).toEqual([]);
  });

  it('the seed hashes no literal password and takes them from the environment', () => {
    const seed = read('prisma/seed.ts');
    expect(seed).not.toMatch(/bcrypt\.hash\(\s*['"`]/);
    expect(seed).toContain("seedPassword('SEED_ADMIN_PASSWORD'");
    expect(seed).toContain("seedPassword('SEED_COACH_PASSWORD'");
    expect(seed).toContain("randomBytes(18).toString('base64url')");
  });

  it('the seed refuses a production database unless explicitly allowed and given every password', () => {
    const seed = read('prisma/seed.ts');
    expect(seed).toMatch(/IS_PRODUCTION && process\.env\.SEED_ALLOW_PRODUCTION !== 'true'[\s\S]{0,40}throw new Error/);
    expect(seed).toMatch(/if \(IS_PRODUCTION\) throw new Error\(`\$\{envName\} is required to seed production\.`\)/);
  });

  it('no stale compiled seed carries its own copy', () => {
    for (const f of ['prisma/seed.js', 'prisma/seed.js.js']) expect(fs.existsSync(path.join(ROOT, f))).toBe(false);
  });

  it('the README publishes no email/password pair', () => {
    const readme = read('README.md');
    expect(readme).not.toMatch(/\|\s*[^|\s]+@[^|\s]+\s*\|\s*[^|\s]{6,}\s*\|/);
    expect(readme).not.toMatch(/\|\s*Password\s*\|/i);
  });
});
