/**
 * tests/login-form-hygiene.unit.test.ts
 *
 * No sign-in screen ships with somebody's credentials in it.
 *
 * Every served copy of Familista's login form used to carry a real account's
 * address AND its working password as `value` attributes, plus a block that
 * printed two accounts' credentials in full. That is not a stale placeholder:
 * it is a live credential disclosure on a public page, handed to every visitor
 * and to every newly invited club president.
 *
 * This suite is a ratchet. It walks every HTML and JS file a browser can
 * actually be served and fails if a credential reappears in one — including in
 * a copy nobody remembered to update, which is exactly how this survived across
 * four files.
 *
 * Seed and repair scripts are deliberately out of scope. They legitimately name
 * the demo account, they are never sent to a browser, and rewriting them would
 * break the seeding they exist to do.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * Everything a browser is served.
 *
 * Enumerated by walking the tree rather than listed by hand: a fifth copy
 * appearing tomorrow is caught by the same test that caught the first four.
 */
function servedFiles(): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage', 'prisma', 'scripts', 'tests', 'src']);

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(rel);
      } else if (/\.(html|js)$/.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  walk('');
  return out;
}

/** Credentials that were, at one point, shipped to browsers. */
const LEAKED_CREDENTIALS = ['Familista2024!', 'Coach2024!'];
/** A real person's address, which is not a placeholder. */
const REAL_ADDRESSES = ['khatab@familista.io', 'coach@familista.io'];

const FILES = servedFiles();
/**
 * The pages that actually CONTAIN the sign-in markup.
 *
 * Matched on the input element, not on the id: several scripts reference
 * `login-email` to read the field, and a script is not a page that ships a
 * value.
 */
const LOGIN_PAGES = FILES.filter((f) => f.endsWith('.html') && read(f).includes('id="login-email"'));

/**
 * The main application's sign-in form, in each copy that ships it.
 *
 * Distinct from LOGIN_PAGES, which also includes the separate admin console —
 * a different form that never carried a credential and has its own markup. The
 * universal rules (no value attribute, no credential, autocomplete hints) apply
 * to every page; the rules below about the demo block and the prefill helper
 * are about this form specifically.
 */
const SPA_PAGES = LOGIN_PAGES.filter((f) => read(f).includes('class="login-input"'));

/** Where the prefill helper lives for each SPA copy: inline, or in app.js. */
const HELPER_SOURCES = ['frontend/index.html', 'frontend/familista_v5.html', 'familista_v5.html', 'public/app.js'];

/** Just the helper, so an assertion cannot drift into unrelated code. */
function helperOf(file: string): string {
  const body = read(file);
  const start = body.indexOf('// ── Login field hygiene');
  expect(`${file} has the helper: ${start >= 0}`).toBe(`${file} has the helper: true`);
  const end = body.indexOf('function doLogout', start);
  const anchor = body.indexOf('async function doLogin', start);
  const stop = [end, anchor].filter((n) => n > start).sort((a, b) => a - b)[0] ?? start + 3500;
  return body.slice(start, stop);
}

describe('no served file carries a credential', () => {
  it('finds the login form in every copy, so nothing is silently skipped', () => {
    // Four copies existed when this was written. The point is that the count
    // is discovered, not asserted — a new one is covered automatically.
    expect(LOGIN_PAGES.length).toBeGreaterThanOrEqual(4);
    for (const f of LOGIN_PAGES) expect(read(f)).toContain('id="login-email"');
  });

  it('ships no password anywhere a browser can read it', () => {
    const offenders = FILES.filter((f) => {
      const body = read(f);
      return LEAKED_CREDENTIALS.some((c) => body.includes(c));
    });
    expect(offenders).toEqual([]);
  });

  it('and no real person\'s address', () => {
    const offenders = FILES.filter((f) => {
      const body = read(f);
      return REAL_ADDRESSES.some((a) => body.includes(a));
    });
    expect(offenders).toEqual([]);
  });
});

describe('the login form starts empty', () => {
  it('has no value attribute on the email or password field', () => {
    for (const file of LOGIN_PAGES) {
      const body = read(file);
      for (const id of ['login-email', 'login-password']) {
        const tag = body.slice(body.indexOf(`id="${id}"`));
        const input = tag.slice(0, tag.indexOf('>') + 1);
        expect(`${file} ${id}: ${/\svalue=/.test(input)}`).toBe(`${file} ${id}: false`);
      }
    }
  });

  it('uses a neutral placeholder, not somebody\'s address', () => {
    for (const file of SPA_PAGES) {
      const body = read(file);
      const tag = body.slice(body.indexOf('id="login-email"'));
      const input = tag.slice(0, tag.indexOf('>') + 1);
      const placeholder = /placeholder="([^"]*)"/.exec(input)?.[1] ?? '';
      // A placeholder that is a real address is still that address on a
      // public page.
      expect(`${file}: ${placeholder}`).toBe(`${file}: you@club.com`);
    }
  });

  it('and is emptied on load, before anything else runs', () => {
    for (const file of SPA_PAGES) {
      const body = read(file);
      const hasHelper = body.includes('famClearLoginForm')
        // public/index.html carries the markup; public/app.js carries its code.
        || (file === 'public/index.html' && read('public/app.js').includes('famClearLoginForm'));
      expect(`${file}: ${hasHelper}`).toBe(`${file}: true`);
    }
    for (const source of HELPER_SOURCES) {
      // Cleared first, then the one permitted prefill — browsers restore input
      // values on a soft reload, so clearing is not redundant.
      const helper = helperOf(source);
      const clearAt = helper.search(/(window\.)?famClearLoginForm\(\);/g);
      const fillAt = helper.search(/(famPrefillInvitedEmail|prefillFromInvitation)\(\);/);
      expect(`${source} clears: ${clearAt >= 0}`).toBe(`${source} clears: true`);
      expect(`${source} then fills: ${fillAt > clearAt}`).toBe(`${source} then fills: true`);
    }
  });
});

