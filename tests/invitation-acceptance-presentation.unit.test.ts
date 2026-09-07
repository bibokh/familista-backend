/**
 * tests/invitation-acceptance-presentation.unit.test.ts
 *
 * The acceptance page is dressed, and stays dressed.
 *
 * A head coach opened their invitation in production and got raw browser
 * HTML: serif text, grey default buttons, unstyled inputs, no card. The data
 * was perfect — club, role, team and address all correct — which is exactly
 * what made it confusing, and exactly what identifies the cause.
 *
 * The cause was Content-Security-Policy. This origin sends
 * `style-src 'self' https://fonts.googleapis.com`, with no 'unsafe-inline',
 * and the whole design lived in an inline <style> block. The browser discarded
 * every rule. The external script, being same-origin, ran perfectly — hence
 * correct data inside an undesigned page. Reproduced in Chromium under that
 * exact header: inputs computed to 13.33px Arial with no border radius, and
 * the card to Times New Roman. With the stylesheet moved to a file: 16px, the
 * intended family, an 11px radius on the input and 18px on the card.
 *
 * A second, independent bug was found in the same stylesheet and is pinned
 * here too: `font: 400 16px/1.4 inherit` is invalid, because the `font`
 * shorthand only accepts a CSS-wide keyword as its ENTIRE value, never in the
 * family slot. Browsers drop the whole declaration. Every control on the page
 * was affected, and 13.33px is below the 16px at which iOS Safari stops
 * zooming the viewport on focus.
 *
 * Nothing here is about the invitation itself. The token, the membership, the
 * role and the team scoping are covered by the invitation and People & Access
 * suites; this file is only about whether the page looks like Familista.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAGE = read('public/invite/index.html');
const SCRIPT = read('public/invite/invite.js');
const SHEET = read('public/invite/invite.css');
const APP_TS = read('src/app.ts');
const MAIL = read('src/identity/invitation-mail.service.ts');

/** Every HTML document this Express app serves from public/. */
function servedPages(dir = path.join(ROOT, 'public'), out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // public/app is the built React SPA — a bundler's output, not a page
    // anybody edits, and it is served under its own route.
    if (entry.isDirectory() && entry.name !== 'app') servedPages(full, out);
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('the policy that discarded the design', () => {
  it('still forbids inline CSS — this is the constraint, not the bug', () => {
    const csp = APP_TS.slice(APP_TS.indexOf('contentSecurityPolicy'), APP_TS.indexOf('imgSrc'));
    expect(csp).toContain("styleSrc:    [\"'self'\", 'https://fonts.googleapis.com']");
    // The fix was NOT to allow inline styles. Widening this would have undone
    // a real protection to save moving one file.
    expect(csp).not.toContain("'unsafe-inline'");
  });

  it('so no page this server serves keeps its design in a <style> block', () => {
    for (const file of servedPages()) {
      const src = fs.readFileSync(file, 'utf8');
      // Comments are prose; the rule is about markup. This file's own
      // explanation of the rule must not fail it.
      const markup = src.replace(/<!--[\s\S]*?-->/g, ' ');
      const rel = path.relative(ROOT, file);
      expect(`${rel} has a <style> block: ${/<style[\s>]/i.test(markup)}`)
        .toBe(`${rel} has a <style> block: false`);
    }
  });

  it('and the acceptance page carries no inline style attribute at all', () => {
    // Both halves: the markup, and the script that writes most of it.
    for (const [label, src] of [['index.html', PAGE], ['invite.js', SCRIPT]] as const) {
      const markup = src.replace(/<!--[\s\S]*?-->/g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      expect(`${label} inline style attributes: ${(markup.match(/style="/g) || []).length}`)
        .toBe(`${label} inline style attributes: 0`);
    }
  });

  it('it links a same-origin stylesheet, which is what the policy allows', () => {
    expect(PAGE).toMatch(/<link rel="stylesheet" href="\/invite\/invite\.css/);
    // Same origin, so 'self' covers it — not a CDN, which the policy would
    // refuse just as firmly.
    expect(PAGE).not.toMatch(/<link[^>]+href="https?:\/\//);
  });

  it('and that stylesheet is served as a file, not swallowed by the catch-all', () => {
    // `app.get(['/invite', '/invite/*'])` would answer /invite/invite.css with
    // the HTML document if it ran first. express.static is registered ahead of
    // it, which is the only reason the stylesheet arrives as CSS.
    const staticAt = APP_TS.indexOf('express.static(publicDir');
    const routeAt = APP_TS.indexOf("app.get(['/invite', '/invite/*']");
    expect(staticAt).toBeGreaterThan(0);
    expect(routeAt).toBeGreaterThan(0);
    expect(staticAt).toBeLessThan(routeAt);
  });

  // The app shell predates this rule and carries inline style attributes of its
  // own. They are outside this task, and they are being discarded on this
  // origin exactly as the acceptance page's were — so the count may fall and
  // may not rise.
  it('and the app shell does not add more of them', () => {
    const shell = read('public/index.html');
    expect((shell.match(/style="/g) || []).length).toBeLessThanOrEqual(158);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('one branded shell, for a president and for a head coach alike', () => {
  it('there is exactly one acceptance document', () => {
    const pages = servedPages().map((p) => path.relative(ROOT, p));
    expect(pages.filter((p) => /invite/i.test(p))).toEqual(['public/invite/index.html']);
  });

  it('and it never branches on role to choose a template', () => {
    const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    // Which screen is shown depends on whether an account exists, never on
    // what the person was invited as.
    expect(code).toMatch(/if \(preview\.accountExists\) renderSignIn\(\); else renderCreateAccount\(\);/);
    for (const role of ['CLUB_OWNER', 'HEAD_COACH', 'PRESIDENT', 'STAFF']) {
      const asBranch = new RegExp(`(if|\\?)[^\\n]*['"]${role}['"]`);
      expect(`${role} used as a branch: ${asBranch.test(code)}`).toBe(`${role} used as a branch: false`);
    }
    // The role reaches the page as a label and nothing else.
    expect(code).toContain("CLUB_OWNER: 'President'");
    expect(code).toContain("HEAD_COACH: 'Head coach'");
  });

  it('and both kinds of invitation are mailed the same acceptance link', () => {
    const url = MAIL.slice(MAIL.indexOf('export function acceptanceUrl'), MAIL.indexOf('export interface DeliveryOutcome'));
    expect(url).toContain('/invite/accept?token=');
    // One builder, no kind in it: a president and a coach get the same page.
    expect(url).not.toMatch(/PRESIDENT|STAFF|kind/);
  });

  it('and names every role the club can invite, including the newer staff ones', () => {
    // A role with no entry falls back to a lower-cased enum token, which reads
    // like a leak of the schema on the first page somebody ever sees.
    for (const role of [
      'CLUB_OWNER', 'CLUB_ADMIN', 'HEAD_COACH', 'ASSISTANT_COACH', 'GOALKEEPING_COACH',
      'FITNESS_COACH', 'TECHNICAL_COACH', 'TACTICAL_COACH', 'YOUTH_COACH',
      'PERFORMANCE_COACH', 'ANALYST', 'MEDICAL_STAFF', 'PHYSIO', 'SCOUT', 'FINANCE_MANAGER',
    ]) {
      expect(`${role} named: ${new RegExp(`${role}:\\s*'`).test(SCRIPT)}`).toBe(`${role} named: true`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the stylesheet actually applies', () => {
  it('has no font shorthand ending in a CSS-wide keyword', () => {
    // `font: 400 16px/1.4 inherit` is invalid and dropped whole. `font: inherit`
    // — the keyword as the ENTIRE value — is valid and used widely elsewhere,
    // so the rule has to tell them apart.
    const css = SHEET.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const bad = [...css.matchAll(/font:\s*[^;{}]*\S\s+(inherit|initial|unset|revert)\s*;/g)]
      .map((m) => m[0].trim());
    expect(bad).toEqual([]);
  });

  it('sets every control from longhands, so nothing silently vanishes', () => {
    const input = SHEET.slice(SHEET.indexOf('  input {'), SHEET.indexOf('  input:focus'));
    expect(input).toContain('font-family: inherit;');
    // 16px, because below it iOS Safari zooms the viewport when a field is
    // focused — which is the difference between a form and a fight.
    expect(input).toMatch(/font-size:\s*16px/);
  });

  it('and every class the page and script use has a rule', () => {
    const defined = new Set([...SHEET.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
    const used = new Set<string>();
    for (const src of [PAGE.slice(PAGE.indexOf('<body')), SCRIPT]) {
      for (const m of src.matchAll(/class="([^"$]*)"/g)) {
        // `class="alert alert--' + kind + '"` is one expression, not a list of
        // names: the tail after the quote is JavaScript. Only literal
        // attributes are class lists.
        if (/['`+]/.test(m[1])) continue;
        m[1].split(/\s+/).filter((c) => /^[a-zA-Z][\w-]*$/.test(c)).forEach((c) => used.add(c));
      }
      for (const m of src.matchAll(/className = '([^'+]*)'/g)) {
        m[1].split(/\s+/).filter((c) => /^[a-zA-Z][\w-]*$/.test(c)).forEach((c) => used.add(c));
      }
      for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) used.add(m[1]);
    }
    expect([...used].filter((c) => !defined.has(c)).sort()).toEqual([]);
  });

  it('and no element is left to the browser to style', () => {
    for (const sel of ['input', 'label', 'button', 'h1']) {
      expect(`rule for ${sel}: ${new RegExp(`(^|[,{}\\s])${sel}\\s*[,{]`, 'm').test(SHEET)}`)
        .toBe(`rule for ${sel}: true`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('and it fits a phone', () => {
  it('clears the notch and the home indicator', () => {
    expect(SHEET).toContain('env(safe-area-inset-top)');
    expect(SHEET).toContain('env(safe-area-inset-bottom)');
    expect(PAGE).toContain('viewport-fit=cover');
    expect(PAGE).toMatch(/width=device-width, initial-scale=1/);
  });

  it('stays a card rather than stretching across a desktop', () => {
    expect(SHEET).toMatch(/\.shell\s*\{[^}]*max-width:\s*468px/);
  });

  it('never scrolls sideways, whatever the content is', () => {
    expect(SHEET).toMatch(/overflow-x:\s*hidden/);
    // A long club name or address wraps instead of widening the page.
    expect(SHEET).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('and gives every tap target room for a thumb', () => {
    const btn = SHEET.slice(SHEET.indexOf('  .btn {'), SHEET.indexOf('  .btn:hover'));
    expect(btn).toMatch(/min-height:\s*50px/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('and it still says what the invitation is for', () => {
  it('shows the club, the role, the access, the address and the expiry', () => {
    const summary = SCRIPT.slice(SCRIPT.indexOf('function summaryHtml'), SCRIPT.indexOf('function alertHtml'));
    for (const field of ['clubName', 'roleLabel(preview.role)', 'accessRow()', 'preview.email', 'expires']) {
      expect(`${field}: ${summary.includes(field)}`).toBe(`${field}: true`);
    }
  });

  it('names every team a multi-team invitation grants, not just the first', () => {
    // `teamName` is only set for a single team, so reading it alone showed
    // nothing at all for a staff invitation covering two — the row vanished.
    const access = SCRIPT.slice(SCRIPT.indexOf('function accessRow'), SCRIPT.indexOf('function summaryHtml'));
    expect(access).toContain('preview.teams');
    expect(access).toMatch(/join\(' · '\)/);
    // And an invitation naming no team says so rather than leaving a gap.
    expect(access).toContain('The whole club');
  });

  it('locks the invited address, because it is not the reader\'s to change', () => {
    const form = SCRIPT.slice(SCRIPT.indexOf('function renderCreateAccount'), SCRIPT.indexOf('var form = document'));
    expect(form).toMatch(/id="email"[^>]*readonly/);
    for (const field of ['firstName', 'lastName', 'password', 'confirm']) {
      expect(`${field} present: ${form.includes(`id="${field}"`)}`).toBe(`${field} present: true`);
    }
  });

  it('and validates the password exactly as it did', () => {
    // Presentation changed; the rule did not.
    expect(SCRIPT).toMatch(/MIN_PASSWORD\s*=\s*8/);
    expect(SCRIPT).toContain('pw.length >= MIN_PASSWORD');
    expect(SCRIPT).toContain('pw === cf');
  });
});
