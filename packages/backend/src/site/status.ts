// Cheap site/runtime health for the preview chrome and Docker worker deployments. No LLM.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { SiteStatus, SiteStatusLight } from "@aihot/contracts/site";
import { config, REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";

const COLLECT_OK_MS = 15 * 60_000;
const COLLECT_STALE_MS = 35 * 60_000;
const ANALYZE_STALE_MS = 90 * 60_000;
const WORKER_HEARTBEAT_STALE_MS = 5 * 60_000;

export interface WorkerStatusInput {
  now: Date;
  db: "ok" | "down";
  newestArticleAt: string | null;
  workerHeartbeatAt: string | null;
  collectEnabled: boolean;
  modelCallsEnabled: boolean;
  lastScheduleRun: { status: string; at: string | null } | null;
  lastSweepRun: { status: string; at: string | null } | null;
  lastSourceOkAt: string | null;
  enabledSources: number;
  failingSources: number;
  lastAnalyzeAt: string | null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function latestIso(...values: Array<string | null | undefined>): string | null {
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > bestMs) bestMs = ms;
  }
  return Number.isFinite(bestMs) ? new Date(bestMs).toISOString() : null;
}

/** Derives SiteStatus from DB heartbeat, job_runs, sources, and analyses for Docker/systemd worker deployments. */
export function deriveWorkerStatus(input: WorkerStatusInput): SiteStatus {
  const checkedAt = input.now.toISOString();
  const nowMs = input.now.getTime();

  let autoLoop: SiteStatus["autoLoop"] = "missing";
  if (input.workerHeartbeatAt) {
    const hbMs = Date.parse(input.workerHeartbeatAt);
    autoLoop = Number.isFinite(hbMs) && nowMs - hbMs <= WORKER_HEARTBEAT_STALE_MS ? "running" : "dead";
  }

  const lastCollectAt = latestIso(input.lastScheduleRun?.at, input.lastSourceOkAt);
  let collect: SiteStatus["collect"] = "unknown";
  if (input.collectEnabled) {
    if (input.lastScheduleRun?.status === "failed" || (input.enabledSources > 0 && input.failingSources >= input.enabledSources)) {
      collect = "failing";
    } else if (lastCollectAt) {
      const age = nowMs - Date.parse(lastCollectAt);
      collect = Number.isFinite(age) && age <= COLLECT_OK_MS ? "ok" : "stale";
    }
  }

  const effectiveAnalyzeAt = latestIso(input.lastAnalyzeAt, input.lastSweepRun?.at);
  let analyze: SiteStatus["analyze"] = "unknown";
  if (input.modelCallsEnabled && effectiveAnalyzeAt) {
    const age = nowMs - Date.parse(effectiveAnalyzeAt);
    analyze = Number.isFinite(age) && age <= ANALYZE_STALE_MS ? "ok" : "stale";
  }

  let light: SiteStatusLight = "green";
  let label = "运行正常";
  let detail = !input.collectEnabled || !input.modelCallsEnabled
    ? "API、数据库与后台 Worker 运行正常（部分安全阀关闭）"
    : "API、数据库与后台 Worker 运行正常";

  if (input.db === "down" || autoLoop === "dead" || collect === "failing") {
    light = "red";
    label = "服务异常";
    if (input.db === "down") detail = "数据库不可用";
    else if (autoLoop === "dead") detail = "后台 Worker 心跳超时";
    else detail = "采集任务失败";
  } else if (autoLoop === "missing" || collect === "stale" || analyze === "stale") {
    light = "yellow";
    if (collect === "stale") {
      label = "采集延迟";
      detail = "采集结果偏旧或延迟";
    } else if (autoLoop === "missing") {
      label = "需关注";
      detail = "未检测到后台 Worker 心跳";
    } else {
      label = "运行降级";
      detail = "分析偏旧，等待下一轮精选";
    }
  }

  return {
    light,
    label,
    detail,
    db: input.db,
    autoLoop,
    collect,
    analyze,
    lastCollectAt,
    lastAnalyzeAt: effectiveAnalyzeAt,
    newestArticleAt: input.newestArticleAt,
    checkedAt,
  };
}

