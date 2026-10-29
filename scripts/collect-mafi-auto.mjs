#!/usr/bin/env node
function requirePreviewDatabaseUrl(value) {
  if (!value) throw new Error("Set PREVIEW_DATABASE_URL before running this helper");
  const parsed = new URL(value);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("PREVIEW_DATABASE_URL must use PostgreSQL");
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!/(?:^|[_-])preview(?:[_-]|$)|(?:_test|_ci)$/i.test(database)) throw new Error("Use a dedicated preview, _test or _ci database");
  return value;
}
/**
 * Auto collect one-shot for MAFi preview DB. Ignores stack MODEL_CALLS_ENABLED
 * (forces MODEL off for collect child only; never calls LLM).
 *
 *   node --env-file=.env scripts/collect-mafi-auto.mjs
 *   node --env-file=.env scripts/collect-mafi-auto.mjs web-nmpa-devices
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const db = requirePreviewDatabaseUrl(process.env.PREVIEW_DATABASE_URL);

if (process.env.COLLECT_ENABLED !== "true") {
  console.error("Refusing: COLLECT_ENABLED is not true.");
  process.exit(2);
}

const defaultSources = [
  // AI / lab (main)
  "rss-openai-news", "web-anthropic-news", "web-deepseek-updates", "rss-github-ai",
  "json-vllm-releases", "json-ollama-releases", "rss-google-deepmind", "rss-hugging-face",
  // finance / gov (existing)
  "web-cnpharm-device-policy", "web-cnpharm-device-supervision", "web-smpaa-notices", "web-nhsa-news",
  "web-nbs-releases", "web-pboc-news", "web-safe-news", "web-csrc-market",
  "web-shfe-notices", "rss-fed-press", "rss-cnbc-top", "web-stcn-news",
];
const ids = process.argv.slice(2).length ? process.argv.slice(2) : defaultSources;
const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
const logDir = ".data/logs";
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `collect-${day}.log`);
const stamp = new Date().toISOString();
const header = `\n=== collect-mafi-auto ${stamp} sources=${ids.join(",")} ===\n`;
fs.appendFileSync(logPath, header);
console.log(JSON.stringify({ phase: "collect_start", stamp, sources: ids.length, log: logPath }));

const env = {
  ...process.env,
  DATABASE_URL: db,
  MODEL_CALLS_ENABLED: "false",
  COLLECT_ENABLED: "true",
  FEISHU_CONTENT_PUSH_ENABLED: "false",
  FEISHU_INTERNAL_ENABLED: "false",
  INDEXNOW_SUBMIT_ENABLED: "false",
};
const r = spawnSync(process.execPath, ["scripts/collect.ts", ...ids], {
  env,
  encoding: "utf8",
  cwd: process.cwd(),
});
const out = `${r.stdout || ""}${r.stderr || ""}`;
process.stdout.write(out);
fs.appendFileSync(logPath, out + `\n=== end exit=${r.status} ===\n`);
console.log(JSON.stringify({ phase: "collect_done", exit: r.status ?? 1, log: logPath }));
process.exit(r.status ?? 1);
