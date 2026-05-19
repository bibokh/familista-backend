/*
 * Familista — White-label SPA Bootstrap
 *
 * Drop-in client script that resolves the tenant theme from the current host,
 * applies CSS variables, swaps title/favicon/OG metadata, and exposes a
 * `window.familistaTheme` object for the SPA to read.
 *
 * Place this as the FIRST <script> tag in your existing familista_v5.html,
 * ahead of any rendering code. It is dependency-free and ~3KB.
 *
 *   <script src="/whitelabel-bootstrap.client.js"></script>
 *
 * The script silently falls back to the default Familista brand on any
 * network or parse error — never blocks app startup.
 */

(function () {
  'use strict';

  var API_BASE = (window.FAMILISTA_API_BASE || '/api/v1').replace(/\/$/, '');
  var ENDPOINT = API_BASE + '/whitelabel/public/resolve';
  var CACHE_KEY = 'familista:wl:v1';
  var CACHE_TTL_MS = 5 * 60 * 1000;

  function readCache(host) {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed.host !== host) return null;
      if (Date.now() - parsed.savedAt > CACHE_TTL_MS) return null;
      return parsed.theme;
    } catch (e) { return null; }
  }

  function writeCache(host, theme) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        host: host, theme: theme, savedAt: Date.now(),
      }));
    } catch (e) { /* quota or disabled — ignore */ }
  }

  function applyTheme(theme) {
    if (!theme || typeof theme !== 'object') return;
    window.familistaTheme = theme;

    var root = document.documentElement;
    var c = theme.colors || {};
    var setVar = function (name, value) {
      if (typeof value === 'string' && value) root.style.setProperty(name, value);
    };

    setVar('--wl-primary', c.primary);
    setVar('--wl-secondary', c.secondary);
    setVar('--wl-accent', c.accent);
    setVar('--wl-bg', c.background);
    setVar('--wl-surface', c.surface);
    setVar('--wl-text', c.text);
    setVar('--wl-muted', c.mutedText);
    setVar('--wl-border', c.border);
    setVar('--wl-error', c.error);
    setVar('--wl-success', c.success);
    setVar('--wl-warning', c.warning);

    var t = theme.typography || {};
    setVar('--wl-font', t.fontFamily);

    if (t.fontHeadingUrl) {
      injectLink('preload', t.fontHeadingUrl, 'font', 'anonymous');
      injectLink('stylesheet', t.fontHeadingUrl);
    }
    if (t.fontBodyUrl && t.fontBodyUrl !== t.fontHeadingUrl) {
      injectLink('preload', t.fontBodyUrl, 'font', 'anonymous');
      injectLink('stylesheet', t.fontBodyUrl);
    }

    if (theme.productName) {
      document.title = theme.productName + (theme.tagline ? ' — ' + theme.tagline : '');
    }

    if (theme.faviconUrl) replaceFavicon(theme.faviconUrl);

    setMeta('property', 'og:title', theme.productName || 'Familista');
    if (theme.tagline) setMeta('property', 'og:description', theme.tagline);
    if (theme.ogImageUrl) setMeta('property', 'og:image', theme.ogImageUrl);

    if (theme.customHeadHtml && /^[^<]*(<(?:link|meta|style)\b[^>]*>[^<]*)+$/i.test(theme.customHeadHtml)) {
      var holder = document.createElement('div');
      holder.innerHTML = theme.customHeadHtml;
      while (holder.firstChild) document.head.appendChild(holder.firstChild);
    }

    if (theme.customCss) {
      var style = document.createElement('style');
      style.setAttribute('data-wl', '1');
      style.textContent = theme.customCss;
      document.head.appendChild(style);
    }

    document.documentElement.setAttribute('data-wl-source', theme.resolvedFrom || 'default');
    document.dispatchEvent(new CustomEvent('familista:theme-ready', { detail: theme }));
  }

  function injectLink(rel, href, as, crossorigin) {
    var link = document.createElement('link');
    link.rel = rel;
    link.href = href;
    if (as) link.as = as;
    if (crossorigin) link.crossOrigin = crossorigin;
    document.head.appendChild(link);
  }

  function replaceFavicon(href) {
    var existing = document.querySelectorAll('link[rel~="icon"]');
    existing.forEach(function (el) { el.parentNode && el.parentNode.removeChild(el); });
    var link = document.createElement('link');
    link.rel = 'icon';
    link.href = href;
    document.head.appendChild(link);
  }

  function setMeta(attr, key, value) {
    var sel = 'meta[' + attr + '="' + key + '"]';
    var el = document.head.querySelector(sel);
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute(attr, key);
      document.head.appendChild(el);
    }
    el.setAttribute('content', value);
  }

  function fetchTheme(host) {
    return fetch(ENDPOINT + '?host=' + encodeURIComponent(host), {
      method: 'GET',
      credentials: 'omit',
      headers: { 'Accept': 'application/json' },
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) {
        if (body && body.success && body.data) return body.data;
        if (body && body.colors) return body;
        return null;
      })
      .catch(function () { return null; });
  }

  var host = window.location.hostname;
  var cached = readCache(host);
  if (cached) {
    applyTheme(cached);
    fetchTheme(host).then(function (fresh) {
      if (fresh) { writeCache(host, fresh); /* next reload picks up */ }
    });
  } else {
    fetchTheme(host).then(function (theme) {
      if (theme) {
        writeCache(host, theme);
        applyTheme(theme);
      } else {
        document.dispatchEvent(new CustomEvent('familista:theme-ready', { detail: null }));
      }
    });
  }
})();
