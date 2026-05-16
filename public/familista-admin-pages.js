/*
 * Familista — Admin Control Center · Page render functions
 * File: public/familista-admin-pages.js
 *
 * Each render function:
 *   - Receives a container element (already cleared) and a query state.
 *   - Hits the live backend via FamilistaAPI.admin.*
 *   - Returns nothing — paints into the container.
 *
 * No mock data anywhere. Every byte rendered comes from the API.
 */
(function () {
  'use strict';

  var UI  = window.AdminUI;
  var API = function () { return window.FamilistaAPI.admin; };

  // ─────────────────────────────────────────────────────────────────────
  // Helpers — pagination + filter wiring used by every list page
  // ─────────────────────────────────────────────────────────────────────

  function readQuery() {
    var hash = window.location.hash || '';
    var qi = hash.indexOf('?');
    if (qi === -1) return {};
    var out = {};
    var parts = hash.substring(qi + 1).split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (kv[0]) out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    }
    return out;
  }
  function writeQuery(route, q) {
    var parts = [];
    for (var k in q) {
      if (Object.prototype.hasOwnProperty.call(q, k) && q[k] !== '' && q[k] !== undefined && q[k] !== null) {
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(q[k])));
      }
    }
    var qs = parts.length ? ('?' + parts.join('&')) : '';
    var newHash = '#/' + route + qs;
    if (window.location.hash !== newHash) {
      // replaceState avoids history spam from typing in search
      history.replaceState(null, '', newHash);
    }
  }

  function withPager(state, route, container, render) {
    var p = UI.el('div');
    container.appendChild(p);
    p.appendChild(UI.pager(
      { total: state.total, page: state.page, limit: state.limit },
      function (page) {
        var q = Object.assign({}, state.q, { page: page });
        writeQuery(route, q);
        render(q);
      },
    ));
  }

  function renderListShell(container, opts) {
    var panel = UI.el('div', { class: 'panel' });
    if (opts.filters)  panel.appendChild(opts.filters);
    if (opts.body)     panel.appendChild(opts.body);
    if (opts.pagerBar) panel.appendChild(opts.pagerBar);
    container.appendChild(panel);
  }

  function showError(container, err) {
    UI.empty(container);
    container.appendChild(UI.el('div', { class: 'alert crit' }, [
      'Failed to load: ' + (err && err.message ? err.message : 'request error'),
    ]));
  }

  function head(title, lede, actions) {
    var n = UI.el('div', { class: 'page-head' }, [
      UI.el('div', {}, [
        UI.el('h1', { text: title }),
        lede ? UI.el('div', { class: 'lede', text: lede }) : null,
      ]),
      actions ? UI.el('div', { class: 'head-actions' }, actions) : null,
    ]);
    return n;
  }

  // ─────────────────────────────────────────────────────────────────────
  // 1. OVERVIEW
  // ─────────────────────────────────────────────────────────────────────

  function renderOverview(container) {
    UI.empty(container);
    container.appendChild(head('Dashboard', 'Cross-engine snapshot of the Familista platform.'));

    var q = readQuery();
    var win = q.window || '30d';

    // Window selector
    var winBar = UI.el('div', { class: 'panel' });
    var winHead = UI.el('div', { class: 'panel-head' }, [
      UI.el('h2', { text: 'Snapshot window' }),
      UI.el('div', { class: 'row', style: 'gap:6px;' }, ['24h', '7d', '30d', '90d', 'all'].map(function (w) {
        var b = UI.el('button', { class: 'btn' + (w === win ? ' primary' : ''), text: w });
        b.addEventListener('click', function () {
          writeQuery('overview', { window: w });
          renderOverview(container);
        });
        return b;
      })),
    ]);
    winBar.appendChild(winHead);
    container.appendChild(winBar);

    var kpis = UI.el('div', { class: 'kpi-grid' });
    container.appendChild(kpis);
    // skeleton placeholders
    for (var i = 0; i < 8; i++) kpis.appendChild(UI.el('div', { class: 'panel', style: 'padding:16px;' }, [UI.el('div', { class: 'skel lg', style: 'width:60%;margin-bottom:10px;' }), UI.el('div', { class: 'skel', style: 'width:40%;' })]));

    var enginesPanel = UI.el('div', { class: 'panel' }, [
      UI.el('div', { class: 'panel-head' }, [UI.el('h2', { text: 'Engine status' }), UI.el('div', { class: 'meta', text: 'live' })]),
      UI.skeleton(2, 6),
    ]);
    container.appendChild(enginesPanel);

    var twoCol = UI.el('div', { class: 'grid-2' });
    container.appendChild(twoCol);
    var alertsPanel   = UI.el('div', { class: 'panel' }, [UI.el('div', { class: 'panel-head' }, [UI.el('h2', { text: 'Alerts' })]), UI.skeleton(3, 1)]);
    var activityPanel = UI.el('div', { class: 'panel' }, [UI.el('div', { class: 'panel-head' }, [UI.el('h2', { text: 'Recent activity' })]), UI.skeleton(5, 2)]);
    twoCol.appendChild(alertsPanel);
    twoCol.appendChild(activityPanel);

    Promise.all([
      API().dashboard.overview({ window: win }),
      API().dashboard.engines(),
      API().dashboard.alerts(),
    ]).then(function (out) {
      var ov = out[0], en = out[1], al = out[2];

      // KPIs
      UI.empty(kpis);
      var c = ov.counts;
      kpis.appendChild(UI.kpi('Organizations', UI.fmtNum(c.organizations), UI.fmtNum(c.organizationsActive) + ' active', { accent: true }));
      kpis.appendChild(UI.kpi('Academies',     UI.fmtNum(c.academies),     'on ACADEMY plan'));
      kpis.appendChild(UI.kpi('Users',         UI.fmtNum(c.users),         UI.fmtNum(c.usersActive) + ' active'));
      kpis.appendChild(UI.kpi('Players',       UI.fmtNum(c.players)));
      kpis.appendChild(UI.kpi('Coaches',       UI.fmtNum(c.coaches),       'head + assistants'));
      kpis.appendChild(UI.kpi('Managers',      UI.fmtNum(c.managers)));
      kpis.appendChild(UI.kpi('Investors',     UI.fmtNum(c.investors),     UI.fmtNum(c.investorsActive) + ' active'));
      kpis.appendChild(UI.kpi('Franchise units', UI.fmtNum(c.franchiseUnits), UI.fmtNum(c.franchiseUnitsActive) + ' active'));
      kpis.appendChild(UI.kpi('Active subs',   UI.fmtNum(c.subscriptionsActive), UI.fmtNum(c.subscriptionsTrialing) + ' trial · ' + UI.fmtNum(c.subscriptionsPastDue) + ' past due'));
      kpis.appendChild(UI.kpi('Net revenue',   UI.fmtMoney(ov.revenue.net, ov.revenue.currency), UI.fmtNum(ov.revenue.transactions) + ' txns / ' + win, { accent: true }));
      kpis.appendChild(UI.kpi('AI decisions',  UI.fmtNum(c.aiDecisions), UI.fmtNum(c.aiModelsActive) + ' active models'));
      kpis.appendChild(UI.kpi('Vision runs',   UI.fmtNum(c.visionRuns), UI.fmtNum(c.visionRunsFailed) + ' failed'));
      kpis.appendChild(UI.kpi('Audit entries', UI.fmtNum(c.auditEntries), UI.fmtNum(c.auditFailures) + ' failures'));

      // Engines
      UI.empty(enginesPanel);
      enginesPanel.appendChild(UI.el('div', { class: 'panel-head' }, [
        UI.el('h2', { text: 'Engine status' }),
        UI.el('div', { class: 'meta', text: 'as of ' + UI.fmtDate(en.generatedAt) }),
      ]));
      var grid = UI.el('div', { class: 'engine-grid' });
      enginesPanel.appendChild(grid);
      for (var ei = 0; ei < en.engines.length; ei++) {
        var e = en.engines[ei];
        var metricsRow = UI.el('div', { class: 'metrics' });
        for (var mk in e.metrics) {
          metricsRow.appendChild(UI.el('div', { class: 'k', text: mk }));
          metricsRow.appendChild(UI.el('div', { text: UI.fmtNum(e.metrics[mk]) }));
        }
        grid.appendChild(UI.el('div', { class: 'engine' }, [
          UI.el('div', { class: 'top' }, [UI.el('div', { class: 'name', text: e.engine }), UI.badgeForBool(e.healthy, 'Healthy', 'Attention')]),
          metricsRow,
          UI.el('div', { class: 'last', text: e.lastActivityAt ? 'last activity: ' + UI.fmtRel(e.lastActivityAt) : 'no recent activity' }),
        ]));
      }

      // Alerts
      UI.empty(alertsPanel);
      alertsPanel.appendChild(UI.el('div', { class: 'panel-head' }, [UI.el('h2', { text: 'Alerts' }), UI.el('div', { class: 'meta', text: UI.fmtNum(al.alerts.length) + ' active' })]));
      var alBody = UI.el('div', { class: 'panel-body' });
      alertsPanel.appendChild(alBody);
      for (var ai = 0; ai < al.alerts.length; ai++) {
        var a = al.alerts[ai];
        var cls = a.severity === 'critical' ? 'crit' : a.severity === 'warning' ? 'warn' : 'info';
        alBody.appendChild(UI.el('div', { class: 'alert ' + cls }, [
          UI.el('div', {}, [
            UI.el('div', { style: 'font-weight:600;', text: a.message }),
            UI.el('div', { style: 'font-size:11.5px;color:var(--text-3);margin-top:3px;letter-spacing:0.4px;', text: a.code }),
          ]),
        ]));
      }

      // Activity
      UI.empty(activityPanel);
      activityPanel.appendChild(UI.el('div', { class: 'panel-head' }, [UI.el('h2', { text: 'Recent activity' }), UI.el('div', { class: 'meta', text: 'last 20 events' })]));
      var feed = UI.el('div', { class: 'feed' });
      activityPanel.appendChild(feed);
      if (ov.recentActivity.length === 0) {
        feed.appendChild(UI.emptyState('No events yet', 'Audit log is empty.'));
      } else {
        for (var fi = 0; fi < ov.recentActivity.length; fi++) {
          var ev = ov.recentActivity[fi];
          var tone = ev.result === 'SUCCESS' ? '' : 'crit';
          feed.appendChild(UI.el('div', { class: 'feed-item' }, [
            UI.el('div', { class: 'dot ' + tone }),
            UI.el('div', { class: 'body' }, [
              UI.el('div', { class: 'action', text: ev.action }),
              UI.el('div', { class: 'meta', text: [ev.category, ev.resourceType, ev.resourceId].filter(Boolean).join(' · ') }),
            ]),
            UI.el('div', { class: 'when', text: UI.fmtRel(ev.createdAt) }),
          ]));
        }
      }
    }).catch(function (err) { showError(container, err); });
  }

  // ─────────────────────────────────────────────────────────────────────
  // 2. ORGANIZATIONS / CLUBS / ACADEMIES
  // ─────────────────────────────────────────────────────────────────────

  function fetchOrgs(api, q) { return api(q); }

  function makeOrgPage(opts) {
    // opts: { title, lede, route, api, lockedFilters }
    return function (container) {
      UI.empty(container);
      container.appendChild(head(opts.title, opts.lede));

      var q = Object.assign({ page: 1, limit: 25 }, readQuery(), opts.lockedFilters || {});

      function reload(newQ) {
        var merged = Object.assign({}, q, newQ);
        if (newQ && !newQ.page) merged.page = 1;
        q = merged;
        writeQuery(opts.route, q);
        run();
      }

      function run() {
        var body = UI.skeleton(8, 6);
        var filters = UI.filterBar([
          { kind: 'search', key: 'q', placeholder: 'Search name, city, country…', value: q.q },
          { kind: 'select', key: 'plan',   label: 'Plan',   value: q.plan,   options: [
            { value: 'BASIC', label: 'Basic' }, { value: 'PRO', label: 'Pro' },
            { value: 'ACADEMY', label: 'Academy' }, { value: 'ENTERPRISE', label: 'Enterprise' },
          ] },
          { kind: 'select', key: 'status', label: 'Status', value: q.status, options: [
            { value: 'ACTIVE', label: 'Active' }, { value: 'TRIALING', label: 'Trialing' },
            { value: 'PAST_DUE', label: 'Past due' }, { value: 'CANCELED', label: 'Canceled' },
            { value: 'INCOMPLETE', label: 'Incomplete' },
          ] },
          { kind: 'select', key: 'hasOverride', label: 'Override', value: q.hasOverride, options: [
            { value: 'true', label: 'Has override' }, { value: 'false', label: 'No override' },
          ] },
        ], reload);

        renderListShell(container, { filters: filters, body: body });

        opts.api(q).then(function (res) {
          UI.empty(container);
          container.appendChild(head(opts.title, opts.lede));
          var rows = res || [];
          // The API client unwraps `data` but pagination meta is on the envelope's
          // siblings — re-fetch via raw to read pagination.
          window.FamilistaAPI.raw.request('GET', opts.endpoint, { query: q }).then(function (env) {
            var items = env && env.data ? env.data : [];
            var pag   = (env && env.pagination) || { total: items.length, page: q.page, limit: q.limit };
            var tbl   = UI.table([
              { key: 'name',    header: 'Name',    render: function (r) { return UI.el('div', {}, [UI.el('div', { style: 'font-weight:600;', text: r.name }), UI.el('div', { class: 'muted mono', text: r.id })]); } },
              { key: 'city',    header: 'Location', render: function (r) { return r.city + ' · ' + r.country; } },
              { key: 'plan',    header: 'Plan',    render: function (r) { return UI.badge(r.plan, r.plan === 'ENTERPRISE' ? 'gold' : 'silver'); } },
              { key: 'status',  header: 'Status',  render: function (r) { return UI.badgeForSubStatus(r.subscriptionStatus); } },
              { key: 'planSource', header: 'Source', render: function (r) { return r.planSource === 'OVERRIDE' ? UI.badge('OVERRIDE', 'warn') : UI.badge(r.planSource, 'silver'); } },
              { key: 'userCount',   header: 'Users',   cls: 'num', render: function (r) { return UI.fmtNum(r.userCount); } },
              { key: 'playerCount', header: 'Players', cls: 'num', render: function (r) { return UI.fmtNum(r.playerCount); } },
              { key: 'createdAt',   header: 'Created',          render: function (r) { return UI.fmtDate(r.createdAt, { short: true }); } },
            ], items, { onRow: openOrg });

            var panel = UI.el('div', { class: 'panel' });
            panel.appendChild(filters);
            panel.appendChild(tbl);
            panel.appendChild(UI.pager(
              { total: pag.total, page: pag.page, limit: pag.limit },
              function (page) { reload({ page: page }); },
            ));
            container.appendChild(panel);
          }).catch(function (err) { showError(container, err); });
        }).catch(function (err) { showError(container, err); });
      }

      function openOrg(row) {
        API().orgs.get(row.id).then(function (d) {
          var body = UI.el('div');
          body.appendChild(UI.el('section', {}, [
            UI.el('h4', { text: 'Identity' }),
            UI.dl([
              ['Name', d.name],
              ['ID', UI.el('span', { class: 'mono', text: d.id })],
              ['City', d.city],
              ['Country', d.country],
              ['Founded', UI.fmtDate(d.founded, { short: true })],
              ['Stadium', d.stadium || '—'],
              ['Capacity', d.capacity ? UI.fmtNum(d.capacity) : '—'],
            ]),
          ]));
          body.appendChild(UI.el('section', {}, [
            UI.el('h4', { text: 'Billing' }),
            UI.dl([
              ['Plan', UI.badge(d.plan, d.plan === 'ENTERPRISE' ? 'gold' : 'silver')],
              ['Status', UI.badgeForSubStatus(d.subscriptionStatus)],
              ['Plan source', d.planSource === 'OVERRIDE' ? UI.badge('OVERRIDE', 'warn') : UI.badge(d.planSource || '—', 'silver')],
              ['Trial ends', UI.fmtDate(d.trialEndsAt)],
              ['Period end', UI.fmtDate(d.currentPeriodEnd)],
              ['Stripe customer', UI.el('span', { class: 'mono', text: d.stripeCustomerId || '—' })],
              ['Stripe subscription', UI.el('span', { class: 'mono', text: d.stripeSubscriptionId || '—' })],
              ['Active overrides', UI.fmtNum((d.subscriptionOverrides || []).length)],
            ]),
          ]));
          if (d.franchiseUnit) {
            body.appendChild(UI.el('section', {}, [
              UI.el('h4', { text: 'Franchise unit' }),
              UI.dl([
                ['Code', d.franchiseUnit.code],
                ['Name', d.franchiseUnit.name],
                ['Level', UI.badge(d.franchiseUnit.level, 'silver')],
                ['Status', UI.badgeForFranchiseStatus(d.franchiseUnit.status)],
              ]),
            ]));
          }
          body.appendChild(UI.el('section', {}, [
            UI.el('h4', { text: 'Counters' }),
            UI.dl([
              ['Users',          UI.fmtNum(d._count && d._count.users)],
              ['Players',        UI.fmtNum(d._count && d._count.players)],
              ['Financial rows', UI.fmtNum(d._count && d._count.financials)],
              ['Matches',        UI.fmtNum(d._count && d._count.matches)],
              ['AI insights',    UI.fmtNum(d._count && d._count.aiInsights)],
            ]),
          ]));
          UI.drawerOpen({ title: d.name, body: body });
        }).catch(function (err) { UI.toast(err.message || 'Failed to load detail', 'err'); });
      }

      run();
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // 3. USERS / COACHES / MANAGERS
  // ─────────────────────────────────────────────────────────────────────

  function makeUserPage(opts) {
    return function (container) {
      UI.empty(container);
      container.appendChild(head(opts.title, opts.lede));

      var q = Object.assign({ page: 1, limit: 25 }, readQuery());

      function reload(newQ) {
        var merged = Object.assign({}, q, newQ);
        if (newQ && !newQ.page) merged.page = 1;
        q = merged;
        writeQuery(opts.route, q);
        run();
      }

      function run() {
        var filterFields = [
          { kind: 'search', key: 'q', placeholder: 'Search name or email…', value: q.q },
          { kind: 'select', key: 'isActive', label: 'Status', value: q.isActive, options: [
            { value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' },
          ] },
        ];
        if (!opts.lockedRoles) {
          filterFields.splice(1, 0, { kind: 'select', key: 'role', label: 'Role', value: q.role, options: [
            { value: 'SUPER_ADMIN', label: 'Super admin' },
            { value: 'CLUB_ADMIN', label: 'Club admin' },
            { value: 'HEAD_COACH', label: 'Head coach' },
            { value: 'ASSISTANT_COACH', label: 'Assistant coach' },
            { value: 'ANALYST', label: 'Analyst' },
            { value: 'MEDICAL_STAFF', label: 'Medical staff' },
            { value: 'SCOUT', label: 'Scout' },
          ] });
        }
        var filters = UI.filterBar(filterFields, reload);

        var panel = UI.el('div', { class: 'panel' });
        panel.appendChild(filters);
        panel.appendChild(UI.skeleton(6, 6));
        UI.empty(container);
        container.appendChild(head(opts.title, opts.lede));
        container.appendChild(panel);

        window.FamilistaAPI.raw.request('GET', opts.endpoint, { query: q }).then(function (env) {
          var items = env && env.data ? env.data : [];
          var pag   = (env && env.pagination) || { total: items.length, page: q.page, limit: q.limit };

          var canWrite = window.AdminAuth && window.AdminAuth.hasCap('platform-admin:write');

          var tbl = UI.table([
            { key: 'name', header: 'Name', render: function (r) {
              return UI.el('div', {}, [
                UI.el('div', { style: 'font-weight:600;', text: (r.firstName || '') + ' ' + (r.lastName || '') }),
                UI.el('div', { class: 'muted', text: r.email }),
              ]);
            } },
            { key: 'role',     header: 'Role',     render: function (r) { return UI.badge(r.role, 'silver'); } },
            { key: 'clubName', header: 'Club',     render: function (r) { return r.clubName || '—'; } },
            { key: 'isActive', header: 'Status',   render: function (r) { return UI.badgeForBool(r.isActive); } },
            { key: 'lastLoginAt', header: 'Last login', render: function (r) { return UI.fmtRel(r.lastLoginAt); } },
            { key: 'createdAt',   header: 'Created',    render: function (r) { return UI.fmtDate(r.createdAt, { short: true }); } },
            { key: 'actions',  header: '', cls: 'row-actions', render: function (r) {
              if (!canWrite) return UI.el('span', { class: 'muted', text: '—' });
              var btn = UI.el('button', { class: 'btn ' + (r.isActive ? 'danger' : ''), text: r.isActive ? 'Deactivate' : 'Reactivate' });
              btn.addEventListener('click', function () {
                var reason = window.prompt('Reason (audit log)') || '';
                UI.confirmAction((r.isActive ? 'Deactivate' : 'Reactivate') + ' user ' + r.email + '?').then(function (ok) {
                  if (!ok) return;
                  API().users.setActive(r.id, { isActive: !r.isActive, reason: reason }).then(function () {
                    UI.toast('Updated · audit recorded', 'ok');
                    reload({});
                  }).catch(function (err) { UI.toast(err.message || 'Update failed', 'err'); });
                });
              });
              return btn;
            } },
          ], items, { onRow: function (r) {
            UI.drawerOpen({
              title: (r.firstName || '') + ' ' + (r.lastName || ''),
              body: UI.dl([
                ['Email', r.email],
                ['Role', UI.badge(r.role, 'silver')],
                ['Status', UI.badgeForBool(r.isActive)],
                ['Club', r.clubName || '—'],
                ['Club ID', UI.el('span', { class: 'mono', text: r.clubId || '—' })],
                ['Last login', UI.fmtDate(r.lastLoginAt)],
                ['Created', UI.fmtDate(r.createdAt)],
                ['User ID', UI.el('span', { class: 'mono', text: r.id })],
              ]),
            });
          } });

          UI.empty(panel);
          panel.appendChild(filters);
          panel.appendChild(tbl);
          panel.appendChild(UI.pager({ total: pag.total, page: pag.page, limit: pag.limit }, function (page) { reload({ page: page }); }));
        }).catch(function (err) { showError(container, err); });
      }

      run();
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // 4. PLAYERS
  // ─────────────────────────────────────────────────────────────────────

  function renderPlayers(container) {
    UI.empty(container);
    container.appendChild(head('Players', 'All registered players across every tenant.'));

    var q = Object.assign({ page: 1, limit: 25 }, readQuery());

    function reload(newQ) {
      var merged = Object.assign({}, q, newQ);
      if (newQ && !newQ.page) merged.page = 1;
      q = merged;
      writeQuery('players', q);
      run();
    }

    function run() {
      var filters = UI.filterBar([
        { kind: 'search', key: 'q',      placeholder: 'Search name…', value: q.q },
        { kind: 'search', key: 'clubId', placeholder: 'Filter by club ID', value: q.clubId },
      ], reload);
      var panel = UI.el('div', { class: 'panel' });
      panel.appendChild(filters);
      panel.appendChild(UI.skeleton(6, 5));
      UI.empty(container);
      container.appendChild(head('Players', 'All registered players across every tenant.'));
      container.appendChild(panel);

      window.FamilistaAPI.raw.request('GET', '/admin/players', { query: q }).then(function (env) {
        var items = env && env.data ? env.data : [];
        var pag   = (env && env.pagination) || { total: items.length, page: q.page, limit: q.limit };
        var tbl = UI.table([
          { key: 'number',   header: '#', cls: 'num', render: function (r) { return UI.fmtNum(r.number); } },
          { key: 'name',     header: 'Name', render: function (r) { return (r.firstName || '') + ' ' + (r.lastName || ''); } },
          { key: 'position', header: 'Position', render: function (r) { return UI.badge(r.position || '—', 'silver'); } },
          { key: 'clubName', header: 'Club', render: function (r) { return r.clubName || '—'; } },
          { key: 'id',       header: 'ID', cls: 'mono', render: function (r) { return r.id; } },
        ], items);
        UI.empty(panel);
        panel.appendChild(filters);
        panel.appendChild(tbl);
        panel.appendChild(UI.pager({ total: pag.total, page: pag.page, limit: pag.limit }, function (page) { reload({ page: page }); }));
      }).catch(function (err) { showError(container, err); });
    }
    run();
  }

  // ─────────────────────────────────────────────────────────────────────
  // 5. INVESTORS
  // ─────────────────────────────────────────────────────────────────────

  function renderInvestors(container) {
    UI.empty(container);
    container.appendChild(head('Investors', 'Investor profiles registered on the platform.'));

    var q = Object.assign({ page: 1, limit: 25 }, readQuery());
    function reload(newQ) {
      var merged = Object.assign({}, q, newQ);
      if (newQ && !newQ.page) merged.page = 1;
      q = merged;
      writeQuery('investors', q);
      run();
    }

    function run() {
      var filters = UI.filterBar([
        { kind: 'search', key: 'q', placeholder: 'Search display, legal, email…', value: q.q },
        { kind: 'select', key: 'kycStatus', label: 'KYC', value: q.kycStatus, options: [
          { value: 'PENDING', label: 'Pending' }, { value: 'IN_REVIEW', label: 'In review' },
          { value: 'VERIFIED', label: 'Verified' }, { value: 'REJECTED', label: 'Rejected' },
          { value: 'EXPIRED', label: 'Expired' },
        ] },
        { kind: 'select', key: 'isActive', label: 'Status', value: q.isActive, options: [
          { value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' },
        ] },
      ], reload);
      var panel = UI.el('div', { class: 'panel' });
      panel.appendChild(filters);
      panel.appendChild(UI.skeleton(6, 6));
      UI.empty(container);
      container.appendChild(head('Investors', 'Investor profiles registered on the platform.'));
      container.appendChild(panel);

      window.FamilistaAPI.raw.request('GET', '/admin/investors', { query: q }).then(function (env) {
        var items = env && env.data ? env.data : [];
        var pag   = (env && env.pagination) || { total: items.length, page: q.page, limit: q.limit };

        var canWrite = window.AdminAuth && window.AdminAuth.hasCap('investor-profile:write');

        var tbl = UI.table([
          { key: 'displayName', header: 'Name', render: function (r) {
            return UI.el('div', {}, [
              UI.el('div', { style: 'font-weight:600;', text: r.displayName }),
              UI.el('div', { class: 'muted', text: r.legalName || '' }),
            ]);
          } },
          { key: 'type',         header: 'Type', render: function (r) { return UI.badge(r.type, 'silver'); } },
          { key: 'contactEmail', header: 'Contact', render: function (r) { return r.contactEmail || r.contactName || '—'; } },
          { key: 'countryCode',  header: 'Country' },
          { key: 'kycStatus',    header: 'KYC', render: function (r) { return UI.badgeForKyc(r.kycStatus); } },
          { key: 'accredited',   header: 'Accredited', render: function (r) { return r.accredited ? UI.badge('Yes', 'gold') : UI.badge('No', 'silver'); } },
          { key: 'aumUsd',       header: 'AUM (USD)', cls: 'num', render: function (r) { return r.aumUsd ? UI.fmtMoney(r.aumUsd, 'USD') : '—'; } },
          { key: 'isActive',     header: 'Status', render: function (r) { return UI.badgeForBool(r.isActive); } },
          { key: 'actions',      header: '', cls: 'row-actions', render: function (r) {
            if (!canWrite) return UI.el('span', { class: 'muted', text: '—' });
            var btn = UI.el('button', { class: 'btn ' + (r.isActive ? 'danger' : ''), text: r.isActive ? 'Deactivate' : 'Reactivate' });
            btn.addEventListener('click', function () {
              var reason = window.prompt('Reason (audit log)') || '';
              UI.confirmAction((r.isActive ? 'Deactivate' : 'Reactivate') + ' investor ' + r.displayName + '?').then(function (ok) {
                if (!ok) return;
                API().investors.setActive(r.id, { isActive: !r.isActive, reason: reason })
                  .then(function () { UI.toast('Updated · audit recorded', 'ok'); reload({}); })
                  .catch(function (err) { UI.toast(err.message || 'Update failed', 'err'); });
              });
            });
            return btn;
          } },
        ], items);

        UI.empty(panel);
        panel.appendChild(filters);
        panel.appendChild(tbl);
        panel.appendChild(UI.pager({ total: pag.total, page: pag.page, limit: pag.limit }, function (page) { reload({ page: page }); }));
      }).catch(function (err) { showError(container, err); });
    }
    run();
  }

  // ─────────────────────────────────────────────────────────────────────
  // 6. SUBSCRIPTIONS
  // ─────────────────────────────────────────────────────────────────────

  function renderSubscriptions(container) {
    UI.empty(container);
    container.appendChild(head('Subscriptions', 'Plan + status across every tenant. Operator overrides take precedence over Stripe.'));

    var q = Object.assign({ page: 1, limit: 25 }, readQuery());
    function reload(newQ) {
      var merged = Object.assign({}, q, newQ);
      if (newQ && !newQ.page) merged.page = 1;
      q = merged;
      writeQuery('subscriptions', q);
      run();
    }

    function run() {
      var filters = UI.filterBar([
        { kind: 'search', key: 'q', placeholder: 'Search organization…', value: q.q },
        { kind: 'select', key: 'plan', label: 'Plan', value: q.plan, options: [
          { value: 'BASIC', label: 'Basic' }, { value: 'PRO', label: 'Pro' },
          { value: 'ACADEMY', label: 'Academy' }, { value: 'ENTERPRISE', label: 'Enterprise' },
        ] },
        { kind: 'select', key: 'status', label: 'Status', value: q.status, options: [
          { value: 'ACTIVE', label: 'Active' }, { value: 'TRIALING', label: 'Trialing' },
          { value: 'PAST_DUE', label: 'Past due' }, { value: 'CANCELED', label: 'Canceled' },
          { value: 'INCOMPLETE', label: 'Incomplete' },
        ] },
      ], reload);

      var panel = UI.el('div', { class: 'panel' });
      panel.appendChild(filters);
      panel.appendChild(UI.skeleton(6, 6));
      UI.empty(container);
      container.appendChild(head('Subscriptions', 'Plan + status across every tenant. Operator overrides take precedence over Stripe.'));

      // Load breakdown KPIs
      var kpiRow = UI.el('div', { class: 'kpi-grid' });
      container.appendChild(kpiRow);
      for (var i = 0; i < 4; i++) kpiRow.appendChild(UI.el('div', { class: 'panel', style: 'padding:16px;' }, [UI.el('div', { class: 'skel lg' })]));
      container.appendChild(panel);

      API().dashboard.subscriptions().then(function (b) {
        UI.empty(kpiRow);
        kpiRow.appendChild(UI.kpi('Organizations', UI.fmtNum(b.totals.organizations)));
        kpiRow.appendChild(UI.kpi('Active overrides', UI.fmtNum(b.totals.overrides)));
        var trial = b.byStatus.find(function (s) { return s.status === 'TRIALING'; });
        var past  = b.byStatus.find(function (s) { return s.status === 'PAST_DUE'; });
        kpiRow.appendChild(UI.kpi('Trialing', UI.fmtNum(trial ? trial.count : 0)));
        kpiRow.appendChild(UI.kpi('Past due', UI.fmtNum(past ? past.count : 0), '', { accent: true }));
      }).catch(function () {});

      window.FamilistaAPI.raw.request('GET', '/admin/subscriptions', { query: q }).then(function (env) {
        var items = env && env.data ? env.data : [];
        var pag   = (env && env.pagination) || { total: items.length, page: q.page, limit: q.limit };
        var tbl = UI.table([
          { key: 'clubName', header: 'Organization', render: function (r) {
            return UI.el('div', {}, [
              UI.el('div', { style: 'font-weight:600;', text: r.clubName }),
              UI.el('div', { class: 'muted mono', text: r.clubId }),
            ]);
          } },
          { key: 'plan',     header: 'Plan',   render: function (r) { return UI.badge(r.plan, r.plan === 'ENTERPRISE' ? 'gold' : 'silver'); } },
          { key: 'status',   header: 'Status', render: function (r) { return UI.badgeForSubStatus(r.status); } },
          { key: 'planSource', header: 'Source', render: function (r) { return r.planSource === 'OVERRIDE' ? UI.badge('OVERRIDE', 'warn') : UI.badge(r.planSource, 'silver'); } },
          { key: 'trialEndsAt',      header: 'Trial ends', render: function (r) { return UI.fmtDate(r.trialEndsAt, { short: true }); } },
          { key: 'currentPeriodEnd', header: 'Period end', render: function (r) { return UI.fmtDate(r.currentPeriodEnd, { short: true }); } },
          { key: 'stripeCustomerId', header: 'Stripe customer', cls: 'mono', render: function (r) { return r.stripeCustomerId || '—'; } },
          { key: 'override',         header: 'Override', render: function (r) {
            if (!r.activeOverride) return UI.el('span', { class: 'muted', text: '—' });
            return UI.badge(r.activeOverride.plan + ' · ' + r.activeOverride.status, 'warn');
          } },
        ], items);
        UI.empty(panel);
        panel.appendChild(filters);
        panel.appendChild(tbl);
        panel.appendChild(UI.pager({ total: pag.total, page: pag.page, limit: pag.limit }, function (page) { reload({ page: page }); }));
      }).catch(function (err) { showError(container, err); });
    }
    run();
  }

  // ─────────────────────────────────────────────────────────────────────
  // 7. PAYMENTS
  // ─────────────────────────────────────────────────────────────────────

  function renderPayments(container) {
    UI.empty(container);
    container.appendChild(head('Payments', 'Financial ledger across every organization.'));

    var q = Object.assign({ page: 1, limit: 25 }, readQuery());
    function reload(newQ) {
      var merged = Object.assign({}, q, newQ);
      if (newQ && !newQ.page) merged.page = 1;
      q = merged;
      writeQuery('payments', q);
      run();
    }
    function run() {
      var filters = UI.filterBar([
        { kind: 'search', key: 'clubId',   placeholder: 'Filter by club ID',      value: q.clubId },
        { kind: 'search', key: 'category', placeholder: 'Filter by category…',     value: q.category },
        { kind: 'search', key: 'currency', placeholder: 'EUR / USD / …',           value: q.currency },
        { kind: 'select', key: 'type', label: 'Type', value: q.type, options: [
          { value: 'INCOME', label: 'Income' }, { value: 'EXPENSE', label: 'Expense' },
        ] },
        { kind: 'date',   key: 'from', label: 'From', value: q.from },
        { kind: 'date',   key: 'to',   label: 'To',   value: q.to },
      ], reload);

      var panel = UI.el('div', { class: 'panel' });
      panel.appendChild(filters);
      panel.appendChild(UI.skeleton(6, 6));
      UI.empty(container);
      container.appendChild(head('Payments', 'Financial ledger across every organization.'));
      var kpiRow = UI.el('div', { class: 'kpi-grid' });
      container.appendChild(kpiRow);
      container.appendChild(panel);

      window.FamilistaAPI.raw.request('GET', '/admin/payments', { query: q }).then(function (env) {
        var items = env && env.data ? env.data : [];
        var pag   = (env && env.pagination) || { total: items.length, page: q.page, limit: q.limit };
        var sum   = env && env.totals ? env.totals.amount : 0;
        UI.empty(kpiRow);
        kpiRow.appendChild(UI.kpi('Rows in scope', UI.fmtNum(pag.total)));
        kpiRow.appendChild(UI.kpi('Sum (mixed currency)', UI.fmtNum(sum, { maxFrac: 2 }), 'Filter by currency for accurate single-currency totals', { accent: true }));

        var tbl = UI.table([
          { key: 'date',     header: 'Date', render: function (r) { return UI.fmtDate(r.date); } },
          { key: 'clubName', header: 'Organization', render: function (r) { return r.clubName || '—'; } },
          { key: 'type',     header: 'Type', render: function (r) { return UI.badge(r.type, r.type === 'INCOME' ? 'ok' : 'silver'); } },
          { key: 'category', header: 'Category' },
          { key: 'amount',   header: 'Amount', cls: 'num', render: function (r) { return UI.fmtMoney(r.amount, r.currency); } },
          { key: 'description', header: 'Description', render: function (r) { return r.description || '—'; } },
        ], items);

        UI.empty(panel);
        panel.appendChild(filters);
        panel.appendChild(tbl);
        panel.appendChild(UI.pager({ total: pag.total, page: pag.page, limit: pag.limit }, function (page) { reload({ page: page }); }));
      }).catch(function (err) { showError(container, err); });
    }
    run();
  }

  // ─────────────────────────────────────────────────────────────────────
  // 8. FRANCHISE UNITS
  // ─────────────────────────────────────────────────────────────────────

  function renderFranchiseUnits(container) {
    UI.empty(container);
    container.appendChild(head('Franchise Units', 'Hierarchy of master / regional / local / academy units.'));

    var q = Object.assign({ page: 1, limit: 25 }, readQuery());
    function reload(newQ) {
      var merged = Object.assign({}, q, newQ);
      if (newQ && !newQ.page) merged.page = 1;
      q = merged;
      writeQuery('franchise-units', q);
      run();
    }
    function run() {
      var filters = UI.filterBar([
        { kind: 'search', key: 'q', placeholder: 'Search name / code / legal…', value: q.q },
        { kind: 'select', key: 'status', label: 'Status', value: q.status, options: [
          { value: 'PENDING', label: 'Pending' }, { value: 'ACTIVE', label: 'Active' },
          { value: 'SUSPENDED', label: 'Suspended' }, { value: 'IN_RENEWAL', label: 'In renewal' },
          { value: 'TERMINATED', label: 'Terminated' },
        ] },
        { kind: 'select', key: 'level', label: 'Level', value: q.level, options: [
          { value: 'MASTER', label: 'Master' }, { value: 'REGIONAL', label: 'Regional' },
          { value: 'LOCAL', label: 'Local' }, { value: 'ACADEMY', label: 'Academy' },
        ] },
      ], reload);
      var panel = UI.el('div', { class: 'panel' });
      panel.appendChild(filters);
      panel.appendChild(UI.skeleton(6, 7));
      UI.empty(container);
      container.appendChild(head('Franchise Units', 'Hierarchy of master / regional / local / academy units.'));
      container.appendChild(panel);

      window.FamilistaAPI.raw.request('GET', '/admin/franchise-units', { query: q }).then(function (env) {
        var items = env && env.data ? env.data : [];
        var pag   = (env && env.pagination) || { total: items.length, page: q.page, limit: q.limit };
        var canWrite = window.AdminAuth && window.AdminAuth.hasCap('franchise-unit:write');

        var tbl = UI.table([
          { key: 'code',  header: 'Code', cls: 'mono' },
          { key: 'name',  header: 'Name', render: function (r) { return UI.el('div', { style: 'font-weight:600;', text: r.name }); } },
          { key: 'level', header: 'Level', render: function (r) { return UI.badge(r.level, 'silver'); } },
          { key: 'status',  header: 'Status',  render: function (r) { return UI.badgeForFranchiseStatus(r.status); } },
          { key: 'clubCount', header: 'Clubs',  cls: 'num', render: function (r) { return UI.fmtNum(r.clubCount); } },
          { key: 'ownerCount', header: 'Owners', cls: 'num', render: function (r) { return UI.fmtNum(r.ownerCount); } },
          { key: 'territoryName', header: 'Territory', render: function (r) { return r.territoryName || '—'; } },
          { key: 'actions', header: '', cls: 'row-actions', render: function (r) {
            if (!canWrite) return UI.el('span', { class: 'muted', text: '—' });
            var sel = UI.el('select', { class: 'select', style: 'min-width:140px;' });
            ['', 'ACTIVE', 'SUSPENDED', 'TERMINATED'].forEach(function (s) {
              var o = UI.el('option', { value: s }, [s || 'Change status…']);
              if (s === r.status) o.selected = true;
              sel.appendChild(o);
            });
            sel.addEventListener('change', function () {
              if (!sel.value || sel.value === r.status) return;
              var reason = window.prompt('Reason (audit log)') || '';
              UI.confirmAction('Set ' + r.code + ' to ' + sel.value + '?').then(function (ok) {
                if (!ok) { sel.value = r.status; return; }
                API().franchiseUnits.setStatus(r.id, { status: sel.value, reason: reason })
                  .then(function () { UI.toast('Status updated · audit recorded', 'ok'); reload({}); })
                  .catch(function (err) { UI.toast(err.message || 'Update failed', 'err'); sel.value = r.status; });
              });
            });
            return sel;
          } },
        ], items);

        UI.empty(panel);
        panel.appendChild(filters);
        panel.appendChild(tbl);
        panel.appendChild(UI.pager({ total: pag.total, page: pag.page, limit: pag.limit }, function (page) { reload({ page: page }); }));
      }).catch(function (err) { showError(container, err); });
    }
    run();
  }

  // ─────────────────────────────────────────────────────────────────────
  // 9. AI ENGINE
  // ─────────────────────────────────────────────────────────────────────

  function renderAiEngine(container) {
    UI.empty(container);
    container.appendChild(head('AI Engine', 'Active decision models and recent decision activity.'));

    var kpis = UI.el('div', { class: 'kpi-grid' });
    container.appendChild(kpis);
    var byDomainPanel = UI.el('div', { class: 'panel' }, [UI.el('div', { class: 'panel-head' }, [UI.el('h2', { text: 'Decisions by domain' })]), UI.skeleton(2, 6)]);
    container.appendChild(byDomainPanel);

    API().dashboard.ai().then(function (d) {
      UI.empty(kpis);
      kpis.appendChild(UI.kpi('Active models', UI.fmtNum(d.models.active), 'of ' + UI.fmtNum(d.models.total) + ' total', { accent: true }));
      kpis.appendChild(UI.kpi('Total decisions', UI.fmtNum(d.decisions.total)));
      kpis.appendChild(UI.kpi('Domains in use', UI.fmtNum(d.byDomain.length)));

      UI.empty(byDomainPanel);
      byDomainPanel.appendChild(UI.el('div', { class: 'panel-head' }, [UI.el('h2', { text: 'Decisions by domain' }), UI.el('div', { class: 'meta', text: 'as of ' + UI.fmtDate(d.generatedAt) })]));
      byDomainPanel.appendChild(UI.table([
        { key: 'domain', header: 'Domain', render: function (r) { return UI.badge(r.domain, 'gold'); } },
        { key: 'count',  header: 'Count', cls: 'num', render: function (r) { return UI.fmtNum(r.count); } },
      ], d.byDomain));
    }).catch(function (err) { showError(byDomainPanel, err); });

    // Models table
    var modelsPanel = UI.el('div', { class: 'panel' });
    var modelFilters = UI.filterBar([
      { kind: 'search', key: 'q', placeholder: 'Search model name / slug…' },
      { kind: 'select', key: 'activeOnly', label: 'Filter', options: [
        { value: 'true', label: 'Active only' },
      ] },
    ], function (qq) {
      window.FamilistaAPI.raw.request('GET', '/admin/ai/models', { query: Object.assign({ page: 1, limit: 100 }, qq) }).then(function (env) {
        renderModelsTable(env && env.data ? env.data : []);
      });
    });
    function renderModelsTable(items) {
      var existing = modelsPanel.querySelector('.tbl-wrap');
      if (existing) existing.parentNode.removeChild(existing);
      modelsPanel.appendChild(UI.table([
        { key: 'name', header: 'Name', render: function (r) {
          return UI.el('div', {}, [UI.el('div', { style: 'font-weight:600;', text: r.name }), UI.el('div', { class: 'muted mono', text: r.slug })]);
        } },
        { key: 'domain',       header: 'Domain', render: function (r) { return UI.badge(r.domain, 'gold'); } },
        { key: 'decisionType', header: 'Decision' },
        { key: 'version',      header: 'Version', cls: 'mono' },
        { key: 'provider',     header: 'Provider' },
        { key: 'isActive',     header: 'Active', render: function (r) { return UI.badgeForBool(r.isActive); } },
        { key: 'createdAt',    header: 'Created', render: function (r) { return UI.fmtDate(r.createdAt, { short: true }); } },
      ], items));
    }
    modelsPanel.appendChild(UI.el('div', { class: 'panel-head' }, [UI.el('h2', { text: 'Models' })]));
    modelsPanel.appendChild(modelFilters);
    modelsPanel.appendChild(UI.skeleton(5, 6));
    container.appendChild(modelsPanel);

    window.FamilistaAPI.raw.request('GET', '/admin/ai/models', { query: { page: 1, limit: 100 } }).then(function (env) {
      var skel = modelsPanel.querySelector('.panel-body');
      if (skel) skel.parentNode.removeChild(skel);
      renderModelsTable(env && env.data ? env.data : []);
    }).catch(function (err) { showError(modelsPanel, err); });

    // Recent decisions
    var decPanel = UI.el('div', { class: 'panel' });
    decPanel.appendChild(UI.el('div', { class: 'panel-head' }, [UI.el('h2', { text: 'Recent decisions' })]));
    decPanel.appendChild(UI.skeleton(5, 4));
    container.appendChild(decPanel);
    window.FamilistaAPI.raw.request('GET', '/admin/ai/decisions', { query: { page: 1, limit: 25 } }).then(function (env) {
      var items = env && env.data ? env.data : [];
      var pag   = (env && env.pagination) || { total: items.length, page: 1, limit: 25 };
      var skel = decPanel.querySelector('.panel-body');
      if (skel) skel.parentNode.removeChild(skel);
      decPanel.appendChild(UI.table([
        { key: 'id',           header: 'ID', cls: 'mono' },
        { key: 'domain',       header: 'Domain', render: function (r) { return UI.badge(r.domain, 'gold'); } },
        { key: 'decisionType', header: 'Decision' },
        { key: 'createdAt',    header: 'When', render: function (r) { return UI.fmtDate(r.createdAt); } },
      ], items));
      decPanel.appendChild(UI.pager({ total: pag.total, page: pag.page, limit: pag.limit }, function (page) {
        window.FamilistaAPI.raw.request('GET', '/admin/ai/decisions', { query: { page: page, limit: 25 } }).then(function (env2) {
          var tblOld = decPanel.querySelector('.tbl-wrap'); if (tblOld) tblOld.parentNode.removeChild(tblOld);
          var pagerOld = decPanel.querySelector('.pager');  if (pagerOld) pagerOld.parentNode.removeChild(pagerOld);
          var items2 = env2 && env2.data ? env2.data : [];
          var pag2 = (env2 && env2.pagination) || { total: items2.length, page: page, limit: 25 };
          decPanel.appendChild(UI.table([
            { key: 'id',           header: 'ID', cls: 'mono' },
            { key: 'domain',       header: 'Domain', render: function (r) { return UI.badge(r.domain, 'gold'); } },
            { key: 'decisionType', header: 'Decision' },
            { key: 'createdAt',    header: 'When', render: function (r) { return UI.fmtDate(r.createdAt); } },
          ], items2));
          decPanel.appendChild(UI.pager({ total: pag2.total, page: pag2.page, limit: pag2.limit }, arguments.callee));
        });
      }));
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // 10. VISION ENGINE
  // ─────────────────────────────────────────────────────────────────────

  function renderVisionEngine(container) {
    UI.empty(container);
    container.appendChild(head('Vision Engine', 'Analysis runs and frame-level health.'));

    var kpis = UI.el('div', { class: 'kpi-grid' });
    container.appendChild(kpis);
    var byStatusPanel = UI.el('div', { class: 'panel' }, [UI.el('div', { class: 'panel-head' }, [UI.el('h2', { text: 'Runs by status' })]), UI.skeleton(2, 6)]);
    container.appendChild(byStatusPanel);

    API().dashboard.vision().then(function (d) {
      UI.empty(kpis);
      kpis.appendChild(UI.kpi('Total runs', UI.fmtNum(d.runs.total), '', { accent: true }));
      kpis.appendChild(UI.kpi('Frames processed', UI.fmtNum(d.framesProcessed)));
      kpis.appendChild(UI.kpi('Errors',   UI.fmtNum(d.errors)));
      kpis.appendChild(UI.kpi('Warnings', UI.fmtNum(d.warnings)));

      UI.empty(byStatusPanel);
      byStatusPanel.appendChild(UI.el('div', { class: 'panel-head' }, [UI.el('h2', { text: 'Runs by status' }), UI.el('div', { class: 'meta', text: 'as of ' + UI.fmtDate(d.generatedAt) })]));
      byStatusPanel.appendChild(UI.table([
        { key: 'status', header: 'Status', render: function (r) { return UI.badgeForIngestStatus(r.status); } },
        { key: 'count',  header: 'Count', cls: 'num', render: function (r) { return UI.fmtNum(r.count); } },
      ], d.byStatus));
    }).catch(function (err) { showError(byStatusPanel, err); });

    // Runs list
    var runsPanel = UI.el('div', { class: 'panel' });
    runsPanel.appendChild(UI.el('div', { class: 'panel-head' }, [UI.el('h2', { text: 'Analysis runs' })]));
    var filters = UI.filterBar([
      { kind: 'select', key: 'status', label: 'Status', options: [
        { value: 'QUEUED', label: 'Queued' }, { value: 'RUNNING', label: 'Running' },
        { value: 'COMPLETED', label: 'Completed' }, { value: 'FAILED', label: 'Failed' },
        { value: 'CANCELLED', label: 'Cancelled' },
      ] },
      { kind: 'search', key: 'clubId', placeholder: 'Filter by club ID' },
    ], function (q) {
      var page = 1;
      reloadRuns(Object.assign({ page: page, limit: 25 }, q));
    });
    runsPanel.appendChild(filters);
    runsPanel.appendChild(UI.skeleton(5, 7));
    container.appendChild(runsPanel);

    function reloadRuns(q) {
      window.FamilistaAPI.raw.request('GET', '/admin/vision/runs', { query: q }).then(function (env) {
        var items = env && env.data ? env.data : [];
        var pag   = (env && env.pagination) || { total: items.length, page: q.page, limit: q.limit };
        var skel = runsPanel.querySelector('.panel-body'); if (skel) skel.parentNode.removeChild(skel);
        var tblOld = runsPanel.querySelector('.tbl-wrap'); if (tblOld) tblOld.parentNode.removeChild(tblOld);
        var pagerOld = runsPanel.querySelector('.pager');  if (pagerOld) pagerOld.parentNode.removeChild(pagerOld);
        runsPanel.appendChild(UI.table([
          { key: 'id',            header: 'Run ID', cls: 'mono' },
          { key: 'modelProvider', header: 'Model', render: function (r) { return (r.modelProvider || '—') + ' · ' + (r.modelVersion || '—'); } },
          { key: 'status',        header: 'Status', render: function (r) { return UI.badgeForIngestStatus(r.status); } },
          { key: 'frames',        header: 'Frames', cls: 'num', render: function (r) { return UI.fmtNum(r.framesProcessed) + ' / ' + UI.fmtNum(r.framesTotal || 0); } },
          { key: 'errorsCount',   header: 'Errors', cls: 'num', render: function (r) { return UI.fmtNum(r.errorsCount); } },
          { key: 'durationMs',    header: 'Duration', cls: 'num', render: function (r) { return r.durationMs ? UI.fmtNum(r.durationMs / 1000, { maxFrac: 1 }) + 's' : '—'; } },
          { key: 'createdAt',     header: 'Created', render: function (r) { return UI.fmtDate(r.createdAt); } },
        ], items));
        runsPanel.appendChild(UI.pager({ total: pag.total, page: pag.page, limit: pag.limit }, function (page) {
          reloadRuns(Object.assign({}, q, { page: page }));
        }));
      });
    }
    reloadRuns({ page: 1, limit: 25 });
  }

  // ─────────────────────────────────────────────────────────────────────
  // 11. AUDIT LOGS
  // ─────────────────────────────────────────────────────────────────────

  function renderAuditLogs(container) {
    UI.empty(container);
    container.appendChild(head('Audit Logs', 'Every privileged action and access decision is recorded here.'));

    var q = Object.assign({ page: 1, limit: 50 }, readQuery());
    function reload(newQ) {
      var merged = Object.assign({}, q, newQ);
      if (newQ && !newQ.page) merged.page = 1;
      q = merged;
      writeQuery('audit-logs', q);
      run();
    }
    function run() {
      var filters = UI.filterBar([
        { kind: 'search', key: 'action',       placeholder: 'Action…',        value: q.action },
        { kind: 'search', key: 'adminId',     placeholder: 'Admin ID…',      value: q.adminId },
        { kind: 'search', key: 'clubId',      placeholder: 'Club ID…',       value: q.clubId },
        { kind: 'search', key: 'resourceType',placeholder: 'Resource type…', value: q.resourceType },
        { kind: 'select', key: 'category', label: 'Category', value: q.category, options: [
          'BRANDING','DOMAIN','ASSET','PALETTE','BILLING','LICENSE','LIMITS','ACCESS','IMPERSONATION','FEATURE_FLAG','PLATFORM_ADMIN','OTHER'
        ].map(function (c) { return { value: c, label: c }; }) },
        { kind: 'select', key: 'result', label: 'Result', value: q.result, options: [
          { value: 'SUCCESS', label: 'Success' },
          { value: 'FAILURE', label: 'Failure' },
          { value: 'REJECTED', label: 'Rejected' },
        ] },
        { kind: 'date', key: 'from', label: 'From', value: q.from },
        { kind: 'date', key: 'to',   label: 'To',   value: q.to },
      ], reload);

      var panel = UI.el('div', { class: 'panel' });
      panel.appendChild(filters);
      panel.appendChild(UI.skeleton(8, 7));
      UI.empty(container);
      container.appendChild(head('Audit Logs', 'Every privileged action and access decision is recorded here.'));
      container.appendChild(panel);

      window.FamilistaAPI.raw.request('GET', '/admin/audit-logs', { query: q }).then(function (env) {
        var items = env && env.data ? env.data : [];
        var pag   = (env && env.pagination) || { total: items.length, page: q.page, limit: q.limit };
        var tbl = UI.table([
          { key: 'createdAt', header: 'When', render: function (r) { return UI.fmtDate(r.createdAt); } },
          { key: 'action',    header: 'Action', render: function (r) { return UI.el('span', { style: 'font-weight:600;', text: r.action }); } },
          { key: 'category',  header: 'Category', render: function (r) { return UI.badge(r.category, 'silver'); } },
          { key: 'result',    header: 'Result',   render: function (r) { return UI.badgeForAuditResult(r.result); } },
          { key: 'adminId',   header: 'Admin', cls: 'mono', render: function (r) { return r.adminId || '—'; } },
          { key: 'resource',  header: 'Resource', render: function (r) {
            if (!r.resourceType) return '—';
            return UI.el('div', {}, [UI.el('div', { text: r.resourceType }), UI.el('div', { class: 'muted mono', text: r.resourceId || '' })]);
          } },
          { key: 'ipAddress', header: 'IP', cls: 'mono' },
          { key: 'message',   header: 'Message', render: function (r) { return r.message || '—'; } },
        ], items, { onRow: function (r) {
          UI.drawerOpen({
            title: r.action,
            body: UI.el('div', {}, [
              UI.dl([
                ['When', UI.fmtDate(r.createdAt)],
                ['Result', UI.badgeForAuditResult(r.result)],
                ['Category', UI.badge(r.category, 'silver')],
                ['Admin ID', UI.el('span', { class: 'mono', text: r.adminId || '—' })],
                ['User ID', UI.el('span', { class: 'mono', text: r.userId || '—' })],
                ['Club ID', UI.el('span', { class: 'mono', text: r.clubId || '—' })],
                ['Resource', (r.resourceType || '—') + (r.resourceId ? ' (' + r.resourceId + ')' : '')],
                ['IP', UI.el('span', { class: 'mono', text: r.ipAddress || '—' })],
                ['User agent', r.userAgent || '—'],
                ['Message', r.message || '—'],
              ]),
              UI.el('section', {}, [
                UI.el('h4', { text: 'Metadata' }),
                UI.el('pre', {
                  style: 'background:var(--bg-0);padding:12px;border-radius:6px;font-size:12px;overflow:auto;max-height:280px;border:1px solid var(--border);',
                  text: r.metadata ? JSON.stringify(r.metadata, null, 2) : '—',
                }),
              ]),
            ]),
          });
        } });
        UI.empty(panel);
        panel.appendChild(filters);
        panel.appendChild(tbl);
        panel.appendChild(UI.pager({ total: pag.total, page: pag.page, limit: pag.limit }, function (page) { reload({ page: page }); }));
      }).catch(function (err) { showError(container, err); });
    }
    run();
  }

  // ─────────────────────────────────────────────────────────────────────
  // 12. ALERTS (full-page)
  // ─────────────────────────────────────────────────────────────────────

  function renderAlerts(container) {
    UI.empty(container);
    container.appendChild(head('Alerts', 'Anomalies surfaced from the engines and billing layer.'));
    var panel = UI.el('div', { class: 'panel' }, [UI.skeleton(4, 1)]);
    container.appendChild(panel);
    API().dashboard.alerts().then(function (d) {
      UI.empty(panel);
      panel.appendChild(UI.el('div', { class: 'panel-head' }, [
        UI.el('h2', { text: 'Active alerts' }),
        UI.el('div', { class: 'meta', text: 'as of ' + UI.fmtDate(d.generatedAt) }),
      ]));
      var body = UI.el('div', { class: 'panel-body' });
      panel.appendChild(body);
      if (!d.alerts || d.alerts.length === 0) {
        body.appendChild(UI.emptyState('No active alerts', 'All systems nominal.'));
      } else {
        for (var i = 0; i < d.alerts.length; i++) {
          var a = d.alerts[i];
          var cls = a.severity === 'critical' ? 'crit' : a.severity === 'warning' ? 'warn' : 'info';
          body.appendChild(UI.el('div', { class: 'alert ' + cls }, [
            UI.el('div', { style: 'flex:1;' }, [
              UI.el('div', { style: 'font-weight:600;', text: a.message }),
              UI.el('div', { style: 'font-size:11.5px;color:var(--text-3);margin-top:3px;letter-spacing:0.4px;', text: a.code + (a.count !== undefined ? '  ·  count: ' + a.count : '') }),
            ]),
          ]));
        }
      }
    }).catch(function (err) { showError(panel, err); });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Public — page registry consumed by the router in admin-app.js
  // ─────────────────────────────────────────────────────────────────────

  window.AdminPages = {
    'overview':        renderOverview,
    'alerts':          renderAlerts,
    'organizations':   makeOrgPage({ title: 'Organizations', lede: 'All tenants on the platform.',   route: 'organizations', api: function (q) { return API().orgs.list(q); }, endpoint: '/admin/organizations' }),
    'clubs':           makeOrgPage({ title: 'Clubs',         lede: 'Same view as Organizations.',     route: 'clubs',         api: function (q) { return API().clubs.list(q); }, endpoint: '/admin/clubs' }),
    'academies':       makeOrgPage({ title: 'Academies',     lede: 'Clubs operating on the ACADEMY plan.', route: 'academies', api: function (q) { return API().academies.list(q); }, endpoint: '/admin/academies', lockedFilters: { plan: 'ACADEMY' } }),
    'players':         renderPlayers,
    'coaches':         makeUserPage({ title: 'Coaches',  lede: 'Head and assistant coaches.', route: 'coaches',  endpoint: '/admin/coaches',  lockedRoles: true }),
    'managers':        makeUserPage({ title: 'Managers', lede: 'Club administrators.',         route: 'managers', endpoint: '/admin/managers', lockedRoles: true }),
    'investors':       renderInvestors,
    'subscriptions':   renderSubscriptions,
    'payments':        renderPayments,
    'franchise-units': renderFranchiseUnits,
    'ai-engine':       renderAiEngine,
    'vision-engine':   renderVisionEngine,
    'audit-logs':      renderAuditLogs,
  };
})();
