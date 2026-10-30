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
 * One analyze tick for MAFi auto loop (preview DB).
 * Incremental: only body_status=ok + processing_state=new (and cheap free-extract pending).
 * Caps per tick so hour/day budgets are not blown in one run.
 *
 *   node --env-file=.env scripts/analyze-mafi-auto.mjs
 *   node --env-file=.env scripts/analyze-mafi-auto.mjs --limit 12 --req-cap 80
 *
 * Respects live budgets circuit; stops cleanly when exhausted. jina stays unused (paidFallback:false).
 */
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import postgres from "postgres";

const args = process.argv.slice(2);
const argNum = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? Number(args[i + 1]) : def;
};
const limit = argNum("--limit", 12);
const reqCap = argNum("--req-cap", 80);
const extractCap = argNum("--extract-cap", 12);
const dayStopArg = argNum("--day-stop", NaN);
const hourStopArg = argNum("--hour-stop", NaN);
const minuteCap = argNum("--minute-cap", 18);

const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
const logDir = ".data/logs";
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `analyze-${day}.log`);
const reportPath = path.join(logDir, `analyze-last.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logLine = (o) => {
  const line = typeof o === "string" ? o : JSON.stringify(o);
  console.log(line);
  fs.appendFileSync(logPath, line + "\n");
};

const report = {
  checkedAt: new Date().toISOString(),
  limit,
  reqCap,
  extractCap,
  database: "mafi_preview_20261021",
  phase1: [],
  phase2_extract: [],
  phase3: [],
  phase4_group: [],
  stoppedReason: null,
};
const emit = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

const local = parseEnv(fs.readFileSync(".env", "utf8"));
if (local.MODEL_CALLS_ENABLED !== "true") {
  console.error("MODEL_CALLS_ENABLED must be true for analyze");
  process.exit(2);
}
Object.assign(process.env, local, {
  DATABASE_URL: requirePreviewDatabaseUrl(process.env.PREVIEW_DATABASE_URL || local.PREVIEW_DATABASE_URL),
  AIHOT_DATA_DIR: ".data/preview",
  COLLECT_ENABLED: "true",
  MODEL_CALLS_ENABLED: "true",
  FEISHU_CONTENT_PUSH_ENABLED: "false",
  FEISHU_INTERNAL_ENABLED: "false",
  INDEXNOW_SUBMIT_ENABLED: "false",
  LOG_LEVEL: "error",
});
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) {
  delete process.env[name];
}

const probe = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

async function usage() {
  const [u] = await probe`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE finished_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo')::int AS today,
      count(*) FILTER (WHERE finished_at >= now() - interval '1 hour')::int AS last_hour,
      count(*) FILTER (WHERE finished_at >= now() - interval '1 minute')::int AS last_minute
    FROM receipt_attempts WHERE service='llm'`;
  return u;
}

const [budgetRow] = await probe`SELECT per_minute, per_hour, per_day FROM budgets WHERE service='llm'`;
report.budgetLive = budgetRow;
const dayStop = Number.isFinite(dayStopArg) ? dayStopArg : Math.max(0, (budgetRow?.per_day ?? 500) - 5);
const hourStop = Number.isFinite(hourStopArg) ? hourStopArg : Math.max(0, (budgetRow?.per_hour ?? 450) - 10);
report.dayStop = dayStop;
report.hourStop = hourStop;

let tickReqs = 0;

function shouldStop(u) {
  if (u.today >= dayStop) return `day_stop_${dayStop}`;
  if (u.last_hour >= hourStop) return `hour_stop_${hourStop}`;
  if (tickReqs >= reqCap) return `req_cap_${reqCap}`;
  return null;
}

async function waitMinute(need = 8) {
  for (let i = 0; i < 90; i++) {
    const u = await usage();
    if (u.last_minute + need <= Math.min(minuteCap, budgetRow?.per_minute ?? 20)) return u;
    await sleep(1500);
  }
  return usage();
}

const { analyzeArticle } = await import("@aihot/backend/editorial/analyze");
const { publishArticle } = await import("@aihot/backend/publication/publish");
const { groupArticle } = await import("@aihot/backend/events/group");
const { extractFromUrl, pageFetchable, pageRules } = await import("@aihot/backend/content/extract");
const { contentHash, reviseMaterial, updatePresentation } = await import("@aihot/backend/content/materials");
const { BudgetExceededError, failureKind } = await import("@aihot/backend/providers/receipts");
const { sql, closeDb } = await import("@aihot/backend/db");

async function analyzeOne(art, bucket) {
  let u = await usage();
  const stop = shouldStop(u);
  if (stop) {
    report.stoppedReason = stop;
    return false;
  }
  u = await waitMinute(8);
  if (shouldStop(u)) {
    report.stoppedReason = shouldStop(u);
    return false;
  }
  const before = u.total;
  const started = Date.now();
  const row = { id: art.id, source_id: art.source_id, title: art.title, status: "pending" };
  logLine({ phase: "analyze", id: art.id, source_id: art.source_id, today: u.today, tickReqs });
  try {
    const result = await analyzeArticle(art.id);
    if (!result) row.status = "missing";
    else if (result.needsBody) row.status = "needs_body";
    else {
      if (!result.stale && result.output) await publishArticle(art.id);
      row.status = "ok";
      row.analysisId = result.analysisId;
      row.relevance = result.output?.relevance ?? null;
      row.selected = result.output?.selected ?? null;
      row.score = result.output?.score ?? null;
      row.threshold = result.output?.threshold ?? null;
      row.category = result.output?.category ?? null;
      row.titleZh = result.output?.titleZh?.slice(0, 100) ?? null;
    }
  } catch (e) {
    row.status = "failed";
    row.failureKind = failureKind(e);
    row.message = String(e?.message ?? e).slice(0, 240);
    bucket.push(row);
    emit();
    logLine(row);
    if (e instanceof BudgetExceededError || row.failureKind === "budget") {
      report.stoppedReason = "budget_exceeded";
      return false;
    }
    return true;
  }
  const after = await usage();
  row.latencyMs = Date.now() - started;
  row.requestsUsed = Math.max(0, after.total - before);
  tickReqs += row.requestsUsed;
  row.todayAfter = after.today;
  row.tickReqs = tickReqs;
  bucket.push(row);
  emit();
  logLine(row);
  await sleep(2500);
  return true;
}

report.usageBefore = await usage();
logLine({
  phase: "analyze_tick_start",
  usage: report.usageBefore,
  budget: budgetRow,
  dayStop,
  hourStop,
  limit,
  reqCap,
  extractCap,
});

const okNew = await probe`
  SELECT id, source_id, left(title, 80) AS title
  FROM articles
  WHERE body_status='ok' AND processing_state='new'
    AND length(coalesce(body_text,'')) >= 50
  ORDER BY
    CASE WHEN source_id LIKE 'web-smpaa%' OR source_id LIKE 'web-nmpa%' OR source_id LIKE 'web-nhsa%' THEN 0 ELSE 1 END,
    published_at DESC NULLS LAST
  LIMIT ${limit}`;
report.phase1_candidates = okNew.length;
logLine({ phase: "phase1", candidates: okNew.length });
for (const art of okNew) {
  const cont = await analyzeOne(art, report.phase1);
  if (!cont || report.stoppedReason) break;
}

if (!report.stoppedReason && tickReqs < reqCap) {
  const pending = await probe`
    SELECT a.id, a.source_id, a.url, a.revision, left(a.title, 80) AS title, s.kind, s.config, s.participation_mode
    FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.body_status='pending' AND a.processing_state='new'
      AND s.participation_mode='editorial'
    ORDER BY
      CASE WHEN a.source_id LIKE 'web-smpaa%' OR a.source_id LIKE 'web-nmpa%' OR a.source_id LIKE 'web-nhsa%'
        OR a.source_id LIKE 'web-pboc%' OR a.source_id LIKE 'web-nbs%' OR a.source_id LIKE 'web-safe%'
        OR a.source_id LIKE 'web-csrc%' OR a.source_id LIKE 'web-shfe%' THEN 0 ELSE 1 END,
      a.published_at DESC NULLS LAST
    LIMIT ${extractCap}`;
  report.phase2_pendingSeen = pending.length;
  logLine({ phase: "phase2_extract_start", pending: pending.length });
  for (const art of pending) {
    if (shouldStop(await usage())) {
      report.stoppedReason = shouldStop(await usage());
      break;
    }
    const row = { id: art.id, source_id: art.source_id, title: art.title, status: "skip" };
    try {
      if (!pageFetchable(art.url, art.kind)) {
        row.status = "not_fetchable";
        report.phase2_extract.push(row);
        continue;
      }
      const got = await extractFromUrl(art.url, `article:${art.id}`, pageRules(art.config), { paidFallback: false });
      if (!got || !got.text || got.text.length < 50) {
        row.status = "no_body";
        report.phase2_extract.push(row);
        continue;
      }
      await sql.begin(async (tx) => {
        const [cur] = await tx`
          SELECT title, excerpt, content_hash, media FROM articles
          WHERE id=${art.id} AND revision=${art.revision} AND body_status <> 'ok' FOR UPDATE`;
        if (!cur) {
          row.status = "skipped_race";
          return;
        }
        const hash = contentHash({ title: cur.title, bodyText: got.text, excerpt: cur.excerpt });
        if (hash === cur.content_hash) {
          await updatePresentation(tx, art.id, { html: got.html, media: cur.media?.length ? cur.media : got.images });
          await tx`UPDATE articles SET body_status='ok', body_html=${got.html}, body_text=${got.text}, updated_at=now() WHERE id=${art.id}`;
        } else {
          await reviseMaterial(tx, art.id, {
            set: sql`body_html = ${got.html}, body_text = ${got.text}, body_status = 'ok',
              media = CASE WHEN jsonb_array_length(media) = 0 THEN ${sql.json(got.images ?? [])}::jsonb ELSE media END`,
            hash,
            title: cur.title,
            bodyText: got.text,
          });
        }
        row.status = "extracted";
        row.via = got.via;
        row.bodyLen = got.text.length;
      });
    } catch (e) {
      row.status = "extract_error";
      row.message = String(e?.message ?? e).slice(0, 200);
    }
    report.phase2_extract.push(row);
    if (row.status === "extracted") logLine(row);
    await sleep(400);
  }
  emit();

  const remainSlots = Math.max(0, limit - report.phase1.length);
  if (!report.stoppedReason && remainSlots > 0 && tickReqs < reqCap) {
    const toAnalyze = await probe`
      SELECT id, source_id, left(title, 80) AS title
      FROM articles
      WHERE body_status='ok' AND processing_state='new'
        AND length(coalesce(body_text,'')) >= 50
      ORDER BY
        CASE WHEN source_id LIKE 'web-smpaa%' OR source_id LIKE 'web-nmpa%' OR source_id LIKE 'web-nhsa%' THEN 0 ELSE 1 END,
        published_at DESC NULLS LAST
      LIMIT ${remainSlots}`;
    report.phase3_candidates = toAnalyze.length;
    logLine({ phase: "phase3", candidates: toAnalyze.length });
    for (const art of toAnalyze) {
      const cont = await analyzeOne(art, report.phase3);
      if (!cont || report.stoppedReason) break;
    }
  }
}

// Seat model-selected rows stuck on grouping_status=pending (preview has no pg-boss worker).
if (!report.stoppedReason || String(report.stoppedReason).startsWith("tick") || report.stoppedReason === "no_work") {
  const waiting = await probe`
    SELECT a.id, a.source_id, left(a.title, 80) AS title
    FROM publications p
    JOIN articles a ON a.id = p.article_id
    JOIN LATERAL (
      SELECT selected FROM analyses WHERE article_id = a.id
      ORDER BY input_revision DESC, id DESC LIMIT 1
    ) an ON true
    WHERE an.selected IS TRUE AND p.selected IS NOT TRUE AND a.grouping_status = 'pending'
    ORDER BY a.discovered_at DESC
    LIMIT 12`;
  report.phase4_candidates = waiting.length;
  logLine({ phase: "phase4_group_start", candidates: waiting.length });
  for (const art of waiting) {
    const u = await usage();
    if (u.today >= dayStop || u.last_hour >= hourStop) {
      report.stoppedReason = u.today >= dayStop ? `day_stop_${dayStop}` : `hour_stop_${hourStop}`;
      break;
    }
    const row = { id: art.id, source_id: art.source_id, title: art.title, status: "pending" };
    try {
      const r = await groupArticle(art.id);
      row.status = "ok";
      row.verdict = r.verdict;
      const [pub] = await probe`SELECT selected, seat FROM publications WHERE article_id = ${art.id}`;
      row.selected = pub?.selected ?? null;
      row.seat = pub?.seat ?? null;
    } catch (e) {
      row.status = "failed";
      row.failureKind = failureKind(e);
      row.message = String(e?.message ?? e).slice(0, 240);
      if (e instanceof BudgetExceededError || row.failureKind === "budget") {
        report.stoppedReason = "budget_exceeded";
        report.phase4_group.push(row);
        logLine(row);
        break;
      }
    }
    report.phase4_group.push(row);
    logLine(row);
  }
}

report.usageAfter = await usage();
const all = [...report.phase1, ...report.phase3];
report.summary = {
  analyzedOk: all.filter((r) => r.status === "ok").length,
  selected: all.filter((r) => r.selected === true).length,
  failed: all.filter((r) => r.status === "failed").length,
  freeExtracted: report.phase2_extract.filter((r) => r.status === "extracted").length,
  groupedOk: report.phase4_group.filter((r) => r.status === "ok").length,
  tickReqs,
  today: report.usageAfter.today,
  remainingToDayStop: Math.max(0, dayStop - report.usageAfter.today),
};
if (!report.stoppedReason) report.stoppedReason = all.length || report.phase2_extract.length ? "tick_done" : "no_work";
emit();
logLine({ phase: "analyze_tick_done", summary: report.summary, stoppedReason: report.stoppedReason, report: reportPath });

await probe.end();
await closeDb();
process.exit(0);