describe('signing out leaves nothing of the last person behind', () => {
  it('clears the form on logout, in every copy', () => {
    for (const file of ['frontend/index.html', 'frontend/familista_v5.html', 'familista_v5.html', 'public/app.js']) {
      const body = read(file);
      const logout = body.slice(body.indexOf('function doLogout'), body.indexOf('function doLogout') + 2500);
      expect(`${file}: ${logout.includes('famClearLoginForm')}`).toBe(`${file}: true`);
    }
  });
});

describe('the one permitted prefill carries no secret', () => {
  const sources = ['frontend/index.html', 'frontend/familista_v5.html', 'familista_v5.html', 'public/app.js'];

  it('reads the address from the fragment, never a query string', () => {
    for (const file of sources) {
      const body = read(file);
      // A fragment is never sent to a server, never in a Referer, never in an
      // access log. A query string is visible to all three.
      expect(`${file}: ${body.includes("String(window.location.hash || '').replace(/^#/, '')")}`).toBe(`${file}: true`);
      // The address is read from the hash and from nowhere else. `search` does
      // appear in the helper — in the replaceState that PRESERVES the query
      // while erasing the fragment — so what is pinned is that nothing reads
      // an email out of it.
      const helper = helperOf(file);
      expect(`${file}: ${/get\('email'\)/.test(helper)}`).toBe(`${file}: true`);
      expect(`${file}: ${/URLSearchParams\([^)]*location\.search/.test(helper)}`).toBe(`${file}: false`);
      expect(`${file}: ${/location\.search[\s\S]{0,60}get\('email'\)/.test(helper)}`).toBe(`${file}: false`);
    }
  });

  it('accepts only something shaped like an address, and only into the email field', () => {
    for (const file of sources) {
      const body = read(file);
      expect(body).toMatch(/\/\^\[\^@\\s\]\+@\[\^@\\s\]\+\\\.\[\^@\\s\]\+\$\/\.test\(email\)/);
    }
    // The prefill never puts anything INTO the password field — it only moves
    // the cursor there. The single assignment to a password value in the
    // helper is famClearLoginForm emptying it.
    for (const file of sources) {
      const helper = helperOf(file);
      const assignments = helper.match(/password\.value\s*=\s*[^;]+/g) || [];
      for (const assignment of assignments) {
        expect(`${file}: ${assignment.trim()}`).toMatch(/password\.value = ''$/);
      }
      expect(`${file}: ${helper.includes('password.focus()')}`).toBe(`${file}: true`);
    }
  });

  it('erases the fragment once it has been used', () => {
    for (const file of sources) {
      expect(`${file}: ${read(file).includes('history.replaceState({}, document.title, window.location.pathname')}`)
        .toBe(`${file}: true`);
    }
  });

  it('and the invitation page hands it over that way, with no credential attached', () => {
    const invite = read('public/invite/invite.js');
    expect(invite).toContain("appUrl() + '#email=' + encodeURIComponent(preview.email)");
    // No token, no password, no session travels across the origin boundary.
    const handoff = invite.slice(invite.indexOf('function showAccepted'), invite.indexOf('function showProblem'));
    expect(handoff).not.toMatch(/\btoken\b|accessToken|refreshToken|password:/);
    expect(handoff).not.toMatch(/\?token=|\?password=|\?access/);
  });
});

describe('the sign-in screen still works, and looks like itself', () => {
  it('keeps the fields, the button and the error slot', () => {
    for (const file of SPA_PAGES) {
      const body = read(file);
      for (const marker of ['id="login-email"', 'id="login-password"', 'id="login-btn"', 'id="login-error"']) {
        expect(`${file} ${marker}: ${body.includes(marker)}`).toBe(`${file} ${marker}: true`);
      }
    }
  });

  it('and gains the autocomplete hints a password manager needs', () => {
    // Without these a manager either ignores the form or offers the wrong
    // field — which is how people end up typing credentials in by hand.
    for (const file of LOGIN_PAGES) {
      const body = read(file);
      expect(`${file}: ${body.includes('autocomplete="username"')}`).toBe(`${file}: true`);
      expect(`${file}: ${body.includes('autocomplete="current-password"')}`).toBe(`${file}: true`);
    }
  });

  it('and the demo credential block is gone, keeping only the API hostname', () => {
    for (const file of SPA_PAGES) {
      const body = read(file);
      expect(`${file}: ${/<strong>Demo:<\/strong>/.test(body)}`).toBe(`${file}: false`);
      expect(`${file}: ${/<strong>Coach:<\/strong>/.test(body)}`).toBe(`${file}: false`);
      // A hostname is not a credential; it stays.
      expect(`${file}: ${body.includes('familista-backend.onrender.com')}`).toBe(`${file}: true`);
    }
  });
});
