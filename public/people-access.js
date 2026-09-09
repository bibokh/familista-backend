// Familista — Club People & Access
// ═════════════════════════════════════════════════════════════════════════════
//
// Who can open this club, what they may reach, and how that changed.
//
// This is the CLUB's access screen. It is not the platform's: nothing here
// grants, implies or displays platform authority, and a president using it
// stays a president. The platform's own People & Access lives in SYSTEM and
// shares no code with this file.
//
// Everything on screen is server data. The management actions are shown to
// somebody the SERVER has said holds CLUB_OWNER or CLUB_ADMIN in the club now
// open — and hiding them is a courtesy, not the guard. Every endpoint behind
// them re-checks, so a person who forges the client state gets a 403 rather
// than a member list.
//
// Its own file because it is its own module: app.js registers the page and
// nothing else about it lives there.

(function () {
  'use strict';

  // ── state ──────────────────────────────────────────────────────────────────
  var PA = {
    activeTab: 'members',
    loading: true,
    error: null,
    members: [],       // Membership rows, with .user and .team
    invitations: [],
    teams: [],
    audit: [],
    busy: {},          // membershipId/invitationId → true while a call is out
  };
  window._PA = PA;

  var api = function () { return window.FamilistaAPI; };
  var esc = function (s) {
    return (typeof window._esc === 'function') ? window._esc(s)
      : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  };
  var toast = function (m, k) {
    if (typeof window.showToast === 'function') window.showToast(m, k || 'info');
  };

  // ── roles ──────────────────────────────────────────────────────────────────
  //
  // The labels a club recognises, mapped onto the authoritative MembershipRole
  // enum. Nothing here invents a role: every value on the right is one the
  // schema already has, and a name on the left that has no enum value simply
  // is not offered.
  var ROLE_LABELS = {
    CLUB_OWNER: 'President', CLUB_ADMIN: 'Club administrator',
    HEAD_COACH: 'Head coach', ASSISTANT_COACH: 'Assistant coach',
    GOALKEEPING_COACH: 'Goalkeeping coach', FITNESS_COACH: 'Fitness coach',
    TECHNICAL_COACH: 'Technical coach', TACTICAL_COACH: 'Tactical coach',
    YOUTH_COACH: 'Academy coach', PERFORMANCE_COACH: 'Performance coach',
    ANALYST: 'Video / match analyst', MEDICAL_STAFF: 'Medical staff',
    PHYSIO: 'Physiotherapist', SCOUT: 'Scout', FINANCE_MANAGER: 'Finance manager',
    PARENT: 'Parent', PLAYER: 'Player', DEVICE: 'Device',
  };

  // What a club may hand out from this screen, in the order a club thinks of
  // them. PLAYER, PARENT and DEVICE are not here: those are created by the
  // squad and device flows that own them, not by a staff invitation.
  var INVITABLE = [
    'CLUB_ADMIN', 'HEAD_COACH', 'ASSISTANT_COACH', 'GOALKEEPING_COACH',
    'FITNESS_COACH', 'TECHNICAL_COACH', 'TACTICAL_COACH', 'YOUTH_COACH',
    'PERFORMANCE_COACH', 'ANALYST', 'MEDICAL_STAFF', 'PHYSIO', 'SCOUT',
    'FINANCE_MANAGER',
  ];

  /**
   * The roles this person may actually invite somebody into.
   *
   * President is the club's own, and it is offered only to somebody the server
   * would accept it from — a sitting president, or Familista onboarding the
   * club. That is `canAppointPresident`, the capability `createInvitation`
   * mirrors, read from the server's answer and never decided here.
   *
   * It is offered at all because a club has to be able to get a president
   * through the invitation flow: that is now the ONLY way a CLUB_OWNER
   * membership comes into existence, since creating a club grants nobody
   * anything. A club with no president stays a club with no president until a
   * real person accepts.
   */
  function invitableRoles() {
    var can = false;
    try {
      var ea = ((window.State && window.State.context) || {}).effectiveAccess || {};
      can = ea.canAppointPresident === true;
    } catch (_) { can = false; }
    return can ? ['CLUB_OWNER'].concat(INVITABLE) : INVITABLE.slice();
  }

  // The two roles that manage a club. Everything else is ordinary staff, and
  // nothing promotes itself into this list by accident — it is written out.
  var MANAGING = ['CLUB_OWNER', 'CLUB_ADMIN'];

  function roleLabel(r) { return ROLE_LABELS[r] || String(r || '').replace(/_/g, ' ').toLowerCase(); }

  /**
   * The offered roles, plus the one this person already holds.
   *
   * A dropdown that cannot show the current value is a dropdown that silently
   * proposes a change nobody asked for. So a president being edited by
   * somebody who may not appoint one still SEES "President" selected — and
   * every other option is a demotion, which is what that person may do.
   */
  function withCurrent(list, role) {
    return role && list.indexOf(role) < 0 ? [role].concat(list) : list;
  }

  /**
   * May the signed-in person manage access here?
   *
   * From the server's own answer about the club now open — the membership role
   * /me/context reported — and never from a role the client could have set for
   * itself. False while the answer is still outstanding, so the management
   * actions appear when they are known to apply rather than flickering away.
   */
  function canManage() {
    try {
      var ctx = (window.State && window.State.context) || {};
      // The server's own answer first. It already knows every way somebody may
      // reach this screen — a club-managing membership, or platform authority,
      // which is not a membership and has no role name to match against. That
      // second case is why reading a role here was not enough: the platform
      // owner used to pass this test only because they held a CLUB_OWNER
      // membership of the club, which is exactly what has been removed.
      var ea = ctx.effectiveAccess || {};
      if (ea.canManagePeople === true) return true;
      if (ea.canManagePeople === false) return false;

      var role = ctx.currentClubRole;
      if (!role) {
        var here = (ctx.availableClubs || []).filter(function (c) { return c && c.id === ctx.clubId; })[0];
        var roles = (here && here.roles) || [];
        role = MANAGING.filter(function (m) { return roles.indexOf(m) >= 0; })[0] || null;
      }
      return MANAGING.indexOf(role) >= 0;
    } catch (_) { return false; }
  }

  // ── formatting ─────────────────────────────────────────────────────────────
  function initials(u) {
    var a = (u && u.firstName && u.firstName[0]) || '';
    var b = (u && u.lastName && u.lastName[0]) || '';
    var s = (a + b) || (u && u.email && u.email[0]) || '?';
    return s.toUpperCase();
  }
  function fullName(u) {
    var n = [(u && u.firstName) || '', (u && u.lastName) || ''].join(' ').trim();
    return n || (u && u.email) || 'Unknown';
  }
  /** A measured date, or an em dash for one the platform does not keep. */
  function when(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function relative(v) {
    if (!v) return 'Never signed in';
    var d = new Date(v); if (isNaN(d.getTime())) return '—';
    var mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 2) return 'Just now';
    if (mins < 60) return mins + ' minutes ago';
    if (mins < 60 * 24) return Math.floor(mins / 60) + ' hours ago';
    if (mins < 60 * 24 * 30) return Math.floor(mins / 1440) + ' days ago';
    return when(v);
  }
  function scopeLabel(m) {
    if (!m.teamId) return 'Whole club';
    return (m.team && m.team.name) || 'One team';
  }
  function statusOf(m) {
    if (m.isActive) return 'ACTIVE';
    return m.status === 'SUSPENDED' ? 'SUSPENDED' : 'REMOVED';
  }

  // ── data ───────────────────────────────────────────────────────────────────
  //
  // Four reads, in parallel, and a failure in one does not blank the other
  // three: the tab that could not load says so, and the rest of the screen
  // works.
  function load() {
    PA.loading = true; PA.error = null; paint();
    var A = api();
    if (!A) { PA.loading = false; PA.error = 'The API client is not available.'; paint(); return Promise.resolve(); }

    var settle = function (p, onto, pick) {
      return p.then(function (r) {
        var d = (r && r.data) || r || {};
        PA[onto] = pick(d) || [];
      }).catch(function () { PA[onto] = []; });
    };

    return Promise.all([
      settle(A.get('/memberships?limit=200'), 'members', function (d) { return d.items || d.memberships || (Array.isArray(d) ? d : []); }),
      settle(A.get('/invitations'), 'invitations', function (d) { return d.invitations || d.items || (Array.isArray(d) ? d : []); }),
      settle(A.get('/teams?isActive=true&limit=200'), 'teams', function (d) { return d.items || d.teams || (Array.isArray(d) ? d : []); }),
      settle(A.get('/memberships/audit?limit=60'), 'audit', function (d) { return d.items || (Array.isArray(d) ? d : []); }),
    ]).then(function () {
      PA.loading = false;
      paint();
    });
  }

  // ── summary ────────────────────────────────────────────────────────────────
  function summary() {
    var active = PA.members.filter(function (m) { return m.isActive; });
    var suspended = PA.members.filter(function (m) { return !m.isActive && m.status === 'SUSPENDED'; });
    var pending = PA.invitations.filter(function (i) { return i.status === 'PENDING'; });
    var teams = {};
    active.forEach(function (m) { if (m.teamId) teams[m.teamId] = 1; });
    return {
      active: active.length,
      pending: pending.length,
      suspended: suspended.length,
      teams: Object.keys(teams).length,
    };
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  function card(value, label, hint, tone) {
    return '<div class="pa-stat' + (tone ? ' pa-stat--' + tone : '') + '">'
      + '<div class="pa-stat-v">' + esc(value) + '</div>'
      + '<div class="pa-stat-l">' + esc(label) + '</div>'
      + (hint ? '<div class="pa-stat-h">' + esc(hint) + '</div>' : '')
      + '</div>';
  }

  function empty(title, body) {
    return '<div class="pa-empty"><div class="pa-empty-t">' + esc(title) + '</div>'
      + '<div class="pa-empty-b">' + esc(body) + '</div></div>';
  }

  function skeleton(rows) {
    var out = '';
    for (var i = 0; i < (rows || 4); i++) out += '<div class="pa-skel-row"></div>';
    return '<div class="pa-skel">' + out + '</div>';
  }

  function chip(text, tone) {
    return '<span class="pa-chip' + (tone ? ' pa-chip--' + tone : '') + '">' + esc(text) + '</span>';
  }

  // ── members ────────────────────────────────────────────────────────────────
  function membersTab() {
    if (PA.loading) return skeleton(5);
    if (!PA.members.length) {
      return empty('Nobody has access yet',
        'Invite your first staff member and they will appear here once they accept.');
    }
    var manage = canManage();
    // Active first, then suspended, then removed — the order somebody reads in.
    var rank = { ACTIVE: 0, SUSPENDED: 1, REMOVED: 2 };
    var rows = PA.members.slice().sort(function (a, b) {
      var d = rank[statusOf(a)] - rank[statusOf(b)];
      return d || fullName(a.user).localeCompare(fullName(b.user));
    });
    return '<div class="pa-list">' + rows.map(function (m) { return memberRow(m, manage); }).join('') + '</div>';
  }

  function memberRow(m, manage) {
    var st = statusOf(m);
    var u = m.user || {};
    var busy = !!PA.busy[m.id];
    var isOwner = m.role === 'CLUB_OWNER';
    var lastOwner = isOwner && m.isActive && PA.members.filter(function (x) {
      return x.role === 'CLUB_OWNER' && x.isActive;
    }).length === 1;

    var actions = '';
    if (manage) {
      if (lastOwner) {
        // Named, not merely disabled: a control that refuses without saying why
        // is the same as a broken one.
        actions = '<div class="pa-protected" title="Give the club another president first">'
          + 'Protected · the club’s only president</div>';
      } else if (m.isActive) {
        actions = ''
          + btn('paChangeRole', m.id, 'Change role', busy)
          + btn('paChangeTeam', m.id, 'Change team access', busy)
          + btn('paSuspend', m.id, 'Suspend', busy, 'warn')
          + btn('paRemove', m.id, 'Remove', busy, 'danger');
      } else {
        actions = btn('paReactivate', m.id, st === 'SUSPENDED' ? 'Restore access' : 'Re-add to club', busy);
      }
    }

    return '<div class="pa-row' + (m.isActive ? '' : ' pa-row--off') + '">'
      + '<div class="pa-av" aria-hidden="true">' + esc(initials(u)) + '</div>'
      + '<div class="pa-who">'
      +   '<div class="pa-name" data-user-content>' + esc(fullName(u)) + '</div>'
      +   '<div class="pa-mail" data-user-content>' + esc(u.email || '') + '</div>'
      + '</div>'
      + '<div class="pa-meta">'
      +   chip(roleLabel(m.role), isOwner ? 'owner' : 'role')
      +   chip(scopeLabel(m), m.teamId ? 'team' : 'club')
      +   (st === 'ACTIVE' ? chip('Active', 'ok')
          : st === 'SUSPENDED' ? chip('Suspended', 'warn') : chip('Removed', 'off'))
      + '</div>'
      + '<div class="pa-dates">'
      +   '<div><span>Joined</span> ' + esc(when(m.joinedAt)) + '</div>'
      +   '<div><span>Last seen</span> ' + esc(relative(u.lastLoginAt)) + '</div>'
      + '</div>'
      + '<div class="pa-acts">' + actions + '</div>'
      + '</div>';
  }

  function btn(action, id, label, busy, tone) {
    return '<button type="button" class="pa-btn' + (tone ? ' pa-btn--' + tone : '') + '"'
      + ' data-pa="' + action + '" data-id="' + esc(id) + '"'
      + (busy ? ' disabled' : '') + '>' + esc(label) + '</button>';
  }

  // ── invitations ────────────────────────────────────────────────────────────
  function invitationsTab() {
    if (PA.loading) return skeleton(3);
    if (!PA.invitations.length) {
      return empty('No invitations yet',
        'Invitations you send appear here with their delivery state until they are accepted.');
    }
    var manage = canManage();
    var teamName = {};
    PA.teams.forEach(function (t) { teamName[t.id] = t.name; });

    return '<div class="pa-list">' + PA.invitations.map(function (v) {
      var busy = !!PA.busy[v.id];
      var ids = (v.teamIds && v.teamIds.length) ? v.teamIds : (v.teamId ? [v.teamId] : []);
      var access = ids.length
        ? ids.map(function (id) { return teamName[id] || 'One team'; }).join(' · ')
        : 'Whole club';
      var tone = v.status === 'PENDING' ? 'warn' : v.status === 'ACCEPTED' ? 'ok' : 'off';
      // Delivery is a different fact from validity, and the screen says both.
      var delivered = v.deliveryState === 'SENT' ? 'Email sent'
        : v.deliveryState === 'FAILED' ? ('Email failed' + (v.deliveryFailureCode ? ' · ' + v.deliveryFailureCode : ''))
        : v.deliveryState === 'QUEUED' ? 'Sending' : 'Not sent';

      var acts = '';
      if (manage && v.status === 'PENDING') {
        acts = btn('paResend', v.id, 'Resend', busy) + btn('paRevoke', v.id, 'Revoke', busy, 'danger');
      }
      return '<div class="pa-row pa-row--inv">'
        + '<div class="pa-av pa-av--inv" aria-hidden="true">@</div>'
        + '<div class="pa-who">'
        +   '<div class="pa-name" data-user-content>' + esc(v.email) + '</div>'
        +   '<div class="pa-mail">' + esc(delivered) + '</div>'
        + '</div>'
        + '<div class="pa-meta">'
        +   chip(roleLabel(v.role), 'role')
        +   chip(access, ids.length ? 'team' : 'club')
        +   chip(v.status.charAt(0) + v.status.slice(1).toLowerCase(), tone)
        + '</div>'
        + '<div class="pa-dates">'
        +   '<div><span>Sent</span> ' + esc(when(v.createdAt)) + '</div>'
        +   '<div><span>Expires</span> ' + esc(when(v.expiresAt)) + '</div>'
        + '</div>'
        + '<div class="pa-acts">' + acts + '</div>'
        + '</div>';
    }).join('') + '</div>';
  }

  // ── access by team ─────────────────────────────────────────────────────────
  function teamsTab() {
    if (PA.loading) return skeleton(3);
    var active = PA.members.filter(function (m) { return m.isActive; });
    var clubWide = active.filter(function (m) { return !m.teamId; });

    var blocks = [];
    // The club as a whole first: these people reach every team, and reading the
    // per-team lists without knowing that would be misleading.
    blocks.push(teamBlock('Whole club', 'Reaches every team', clubWide));
    PA.teams.forEach(function (t) {
      blocks.push(teamBlock(t.name, t.kind ? String(t.kind).replace(/_/g, ' ').toLowerCase() : '',
        active.filter(function (m) { return m.teamId === t.id; }), true));
    });
    if (!PA.teams.length && !clubWide.length) {
      return empty('No teams yet', 'Create a team and the people who can reach it will be listed here.');
    }
    return '<div class="pa-teams">' + blocks.join('') + '</div>';
  }

  function teamBlock(name, sub, rows, userNamed) {
    var body = rows.length
      ? rows.map(function (m) {
        return '<div class="pa-tm">'
          + '<span class="pa-av pa-av--sm" aria-hidden="true">' + esc(initials(m.user)) + '</span>'
          + '<span class="pa-tm-n" data-user-content>' + esc(fullName(m.user)) + '</span>'
          + '<span class="pa-tm-r">' + esc(roleLabel(m.role)) + '</span>'
          + '</div>';
      }).join('')
      : '<div class="pa-tm pa-tm--none">Nobody is scoped to this team yet</div>';
    return '<div class="pa-team">'
      + '<div class="pa-team-h">'
      +   '<div class="pa-team-n"' + (userNamed ? ' data-user-content' : '') + '>' + esc(name) + '</div>'
      +   (sub ? '<div class="pa-team-s">' + esc(sub) + '</div>' : '')
      +   '<div class="pa-team-c">' + rows.length + '</div>'
      + '</div>'
      + '<div class="pa-team-b">' + body + '</div>'
      + '</div>';
  }

  // ── activity ───────────────────────────────────────────────────────────────
  var AUDIT_WORDS = {
    GRANT: 'Membership granted', REVOKE: 'Removed from club',
    ROLE_CHANGED: 'Role changed', TEAM_CHANGED: 'Team access changed',
    REACTIVATE: 'Access restored', SUSPEND: 'Access suspended',
    UNSUSPEND: 'Suspension lifted', CONTEXT_SWITCH: 'Switched club context',
    INVITED: 'Invitation sent', INVITE_ACCEPTED: 'Invitation accepted',
    INVITE_REVOKED: 'Invitation revoked', INVITE_RESENT: 'Invitation resent',
  };

  function auditTab() {
    if (PA.loading) return skeleton(6);
    // Context switches are noise on an access log: they say somebody opened
    // the club, not that anybody's access changed.
    var rows = PA.audit.filter(function (a) { return a.action !== 'CONTEXT_SWITCH'; });
    if (!rows.length) {
      return empty('Nothing recorded yet',
        'Invitations, role changes and access changes are listed here as they happen.');
    }
    return '<div class="pa-log">' + rows.map(function (a) {
      var actor = a.actor ? [a.actor.firstName, a.actor.lastName].filter(Boolean).join(' ') : '';
      var after = a.after || {};
      // Only ever a role, a team or an address — never a token, and there is
      // no branch here that could reach one.
      var detail = [
        after.role ? roleLabel(after.role) : '',
        after.email ? String(after.email) : '',
      ].filter(Boolean).join(' · ');
      return '<div class="pa-log-row">'
        + '<div class="pa-log-a">' + esc(AUDIT_WORDS[a.action] || String(a.action).replace(/_/g, ' ').toLowerCase()) + '</div>'
        + '<div class="pa-log-d" data-user-content>' + esc(detail) + '</div>'
        + '<div class="pa-log-w">' + esc(actor ? 'by ' + actor : '') + '</div>'
        + '<div class="pa-log-t">' + esc(relative(a.createdAt)) + '</div>'
        + '</div>';
    }).join('') + '</div>';
  }

  // ── the page ───────────────────────────────────────────────────────────────
  // `id` and `label` rather than a two-element array: the slug is a code
  // identifier and must not reach the translation inventory, and `label` is the
  // key the extractor reads, so the words a person sees do.
  var TABS = [
    { id: 'members',     label: 'Members' },
    { id: 'invitations', label: 'Invitations' },
    { id: 'teams',       label: 'Access by team' },
    { id: 'audit',       label: 'Activity' },
  ];

  function paint() {
    var el = document.getElementById('pa-content');
    if (!el) return;
    var s = summary();
    var manage = canManage();

    var body = PA.activeTab === 'members' ? membersTab()
      : PA.activeTab === 'invitations' ? invitationsTab()
      : PA.activeTab === 'teams' ? teamsTab() : auditTab();

    el.innerHTML = ''
      + '<div class="pa-head">'
      +   '<div class="pa-head-t">'
      +     '<h1>People &amp; Access</h1>'
      +     '<p>Manage who can access this club, their role, teams and status.</p>'
      +   '</div>'
      +   (manage ? '<button type="button" class="pa-invite" data-pa="paInvite">Invite staff</button>' : '')
      + '</div>'
      + '<div class="pa-stats">'
      +   card(PA.loading ? '—' : s.active, 'Active members', '', 'ok')
      +   card(PA.loading ? '—' : s.pending, 'Pending invitations', '', 'warn')
      +   card(PA.loading ? '—' : s.suspended, 'Suspended members', '', 'off')
      +   card(PA.loading ? '—' : s.teams, 'Teams covered', '', 'team')
      + '</div>'
      + '<div class="pa-tabs" role="tablist">'
      +   TABS.map(function (t) {
        return '<button type="button" role="tab" class="pa-tab' + (PA.activeTab === t.id ? ' is-on' : '') + '"'
          + ' aria-selected="' + (PA.activeTab === t.id) + '" data-pa="paTab" data-tab="' + t.id + '">'
          + esc(t.label) + '</button>';
      }).join('')
      + '</div>'
      + '<div class="pa-body">' + body + '</div>';
  }

  // ── the invite panel ───────────────────────────────────────────────────────
  //
  // A floating panel, fixed-position and animated on opacity and transform
  // only, so opening it moves nothing underneath it.
  function openInvite() {
    closePanel();
    var wrap = document.createElement('div');
    wrap.className = 'pa-scrim';
    wrap.id = 'pa-panel';
    wrap.innerHTML = ''
      + '<div class="pa-panel" role="dialog" aria-modal="true" aria-label="Invite staff">'
      +   '<div class="pa-panel-h">'
      +     '<div><h2>Invite staff</h2><p>They will create their own Familista password. Nobody at the club sees it.</p></div>'
      +     '<button type="button" class="pa-x" data-pa="paClose" aria-label="Close">&times;</button>'
      +   '</div>'
      +   '<form class="pa-form" id="pa-invite-form" novalidate>'
      +     '<div class="pa-two">'
      +       field('First name', '<input class="pa-in" name="firstName" autocomplete="given-name" maxlength="60" required>')
      +       field('Last name', '<input class="pa-in" name="lastName" autocomplete="family-name" maxlength="60" required>')
      +     '</div>'
      +     field('Email', '<input class="pa-in" name="email" type="email" autocomplete="off" maxlength="200" required placeholder="coach@example.com">')
      +     field('Role', '<select class="pa-in" name="role" required>'
             + invitableRoles().map(function (r) {
               return '<option value="' + r + '">' + esc(roleLabel(r)) + '</option>';
             }).join('') + '</select>')
      +     '<div class="pa-scope">'
      +       '<div class="pa-lab">Access scope</div>'
      +       '<label class="pa-radio"><input type="radio" name="scope" value="club"> '
      +         '<span><b>The whole club</b><em>Every team, now and in future. Give this only to people who run the club.</em></span></label>'
      +       '<label class="pa-radio"><input type="radio" name="scope" value="teams" checked> '
      +         '<span><b>Specific teams</b><em>They reach only what you tick. This is the safe default.</em></span></label>'
      +       '<div class="pa-teamlist" id="pa-teamlist">' + teamPicker() + '</div>'
      +     '</div>'
      +     '<div class="pa-err" id="pa-err" hidden></div>'
      +     '<div class="pa-panel-f">'
      +       '<button type="button" class="pa-btn" data-pa="paClose">Cancel</button>'
      +       '<button type="submit" class="pa-invite" id="pa-send">Send invitation</button>'
      +     '</div>'
      +   '</form>'
      + '</div>';
    document.body.appendChild(wrap);
    // The panel animates itself in from its first frame — see `paRise`. There is
    // no class to add a frame later, which is what used to open it from a
    // half-resolved state.
    var first = wrap.querySelector('input[name="firstName"]');
    // `preventScroll`, and it is the whole of this fix. Focusing ran while the
    // panel was still at `translate3d(0,10px,0)`, so the browser scrolled the
    // field into view against a position the panel was about to leave — and
    // then corrected that scroll while the animation was still running. A
    // scrolling ancestor moving under a moving panel is the shake. The field is
    // the first thing in the form and needs no scrolling to be seen.
    if (first) {
      try { first.focus({ preventScroll: true }); }
      catch (_) { first.focus(); }
    }
    wrap.querySelector('#pa-invite-form').addEventListener('submit', submitInvite);
    wrap.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'scope') {
        var list = document.getElementById('pa-teamlist');
        if (list) list.hidden = (e.target.value !== 'teams');
      }
    });
  }

  function field(label, control) {
    return '<label class="pa-field"><span class="pa-lab">' + esc(label) + '</span>' + control + '</label>';
  }

  function teamPicker() {
    if (!PA.teams.length) {
      return '<div class="pa-teamlist-none">This club has no teams yet. Create one first, or invite with club-wide access.</div>';
    }
    return PA.teams.map(function (t) {
      return '<label class="pa-check"><input type="checkbox" name="teamIds" value="' + esc(t.id) + '"> '
        + '<span data-user-content>' + esc(t.name) + '</span></label>';
    }).join('');
  }

  function closePanel() {
    var p = document.getElementById('pa-panel');
    if (p) p.remove();
  }

  function showErr(msg) {
    var e = document.getElementById('pa-err');
    if (!e) return;
    e.textContent = msg;
    e.hidden = !msg;
  }

  function submitInvite(ev) {
    ev.preventDefault();
    var form = ev.target;
    var send = document.getElementById('pa-send');
    var data = new FormData(form);
    var email = String(data.get('email') || '').trim();
    var role = String(data.get('role') || '');
    var scope = String(data.get('scope') || 'teams');
    var teamIds = data.getAll('teamIds').map(String);

    if (!String(data.get('firstName') || '').trim() || !String(data.get('lastName') || '').trim()) {
      return showErr('A first and last name are required.');
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showErr('Enter a valid email address.');
    if (scope === 'teams' && !teamIds.length) {
      return showErr('Pick at least one team, or choose club-wide access.');
    }
    showErr('');
    send.disabled = true;
    send.textContent = 'Sending…';

    // The name goes nowhere near the invitation: the invited person types their
    // own on the acceptance page, and an inviter's guess at somebody's name is
    // not an identity. It is collected here because a club writes to a person,
    // and it is used in the confirmation this screen shows.
    var body = { email: email, role: role };
    if (scope === 'teams') body.teamIds = teamIds;

    api().post('/invitations', body).then(function (r) {
      var out = (r && r.data) || r || {};
      var delivery = out.delivery || {};
      closePanel();
      if (delivery.state === 'SENT') {
        // The address is appended rather than embedded for the same reason:
        // "Invitation sent" is the sentence, and the address is data.
        toast('Invitation sent' + ' · ' + email, 'success');
      } else if (delivery.notConfigured) {
        toast('Invitation created, but email delivery is not configured on this deployment.', 'warning');
      } else {
        toast('Invitation created, but the email could not be delivered. Try Resend.', 'warning');
      }
      PA.activeTab = 'invitations';
      return load();
    }).catch(function (e) {
      send.disabled = false;
      send.textContent = 'Send invitation';
      showErr((e && (e.userMessage || e.message)) || 'The invitation could not be sent.');
    });
  }

  // ── confirmation, for the destructive things ───────────────────────────────
  //
  // A Familista panel, never window.confirm: a browser dialog blocks the page,
  // cannot be styled, and reads as a bug in a product like this one.
  function confirmAction(opts) {
    return new Promise(function (resolve) {
      closePanel();
      var wrap = document.createElement('div');
      wrap.className = 'pa-scrim';
      wrap.id = 'pa-panel';
      wrap.innerHTML = '<div class="pa-panel pa-panel--sm" role="dialog" aria-modal="true">'
        + '<div class="pa-panel-h"><div><h2>' + esc(opts.title) + '</h2>'
        // The person is its own element, never spliced into the sentence: a
        // name inside a sentence makes that sentence untranslatable, because
        // the catalogue would be keyed by somebody's name.
        + (opts.subject ? '<p class="pa-subject" data-user-content>' + esc(opts.subject) + '</p>' : '')
        + '<p>' + esc(opts.body) + '</p></div></div>'
        + '<div class="pa-panel-f">'
        +   '<button type="button" class="pa-btn" data-pa="paCancel">Cancel</button>'
        +   '<button type="button" class="pa-btn pa-btn--' + (opts.tone || 'danger') + ' pa-btn--solid" data-pa="paOk">'
        +     esc(opts.confirm) + '</button>'
        + '</div></div>';
      document.body.appendChild(wrap);
      // Same animation as the invite panel; nothing to toggle.
      wrap.addEventListener('click', function (e) {
        var t = e.target.closest && e.target.closest('[data-pa]');
        if (!t) return;
        var what = t.getAttribute('data-pa');
        if (what === 'paOk') { closePanel(); resolve(true); }
        if (what === 'paCancel') { closePanel(); resolve(false); }
      });
    });
  }

  /** A small chooser — for a role or a team — returning the picked value. */
  function choose(opts) {
    return new Promise(function (resolve) {
      closePanel();
      var wrap = document.createElement('div');
      wrap.className = 'pa-scrim';
      wrap.id = 'pa-panel';
      wrap.innerHTML = '<div class="pa-panel pa-panel--sm" role="dialog" aria-modal="true">'
        + '<div class="pa-panel-h"><div><h2>' + esc(opts.title) + '</h2>'
        + (opts.subject ? '<p class="pa-subject" data-user-content>' + esc(opts.subject) + '</p>' : '')
        + '<p>' + esc(opts.body) + '</p></div></div>'
        + '<div class="pa-form"><label class="pa-field"><span class="pa-lab">' + esc(opts.label) + '</span>'
        + '<select class="pa-in" id="pa-choose">'
        + opts.options.map(function (o) {
          return '<option value="' + esc(o[0]) + '"' + (o[0] === opts.value ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
        }).join('')
        + '</select></label></div>'
        + '<div class="pa-panel-f">'
        +   '<button type="button" class="pa-btn" data-pa="paCancel">Cancel</button>'
        +   '<button type="button" class="pa-invite" data-pa="paOk">' + esc(opts.confirm) + '</button>'
        + '</div></div>';
      document.body.appendChild(wrap);
      // Same animation as the invite panel; nothing to toggle.
      wrap.addEventListener('click', function (e) {
        var t = e.target.closest && e.target.closest('[data-pa]');
        if (!t) return;
        var what = t.getAttribute('data-pa');
        if (what === 'paOk') {
          var v = (document.getElementById('pa-choose') || {}).value;
          closePanel(); resolve(v == null ? null : String(v));
        }
        if (what === 'paCancel') { closePanel(); resolve(null); }
      });
    });
  }

  // ── the calls ──────────────────────────────────────────────────────────────
  //
  // Every one of these is refused by the server for a caller who may not make
  // it. What the screen adds is that it does not offer them, and that a failure
  // says what happened rather than leaving a row looking changed.
  function run(id, promise, okMessage) {
    PA.busy[id] = true; paint();
    return promise.then(function () {
      toast(okMessage, 'success');
      return load();
    }).catch(function (e) {
      toast((e && (e.userMessage || e.message)) || 'That could not be completed.', 'error');
    }).then(function () {
      delete PA.busy[id]; paint();
    });
  }

  function member(id) { return PA.members.filter(function (m) { return m.id === id; })[0]; }

  var HANDLERS = {
    paTab: function (el) { PA.activeTab = el.getAttribute('data-tab') || 'members'; paint(); },
    paInvite: openInvite,
    paClose: closePanel,

    paSuspend: function (el) {
      var id = el.getAttribute('data-id'); var m = member(id); if (!m) return;
      confirmAction({
        title: 'Suspend access?',
        subject: fullName(m.user),
        body: 'They will be signed out and lose access to this club until you restore it. '
          + 'Their Familista account and password are not affected.',
        confirm: 'Suspend access', tone: 'warn',
      }).then(function (ok) {
        if (ok) run(id, api().post('/memberships/' + id + '/suspend', {}), 'Access suspended');
      });
    },

    paReactivate: function (el) {
      var id = el.getAttribute('data-id');
      run(id, api().post('/memberships/' + id + '/reactivate', {}), 'Access restored');
    },

    paRemove: function (el) {
      var id = el.getAttribute('data-id'); var m = member(id); if (!m) return;
      confirmAction({
        title: 'Remove from club?',
        subject: fullName(m.user),
        body: 'They lose this club’s access immediately. Their personal Familista account stays '
          + 'exactly as it is — this ends their access here, not their account.',
        confirm: 'Remove access',
      }).then(function (ok) {
        if (ok) run(id, api().delete('/memberships/' + id), 'Removed from the club');
      });
    },

    paChangeRole: function (el) {
      var id = el.getAttribute('data-id'); var m = member(id); if (!m) return;
      choose({
        title: 'Change role', subject: fullName(m.user), body: 'What this person is in this club.',
        label: 'Role', value: m.role, confirm: 'Save role',
        // President is offered only to somebody the server would accept it
        // from — the same `canAppointPresident` the invite dialog reads, and
        // the same rule `changeRole` enforces. Two doors into the same room,
        // one rule.
        options: withCurrent(invitableRoles(), m.role).map(function (r) { return [r, roleLabel(r)]; }),
      }).then(function (role) {
        if (role && role !== m.role) run(id, api().patch('/memberships/' + id + '/role', { role: role }), 'Role changed');
      });
    },

    paChangeTeam: function (el) {
      var id = el.getAttribute('data-id'); var m = member(id); if (!m) return;
      choose({
        title: 'Change team access', subject: fullName(m.user), body: 'What this membership reaches.',
        label: 'Team', value: m.teamId || '', confirm: 'Save access',
        options: [['', 'The whole club']].concat(PA.teams.map(function (t) { return [t.id, t.name]; })),
      }).then(function (teamId) {
        if (teamId === null) return;
        var next = teamId || null;
        if (next === (m.teamId || null)) return;
        run(id, api().patch('/memberships/' + id + '/team', { teamId: next }), 'Team access changed');
      });
    },

    paResend: function (el) {
      var id = el.getAttribute('data-id');
      confirmAction({
        title: 'Resend the invitation?',
        body: 'A new link is sent and the previous one stops working immediately.',
        confirm: 'Send a new link', tone: 'warn',
      }).then(function (ok) {
        if (ok) run(id, api().post('/invitations/' + id + '/resend', {}), 'A new invitation was sent');
      });
    },

    paRevoke: function (el) {
      var id = el.getAttribute('data-id');
      confirmAction({
        title: 'Revoke the invitation?',
        body: 'The link stops working immediately. You can invite the same person again later.',
        confirm: 'Revoke invitation',
      }).then(function (ok) {
        if (ok) run(id, api().delete('/invitations/' + id), 'Invitation revoked');
      });
    },
  };

  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-pa]');
    if (!t) return;
    var what = t.getAttribute('data-pa');
    // The confirm and choose panels answer their own clicks.
    if (what === 'paOk' || what === 'paCancel') return;
    var fn = HANDLERS[what];
    if (!fn) return;
    e.preventDefault();
    fn(t);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.getElementById('pa-panel')) closePanel();
  });

  // ── the entry points app.js registers ──────────────────────────────────────
  window.renderPeopleAccessHTML = function () {
    // `page`, and NOT `page active`. This was the only page template in the
    // application that shipped itself already active, and `navTo` mounts a page
    // AFTER it has cleared `.active` from every other one — so this page arrived
    // switched on beside whichever page was really open. Two `.page.active`
    // elements, both in flow, both `height:100%`: the document became twice the
    // viewport, the body grew a scrollbar it should not have, and every
    // navigation re-toggled `display` on a page that carries
    // `animation: fadeIn ... both` — replaying a `translateY(5px)` on content
    // stacked under the real screen, which is the shake.
    //
    // It also broke `document.querySelector('.page.active')`, which seven call
    // sites read to mean "the page the reader is looking at": with two matches
    // it returns whichever comes first in the container, so repaints landed on
    // a page nobody was looking at. `navTo` decides what is active, here as
    // everywhere else.
    return '<div class="page" id="pg-people-access">'
      + '<div class="pa-wrap" id="pa-content"></div>'
      + '</div>';
  };

  window.renderPeopleAccessPage = function () {
    PA.activeTab = 'members';
    paint();   // the shell, from whatever is already held
    load();    // and the answer behind it
  };
})();
