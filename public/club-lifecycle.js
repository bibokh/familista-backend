/**
 * Club lifecycle controls — the platform owner's, on the Clubs page.
 *
 * A three-dot menu on every card, and the dialogs behind it. Everything here is
 * PRESENTATION: the server decides who may do any of this, refuses a club role
 * outright, and refuses permanent deletion for a club that still has anything
 * in it. Nothing in this file is a permission, and nothing in it may be trusted
 * to be one.
 *
 * Two rules from the design system govern the whole file:
 *
 *   · Nothing may move that the reader did not move. The menu and both dialogs
 *     are `position: fixed` and animate on opacity and transform only, so
 *     opening one does not shift a pixel of the grid underneath.
 *   · A measured zero renders as `0`. The deletion preview counts real rows,
 *     and a club with nothing in it says so — it does not hide the list.
 */
(function () {
  'use strict';

  var LIVE = null;   // the open menu's element, or null

  function api() {
    try { return window.FamilistaAPI || null; } catch (_) { return null; }
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, kind) {
    try { if (typeof window.showToast === 'function') window.showToast(msg, kind || 'success'); } catch (_) {}
  }

  // ── the menu ───────────────────────────────────────────────────────────────

  /**
   * What this club can be moved to from where it is.
   *
   * Mirrored from `club-lifecycle.service`, which is the rule: reactivate is
   * offered only to a deactivated club, restore only to an archived one, and
   * deactivate is not offered to an archived club because archiving is not
   * suspension and the service refuses that move. An action the server would
   * refuse is not drawn.
   */
  function actionsFor(lifecycle) {
    var out = [{ key: 'open', label: 'Open club' }];
    if (lifecycle === 'DEACTIVATED') {
      out.push({ key: 'reactivate', label: 'Reactivate club' });
      out.push({ key: 'archive', label: 'Archive club' });
    } else if (lifecycle === 'ARCHIVED') {
      out.push({ key: 'restore', label: 'Restore club' });
    } else {
      out.push({ key: 'deactivate', label: 'Deactivate club' });
      out.push({ key: 'archive', label: 'Archive club' });
    }
    out.push({ key: 'history', label: 'Lifecycle history' });
    out.push({ key: 'delete', label: 'Delete permanently', danger: true });
    return out;
  }

  function closeMenu() {
    var el = document.getElementById('cl-menu');
    if (el) el.remove();
    LIVE = null;
  }

  function menu(btn) {
    if (!btn) return;
    var clubId = btn.getAttribute('data-club-id') || '';
    var name = btn.getAttribute('data-club-name') || 'Club';
    var lifecycle = btn.getAttribute('data-club-lifecycle') || 'ACTIVE';
    // A second click on the same button closes it, which is what a menu button
    // is expected to do.
    var reopening = LIVE === btn;
    closeMenu();
    if (reopening) return;
    LIVE = btn;

    var box = document.createElement('div');
    box.id = 'cl-menu';
    box.className = 'cl-menu';
    box.setAttribute('role', 'menu');
    box.innerHTML = actionsFor(lifecycle).map(function (a) {
      return '<button type="button" role="menuitem" class="cl-menu-item'
        + (a.danger ? ' cl-menu-item--danger' : '') + '" data-cl="' + a.key + '">'
        + esc(a.label) + '</button>';
    }).join('');

    // Fixed, and positioned from the button's own rectangle: the menu floats
    // over the grid rather than being laid out inside it, so nothing below it
    // moves when it opens.
    var r = btn.getBoundingClientRect();
    box.style.top = Math.round(r.bottom + 6) + 'px';
    box.style.left = Math.round(Math.min(r.left, window.innerWidth - 232)) + 'px';
    document.body.appendChild(box);

    box.addEventListener('click', function (e) {
      var item = e.target.closest('[data-cl]');
      if (!item) return;
      var key = item.getAttribute('data-cl');
      closeMenu();
      run(key, { id: clubId, name: name, lifecycle: lifecycle });
    });
  }

  document.addEventListener('click', function (e) {
    if (!LIVE) return;
    if (e.target.closest && (e.target.closest('#cl-menu') || e.target.closest('[data-action="clubLifecycleMenu"]'))) return;
    closeMenu();
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);

  // ── the dialogs ────────────────────────────────────────────────────────────

  function closeDialog() {
    var el = document.getElementById('cl-dialog');
    if (el) el.remove();
  }

  /**
   * One dialog shell for every action.
   *
   * `body` is the explanation, `confirm` the button, `onConfirm` the work. The
   * shell owns the scrim, the focus and the escape key so that four dialogs
   * cannot drift into behaving like four different dialogs.
   */
  function dialog(opts) {
    closeDialog();
    var wrap = document.createElement('div');
    wrap.id = 'cl-dialog';
    wrap.className = 'cl-scrim';
    wrap.innerHTML =
      '<div class="cl-panel' + (opts.danger ? ' cl-panel--danger' : '') + '" role="dialog" aria-modal="true">'
      + '<div class="cl-panel-h">'
      + '<div><h2>' + esc(opts.title) + '</h2>'
      // The club's own name, marked as what it is: data a person typed, never
      // translated, and kept OUT of the title so the title stays one literal
      // sentence a translator can work with.
      + (opts.subject ? '<div class="cl-subject" data-user-content>' + esc(opts.subject) + '</div>' : '')
      + '</div>'
      + '<button type="button" class="cl-x" data-cl-close aria-label="Close">&times;</button>'
      + '</div>'
      + '<div class="cl-panel-b">' + opts.body + '</div>'
      + '<div class="cl-err" id="cl-err" hidden></div>'
      + '<div class="cl-panel-f">'
      + '<button type="button" class="cl-btn" data-cl-close>Cancel</button>'
      + '<button type="button" class="cl-go' + (opts.danger ? ' cl-go--danger' : '') + '" id="cl-go"'
      + (opts.armed === false ? ' disabled' : '') + '>' + esc(opts.confirm) + '</button>'
      + '</div>'
      + '</div>';
    document.body.appendChild(wrap);

    wrap.addEventListener('click', function (e) {
      if (e.target.closest('[data-cl-close]') || e.target === wrap) closeDialog();
    });
    var go = wrap.querySelector('#cl-go');
    go.addEventListener('click', function () {
      go.disabled = true;
      Promise.resolve()
        .then(function () { return opts.onConfirm(wrap); })
        .then(function () { closeDialog(); })
        .catch(function (err) {
          go.disabled = false;
          var box = wrap.querySelector('#cl-err');
          if (box) {
            // The server's own words. It knows why it refused; guessing here
            // would replace a real reason with a generic one.
            box.textContent = (err && (err.userMessage || err.message)) || 'That could not be done.';
            box.hidden = false;
          }
        });
    });
    if (opts.onMount) { try { opts.onMount(wrap); } catch (_) {} }
    return wrap;
  }

  /** The optional note that travels with a lifecycle change into the audit log. */
  function reasonField() {
    // Every user-visible string in this file is ONE literal, whole sentence.
    // Built by concatenation they extract as fragments — "to confirm",
    // "Nothing is deleted." — and a fragment cannot be translated, because no
    // language puts the pieces back in the same order.
    return '<label class="cl-lab">Reason</label>'
      + '<input class="cl-in" id="cl-reason" maxlength="500" '
      + 'placeholder="Optional — recorded in the club’s lifecycle history">';
  }
  function reasonOf(wrap) {
    var el = wrap.querySelector('#cl-reason');
    return el && el.value.trim() ? el.value.trim() : null;
  }

  function refresh() {
    // Every surface that holds a club's lifecycle is told it has changed, so
    // that two screens cannot report the same club differently. SYSTEM reads
    // its club list once per session and would otherwise go on showing the
    // state the club was in when that list was fetched.
    try {
      document.dispatchEvent(new CustomEvent('familista:club-lifecycle-changed'));
    } catch (_) {}
    // The picker rebuilds from the server rather than being patched in place,
    // so what is on screen after a change is what the server actually holds.
    try {
      if (window.AppContext && window.AppContext.load) return window.AppContext.load();
    } catch (_) {}
    return Promise.resolve();
  }

  function post(path, body) {
    var A = api();
    if (!A) return Promise.reject(new Error('The API client is not available.'));
    return A.post(path, body || {});
  }

  // ── the actions ────────────────────────────────────────────────────────────

  function run(key, club) {
    if (key === 'open') {
      try { if (typeof window.openClub === 'function') window.openClub(club.id); } catch (_) {}
      return;
    }
    if (key === 'history') return showHistory(club);
    if (key === 'delete') return confirmDelete(club);

    // Each entry is a title, a button, whole sentences, and the toast that
    // reports it. Nothing here is assembled from another string at runtime:
    // the toast used to be built by cutting " club" off the button label and
    // adding a "d", which produces an English word by English grammar and
    // nothing at all in any other language.
    var COPY = {
      deactivate: {
        title: 'Deactivate club',
        confirm: 'Deactivate club',
        done: 'Club deactivated — nothing was deleted',
        body: '<p class="cl-p cl-p--lead">The club stops being usable by its own people. Nothing is deleted.</p>'
          + '<p class="cl-p">Players, teams, academy sides, staff, memberships and their roles, training, matches, tactics, transfers, coach-market history, media, medical records, settings and history all stay exactly as they are.</p>'
          + '<p class="cl-p">You can still inspect the club from SYSTEM, and reactivating it puts it back exactly as it was.</p>',
      },
      reactivate: {
        title: 'Reactivate club',
        confirm: 'Reactivate club',
        done: 'Club reactivated — it is back exactly as it was',
        body: '<p class="cl-p cl-p--lead">The club returns to the state it was in before it was deactivated, with every membership, role and record it had.</p>'
          + '<p class="cl-p">Nobody has to be re-invited and nothing has to be rebuilt.</p>',
      },
      archive: {
        title: 'Archive club',
        confirm: 'Archive club',
        done: 'Club archived — nothing was deleted',
        body: '<p class="cl-p cl-p--lead">The club leaves the ordinary club lists and is kept by Familista. Nothing is deleted.</p>'
          + '<p class="cl-p">It stays visible in SYSTEM under its archived state, and restoring it returns it to exactly what it was.</p>',
      },
      restore: {
        title: 'Restore club',
        confirm: 'Restore club',
        done: 'Club restored — it is back exactly as it was',
        body: '<p class="cl-p cl-p--lead">The club returns to the state it was in before it was archived, with everything it owned still in place.</p>',
      },
    };
    var copy = COPY[key];
    if (!copy) return;

    dialog({
      title: copy.title,
      subject: club.name,
      confirm: copy.confirm,
      body: copy.body + reasonField(),
      onConfirm: function (wrap) {
        return post('/system/clubs/' + club.id + '/' + key, { reason: reasonOf(wrap) })
          .then(function () {
            toast(copy.done, 'success');
            return refresh();
          });
      },
    });
  }

  // ── lifecycle history ──────────────────────────────────────────────────────

  function when(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function showHistory(club) {
    var A = api();
    dialog({
      title: 'Lifecycle history',
      subject: club.name,
      confirm: 'Done',
      body: '<div id="cl-history" class="cl-hist"><p class="cl-p">Reading the history…</p></div>',
      onConfirm: function () { return Promise.resolve(); },
      onMount: function (wrap) {
        if (!A) return;
        A.get('/system/clubs/' + club.id + '/lifecycle/history').then(function (r) {
          var d = (r && r.data) || r || {};
          var events = d.events || [];
          var box = wrap.querySelector('#cl-history');
          if (!box) return;
          if (!events.length) {
            box.innerHTML =
              '<p class="cl-p">This club has no recorded lifecycle events yet.</p>'
              + '<p class="cl-p">Every state change from here is recorded with who made it, when, and why.</p>';
            return;
          }
          box.innerHTML = '<ul class="cl-hist-list">' + events.map(function (e) {
            return '<li class="cl-hist-row">'
              + '<div class="cl-hist-move">' + esc(e.from || '—') + ' → <b>' + esc(e.to || e.action) + '</b></div>'
              + '<div class="cl-hist-who">' + esc(e.changedByEmail || e.changedByName || 'Familista')
              + ' · ' + esc(when(e.at)) + '</div>'
              + (e.reason ? '<div class="cl-hist-why">' + esc(e.reason) + '</div>' : '')
              + '</li>';
          }).join('') + '</ul>';
        }).catch(function () {
          var box = wrap.querySelector('#cl-history');
          if (box) box.innerHTML = '<p class="cl-p">The history could not be read just now.</p>';
        });
      },
    });
  }

  // ── permanent deletion ─────────────────────────────────────────────────────

  // Capitalised and specific, so each one is a translation unit in its own
  // right rather than a bare word the catalogue would then translate everywhere
  // else in the product that happens to say it.
  var DEP_LABELS = {
    teams: 'Teams', memberships: 'Memberships', players: 'Players', matches: 'Matches',
    invitations: 'Invitations', trainingSessions: 'Training sessions', users: 'User accounts',
    announcements: 'Announcements', staffEngagements: 'Staff engagements',
    financials: 'Financial records', devices: 'Devices', scoutReports: 'Scout reports',
  };

  /**
   * The irreversible one.
   *
   * Three things have to be true, and only the third is in this file's gift:
   * the server checks platform authority, the server checks the typed name, and
   * the server refuses outright when anything still belongs to the club. What
   * happens here is that the person is shown WHAT belongs to it before they are
   * asked, and the button stays disabled until they have typed the club's name.
   */
  function confirmDelete(club) {
    var A = api();
    var body =
      '<p class="cl-p cl-p--danger">This cannot be undone. Permanent deletion removes the club row itself.</p>'
      + '<p class="cl-p">It is not a way to suspend a club — deactivating and archiving both keep every record, and both can be reversed.</p>'
      + '<div id="cl-deps" class="cl-deps"><p class="cl-p">Counting what belongs to this club…</p></div>'
      // The instruction is one sentence; the name it asks for is shown beside
      // it as the data it is. Interpolating the name into the sentence would
      // make the sentence untranslatable and the club name translatable, which
      // are the two mistakes this file exists to avoid.
      + '<label class="cl-lab" for="cl-confirm-name">Type the club’s exact name to confirm</label>'
      + '<div class="cl-subject cl-subject--inline" data-user-content>' + esc(club.name) + '</div>'
      + '<input class="cl-in" id="cl-confirm-name" autocomplete="off" spellcheck="false">';

    var wrap = dialog({
      title: 'Delete club permanently',
      subject: club.name,
      confirm: 'Delete permanently',
      danger: true,
      armed: false,
      body: body,
      onConfirm: function (w) {
        var typed = w.querySelector('#cl-confirm-name');
        if (!A) return Promise.reject(new Error('The API client is not available.'));
        // DELETE with the typed name in the body. The server checks it against
        // the club's real name and refuses on any mismatch, so this is a
        // confirmation being forwarded rather than a confirmation being made.
        return A.delete('/system/clubs/' + club.id, {
          body: { confirmName: typed ? typed.value.trim() : '' },
        }).then(function () {
          toast('Club permanently deleted', 'success');
          return refresh();
        });
      },
      onMount: function (w) {
        var go = w.querySelector('#cl-go');
        var typed = w.querySelector('#cl-confirm-name');
        // Armed only by the exact name, and re-checked on every keystroke.
        typed.addEventListener('input', function () {
          go.disabled = typed.value.trim() !== club.name;
        });

        if (!A) return;
        A.get('/system/clubs/' + club.id + '/dependencies').then(function (r) {
          var d = (r && r.data) || r || {};
          var box = w.querySelector('#cl-deps');
          if (!box) return;
          var counts = d.counts || {};
          var rows = Object.keys(counts).map(function (k) {
            return '<div class="cl-dep' + (counts[k] > 0 ? ' cl-dep--blocking' : '') + '">'
              + '<span class="cl-dep-n">' + esc(counts[k]) + '</span>'
              + '<span class="cl-dep-k">' + esc(DEP_LABELS[k] || k) + '</span></div>';
          }).join('');
          box.innerHTML = '<div class="cl-dep-grid">' + rows + '</div>'
            + (d.deletable
              ? '<p class="cl-p">Nothing belongs to this club. It can be deleted.</p>'
              : '<p class="cl-p cl-p--danger">Familista will refuse this. The records above still belong to the club, and permanent deletion does not remove them by cascade.</p>'
                + '<p class="cl-p">Deactivate or archive it instead — both keep everything exactly as it is.</p>');
          if (!d.deletable) {
            // Nothing to arm: the server would refuse, so the interface does
            // not offer a button that produces an error.
            go.disabled = true;
            typed.disabled = true;
          }
        }).catch(function () {
          var box = w.querySelector('#cl-deps');
          if (box) box.innerHTML = '<p class="cl-p">What belongs to this club could not be counted just now.</p>';
        });
      },
    });
    return wrap;
  }

  window.ClubLifecycle = { menu: menu, close: closeMenu };
}());