type PidAutoLoop = {
  pid?: number;
  startedAt?: string;
  updatedAt?: string;
  stoppedAt?: string;
  collectRuns?: number;
  analyzeRuns?: number;
  collectMs?: number;
  analyzeMs?: number;
};

type PidFile = {
  autoLoop?: PidAutoLoop;
};

function pidAlive(pid: number | undefined): boolean {
  if (!Number.isFinite(pid) || !pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function mtimeIso(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    return statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

function tokyoDay(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

/** Scan the auto-loop log from the end for the latest collect/analyze tick stamps. */
function scanLoopLog(file: string): { lastCollectAt: string | null; lastAnalyzeAt: string | null; lastCollectExit: number | null } {
  let lastCollectAt: string | null = null;
  let lastAnalyzeAt: string | null = null;
  let lastCollectExit: number | null = null;
  try {
    if (!existsSync(file)) return { lastCollectAt, lastAnalyzeAt, lastCollectExit };
    const text = readFileSync(file, "utf8");
    const lines = text.length > 200_000 ? text.slice(-200_000).split(/\r?\n/) : text.split(/\r?\n/);
    for (const line of lines) {
      const mCollect = /^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+collect_tick_end\s+(\{.*\})\s*$/.exec(line);
      if (mCollect) {
        lastCollectAt = mCollect[1]!;
        try {
          const obj = JSON.parse(mCollect[2]!) as { exit?: number };
          lastCollectExit = typeof obj.exit === "number" ? obj.exit : null;
        } catch {
          lastCollectExit = null;
        }
      }
      const mAnalyze = /^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+analyze_tick_end\s+/.exec(line);
      if (mAnalyze) lastAnalyzeAt = mAnalyze[1]!;
    }
  } catch {
    /* ignore */
  }
  return { lastCollectAt, lastAnalyzeAt, lastCollectExit };
}

export async function loadSiteStatus(now = new Date()): Promise<SiteStatus> {
  const checkedAt = now.toISOString();
  let db: "ok" | "down" = "down";
  let newestArticleAt: string | null = null;
  try {
    const rows = await sql<{ newest: Date | null }[]>`SELECT max(created_at) AS newest FROM articles`;
    db = "ok";
    const newest = rows[0]?.newest;
    newestArticleAt = newest ? new Date(newest).toISOString() : null;
  } catch {
    db = "down";
  }

  const pidPath = path.join(REPO_ROOT, ".data", "preview-pids.json");
  const pids = readJson<PidFile>(pidPath);
  const loop = pids?.autoLoop;

  if (!loop) {
    const collectEnabled = process.env.COLLECT_ENABLED === "true";
    const modelCallsEnabled = config.modelCallsEnabled;
    if (db === "down") {
      return deriveWorkerStatus({
        now,
        db: "down",
        newestArticleAt: null,
        workerHeartbeatAt: null,
        collectEnabled,
        modelCallsEnabled,
        lastScheduleRun: null,
        lastSweepRun: null,
        lastSourceOkAt: null,
        enabledSources: 0,
        failingSources: 0,
        lastAnalyzeAt: null,
      });
    }
    const [hbRows, runRows, sourceRows, analyzeRows] = await Promise.all([
      sql<{ updated_at: Date }[]>`SELECT updated_at FROM settings WHERE key = 'heartbeat.worker' LIMIT 1`,
      sql<{ job: string; status: string; at: Date | null }[]>`
        SELECT DISTINCT ON (job) job, status, COALESCE(finished_at, started_at) AS at
        FROM job_runs
        WHERE job IN ('sources.schedule', 'content.sweep')
        ORDER BY job, started_at DESC`,
      sql<{ last_ok: Date | null; enabled_count: number; failing_count: number }[]>`
        SELECT max(last_ok_at) AS last_ok,
               count(*)::int AS enabled_count,
               count(*) FILTER (WHERE health = 'failing')::int AS failing_count
        FROM sources
        WHERE enabled`,
      sql<{ last_analyze: Date | null }[]>`SELECT max(created_at) AS last_analyze FROM analyses`,
    ]);
    const scheduleRow = runRows.find((r) => r.job === "sources.schedule");
    const sweepRow = runRows.find((r) => r.job === "content.sweep");
    const sourceRow = sourceRows[0];
    return deriveWorkerStatus({
      now,
      db: "ok",
      newestArticleAt,
      workerHeartbeatAt: toIso(hbRows[0]?.updated_at),
      collectEnabled,
      modelCallsEnabled,
      lastScheduleRun: scheduleRow ? { status: scheduleRow.status, at: toIso(scheduleRow.at) } : null,
      lastSweepRun: sweepRow ? { status: sweepRow.status, at: toIso(sweepRow.at) } : null,
      lastSourceOkAt: toIso(sourceRow?.last_ok),
      enabledSources: sourceRow?.enabled_count ?? 0,
      failingSources: sourceRow?.failing_count ?? 0,
      lastAnalyzeAt: toIso(analyzeRows[0]?.last_analyze),
    });
  }

  let autoLoop: SiteStatus["autoLoop"] = "missing";
  if (loop?.pid) autoLoop = pidAlive(loop.pid) && !loop.stoppedAt ? "running" : "dead";

  const loopLog = path.join(REPO_ROOT, ".data", "logs", `auto-loop-${tokyoDay(now)}.log`);
  const scanned = scanLoopLog(loopLog);
  const analyzeReport = readJson<{ checkedAt?: string; stoppedReason?: string; summary?: { selected?: number } }>(
    path.join(REPO_ROOT, ".data", "logs", "analyze-last.json"),
  );

  let lastCollectAt = scanned.lastCollectAt ?? loop?.updatedAt ?? mtimeIso(path.join(REPO_ROOT, ".data", "logs", `collect-${tokyoDay(now)}.log`));
  let lastAnalyzeAt = scanned.lastAnalyzeAt ?? analyzeReport?.checkedAt ?? null;

  let collect: SiteStatus["collect"] = "unknown";
  if (lastCollectAt) {
    const age = now.getTime() - Date.parse(lastCollectAt);
    if (scanned.lastCollectExit != null && scanned.lastCollectExit !== 0) collect = "failing";
    else if (Number.isFinite(age) && age <= COLLECT_OK_MS) collect = "ok";
    else if (Number.isFinite(age) && age <= COLLECT_STALE_MS) collect = "stale";
    else collect = "stale";
  }

  let analyze: SiteStatus["analyze"] = "unknown";
  const stop = analyzeReport?.stoppedReason ?? "";
  if (stop.startsWith("day_stop") || stop.startsWith("hour_stop") || stop.includes("budget")) {
    analyze = "budget_paused";
  } else if (lastAnalyzeAt) {
    const age = now.getTime() - Date.parse(lastAnalyzeAt);
    analyze = Number.isFinite(age) && age <= ANALYZE_STALE_MS ? "ok" : "stale";
  }

  let light: SiteStatusLight = "green";
  let label = "运行正常";
  let detail = "API 与数据库正常，自动循环在跑，近期采集成功";

  if (db === "down" || autoLoop === "dead" || collect === "failing") {
    light = "red";
    label = "服务异常";
    if (db === "down") detail = "数据库不可用";
    else if (autoLoop === "dead") detail = "自动循环未在运行";
    else detail = "采集连续失败";
  } else if (autoLoop === "missing" || collect === "stale" || analyze === "budget_paused" || analyze === "stale") {
    light = "yellow";
    // Distinct warn titles (must not reuse green's healthy copy / 数据获取中).
    if (analyze === "budget_paused") {
      label = "已达额度上限";
      detail = "模型日预算已触顶，精选分析暂停；采集仍在进行";
    } else if (collect === "stale") {
      label = "采集延迟";
      detail = "采集结果偏旧或延迟";
    } else if (autoLoop === "missing") {
      label = "需关注";
      detail = "未找到自动循环记录";
    } else {
      // analyze === "stale"
      label = "运行降级";
      detail = "分析偏旧，等待下一轮精选";
    }
  }

  return {
    light,
    label,
    detail,
    db,
    autoLoop,
    collect,
    analyze,
    lastCollectAt,
    lastAnalyzeAt,
    newestArticleAt,
    checkedAt,
  };
}
