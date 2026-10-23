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
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const AGENT_BIN = '/app/src/agent/agent.js';
const TOKSCALE_BIN = '/app/node_modules/@tokscale/cli-linux-x64-gnu/bin/tokscale';

console.log(`[smoke] Node runtime: ${process.version}`);

// 1. Assert timezone database is installed and readable
const tzFile = '/usr/share/zoneinfo/Asia/Shanghai';
assert(
  fs.existsSync(tzFile),
  `Missing ${tzFile} — tzdata package must be installed in image to prevent timezone drift.`
);
fs.accessSync(tzFile, fs.constants.R_OK);
console.log(`[smoke] Verified timezone database exists and is readable: ${tzFile}`);

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
const SAFE_DEFAULTS = {
  TOKEN_MONITOR_CLIENTS: 'hermes',
  TOKEN_MONITOR_LIMITS_ENABLED: '0',
  TOKEN_MONITOR_SYNC_SESSION_TITLES: '0',
  TOKEN_MONITOR_WATCH: '0',
  TOKEN_MONITOR_INTERVAL_MS: '300000',
};
for (const [key, val] of Object.entries(SAFE_DEFAULTS)) {
  assert.strictEqual(process.env[key], val, `Expected default ${key}=${val}`);
}
if (typeof process.getuid === 'function') {
  assert.strictEqual(process.getuid(), 1000, `Expected uid 1000, got ${process.getuid()}`);
}
console.log('[smoke] Verified safe image defaults and uid 1000');

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
    TOKEN_MONITOR_CLIENTS: process.env.TOKEN_MONITOR_CLIENTS,
    TOKEN_MONITOR_LIMITS_ENABLED: process.env.TOKEN_MONITOR_LIMITS_ENABLED,
    TOKEN_MONITOR_SYNC_SESSION_TITLES: process.env.TOKEN_MONITOR_SYNC_SESSION_TITLES,
    TOKEN_MONITOR_WATCH: process.env.TOKEN_MONITOR_WATCH,
    TOKEN_MONITOR_INTERVAL_MS: process.env.TOKEN_MONITOR_INTERVAL_MS,
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

  console.log('[smoke] All smoke checks passed successfully!');
} finally {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (_) {}
}
