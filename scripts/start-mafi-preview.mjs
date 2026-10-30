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
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import net from "node:net";

const repo = process.cwd();

function loadDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    let value = line.slice(i + 1);
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, i)] = value;
  }
  return out;
}

const dotenv = loadDotEnv(path.join(repo, ".env"));
const dbUrl = requirePreviewDatabaseUrl(process.env.PREVIEW_DATABASE_URL || dotenv.PREVIEW_DATABASE_URL);
const dbName = decodeURIComponent(new URL(dbUrl).pathname.slice(1));
if (!dbName) throw new Error("DATABASE_URL must name the preview database");
const adminUrl = new URL(dbUrl); adminUrl.pathname = "/postgres";
const sql = postgres(adminUrl.toString(), { max: 1 });
if (!(await sql`SELECT 1 FROM pg_database WHERE datname=${dbName}`).length) {
  await sql.end();
  throw new Error(`Preview database "${dbName}" does not exist; refusing to create a fresh one (2026-10-30 drift guard)`);
}
await sql.end();

function free(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}
await free(3000);
await free(3001);

const env = {
  ...process.env,
  ...dotenv,
  NODE_ENV: "development",
  DATABASE_URL: dbUrl,
  AIHOT_DATA_DIR: ".data/preview",
  API_HOST: "127.0.0.1",
  API_PORT: "3001",
  API_BASE_URL: "http://127.0.0.1:3001",
  WEB_HOST: "127.0.0.1",
  WEB_PORT: "3000",
  SITE_URL: "http://127.0.0.1:3000",
  // Local preview: collect on; MODEL follows .env (enable stack = true).\r
  COLLECT_ENABLED: dotenv.COLLECT_ENABLED === "false" ? "false" : "true",
  MODEL_CALLS_ENABLED: dotenv.MODEL_CALLS_ENABLED === "true" ? "true" : "false",
  FEISHU_CONTENT_PUSH_ENABLED: "false",
  FEISHU_INTERNAL_ENABLED: "false",
  INDEXNOW_SUBMIT_ENABLED: "false",
  LOG_LEVEL: dotenv.LOG_LEVEL || "warn",
};
// Prefer rotated admin password from live .env; never invent a throwaway one for acceptance.
if (!env.ADMIN_PASSWORD) env.ADMIN_PASSWORD = randomBytes(16).toString("hex");
if (!env.SESSION_SECRET) env.SESSION_SECRET = randomBytes(32).toString("hex");
if (!env.IMG_PROXY_SIGN_SECRET) env.IMG_PROXY_SIGN_SECRET = randomBytes(32).toString("hex");
// Do not inherit Docker-style PORT=127.0.0.1:3000 into Node listeners.
delete env.PORT;

for (const script of ["scripts/migrate.ts", "scripts/seed.ts"]) {
  execFileSync(process.execPath, [script], { env, stdio: "inherit", cwd: repo });
}

const children = [];
for (const [name, script] of [["api", "apps/api/src/main.ts"], ["worker", "apps/worker/src/main.ts"], ["web", "apps/web/server.ts"]]) {
  const log = fs.openSync(path.join(repo, `.data/preview-${name}.log`), "a");
  const child = spawn(process.execPath, [script], {
    env,
    cwd: repo,
    stdio: ["ignore", log, log],
    windowsHide: true,
    detached: false,
  });
  children.push({ name, child });
  child.on("exit", (code) => console.log(name + " exited " + code));
}

fs.writeFileSync(
  path.join(repo, ".data/preview-pids.json"),
  JSON.stringify({
    pid: process.pid,
    children: children.map((x) => x.child.pid),
    url: env.SITE_URL,
    api: env.API_BASE_URL,
    database: dbName,
    collect: env.COLLECT_ENABLED === "true",
    models: env.MODEL_CALLS_ENABLED === "true",
    MODEL_CALLS_ENABLED: env.MODEL_CALLS_ENABLED,
    COLLECT_ENABLED: env.COLLECT_ENABLED,
    startedAt: new Date().toISOString(),
  }, null, 2) + "\n",
);

console.log("MAFi local preview http://127.0.0.1:3000 (COLLECT=" + env.COLLECT_ENABLED + " MODEL=" + env.MODEL_CALLS_ENABLED + "); db=" + dbName);

function stop() {
  for (const { child } of children) {
    try { child.kill(); } catch {}
  }
}
process.on("SIGINT", () => { stop(); process.exit(); });
process.on("SIGTERM", () => { stop(); process.exit(); });

let ready = false;
for (let i = 0; i < 90; i++) {
  try {
    const r = await fetch("http://127.0.0.1:3000/", { signal: AbortSignal.timeout(1500) });
    if (r.ok) { ready = true; break; }
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
if (!ready) {
  console.error("preview not ready on :3000");
  stop();
  process.exit(1);
}
console.log("preview ready");
// Keep parent alive with children.
await new Promise(() => {});