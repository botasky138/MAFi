import { readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileReaderStore } from "./cache.ts";
import { EXCLUDED_REPOS } from "../trend-config.ts";
import { isTrendSince, type TrendItem, type TrendSince, type TrendWindowResult } from "../trend-contract.ts";
import {
  decorateList, describeRepos, loadRepos, noteListed, pollRepos, saveRepos,
  type PurposeInput, type PurposeOutput, type RepoFetchResult,
} from "./github-repos.ts";

export type { TrendItem, TrendSince, TrendWindowResult };
export { isTrendSince };
export const WINDOW_MS: Record<TrendSince, number> = {
  daily: 30 * 60 * 1000,
  weekly: 2 * 60 * 60 * 1000,
  monthly: 6 * 60 * 60 * 1000,
};
const PHRASE: Record<TrendSince, string> = { daily: "today", weekly: "this week", monthly: "this month" };
const SOURCE: Record<TrendSince, string> = {
  daily: "https://github.com/trending?since=daily",
  weekly: "https://github.com/trending?since=weekly",
  monthly: "https://github.com/trending?since=monthly",
};
const EXCLUDED = new Set(EXCLUDED_REPOS.map((name) => name.toLowerCase()));
const LOCK_MS = 180_000;
const FORCE_COOLDOWN_MS = 60_000;
/**
 * The worker checks every 5 minutes. nextRefreshAt is the finish time plus the window, a few seconds after
 * the matching tick, so without this slack every window waited a whole extra tick (30 min ran hourly).
 */
const DUE_SLACK_MS = 2 * 60 * 1000;
/** A snapshot is stale only when it missed its window by more than a few ticks. */
const STALE_GRACE_MS = 15 * 60 * 1000;
/** A window whose page failed is tried again after this (or its own interval, if shorter), not a whole window later. */
const FAILED_RETRY_MS = 10 * 60 * 1000;
/** Stars count as live while the last poll is this recent. */
const LIVE_MS = 20 * 60 * 1000;
const SINCE: TrendSince[] = ["daily", "weekly", "monthly"];

export interface ParseResult {
  rawCards: number;
  withPeriod: TrendItem[];
}

interface StoredWindow {
  fetchedAt: string | null;
  attemptedAt: string | null;
  nextRefreshAt: string | null;
  lastError: string | null;
  trigger: "schedule" | "admin" | null;
  items: TrendItem[];
  sourceUrl: string;
  demo: boolean;
}

interface Envelope {
  version: 1;
  forcedAt: string | null;
  windows: Record<TrendSince, StoredWindow>;
}

export interface TrendFetchResult { status: number; body: string; retryAfter: string | null }
export interface TrendIO {
  dir: string;
  now: () => number;
  enabled: boolean;
  fetch: (url: string) => Promise<TrendFetchResult>;
  /** The GitHub repos API (live stars, topics, creation date). Absent in tests that only exercise HTML. */
  repoFetch?: (fullName: string) => Promise<RepoFetchResult>;
  /** GITHUB_TOKEN is set: poll every listed repo each run instead of about 40 an hour. */
  hasToken?: boolean;
  /** Waits between attempts at a trending page; tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
  /** Writes the purpose line (the worker's model step). Absent in the API process and in HTML-only tests. */
  describe?: (input: PurposeInput) => Promise<PurposeOutput>;
  mode: "due" | "force";
}

function blank(since: TrendSince): StoredWindow {
  return { fetchedAt: null, attemptedAt: null, nextRefreshAt: null, lastError: null, trigger: null, items: [], sourceUrl: SOURCE[since], demo: false };
}

function emptyEnvelope(): Envelope {
  return { version: 1, forcedAt: null, windows: { daily: blank("daily"), weekly: blank("weekly"), monthly: blank("monthly") } };
}

function decode(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").trim();
}

