/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA SYSTEM — the icon set

   One stroked line drawing per concept, on a 24×24 grid, inheriting
   `currentColor`. There is exactly one of these in the product: the rail, the
   top bar and the Live Data Flow board all draw from this file, so an icon
   cannot mean one thing in the navigation and another on the board.

   Why not emoji. A glyph carries the host platform's own colour palette and a
   bitmap's own edges into a surface built entirely from tokens, it renders
   differently on every operating system, and it cannot take a hover colour. A
   path does none of that.

   Adding one: give it a name that says what it IS rather than what it looks
   like (`governance`, not `scales`), keep it to a single `d`, and draw it on
   the same optical weight as its neighbours — 1.6 stroke, round joins.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var ICONS = {
    // ── shell
    home: 'M3.6 10.4 12 3.6l8.4 6.8V19a1.6 1.6 0 0 1-1.6 1.6h-3.6v-6H9.8v6H6.2A1.6 1.6 0 0 1 4.6 19v-8.6Z',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20.4 20.4l-4.5-4.5',
    chevron: 'M7.6 10 12 14.4 16.4 10',
    overview: 'M4 4.6h6.4V11H4ZM13.6 4.6H20v4.2h-6.4ZM13.6 11.8H20v7.6h-6.4ZM4 13.8h6.4v5.6H4Z',
    infrastructure: 'M4 5.4h16v4.2H4ZM4 14.4h16v4.2H4ZM7.4 7.4h.1M7.4 16.5h.1M12.8 7.4h4M12.8 16.5h4',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.3 14.6a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-2.8 1.1v.3a1.9 1.9 0 1 1-3.8 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0-1.1-2.8h-.3a1.9 1.9 0 1 1 0-3.8h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 2.8-1.1v-.3a1.9 1.9 0 1 1 3.8 0v.2a1.6 1.6 0 0 0 2.8 1.1l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0 1.1 2.8h.3a1.9 1.9 0 1 1 0 3.8h-.2a1.6 1.6 0 0 0-1.5 1.1Z',

    // ── domains
    clubs: 'M12 3 4.5 6v5.5c0 4.3 3.2 7.4 7.5 8.5 4.3-1.1 7.5-4.2 7.5-8.5V6Z',
    users: 'M9.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.5 20a6 6 0 0 1 12 0M16.5 6.6a3 3 0 0 1 0 4.8M17.5 14.6A5.5 5.5 0 0 1 21 20',
    players: 'M13.5 5.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6ZM8 21l2-5.5L7.5 13l1.2-4.2 3.3-1.1 2.5 2.6 3 1.1M11 15.5 14.5 21',
    training: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 13.4a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8Z',
    matches: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.4l4.3 3.1-1.6 5H9.3l-1.6-5ZM12 3.1v4.3M20.6 9.8 16.3 10.5M17.4 19.4l-2.7-3.9M6.6 19.4l2.7-3.9M3.4 9.8l4.3.7',
    transfers: 'M4 8.5h13M14 5.5l3 3-3 3M20 15.5H7M10 12.5l-3 3 3 3',
    medical: 'M6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4ZM12 8.5v7M8.5 12h7',
    media: 'M3.5 8.6A2.6 2.6 0 0 1 6.1 6h5.8a2.6 2.6 0 0 1 2.6 2.6v6.8A2.6 2.6 0 0 1 11.9 18H6.1a2.6 2.6 0 0 1-2.6-2.6ZM14.5 11.2l6-3.2v8l-6-3.2Z',
    ai: 'M12 3.2l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8ZM18.4 16.2l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8Z',
    system: 'M6 5.4h12a1.6 1.6 0 0 1 1.6 1.6v10a1.6 1.6 0 0 1-1.6 1.6H6A1.6 1.6 0 0 1 4.4 17V7A1.6 1.6 0 0 1 6 5.4ZM8 9h.1M8 12.4h.1M11.4 9h5M11.4 12.4h5M8 15.4h8.4',

    // ── destinations and storage
    database: 'M12 8.6c4.4 0 8-1.2 8-2.8S16.4 3 12 3 4 4.2 4 5.8s3.6 2.8 8 2.8ZM4 5.8v12.4C4 19.8 7.6 21 12 21s8-1.2 8-2.8V5.8M4 12c0 1.6 3.6 2.8 8 2.8s8-1.2 8-2.8',
    play: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM10.2 8.4l5.6 3.6-5.6 3.6Z',
    audit: 'M9 4.5H7.5A1.5 1.5 0 0 0 6 6v13a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V6a1.5 1.5 0 0 0-1.5-1.5H15M9.2 3h5.6v3.2H9.2ZM9 11.5h6M9 15.2h4',
    analytics: 'M4 20h16M7.5 20v-5.5M12 20V7.5M16.5 20v-8.5',
    product: 'M4 19.4h16M4.6 15.4l4.6-5 3.4 3 6.8-7.4',
    pipeline: 'M17 8.2a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2ZM6.5 15.1a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2ZM17 21a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 17 21ZM8.8 11.3l5.8-2.7M8.8 13.7l5.8 2.7',
    layers: 'M12 3 3.5 7.6 12 12.2l8.5-4.6ZM3.5 12.4 12 17l8.5-4.6M3.5 16.6 12 21.2l8.5-4.6',
    gps: 'M12 21s6.4-5.4 6.4-10.4A6.4 6.4 0 0 0 5.6 10.6C5.6 15.6 12 21 12 21ZM12 13.1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
    edge: 'M7.2 18.2h9.4a3.4 3.4 0 0 0 .4-6.8 5.4 5.4 0 0 0-10.4-1.2 4 4 0 0 0 .6 8Z',
    storage: 'M4 6.4A2.4 2.4 0 0 1 6.4 4h11.2A2.4 2.4 0 0 1 20 6.4v3.2H4ZM4 14.4A2.4 2.4 0 0 1 6.4 12h11.2a2.4 2.4 0 0 1 2.4 2.4v3.2A2.4 2.4 0 0 1 17.6 20H6.4A2.4 2.4 0 0 1 4 17.6ZM7.4 7h.1M7.4 16h.1',

    // ── intelligence and governance
    gateway: 'M6.6 10.4h10.8a1.6 1.6 0 0 1 1.6 1.6v6.6a1.6 1.6 0 0 1-1.6 1.6H6.6A1.6 1.6 0 0 1 5 18.6V12a1.6 1.6 0 0 1 1.6-1.6ZM8.4 10.4V7.6a3.6 3.6 0 1 1 7.2 0v2.8M12 14.4v2.2',
    engines: 'M8.4 8.4h7.2v7.2H8.4ZM6 6h12v12H6ZM9.4 3v3M14.6 3v3M9.4 18v3M14.6 18v3M3 9.4h3M3 14.6h3M18 9.4h3M18 14.6h3',
    agents: 'M6.8 9h10.4A1.8 1.8 0 0 1 19 10.8v6.4A1.8 1.8 0 0 1 17.2 19H6.8A1.8 1.8 0 0 1 5 17.2v-6.4A1.8 1.8 0 0 1 6.8 9ZM12 6.2V9M12 5.8a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2ZM9.2 12.8h.1M14.8 12.8h.1M9.8 15.8h4.4',
    registry: 'M12 3 4 7.2v9.6L12 21l8-4.2V7.2ZM4 7.2 12 11.4l8-4.2M12 11.4V21',
    governance: 'M12 4.2v16M7.4 20.2h9.2M4 9.2h16M4.6 9.2 2.4 14a3 3 0 0 0 5.6 0ZM19.4 9.2 21.6 14a3 3 0 0 1-5.6 0Z',
    compliance: 'M12 3 4.5 6v5.5c0 4.3 3.2 7.4 7.5 8.5 4.3-1.1 7.5-4.2 7.5-8.5V6ZM9 11.8l2.2 2.2 4-4.2',
    consent: 'M9.4 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.4 20a6 6 0 0 1 12 0M15.8 13.6l2 2 3.6-3.8',
    residency: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.2 12h17.6M12 3.1a14.4 14.4 0 0 1 0 17.8 14.4 14.4 0 0 1 0-17.8Z',
    notifications: 'M18 9.4a6 6 0 1 0-12 0c0 4.8-2 6.3-2 6.3h16s-2-1.5-2-6.3ZM13.7 19a2 2 0 0 1-3.4 0',
    security: 'M12 3 4.5 6v5.5c0 4.3 3.2 7.4 7.5 8.5 4.3-1.1 7.5-4.2 7.5-8.5V6ZM12 8.4v4M12 15.4h.1',
    health: 'M12 20.2s-7-4.4-7-9.3A4 4 0 0 1 12 8.4a4 4 0 0 1 7 2.5c0 4.9-7 9.3-7 9.3ZM4.6 12.6h3.1l1.5-3 2 5 1.5-2.5h3.2',
    backup: 'M20 11a8 8 0 1 0-1.3 5.3M20 5v6h-6',
    approvals: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.2 12.2l2.6 2.6 5-5.2',

    // ── innovation
    lab: 'M9.6 3.2v5.4L4.8 17a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3l-4.8-8.4V3.2M8.6 3.2h6.8M7.6 14.4h8.8',
    experiments: 'M6.6 4.6h4.2v4.8l-4.8 8a2 2 0 0 0 1.7 3M17.4 4.6h-4.2v4.8l4.8 8a2 2 0 0 1-1.7 3H7.7M5.4 4.6h13.2',
    flags: 'M5.4 20.4V4.2M5.4 5.2h10.4l-1.6 3.4 1.6 3.4H5.4',
    releases: 'M12 3.2 5.6 9.6M12 3.2l6.4 6.4M12 3.2v12.4M5 20.4h14',
    automation: 'M8 4.6h8M6.4 8.6h11.2M5 12.6h14M8.4 16.6h7.2M11 20.4h2',
    integrations: 'M9.6 4.6v4M14.4 4.6v4M7.4 8.6h9.2v3.6a4.6 4.6 0 1 1-9.2 0ZM12 16.8v3.6',

    // ── measurement
    rate: 'M3.5 12h4L10 5l4 14 2.5-7h4',
    stream: 'M4 7.2h16M4 12h16M4 16.8h10',
    session: 'M4 5.4h16v10.2H4ZM9 19.6h6M12 15.6v4',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.2V12l3 2',
    latency: 'M13.2 3 5 13.6h6L10.8 21 19 10.4h-6Z',
    processed: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.4 12.2l2.4 2.4 4.8-5',
    failed: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.4 9.4l5.2 5.2M14.6 9.4l-5.2 5.2',
    pending: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.6v4.6M12 15.6h.1',
    globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.2 12h17.6M12 3.1a14.4 14.4 0 0 1 0 17.8 14.4 14.4 0 0 1 0-17.8Z',
    timeline: 'M3.6 7.4h16.8M3.6 12h16.8M3.6 16.6h16.8M8.4 4.6v5.6M15.6 9.2v5.6M11 13.8v5.6',
    expand: 'M9 4.2H4.2V9M15 4.2h4.8V9M9 19.8H4.2V15M15 19.8h4.8V15',
    replay: 'M4 11a8 8 0 1 1 1.3 5.3M4 5v6h6',
    live: 'M12 14.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8',
  };

  /**
   * One icon, as inline SVG.
   *
   * Returns a string rather than a node because every surface in SYSTEM builds
   * its markup as a string and hands it to `innerHTML` once. An unknown name
   * renders the `system` icon rather than nothing, so a typo is visible in
   * review instead of being an invisible gap on the screen.
   */
  function syIcon(name, cls) {
    var d = ICONS[name] || ICONS.system;
    return '<svg class="sy-ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24"'
      + ' aria-hidden="true" focusable="false"><path d="' + d + '"/></svg>';
  }

  window.SY_ICONS = ICONS;
  window.syIcon = syIcon;
}());
