/**
 * Cyber Defense · Step 9 follow-up — every dependency from the official registry
 *
 * The lockfile used to resolve 332 of its 579 packages through a third-party
 * mirror. They now resolve from registry.npmjs.org, with the same versions and
 * the same sha512 integrity (checked against the official registry before the
 * change and again by a clean `npm ci`). This keeps it that way.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const entries = Object.entries(lock.packages as Record<string, { resolved?: string; integrity?: string; version?: string; link?: boolean }>)
  .filter(([k]) => k.startsWith('node_modules/'));

describe('the lockfile', () => {
  it('resolves every package from registry.npmjs.org, over https', () => {
    const elsewhere = entries.filter(([, p]) => !p.link && !String(p.resolved).startsWith('https://registry.npmjs.org/'));
    expect(elsewhere.map(([k]) => k)).toEqual([]);
  });

  it('pins a sha512 integrity for every package', () => {
    const weak = entries.filter(([, p]) => !p.link && !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(p.integrity)));
    expect(weak.map(([k]) => k)).toEqual([]);
  });

  it('every resolved URL is the canonical tarball for that exact name and version', () => {
    for (const [k, p] of entries.filter(([, e]) => !e.link)) {
      const name = k.split('node_modules/').pop()!;
      const base = name.split('/').pop();
      expect(p.resolved).toBe(`https://registry.npmjs.org/${name}/-/${base}-${p.version}.tgz`);
    }
  });

  it('mentions no mirror anywhere', () => {
    expect(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).not.toMatch(/npmmirror|taobao|cnpm/i);
  });
});

describe('.npmrc', () => {
  const rc = fs.readFileSync(path.join(ROOT, '.npmrc'), 'utf8');
  const settings = rc.split('\n').filter((l) => l.trim() && !/^\s*[#;]/.test(l));

  it('pins the official registry and nothing else', () => {
    expect(settings).toEqual(['registry=https://registry.npmjs.org/']);
  });

  it('holds no credential', () => {
    expect(rc).not.toMatch(/_authToken|_auth\s*=|_password|\/\/[^\n]*:_/);
  });
});
