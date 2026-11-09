#!/usr/bin/env node
import fs_pin from "node:fs";
function requirePreviewDatabaseUrl(value) {
  if (!value) throw new Error("Set PREVIEW_DATABASE_URL before running this helper");
  const parsed = new URL(value);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("PREVIEW_DATABASE_URL must use PostgreSQL");
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!/(?:^|[_-])preview(?:[_-]|$)|(?:_test|_ci)$/i.test(database)) throw new Error("Use a dedicated preview, _test or _ci database");
  // Pin (2026-10-30): refuse to run against any DB other than the pinned preview DB (no silent drift).
  {
    let pin = process.env.MAFI_PREVIEW_DB;
    if (!pin) { try { const m = fs_pin.readFileSync(".env", "utf8").match(/^MAFI_PREVIEW_DB=(.+)$/m); if (m) pin = m[1].trim().replace(/^["']|["']$/g, ""); } catch {} }
    pin ||= "mafi_preview_20261021";
    if (pin && database !== pin) throw new Error(`Preview DB drift: PREVIEW_DATABASE_URL points at "${database}" but MAFI_PREVIEW_DB pins "${pin}"`);
    console.error(`[mafi] preview database: ${database}${pin ? " (pinned)" : " (UNPINNED)"}`);
  }
  return value;
}
/**
 * Local forever scheduler for MAFi preview automation (Windows-friendly).
 * - every 10 min: collect one-shot (MODEL forced off in collect child only)
 * - every 60 min: analyze tick (精选 path; capped; budget circuit)
 *
 * Does NOT depend on chat. Logs under .data/logs/.
 *
 *   node --env-file=.env scripts/mafi-auto-loop.mjs
 *   node --env-file=.env scripts/mafi-auto-loop.mjs --once
 *   MAFI_AUTO_ONCE=1 node --env-file=.env scripts/mafi-auto-loop.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

const repo = process.cwd();
const once = process.argv.includes("--once") || process.env.MAFI_AUTO_ONCE === "1";
const COLLECT_MS = Number(process.env.MAFI_AUTO_COLLECT_MS || 10 * 60 * 1000);
const ANALYZE_MS = Number(process.env.MAFI_AUTO_ANALYZE_MS || 60 * 60 * 1000);
// A collect run longer than this is killed (whole process tree) so a hang, e.g. a DB socket left dead by
// sleep/resume, cannot hold the lock and starve analyze. Normal runs finish in about a minute.
const COLLECT_TIMEOUT_MS = Number(process.env.MAFI_AUTO_COLLECT_TIMEOUT_MS || 8 * 60 * 1000);
/** Stagger analyze vs collect: both used to fire on the same multiples of 60m, collect won the busy lock, analyze never ran. */
const ANALYZE_OFFSET_MS = Number(process.env.MAFI_AUTO_ANALYZE_OFFSET_MS || 5 * 60 * 1000);
const ANALYZE_LIMIT = process.env.MAFI_AUTO_ANALYZE_LIMIT || "12";
const ANALYZE_REQ_CAP = process.env.MAFI_AUTO_ANALYZE_REQ_CAP || "80";
const ANALYZE_EXTRACT_CAP = process.env.MAFI_AUTO_EXTRACT_CAP || "12";

const logDir = path.join(repo, ".data", "logs");
fs.mkdirSync(logDir, { recursive: true });

function tokyoDay() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}
function loopLogPath() {
  return path.join(logDir, `auto-loop-${tokyoDay()}.log`);
}
function append(msg, obj) {
  const line = obj != null
    ? `${new Date().toISOString()} ${msg} ${JSON.stringify(obj)}`
    : `${new Date().toISOString()} ${msg}`;
  console.log(line);
  fs.appendFileSync(loopLogPath(), line + "\n");
}

const local = parseEnv(fs.readFileSync(path.join(repo, ".env"), "utf8"));
const envBase = {
  ...process.env,
  ...local,
  DATABASE_URL: requirePreviewDatabaseUrl(process.env.PREVIEW_DATABASE_URL || local.PREVIEW_DATABASE_URL),
  AIHOT_DATA_DIR: ".data/preview",
  COLLECT_ENABLED: "true",
  MODEL_CALLS_ENABLED: local.MODEL_CALLS_ENABLED === "true" ? "true" : "false",
  FEISHU_CONTENT_PUSH_ENABLED: "false",
  FEISHU_INTERNAL_ENABLED: "false",
  INDEXNOW_SUBMIT_ENABLED: "false",
};
delete envBase.PORT;

if (envBase.COLLECT_ENABLED !== "true") {
  console.error("COLLECT_ENABLED must be true");
  process.exit(2);
}

let busy = false;
let stopping = false;
let collectRuns = 0;
let analyzeRuns = 0;

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try { spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}

function runNode(script, args = [], { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--env-file-if-exists=.env", script, ...args], {
      cwd: repo,
      env: envBase,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    const onChunk = (buf) => {
      const s = buf.toString("utf8");
      out += s;
      process.stdout.write(s);
      try { fs.appendFileSync(loopLogPath(), s); } catch {}
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      append("child_timeout_kill", { script, pid: child.pid, timeoutMs });
      killTree(child.pid);
    }, timeoutMs) : null;
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, signal, out, timedOut });
    });
  });
}

