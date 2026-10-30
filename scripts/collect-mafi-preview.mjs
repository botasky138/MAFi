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
 * Collect-only one-shot for MAFi local trial.
 *
 * Usage (from repo root, Asia/Tokyo machine):
 *   node --env-file=.env scripts/collect-mafi-preview.mjs
 *   node --env-file=.env scripts/collect-mafi-preview.mjs web-nmpa-devices web-nmpa-trends
 *
 * Does NOT start a forever worker/daemon. Prefer supervised one-shots or scripts/mafi-auto-loop.mjs.
 * Requires COLLECT_ENABLED=true. Safe with MODEL_CALLS_ENABLED=true: the collect child is forced
 * MODEL off and never calls the LLM (stack .env MODEL can stay on).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const db = requirePreviewDatabaseUrl(process.env.PREVIEW_DATABASE_URL);

if (process.env.COLLECT_ENABLED !== "true") {
  console.error("Refusing: COLLECT_ENABLED is not true.");
  process.exit(2);
}

const defaultSources = [
  "web-cnpharm-device-policy", "web-cnpharm-device-supervision", "web-smpaa-notices", "web-nhsa-news",
  "web-nbs-releases", "web-pboc-news", "web-safe-news", "web-csrc-market",
  "web-shfe-notices", "rss-fed-press", "rss-cnbc-top", "web-stcn-news",
];
const sources = process.argv.slice(2);
const ids = sources.length ? sources : defaultSources;
const logPath = ".data/collect-only-20261022.log";
const stamp = new Date().toISOString();
fs.mkdirSync(".data", { recursive: true });
fs.appendFileSync(logPath, `\n=== collect-mafi-preview ${stamp} sources=${ids.join(",")} MODEL_stack=${process.env.MODEL_CALLS_ENABLED ?? ""} ===\n`);

// Collect path must not call LLM; force MODEL off only for this child.
const env = { ...process.env, DATABASE_URL: db, MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "true" };
const r = spawnSync(process.execPath, ["scripts/collect.ts", ...ids], { env, encoding: "utf8" });
const out = `${r.stdout || ""}${r.stderr || ""}`;
process.stdout.write(out);
fs.appendFileSync(logPath, out + `\n=== end exit=${r.status} ===\n`);
process.exit(r.status ?? 1);