function integer(text: string): number | null {
  const digits = text.replace(/,/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseTrendingHtml(html: string, since: TrendSince): ParseResult {
  const chunks = html.split(/<article\b[^>]*class="[^"]*\bBox-row\b[^"]*"/).slice(1);
  const withPeriod: TrendItem[] = [];
  for (const chunk of chunks) {
    const link = chunk.match(/<h2\b[\s\S]*?<a\b[^>]*href="\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)"/);
    if (!link) continue;
    const period = chunk.match(/([\d,]+)\s+stars\s+(today|this week|this month)/);
    if (!period || period[2] !== PHRASE[since]) continue;
    const starsPeriod = integer(period[1] ?? "");
    if (starsPeriod === null) continue;
    const fullName = `${link[1]}/${link[2]}`;
    const totalMarkup = chunk.match(new RegExp(`href="/${link[1]}/${link[2]}/stargazers"[^>]*>([\\s\\S]*?)</a>`));
    const totalText = totalMarkup ? totalMarkup[1]?.replace(/<[^>]+>/g, " ") : "";
    const totalFound = totalText?.match(/[\d,]+/);
    // The description may hold links (<a>) and emoji markup; keep its text.
    const description = chunk.match(/<p class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const language = chunk.match(/itemprop="programmingLanguage">\s*([^<]+?)\s*</);
    withPeriod.push({
      fullName,
      url: `https://github.com/${fullName}`,
      description: decode((description?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ")),
      language: language?.[1] ? decode(language[1]) : null,
      starsTotal: totalFound ? integer(totalFound[0]) : null,
      starsPeriod,
      periodText: `${period[1]} stars ${period[2]}`,
      starsHour: null,
      spark: [],
      category: "other",
      secondary: null,
      purpose: null,
      topics: null,
      createdAt: null,
      badges: [],
    });
  }
  return { rawCards: chunks.length, withPeriod };
}

export function applyExclusions(items: readonly TrendItem[]): TrendItem[] {
  return items.filter((item) => !EXCLUDED.has(item.fullName.toLowerCase()));
}

export function sortByPeriod(items: readonly TrendItem[]): TrendItem[] {
  return [...items].sort((a, b) => b.starsPeriod - a.starsPeriod || a.fullName.localeCompare(b.fullName));
}

function keptItem(value: unknown): TrendItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as TrendItem;
  if (typeof item.fullName !== "string" || !item.fullName.includes("/")) return null;
  if (typeof item.starsPeriod !== "number" || !Number.isSafeInteger(item.starsPeriod) || item.starsPeriod < 0) return null;
  if (item.starsTotal !== null && (typeof item.starsTotal !== "number" || !Number.isSafeInteger(item.starsTotal))) return null;
  return {
    fullName: item.fullName,
    url: typeof item.url === "string" ? item.url : `https://github.com/${item.fullName}`,
    description: typeof item.description === "string" ? item.description : "",
    language: typeof item.language === "string" ? item.language : null,
    starsTotal: item.starsTotal,
    starsPeriod: item.starsPeriod,
    periodText: typeof item.periodText === "string" ? item.periodText : "",
    starsHour: null, spark: [], category: "other", secondary: null, purpose: null, topics: null, createdAt: null, badges: [],
  };
}

function storeFor(dir: string): FileReaderStore {
  return new FileReaderStore(dir);
}

async function load(dir: string): Promise<Envelope> {
  const saved = await storeFor(dir).read("github-trending");
  if (!saved || typeof saved !== "object") return emptyEnvelope();
  const record = saved as Partial<Envelope>;
  const envelope = emptyEnvelope();
  envelope.forcedAt = typeof record.forcedAt === "string" ? record.forcedAt : null;
  for (const since of SINCE) {
    const window = record.windows?.[since];
    if (!window) continue;
    envelope.windows[since] = {
      ...blank(since),
      fetchedAt: typeof window.fetchedAt === "string" ? window.fetchedAt : null,
      attemptedAt: typeof window.attemptedAt === "string" ? window.attemptedAt : null,
      nextRefreshAt: typeof window.nextRefreshAt === "string" ? window.nextRefreshAt : null,
      lastError: typeof window.lastError === "string" ? window.lastError : null,
      trigger: window.trigger === "admin" || window.trigger === "schedule" ? window.trigger : null,
      sourceUrl: SOURCE[since],
      demo: window.demo === true,
      items: Array.isArray(window.items) ? window.items.map(keptItem).filter((item): item is TrendItem => item !== null) : [],
    };
  }
  return envelope;
}

async function save(dir: string, envelope: Envelope): Promise<void> {
  await storeFor(dir).write("github-trending", envelope);
}

function procStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return after[19] ?? null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function releaseStaleLock(lockPath: string, now: number): Promise<void> {
  try {
    const text = await readFile(lockPath, "utf8");
    const [pidText, startText, startedText] = text.split("\n");
    const pid = Number(pidText);
    const started = Number(startedText);
    const fresh = Number.isFinite(started) && now - started < LOCK_MS;
    const currentStart = Number.isInteger(pid) && pid > 0 ? procStart(pid) : null;
    const sameProcess = currentStart !== null && startText !== "" && currentStart === startText;
    const alive = sameProcess || (currentStart === null && Number.isInteger(pid) && pid > 0 && pidAlive(pid));
    if (alive && fresh) return;
    await unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function withLock<T>(dir: string, now: number, fn: () => Promise<T>): Promise<T | "locked"> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, "github-trending.lock");
  await releaseStaleLock(lockPath, now);
  try {
    await writeFile(lockPath, `${process.pid}\n${procStart(process.pid) ?? ""}\n${now}`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "locked";
    throw error;
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

function retriable(status: number): boolean {
  return status === 429 || status >= 500 || status === 0;
}

/**
 * GitHub's trending pages answer 504 about half the time (measured 2026-11-09, each in under a second), so
 * a 5xx, a dropped connection or a short 429 is tried up to four times. The last answer is returned, with
 * the first Retry-After kept if the last has none.
 */
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

async function pull(io: TrendIO, url: string): Promise<TrendFetchResult> {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: TrendFetchResult | null = null;
  let retryAfter: string | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
    try {
      last = await io.fetch(url);
    } catch {
      last = null;
    }
    if (last && !retriable(last.status)) return last;
    retryAfter ??= last?.retryAfter ?? null;
    // Asked to wait longer than our backoff: stop here and let the plan honour it.
    if ((retryAfterMs(last?.retryAfter ?? null, io.now()) ?? 0) > RETRY_DELAYS_MS.at(-1)!) break;
  }
  const result = last ?? { status: 0, body: "", retryAfter: null };
  return result.retryAfter || !retryAfter ? result : { ...result, retryAfter };
}

export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function planAfter(now: number, interval: number, retryAfter: string | null): string {
  const extra = Math.max(interval, retryAfterMs(retryAfter, now) ?? 0);
  return new Date(now + extra).toISOString();
}

function blankResult(since: TrendSince, status: "disabled" | "unavailable", message: string, window?: StoredWindow): TrendWindowResult {
  return {
    status, since, sourceUrl: SOURCE[since], fetchedAt: null, attemptedAt: window?.attemptedAt ?? null, nextRefreshAt: window?.nextRefreshAt ?? null,
    trigger: window?.trigger ?? null, message, items: [], demo: false, featured: [], starsAt: null, live: false,
  };
}

export async function readGithubTrend(io: Omit<TrendIO, "mode"> & { since: TrendSince }): Promise<TrendWindowResult> {
  if (!io.enabled) return blankResult(io.since, "disabled", "GitHub 趋势未启用");
  const envelope = await load(io.dir);
  const window = envelope.windows[io.since];
  if (!window.fetchedAt) return blankResult(io.since, "unavailable", window.lastError ? `还没有成功采集过：${window.lastError}` : "还没有采集过", window);
  const now = io.now();
  const repos = await loadRepos(io.dir);
  const lists = SINCE.map((since) => new Set(applyExclusions(envelope.windows[since].items).map((item) => item.fullName.toLowerCase())));
  const triple = new Set([...lists[0]!].filter((name) => lists[1]!.has(name) && lists[2]!.has(name)));
  const { items, featured } = decorateList(repos, { since: io.since, items: sortByPeriod(applyExclusions(window.items)), triple }, now);
  const overdue = now - Date.parse(window.fetchedAt) > WINDOW_MS[io.since] + STALE_GRACE_MS;
  const message = window.lastError
    ? `最近一次采集没成功（${window.lastError}），先显示上次的结果。`
    : overdue ? "榜单比计划的更新时间旧，后台采集可能停了。" : items.length === 0 ? "这一期的仓库都在排除名单里。" : null;
  return {
    status: window.lastError || overdue ? "stale" : "ready",
    since: io.since,
    sourceUrl: SOURCE[io.since],
    fetchedAt: window.fetchedAt,
    attemptedAt: window.attemptedAt,
    nextRefreshAt: window.nextRefreshAt,
    trigger: window.trigger,
    message,
    items,
    demo: window.demo,
    featured,
    starsAt: repos.starsAt,
    live: Boolean(repos.starsAt && now - Date.parse(repos.starsAt) < LIVE_MS),
  };
}

export interface RefreshResult {
  ok: boolean;
  reason?: "cooldown" | "locked" | "disabled";
  windows: Record<TrendSince, { ok: boolean }>;
  stars?: { polled: number; ok: number };
  purposes?: { written: number; failed: number };
}

/**
 * One worker tick (or the admin's forced run): the trending pages that are due, then the live stars of every
 * listed repo, then a few purpose lines, 精选 first. Readers never trigger any of it.
 */
export async function refreshGithubTrend(io: TrendIO): Promise<RefreshResult> {
  const idle = { daily: { ok: false }, weekly: { ok: false }, monthly: { ok: false } };
  if (!io.enabled) return { ok: false, reason: "disabled", windows: idle };
  const now = io.now();
  const preview = await load(io.dir);
  if (io.mode === "force" && preview.forcedAt && now - Date.parse(preview.forcedAt) < FORCE_COOLDOWN_MS) {
    return { ok: false, reason: "cooldown", windows: idle };
  }
  const ran = await withLock(io.dir, now, async () => {
    const envelope = await load(io.dir);
    if (io.mode === "force" && envelope.forcedAt && io.now() - Date.parse(envelope.forcedAt) < FORCE_COOLDOWN_MS) return "cooldown" as const;
    const windows = { daily: { ok: true }, weekly: { ok: true }, monthly: { ok: true } };
    let any = false;
    const fresh = new Set<TrendSince>();
    for (const since of SINCE) {
      const current = envelope.windows[since];
      if (io.mode === "due" && current.nextRefreshAt && Date.parse(current.nextRefreshAt) - DUE_SLACK_MS > now) continue;
      any = true;
      const response = await pull(io, SOURCE[since]);
      const at = new Date(io.now()).toISOString();
      current.attemptedAt = at;
      current.trigger = io.mode === "force" ? "admin" : "schedule";
      if (response.status !== 200) {
        current.lastError = `GitHub 返回 HTTP ${response.status}`;
        current.nextRefreshAt = planAfter(io.now(), Math.min(WINDOW_MS[since], FAILED_RETRY_MS), response.retryAfter);
        windows[since] = { ok: false };
        continue;
      }
      const parsed = parseTrendingHtml(response.body, since);
      if (parsed.withPeriod.length === 0) {
        current.lastError = parsed.rawCards > 0 ? "页面有仓库卡片，但读不到期间星数" : "页面上没有仓库卡片";
        current.nextRefreshAt = planAfter(io.now(), Math.min(WINDOW_MS[since], FAILED_RETRY_MS), response.retryAfter);
        windows[since] = { ok: false };
        continue;
      }
      current.items = sortByPeriod(applyExclusions(parsed.withPeriod));
      current.fetchedAt = at;
      current.lastError = null;
      current.demo = false;
      current.nextRefreshAt = planAfter(io.now(), WINDOW_MS[since], null);
      windows[since] = { ok: true };
      fresh.add(since);
    }
    if (any || io.mode === "force") {
      if (io.mode === "force") envelope.forcedAt = new Date(io.now()).toISOString();
      await save(io.dir, envelope);
    }

    const repos = await loadRepos(io.dir);
    const listed = Object.fromEntries(SINCE.map((since) => [since, envelope.windows[since].items.map((item) => item.fullName)])) as Record<TrendSince, string[]>;
    const names = SINCE.flatMap((since) => listed[since]);
    noteListed(repos, names, fresh.has("daily") ? listed.daily : null, io.now());
    const stars = await pollRepos(repos, names, { now: io.now, repoFetch: io.repoFetch, hasToken: io.hasToken === true });
    // 精选 of each list first, then the rest by period stars, so the cards on top get their line first.
    const ordered = new Map<string, TrendItem>();
    const decorated = SINCE.map((since) => decorateList(repos, { since, items: envelope.windows[since].items, triple: new Set() }, io.now()));
    for (const { items, featured } of decorated) for (const item of items) if (featured.includes(item.fullName)) ordered.set(item.fullName.toLowerCase(), item);
    for (const { items } of decorated) for (const item of items) if (!ordered.has(item.fullName.toLowerCase())) ordered.set(item.fullName.toLowerCase(), item);
    const purposes = await describeRepos(repos, [...ordered.values()], { now: io.now, describe: io.describe, waitForMeta: Boolean(io.repoFetch && io.hasToken) });
    await saveRepos(io.dir, repos);
    return { windows, stars, purposes };
  });
  if (ran === "locked") return { ok: false, reason: "locked", windows: idle };
  if (ran === "cooldown") return { ok: false, reason: "cooldown", windows: idle };
  return { ok: true, ...ran };
}