async function tickCollect() {
  if (busy || stopping) return;
  busy = true;
  collectRuns += 1;
  append("collect_tick_begin", { n: collectRuns, modelStack: envBase.MODEL_CALLS_ENABLED });
  try {
    const r = await runNode("scripts/collect-mafi-auto.mjs", [], { timeoutMs: COLLECT_TIMEOUT_MS });
    append("collect_tick_end", { n: collectRuns, exit: r.code, ...(r.timedOut ? { timedOut: true } : {}) });
  } catch (e) {
    append("collect_tick_error", { message: String(e?.message ?? e).slice(0, 300) });
  } finally {
    busy = false;
    updatePidRecord({ lastCollectAt: new Date().toISOString() });
  }
}

async function tickAnalyze(retried = false) {
  if (stopping) return;
  if (busy) {
    // Collect tick owns the lock (often co-scheduled on 60m boundaries). Retry once shortly after.
    if (!retried) {
      append("analyze_tick_deferred", { reason: "busy", retryMs: 90_000 });
      setTimeout(() => { tickAnalyze(true).catch(() => {}); }, 90_000);
    } else {
      append("analyze_tick_skip", { reason: "busy_after_retry" });
    }
    return;
  }
  if (envBase.MODEL_CALLS_ENABLED !== "true") {
    append("analyze_tick_skip", { reason: "MODEL_CALLS_ENABLED!=true" });
    return;
  }
  busy = true;
  analyzeRuns += 1;
  append("analyze_tick_begin", { n: analyzeRuns, limit: ANALYZE_LIMIT, reqCap: ANALYZE_REQ_CAP });
  try {
    const r = await runNode("scripts/analyze-mafi-auto.mjs", [
      "--limit", String(ANALYZE_LIMIT),
      "--req-cap", String(ANALYZE_REQ_CAP),
      "--extract-cap", String(ANALYZE_EXTRACT_CAP),
    ]);
    append("analyze_tick_end", { n: analyzeRuns, exit: r.code });
    // After analyze: restore near-miss / AI-prefer seats when selected_fresh on listing floor is thin.
    try {
      const rr = await runNode("scripts/_restore-selected-floor.mjs");
      append("restore_selected_floor", { exit: rr.code });
    } catch (re) {
      append("restore_selected_floor_error", { message: String(re?.message ?? re).slice(0, 200) });
    }
  } catch (e) {
    append("analyze_tick_error", { message: String(e?.message ?? e).slice(0, 300) });
  } finally {
    busy = false;
    updatePidRecord({ lastAnalyzeAt: new Date().toISOString() });
  }
}

function updatePidRecord(extra = {}) {
  const pidPath = path.join(repo, ".data", "preview-pids.json");
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(pidPath, "utf8")); } catch {}
  const next = {
    ...cur,
    autoLoop: {
      pid: process.pid,
      script: "scripts/mafi-auto-loop.mjs",
      collectMs: COLLECT_MS,
      analyzeMs: ANALYZE_MS,
      analyzeLimit: Number(ANALYZE_LIMIT),
      analyzeReqCap: Number(ANALYZE_REQ_CAP),
      extractCap: Number(ANALYZE_EXTRACT_CAP),
      once,
      startedAt: extra.startedAt || cur.autoLoop?.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      collectRuns,
      analyzeRuns,
      ...extra,
    },
  };
  fs.writeFileSync(pidPath, JSON.stringify(next, null, 2) + "\n");
}

append("auto_loop_start", {
  pid: process.pid,
  once,
  collectMs: COLLECT_MS,
  analyzeMs: ANALYZE_MS,
  analyzeLimit: Number(ANALYZE_LIMIT),
  analyzeReqCap: Number(ANALYZE_REQ_CAP),
  model: envBase.MODEL_CALLS_ENABLED,
  db: String(envBase.DATABASE_URL).replace(/:[^:@/]+@/, ":***@"),
});
updatePidRecord();

const shutdown = () => {
  if (stopping) return;
  stopping = true;
  append("auto_loop_stopping", { pid: process.pid, collectRuns, analyzeRuns });
  updatePidRecord({ stoppedAt: new Date().toISOString() });
  // Allow in-flight tick a moment; force exit soon.
  setTimeout(() => process.exit(0), busy ? 2000 : 100);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await tickCollect();
await tickAnalyze();
updatePidRecord();

if (once) {
  append("auto_loop_once_done", { collectRuns, analyzeRuns });
  updatePidRecord({ stoppedAt: new Date().toISOString(), onceDone: true });
  process.exit(0);
}

setInterval(() => { tickCollect().catch(() => {}); }, COLLECT_MS);
// Offset first analyze interval so it does not share the 0/60/120… minute boundary with collect.
setTimeout(() => {
  tickAnalyze().catch(() => {});
  setInterval(() => { tickAnalyze().catch(() => {}); }, ANALYZE_MS);
  append("auto_loop_analyze_armed", { offsetMs: ANALYZE_OFFSET_MS, everyMs: ANALYZE_MS });
}, Math.max(0, ANALYZE_OFFSET_MS));
append("auto_loop_armed", { nextCollectMs: COLLECT_MS, nextAnalyzeMs: ANALYZE_MS, analyzeOffsetMs: ANALYZE_OFFSET_MS });

// Keep alive
await new Promise(() => {});
