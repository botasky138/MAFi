import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileReaderStore } from "./cache.ts";
import { isTrendSince, type TrendItem, type TrendSince, type TrendWindowResult } from "../trend-contract.ts";

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
const EXCLUDED = new Set(["vercel-labs/agent-desktop", "thedotmack/claude-mem"]);
const LOCK_MS = 180_000;
const FORCE_COOLDOWN_MS = 60_000;
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
    const description = chunk.match(/<p class="col-9[^"]*"[^>]*>\s*([^<]*?)\s*<\/p>/);
    const language = chunk.match(/itemprop="programmingLanguage">\s*([^<]+?)\s*</);
    withPeriod.push({
      fullName,
      url: `https://github.com/${fullName}`,
      description: decode(description?.[1] ?? ""),
      language: language?.[1] ? decode(language[1]) : null,
      starsTotal: totalFound ? integer(totalFound[0]) : null,
      starsPeriod,
      periodText: `${period[1]} stars ${period[2]}`,
      category: "pending",
      topics: [],
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
  return { ...item, category: "pending", topics: [] };
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
    const [pidText, startedText] = text.split("\n");
    const pid = Number(pidText);
    const started = Number(startedText);
    const alive = Number.isInteger(pid) && pid > 0 && pidAlive(pid);
    const fresh = Number.isFinite(started) && now - started < LOCK_MS;
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
    await writeFile(lockPath, `${process.pid}\n${now}`, { flag: "wx", mode: 0o600 });
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

async function pull(io: TrendIO, url: string): Promise<TrendFetchResult> {
  const once = async () => io.fetch(url);
  try {
    const first = await once();
    if (!retriable(first.status)) return first;
  } catch {
    /* one retry below */
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  try {
    return await once();
  } catch {
    return { status: 0, body: "", retryAfter: null };
  }
}

function planAfter(now: number, interval: number, retryAfter: string | null): string {
  let extra = interval;
  if (retryAfter && /^\d+$/.test(retryAfter)) extra = Math.max(extra, Number(retryAfter) * 1000);
  return new Date(now + extra).toISOString();
}

export async function readGithubTrend(io: Omit<TrendIO, "mode"> & { since: TrendSince }): Promise<TrendWindowResult> {
  const sourceUrl = SOURCE[io.since];
  if (!io.enabled) {
    return { status: "disabled", since: io.since, sourceUrl, fetchedAt: null, attemptedAt: null, nextRefreshAt: null, trigger: null, message: "GitHub 趋势未启用", items: [], demo: false };
  }
  const window = (await load(io.dir)).windows[io.since];
  const items = sortByPeriod(applyExclusions(window.items));
  if (!window.fetchedAt) {
    return { status: "unavailable", since: io.since, sourceUrl, fetchedAt: null, attemptedAt: window.attemptedAt, nextRefreshAt: window.nextRefreshAt, trigger: window.trigger, message: window.lastError ?? "尚未采集", items: [], demo: false };
  }
  const overdue = io.now() - Date.parse(window.fetchedAt) > WINDOW_MS[io.since];
  const stale = Boolean(window.lastError) || overdue;
  const message = window.lastError
    ? "最近一次采集失败，仍显示上次成功快照。计划不早于下次采集时间，到点不保证更新。"
    : overdue
      ? "快照已超过该窗口的计划间隔。计划不早于下次采集时间，到点不保证更新。"
      : items.length === 0 ? "这次候选都在排除名单里。" : null;
  return {
    status: stale ? "stale" : "ready",
    since: io.since,
    sourceUrl,
    fetchedAt: window.fetchedAt,
    attemptedAt: window.attemptedAt,
    nextRefreshAt: window.nextRefreshAt,
    trigger: window.trigger,
    message,
    items,
    demo: window.demo,
  };
}

export async function refreshGithubTrend(io: TrendIO): Promise<{ ok: boolean; reason?: "cooldown" | "locked" | "disabled"; windows: Record<TrendSince, { ok: boolean }> }> {
  const idle = { daily: { ok: false }, weekly: { ok: false }, monthly: { ok: false } };
  if (!io.enabled) return { ok: false, reason: "disabled", windows: idle };
  const now = io.now();
  const preview = await load(io.dir);
  if (io.mode === "force" && preview.forcedAt && now - Date.parse(preview.forcedAt) < FORCE_COOLDOWN_MS) {
    return { ok: false, reason: "cooldown", windows: idle };
  }
  const ran = await withLock(io.dir, now, async () => {
    const envelope = await load(io.dir);
    if (io.mode === "force") envelope.forcedAt = new Date(now).toISOString();
    const windows = { daily: { ok: true }, weekly: { ok: true }, monthly: { ok: true } };
    let any = false;
    for (const since of SINCE) {
      const current = envelope.windows[since];
      if (io.mode === "due" && current.nextRefreshAt && Date.parse(current.nextRefreshAt) > now) continue;
      any = true;
      const response = await pull(io, SOURCE[since]);
      const at = new Date(io.now()).toISOString();
      current.attemptedAt = at;
      current.trigger = io.mode === "force" ? "admin" : "schedule";
      if (response.status !== 200) {
        current.lastError = `来源返回 HTTP ${response.status}`;
        current.nextRefreshAt = planAfter(io.now(), WINDOW_MS[since], response.retryAfter);
        windows[since] = { ok: false };
        continue;
      }
      const parsed = parseTrendingHtml(response.body, since);
      if (parsed.withPeriod.length === 0) {
        current.lastError = parsed.rawCards > 0 ? "趋势页有卡片，但没有可用的期间星数" : "来源未返回趋势卡片";
        current.nextRefreshAt = planAfter(io.now(), WINDOW_MS[since], response.retryAfter);
        windows[since] = { ok: false };
        continue;
      }
      current.items = sortByPeriod(applyExclusions(parsed.withPeriod));
      current.fetchedAt = at;
      current.lastError = null;
      current.demo = false;
      current.nextRefreshAt = planAfter(io.now(), WINDOW_MS[since], null);
      windows[since] = { ok: true };
    }
    if (any || io.mode === "force") await save(io.dir, envelope);
    return windows;
  });
  if (ran === "locked") return { ok: false, reason: "locked", windows: idle };
  return { ok: true, windows: ran };
}

