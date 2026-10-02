// Settings · Platform · AI and your club's data (Cyber Defense, R3 + R8)
// ─────────────────────────────────────────────────────────────────────────────
// The club's two switches, read from and written to /ai-data-policy:
//
//   restrictedEgress  may medical data (injury details, condition, health-risk
//                     scores) and minors' details be sent to the AI provider
//                     for this club's analyses?
//   trainingUse       may the club's data be used for training (federated
//                     learning)?
//
// Both are off until a club administrator turns them on. Everyone in the club
// sees the card; only a club administrator can change it. One card on the
// Settings card vocabulary (set-card, set-field-l, set-field-help, toggle):
// no navigation, no modal, and a change saves in place.

(function () {
  'use strict';

  var S = { policy: null, loaded: false, busy: false, note: null };
  var KEYS = { egress: 'restrictedEgress', training: 'trainingUse' };

  function tr(key) {
    return (typeof window.t === 'function') ? window.t('settings.aiData.' + key) : key;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function card() { return document.getElementById('set-aidata-card'); }
  function canEdit() {
    var u = window.State && window.State.user;
    return !!(u && (u.role === 'SUPER_ADMIN' || u.role === 'CLUB_ADMIN'));
  }

  async function call(method, body) {
    var res = await FamilistaAPI.request(method, '/ai-data-policy', { body: body });
    return (res && res.data !== undefined) ? res.data : res;
  }

  function row(key) {
    var on = !!(S.policy && S.policy[KEYS[key]]);
    var editable = canEdit() && !S.busy;
    return '<div class="set-aidata-row">'
      + '<div class="set-aidata-txt">'
      + '<div class="set-field-l" id="aid-' + key + '-l">' + esc(tr(key + 'Title')) + '</div>'
      + '<p class="set-field-help" id="aid-' + key + '-h">' + esc(tr(key + 'Help')) + '</p>'
      + '</div>'
      + '<button type="button" class="toggle' + (on ? ' on' : '') + '" role="switch" aria-checked="' + on + '"'
      + ' aria-labelledby="aid-' + key + '-l" aria-describedby="aid-' + key + '-h" data-aidata="' + key + '"'
      + (editable ? '' : ' disabled') + '><span class="toggle-knob"></span></button>'
      + '</div>';
  }

  function render() {
    var el = card();
    if (!el) return;
    var body;
    if (!S.loaded) body = '<div class="set-aidata-skel" aria-hidden="true"></div><div class="set-aidata-skel" aria-hidden="true"></div>';
    else if (!S.policy) body = '<p class="set-field-help">' + esc(tr('loadFailed')) + '</p>';
    else body = row('egress') + row('training');
    el.innerHTML = '<div class="set-card-hd">' + esc(tr('title')) + '</div>'
      + '<p class="set-field-help set-aidata-intro">' + esc(tr('intro')) + '</p>'
      + '<div class="set-aidata-body">' + body + '</div>'
      + (S.loaded && S.policy && !canEdit() ? '<p class="set-field-help">' + esc(tr('adminOnly')) + '</p>' : '')
      + '<p class="set-field-note' + (S.note ? ' ' + S.note.kind : '') + '" role="status" aria-live="polite">'
      + (S.note ? esc(tr(S.note.key)) : '') + '</p>';
  }

  async function load() {
    try { S.policy = await call('GET'); } catch (_) { S.policy = null; }
    S.loaded = true;
    render();
  }

  async function onClick(e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-aidata]');
    if (!btn || !card() || !card().contains(btn) || S.busy || !canEdit() || !S.policy) return;
    var field = KEYS[btn.getAttribute('data-aidata')];
    if (!field) return;
    var patch = {}; patch[field] = !S.policy[field];
    S.busy = true; S.note = null; render();
    try {
      S.policy = await call('PUT', patch);
      S.note = { key: 'saved', kind: 'is-ok' };
    } catch (_) {
      S.note = { key: 'failed', kind: 'is-warn' };
    }
    S.busy = false;
    render();
  }

  /** Called when the Settings page is drawn. */
  function mount() {
    var el = card();
    if (!el || el.getAttribute('data-aidata-mounted') === '1') return;
    el.setAttribute('data-aidata-mounted', '1');
    S.loaded = false; S.policy = null; S.note = null;
    el.hidden = false;
    render();
    load();
  }

  document.addEventListener('click', onClick);
  try { if (window.I18N && I18N.onChange) I18N.onChange(function () { if (card() && !card().hidden) render(); }); } catch (_) {}

  window.SettingsAiData = { mount: mount, render: render };
})();
