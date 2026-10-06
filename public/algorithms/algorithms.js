/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA ALGORITHMS — the eighth room

   EVERY NUMBER THE PLATFORM COMPUTES, AND WHO LET IT

   Expected goals, training load, the load and attrition indices, medical risk,
   eligibility, the kickoff window: each is an algorithm somebody acts on. This
   room lists every one of them, the domain it belongs to, its version, what
   goes in and what comes out, how it behaves on fixed synthetic scenarios
   right now, and the human approval it runs under.

   THE CONTINUOUS INTELLIGENCE LOOP

     Observe → Learn → Propose → Simulate → Test → Human approval → Deploy
             → Measure → Learn

   Deploy is reachable only from Human approval, and an approval names the
   exact version and the exact code. Where each algorithm stands on the loop is
   derived on the server from evidence; this module draws it and decides
   nothing.

   READ/ANALYZE-ONLY

   There is no button here that changes an algorithm, a weight or a setting,
   and there must never be one: an algorithm changes only through a reviewed
   pull request that records the owner's approval, released by the CI-gated
   deploy.

   PRODUCTION MONITORING (Step 2)

   How each algorithm really ran in production — runs, failures, latency, the
   shape of its outputs, the code that was running — in five states and no
   others: Healthy, Warning, Failing, Not enough data, Not instrumented. Green
   is drawn only for what was measured; a finding is evidence for a person and
   changes nothing.

   LEARNING (Step 3)

   Synthetic only. Invented outcomes test the measuring method — a planted
   error must be found, and none reported where none was planted — and say
   nothing about real-world accuracy, so every view of them carries a banner
   that says so and a verdict is never drawn green. The real-world lane is
   disabled; health data is never a learning outcome. Whether this
   deployment's telemetry writes work is shown as evidence too: only a write
   this server completed verifies it.

   PROPOSALS (Step 4)

   A candidate is a proposed new version of an approved algorithm. Its code,
   and the engine that judges it, live outside the production build: it ran in
   a separate process in CI, never on this server, and what that run found is
   read here from a validated evidence file. Every candidate is experimental
   and not approved, and none can reach Deploy. A Test verdict is a result
   about properties and is coloured as one; a score difference on synthetic
   outcomes is a bracket, never a winner, and a sample-size estimate is
   conditional on the synthetic assumptions and says so.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var AL = {
    data: null,
    error: null,
    section: 'overview',
    key: null,
    detail: null,
    detailError: null,
    langOpen: false,
    refreshing: false,
    mon: null,
    monError: null,
    monDetail: null,
    monDetailError: null,
    learn: null,
    learnError: null,
    learnDetail: null,
    learnDetailError: null,
    learnScenario: 'consistent',
    cand: null,
    candError: null,
    candDetail: null,
    candDetailError: null,
    candId: null,
    candTab: 'change',
    rel: null,
    relError: null,
  };

  // ── plumbing ──────────────────────────────────────────────────────────────

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** A count, localised — or an em dash. `0` is an answer; absence is not. */
  function num(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    try { return n.toLocaleString(AL_LANG); } catch (_) { return String(n); }
  }
  function has(v) { return v !== null && v !== undefined; }

  function absent(why) {
    return '<span class="al-none" title="' + esc(why || '') + '">—</span>';
  }

  function fmtInstant(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var local;
    try {
      local = new Intl.DateTimeFormat(AL_LANG, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
    } catch (_) { local = d.toISOString().replace('T', ' ').slice(0, 16); }
    return { local: local, utc: d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') };
  }

  function instantHtml(iso, why) {
    var at = fmtInstant(iso);
    if (!at) return absent(why || T('Not recorded yet.'));
    return '<time class="al-at" datetime="' + esc(iso) + '" title="' + esc(at.utc) + '" data-no-i18n>' + esc(at.local) + '</time>';
  }

  /** A fingerprint is shown short, and whole on hover. */
  function fp(hex) {
    if (!hex) return absent(T('Not available on this server.'));
    return '<code class="al-fp" title="' + esc(hex) + '" data-no-i18n>' + esc(hex.slice(0, 12)) + '…</code>';
  }

  // ── localisation ──────────────────────────────────────────────────────────
  //
  // This room's own three-language catalogue, behind `data-no-i18n` on the page
  // root — the boundary every owner room keeps, so these strings never enter
  // the club product's locale files. Registry keys, versions, file paths,
  // symbols and fingerprints are identifiers and are never translated.

  var AL_LOCALES = [['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']];
  var AL_DICT = {};
  var AL_LANG = 'en';
  var AL_DIR = 'ltr';

  function localeOf(tag) {
    for (var i = 0; i < AL_LOCALES.length; i++) if (AL_LOCALES[i][0] === tag) return AL_LOCALES[i];
    return AL_LOCALES[0];
  }
  function initialLocale() {
    try {
      var v = localStorage.getItem('familista_algorithms_locale');
      if (v && localeOf(v)[0] === v) return v;
    } catch (_) {}
    return 'en';
  }
  function loadDict(tag) {
    if (tag === 'en') { AL_DICT = {}; return Promise.resolve(); }
    return fetch('/algorithms/i18n/' + tag + '.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { AL_DICT = d || {}; })
      .catch(function () { AL_DICT = {}; });
  }
  function setLocale(tag) {
    var l = localeOf(tag);
    AL_LANG = l[0]; AL_DIR = l[2];
    try { localStorage.setItem('familista_algorithms_locale', AL_LANG); } catch (_) {}
    return loadDict(AL_LANG);
  }

  /** One string. A missing key falls through to English, never to a key path. */
  function T(text) {
    var s = String(text == null ? '' : text);
    if (!s || AL_LANG === 'en') return s;
    return Object.prototype.hasOwnProperty.call(AL_DICT, s) ? AL_DICT[s] : s;
  }
  /** A sentence with numbers in it: the key holds %d, the numbers are localised. */
  function tf(key) {
    var args = Array.prototype.slice.call(arguments, 1);
    var i = 0;
    return T(key).replace(/%d/g, function () { var v = args[i++]; return v == null ? '—' : num(v); });
  }

  function languageSwitchHtml() {
    var active = localeOf(AL_LANG);
    return '<div class="al-langs' + (AL.langOpen ? ' is-open' : '') + '">'
      + '<button class="al-lang-pick" type="button" data-al-langs'
      + ' aria-expanded="' + (AL.langOpen ? 'true' : 'false') + '" aria-label="' + esc(T('Algorithms language')) + '">'
      + '<span data-no-i18n>' + esc(active[1]) + '</span><span class="al-lang-ch" aria-hidden="true">⌄</span></button>'
      + '<div class="al-lang-menu" role="group">'
      + AL_LOCALES.map(function (l) {
        return '<button class="al-lang' + (l[0] === AL_LANG ? ' is-on' : '') + '" type="button"'
          + ' data-al-lang="' + l[0] + '" lang="' + l[0] + '" data-no-i18n'
          + ' aria-pressed="' + (l[0] === AL_LANG ? 'true' : 'false') + '">' + esc(l[1]) + '</button>';
      }).join('')
      + '</div></div>';
  }

  // ── the vocabulary ────────────────────────────────────────────────────────
  //
  // These functions are the only place a state becomes a colour. Green: the
  // algorithm runs exactly what a person approved, or a check passed. Amber:
  // waiting for a person. Red: a check failed, or a mode no approval can
  // allow. Dotted grey: not simulated — never to be read as passing.

  function gateKind(g) {
    switch (g) {
      case 'APPROVED': return 'ok';
      case 'EVALUATION_FAILED': case 'MODE_NOT_ALLOWED': return 'crit';
      case 'NO_APPROVAL': case 'VERSION_NOT_APPROVED': case 'CHANGED_SINCE_APPROVAL': case 'FINGERPRINT_UNAVAILABLE': return 'warn';
      default: return 'unknown';
    }
  }
  var GATE_LABEL = {
    APPROVED: 'Approved',
    NO_APPROVAL: 'No approval',
    VERSION_NOT_APPROVED: 'Version not approved',
    CHANGED_SINCE_APPROVAL: 'Changed since approval',
    FINGERPRINT_UNAVAILABLE: 'Code not readable',
    EVALUATION_FAILED: 'Evaluation failed',
    MODE_NOT_ALLOWED: 'Mode not allowed',
  };
  var GATE_MEANING = {
    APPROVED: 'Runs exactly the version and the code its approval names.',
    NO_APPROVAL: 'No human approval is recorded for it.',
    VERSION_NOT_APPROVED: 'Its version is not the version that was approved.',
    CHANGED_SINCE_APPROVAL: 'Its code changed after it was approved.',
    FINGERPRINT_UNAVAILABLE: 'The fingerprint of its code is not available on this server.',
    EVALUATION_FAILED: 'It failed at least one of its own checks.',
    MODE_NOT_ALLOWED: 'It is set to act, and only read/analyze is allowed.',
  };
  function evalKind(s) { return s === 'PASS' ? 'ok' : s === 'FAIL' ? 'crit' : 'none'; }
  var EVAL_LABEL = { PASS: 'Passing', FAIL: 'Failing', NOT_SIMULATED: 'Not simulated' };

  var STAGE_LABEL = {
    OBSERVE: 'Observe', LEARN: 'Learn', PROPOSE: 'Propose', SIMULATE: 'Simulate', TEST: 'Test',
    HUMAN_APPROVAL: 'Human approval', DEPLOY: 'Deploy', MEASURE: 'Measure',
  };

  function chip(kind, label, title, extra) {
    return '<span class="al-chip al-chip--' + kind + (extra ? ' ' + extra : '') + '"'
      + (title ? ' title="' + esc(title) + '"' : '') + '>'
      + '<span class="al-dot" aria-hidden="true"></span>' + esc(label) + '</span>';
  }
  function gateChip(g, extra) { return chip(gateKind(g), T(GATE_LABEL[g] || g), T(GATE_MEANING[g] || ''), extra); }
  function evalChip(e, extra) {
    var label = e.state === 'NOT_SIMULATED' ? T(EVAL_LABEL.NOT_SIMULATED) : T(EVAL_LABEL[e.state]) + ' · ' + num(e.passed) + '/' + num(e.total);
    return chip(evalKind(e.state), label, '', extra);
  }
  function stageTag(s) { return '<span class="al-stage-tag">' + esc(T(STAGE_LABEL[s] || s)) + '</span>'; }

  // ── the production vocabulary (Step 2) ────────────────────────────────────
  //
  // Five states, and the colour of each is a fact: green only for an
  // algorithm measured in production with every check passing; amber for
  // evidence a person should look at; red for something proven wrong; dotted
  // grey for "not enough runs to say" and "does not run in production" —
  // never to be read as healthy.

  function monKind(s) {
    switch (s) {
      case 'HEALTHY': return 'ok';
      case 'WARNING': return 'warn';
      case 'FAILING': return 'crit';
      case 'NOT_ENOUGH_DATA': return 'none';
      case 'NOT_INSTRUMENTED': return 'off';
      default: return 'unknown';
    }
  }
  var MON_LABEL = {
    HEALTHY: 'Healthy',
    WARNING: 'Warning',
    FAILING: 'Failing',
    NOT_ENOUGH_DATA: 'Not enough data',
    NOT_INSTRUMENTED: 'Not instrumented',
  };
  var MON_MEANING = {
    HEALTHY: 'Measured in production with enough runs, and every check passes.',
    WARNING: 'Production evidence a person should look at.',
    FAILING: 'Something is proven wrong: the code, its evaluation, its outputs or repeated failures.',
    NOT_ENOUGH_DATA: 'Instrumented, but too few production runs to call it anything yet.',
    NOT_INSTRUMENTED: 'It does not run in production, so there is nothing to measure.',
  };
  var MON_ORDER = ['FAILING', 'WARNING', 'HEALTHY', 'NOT_ENOUGH_DATA', 'NOT_INSTRUMENTED'];
  var FINDING_LABEL = {
    FINGERPRINT_MISMATCH: 'The running code is not the approved code',
    FINGERPRINT_UNVERIFIED: 'The running code could not be proven',
    EVALUATION_FAILED: 'Its evaluation fails in this server',
    CONTRACT_VIOLATIONS: 'An output broke its declared contract',
    REPEATED_FAILURES: 'Repeated failures',
    FAILURES: 'A production run failed',
    STALE: 'No production run for a week',
    NO_EXECUTIONS: 'No production run recorded yet',
    DISTRIBUTION_SHIFT: 'Its outputs shifted against their baseline',
    LATENCY_REGRESSION: 'It became slower than its baseline',
  };
  var VERDICT_LABEL = { MATCH: 'Approved code', MISMATCH: 'Not the approved code', UNVERIFIED: 'Not proven' };
  function verdictKind(v) { return v === 'MATCH' ? 'ok' : v === 'MISMATCH' ? 'crit' : 'warn'; }
  var REASON_LABEL = {
    OK: 'The running code is the code the approval names.',
    NOT_APPROVED: 'The loaded source is not the approved source.',
    CHANGED_AFTER_BUILD: 'The loaded file is not what the build compiled.',
    BUILD_NOT_APPROVED: 'This build was compiled from source that was not approved.',
    SEAL_MISSING: 'The build seal is missing beside the server, so nothing can be proven.',
    UNREADABLE: 'The loaded file could not be read.',
  };
  var BASIS_LABEL = { SOURCE: 'TypeScript source', COMPILED: 'Compiled build' };
  var STORE_LABEL = { OK: 'Writing', IDLE: 'Idle', FAILING: 'Write failing', NOT_STARTED: 'Not started in this server' };
  function storeKind(s) { return s === 'OK' ? 'ok' : s === 'FAILING' ? 'crit' : s === 'IDLE' ? 'info' : 'none'; }
  var CHECK_STATE = { PASS: ['ok', '✓'], WARN: ['warn', '!'], FAIL: ['crit', '✕'], NOT_ENOUGH_DATA: ['none', '·'], NOT_APPLICABLE: ['none', '–'] };
  var CHECK_STATE_LABEL = { PASS: 'Passing', WARN: 'Warning', FAIL: 'Failing', NOT_ENOUGH_DATA: 'Not enough data', NOT_APPLICABLE: 'Not applicable' };
  var KIND_LABEL = { REQUEST: 'Request', WORKER: 'Background worker' };

  function monChip(st, extra) { return chip(monKind(st), T(MON_LABEL[st] || st), T(MON_MEANING[st] || ''), extra); }
  function verdictChip(v, extra) { return chip(verdictKind(v), T(VERDICT_LABEL[v] || v), '', extra); }

  // ── the learning vocabulary (Step 3) ──────────────────────────────────────
  //
  // Synthetic results test the measuring method, never the algorithm, so a
  // verdict is drawn neutral — "none detected" in green would read as
  // "accurate". Colour belongs to the method check alone: whether the method
  // found the error that was planted, and nothing it was not given.

  var LEARN_STATUS_LABEL = {
    SYNTHETIC_ONLY: 'Synthetic method checks',
    DERIVED: 'Covered by expected goals',
    NO_GROUND_TRUTH: 'Nothing to learn from',
    EXCLUDED_HEALTH: 'Excluded: health data',
  };
  function learnStatusKind(s) { return s === 'SYNTHETIC_ONLY' ? 'info' : s === 'DERIVED' ? 'none' : 'off'; }
  var LEARN_VERDICT_LABEL = {
    MISCALIBRATION_DETECTED: 'Miscalibration detected',
    NONE_DETECTED: 'None detected at this sample size',
    NOT_ENOUGH_DATA: 'Not enough data',
    INCONCLUSIVE: 'Inconclusive',
    UNAVAILABLE: 'Unavailable',
  };
  var METHOD_CHECK_LABEL = {
    PASSED: 'Method check passed',
    FAILED: 'Method check failed',
    UNVERIFIED: 'Code not proven',
    UNAVAILABLE: 'Could not run',
  };
  function methodKind(m) { return m === 'PASSED' ? 'ok' : m === 'FAILED' ? 'crit' : m === 'UNVERIFIED' ? 'warn' : 'none'; }
  var SIGNAL_LABEL = { CITL: 'Total goals', SLOPE: 'Calibration slope' };
  var TRUTH_LABEL = {
    MODEL: 'The model’s own probabilities',
    LOGIT_SHIFT: 'The model shifted on the log-odds scale',
    LOGIT_SCALE: 'The model’s log-odds scaled',
  };
  var LEARN_REASON_LABEL = {
    NO_SAMPLE: 'No shots were drawn.',
    NON_FINITE_PREDICTION: 'A prediction was not a number between 0 and 1.',
    EXPECTED_GOALS_BELOW_FLOOR: 'Fewer expected goals than the floor.',
    EXPECTED_NON_GOALS_BELOW_FLOOR: 'Fewer expected non-goals than the floor.',
    CITL_UNAVAILABLE: 'The goals test could not run: the predictions carry no variance.',
    'SLOPE_UNAVAILABLE:NO_VARIATION_IN_OUTCOMES': 'The slope could not be fitted: every outcome is the same.',
    'SLOPE_UNAVAILABLE:NO_VARIATION_IN_PREDICTIONS': 'The slope could not be fitted: every prediction is the same.',
    'SLOPE_UNAVAILABLE:SINGULAR': 'The slope could not be fitted: the data cannot separate slope from intercept.',
    'SLOPE_UNAVAILABLE:NON_FINITE': 'The slope could not be fitted: a value became infinite.',
    'SLOPE_UNAVAILABLE:SEPARATION': 'The slope could not be fitted: outcomes are perfectly separated.',
    'SLOPE_UNAVAILABLE:NO_CONVERGENCE': 'The slope could not be fitted: the fit did not settle.',
    TIME_BUDGET_EXCEEDED: 'Stopped: the time budget was used up.',
    LIMIT_EXCEEDED: 'Refused: the scenario exceeds a resource limit.',
    ERROR: 'The run failed with an error.',
  };
  var WRITE_LABEL = {
    VERIFIED: 'Verified by this server',
    FAILING: 'Write failing in this server',
    UNVERIFIED: 'Unverified',
    NOT_RUNNING: 'Not running in this server',
  };
  var WRITE_MEANING = {
    VERIFIED: 'This server completed a write since it started.',
    FAILING: 'This server’s last write attempt failed.',
    UNVERIFIED: 'This server has recorded no run yet. Zero runs is not evidence of failure or success.',
    NOT_RUNNING: 'Telemetry is not running in this server process, so it cannot vouch for its writes.',
  };
  function writeKind(w) { return w === 'VERIFIED' ? 'ok' : w === 'FAILING' ? 'crit' : w === 'UNVERIFIED' ? 'none' : 'off'; }
  var STORED_LABEL = { ROWS_PRESENT: 'Earlier runs are stored', NO_ROWS: 'No stored runs', UNKNOWN: 'Unknown' };
  var STORED_MEANING = {
    ROWS_PRESENT: 'History only: written under an earlier deployment or by another server. It does not verify this deployment.',
    NO_ROWS: 'Nothing is stored within the retention window.',
    UNKNOWN: 'The store could not be read.',
  };

  // ── the proposals vocabulary (Step 4) ─────────────────────────────────────
  //
  // A Test verdict is a result about properties, so it carries the result
  // colours. A score bracket or a sample-size estimate never does: synthetic
  // outcomes cannot say which version is right.

  var CAND_NOTICE = 'Synthetic data: shows how a candidate differs from the approved version and which properties it keeps, not which is more accurate on real matches. Candidates are experimental and never run in production.';
  var CAND_TEST_LABEL = {
    PASSED: 'Held-out test passed',
    FAILED: 'Held-out test failed',
    INCONCLUSIVE: 'Inconclusive',
    UNAVAILABLE: 'Not judged',
  };
  var CAND_TEST_MEANING = {
    PASSED: 'On held-out seeds it kept every property the approved version keeps and fixed what it claimed. This is not a measure of real-world accuracy.',
    FAILED: 'On held-out seeds it broke a property the approved version keeps, did not fix what it claimed, or returned invalid values.',
    INCONCLUSIVE: 'The held-out probes did not reach the changed region often enough to judge.',
    UNAVAILABLE: 'The run or the comparison method did not complete, so no verdict was given.',
  };
  function candTestKind(t) { return t === 'PASSED' ? 'ok' : t === 'FAILED' ? 'crit' : t === 'INCONCLUSIVE' ? 'warn' : 'none'; }
  var OUTCOME_LABEL = { KEPT: 'Kept', FIXED: 'Fixed', BROKEN: 'Broken', STILL_FAILING: 'Broken in both' };
  function outcomeKind(o) { return o === 'FIXED' ? 'ok' : o === 'BROKEN' ? 'crit' : o === 'STILL_FAILING' ? 'warn' : 'none'; }
  var RUN_LABEL = {
    COMPLETED: 'Completed',
    TIMED_OUT: 'Stopped at its time limit',
    MEMORY_LIMIT: 'Stopped at its memory limit',
    OUTPUT_LIMIT: 'Stopped at its output limit',
    CRASHED: 'Crashed',
    INVALID_OUTPUT: 'Report unreadable',
    REFUSED: 'Refused before judging',
  };
  function runKind(s) { return s === 'COMPLETED' ? 'none' : s === 'REFUSED' ? 'warn' : 'crit'; }
  var ESTIMATE_LABEL = { ESTIMATED: 'Estimated', UNSTABLE: 'Unstable', UNDEFINED: 'Undefined' };
  var WORLD_STATUS_LABEL = { COMPUTED: 'Computed', NOT_ENOUGH_DATA: 'Not enough data', NO_DIFFERENCE: 'No difference' };
  var PHASE_LABEL = { DEVELOPMENT: 'Development', HELD_OUT: 'Held-out' };
  var SYMBOL_LABEL = { SAME: 'Unchanged', CHANGED: 'Changed', MISSING: 'Missing' };
  var PROPOSER_LABEL = { PLATFORM_OWNER: 'The platform owner', AI_ASSISTANT: 'An AI assistant' };
  var EVIDENCE_KIND_LABEL = { MEASUREMENT: 'Measurement', GEOMETRY: 'Geometry', PROPERTY: 'Property' };
  var LAB_CHECK_LABEL = {
    NO_CHANGE: 'No change reported',
    CHANGE_REPORTED: 'A change was reported',
    COST_SEEN: 'Cost seen',
    GAIN_SEEN: 'Gain seen',
    NOT_SEEN: 'Not seen',
    CAUGHT: 'Caught',
    MISSED: 'Missed',
    NOT_ENOUGH_DATA: 'Not enough data',
    BRACKET_DRAWN: 'A bracket was drawn',
  };
  var CAND_TAB_LABEL = { change: 'Change', simulate: 'Simulate', test: 'Test', approval: 'Approval', resources: 'Resources' };
  /** Verdict, run, freshness and estimate codes. A code "CODE:id" is followed by that property's title. */
  var CAND_REASON_LABEL = {
    RUN_TIMED_OUT: 'The run reached its time limit and was stopped.',
    RUN_MEMORY_LIMIT: 'The run reached its memory limit and was stopped.',
    RUN_OUTPUT_LIMIT: 'The run wrote more than its output limit and was stopped.',
    RUN_CRASHED: 'The run crashed.',
    RUN_INVALID_OUTPUT: 'The run’s report could not be read.',
    RUN_REFUSED: 'The proposal was refused before it was judged.',
    OUTPUT_HELD_BY_DESCENDANT: 'A process the run started still held its output open after the run ended, so its report was not accepted. That process was not verified to have stopped.',
    METHOD_CHECKS_FAILED: 'The comparison method failed its own checks, so no candidate is judged.',
    NO_RESULTS: 'There are no results to judge.',
    BROKEN: 'Breaks a property the approved version keeps:',
    TARGET_NOT_FIXED: 'Did not fix a property it claimed to fix:',
    NEW_INVALID_OUTPUTS: 'Returns invalid values where the approved version does not.',
    NOT_COVERED: 'Too few held-out probes reached the changed region for:',
    SHARED_FAILURE: 'Broken by both versions, so not the candidate’s doing:',
    DECLARATION_MISMATCH: 'Its declaration does not match its allow-list entry.',
    DECLARATION_INVALID: 'Its declaration could not be read.',
    NO_APPROVED_BASELINE: 'The algorithm has no approved version to compare with.',
    BASELINE_NOT_CURRENT: 'The approved version it names is no longer the current approval.',
    VERSION_ALREADY_USED: 'Its version is already used in the registry.',
    UNKNOWN_TARGET: 'It claims to fix a property that does not exist:',
    FINGERPRINT_UNAVAILABLE: 'Its code could not be fingerprinted.',
    NO_CODE_CHANGE: 'Its code is identical to the approved version.',
    APPROVED_CODE_CHANGED: 'The approved code changed after this evidence was produced.',
    UNKNOWN_ALGORITHM: 'Its algorithm is not in the registry.',
    CANDIDATE_MATCHES_APPROVAL: 'It carries the approved version and code, so it is not a candidate.',
    NO_DIFFERENCE: 'The two versions never differ on these shots.',
    FEW_CHANGED_SHOTS: 'Fewer than 30 shots differ.',
    RESAMPLE_WITHOUT_DIFFERENCE: 'Some resamples show no difference at all, so the upper end is unbounded.',
  };

  // Releases (Step 5): a CHANGE approval's binding to its evidence, and what
  // this server can and cannot see between an approval and a measurement.
  var BINDING_LABEL = { NOT_APPLICABLE: 'No candidate', VALID: 'Bound to its evidence', INVALID: 'Binding broken' };
  var BINDING_MEANING = {
    NOT_APPLICABLE: 'A baseline approval records the code as it already ran. No candidate was judged, so there is no evidence to bind.',
    VALID: 'The approval names its candidate, the version it replaced and a dossier whose digest still matches, and every link between them holds.',
    INVALID: 'At least one link between the approval and its evidence no longer holds. CI fails until it does.',
  };
  function bindingKind(s) { return s === 'VALID' ? 'ok' : s === 'INVALID' ? 'crit' : 'none'; }
  var BINDING_REASON_LABEL = {
    DOSSIER_UNREADABLE: 'The dossier it names cannot be read on this server.',
    DIGEST_MISMATCH: 'The dossier is not the one the approval names: its digest differs.',
    EVIDENCE_DIGEST_MISMATCH: 'The evidence inside the dossier was changed after it was recorded.',
    ALGORITHM_MISMATCH: 'The dossier is about another algorithm.',
    CANDIDATE_MISMATCH: 'The dossier is about another candidate.',
    VERSION_MISMATCH: 'The approved version is not the registered version, or not the version the dossier promoted.',
    FINGERPRINT_MISMATCH: 'The approved fingerprint is not the code the dossier promoted.',
    BASELINE_MISMATCH: 'The version it replaced is not the one the evidence was judged against.',
    BASELINE_NOT_IN_HISTORY: 'The version it replaced does not come before it in the version history.',
    VERSION_REUSED: 'It reuses the number of the version it replaced.',
    VERDICT_MISMATCH: 'The held-out Test in the dossier did not pass.',
    METHOD_CHECKS_NOT_PASSED: 'Not every method check in the dossier passed.',
    CODE_DEPENDANT_NOT_SIMULATED: 'An algorithm whose code calls the changed code was not simulated.',
    CODE_DEPENDANT_BROKEN: 'An algorithm whose code calls the changed code broke a property or returned new invalid values.',
    REFERENCE_NOT_A_PULL_REQUEST: 'The approval does not name the pull request that carried it.',
  };
  var DEP_PATH_LABEL = { CODE: 'Calls the changed code', DATA: 'Reads stored values only' };
  var LIMIT_LABEL = {
    SYNTHETIC_ONLY: 'Every input was invented.',
    NO_REAL_WORLD_ACCURACY: 'Nothing here compares a version with real outcomes.',
    HELD_OUT_SEEDS_VISIBLE: 'The held-out seeds can be read in the repository, so the split is not a blind test.',
    DATA_DEPENDANTS_NOT_SIMULATED: 'An algorithm that only reads stored values was not run: the change alters none of its inputs today.',
    NOT_OBSERVED_IN_PRODUCTION: 'Production telemetry does not record this algorithm, so nothing measures it after release.',
  };
  var PRODUCTION_LABEL = { MEASURED: 'Recorded by telemetry', NOT_OBSERVABLE: 'Not observable' };
  var PRODUCTION_MEANING = {
    MEASURED: 'A request, worker or job calls it, and production telemetry records every run.',
    NOT_OBSERVABLE: 'No request, worker or job calls it, so production telemetry has nothing to record. That is never read as proof the code is unused.',
  };

  /** A statistic, localised, with a fixed number of decimals. Data, not prose. */
  function dec(v, d) { return typeof v === 'number' && isFinite(v) ? num(+v.toFixed(d)) : '—'; }
  /** An interval as value [low – high]. */
  function ivl(i, d) { return i ? dec(i.value, d) + ' [' + dec(i.low, d) + ' – ' + dec(i.high, d) + ']' : '—'; }
  function share(v) { return typeof v === 'number' && isFinite(v) ? num(+(100 * v).toFixed(1)) + '%' : '—'; }
  function bytes(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    if (n >= 1048576) return num(+(n / 1048576).toFixed(1)) + ' MB';
    if (n >= 1024) return num(Math.round(n / 1024)) + ' KB';
    return num(n) + ' B';
  }
  function ms(v) { return typeof v === 'number' && isFinite(v) ? num(+v.toFixed(v < 10 ? 2 : 1)) + ' ms' : '—'; }
  function val(text) { return '<span class="al-val" data-no-i18n>' + esc(text) + '</span>'; }
  function verdictTag(v) { return chip('info', T(LEARN_VERDICT_LABEL[v] || v), '', 'al-chip--sm'); }
  function methodChip(m, extra) { return chip(methodKind(m), T(METHOD_CHECK_LABEL[m] || m), '', extra); }
  function syntheticBanner(text) {
    return '<div class="al-banner al-banner--synthetic" role="note"><span class="al-banner-tag">' + esc(T('Synthetic')) + '</span>'
      + '<span>' + esc(T(text || 'Synthetic data: these results test the measuring method, not the algorithm’s real-world accuracy.')) + '</span></div>';
  }

  /** A duration in microseconds, as the room shows it. Data, not prose. */
  function dur(us) {
    if (typeof us !== 'number' || !isFinite(us)) return '—';
    if (us >= 1000000) return num(+(us / 1000000).toFixed(2)) + ' s';
    if (us >= 1000) return num(+(us / 1000).toFixed(1)) + ' ms';
    return num(us) + ' µs';
  }
  function atMost(us) { return typeof us === 'number' && isFinite(us) ? '≤ ' + dur(us) : '—'; }
  function pct(part, whole) { return whole ? num(+(100 * part / whole).toFixed(1)) + '%' : '—'; }
  /** A share as one of 21 width classes: the stylesheet draws it, never an inline style. */
  function wClass(part, whole) { return 'al-w-' + (whole ? Math.max(0, Math.min(20, Math.round(20 * part / whole))) : 0); }
  /** A small difference to `p` significant digits, signed. Data, not prose. */
  function sig(v, p) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    var s;
    try { s = Math.abs(v).toLocaleString(AL_LANG, { maximumSignificantDigits: p }); } catch (_) { s = String(+Math.abs(v).toPrecision(p)); }
    return (v > 0 ? '+' : v < 0 ? '−' : '') + s;
  }
  function ivlSig(i, p) { return i ? sig(i.value, p) + ' [' + sig(i.low, p) + ' – ' + sig(i.high, p) + ']' : '—'; }
  /** A shot count from an estimate: three significant figures, because more would be false precision. */
  function shotsFig(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return num(n >= 1000 ? +n.toPrecision(3) : Math.ceil(n));
  }
  /** A sentence inside a key–value row: read at text weight, not as a figure. */
  function prose(text) { return '<span class="al-prose">' + esc(text) + '</span>'; }
  /** A model output exactly as it was returned: four decimals. Data, not prose. */
  function fix4(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    try { return v.toLocaleString(AL_LANG, { minimumFractionDigits: 4, maximumFractionDigits: 4 }); } catch (_) { return v.toFixed(4); }
  }
  function nsText(v) { return typeof v === 'number' && isFinite(v) ? num(Math.round(v)) + ' ns' : '—'; }

  // ── the frame ─────────────────────────────────────────────────────────────

  var SECTIONS = [
    ['overview', 'Overview', '◎', 'COMMAND'],
    ['registry', 'Registry', '☰', 'COMMAND'],
    ['loop', 'Intelligence Loop', '↻', 'COMMAND'],
    ['evaluation', 'Evaluation', '✓', 'EVIDENCE'],
    ['approvals', 'Approvals & Audit', '◆', 'EVIDENCE'],
    ['monitoring', 'Monitoring', '∿', 'EVIDENCE'],
    ['learning', 'Learning', '◇', 'EVIDENCE'],
    ['proposals', 'Proposals', '✎', 'EVIDENCE'],
  ];
  var GROUP_ORDER = ['COMMAND', 'EVIDENCE'];
  var GROUP_LABEL = { COMMAND: 'Command', EVIDENCE: 'Evidence' };

  function algorithms() { return (AL.data && AL.data.algorithms) || []; }
  function domains() { return (AL.data && AL.data.domains) || []; }
  function domainTitle(id) {
    var d = domains().filter(function (x) { return x.id === id; })[0];
    return d ? T(d.title) : id;
  }
  function algorithmName(key) {
    var a = algorithms().filter(function (x) { return x.key === key; })[0];
    return a ? T(a.name) : key;
  }

  function railBadge(id) {
    var t = AL.data && AL.data.totals;
    if (!t) return '';
    var n = 0, kind = 'warn';
    if (id === 'registry') n = t.registered - t.approved;
    if (id === 'evaluation' && t.failing) { n = t.failing; kind = 'crit'; }
    if (id === 'monitoring' && AL.mon && AL.mon.states) {
      if (AL.mon.states.FAILING) { n = AL.mon.states.FAILING; kind = 'crit'; }
      else n = AL.mon.states.WARNING;
    }
    if (id === 'learning' && AL.learn && AL.learn.algorithms) {
      n = AL.learn.algorithms.reduce(function (c, a) {
        return c + (a.synthetic ? a.synthetic.scenarios.filter(function (s) { return s.methodCheck === 'FAILED'; }).length : 0);
      }, 0);
      kind = 'crit';
    }
    if (id === 'approvals' && AL.rel) { n = AL.rel.totals.bindingInvalid; kind = 'crit'; }
    if (id === 'proposals' && AL.cand && AL.cand.state === 'READY') {
      var failedChecks = AL.cand.methodChecks.total - AL.cand.methodChecks.passed;
      if (failedChecks) { n = failedChecks; kind = 'crit'; } else n = AL.cand.counts.awaitingApproval;
    }
    if (!n) return '';
    return '<span class="al-rail-badge al-rail-badge--' + kind + '" data-no-i18n>' + esc(num(n)) + '</span>';
  }

  function markSvg(size) {
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" focusable="false" aria-hidden="true">'
      + '<path d="M12 3.6a8.4 8.4 0 1 1-7.5 4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
      + '<path d="M4.3 4.4v4h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<circle cx="12" cy="12" r="2" stroke="currentColor" stroke-width="1.5"/>'
      + '</svg>';
  }

  function railHtml() {
    var current = AL.section === 'algorithm' ? 'registry' : AL.section === 'candidate' ? 'proposals' : AL.section;
    var groups = GROUP_ORDER.map(function (g) {
      return '<div class="al-rail-group"><div class="al-rail-label">' + esc(T(GROUP_LABEL[g])) + '</div>'
        + SECTIONS.filter(function (s) { return s[3] === g; }).map(function (s) {
          var on = current === s[0];
          return '<button class="al-rail-item' + (on ? ' is-on' : '') + '" type="button" data-al-nav="' + s[0] + '"'
            + (on ? ' aria-current="page"' : '') + '>'
            + '<span class="al-rail-icon" aria-hidden="true">' + s[2] + '</span>'
            + '<span class="al-rail-text">' + esc(T(s[1])) + '</span>' + railBadge(s[0]) + '</button>';
        }).join('') + '</div>';
    }).join('');
    return '<nav class="al-rail" aria-label="' + esc(T('Algorithms')) + '">'
      + '<div class="al-rail-head">'
      + '<button class="al-rail-home" type="button" data-al-home aria-label="' + esc(T('Back to Familista home')) + '">'
      + '<span aria-hidden="true">←</span><span data-no-i18n>Familista</span></button>'
      + '<div class="al-rail-brand"><span class="al-rail-mark" aria-hidden="true">' + markSvg(18) + '</span>'
      + '<span class="al-rail-title">' + esc(T('Algorithms')) + '</span></div>'
      + '</div>'
      + '<div class="al-rail-body">' + groups + '</div>'
      + '<div class="al-rail-foot">' + footHtml() + '</div>'
      + '</nav>';
  }

  function footHtml() {
    var d = AL.data;
    if (!d && AL.error) return '<div class="al-foot">' + chip('off', T('Unavailable')) + '</div>';
    if (!d) return '<div class="al-foot">' + chip('unknown', T('Reading evidence…')) + '</div>';
    var at = fmtInstant(d.measuredAt);
    return '<div class="al-foot">' + chip('info', T('Read/analyze only'), T('No algorithm can change from this room.'))
      + (at ? '<span class="al-foot-at" data-no-i18n title="' + esc(at.utc) + '">' + esc(at.local) + '</span>' : '')
      + '</div>';
  }

  function titleOf() {
    if (AL.section === 'algorithm') return algorithmName(AL.key);
    if (AL.section === 'candidate') {
      var cd = AL.candDetail;
      return cd && cd.id === AL.candId ? algorithmName(cd.algorithm) + ' ' + (cd.version || '') + ' · ' + T('Candidate') : T('Candidate');
    }
    return T((SECTIONS.filter(function (s) { return s[0] === AL.section; })[0] || [null, 'Overview'])[1]);
  }

  function topHtml() {
    return '<header class="al-top">'
      + '<div class="al-top-l"><div class="al-top-eyebrow" data-no-i18n>FAMILISTA · ALGORITHMS</div>'
      + '<h1 class="al-top-title">' + esc(titleOf()) + '</h1></div>'
      + '<div class="al-top-r">'
      + '<button class="al-btn" type="button" data-al-refresh' + (AL.refreshing ? ' aria-busy="true" disabled' : '') + '>'
      + '<span aria-hidden="true">↻</span><span>' + esc(AL.refreshing ? T('Reading…') : T('Refresh')) + '</span></button>'
      + languageSwitchHtml()
      + '</div></header>';
  }

  function panel(title, body, note, cls) {
    return '<section class="al-panel' + (cls ? ' ' + cls : '') + '">'
      + (title ? '<div class="al-panel-head"><h2 class="al-panel-title">' + esc(T(title)) + '</h2>'
        + (note ? '<span class="al-panel-note">' + esc(note) + '</span>' : '') + '</div>' : '')
      + body + '</section>';
  }

  function emptyState(title, detail) {
    return '<div class="al-empty"><div class="al-empty-mark" aria-hidden="true">∅</div>'
      + '<div class="al-empty-title">' + esc(T(title)) + '</div>'
      + (detail ? '<div class="al-empty-detail">' + esc(detail) + '</div>' : '') + '</div>';
  }

  /** The skeleton is the size of what it stands in for. Heights are classes: CSP refuses inline styles. */
  function skeleton(n, size) {
    var rows = '';
    for (var i = 0; i < n; i++) rows += '<div class="al-skel-row al-skel-row--' + size + '"></div>';
    return '<div class="al-skel" aria-hidden="true">' + rows + '</div>';
  }

  function kv(k, v) {
    return '<div class="al-kv-row"><span>' + esc(k) + '</span><b>' + v + '</b></div>';
  }

  // ── OVERVIEW ──────────────────────────────────────────────────────────────

  function figure(value, label, kind) {
    return '<div class="al-fig' + (kind ? ' al-fig--' + kind : '') + '">'
      + '<div class="al-fig-v" data-no-i18n>' + value + '</div>'
      + '<div class="al-fig-l">' + esc(label) + '</div></div>';
  }

  function overviewHtml() {
    var d = AL.data, t = d.totals;
    var waiting = t.registered - t.approved;
    var hero = '<section class="al-hero">'
      + '<div class="al-hero-id"><span class="al-hero-mark" aria-hidden="true">' + markSvg(30) + '</span>'
      + '<div><div class="al-hero-k">' + esc(T('Continuous Intelligence Loop')) + '</div>'
      + '<div class="al-hero-t">' + esc(t.failing ? tf('%d algorithms are failing their own checks.', t.failing)
        : waiting ? tf('%d algorithms are waiting for a human approval.', waiting)
          : T('Every algorithm runs exactly the version a person approved.')) + '</div>'
      + '<div class="al-hero-s">' + esc(T('Read/analyze only. Nothing in this room changes an algorithm; a change reaches production only through a reviewed pull request that records the owner’s approval.')) + '</div>'
      + '</div></div>'
      + '<div class="al-figs">'
      + figure(esc(num(t.registered)), T('Algorithms registered'))
      + figure(esc(num(t.approved)) + '<small> / ' + esc(num(t.registered)) + '</small>', T('Running an approved version'), t.approved === t.registered ? 'ok' : 'warn')
      + figure(esc(num(t.checksPassed)) + '<small> / ' + esc(num(t.checks)) + '</small>', T('Evaluation checks passing'), t.checksPassed === t.checks ? 'ok' : 'crit')
      + figure(esc(num(t.registered - t.simulated)), T('Not simulated'), t.registered - t.simulated ? 'none' : '')
      + '</div></section>';

    var guarantees = panel('What this room guarantees', '<ul class="al-guar">' + d.guarantees.map(function (g) {
      return '<li class="al-guar-i">' + chip(g.holds ? 'ok' : 'crit', g.holds ? T('Holds') : T('Broken'), '', 'al-chip--sm')
        + '<span class="al-guar-t">' + esc(T(g.text)) + '</span>'
        + '<span class="al-guar-b">' + esc(g.basis === 'RUNTIME' ? T('Checked now') : T('Pinned at build')) + '</span></li>';
    }).join('') + '</ul>');

    var strip = panel('The loop', '<ol class="al-strip">' + d.loop.map(function (s) {
      return '<li class="al-strip-i' + (s.who === 'HUMAN' ? ' al-strip-i--human' : '') + '">'
        + '<span class="al-strip-n" data-no-i18n>' + esc(num(s.algorithms)) + '</span>'
        + '<span class="al-strip-t">' + esc(T(s.title)) + '</span></li>';
    }).join('') + '</ol>', T('Algorithms at each stage'));

    var byDomain = '<div class="al-dgrid">' + domains().map(function (dm) {
      var list = algorithms().filter(function (a) { return a.domain === dm.id; });
      return '<section class="al-panel al-dcard"><div class="al-dcard-h"><h2 class="al-panel-title">' + esc(T(dm.title)) + '</h2>'
        + '<span class="al-panel-note">' + esc(tf('%d algorithms', list.length)) + '</span></div>'
        + '<p class="al-dcard-d">' + esc(T(dm.describes)) + '</p>'
        + (list.length ? '<div class="al-dcard-l">' + list.map(function (a) {
          return '<button class="al-mini" type="button" data-al-open="' + esc(a.key) + '">'
            + '<span class="al-dot al-dot--' + gateKind(a.gate) + '" aria-hidden="true"></span>'
            + '<span class="al-mini-n">' + esc(T(a.name)) + '</span>'
            + '<span class="al-mini-v" data-no-i18n>' + esc(a.version) + '</span></button>';
        }).join('') + '</div>' : emptyState('No algorithm is registered in this domain yet', T('An algorithm joins a domain when it is added to the registry with its source, version and approval.')))
        + '</section>';
    }).join('') + '</div>';

    return hero + guarantees + strip + byDomain;
  }

  // ── REGISTRY ──────────────────────────────────────────────────────────────

  function registryHtml() {
    var list = algorithms();
    if (!list.length) return panel('Registry', emptyState('No algorithm is registered', T('Add an algorithm to src/algorithms/registry.ts with its source, version and approval.')));
    return '<div class="al-intro">' + esc(T('Every algorithm whose output somebody acts on. Open one for its inputs, outputs, source, fingerprint, approval and scenarios.')) + '</div>'
      + domains().map(function (dm) {
        var rows = list.filter(function (a) { return a.domain === dm.id; });
        if (!rows.length) return '';
        return panel(dm.title, '<div class="al-tbl" role="table">'
          + '<div class="al-tr al-tr--h" role="row"><span role="columnheader">' + esc(T('Algorithm')) + '</span>'
          + '<span role="columnheader">' + esc(T('Version')) + '</span><span role="columnheader">' + esc(T('Stage')) + '</span>'
          + '<span role="columnheader">' + esc(T('Approval')) + '</span><span role="columnheader">' + esc(T('Evaluation')) + '</span></div>'
          + rows.map(function (a) {
            return '<button class="al-tr al-tr--row" role="row" type="button" data-al-open="' + esc(a.key) + '">'
              + '<span role="cell" class="al-tr-name"><b>' + esc(T(a.name)) + '</b><code data-no-i18n>' + esc(a.key) + '</code></span>'
              + '<span role="cell"><code data-no-i18n>' + esc(a.version) + '</code></span>'
              + '<span role="cell">' + stageTag(a.stage) + '</span>'
              + '<span role="cell">' + gateChip(a.gate, 'al-chip--sm') + '</span>'
              + '<span role="cell">' + evalChip(a.evaluation, 'al-chip--sm') + '</span></button>';
          }).join('') + '</div>', tf('%d algorithms', rows.length));
      }).join('');
  }

  // ── THE LOOP ──────────────────────────────────────────────────────────────

  function loopHtml() {
    var d = AL.data;
    return '<div class="al-intro">' + esc(T('Every algorithm moves around one loop. Where each one stands is derived from evidence, never set by hand. Deploy is reachable only from Human approval.')) + '</div>'
      + '<ol class="al-loop">' + d.loop.map(function (s, i) {
        var next = s.next.map(function (n) { return T(STAGE_LABEL[n] || n); }).join(' · ');
        return '<li class="al-stage' + (s.who === 'HUMAN' ? ' al-stage--human' : '') + (s.id === 'HUMAN_APPROVAL' ? ' al-stage--gate' : '') + '">'
          + '<div class="al-stage-h"><span class="al-stage-n" data-no-i18n>' + esc('0' + (i + 1)) + '</span>'
          + '<span class="al-stage-who">' + esc(s.who === 'HUMAN' ? T('A person') : T('The platform')) + '</span></div>'
          + '<div class="al-stage-t">' + esc(T(s.title)) + '</div>'
          + '<div class="al-stage-d">' + esc(T(s.describes)) + '</div>'
          + '<div class="al-stage-f"><span><b data-no-i18n>' + esc(num(s.algorithms)) + '</b> ' + esc(T('here now')) + '</span>'
          + loopEvidence(s.id)
          + '<span class="al-stage-next">' + esc(T('Next')) + ': ' + esc(next) + '</span></div></li>';
      }).join('') + '</ol>'
      + panel('The approval gate', '<ol class="al-gate">'
        + '<li><b>' + esc(T('Only read/analyze')) + '</b><span>' + esc(T('An algorithm set to act is refused before anything else is looked at. No approval can allow it in Step 1.')) + '</span></li>'
        + '<li><b>' + esc(T('The exact version')) + '</b><span>' + esc(T('An approval of one version does not approve the next.')) + '</span></li>'
        + '<li><b>' + esc(T('The exact code')) + '</b><span>' + esc(T('The approval names a fingerprint of the algorithm’s source. One more edit and it no longer matches.')) + '</span></li>'
        + '<li><b>' + esc(T('Its own checks')) + '</b><span>' + esc(T('An algorithm failing its scenarios goes back to Test, whatever its approval says.')) + '</span></li>'
        + '<li><b>' + esc(T('A reviewed change')) + '</b><span>' + esc(T('The approval is recorded in the registry, which is code-owned: the edit that records it is itself reviewed. CI fails while any algorithm’s code differs from its approval.')) + '</span></li>'
        + '</ol>');
  }

  /**
   * What production evidence says at Measure, and what it hands to Learn.
   * Drawn only from the monitoring read; absent until it has answered.
   */
  function loopEvidence(stage) {
    var L = AL.mon && AL.mon.loop;
    var out = '';
    if (stage === 'MEASURE' && L) {
      out += '<span class="al-stage-ev">' + esc(tf('%d measured in production · %d not instrumented', L.measured, L.notInstrumented)) + '</span>'
        + '<span class="al-stage-ev">' + esc(tf('%d healthy · %d warning · %d failing · %d not enough data', L.healthy, L.warning, L.failing, L.notEnoughData)) + '</span>';
      if (AL.mon.writePath) out += '<span class="al-stage-ev">' + esc(T('Write path of this server')) + ': ' + esc(T(WRITE_LABEL[AL.mon.writePath.thisServer] || AL.mon.writePath.thisServer)) + '</span>';
    }
    if (stage === 'LEARN') {
      if (L) out += '<span class="al-stage-ev">' + esc(tf('%d with production findings for a person', L.withFindings)) + '</span>';
      var c = learnChecks();
      if (c) out += '<span class="al-stage-ev">' + esc(tf('%d of %d synthetic method checks passing', c.passed, c.total)) + '</span>';
      if (AL.learn) out += '<span class="al-stage-ev">' + esc(T('Real-world learning: disabled')) + '</span>';
    }
    var Cd = AL.cand && AL.cand.state === 'READY' ? AL.cand : null;
    if (stage === 'PROPOSE' && Cd) out += '<span class="al-stage-ev">' + esc(tf('Candidates: %d · experimental, none approved', Cd.counts.candidates)) + '</span>';
    if (stage === 'SIMULATE' && Cd) out += '<span class="al-stage-ev">' + esc(T('Candidates run in CI in a separate process, never on this server')) + '</span>';
    if (stage === 'TEST' && Cd) {
      var by = function (t) { return Cd.candidates.filter(function (c) { return c.test === t; }).length; };
      out += '<span class="al-stage-ev">' + esc(tf('%d held-out tests passed · %d failed · %d inconclusive', by('PASSED'), by('FAILED'), by('INCONCLUSIVE'))) + '</span>';
    }
    if (stage === 'HUMAN_APPROVAL' && Cd) out += '<span class="al-stage-ev">' + esc(tf('Candidates waiting for a person: %d', Cd.counts.awaitingApproval)) + '</span>';
    return out;
  }

  /** Method checks across every synthetic algorithm; null until learning has answered. */
  function learnChecks() {
    if (!AL.learn || !AL.learn.algorithms) return null;
    return AL.learn.algorithms.reduce(function (c, a) {
      if (a.synthetic) { c.passed += a.synthetic.methodChecks.passed; c.total += a.synthetic.methodChecks.total; }
      return c;
    }, { passed: 0, total: 0 });
  }

  // ── EVALUATION ────────────────────────────────────────────────────────────

  function evaluationHtml() {
    var list = algorithms();
    var simulated = list.filter(function (a) { return a.evaluation.state !== 'NOT_SIMULATED'; });
    var notSim = list.filter(function (a) { return a.evaluation.state === 'NOT_SIMULATED'; });
    return '<div class="al-intro">' + esc(T('Each algorithm runs on fixed synthetic scenarios, in this server, and is checked against the properties it must keep. No club, player or match data is read.')) + '</div>'
      + panel('Simulated', simulated.length ? '<div class="al-evl">' + simulated.map(function (a) {
        return '<button class="al-evl-i" type="button" data-al-open="' + esc(a.key) + '">'
          + '<span class="al-evl-n">' + esc(T(a.name)) + '</span>'
          + evalChip(a.evaluation, 'al-chip--sm') + '</button>';
      }).join('') + '</div>' : emptyState('No algorithm has a scenario yet', T('A scenario runs the real function on synthetic inputs and checks what comes back.')),
      tf('%d algorithms', simulated.length))
      + panel('Not simulated', notSim.length ? '<div class="al-evl">' + notSim.map(function (a) {
        return '<button class="al-evl-i" type="button" data-al-open="' + esc(a.key) + '">'
          + '<span class="al-evl-n">' + esc(T(a.name)) + '</span>' + evalChip(a.evaluation, 'al-chip--sm') + '</button>';
      }).join('') + '</div><div class="al-note">' + esc(T('Each one says why on its own page. Not simulated is never read as passing.')) + '</div>'
        : emptyState('Every registered algorithm has scenarios', ''), tf('%d algorithms', notSim.length));
  }

  // ── APPROVALS & AUDIT ─────────────────────────────────────────────────────

  function approvalsHtml() {
    var list = algorithms();
    // A chip still loading is a chip with nothing in it: the same box, so nothing moves when it arrives.
    var skel = '<span class="al-chip al-chip--sm al-chip--skel" aria-hidden="true">&nbsp;</span>';
    var cell = function (label, body) { return '<span role="cell"><span class="al-cell-l">' + esc(label) + '</span>' + body + '</span>'; };
    return '<div class="al-intro">' + esc(T('The approval each algorithm runs under, whether its code still matches it, and — for a change — whether the approval is still bound to the evidence it was judged on. A baseline approval records an algorithm exactly as it already ran in production when the registry was created; it takes effect when the platform owner merges the pull request that introduces it.')) + '</div>'
      + panel('Approvals', '<div class="al-tbl al-tbl--appr" role="table">'
        + '<div class="al-tr al-tr--h" role="row"><span role="columnheader">' + esc(T('Algorithm')) + '</span>'
        + '<span role="columnheader">' + esc(T('Approved version')) + '</span><span role="columnheader">' + esc(T('Kind')) + '</span>'
        + '<span role="columnheader">' + esc(T('Evidence')) + '</span><span role="columnheader">' + esc(T('Running code')) + '</span>'
        + '<span role="columnheader">' + esc(T('Gate')) + '</span></div>'
        + list.map(function (a) {
          var r = releaseOf(a.key);
          var pending = AL.relError ? absent(AL.relError) : skel;
          return '<button class="al-tr al-tr--row" role="row" type="button" data-al-open="' + esc(a.key) + '">'
            + '<span role="cell" class="al-tr-name"><b>' + esc(T(a.name)) + '</b></span>'
            + cell(T('Approved version'), a.approval ? '<code data-no-i18n>' + esc(a.approval.version) + '</code>' : absent(T('No approval recorded.')))
            + cell(T('Kind'), a.approval ? esc(a.approval.kind === 'BASELINE' ? T('Baseline') : T('Change')) : absent(T('No approval recorded.')))
            + cell(T('Evidence'), r ? bindingChip(r.binding, 'al-chip--sm') : pending)
            + cell(T('Running code'), r ? verdictChip(r.runtime.verdict, 'al-chip--sm') : pending)
            + cell(T('Gate'), gateChip(a.gate, 'al-chip--sm')) + '</button>';
        }).join('') + '</div>')
      + releaseStatesPanel()
      + changeApprovalsPanel()
      + panel('Where the evidence lives', '<div class="al-kv">'
        + kv(T('Approval record'), '<code data-no-i18n>src/algorithms/registry.ts</code>')
        + kv(T('Approval dossiers'), '<code data-no-i18n>src/algorithms/approvals/</code>')
        + kv(T('Code fingerprints'), '<code data-no-i18n>src/algorithms/generated/algorithm-manifest.json</code>')
        + kv(T('The loop and its gate'), '<code data-no-i18n>src/algorithms/loop.ts</code>')
        + kv(T('Release tool'), '<code data-no-i18n>npm run algorithms:release</code>')
        + kv(T('CI gate'), '<code data-no-i18n>tests/algorithms.unit.test.ts</code> <code data-no-i18n>tests/algorithms-release.unit.test.ts</code>')
        + kv(T('Cybersecurity control'), '<code data-no-i18n>algorithm-change-gate</code> <code data-no-i18n>algorithm-release-binding</code>')
        + '</div><div class="al-note">' + esc(T('Every approval is a change to a code-owned file, so it is reviewed and kept in the repository history with the pull request that carried it.')) + '</div>'
        + '<div class="al-note">' + esc(T('Rolling back to the previous approved version is a reviewed pull request too — the promotion reverted, or the release tool’s exact rollback — CI-gated and deployed like any change. CI rehearses a promotion and its rollback on every pull request.')) + '</div>');
  }

  function releaseOf(key) {
    var list = AL.rel && AL.rel.algorithms;
    return (list && list.filter(function (r) { return r.key === key; })[0]) || null;
  }
  function bindingChip(b, extra) { return chip(bindingKind(b.state), T(BINDING_LABEL[b.state] || b.state), T(BINDING_MEANING[b.state] || ''), extra); }
  function productionChip(p, extra) { return chip(p === 'MEASURED' ? 'info' : 'none', T(PRODUCTION_LABEL[p] || p), T(PRODUCTION_MEANING[p] || ''), extra); }
  function notKnownHere(value) {
    // The only value the contract allows; anything else would be a claim this server cannot make.
    return value === 'NOT_KNOWN_HERE' ? chip('unknown', T('Not known here'), '', 'al-chip--sm') : absent(String(value));
  }

  /** The states between an approval and a measurement — and which of them this server can see. */
  function releaseStatesPanel() {
    if (AL.relError && !AL.rel) return panel('Release states', emptyState('Release states could not be read', AL.relError));
    var R = AL.rel;
    if (!R) return panel('Release states', skeleton(6, 'check'));
    var t = R.totals;
    var mismatched = R.algorithms.filter(function (r) { return r.runtime.verdict === 'MISMATCH'; }).length;
    var row = function (state, here, how) {
      return '<div class="al-tr al-tr--static" role="row"><span role="cell" class="al-tr-name"><b>' + esc(state) + '</b></span>'
        + '<span role="cell">' + here + '</span><span role="cell" class="al-tr-why">' + esc(how) + '</span></div>';
    };
    return panel('Release states', '<div class="al-tbl al-tbl--rel" role="table">'
      + '<div class="al-tr al-tr--h" role="row"><span role="columnheader">' + esc(T('State')) + '</span>'
      + '<span role="columnheader">' + esc(T('On this server')) + '</span><span role="columnheader">' + esc(T('How it is known')) + '</span></div>'
      + row(T('Approved'), chip(t.baseline + t.change === t.registered && !t.bindingInvalid ? 'ok' : 'warn', tf('%d of %d', t.baseline + t.change, t.registered), '', 'al-chip--sm'),
        T('The approval records in this build’s registry: a baseline, or a change bound to its evidence.'))
      + row(T('Built from'), R.build.commit ? '<code class="al-fp" title="' + esc(R.build.commit) + '" data-no-i18n>' + esc(R.build.commit.slice(0, 12)) + '…</code>' : chip('unknown', T('Not reported'), '', 'al-chip--sm'),
        T('The commit Render built this server from, when Render reports it.'))
      + row(T('Deploy requested'), notKnownHere(R.deploy.requested), T('The deploy workflow’s summary for the merge commit says whether Render accepted the deploy.'))
      + row(T('Confirmed live'), notKnownHere(R.deploy.live), T('Render’s dashboard, checked by a person, says whether that deploy is live.'))
      + row(T('Running code'), chip(mismatched ? 'crit' : t.runtimeMatch === t.registered ? 'ok' : 'warn', tf('%d of %d', t.runtimeMatch, t.registered), '', 'al-chip--sm'),
        T('The fingerprints of the code this process loaded, proven against each approval.'))
      + row(T('Measured in production'), chip('info', tf('%d of %d', t.measured, t.registered), '', 'al-chip--sm'),
        T('Production telemetry, for the algorithms a request, worker or job calls. The others are not observable here, which never means unused.'))
      + '</div>');
  }

  function changeApprovalsPanel() {
    var R = AL.rel;
    if (!R) return AL.relError ? '' : panel('Change approvals', skeleton(2, 'check'));
    var changes = R.algorithms.filter(function (r) { return r.approval && r.approval.kind === 'CHANGE'; });
    if (!changes.length) {
      return panel('Change approvals', emptyState('No algorithm has changed since its baseline', T('A change approval is written by the release tool in a reviewed pull request. It names the candidate it promotes, the approved version it replaces and the dossier of evidence it was judged on, and binds them by digest.')), tf('Change approvals: %d', 0));
    }
    return panel('Change approvals', changes.map(changeCardHtml).join(''), tf('Change approvals: %d', changes.length));
  }

  function changeCardHtml(r) {
    var a = r.approval, b = r.binding, d = b.dossier;
    var rows = kv(T('Algorithm'), esc(T(r.name)))
      // Version numbers are a left-to-right run in every language, so the arrow points the same way in all of them.
      + kv(T('Version'), val((d ? d.baseline.version : '—') + ' → ' + a.version))
      + kv(T('Approved in'), '<code data-no-i18n>' + esc(a.reference) + '</code> ' + val(a.approvedAt))
      + kv(T('Evidence'), bindingChip(b, 'al-chip--sm'))
      + (b.reasons.length ? kv(T('Why'), '<ul class="al-rules">' + b.reasons.map(function (x) { return rule(T(BINDING_REASON_LABEL[x] || x)); }).join('') + '</ul>') : '')
      + kv(T('Running code'), verdictChip(r.runtime.verdict, 'al-chip--sm'))
      + kv(T('In production'), productionChip(r.production, 'al-chip--sm'));
    if (d) {
      rows += kv(T('Candidate'), '<code data-no-i18n>' + esc(d.candidate) + '</code>')
        + kv(T('Dossier'), '<code data-no-i18n>' + esc(d.file) + '</code> ' + fp(d.digest))
        + kv(T('Held-out test'), candTestChip(d.test.verdict, 'al-chip--sm'))
        + kv(T('Method checks passing'), val(num(d.test.methodChecks.passed) + ' / ' + num(d.test.methodChecks.total)))
        + kv(T('Properties'), esc(tf('%d kept · %d fixed · %d broken', d.properties.kept, d.properties.fixed, d.properties.broken)))
        + kv(T('Dependants'), d.dependants.length ? '<span class="al-chips">' + d.dependants.map(function (x) {
          return '<span class="al-dep"><b>' + esc(algorithmName(x.key)) + '</b> '
            + chip(x.path === 'CODE' ? 'info' : 'none', T(DEP_PATH_LABEL[x.path] || x.path), '', 'al-chip--sm') + ' '
            + (x.path === 'CODE' ? chip(x.simulated ? 'ok' : 'crit', x.simulated ? T('Simulated') : T('Not simulated'), '', 'al-chip--sm') : '')
            + (x.broken ? ' ' + chip('crit', T('Broken') + ' · ' + num(x.broken), '', 'al-chip--sm') : '') + '</span>';
        }).join('') + '</span>' : absent(T('No algorithm depends on it.')))
        + kv(T('Evaluation engine'), fp(d.engine.fingerprint) + ' ' + val(tf('Lab spec %d', d.engine.specVersion)) + ' '
          + (d.engine.commit ? '<code class="al-fp" title="' + esc(d.engine.commit) + '" data-no-i18n>' + esc(d.engine.commit.slice(0, 12)) + '…</code>' : absent(T('No commit recorded.'))))
        + kv(T('What the evidence cannot show'), '<ul class="al-rules">' + d.limits.map(function (l) { return rule(T(LIMIT_LABEL[l] || l)); }).join('') + '</ul>');
    }
    return '<div class="al-change"><div class="al-kv">' + rows + '</div></div>';
  }

  // ── MONITORING ────────────────────────────────────────────────────────────

  function evaluationRunsPanel() {
    var m = AL.data.monitoring;
    if (!m) return '';
    return panel('Synthetic evaluation in this server', '<div class="al-figs al-figs--4">'
      + figure(esc(num(m.evaluationRuns)), T('Evaluation runs since start'))
      + figure(esc(num(m.failingRuns)), T('Runs with a failing check'), m.failingRuns ? 'crit' : 'ok')
      + figure(has(m.lastDurationMs) ? esc(num(m.lastDurationMs)) + '<small> ms</small>' : absent(T('Not run yet.')), T('Last run took'))
      + figure(instantHtml(m.lastRunAt), T('Last run'))
      + '</div><div class="al-note">' + esc(T('This server re-runs every scenario when the room is read, at most once a minute, and keeps its own record of the runs since it started.')) + '</div>');
  }

  function monitoringSkeleton() {
    return '<div class="al-figs" aria-hidden="true">' + [0, 1, 2, 3].map(function () { return '<div class="al-skel-row al-skel-row--fig"></div>'; }).join('') + '</div>'
      + panel('Algorithms in production', skeleton(6, 'port'));
  }

  function monitoringHtml() {
    var intro = '<div class="al-intro">' + esc(T('How each algorithm really runs in production: how often, from which workflow, whether it failed, how long it took, what its outputs looked like and which code was running. Five states and no others; green only for what was measured. A finding is evidence for a person — nothing here changes an algorithm.')) + '</div>';
    if (AL.monError && !AL.mon) return intro + panel('', emptyState('Production monitoring could not be read', AL.monError)) + evaluationRunsPanel();
    var M = AL.mon;
    if (!M) return intro + monitoringSkeleton() + evaluationRunsPanel();

    var notice = M.state === 'STORE_UNAVAILABLE'
      ? '<div class="al-banner al-banner--warn" role="status">' + esc(T(M.reason || 'The telemetry store could not be read. Figures below are this server’s own unwritten runs only, and nothing reads as healthy.')) + '</div>' : '';

    var cov = M.coverage, tot = M.totals, rt = M.runtime;
    var figs = '<div class="al-figs">'
      + figure(esc(num(cov.instrumented)) + '<small> / ' + esc(num(cov.registered)) + '</small>', T('Algorithms measured in production'), cov.instrumented === cov.registered ? 'ok' : '')
      + figure(esc(num(tot.executions24h)), T('Production runs, last 24 hours'))
      + figure(esc(num(tot.failures24h)), T('Failed runs, last 24 hours'), tot.failures24h ? 'crit' : (tot.executions24h ? 'ok' : 'none'))
      + figure(esc(num(rt.verified)) + '<small> / ' + esc(num(cov.registered)) + '</small>', T('Running the approved code'), rt.mismatched ? 'crit' : rt.unverified ? 'warn' : 'ok')
      + '</div>';

    var states = panel('Production state', '<div class="al-mstates">' + MON_ORDER.map(function (st) {
      return '<div class="al-mstate al-mstate--' + monKind(st) + '">'
        + '<span class="al-mstate-n" data-no-i18n>' + esc(num(M.states[st])) + '</span>'
        + '<span class="al-mstate-l">' + esc(T(MON_LABEL[st])) + '</span>'
        + '<span class="al-mstate-d">' + esc(T(MON_MEANING[st])) + '</span></div>';
    }).join('') + '</div>', tot.lastExecutionAt ? T('Last production run') + ': ' + (fmtInstant(tot.lastExecutionAt) || {}).local : T('No production run recorded yet'));

    var rows = M.algorithms.slice().sort(function (a, b) { return MON_ORDER.indexOf(a.state) - MON_ORDER.indexOf(b.state); });
    var table = panel('Algorithms in production', '<div class="al-tbl al-tbl--mon" role="table">'
      + '<div class="al-tr al-tr--h" role="row"><span role="columnheader">' + esc(T('Algorithm')) + '</span>'
      + '<span role="columnheader">' + esc(T('State')) + '</span>'
      + '<span role="columnheader">' + esc(T('Runs · 7 days')) + '</span>'
      + '<span role="columnheader">' + esc(T('Failures · 7 days')) + '</span>'
      + '<span role="columnheader">' + esc(T('Latency p95')) + '</span>'
      + '<span role="columnheader">' + esc(T('Last run')) + '</span>'
      + '<span role="columnheader">' + esc(T('Code')) + '</span></div>'
      + rows.map(function (a) {
        return '<button class="al-tr al-tr--row" role="row" type="button" data-al-open="' + esc(a.key) + '">'
          + '<span role="cell" class="al-tr-name"><b>' + esc(T(a.name)) + '</b><code data-no-i18n>' + esc(a.key) + '</code></span>'
          + '<span role="cell">' + monChip(a.state, 'al-chip--sm') + '</span>'
          + '<span role="cell" class="al-num" data-no-i18n>' + (a.instrumented ? esc(num(a.executions7d)) : '—') + '</span>'
          + '<span role="cell" class="al-num' + (a.failures7d ? ' al-num--crit' : '') + '" data-no-i18n>' + (a.instrumented ? esc(num(a.failures7d)) : '—') + '</span>'
          + '<span role="cell" class="al-num" data-no-i18n>' + esc(atMost(a.p95AtMostUs)) + '</span>'
          + '<span role="cell">' + (a.instrumented ? instantHtml(a.lastExecutionAt, T('No production run recorded yet')) : absent(T('It does not run in production.'))) + '</span>'
          + '<span role="cell">' + verdictChip(a.runtimeCode, 'al-chip--sm') + '</span></button>';
      }).join('') + '</div>', tf('%d of %d algorithms instrumented', cov.instrumented, cov.registered));

    var st = M.store;
    var code = panel('The code that is running', '<div class="al-kv">'
      + kv(T('Read from'), esc(T(BASIS_LABEL[rt.basis] || rt.basis)))
      + kv(T('Proven approved'), '<span class="al-val" data-no-i18n>' + esc(num(rt.verified)) + ' / ' + esc(num(cov.registered)) + '</span>')
      + kv(T('Not the approved code'), '<span class="al-val" data-no-i18n>' + esc(num(rt.mismatched)) + '</span>')
      + kv(T('Not proven'), '<span class="al-val" data-no-i18n>' + esc(num(rt.unverified)) + '</span>')
      + kv(T('Fingerprinted at'), instantHtml(rt.computedAt))
      + kv(T('Took'), '<span class="al-val" data-no-i18n>' + esc(num(rt.durationMs)) + ' ms</span>')
      + '</div><div class="al-note">' + esc(T('At start, this server fingerprints the file it loaded for every algorithm. Compiled, it must match the seal its build wrote, and that seal must name the approved source.')) + '</div>');
    var store = panel('Telemetry store', '<div class="al-kv">'
      + kv(T('State'), chip(storeKind(st.state), T(STORE_LABEL[st.state] || st.state), '', 'al-chip--sm'))
      + kv(T('Last write'), instantHtml(st.lastFlushAt, T('Nothing written by this server yet.')))
      + kv(T('Last write failure'), st.lastFlushFailure ? '<code data-no-i18n>' + esc(st.lastFlushFailure) + '</code>' : absent(T('None.')))
      + kv(T('Waiting to be written'), '<span class="al-val" data-no-i18n>' + esc(num(st.pendingEntries)) + '</span>')
      + kv(T('Runs dropped'), '<span class="al-val" data-no-i18n>' + esc(num(st.droppedRuns)) + '</span>')
      + kv(T('Writes every'), '<span class="al-val" data-no-i18n>' + esc(num(st.flushIntervalSeconds)) + ' s</span>')
      + '</div><div class="al-note">' + esc(T('Counts, histograms and times only — never a player, a club, a user, an input or a message. Each server writes its own runs once a minute, and only when something ran.')) + '</div>');

    var th = M.thresholds;
    var how = panel('How it is measured', '<ul class="al-rules">'
      + rule(tf('Current figures cover the last %d days; drift and latency compare them with the %d days before.', th.recentDays, th.baselineDays))
      + rule(tf('Healthy needs at least %d production runs in the window and every check passing.', th.minHealthySample))
      + rule(tf('Failing: %d or more failures in %d hours, or any output outside its declared contract, or code that is not the approved code.', th.repeatedFailures, th.failureWindowHours))
      + rule(tf('Warning: any failure, no run for %d days, or a population stability index of 0.25 or more against the baseline.', th.staleAfterDays))
      + rule(tf('A distribution is compared only with at least %d recent and %d baseline outputs.', th.minDriftRecent, th.minDriftBaseline))
      + rule(tf('Telemetry is kept %d days, then deleted.', th.retentionDays))
      + '</ul><div class="al-note">' + esc(T('These thresholds decide what this room reports. No algorithm reads them, and nothing here changes an algorithm.')) + '</div>');

    return intro + notice + figs + states + table + '<div class="al-dgrid">' + code + store + '</div>' + writePathPanel(M.writePath) + how + evaluationRunsPanel();
  }

  /**
   * Is this deployment's write path proven? Only a write this server completed
   * says so; stored rows are history from earlier deployments or other servers.
   */
  function writePathPanel(w) {
    if (!w) return '';
    return panel('Write path of this deployment', '<div class="al-dgrid al-dgrid--tight">'
      + '<div class="al-kv">'
      + kv(T('This server'), chip(writeKind(w.thisServer), T(WRITE_LABEL[w.thisServer] || w.thisServer), '', 'al-chip--sm'))
      + kv(T('What that means'), esc(T(WRITE_MEANING[w.thisServer] || '')))
      + kv(T('Server started'), instantHtml(w.serverStartedAt))
      + kv(T('Verified at'), instantHtml(w.verifiedAt, T('Not verified by this server yet.')))
      + '</div><div class="al-kv">'
      + kv(T('Stored history'), chip(w.stored === 'ROWS_PRESENT' ? 'info' : w.stored === 'NO_ROWS' ? 'none' : 'unknown', T(STORED_LABEL[w.stored] || w.stored), '', 'al-chip--sm'))
      + kv(T('What that means'), esc(T(STORED_MEANING[w.stored] || '')))
      + kv(T('Newest stored run'), instantHtml(w.storedNewestRunAt, T('No stored run.')))
      + '</div></div>'
      + '<div class="al-note">' + esc(T('Each server answers for itself and none can vouch for another. Stored rows never verify the running deployment; only a write this server completed does.')) + '</div>');
  }

  function rule(text) { return '<li>' + esc(text) + '</li>'; }

  // ── one algorithm, in production ──────────────────────────────────────────

  // compact: for a half-width panel, where observed and required sit beneath
  // the label instead of squeezing it into a narrow column.
  function checksHtml(checks, compact) {
    return '<ul class="al-checks' + (compact ? ' al-checks--compact' : '') + '">' + checks.map(function (c) {
      var k = CHECK_STATE[c.state] || ['none', '·'];
      return '<li class="al-check al-check--' + k[0] + '">'
        + '<span class="al-check-m" aria-hidden="true">' + k[1] + '</span>'
        + '<span class="al-check-l">' + esc(T(c.label)) + ' <span class="al-check-s">' + esc(T(CHECK_STATE_LABEL[c.state] || c.state)) + '</span></span>'
        + '<span class="al-check-v"><span class="al-check-k">' + esc(T('Observed')) + '</span><code data-no-i18n>' + esc(c.observed) + '</code></span>'
        + '<span class="al-check-v"><span class="al-check-k">' + esc(T('Required')) + '</span><code data-no-i18n>' + esc(c.required) + '</code></span>'
        + '</li>';
    }).join('') + '</ul>';
  }

  function distributionHtml(d) {
    if (!d) return '';
    var rt = d.recent.reduce(function (s, v) { return s + v; }, 0);
    var bt = d.baseline.reduce(function (s, v) { return s + v; }, 0);
    if (!rt && !bt) return panel('Output distribution', emptyState('No output recorded in production yet', T('Every production output is counted into these bins as it is produced.')));
    return panel('Output distribution', '<div class="al-dist">'
      + '<div class="al-dist-legend"><span class="al-key al-key--recent"></span>' + esc(tf('Last %d days', AL.mon ? AL.mon.thresholds.recentDays : 7)) + ' · <span data-no-i18n>' + esc(num(rt)) + '</span>'
      + '<span class="al-key al-key--base"></span>' + esc(tf('The %d days before', AL.mon ? AL.mon.thresholds.baselineDays : 28)) + ' · <span data-no-i18n>' + esc(num(bt)) + '</span></div>'
      + d.labels.map(function (label, i) {
        return '<div class="al-dist-row">'
          + '<code class="al-dist-l" data-no-i18n>' + esc(label) + '</code>'
          + '<div class="al-dist-bars">'
          + '<div class="al-bar"><div class="al-bar-fill al-bar-fill--recent ' + wClass(d.recent[i], rt) + '"></div></div>'
          + '<div class="al-bar al-bar--thin"><div class="al-bar-fill al-bar-fill--base ' + wClass(d.baseline[i], bt) + '"></div></div>'
          + '</div>'
          + '<span class="al-dist-v" data-no-i18n>' + esc(pct(d.recent[i], rt)) + '</span>'
          + '<span class="al-dist-v al-dist-v--base" data-no-i18n>' + esc(pct(d.baseline[i], bt)) + '</span>'
          + '</div>';
      }).join('') + '</div>'
      + '<div class="al-note">' + esc(d.psi === null
        ? T('Not compared yet: a distribution is compared with its baseline only once both windows hold enough outputs.')
        : T('Population stability index against the baseline: %s (a shift is reported from 0.25).').replace('%s', String(d.psi))) + '</div>',
      T(d.name));
  }

  function dailyHtml(days) {
    var max = days.reduce(function (m, d) { return Math.max(m, d.executions); }, 0);
    return '<div class="al-days" role="img" aria-label="' + esc(T('Production runs per day, last 14 days')) + '">' + days.map(function (d) {
      var h = max ? Math.max(d.executions ? 1 : 0, Math.round(10 * d.executions / max)) : 0;
      return '<div class="al-day" title="' + esc(d.day + ' · ' + num(d.executions) + (d.failures ? ' · ✕ ' + num(d.failures) : '')) + '">'
        + '<div class="al-day-col"><div class="al-day-bar al-h-' + h + (d.failures ? ' al-day-bar--fail' : '') + '"></div></div>'
        + '<span class="al-day-d" data-no-i18n>' + esc(d.day.slice(8)) + '</span></div>';
    }).join('') + '</div>';
  }

  function productionHtml() {
    var det = AL.monDetail;
    if (AL.monDetailError) return panel('In production', emptyState('Production monitoring could not be read', AL.monDetailError));
    if (!det || det.key !== AL.key) return panel('In production', skeleton(5, 'check'));

    var head = '<div class="al-prod-h">' + monChip(det.state)
      + (det.findingList.length ? '<span class="al-chips">' + det.findingList.map(function (f) {
        return chip(f.severity === 'FAILING' ? 'crit' : f.severity === 'WARNING' ? 'warn' : 'none', T(FINDING_LABEL[f.id] || f.id), '', 'al-chip--sm');
      }).join('') + '</span>' : '')
      + '</div>';
    var store = det.storeState === 'STORE_UNAVAILABLE'
      ? '<div class="al-banner al-banner--warn" role="status">' + esc(T('The telemetry store could not be read. Figures below are this server’s own unwritten runs only, and nothing reads as healthy.')) + '</div>' : '';

    var rf = det.fingerprint;
    var codePanel = panel('The code that is running', '<div class="al-kv">'
      + kv(T('Verdict'), verdictChip(rf.verdict, 'al-chip--sm'))
      + kv(T('Why'), esc(T(REASON_LABEL[rf.reason] || rf.reason)))
      + kv(T('Read from'), esc(T(BASIS_LABEL[rf.basis] || rf.basis)))
      + kv(T('Loaded file'), '<code data-no-i18n>' + esc(rf.file) + '</code>')
      + kv(T('Code approved'), fp(rf.approved))
      + kv(T('Code running'), fp(rf.source))
      + kv(T('Loaded file fingerprint'), fp(rf.runtime))
      + '</div><div class="al-note">' + esc(T('“Code running” is the source fingerprint the loaded code is proven to be. It must equal the approved one.')) + '</div>');

    if (!det.instrumented) {
      return head + store + panel('Why it is not measured', '<p class="al-reason">' + esc(T(det.coverage.reason || '')) + '</p>'
        + '<div class="al-kv">'
        + kv(T('Evidence in the repository'), '<span class="al-chips">' + det.coverage.evidence.map(function (f) { return '<code class="al-token" data-no-i18n>' + esc(f) + '</code>'; }).join('') + '</span>')
        + '</div><div class="al-note">' + esc(T('CI re-proves this on every pull request: if this algorithm gains a production caller, the build fails until that caller is measured.')) + '</div>')
        + '<div class="al-dgrid">' + codePanel + panel('Checks', checksHtml(det.checks, true)) + '</div>';
    }

    var c = det.counts;
    var lat = det.latency.recent;
    var figs = '<div class="al-figs">'
      + figure(esc(num(c.recent.executions)), T('Production runs, last 7 days'))
      + figure(esc(num(c.recent.failures)), T('Failed runs, last 7 days'), c.recent.failures ? 'crit' : (c.recent.executions ? 'ok' : 'none'))
      + figure(esc(num(c.recent.outOfContract)) + '<small> / ' + esc(num(c.recent.outputs)) + '</small>', T('Outputs outside their contract'), c.recent.outOfContract ? 'crit' : (c.recent.outputs ? 'ok' : 'none'))
      + figure(instantHtml(det.lastExecutionAt, T('No production run recorded yet')), T('Last production run'))
      + '</div>';

    var activity = panel('Activity', dailyHtml(det.daily)
      + '<div class="al-kv al-kv--tight">'
      + kv(T('Runs, last 24 hours'), '<span class="al-val" data-no-i18n>' + esc(num(c.last24h.executions)) + ' · ✕ ' + esc(num(c.last24h.failures)) + '</span>')
      + kv(T('Runs kept'), '<span class="al-val" data-no-i18n>' + esc(num(c.retained.executions)) + ' · ✕ ' + esc(num(c.retained.failures)) + '</span>')
      + kv(T('First seen'), instantHtml(det.firstSeenAt, T('No production run recorded yet')))
      + kv(T('Last failure'), det.lastFailureAt ? instantHtml(det.lastFailureAt) + ' <code data-no-i18n>' + esc(det.lastFailureKind || '') + '</code>' : absent(T('None.')))
      + '</div>');

    var latency = panel('Latency', lat ? '<div class="al-kv">'
      + kv(T('Mean'), '<span class="al-val" data-no-i18n>' + esc(dur(lat.meanUs)) + '</span>')
      + kv(T('Half of runs within'), '<span class="al-val" data-no-i18n>' + esc(atMost(lat.p50AtMostUs)) + '</span>')
      + kv(T('95% of runs within'), '<span class="al-val" data-no-i18n>' + esc(atMost(lat.p95AtMostUs)) + '</span>')
      + kv(T('Slowest run'), '<span class="al-val" data-no-i18n>' + esc(dur(lat.maxUs)) + '</span>')
      + kv(T('Baseline, 95% within'), det.latency.baseline ? '<span class="al-val" data-no-i18n>' + esc(atMost(det.latency.baseline.p95AtMostUs)) + '</span>' : absent(T('No baseline yet.')))
      + '</div><div class="al-note">' + esc(T('Measured around the algorithm call itself. Percentiles are read from fixed bins, so each is an upper bound.')) + '</div>'
      : emptyState('No production run recorded yet', T('Latency appears with the first measured run.')));

    var quality = det.quality || det.freshness ? panel('Input quality', (det.quality ? '<div class="al-kv">'
        + kv(T('OK'), '<span class="al-val" data-no-i18n>' + esc(num(det.quality.ok)) + '</span>')
        + kv(T('Partial'), '<span class="al-val" data-no-i18n>' + esc(num(det.quality.partial)) + '</span>')
        + kv(T('Empty'), '<span class="al-val" data-no-i18n>' + esc(num(det.quality.empty)) + '</span>')
        + kv(T('Not assessed'), '<span class="al-val" data-no-i18n>' + esc(num(det.quality.notAssessed)) + '</span>')
        + '</div><div class="al-note">' + esc(T(det.quality.describes)) + '</div>' : '')
      + (det.freshness ? '<div class="al-kv al-kv--sep">'
        + kv(T('Fresh'), '<span class="al-val" data-no-i18n>' + esc(num(det.freshness.fresh)) + '</span>')
        + kv(T('Stale'), '<span class="al-val" data-no-i18n>' + esc(num(det.freshness.stale)) + '</span>')
        + kv(T('Not assessed'), '<span class="al-val" data-no-i18n>' + esc(num(det.freshness.notAssessed)) + '</span>')
        + '</div><div class="al-note">' + esc(T(det.freshness.describes)) + '</div>' : ''), T('Last 7 days'))
      : panel('Input quality', emptyState('Not assessed for this algorithm', T('Its call sites cannot see the quality of its inputs without reading more data than the algorithm itself does.')));

    var flows = panel('Where it runs', '<div class="al-flows">' + det.bySource.map(function (f) {
      return '<div class="al-flow">'
        + '<div class="al-flow-h"><code data-no-i18n>' + esc(f.source) + '</code><span class="al-stage-tag">' + esc(T(KIND_LABEL[f.kind] || f.kind)) + '</span></div>'
        + '<code class="al-flow-e" data-no-i18n>' + esc(f.entry) + '</code>'
        + '<div class="al-flow-f"><span data-no-i18n>' + esc(num(f.executions7d)) + ' · ✕ ' + esc(num(f.failures7d)) + '</span>'
        + instantHtml(f.lastAt, T('No production run recorded yet')) + '</div></div>';
    }).join('') + '</div>', T('Last 7 days'));

    var fps = panel('Code fingerprints seen in production', det.fingerprintsSeen.length ? '<ul class="al-fps">' + det.fingerprintsSeen.map(function (f) {
      return '<li>' + fp(f.fingerprint === 'unavailable' ? null : f.fingerprint) + '<code data-no-i18n>' + esc(f.version) + '</code>'
        + (f.approved ? chip('ok', T('Approved'), '', 'al-chip--sm') : chip('crit', T('Not approved'), '', 'al-chip--sm'))
        + (f.current ? chip('info', T('Running now'), '', 'al-chip--sm') : '')
        + '<span class="al-num" data-no-i18n>' + esc(num(f.executions)) + '</span>' + instantHtml(f.lastAt) + '</li>';
    }).join('') + '</ul>' : emptyState('No production run recorded yet', T('Each run is recorded under the fingerprint of the code that ran it.')));

    return head + store + figs
      + panel('Checks', checksHtml(det.checks), T('Evidence only — a finding changes nothing.'))
      + distributionHtml(det.distribution)
      + '<div class="al-dgrid">' + activity + latency + '</div>'
      + '<div class="al-dgrid">' + quality + flows + '</div>'
      + '<div class="al-dgrid">' + codePanel + fps + '</div>';
  }

  // ── ONE ALGORITHM ─────────────────────────────────────────────────────────

  function ports(list) {
    if (!list.length) return emptyState('None declared', '');
    return '<ul class="al-ports">' + list.map(function (p) {
      return '<li><span>' + esc(T(p.name)) + '</span>' + (p.unit ? '<em>' + esc(T(p.unit)) + '</em>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function scenariosHtml(det) {
    if (!det.scenarios.length) {
      return emptyState('Not simulated', det.notSimulatedBecause ? T(det.notSimulatedBecause) : '');
    }
    return det.scenarios.map(function (s) {
      return '<div class="al-scn">'
        + '<div class="al-scn-h"><span class="al-scn-t">' + esc(T(s.title)) + '</span>'
        + chip(s.pass ? 'ok' : 'crit', s.pass ? T('Passing') : T('Failing'), '', 'al-chip--sm') + '</div>'
        + '<ul class="al-checks">' + s.checks.map(function (c) {
          return '<li class="al-check al-check--' + (c.pass ? 'ok' : 'crit') + '">'
            + '<span class="al-check-m" aria-hidden="true">' + (c.pass ? '✓' : '✕') + '</span>'
            + '<span class="al-check-l">' + esc(T(c.label)) + '</span>'
            + '<span class="al-check-v"><span class="al-check-k">' + esc(T('Observed')) + '</span><code data-no-i18n>' + esc(c.observed) + '</code></span>'
            + '<span class="al-check-v"><span class="al-check-k">' + esc(T('Required')) + '</span><code data-no-i18n>' + esc(c.expected) + '</code></span>'
            + '</li>';
        }).join('') + '</ul></div>';
    }).join('');
  }

  function algorithmHtml() {
    var head = '<button class="al-back" type="button" data-al-nav="registry"><span aria-hidden="true">←</span> ' + esc(T('Registry')) + '</button>';
    if (AL.detailError) return head + panel('', emptyState('This algorithm could not be read', AL.detailError));
    var det = AL.detail;
    if (!det || det.key !== AL.key) {
      return head + '<div class="al-skel-hero al-skel-hero--sm" aria-hidden="true"></div>'
        + panel('In production', skeleton(5, 'check'))
        + panel('Learning', skeleton(4, 'check'))
        + '<div class="al-dgrid">' + panel('Inputs', skeleton(4, 'port')) + panel('Outputs', skeleton(4, 'port')) + '</div>'
        + panel('Scenarios', skeleton(3, 'check'));
    }
    var a = det.approval;
    return head
      + '<section class="al-ahead">'
      + '<div class="al-ahead-l"><div class="al-ahead-k">' + esc(domainTitle(det.domain)) + '</div>'
      + '<p class="al-ahead-s">' + esc(T(det.summary)) + '</p>'
      + '<div class="al-chips">' + gateChip(det.gate) + evalChip(det.evaluation) + stageTag(det.stage)
      + chip('info', T('Read/analyze only')) + '</div></div>'
      + '<div class="al-kv al-ahead-r">'
      + kv(T('Version'), '<code data-no-i18n>' + esc(det.version) + '</code>')
      + kv(T('Key'), '<code data-no-i18n>' + esc(det.key) + '</code>')
      + kv(T('Used by'), esc(det.usedBy.map(T).join(' · ')))
      + kv(T('Built on'), det.dependsOn.length ? det.dependsOn.map(function (k) {
        return '<button class="al-link" type="button" data-al-open="' + esc(k) + '">' + esc(algorithmName(k)) + '</button>';
      }).join(' ') : esc(T('Nothing else')))
      + '</div></section>'
      + '<h2 class="al-sec">' + esc(T('In production')) + '</h2>'
      + productionHtml()
      + '<h2 class="al-sec">' + esc(T('Learning')) + '</h2>'
      + learningDetailHtml()
      + '<h2 class="al-sec">' + esc(T('Definition and approval')) + '</h2>'
      + '<div class="al-dgrid">' + panel('Inputs', ports(det.inputs)) + panel('Outputs', ports(det.outputs)) + '</div>'
      + panel('Scenarios', scenariosHtml(det), det.scenarios.length ? tf('%d of %d checks passing', det.evaluation.passed, det.evaluation.total) : '')
      + '<div class="al-dgrid">'
      + panel('Approval', a ? '<div class="al-kv">'
        + kv(T('Kind'), esc(a.kind === 'BASELINE' ? T('Baseline') : T('Change')))
        + kv(T('Approved version'), '<code data-no-i18n>' + esc(a.version) + '</code>')
        + kv(T('Approved by'), esc(T('Platform owner')))
        + kv(T('Recorded in'), '<span data-no-i18n>' + esc(a.reference) + '</span>')
        + kv(T('Date'), '<span data-no-i18n>' + esc(a.approvedAt) + '</span>')
        + '</div>' : emptyState('No approval is recorded', T('Until the platform owner approves a version, the algorithm stays at Observe.')))
      + panel('Source & fingerprint', '<div class="al-kv">'
        + kv(T('File'), '<code data-no-i18n>' + esc(det.source.file) + '</code>')
        + kv(T('Declarations'), '<span class="al-chips">' + det.source.symbols.map(function (s) { return '<code class="al-token" data-no-i18n>' + esc(s) + '</code>'; }).join('') + '</span>')
        + kv(T('Code now'), fp(det.fingerprint.current))
        + kv(T('Code approved'), fp(det.fingerprint.approved))
        + kv(T('Match'), det.fingerprint.matches ? chip('ok', T('Identical'), '', 'al-chip--sm') : chip('warn', T('Different'), '', 'al-chip--sm'))
        + '</div><div class="al-note">' + esc(T('The fingerprint covers the declarations listed, with comments and whitespace ignored — rewording a comment is not a change to an algorithm.')) + '</div>')
      + '</div>'
      + '<div class="al-dgrid">'
      + panel('Versions', '<ol class="al-vers">' + det.versions.map(function (v) {
        return '<li><code data-no-i18n>' + esc(v.version) + '</code><span data-no-i18n class="al-vers-d">' + esc(v.date) + '</span><span>' + esc(T(v.note)) + '</span></li>';
      }).join('') + '</ol>')
      + panel('Tests', det.tests.length ? '<div class="al-chips">' + det.tests.map(function (t) { return '<code class="al-token" data-no-i18n>' + esc(t) + '</code>'; }).join('') + '</div>'
        + '<div class="al-note">' + esc(T('Besides these, tests/algorithms.unit.test.ts runs every scenario on every pull request.')) + '</div>'
        : emptyState('No dedicated unit test', T('Its scenarios above are its tests: tests/algorithms.unit.test.ts runs them on every pull request.')))
      + '</div>';
  }

  // ── LEARNING (Step 3) ─────────────────────────────────────────────────────
  //
  // Two lanes, never merged: synthetic method checks, every view of them
  // carrying the banner that says what they are not; and the real-world lane,
  // disabled, with the prerequisites that are not met.

  function learningSkeleton() {
    return '<div class="al-figs" aria-hidden="true">' + [0, 1, 2, 3].map(function () { return '<div class="al-skel-row al-skel-row--fig"></div>'; }).join('') + '</div>'
      + '<div class="al-dgrid">' + panel('Synthetic method checks', skeleton(4, 'port')) + panel('Real-world evidence', skeleton(4, 'port')) + '</div>';
  }

  function learningHtml() {
    var intro = '<div class="al-intro">' + esc(T('Learning compares what an algorithm said with what happened. Here only synthetic outcomes are used: they test the measuring method — whether a planted error is found, and whether no error is reported where none was planted. They say nothing about real-world accuracy, and nothing here changes an algorithm.')) + '</div>';
    if (AL.learnError && !AL.learn) return intro + panel('', emptyState('Learning could not be read', AL.learnError));
    var Lr = AL.learn;
    if (!Lr) return intro + syntheticBanner() + learningSkeleton();
    var c = learnChecks();
    var synth = Lr.algorithms.filter(function (a) { return a.synthetic; });

    var figs = '<div class="al-figs">'
      + figure(esc(num(c.passed)) + '<small> / ' + esc(num(c.total)) + '</small>', T('Synthetic method checks passing'), c.total && c.passed === c.total ? 'ok' : 'crit')
      + figure(esc(num(Lr.counts.syntheticOnly)) + '<small> / ' + esc(num(Lr.algorithms.length)) + '</small>', T('Algorithms with synthetic checks'))
      + figure(esc(num(0)), T('Real-world evaluations (disabled)'), 'none')
      + figure(esc(num(Lr.counts.excludedHealth)), T('Excluded: health data'), 'none')
      + '</div>';

    var lane = panel('Synthetic method checks', synth.map(function (a) {
      var sy = a.synthetic;
      return '<div class="al-lane">'
        + '<div class="al-lane-h"><button class="al-link" type="button" data-al-open="' + esc(a.key) + '">' + esc(T(a.name)) + '</button>'
        + '<span class="al-chips">' + verdictChip(sy.codeVerdict, 'al-chip--sm')
        + chip(sy.methodChecks.passed === sy.methodChecks.total ? 'ok' : 'crit', tf('%d of %d method checks passed', sy.methodChecks.passed, sy.methodChecks.total), '', 'al-chip--sm') + '</span></div>'
        + '<ul class="al-lane-list">' + sy.scenarios.map(function (r) {
          var decl = (Lr.scenarios.filter(function (x) { return x.id === r.id; })[0]) || { title: r.id };
          return '<li><span class="al-lane-t">' + esc(T(decl.title)) + '</span>' + verdictTag(r.verdict) + methodChip(r.methodCheck, 'al-chip--sm') + '</li>';
        }).join('') + '</ul></div>';
    }).join(''), T('Synthetic'));

    var real = panel('Real-world evidence', '<div class="al-kv">'
      + kv(T('State'), chip('off', T('Disabled'), '', 'al-chip--sm'))
      + kv(T('Why'), esc(T(Lr.realWorld.reason)))
      + '</div><ul class="al-prereq">' + Lr.realWorld.prerequisites.map(function (p) {
        return '<li class="al-prereq-i"><span class="al-prereq-m" aria-hidden="true">' + (p.met ? '✓' : '✕') + '</span>'
          + '<span>' + esc(T(p.label)) + '</span>' + chip(p.met ? 'ok' : 'none', p.met ? T('Met') : T('Not met'), '', 'al-chip--sm') + '</li>';
      }).join('') + '</ul>');

    var table = panel('Every algorithm', '<div class="al-tbl al-tbl--learn" role="table">'
      + '<div class="al-tr al-tr--h" role="row"><span role="columnheader">' + esc(T('Algorithm')) + '</span>'
      + '<span role="columnheader">' + esc(T('Learning')) + '</span>'
      + '<span role="columnheader">' + esc(T('Why')) + '</span></div>'
      + Lr.algorithms.map(function (a) {
        return '<button class="al-tr al-tr--row" role="row" type="button" data-al-open="' + esc(a.key) + '">'
          + '<span role="cell" class="al-tr-name"><b>' + esc(T(a.name)) + '</b><code data-no-i18n>' + esc(a.key) + '</code></span>'
          + '<span role="cell">' + chip(learnStatusKind(a.status), T(LEARN_STATUS_LABEL[a.status] || a.status), '', 'al-chip--sm') + '</span>'
          + '<span role="cell" class="al-tr-why">' + esc(T(a.reason)) + '</span></button>';
      }).join('') + '</div>', tf('%d synthetic · %d covered · %d nothing to learn from · %d excluded', Lr.counts.syntheticOnly, Lr.counts.derived, Lr.counts.noGroundTruth, Lr.counts.excludedHealth));

    return intro + syntheticBanner(Lr.notice) + figs
      + '<div class="al-dgrid">' + lane + real + '</div>'
      + table
      + '<div class="al-dgrid">' + learnRulesPanel(Lr.rules) + learnUsePanel(Lr) + '</div>'
      + '<div class="al-dgrid">' + learnScenariosPanel(Lr) + learnShotsPanel(Lr.generator) + '</div>';
  }

  function learnRulesPanel(r) {
    var j = r.justifications;
    var item = function (rule, why) { return '<li><b>' + esc(rule) + '</b><span>' + esc(T(why)) + '</span></li>'; };
    return panel('How results are judged', '<ol class="al-gate">'
      + item(tf('Not enough data below %d expected goals or %d expected non-goals.', r.minExpectedEvents, r.minExpectedEvents), j.sampleFloor)
      + item(T('Miscalibration detected when total goals differ from expected beyond the test, or the calibration slope’s 97.5% interval excludes 1.'), j.miscalibration)
      + item(T('Otherwise: none detected at this sample size, with the smallest error that could still hide.'), j.noneDetected)
      + item(tf('Bins with fewer than %d shots are marked too few to read.', r.minBinShots), j.binDisplay)
      + item(T('Probabilities of exactly 0 or 1 are clipped before a logarithm.'), j.probabilityClip)
      + '</ol><div class="al-note">' + esc(T('These rules decide what this room reports. No algorithm reads them, and no result changes an algorithm.')) + '</div>');
  }

  function learnUsePanel(Lr) {
    var lim = Lr.limits;
    var rows = Lr.algorithms.filter(function (a) { return a.synthetic; }).map(function (a) {
      var m = a.synthetic.measured;
      return '<div class="al-use"><div class="al-use-h"><b>' + esc(T(a.name)) + '</b>'
        + chip(a.synthetic.servedFromCache ? 'info' : 'none', a.synthetic.servedFromCache ? T('Served from memory') : T('Computed for this request'), '', 'al-chip--sm') + '</div>'
        + '<div class="al-kv">'
        + kv(T('Wall time'), val(ms(m.wallMs)))
        + kv(T('Busy time'), val(ms(m.busyMs) + ' / ' + ms(lim.busyBudgetMs)))
        + kv(T('Longest uninterrupted slice'), val(ms(m.maxSliceMs)))
        + kv(T('Slices · yields'), val(num(m.slices) + ' · ' + num(m.yields)))
        + kv(T('Shots drawn'), val(num(m.shots) + ' / ' + num(lim.shotsPerAlgorithmMax)))
        + kv(T('Memory allocated (exact)'), val(bytes(m.allocatedBytes)))
        + kv(T('Peak heap growth (sampled)'), val(bytes(m.peakHeapDeltaBytes)))
        + kv(T('Computed at'), instantHtml(m.computedAt))
        + '</div></div>';
    }).join('');
    return panel('Resource use, measured', rows
      + '<div class="al-note">' + esc(tf('Limits, enforced: at most %d shots per scenario, a yield every %d shots and after every fitting step, and a stop when the busy time runs out. Computed once per server and code version, never at start-up.', lim.shotsPerScenarioMax, lim.sliceShots)) + '</div>');
  }

  function truthText(t) {
    var base = T(TRUTH_LABEL[t.kind] || t.kind);
    return t.parameter === null ? base : base + ' (' + (t.kind === 'LOGIT_SHIFT' ? '+' : '×') + dec(t.parameter, 2) + ')';
  }

  function learnScenariosPanel(Lr) {
    return panel('The scenarios', '<ul class="al-scn-defs">' + Lr.scenarios.map(function (d) {
      var size = d.size.shots !== null ? tf('%d shots', d.size.shots) : tf('Until %d goals are expected', d.size.untilExpectedGoals);
      return '<li><div class="al-scn-defs-h"><b>' + esc(T(d.title)) + '</b>' + (d.circular ? chip('none', T('Circular by design'), '', 'al-chip--sm') : '') + '</div>'
        + '<span>' + esc(T(d.purpose)) + '</span>'
        + '<span class="al-scn-defs-m">' + esc(truthText(d.truth)) + ' · ' + esc(size) + ' · ' + esc(T('Expected')) + ': ' + esc(T(LEARN_VERDICT_LABEL[d.expected.verdict] || d.expected.verdict)) + '</span></li>';
    }).join('') + '</ul>');
  }

  function learnShotsPanel(g) {
    var mix = function (list) { return list.map(function (x) { return '<code class="al-token" data-no-i18n>' + esc(x.value) + ' ' + esc(share(x.share)) + '</code>'; }).join(''); };
    return panel('The invented shots', '<div class="al-kv">'
      + kv(T('Where'), val('x ' + num(g.x[0]) + '–' + num(g.x[1]) + ' · y ' + num(g.y[0]) + '–' + num(g.y[1])))
      + kv(T('Body part'), '<span class="al-chips">' + mix(g.bodyPart) + '</span>')
      + kv(T('Technique'), '<span class="al-chips">' + mix(g.technique) + '</span>')
      + kv(T('Situation'), '<span class="al-chips">' + mix(g.situation) + '</span>')
      + kv(T('Under pressure'), val(share(g.pressured)))
      + kv(T('On the counter'), val(share(g.counter)))
      + '</div><div class="al-note">' + esc(T('Arbitrary, and documented as such: a different mix gives different figures. One more reason a synthetic result says nothing about the real world.')) + '</div>');
  }

  /** One algorithm's learning, on its page. */
  function learningDetailHtml() {
    if (AL.learnDetailError) return panel('Learning', emptyState('Learning could not be read', AL.learnDetailError));
    var d = AL.learnDetail;
    if (!d || d.key !== AL.key) return panel('Learning', skeleton(4, 'check'));
    var head = '<div class="al-prod-h">' + chip(learnStatusKind(d.status), T(LEARN_STATUS_LABEL[d.status] || d.status))
      + chip('off', T('Real-world learning: disabled'), '', 'al-chip--sm') + '</div>';
    if (!d.synthetic) {
      return head + panel('Learning', '<div class="al-kv">'
        + kv(T('Why'), esc(T(d.reason)))
        + (d.derivedFrom ? kv(T('Covered by'), '<button class="al-link" type="button" data-al-open="' + esc(d.derivedFrom) + '">' + esc(algorithmName(d.derivedFrom)) + '</button>') : '')
        + '</div><div class="al-note">' + esc(T('No synthetic check is run where there is no outcome to compare with: an invented outcome would be an invented truth.')) + '</div>');
    }
    var sy = d.synthetic;
    var sel = sy.scenarios.filter(function (x) { return x.id === AL.learnScenario; })[0] || sy.scenarios[0];
    var tabs = '<div class="al-scn-tabs" role="tablist">' + sy.scenarios.map(function (r) {
      var on = r.id === sel.id;
      return '<button class="al-scn-tab' + (on ? ' is-on' : '') + '" type="button" role="tab" aria-selected="' + (on ? 'true' : 'false') + '" data-al-scn="' + esc(r.id) + '">'
        + '<span class="al-scn-tab-t">' + esc(T(r.title)) + '</span>'
        + '<span class="al-chips">' + verdictTag(r.verdict) + methodChip(r.methodCheck, 'al-chip--sm') + '</span></button>';
    }).join('') + '</div>';
    // Every scenario's body is drawn into the same grid cell and only the
    // selected one is visible: the cell is as tall as the tallest, so switching
    // a tab moves nothing beneath it — and switching repaints nothing at all.
    var bodies = '<div class="al-scn-bodies">' + sy.scenarios.map(function (r) {
      var on = r.id === sel.id;
      return '<div class="al-scn-body' + (on ? ' is-on' : '') + '" role="tabpanel" data-al-scn-body="' + esc(r.id) + '"' + (on ? '' : ' aria-hidden="true"') + '>'
        + scenarioDetailHtml(r, sy) + '</div>';
    }).join('') + '</div>';
    return head + syntheticBanner(d.notice)
      + panel('Synthetic method checks', tabs + bodies, tf('%d of %d method checks passed', sy.methodChecks.passed, sy.methodChecks.total));
  }

  function scenarioDetailHtml(r, sy) {
    var m = r.metrics;
    var expected = T(LEARN_VERDICT_LABEL[r.expected.verdict] || r.expected.verdict) + (r.expected.signal ? ' · ' + T(SIGNAL_LABEL[r.expected.signal]) : '');
    var reasons = r.reasons.length ? r.reasons.map(function (x) { return esc(T(LEARN_REASON_LABEL[x] || x)); }).join('<br>') : esc(T('None.'));
    var left = '<div class="al-kv">'
      + kv(T('Verdict'), verdictTag(r.verdict))
      + kv(T('Expected'), esc(expected))
      + kv(T('Method check'), methodChip(r.methodCheck, 'al-chip--sm'))
      + kv(T('Found in'), r.signals.length ? esc(r.signals.map(function (x) { return T(SIGNAL_LABEL[x] || x); }).join(' · ')) : absent(T('Nothing was found.')))
      + kv(T('Notes'), reasons)
      + kv(T('Shots · goals · expected goals'), m ? val(num(m.shots) + ' · ' + num(m.goals) + ' · ' + dec(m.expectedGoals, 1)) : absent())
      + kv(T('Goals ÷ expected (97.5%)'), m ? val(ivl(m.observedOverExpected, 3)) : absent())
      + kv(T('Goals test z'), m && m.citl ? val(dec(m.citl.z, 2)) : absent(T('Not computed.')))
      + kv(T('Calibration slope (97.5%)'), m && m.slope ? val(ivl(m.slope, 3)) : absent(r.fitAttempted ? T('The fit failed; see the notes.') : T('Not attempted below the sample floor.')))
      + kv(T('Calibration intercept (97.5%)'), m && m.intercept ? val(ivl(m.intercept, 3)) : absent())
      + kv(T('Brier score (95%)'), m && m.brier ? val(ivl(m.brier, 4)) : absent())
      + kv(T('Brier, always the average'), m ? val(dec(m.brierReference, 4)) : absent())
      + kv(T('Log-loss (95%)'), m && m.logLoss ? val(ivl(m.logLoss, 4)) : absent())
      + kv(T('Calibration error'), m ? val(dec(m.ece, 4)) : absent())
      + kv(T('Smallest detectable error'), m && m.minimumDetectableError !== null ? val(share(m.minimumDetectableError)) : absent())
      + kv(T('Clipped probabilities'), m ? val(num(m.clipped)) : absent())
      + '</div>';
    var bins = m ? '<div class="al-bins" role="table">'
      + '<div class="al-bin al-bin--h" role="row"><span role="columnheader">' + esc(T('Predicted')) + '</span><span role="columnheader">' + esc(T('Shots')) + '</span>'
      + '<span role="columnheader">' + esc(T('Mean predicted')) + '</span><span role="columnheader">' + esc(T('Observed (95%)')) + '</span></div>'
      + m.bins.map(function (b) {
        return '<div class="al-bin' + (b.readable ? '' : ' al-bin--thin') + '" role="row">'
          + '<span role="cell" class="al-val" data-no-i18n>' + esc(dec(b.from, 2) + '–' + dec(b.to, 2)) + '</span>'
          + '<span role="cell" class="al-num" data-no-i18n>' + esc(num(b.shots)) + '</span>'
          + '<span role="cell" class="al-num" data-no-i18n>' + esc(b.meanPredicted === null ? '—' : dec(b.meanPredicted, 3)) + '</span>'
          + '<span role="cell" class="al-num"' + (b.readable ? ' data-no-i18n>' + esc(b.observedRate === null ? '—' : dec(b.observedRate, 3) + ' [' + dec(b.low, 3) + '–' + dec(b.high, 3) + ']') : '>' + esc(b.shots ? T('Too few to read') : '—')) + '</span></div>';
      }).join('') + '</div>' : emptyState('No result', T('The scenario could not run.'));
    var meta = '<div class="al-kv al-kv--sep">'
      + kv(T('What it checks'), esc(T(r.purpose)))
      + kv(T('Truth'), esc(truthText(r.truth)))
      + kv(T('Seed'), val(String(r.seed)))
      + kv(T('Code evaluated'), verdictChip(sy.code.verdict, 'al-chip--sm') + ' ' + fp(sy.code.fingerprint))
      + kv(T('Time · longest slice · memory'), val(ms(r.measured.wallMs) + ' · ' + ms(r.measured.maxSliceMs) + ' · ' + bytes(r.measured.allocatedBytes)))
      + '</div>';
    return '<div class="al-dgrid al-dgrid--tight">' + left + '<div>' + bins + '</div></div>' + meta;
  }

  // ── PROPOSALS (Step 4) ────────────────────────────────────────────────────

  function propTitle(spec, algorithm, id) {
    var list = (spec && spec.properties && spec.properties[algorithm]) || [];
    var p = list.filter(function (x) { return x.id === id; })[0];
    return p ? T(p.title) : id;
  }
  /** A reason code as a sentence; "CODE:property-id" adds the property's title. */
  function reasonText(code, spec, algorithm) {
    var i = code.indexOf(':');
    var head = i < 0 ? code : code.slice(0, i);
    var text = T(CAND_REASON_LABEL[head] || head);
    return i < 0 ? text : text + ' ' + propTitle(spec, algorithm, code.slice(i + 1));
  }
  function candTestChip(t, extra) { return chip(candTestKind(t), T(CAND_TEST_LABEL[t] || t), T(CAND_TEST_MEANING[t] || ''), extra); }
  function experimentalChip() { return chip('info', T('Experimental'), T('A proposal under test. It does not run in production.'), 'al-chip--sm'); }
  function notApprovedChip() {
    return chip('off', T('Not approved for production'), T('Approval exists only in the registry, as a reviewed record of an exact version and fingerprint.'), 'al-chip--sm');
  }

  function proposalsSkeleton() {
    return '<div class="al-figs" aria-hidden="true">' + [0, 1, 2, 3].map(function () { return '<div class="al-skel-row al-skel-row--fig"></div>'; }).join('') + '</div>'
      + panel('Candidates', skeleton(2, 'port'))
      + '<div class="al-dgrid">' + panel('How a candidate is judged', skeleton(4, 'port')) + panel('The comparison method checks itself', skeleton(4, 'port')) + '</div>';
  }

  function proposalsHtml() {
    var intro = '<div class="al-intro">' + esc(T('A candidate is a proposed new version of an approved algorithm. It is written as separate code, run beside the approved version on the same synthetic shots in a separate process in CI, and tested on held-out seeds. Nothing here runs in production or changes an algorithm; only a reviewed change that records a human approval could.')) + '</div>';
    if (AL.candError && !AL.cand) return intro + panel('', emptyState('Proposals could not be read', AL.candError));
    var C = AL.cand;
    if (!C) return intro + syntheticBanner(CAND_NOTICE) + proposalsSkeleton();
    if (C.state !== 'READY') {
      return intro + syntheticBanner(C.notice) + panel('', emptyState('Candidate evidence is not available', T(C.reason || ''))
        + '<div class="al-notice"><code data-no-i18n>npm run algorithms:candidates</code></div>');
    }
    var mc = C.methodChecks;
    var figs = '<div class="al-figs">'
      + figure(esc(num(C.counts.candidates)), T('Candidates'))
      + figure(esc(num(C.counts.awaitingApproval)), T('Waiting for a person'), C.counts.awaitingApproval ? 'warn' : '')
      + figure(esc(num(mc.passed)) + '<small> / ' + esc(num(mc.total)) + '</small>', T('Method checks passing'), mc.total && mc.passed === mc.total ? 'ok' : 'crit')
      + figure(esc(T('Never')), T('Run in production'), 'none')
      + '</div>';
    var list = C.candidates.length ? '<div class="al-tbl al-tbl--cand" role="table">'
      + '<div class="al-tr al-tr--h" role="row"><span role="columnheader">' + esc(T('Candidate')) + '</span>'
      + '<span role="columnheader">' + esc(T('Stage')) + '</span>'
      + '<span role="columnheader">' + esc(T('Held-out test')) + '</span>'
      + '<span role="columnheader">' + esc(T('Properties')) + '</span>'
      + '<span role="columnheader">' + esc(T('Step 3 shots changed')) + '</span></div>'
      + C.candidates.map(function (c) {
        return '<button class="al-tr al-tr--row" role="row" type="button" data-al-cand="' + esc(c.id) + '">'
          + '<span role="cell" class="al-tr-name"><b>' + esc(algorithmName(c.algorithm)) + ' ' + val(c.version || '—') + '</b>'
          + '<span class="al-chips">' + experimentalChip() + notApprovedChip()
          + (c.freshness === 'STALE' ? chip('warn', T('Stale evidence'), '', 'al-chip--sm') : '') + '</span></span>'
          + '<span role="cell"><span class="al-cell-l">' + esc(T('Stage')) + '</span>' + stageTag(c.stage) + '</span>'
          + '<span role="cell">' + candTestChip(c.test, 'al-chip--sm') + '</span>'
          + '<span role="cell" class="al-tr-why">' + esc(tf('%d kept · %d fixed · %d broken', c.properties.kept, c.properties.fixed, c.properties.broken)) + '</span>'
          + '<span role="cell"><span class="al-cell-l">' + esc(T('Step 3 shots changed')) + '</span><span class="al-num" data-no-i18n>' + esc(c.changedShare === null ? '—' : share(c.changedShare)) + '</span></span></button>';
      }).join('') + '</div>'
      : emptyState('No candidate has been proposed', T('A candidate is added as reviewed code in the lab, outside the production build, with the evidence the lab wrote for it; CI runs the lab again to check that evidence.'));
    return intro + syntheticBanner(C.notice) + figs
      + panel('Candidates', list, tf('Candidates: %d · none approved', C.counts.candidates))
      + '<div class="al-dgrid">' + candRulesPanel(C.spec) + candMethodPanel(C) + '</div>'
      + candSetsPanel(C.spec)
      + '<div class="al-dgrid">' + candProcessPanel() + candLimitsPanel(C.spec.limits) + '</div>';
  }

  function candRulesPanel(spec) {
    var r = spec.rules, j = spec.justifications;
    var item = function (rule, why) { return '<li><b>' + esc(rule) + '</b><span>' + esc(T(why)) + '</span></li>'; };
    return panel('How a candidate is judged', '<ol class="al-gate">'
      + item(T('The verdict reads held-out seeds only.'), j.heldOut)
      + item(T('Decides: every property the approved version keeps must still hold, and every property the candidate claims to fix must be fixed.'), j.probes)
      + item(tf('A random property counts only with at least %d probes where the two versions differ.', r.minRegionProbes), j.minRegionProbes)
      + item(T('Reported, never decides: score differences, in a world built from each version.'), j.bracket)
      + item(tf('A score bracket needs at least %d shots that differ.', r.minChangedShots), j.minChangedShots)
      + item(T('Reported, never decides: how many real shots a test would need, conditional on the synthetic assumptions.'), j.requiredShots)
      + '</ol><div class="al-note">' + esc(T(spec.conditionalNote)) + '</div>');
  }

  function candMethodPanel(C) {
    return panel('The comparison method checks itself', '<ul class="al-mcs">' + C.methodChecks.checks.map(function (m) {
      return '<li class="al-mc"><div class="al-mc-h"><b>' + esc(T(m.title)) + '</b><span class="al-chips">'
        + chip('info', T(LAB_CHECK_LABEL[m.observed] || m.observed || '—'), '', 'al-chip--sm')
        + methodChip(m.passed ? 'PASSED' : 'FAILED', 'al-chip--sm') + '</span></div>'
        + '<span class="al-mc-p">' + esc(T(m.purpose)) + '</span></li>';
    }).join('') + '</ul><div class="al-note">' + esc(T('Planted versions with known differences go through exactly the code a candidate goes through, on seeds no candidate is judged on. If any check fails, no candidate is judged.')) + '</div>',
    tf('%d of %d passed', C.methodChecks.passed, C.methodChecks.total));
  }

  function candSetsPanel(spec) {
    var mixTitle = function (id) { var m = spec.mixes.filter(function (x) { return x.id === id; })[0]; return m ? T(m.title) : id; };
    var phase = function (p) { return chip(p === 'HELD_OUT' ? 'info' : 'none', T(PHASE_LABEL[p] || p), '', 'al-chip--sm'); };
    var rows = spec.scenarios.map(function (sc) {
      return '<div class="al-tr al-tr--static" role="row"><span role="cell"><code data-no-i18n>' + esc(sc.id) + '</code></span>'
        + '<span role="cell">' + phase(sc.phase) + '</span><span role="cell" class="al-tr-name">' + esc(mixTitle(sc.mix)) + '</span>'
        + '<span role="cell"><span class="al-cell-l">' + esc(T('Shots')) + '</span><span class="al-num" data-no-i18n>' + esc(num(sc.shots)) + '</span></span>'
        + '<span role="cell"><span class="al-cell-l">' + esc(T('Seed')) + '</span><span class="al-num" data-no-i18n>' + esc(String(sc.seed)) + '</span></span></div>';
    }).concat(spec.probeSets.map(function (ps) {
      return '<div class="al-tr al-tr--static" role="row"><span role="cell" class="al-tr-name">' + esc(T('Property probes')) + '</span>'
        + '<span role="cell">' + phase(ps.phase) + '</span><span role="cell" class="al-tr-name">' + esc(tf('%d per property', ps.instances)) + '</span>'
        + '<span role="cell"><span class="al-cell-l">' + esc(T('Shots')) + '</span><span class="al-num" data-no-i18n>—</span></span>'
        + '<span role="cell"><span class="al-cell-l">' + esc(T('Seed')) + '</span><span class="al-num" data-no-i18n>' + esc(String(ps.seed)) + '</span></span></div>';
    })).join('');
    return panel('Development and held-out', '<div class="al-tbl al-tbl--sets" role="table">'
      + '<div class="al-tr al-tr--h" role="row"><span role="columnheader">' + esc(T('Set')) + '</span><span role="columnheader">' + esc(T('Phase')) + '</span>'
      + '<span role="columnheader">' + esc(T('Shot mix')) + '</span><span role="columnheader">' + esc(T('Shots')) + '</span><span role="columnheader">' + esc(T('Seed')) + '</span></div>'
      + rows + '</div><ul class="al-scn-defs al-scn-defs--sep">' + spec.mixes.map(function (m) {
        return '<li><div class="al-scn-defs-h"><b>' + esc(T(m.title)) + '</b></div><span>' + esc(T(m.purpose)) + '</span>'
          + '<span class="al-scn-defs-m">' + val('x ' + num(m.x[0]) + '–' + num(m.x[1]) + ' · y ' + num(m.y[0]) + '–' + num(m.y[1])) + '</span></li>';
      }).join('') + '</ul><div class="al-note">' + esc(T('Simulate uses the development seeds; the Test verdict reads only the held-out ones. No seed is shared between them, or with Learning.')) + '</div>');
  }

  function candProcessPanel() {
    var steps = [
      T('Written as separate code in the lab, outside the production build: the approved declarations, changed only where the hypothesis needs.'),
      T('Declared before it runs: its version, the approved version it is compared with, its reason and the properties it claims to fix.'),
      T('Run by the lab, each candidate in its own process with a time limit, capped memory and an empty environment; the evidence it writes is committed with the candidate.'),
      T('Reviewed in a pull request: CI recomputes the evidence and fails if it is stale, the isolation control must hold, and the code owner reviews it.'),
      T('Merged as an experiment. Promotion would be a separate change that records a human approval of the exact version and fingerprint, and is not part of this step.'),
    ];
    return panel('How a candidate is added', '<ol class="al-gate">' + steps.map(function (x) { return '<li><span>' + esc(x) + '</span></li>'; }).join('') + '</ol>');
  }

  function candLimitsPanel(L) {
    return panel('Resource limits', '<div class="al-kv">'
      + kv(T('Time limit per process'), val(dur(L.jobTimeoutMs * 1000)))
      + kv(T('Heap limit per process'), val(num(L.childHeapMb) + ' MB'))
      + kv(T('Output limit per process'), val(bytes(L.maxStdoutBytes)))
      + kv(T('Shots per scenario'), val(num(L.shotsPerScenarioMax)))
      + kv(T('Probes per property'), val(num(L.probeInstancesMax)))
      + kv(T('Candidates at most'), val(num(L.candidatesMax)))
      + '</div><div class="al-note">' + esc(T('The parent process holds the clock: past the limit it kills the whole process group, so even an endless loop stops. Each process starts with an empty environment, so no secret reaches candidate code. This server runs none of it.')) + '</div>');
  }

  // ── one candidate ──

  var CAND_TABS = ['change', 'simulate', 'test', 'approval', 'resources'];

  function candidateHtml() {
    var back = '<div class="al-prod-h"><button class="al-link" type="button" data-al-nav="proposals">' + esc(T('All proposals')) + '</button></div>';
    if (AL.candDetailError) return back + panel('', emptyState('This candidate could not be read', AL.candDetailError));
    var d = AL.candDetail;
    if (!d || d.id !== AL.candId) return back + syntheticBanner(CAND_NOTICE) + panel('', skeleton(6, 'check'));
    var head = '<div class="al-prod-h">' + experimentalChip() + notApprovedChip() + stageTag(d.stage) + candTestChip(d.test)
      + (d.freshness === 'STALE' ? chip('warn', T('Stale evidence'), d.staleReasons.map(function (r) { return reasonText(r, d.spec, d.algorithm); }).join(' ')) : '')
      + '<button class="al-link" type="button" data-al-nav="proposals">' + esc(T('All proposals')) + '</button></div>';
    var tabs = '<div class="al-scn-tabs al-scn-tabs--cand" role="tablist">' + CAND_TABS.map(function (k) {
      var on = k === AL.candTab;
      return '<button class="al-scn-tab' + (on ? ' is-on' : '') + '" type="button" role="tab" aria-selected="' + (on ? 'true' : 'false') + '" data-al-ctab="' + k + '">'
        + '<span class="al-scn-tab-t">' + esc(T(CAND_TAB_LABEL[k])) + '</span></button>';
    }).join('') + '</div>';
    // Every tab's body is drawn into the same grid cell and only the selected
    // one is visible: switching a tab moves nothing beneath it, and repaints nothing.
    var bodies = '<div class="al-scn-bodies">' + CAND_TABS.map(function (k) {
      var on = k === AL.candTab;
      return '<div class="al-scn-body' + (on ? ' is-on' : '') + '" role="tabpanel" data-al-ctab-body="' + k + '"' + (on ? '' : ' aria-hidden="true"') + '>' + candTabHtml(k, d) + '</div>';
    }).join('') + '</div>';
    return head + syntheticBanner(d.notice) + tabs + bodies;
  }

  function candTabHtml(k, d) {
    switch (k) {
      case 'simulate': return candPhaseHtml(d, 'development');
      case 'test': return candTestHtml(d);
      case 'approval': return candApprovalHtml(d);
      case 'resources': return candResourcesHtml(d);
      default: return candChangeHtml(d);
    }
  }

  function candChangeHtml(d) {
    var e = d.entry, dc = e.declaration, code = e.code;
    var proposal = panel('The proposal', '<div class="al-kv">'
      + kv(T('Algorithm'), '<button class="al-link" type="button" data-al-open="' + esc(d.algorithm) + '">' + esc(algorithmName(d.algorithm)) + '</button>')
      + kv(T('Candidate version'), val(d.version || '—'))
      + kv(T('Compared with'), val(d.baselineVersion || '—') + ' ' + fp(dc ? dc.baseline.fingerprint : null))
      + kv(T('Proposed by'), dc ? esc(T(PROPOSER_LABEL[dc.proposedBy] || dc.proposedBy)) : absent())
      + kv(T('Proposed on'), dc ? val(dc.proposedAt) : absent())
      + kv(T('File'), '<code data-no-i18n>' + esc(code.file) + '</code>')
      + kv(T('Why'), dc ? prose(T(dc.rationale)) : absent(T('The declaration could not be read.')))
      + kv(T('Claims to fix'), dc && dc.hypothesis.targets.length ? prose(dc.hypothesis.targets.map(function (t) { return propTitle(d.spec, d.algorithm, t); }).join(' · ')) : absent(T('Nothing.')))
      + kv(T('Where it should change'), dc ? prose(T(dc.hypothesis.region)) : absent())
      + '</div>');
    var codePanel = panel('The code', '<div class="al-kv">'
      + kv(T('Candidate fingerprint'), fp(code.fingerprint))
      + kv(T('Approved fingerprint'), fp(code.approvedFingerprint))
      + '</div><ul class="al-fps al-fps--sep">' + code.symbols.map(function (x) {
        return '<li><code data-no-i18n>' + esc(x.name) + '</code>'
          + chip(x.status === 'CHANGED' ? 'warn' : x.status === 'MISSING' ? 'crit' : 'none', T(SYMBOL_LABEL[x.status] || x.status), '', 'al-chip--sm') + '</li>';
      }).join('') + '</ul>'
      + code.diff.map(function (df) {
        return '<div class="al-diff" dir="ltr" data-no-i18n><div class="al-diff-h">' + esc(df.symbol) + '</div>'
          + df.removed.map(function (l) { return '<div class="al-diff-l al-diff-l--del"><span aria-hidden="true">−</span><code>' + esc(l) + '</code></div>'; }).join('')
          + df.added.map(function (l) { return '<div class="al-diff-l al-diff-l--add"><span aria-hidden="true">+</span><code>' + esc(l) + '</code></div>'; }).join('')
          + '</div>';
      }).join('')
      + '<div class="al-note">' + esc(T('The candidate keeps the approved declarations’ names, so its fingerprint is the one production would carry if it were ever promoted.')) + '</div>');
    var refs = panel('What the proposal rests on', dc ? '<ul class="al-scn-defs">' + dc.evidence.map(function (r) {
      return '<li><div class="al-scn-defs-h">' + chip('info', T(EVIDENCE_KIND_LABEL[r.kind] || r.kind), '', 'al-chip--sm') + '<b>' + esc(T(r.ref)) + '</b></div>'
        + '<span>' + esc(T(r.note)) + '</span></li>';
    }).join('') + '</ul>' : emptyState('No declaration', T('The declaration could not be read.')));
    var deps = panel('Would also change if promoted', d.dependants.length ? '<ul class="al-lane-list">' + d.dependants.map(function (x) {
      return '<li><button class="al-link" type="button" data-al-open="' + esc(x.key) + '">' + esc(T(x.name)) + '</button>'
        + chip(x.simulated ? 'info' : 'none', x.simulated ? T('Has synthetic scenarios') : T('No synthetic scenarios'), '', 'al-chip--sm') + '<span></span></li>';
    }).join('') + '</ul><div class="al-note">' + esc(T('Read from the registry: these algorithms use its output, directly or through another. This step does not simulate them.')) + '</div>'
      : emptyState('Nothing reads its output', T('No registered algorithm depends on it.')));
    return '<div class="al-dgrid">' + proposal + codePanel + '</div><div class="al-dgrid">' + refs + deps + '</div>';
  }

  function candPhaseHtml(d, key) {
    var R = d.entry.results;
    if (!R) return panel('', emptyState('No results', d.entry.run.state === 'REFUSED' ? T('The proposal was refused before it was judged.') : T('The run did not complete.')));
    var ph = R[key];
    return candPropsPanel(d, ph) + ph.scenarios.map(function (sc) { return candScenarioPanel(d, sc); }).join('');
  }

  /** One probe that broke a property, as the evidence recorded it: where it was and what came back. */
  function exampleHtml(d, p, side) {
    var ex = p[side].example;
    if (!ex) return '';
    var from = 0, to = ex.points.length - 1;
    if (ex.points.length > 2) {
      for (var k = 1; k < ex.values.length; k++) {
        if (ex.values[k] !== null && ex.values[k - 1] !== null && ex.values[k] < ex.values[k - 1]) { from = k - 1; to = k; break; }
      }
    }
    var parts = [];
    for (var i = from; i <= to; i++) {
      var pt = ex.points[i];
      parts.push('(' + num(pt.x) + ', ' + num(pt.y) + ') ' + pt.bodyPart + ' → ' + fix4(ex.values[i]));
    }
    return '<div class="al-ex"><span>' + esc(side === 'approved' ? T('Where the approved version breaks it:') : T('Where the candidate breaks it:')) + ' ' + esc(propTitle(d.spec, d.algorithm, p.id)) + '</span>'
      + '<code dir="ltr" data-no-i18n>' + esc(parts.join('   ')) + '</code></div>';
  }

  function candPropsPanel(d, ph) {
    var title = ph.phase === 'HELD_OUT' ? T('Properties on held-out probes') : T('Properties on development probes');
    var cell = function (p, s) { return s.violations ? tf('%d of %d probes', s.violations, p.instances) : T('None'); };
    var rows = ph.properties.map(function (p) {
      return '<div class="al-tr al-tr--static" role="row">'
        + '<span role="cell" class="al-tr-name"><b>' + esc(propTitle(d.spec, d.algorithm, p.id)) + '</b><code data-no-i18n>' + esc(p.id) + '</code></span>'
        + '<span role="cell" class="al-tr-why' + (p.approved.violations ? ' al-crit-t' : '') + '"><span class="al-cell-l">' + esc(T('Approved breaks it')) + '</span>' + esc(cell(p, p.approved)) + '</span>'
        + '<span role="cell" class="al-tr-why' + (p.candidate.violations ? ' al-crit-t' : '') + '"><span class="al-cell-l">' + esc(T('Candidate breaks it')) + '</span>' + esc(cell(p, p.candidate)) + '</span>'
        + '<span role="cell">' + chip(outcomeKind(p.outcome), T(OUTCOME_LABEL[p.outcome] || p.outcome), '', 'al-chip--sm') + '</span>'
        + '<span role="cell"><span class="al-cell-l">' + esc(T('Probes where they differ')) + '</span><span class="al-num" data-no-i18n>' + esc(num(p.inRegion)) + '</span>'
        + (p.covered ? '' : ' ' + chip('warn', T('Too few'), '', 'al-chip--sm')) + '</span></div>';
    }).join('');
    var examples = ph.properties.filter(function (p) { return p.outcome !== 'KEPT'; }).map(function (p) {
      return exampleHtml(d, p, p.outcome === 'BROKEN' ? 'candidate' : 'approved');
    }).join('');
    return panel(title, '<div class="al-tbl al-tbl--props" role="table">'
      + '<div class="al-tr al-tr--h" role="row"><span role="columnheader">' + esc(T('Property')) + '</span>'
      + '<span role="columnheader">' + esc(T('Approved breaks it')) + '</span><span role="columnheader">' + esc(T('Candidate breaks it')) + '</span>'
      + '<span role="columnheader">' + esc(T('Outcome')) + '</span><span role="columnheader">' + esc(T('Probes where they differ')) + '</span></div>'
      + rows + '</div>' + examples);
  }

  function requiredHtml(r, d) {
    var fig = r.point === null ? '—' : '≈ ' + shotsFig(r.point);
    var range = r.low === null && r.high === null ? '' : ' [' + shotsFig(r.low) + ' – ' + (r.high === null ? '∞' : shotsFig(r.high)) + ']';
    return '<span class="al-req"><span class="al-num" data-no-i18n>' + esc(fig + range) + '</span>'
      + chip(r.status === 'ESTIMATED' ? 'info' : 'none', T(ESTIMATE_LABEL[r.status] || r.status),
        r.reasons.map(function (x) { return reasonText(x, d.spec, d.algorithm); }).join(' '), 'al-chip--sm') + '</span>';
  }

  function candScenarioPanel(d, sc) {
    var spec = d.spec;
    var mix = spec.mixes.filter(function (m) { return m.id === sc.mix; })[0];
    var dv = sc.divergence;
    var facts = '<div class="al-kv">'
      + kv(T('Shots · seed'), val(num(sc.shots) + ' · ' + sc.seed))
      + kv(T('Shots that change (95%)'), val(num(dv.changed) + ' · ' + share(dv.share.value) + ' [' + share(dv.share.low) + ' – ' + share(dv.share.high) + ']'))
      + kv(T('Largest rise · largest fall'), val(sig(dv.maxIncrease, 3) + ' · ' + sig(dv.maxDecrease, 3)))
      + kv(T('Invalid outputs, approved · candidate'), val(num(sc.invalid.approved) + ' · ' + num(sc.invalid.candidate)))
      + '</div>';
    var bands = '<div class="al-bins al-bins--bands" role="table">'
      + '<div class="al-bin al-bin--h" role="row"><span role="columnheader">' + esc(T('Metres from goal')) + '</span><span role="columnheader">' + esc(T('Shots')) + '</span>'
      + '<span role="columnheader">' + esc(T('Changed')) + '</span><span role="columnheader">' + esc(T('Mean change')) + '</span></div>'
      + dv.bands.map(function (b) {
        return '<div class="al-bin' + (b.shots ? '' : ' al-bin--thin') + '" role="row">'
          + '<span role="cell" class="al-val" data-no-i18n>' + esc(num(b.from) + (b.to === null ? '+' : '–' + num(b.to))) + '</span>'
          + '<span role="cell" class="al-num" data-no-i18n>' + esc(num(b.shots)) + '</span>'
          + '<span role="cell" class="al-num" data-no-i18n>' + esc(num(b.changed)) + '</span>'
          + '<span role="cell" class="al-num" data-no-i18n>' + esc(b.meanDelta === null ? '—' : sig(b.meanDelta, 3)) + '</span></div>';
      }).join('') + '</div>';
    var worlds = '<div class="al-tbl al-tbl--worlds" role="table">'
      + '<div class="al-tr al-tr--h" role="row"><span role="columnheader">' + esc(T('Outcomes drawn from')) + '</span>'
      + '<span role="columnheader">' + esc(T('Brier difference (95%)')) + '</span><span role="columnheader">' + esc(T('Log-loss difference (95%)')) + '</span>'
      + '<span role="columnheader">' + esc(T('Separable here')) + '</span><span role="columnheader">' + esc(T('Real shots a test would need (conditional)')) + '</span></div>'
      + sc.worlds.map(function (w) {
        var wd = spec.worlds.filter(function (x) { return x.id === w.world; })[0];
        return '<div class="al-tr al-tr--static" role="row">'
          + '<span role="cell" class="al-tr-name"><b>' + esc(wd ? T(wd.title) : w.world) + '</b><span class="al-tr-why">' + esc(wd ? T(wd.meaning) : '') + '</span></span>'
          + '<span role="cell" class="al-num"><span class="al-cell-l">' + esc(T('Brier')) + '</span><span data-no-i18n>' + esc(ivlSig(w.brierDelta, 2)) + '</span></span>'
          + '<span role="cell" class="al-num"><span class="al-cell-l">' + esc(T('Log-loss')) + '</span><span data-no-i18n>' + esc(ivlSig(w.logLossDelta, 2)) + '</span></span>'
          + '<span role="cell"><span class="al-cell-l">' + esc(T('Separable here')) + '</span>' + (w.status === 'COMPUTED'
            ? chip('info', w.distinguishable ? T('Yes, at this size') : T('No, at this size'), '', 'al-chip--sm')
            : chip('none', T(WORLD_STATUS_LABEL[w.status] || w.status), '', 'al-chip--sm')) + '</span>'
          + '<span role="cell"><span class="al-cell-l">' + esc(T('Real shots a test would need (conditional)')) + '</span>' + requiredHtml(w.required, d) + '</span></div>';
      }).join('') + '</div>'
      + '<div class="al-note">' + esc(T('A difference is candidate minus approved: above zero, the candidate scored worse in that world. Each world favours one side by construction, so the two rows bound what is at stake rather than name a winner.')) + ' ' + esc(T(spec.conditionalNote)) + '</div>';
    return panel(mix ? T(mix.title) : sc.mix, '<div class="al-dgrid al-dgrid--tight">' + facts + bands + '</div>' + worlds, T(PHASE_LABEL[sc.phase] || sc.phase));
  }

  function candTestHtml(d) {
    var v = d.entry.verdict;
    var verdict = panel('The verdict', '<div class="al-kv">'
      + kv(T('Held-out test'), candTestChip(v.test))
      + kv(T('What it means'), prose(T(CAND_TEST_MEANING[v.test] || '')))
      + kv(T('Reasons'), v.reasons.length ? v.reasons.map(function (x) { return prose(reasonText(x, d.spec, d.algorithm)); }).join('<br>') : prose(T('None.')))
      + kv(T('Development and held-out'), v.agreement === null ? absent()
        : chip(v.agreement === 'AGREE' ? 'info' : 'warn', v.agreement === 'AGREE' ? T('Agree on every property') : T('Disagree on a property'), '', 'al-chip--sm'))
      + kv(T('Method checks'), esc(tf('%d of %d passed', d.methodChecks.passed, d.methodChecks.total)))
      + '</div><div class="al-note">' + esc(T('Only properties decide. Score differences and sample sizes are reported beside them and never judged: outcomes drawn from either version favour that version by construction.')) + '</div>');
    return verdict + candPhaseHtml(d, 'heldOut');
  }

  function candApprovalHtml(d) {
    var n = d.approvalNeeds;
    var arrow = AL_DIR === 'rtl' ? ' ← ' : ' → ';
    return panel('The approval gate', '<div class="al-kv">'
      + kv(T('Gate'), gateChip(d.gate))
      + kv(T('Can reach Deploy'), chip('off', T('No'), '', 'al-chip--sm'))
      + kv(T('Path on the loop'), esc(d.path.map(function (x) { return T(STAGE_LABEL[x] || x); }).join(arrow)))
      + kv(T('An approval would have to name'), val(n.version || '—') + ' ' + fp(n.fingerprint))
      + kv(T('Approved today'), val(n.approvedVersion || '—') + ' ' + fp(n.approvedFingerprint))
      + '</div><div class="al-note">' + esc(T('An approval is recorded only in the registry, by a reviewed change that names this exact version and fingerprint. Nothing in this room can approve or promote a candidate: the release tool writes a promotion only into a pull request, and it takes effect only when the platform owner merges it.')) + '</div>');
  }

  function candResourcesHtml(d) {
    var m = d.entry.measured, r = d.entry.run, L = d.spec.limits;
    return panel('What the run cost', '<div class="al-kv">'
      + kv(T('Run'), chip(runKind(r.state), T(RUN_LABEL[r.state] || r.state), '', 'al-chip--sm') + (r.signal ? ' ' + val(r.signal) : ''))
      + (r.reasons.length ? kv(T('Why'), r.reasons.map(function (x) { return esc(reasonText(x, d.spec, d.algorithm)); }).join('<br>')) : '')
      + kv(T('Wall time, start to exit'), val(ms(m.wallMs) + ' / ' + dur(L.jobTimeoutMs * 1000)))
      + kv(T('Start-up: Node, TypeScript, modules'), val(ms(m.startupMs)))
      + kv(T('Evaluation'), val(ms(m.evaluationMs)))
      + kv(T('CPU, user · system'), val(ms(m.cpuUserMs) + ' · ' + ms(m.cpuSystemMs)))
      + kv(T('Peak memory (RSS)'), val(bytes(m.maxRssBytes)))
      + kv(T('Heap in use at the end'), val(bytes(m.heapUsedBytes) + ' / ' + num(L.childHeapMb) + ' MB'))
      + kv(T('Predictions computed'), val(num(m.predictions)))
      + kv(T('Per call, approved · candidate'), val(nsText(m.approvedNsPerCall) + ' · ' + nsText(m.candidateNsPerCall)))
      + kv(T('Measured'), instantHtml(d.generatedAt))
      + '</div><div class="al-note">' + esc(T('Measured when the evidence was generated, in a separate process. This server ran nothing. Figures differ from machine to machine, so they are left out of the freshness check.')) + '</div>');
  }

  // ── content ───────────────────────────────────────────────────────────────

  function overviewSkeleton() {
    return '<div class="al-skel-hero" aria-hidden="true"></div>'
      + panel('What this room guarantees', skeleton(4, 'guar'))
      + panel('The loop', '<div class="al-skel-strip" aria-hidden="true"></div>');
  }

  function contentHtml() {
    if (AL.error && !AL.data) return panel('', emptyState('The Algorithms room could not be read', AL.error));
    if (!AL.data) return overviewSkeleton();
    if (AL.data.state === 'NOT_GENERATED') {
      return panel('', emptyState('Algorithm evidence has not been generated', T(AL.data.reason || ''))
        + '<div class="al-notice"><code data-no-i18n>npm run algorithms:discover</code></div>');
    }
    switch (AL.section) {
      case 'registry': return registryHtml();
      case 'loop': return loopHtml();
      case 'evaluation': return evaluationHtml();
      case 'approvals': return approvalsHtml();
      case 'monitoring': return monitoringHtml();
      case 'learning': return learningHtml();
      case 'proposals': return proposalsHtml();
      case 'candidate': return candidateHtml();
      case 'algorithm': return algorithmHtml();
      default: return overviewHtml();
    }
  }

  // ── loading ───────────────────────────────────────────────────────────────

  function apiBase() {
    return (typeof window.FAM_CONFIG !== 'undefined' && window.FAM_CONFIG.API_BASE) ? window.FAM_CONFIG.API_BASE : '/api/v1';
  }
  function token() {
    try { return (window.State && window.State.token) || localStorage.getItem('familista_token') || ''; } catch (_) { return ''; }
  }
  function api(path) {
    var t = token();
    return fetch(apiBase() + path, {
      headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}),
      credentials: 'include',
      cache: 'no-store',
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw new Error(T('Only the platform owner can open the Algorithms room.'));
      if (r.status === 404) throw new Error(T('This algorithm is not in the registry.'));
      if (!r.ok) throw new Error(tf('The platform answered HTTP %d.', r.status));
      return r.json();
    }).then(function (b) { return (b && b.data) || b; });
  }

  /** The fields this screen cannot draw without. An absent field is reported, never drawn as empty. */
  var REQUIRED = {
    overview: ['state', 'measuredAt', 'loop', 'domains', 'algorithms', 'guarantees'],
    detail: ['summary', 'usedBy', 'inputs', 'outputs', 'dependsOn', 'source', 'fingerprint', 'versions', 'tests', 'scenarios'],
    monitoring: ['state', 'measuredAt', 'thresholds', 'coverage', 'states', 'totals', 'runtime', 'store', 'loop', 'algorithms'],
    production: ['storeState', 'coverage', 'fingerprint', 'counts', 'latency', 'bySource', 'fingerprintsSeen', 'daily', 'checks', 'findingList'],
    learning: ['evidence', 'notice', 'measuredAt', 'realWorld', 'rules', 'limits', 'generator', 'scenarios', 'counts', 'algorithms'],
    learnDetail: ['status', 'reason', 'evidence', 'realWorld'],
    candidates: ['state', 'evidence', 'production', 'notice', 'methodChecks', 'counts', 'candidates'],
    candidate: ['stage', 'gate', 'test', 'freshness', 'staleReasons', 'path', 'dependants', 'approvalNeeds', 'entry', 'methodChecks', 'spec', 'notice'],
    releases: ['build', 'deploy', 'algorithms', 'totals'],
  };
  function missingFields(payload, required) {
    return required.filter(function (k) { return !payload || payload[k] === undefined || payload[k] === null; });
  }
  function contractError(endpoint, missing) {
    return T('CONTRACT ERROR') + ' · ' + endpoint + ' · ' + T('the response did not carry:') + ' ' + missing.join(', ');
  }

  function loadOverview() {
    return api('/system/algorithms').then(function (d) {
      var missing = missingFields(d, REQUIRED.overview);
      if (!missing.length && d.state === 'READY' && (!d.totals || !d.monitoring)) missing = ['totals', 'monitoring'].filter(function (k) { return !d[k]; });
      if (missing.length) { AL.data = null; AL.error = contractError('/system/algorithms', missing); return; }
      if (d.reason && d.state === 'READY') d.reason = null;
      AL.data = d; AL.error = null;
    }).catch(function (e) { AL.error = e.message; });
  }

  function loadMonitoring() {
    return api('/system/algorithms/monitoring').then(function (d) {
      var missing = missingFields(d, REQUIRED.monitoring);
      if (missing.length) { AL.mon = null; AL.monError = contractError('/system/algorithms/monitoring', missing); return; }
      // Optional by design: present or null, never absent.
      if (d.reason === undefined) { AL.mon = null; AL.monError = contractError('/system/algorithms/monitoring', ['reason']); return; }
      AL.mon = d; AL.monError = null;
    }).catch(function (e) { AL.monError = e.message; });
  }

  function loadAlgorithmMonitoring(key) {
    AL.monDetailError = null;
    return api('/system/algorithms/' + encodeURIComponent(key) + '/monitoring').then(function (d) {
      var missing = missingFields(d, REQUIRED.production);
      if (!missing.length) {
        missing = ['firstSeenAt', 'lastFailureAt', 'lastFailureKind', 'distribution', 'quality', 'freshness']
          .filter(function (k) { return d[k] === undefined; });
      }
      if (missing.length) { AL.monDetail = null; AL.monDetailError = contractError('/system/algorithms/' + key + '/monitoring', missing); return; }
      AL.monDetail = d;
    }).catch(function (e) { AL.monDetail = null; AL.monDetailError = e.message; });
  }

  function loadLearning() {
    return api('/system/algorithms/learning').then(function (d) {
      var missing = missingFields(d, REQUIRED.learning);
      // The two lanes are facts, not decoration: a response that does not say
      // which is synthetic and that the real world is disabled is refused.
      if (!missing.length && (!d.evidence || d.evidence.synthetic !== 'SYNTHETIC' || d.evidence.realWorld !== 'DISABLED')) missing = ['evidence'];
      if (missing.length) { AL.learn = null; AL.learnError = contractError('/system/algorithms/learning', missing); return; }
      AL.learn = d; AL.learnError = null;
    }).catch(function (e) { AL.learnError = e.message; });
  }

  function loadAlgorithmLearning(key) {
    AL.learnDetailError = null;
    return api('/system/algorithms/' + encodeURIComponent(key) + '/learning').then(function (d) {
      var missing = missingFields(d, REQUIRED.learnDetail);
      if (!missing.length) missing = ['derivedFrom', 'notice', 'synthetic'].filter(function (k) { return d[k] === undefined; });
      if (!missing.length && d.synthetic && d.synthetic.evidence !== 'SYNTHETIC') missing = ['synthetic.evidence'];
      if (missing.length) { AL.learnDetail = null; AL.learnDetailError = contractError('/system/algorithms/' + key + '/learning', missing); return; }
      AL.learnDetail = d;
    }).catch(function (e) { AL.learnDetail = null; AL.learnDetailError = e.message; });
  }

  function loadCandidates() {
    return api('/system/algorithms/candidates').then(function (d) {
      var missing = missingFields(d, REQUIRED.candidates);
      if (!missing.length) missing = ['reason', 'generatedAt', 'spec'].filter(function (k) { return d[k] === undefined; });
      // What a candidate is, is a fact: a response that does not say its results
      // are synthetic and never ran in production is refused.
      if (!missing.length && (d.evidence !== 'SYNTHETIC' || d.production !== 'NEVER_RUN')) missing = ['evidence', 'production'];
      if (missing.length) { AL.cand = null; AL.candError = contractError('/system/algorithms/candidates', missing); return; }
      AL.cand = d; AL.candError = null;
    }).catch(function (e) { AL.candError = e.message; });
  }

  function loadReleases() {
    return api('/system/algorithms/releases').then(function (d) {
      var missing = missingFields(d, REQUIRED.releases);
      // Whether a deploy was requested or is live is not known to this server: a response that claims otherwise is refused.
      if (!missing.length && (d.deploy.requested !== 'NOT_KNOWN_HERE' || d.deploy.live !== 'NOT_KNOWN_HERE')) missing = ['deploy'];
      if (missing.length) { AL.rel = null; AL.relError = contractError('/system/algorithms/releases', missing); return; }
      AL.rel = d; AL.relError = null;
    }).catch(function (e) { AL.relError = e.message; });
  }

  function loadCandidate(id) {
    AL.candDetailError = null;
    return api('/system/algorithms/candidates/' + encodeURIComponent(id)).then(function (d) {
      var missing = missingFields(d, REQUIRED.candidate);
      if (!missing.length && (d.deployable !== false || d.evidence !== 'SYNTHETIC' || d.production !== 'NEVER_RUN')) missing = ['deployable', 'evidence', 'production'];
      if (missing.length) { AL.candDetail = null; AL.candDetailError = contractError('/system/algorithms/candidates/' + id, missing); return; }
      AL.candDetail = d;
    }).catch(function (e) { AL.candDetail = null; AL.candDetailError = e.message; });
  }

  function loadAlgorithm(key) {
    AL.detailError = null;
    return api('/system/algorithms/' + encodeURIComponent(key)).then(function (d) {
      var missing = missingFields(d, REQUIRED.detail);
      if (missing.length) { AL.detail = null; AL.detailError = contractError('/system/algorithms/' + key, missing); return; }
      if (d.notSimulatedBecause === undefined || d.approval === undefined) { AL.detail = null; AL.detailError = contractError('/system/algorithms/' + key, ['notSimulatedBecause', 'approval']); return; }
      AL.detail = d;
    }).catch(function (e) { AL.detail = null; AL.detailError = e.message; });
  }

  // ── paint ─────────────────────────────────────────────────────────────────

  function paint(host) {
    if (!host) return;
    host.setAttribute('dir', AL_DIR);
    host.setAttribute('lang', AL_LANG);
    host.innerHTML = '<div class="al-shell">' + railHtml()
      + '<main class="al-main">' + topHtml() + '<div class="al-body" id="al-body">' + contentHtml() + '</div></main></div>';
  }

  /** Repaint the body, the top bar and the rail — never the shell, so nothing under the reader moves. */
  function repaintBody(host, keepScroll) {
    var body = host.querySelector('#al-body');
    if (!body) return paint(host);
    var y = keepScroll ? body.scrollTop : 0;
    body.innerHTML = contentHtml();
    body.scrollTop = y;
    var top = host.querySelector('.al-top');
    if (top) top.outerHTML = topHtml();
    var rail = host.querySelector('.al-rail');
    if (rail) rail.outerHTML = railHtml();
  }

  function go(host, section) {
    AL.section = section;
    repaintBody(host, false);
  }

  function openAlgorithm(host, key) {
    AL.section = 'algorithm';
    AL.key = key;
    if (!AL.detail || AL.detail.key !== key) AL.detail = null;
    if (!AL.monDetail || AL.monDetail.key !== key) AL.monDetail = null;
    if (!AL.learnDetail || AL.learnDetail.key !== key) AL.learnDetail = null;
    AL.detailError = null;
    AL.monDetailError = null;
    AL.learnDetailError = null;
    AL.learnScenario = 'consistent';
    repaintBody(host, false);
    // Three reads, drawn as each answers: the definition never waits on the
    // telemetry store or on learning, and none of them waits on another.
    var redraw = function () { if (AL.section === 'algorithm' && AL.key === key) repaintBody(host, true); };
    loadAlgorithm(key).then(redraw);
    loadAlgorithmMonitoring(key).then(redraw);
    loadAlgorithmLearning(key).then(redraw);
  }

  function openCandidate(host, id) {
    AL.section = 'candidate';
    AL.candId = id;
    if (!AL.candDetail || AL.candDetail.id !== id) AL.candDetail = null;
    AL.candDetailError = null;
    AL.candTab = 'change';
    repaintBody(host, false);
    loadCandidate(id).then(function () { if (AL.section === 'candidate' && AL.candId === id) repaintBody(host, true); });
  }

  function refresh(host) {
    if (AL.refreshing) return;
    AL.refreshing = true;
    repaintBody(host, true);
    var jobs = [loadOverview(), loadMonitoring(), loadLearning(), loadCandidates(), loadReleases()];
    if (AL.section === 'algorithm' && AL.key) jobs.push(loadAlgorithm(AL.key), loadAlgorithmMonitoring(AL.key), loadAlgorithmLearning(AL.key));
    if (AL.section === 'candidate' && AL.candId) jobs.push(loadCandidate(AL.candId));
    Promise.all(jobs).then(function () { AL.refreshing = false; repaintBody(host, true); });
  }

  /** Switch a scenario tab by toggling classes only: no repaint, so nothing else can move. */
  function selectScenario(host, id) {
    AL.learnScenario = id;
    Array.prototype.forEach.call(host.querySelectorAll('[data-al-scn]'), function (b) {
      var on = b.getAttribute('data-al-scn') === id;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(host.querySelectorAll('[data-al-scn-body]'), function (p) {
      var on = p.getAttribute('data-al-scn-body') === id;
      p.classList.toggle('is-on', on);
      if (on) p.removeAttribute('aria-hidden'); else p.setAttribute('aria-hidden', 'true');
    });
  }

  /** Switch a candidate tab by toggling classes only: no repaint, so nothing else can move. */
  function selectCandTab(host, k) {
    AL.candTab = k;
    Array.prototype.forEach.call(host.querySelectorAll('[data-al-ctab]'), function (b) {
      var on = b.getAttribute('data-al-ctab') === k;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(host.querySelectorAll('[data-al-ctab-body]'), function (p) {
      var on = p.getAttribute('data-al-ctab-body') === k;
      p.classList.toggle('is-on', on);
      if (on) p.removeAttribute('aria-hidden'); else p.setAttribute('aria-hidden', 'true');
    });
  }

  function closeLangs(host) {
    AL.langOpen = false;
    var box = host.querySelector('.al-langs');
    if (box) box.classList.remove('is-open');
    var pick = host.querySelector('[data-al-langs]');
    if (pick) pick.setAttribute('aria-expanded', 'false');
  }

  // ── events ────────────────────────────────────────────────────────────────

  function bind(host) {
    if (host.__alBound) return;
    host.__alBound = true;

    host.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;

      if (t.closest('[data-al-home]')) { try { window.navTo('owner-home'); } catch (_) {} return; }

      if (t.closest('[data-al-langs]')) {
        AL.langOpen = !AL.langOpen;
        var box = host.querySelector('.al-langs');
        if (box) box.classList.toggle('is-open', AL.langOpen);
        t.closest('[data-al-langs]').setAttribute('aria-expanded', AL.langOpen ? 'true' : 'false');
        return;
      }
      var lang = t.closest('[data-al-lang]');
      if (lang) {
        AL.langOpen = false;
        setLocale(lang.getAttribute('data-al-lang')).then(function () {
          var body = host.querySelector('#al-body');
          var y = body ? body.scrollTop : 0;
          paint(host);
          var again = host.querySelector('#al-body');
          if (again) again.scrollTop = y;
        });
        return;
      }
      if (AL.langOpen && !t.closest('.al-langs')) closeLangs(host);

      var scn = t.closest('[data-al-scn]');
      if (scn) { selectScenario(host, scn.getAttribute('data-al-scn')); return; }

      var ctab = t.closest('[data-al-ctab]');
      if (ctab) { selectCandTab(host, ctab.getAttribute('data-al-ctab')); return; }

      var cand = t.closest('[data-al-cand]');
      if (cand) { openCandidate(host, cand.getAttribute('data-al-cand')); return; }

      var open = t.closest('[data-al-open]');
      if (open) { openAlgorithm(host, open.getAttribute('data-al-open')); return; }

      var nav = t.closest('[data-al-nav]');
      if (nav) { go(host, nav.getAttribute('data-al-nav')); return; }

      if (t.closest('[data-al-refresh]')) { refresh(host); return; }
    });

    host.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (AL.langOpen) { closeLangs(host); return; }
      if (AL.section === 'algorithm') go(host, 'registry');
      else if (AL.section === 'candidate') go(host, 'proposals');
    });
  }

  // ── mount ─────────────────────────────────────────────────────────────────

  window.renderFamilistaAlgorithms = function (host) {
    // The page-render registry calls every renderer with NO argument, and the
    // navigation switch calls this one with the root element. Both must work.
    host = host || document.getElementById('al-root');
    if (!host) return;
    bind(host);
    setLocale(initialLocale()).then(function () {
      paint(host);
      // The overview first — it needs no database — and production monitoring
      // beside it; whichever answers second repaints the body, not the shell.
      loadMonitoring().then(function () { if (AL.data || AL.error) repaintBody(host, true); });
      loadLearning().then(function () { if (AL.data || AL.error) repaintBody(host, true); });
      loadCandidates().then(function () { if (AL.data || AL.error) repaintBody(host, true); });
      loadReleases().then(function () { if (AL.data || AL.error) repaintBody(host, true); });
      return loadOverview();
    }).then(function () { paint(host); });
  };

  window.teardownFamilistaAlgorithms = function () {
    // No stream or timer of its own. The open algorithm and the language menu
    // are dropped so the room opens clean next time.
    AL.section = 'overview'; AL.key = null; AL.detail = null; AL.detailError = null; AL.langOpen = false;
    AL.monDetail = null; AL.monDetailError = null;
    AL.learnDetail = null; AL.learnDetailError = null; AL.learnScenario = 'consistent';
    AL.candDetail = null; AL.candDetailError = null; AL.candId = null; AL.candTab = 'change';
  };

  // Exposed for the test suite, which asserts the vocabulary rather than a render.
  window.__familistaAlgorithmsGateKind = gateKind;
  window.__familistaAlgorithmsMonKind = monKind;
  window.__familistaAlgorithmsMethodKind = methodKind;
  window.__familistaAlgorithmsWriteKind = writeKind;
  window.__familistaAlgorithmsCandTestKind = candTestKind;
  window.__familistaAlgorithmsOutcomeKind = outcomeKind;
  window.__familistaAlgorithmsRunKind = runKind;
}());
