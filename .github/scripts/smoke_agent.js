#!/usr/bin/env node
'use strict';

/**
 * In-container smoke gate for token-monitor-agent.
 * Runs under unprivileged user, read-only root, tmpfs /tmp, network none.
 *
 * Verifies:
 * 1. Host vs Container Node version distinction.
 * 2. Timezone data availability (/usr/share/zoneinfo/Asia/Shanghai) and TZ=Asia/Shanghai offset.
 * 3. Safe image default configuration values (clients=hermes, limits=0, watch=0, interval=300000, uid=1000).
 * 4. Token Monitor agent execution (--once --dry-run) without credentials/network.
 * 5. Tokscale token contract:
 *    input 1000, output 400 (additive output 250 + reasoning 150), cache_read 200, cache_write 50
 *    -> total 1650, output 400, actual cost 1.25.
 * 6. Profile fixture auto-discovery & log-driven cross-day boundary splitting under TZ=Asia/Shanghai.
 * 7. The real agent stamps the windows it publishes with the process calendar
 *    (periodWindows.timeZone).
 * 8. Persistence regression against the image's own collector/anchor/daily-archive
 *    code with injected scanner results: a same-calendar restart reuses the saved
 *    anchor, a timezone change forces a full scan, both calendars stay retained
 *    with their own dates and tokens, and allTime is not summed twice.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

// Test-only escape hatch for running this gate against a source checkout (the
// pinned upstream tree) instead of the image. The Docker wrapper never sets it,
// so the in-image gate keeps its /app contract and image-only assertions.
const APP_ROOT = path.resolve(process.env.OVERLAY_SMOKE_APP_ROOT || '/app');
const SOURCE_MODE = Boolean(process.env.OVERLAY_SMOKE_APP_ROOT);
const AGENT_BIN = path.join(APP_ROOT, 'src/agent/agent.js');
const TOKSCALE_BIN = path.join(APP_ROOT, 'node_modules/@tokscale/cli-linux-x64-gnu/bin/tokscale');

// Worker mode is selected by argv rather than by a second file because the
// Docker gate mounts exactly one script. Each probe step is a fresh process so
// neither module caches nor a TZ switch can masquerade as a restart.
const PROBE_FLAG = '--persistence-probe';
const PROBE_RESULT_PREFIX = '[smoke][probe] RESULT ';
const PROBE_STEP_TIMEOUT_MS = 60000;
const PROBE_IDLE_TIMEOUT_MS = 30000;
const PROBE_FIXED_NOW = '2035-01-01T18:00:00Z';
// The worker freezes Date as well as the collector's injectable clock. Anchor
// trust uses new Date(), so injecting options.now alone would not make restart
// reuse deterministic. Real timeout timers are deliberately left untouched.
const PROBE_SCENARIOS = [{
  name: 'fixed-calendar',
  now: PROBE_FIXED_NOW,
  steps: [
    {
      name: 'full-scan-shanghai',
      timeZone: 'Asia/Shanghai',
      expectedCalendarKey: 'Asia/Shanghai|-480',
      expectedTodayKey: '2035-01-02',
      expectedScanFlags: ['--today', '--month', '--since'],
    },
    {
      name: 'restart-same-calendar',
      timeZone: 'Asia/Shanghai',
      expectedCalendarKey: 'Asia/Shanghai|-480',
      expectedTodayKey: '2035-01-02',
      // One scan proves the saved anchor was reused instead of rescanned.
      expectedScanFlags: ['--today'],
    },
    {
      name: 'restart-same-offset-calendar',
      timeZone: 'Asia/Taipei',
      expectedCalendarKey: 'Asia/Taipei|-480',
      expectedTodayKey: '2035-01-02',
      // Same day and offset: calendar identity alone must invalidate the anchor.
      expectedScanFlags: ['--today', '--month', '--since'],
    },
    {
      name: 'restart-los-angeles',
      timeZone: 'America/Los_Angeles',
      expectedCalendarKey: 'America/Los_Angeles|480',
      expectedTodayKey: '2035-01-01',
      expectedScanFlags: ['--today', '--month', '--since'],
    },
  ],
}];

if (process.argv[2] === PROBE_FLAG) {
  runPersistenceProbe().catch((error) => {
    console.error(`[smoke][probe] FAILED: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  });
  // CommonJS top-level return: this process runs the probe worker only.
  return;
}

console.log(`[smoke] Node runtime: ${process.version}`);
if (SOURCE_MODE) console.log(`[smoke] Source mode: app root ${APP_ROOT} (image-only checks skipped)`);

// 1. Assert timezone database is installed and readable (image contract)
if (!SOURCE_MODE) {
  const tzFile = '/usr/share/zoneinfo/Asia/Shanghai';
  assert(
    fs.existsSync(tzFile),
    `Missing ${tzFile} — tzdata package must be installed in image to prevent timezone drift.`
  );
  fs.accessSync(tzFile, fs.constants.R_OK);
  console.log(`[smoke] Verified timezone database exists and is readable: ${tzFile}`);
}

// 2. Assert TZ=Asia/Shanghai (chosen test value, not image default) takes effect
process.env.TZ = 'Asia/Shanghai';
const resolvedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
assert.strictEqual(
  resolvedTz,
  'Asia/Shanghai',
  `Expected resolved timezone Asia/Shanghai, got ${resolvedTz}`
);
const sampleDate = new Date('2026-10-23T00:00:00Z');
assert.strictEqual(
  sampleDate.getHours(),
  8,
  `Expected UTC+8 08:00 for 00:00Z under Asia/Shanghai, got ${sampleDate.getHours()}`
);
assert.strictEqual(
  sampleDate.getTimezoneOffset(),
  -480,
  `Expected timezone offset -480 for Asia/Shanghai, got ${sampleDate.getTimezoneOffset()}`
);
console.log('[smoke] Verified TZ=Asia/Shanghai is active (UTC+8, offset -480)');

// 3. Assert default safe values from image environment
// Do NOT write these into env; verify that image defaults have not regressed.
// A source run has no image defaults or uid 1000 contract, so it skips them and
// only hands the same documented values to its child processes.
const SAFE_DEFAULTS = {
  TOKEN_MONITOR_CLIENTS: 'hermes',
  TOKEN_MONITOR_LIMITS_ENABLED: '0',
  TOKEN_MONITOR_SYNC_SESSION_TITLES: '0',
  TOKEN_MONITOR_WATCH: '0',
  TOKEN_MONITOR_INTERVAL_MS: '300000',
};
if (!SOURCE_MODE) {
  for (const [key, val] of Object.entries(SAFE_DEFAULTS)) {
    assert.strictEqual(process.env[key], val, `Expected default ${key}=${val}`);
  }
  if (typeof process.getuid === 'function') {
    assert.strictEqual(process.getuid(), 1000, `Expected uid 1000, got ${process.getuid()}`);
  }
  console.log('[smoke] Verified safe image defaults and uid 1000');
}

// Helpers: DB fixture creation and child process execution with JSON parsing
function initDb(dbPath, sessionRow, usageRow) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, billing_provider TEXT,
        started_at REAL, message_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        actual_cost_usd REAL, estimated_cost_usd REAL
      );
      CREATE TABLE session_model_usage (
        session_id TEXT, model TEXT, billing_provider TEXT, input_tokens INTEGER,
        output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        reasoning_tokens INTEGER, actual_cost_usd REAL, estimated_cost_usd REAL
      );
    `);
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...sessionRow);
    db.prepare('INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?)').run(...usageRow);
  } finally {
    db.close();
  }
}

function runJSON(bin, args, env, timeout = 30000) {
  const res = spawnSync(bin, args, { env, encoding: 'utf8', timeout });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${bin} exited ${res.status}:\n${res.stderr || res.stdout}`);
  }
  const out = res.stdout.trim();
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? out.slice(start, end + 1) : out);
}

// 3. Isolated scratch environment & cache
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-agent-'));
try {
  const dirs = {
    home: path.join(tempRoot, 'home'),
    hermes: path.join(tempRoot, 'hermes'),
    config: path.join(tempRoot, 'config'),
    data: path.join(tempRoot, 'data'),
    cache: path.join(tempRoot, 'cache'),
    shared: path.join(tempRoot, 'shared'),
    tokscaleConfig: path.join(tempRoot, 'config', 'tokscale'),
    pricingCache: path.join(tempRoot, 'config', 'tokscale', 'cache'),
    crossday: path.join(tempRoot, 'hermes', 'profiles', 'crossday'),
    crossdayLogs: path.join(tempRoot, 'hermes', 'profiles', 'crossday', 'logs'),
  };
  for (const dir of Object.values(dirs)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const emptyPricing = JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), data: {} });
  for (const f of ['pricing-litellm.json', 'pricing-openrouter.json', 'pricing-models-dev.json']) {
    fs.writeFileSync(path.join(dirs.pricingCache, f), emptyPricing);
  }

  // 4. Fixtures: primary Hermes contract & profile cross-day DB + logs
  initDb(
    path.join(dirs.hermes, 'state.db'),
    ['hermes-contract', 'cli', 'claude-sonnet-4-5', 'anthropic', 1787196900, 1, 1000, 400, 200, 50, 150, 1.25, 1.25],
    ['hermes-contract', 'claude-sonnet-4-5', 'anthropic', 1000, 400, 200, 50, 150, 1.25, 1.25]
  );
  initDb(
    path.join(dirs.crossday, 'state.db'),
    ['session-cross-day', 'desktop', 'glm-5.2', 'zai', 1775088000.0, 2, 1400, 500, 3600, 0, 0, 1.0, 1.0],
    ['session-cross-day', 'glm-5.2', 'zai', 1400, 500, 3600, 0, 0, 1.0, 1.0]
  );

  const logLines = [
    '2026-04-01 23:30:00,000 INFO [session-cross-day] agent.conversation_loop: API call #1: model=glm-5.2 provider=zai in=1000 out=100 total=1100 latency=1.0s cache=800/1000 (50%) id=gen-1',
    '2026-04-01 23:45:00,000 INFO [session-cross-day] agent.conversation_loop: API call #2: model=glm-5.2 provider=zai in=1000 out=100 total=1100 latency=1.0s cache=800/1000 (50%) id=gen-2',
    '2026-04-02 00:15:00,000 INFO [session-cross-day] agent.conversation_loop: API call #3: model=glm-5.2 provider=zai in=3000 out=300 total=3300 latency=1.0s cache=2000/3000 (50%) id=gen-3',
  ];
  fs.writeFileSync(path.join(dirs.crossdayLogs, 'agent.log'), logLines.join('\n') + '\n', 'utf8');

  // 5. Strict whitelisted environment for child processes
  const childEnv = {
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    TZ: 'Asia/Shanghai',
    // Image mode asserted these defaults above; source mode passes the same
    // documented values so the agent contract runs without an image env.
    TOKEN_MONITOR_CLIENTS: process.env.TOKEN_MONITOR_CLIENTS ?? SAFE_DEFAULTS.TOKEN_MONITOR_CLIENTS,
    TOKEN_MONITOR_LIMITS_ENABLED: process.env.TOKEN_MONITOR_LIMITS_ENABLED ?? SAFE_DEFAULTS.TOKEN_MONITOR_LIMITS_ENABLED,
    TOKEN_MONITOR_SYNC_SESSION_TITLES: process.env.TOKEN_MONITOR_SYNC_SESSION_TITLES ?? SAFE_DEFAULTS.TOKEN_MONITOR_SYNC_SESSION_TITLES,
    TOKEN_MONITOR_WATCH: process.env.TOKEN_MONITOR_WATCH ?? SAFE_DEFAULTS.TOKEN_MONITOR_WATCH,
    TOKEN_MONITOR_INTERVAL_MS: process.env.TOKEN_MONITOR_INTERVAL_MS ?? SAFE_DEFAULTS.TOKEN_MONITOR_INTERVAL_MS,
    HOME: dirs.home,
    HERMES_HOME: dirs.hermes,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    TOKEN_MONITOR_SHARED_DIR: dirs.shared,
    TOKSCALE_CONFIG_DIR: dirs.tokscaleConfig,
    TOKSCALE_PRICING_CACHE_ONLY: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    all_proxy: 'http://127.0.0.1:9',
  };

  // 6. Execute agent dry-run: token-bucket + stored-cost contract verification
  assert(fs.existsSync(AGENT_BIN), `Missing ${AGENT_BIN}`);
  const summary = runJSON(process.execPath, [AGENT_BIN, '--once', '--dry-run'], childEnv, 60000);
  // The Hub expires today/month against the calendar the agent stamps here, so
  // the published windows must name the process timezone, not a default.
  assert.strictEqual(
    summary?.periodWindows?.timeZone,
    'Asia/Shanghai',
    `Expected agent periodWindows.timeZone Asia/Shanghai, got ${summary?.periodWindows?.timeZone}`
  );
  console.log('[smoke] Verified agent periodWindows.timeZone=Asia/Shanghai');
  const hermesSession = summary?.allTime?.sessions?.['hermes:hermes-contract'];
  assert(hermesSession, 'Expected hermes:hermes-contract in agent summary');
  assert.strictEqual(hermesSession.totalTokens, 1650);
  assert.strictEqual(hermesSession.outputTokens, 400);
  assert.strictEqual(hermesSession.reasoningTokens, 150);
  assert.strictEqual(hermesSession.costUsd ?? hermesSession.cost, 1.25);
  console.log('[smoke] Verified agent token-bucket + stored-cost contract: total=1650, output=400, reasoning=150, cost=1.25');

  // 7. Verify tokscale CLI contract session
  assert(fs.existsSync(TOKSCALE_BIN), `Missing ${TOKSCALE_BIN}`);
  const tokData = runJSON(
    TOKSCALE_BIN,
    ['--json', '--client', 'hermes', '--group-by', 'client,session,model', '--no-spinner'],
    childEnv
  );
  const contractEntry = tokData.entries?.find((e) => e.sessionId === 'hermes-contract');
  assert(contractEntry, 'Expected entry for hermes-contract in tokscale');
  assert.strictEqual(contractEntry.input, 1000);
  assert.strictEqual(contractEntry.output, 250);
  assert.strictEqual(contractEntry.reasoning, 150);
  assert.strictEqual(contractEntry.cacheRead, 200);
  assert.strictEqual(contractEntry.cacheWrite, 50);
  assert.strictEqual(contractEntry.cost, 1.25);
  const total = contractEntry.input + contractEntry.output + contractEntry.reasoning +
    contractEntry.cacheRead + contractEntry.cacheWrite;
  assert.strictEqual(total, 1650);
  console.log('[smoke] Verified tokscale contract entry: input=1000, output=250, reasoning=150, cacheRead=200, cacheWrite=50, total=1650, cost=1.25');

  // 8. Cross-day exact totals & profile discovery (no double-billing) via fixed CLI date filters
  const day1 = runJSON(
    TOKSCALE_BIN,
    ['--json', '--client', 'hermes', '--since', '2026-04-01', '--until', '2026-04-01', '--no-spinner'],
    childEnv
  );
  const day1Tokens = (day1.totalInput || 0) + (day1.totalOutput || 0) +
    (day1.totalCacheRead || 0) + (day1.totalCacheWrite || 0);
  assert.strictEqual(day1Tokens, 2200, `Expected 2026-04-01 tokens 2200, got ${day1Tokens}`);
  assert.strictEqual(day1.totalCost, 0.4, `Expected 2026-04-01 cost 0.4, got ${day1.totalCost}`);

  const day2 = runJSON(
    TOKSCALE_BIN,
    ['--json', '--client', 'hermes', '--since', '2026-04-02', '--until', '2026-04-02', '--no-spinner'],
    childEnv
  );
  const day2Tokens = (day2.totalInput || 0) + (day2.totalOutput || 0) +
    (day2.totalCacheRead || 0) + (day2.totalCacheWrite || 0);
  assert.strictEqual(day2Tokens, 3300, `Expected 2026-04-02 tokens 3300, got ${day2Tokens}`);
  assert.strictEqual(day2.totalCost, 0.6, `Expected 2026-04-02 cost 0.6, got ${day2.totalCost}`);

  const range = runJSON(
    TOKSCALE_BIN,
    ['--json', '--client', 'hermes', '--since', '2026-04-01', '--until', '2026-04-02', '--no-spinner'],
    childEnv
  );
  const rangeTokens = (range.totalInput || 0) + (range.totalOutput || 0) +
    (range.totalCacheRead || 0) + (range.totalCacheWrite || 0);
  assert.strictEqual(rangeTokens, 5500, `Expected range tokens 5500, got ${rangeTokens}`);
  assert.strictEqual(range.totalCost, 1.0, `Expected range cost 1.0, got ${range.totalCost}`);

  console.log('[smoke] Verified cross-day exact totals: 2026-04-01=2200, 2026-04-02=3300, total=5500, cost=1.0 (no double-billing)');

  // 9. Persistence regression against the app root's own collector, anchor and
  // daily-archive code. Scanner results are injected (this is calendar/anchor/
  // archive logic coverage, not a real-binary scan) and every path is scratch.
  runPersistenceProbeSuite(tempRoot);

  console.log('[smoke] All smoke checks passed successfully!');
} finally {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Persistence regression probe
//
// The collector under test is the app root's own v0.89.0 code. Scanner results
// are injected through the collector's runTokscale/runGraph seams, so nothing
// here reaches the network or a real client store; what is exercised for real
// is the filesystem persistence: collector-anchor.json, the calendar-scoped
// daily history archive, and the restart/reuse path across separate processes.
// Scenario tables live with the other probe constants at the top of the file so
// the image-mode run can reach them; the helpers stay here.
// ---------------------------------------------------------------------------

function runPersistenceProbeSuite(tempRoot) {
  const runs = PROBE_SCENARIOS.map((scenario) => ({
    scenario,
    results: scenario.steps.map((step) => runProbeStep(tempRoot, scenario, step)),
  }));
  const byName = Object.fromEntries(runs.map((run) => [run.scenario.name, run.results]));

  for (const { scenario, results } of runs) {
    for (const result of results) {
      const label = `${scenario.name}/${result.step}`;
      // Nothing may land in a default OS location: every persisted path is scratch.
      assert.ok(
        path.resolve(result.anchorPath).startsWith(path.resolve(result.scratchRoot)),
        `${label}: anchor escaped the scratch root: ${result.anchorPath}`
      );
      assert.ok(
        path.resolve(result.archivePath).startsWith(path.resolve(result.scratchRoot)),
        `${label}: daily archive escaped the scratch root: ${result.archivePath}`
      );
      assert.deepEqual(result.errors, [], `${label}: collector reported errors`);
      assert.strictEqual(result.totals.allTime, 1000, `${label}: allTime must not be summed twice across calendars`);
    }
  }

  const [full, restart, sameOffset, moved] = byName['fixed-calendar'];
  assert.deepEqual(
    full.archive.calendars,
    { 'Asia/Shanghai': { '2035-01-02': 100 } },
    'the first full scan must retain exactly the Shanghai calendar'
  );
  assert.deepEqual(
    restart.archive.calendars,
    full.archive.calendars,
    'a same-calendar restart must not add a calendar or grow the retained day'
  );
  assert.strictEqual(
    restart.anchor.fullScanAt,
    full.anchor.fullScanAt,
    'the restart must reuse the saved anchor instead of rescanning'
  );
  assert.strictEqual(sameOffset.todayKey, full.todayKey, 'a same-offset calendar change must not move the local day');
  assert.notStrictEqual(sameOffset.anchor.calendarKey, full.anchor.calendarKey, 'the anchor must bind to the new calendar');
  assert.strictEqual(
    sameOffset.anchor.calendarKey.split('|')[1],
    full.anchor.calendarKey.split('|')[1],
    'the isolating calendar change keeps the same UTC offset, so only the calendar identity differs'
  );
  const sameDayCalendars = {
    'Asia/Shanghai': { '2035-01-02': 100 },
    'Asia/Taipei': { '2035-01-02': 100 },
  };
  assert.deepEqual(sameOffset.archive.calendars, sameDayCalendars, 'both same-offset calendars must retain their own tokens');
  assert.deepEqual(
    moved.archive.calendars,
    { ...sameDayCalendars, 'America/Los_Angeles': { '2035-01-01': 100 } },
    'a calendar change must keep previous calendars, each with its own date and tokens'
  );
  console.log(
    '[smoke] Verified persistence: same-calendar restart reused the anchor (1 scan, capture time unchanged), '
    + 'a calendar change forced a full scan while keeping both calendars, and allTime stayed at 1000'
  );
}

function runProbeStep(tempRoot, scenario, step) {
  const scratchRoot = path.join(tempRoot, 'persistence-probe', scenario.name);
  const dirs = {
    home: path.join(scratchRoot, 'home'),
    hermes: path.join(scratchRoot, 'hermes'),
    config: path.join(scratchRoot, 'config'),
    data: path.join(scratchRoot, 'data'),
    cache: path.join(scratchRoot, 'cache'),
    shared: path.join(scratchRoot, 'shared'),
    tokscaleConfig: path.join(scratchRoot, 'config', 'tokscale'),
    pricingCache: path.join(scratchRoot, 'config', 'tokscale', 'cache'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  // Written once per scenario with fixed content: catalogRevision hashes the
  // file mtime, so rewriting it per step would change the pricing revision and
  // invalidate the anchor between steps.
  const emptyPricing = JSON.stringify({ timestamp: 0, data: {} });
  for (const file of ['pricing-litellm.json', 'pricing-openrouter.json', 'pricing-models-dev.json']) {
    const target = path.join(dirs.pricingCache, file);
    if (!fs.existsSync(target)) fs.writeFileSync(target, emptyPricing);
  }

  const request = {
    timeZone: step.timeZone,
    now: scenario.now,
    expectedCalendarKey: step.expectedCalendarKey || null,
    expectedTodayKey: step.expectedTodayKey || null,
    expectedScanFlags: step.expectedScanFlags,
  };
  const res = spawnSync(process.execPath, [__filename, PROBE_FLAG], {
    env: probeChildEnv(dirs, request),
    encoding: 'utf8',
    timeout: PROBE_STEP_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (res.error) throw new Error(`persistence probe ${scenario.name}/${step.name} failed to run: ${res.error.message}`);
  assert.strictEqual(
    res.status,
    0,
    `persistence probe ${scenario.name}/${step.name} exited ${res.status}:\n${res.stderr || res.stdout}`
  );
  const line = String(res.stdout || '').split('\n').find((entry) => entry.startsWith(PROBE_RESULT_PREFIX));
  assert.ok(line, `persistence probe ${scenario.name}/${step.name} printed no result:\n${res.stdout}\n${res.stderr}`);
  return { ...JSON.parse(line.slice(PROBE_RESULT_PREFIX.length)), scenario: scenario.name, step: step.name, scratchRoot };
}

// Allowlisted child environment: only the paths this probe owns, plus a
// loopback dead proxy so an accidental network attempt fails fast instead of
// reaching a real host. No ambient host environment is inherited.
function probeChildEnv(dirs, request) {
  const env = {
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    TZ: request.timeZone,
    HOME: dirs.home,
    HERMES_HOME: dirs.hermes,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    TOKEN_MONITOR_SHARED_DIR: dirs.shared,
    TOKSCALE_CONFIG_DIR: dirs.tokscaleConfig,
    TOKSCALE_PRICING_CACHE_ONLY: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    all_proxy: 'http://127.0.0.1:9',
    OVERLAY_SMOKE_PROBE: JSON.stringify(request),
  };
  if (SOURCE_MODE) env.OVERLAY_SMOKE_APP_ROOT = APP_ROOT;
  return env;
}

async function runPersistenceProbe() {
  const request = JSON.parse(process.env.OVERLAY_SMOKE_PROBE || 'null');
  assert.ok(request && request.timeZone, 'persistence probe worker needs OVERLAY_SMOKE_PROBE');
  assert.strictEqual(process.env.TZ, request.timeZone, 'worker TZ must be the requested calendar');
  assert.ok(process.env.TOKEN_MONITOR_SHARED_DIR, 'persistence probe worker needs a scratch shared dir');
  // The home the collector reads must be the scratch home beside that dir, so a
  // missing HOME can never send metadata reads to the operator's real home.
  const scratchRoot = path.dirname(process.env.TOKEN_MONITOR_SHARED_DIR);
  assert.strictEqual(
    path.dirname(process.env.HOME || ''),
    scratchRoot,
    `probe HOME must be ${path.join(scratchRoot, 'home')}, got ${process.env.HOME}`
  );
  // Freeze only Date before loading upstream modules. options.now alone does
  // not freeze collectorAnchorTrust's wall clock, and a real midnight would
  // correctly invalidate the anchor while making the reuse assertion fail.
  assert.ok(Number.isFinite(Date.parse(request.now)), 'probe needs a fixed ISO clock');
  const { mock } = require('node:test');
  mock.timers.enable({ apis: ['Date'], now: Date.parse(request.now) });
  const appRoot = path.resolve(process.env.OVERLAY_SMOKE_APP_ROOT || '/app');
  const collectorPath = path.join(appRoot, 'src/shared/collector.js');
  assert.ok(fs.existsSync(collectorPath), `Missing ${collectorPath}`);
  // Fresh module instance per process: a restart here is a real new process.
  const { startCollector, collectionCalendarKey, localTodayKey } = require(collectorPath);

  const fixedNow = request.now ? new Date(request.now) : new Date();
  const todayKey = localTodayKey(fixedNow);
  // Independent formatter cross-check: the stamped day must be this calendar's
  // own local date, not the host's.
  assert.strictEqual(
    todayKey,
    new Intl.DateTimeFormat('en-CA', {
      timeZone: request.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(fixedNow),
    `local day key in ${request.timeZone}`
  );
  if (request.expectedTodayKey) {
    assert.strictEqual(todayKey, request.expectedTodayKey, `fixed local day key in ${request.timeZone}`);
  }
  if (request.expectedCalendarKey) {
    assert.strictEqual(collectionCalendarKey(fixedNow), request.expectedCalendarKey, 'collection calendar key');
  }

  const usageScans = [];
  const graphScans = [];
  const observations = [];
  const errors = [];
  const usageFor = (flags) => {
    const input = flags[0] === '--today' ? 100 : flags[0] === '--month' ? 400 : 1000;
    return {
      entries: [{
        client: 'claude',
        sessionId: 'smoke-persistence-session',
        model: 'claude-opus',
        input,
        output: 0,
        cost: 0,
      }],
    };
  };
  const graphFor = () => ({
    contributions: [{
      date: todayKey,
      activeTimeMs: 0,
      clients: [{
        client: 'claude',
        modelId: 'claude-opus',
        tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
      }],
    }],
  });

  let runtime;
  try {
    runtime = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 5000,
      deviceId: 'smoke-persistence',
      agentVersion: 'smoke',
      limitsEnabled: false,
      historyEnabled: true,
      historyIntervalMs: 15 * 60 * 1000,
      watchEnabled: false,
      intervalMs: 60 * 60 * 1000,
      wslScanEnabled: false,
      projectsEnabled: false,
      codexLocalUsageEnabled: false,
      dailyHistoryArchiveEnabled: true,
      dailyHistoryArchiveWriteEnabled: true,
      anchorPersistenceEnabled: true,
      sessionActivityPolling: false,
      // Injected scans own their pricing: no pricing refresher and no timers.
      pricingCatalogTimers: { setTimeout: () => 1, clearTimeout() {} },
      now: fixedNow,
      homeDir: process.env.HOME,
      env: process.env,
      runTokscale: async (input) => {
        usageScans.push({ flags: [...input.flags], timeZone: input.timeZone });
        return usageFor(input.flags);
      },
      runGraph: async (input) => {
        graphScans.push({ timeZone: input.timeZone });
        return graphFor();
      },
      onUpdate: (summary) => { observations.push(summary); },
      onError: (error) => { errors.push(String((error && error.message) || error)); },
      logger: () => {},
    });
    await withTimeout(runtime.whenIdle(), PROBE_IDLE_TIMEOUT_MS, 'collector did not reach idle');
  } finally {
    if (runtime) runtime.stop();
  }

  // Every assertion runs after whenIdle and outside the collector's swallowed
  // onUpdate/onError callbacks, so a failure can never be silently absorbed.
  const summary = observations.at(-1);
  assert.ok(summary, 'probe collector published no summary');
  assert.deepEqual(errors, [], 'collector reported errors');
  assert.strictEqual(summary.periodWindows.timeZone, request.timeZone, 'published windows must name the process calendar');
  assert.strictEqual(summary.periodWindows.today.key, todayKey);
  assert.strictEqual(summary.today.totalTokens, 100);
  assert.strictEqual(summary.month.totalTokens, 400);
  assert.strictEqual(summary.allTime.totalTokens, 1000);
  assert.deepEqual(
    usageScans.map((scan) => scan.flags[0]),
    request.expectedScanFlags,
    `expected scans ${request.expectedScanFlags.join(' ')}, got ${usageScans.map((scan) => scan.flags.join(' ')).join(' | ')}`
  );
  assert.ok(usageScans.every((scan) => scan.timeZone === request.timeZone), 'every injected scan must be told the same calendar');
  assert.strictEqual(graphScans.length, 1, `expected one graph scan, got ${graphScans.length}`);
  assert.ok(graphScans.every((scan) => scan.timeZone === request.timeZone), 'graph scans must be told the same calendar');

  const sharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  const anchorPath = path.join(sharedDir, 'collector-anchor.json');
  const archivePath = path.join(sharedDir, 'daily-history-calendars.json');
  assert.ok(fs.existsSync(anchorPath), `missing persisted anchor ${anchorPath}`);
  assert.ok(fs.existsSync(archivePath), `missing persisted daily archive ${archivePath}`);
  const anchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
  const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  if (request.expectedCalendarKey) {
    assert.strictEqual(anchor.calendarKey, request.expectedCalendarKey, 'saved anchor must bind to the scanned calendar');
  } else {
    assert.ok(
      String(anchor.calendarKey).startsWith(`${request.timeZone}|`),
      `saved anchor must bind to ${request.timeZone}, got ${anchor.calendarKey}`
    );
  }
  assert.strictEqual(anchor.dateKey, todayKey, 'saved anchor must bind to the scanned local day');
  assert.ok(Number.isFinite(Date.parse(anchor.fullScanAt)), 'saved anchor must carry a full-scan capture time');

  const calendars = {};
  for (const [zone, scope] of Object.entries(archive.calendars || {})) {
    calendars[zone] = {};
    for (const [date, day] of Object.entries(scope.days || {})) {
      calendars[zone][date] = Object.values(day.observations || {})
        .reduce((sum, observation) => sum + Number(observation.tokens || 0), 0);
    }
  }

  console.log(PROBE_RESULT_PREFIX + JSON.stringify({
    timeZone: request.timeZone,
    clock: request.now ? 'fixed' : 'real',
    calendarKey: anchor.calendarKey,
    todayKey,
    scanFlags: usageScans.map((scan) => scan.flags.join(' ')),
    graphScans: graphScans.length,
    totals: {
      today: summary.today.totalTokens,
      month: summary.month.totalTokens,
      allTime: summary.allTime.totalTokens,
    },
    anchor: { calendarKey: anchor.calendarKey, dateKey: anchor.dateKey, fullScanAt: anchor.fullScanAt },
    archive: { calendars },
    anchorPath,
    archivePath,
    errors,
  }));
}

function withTimeout(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), deadline]);
}
