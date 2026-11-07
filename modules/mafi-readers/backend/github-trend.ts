import { readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileReaderStore } from "./cache.ts";
import { isTrendSince, type TrendCategory, type TrendItem, type TrendSince, type TrendWindowResult } from "../trend-contract.ts";

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
const TOPIC_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOPIC_HOUR_BUDGET = 10;
const TOPIC_RULES: Record<"agent" | "devtools" | "infra", ReadonlySet<string>> = {
  agent: new Set(["agent", "agents", "ai-agent", "llm", "llm-agent", "autonomous-agents", "coding-agent"]),
  devtools: new Set(["developer-tools", "devtools", "cli", "command-line"]),
  infra: new Set(["infrastructure", "kubernetes", "devops", "observability", "platform-engineering"]),
};
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
export interface TopicFetchResult {
  status: number;
  topics: string[] | null;
  retryAfter: string | null;
  remaining: number | null;
  resetAt: number | null;
}
export interface TrendIO {
  dir: string;
  now: () => number;
  enabled: boolean;
  fetch: (url: string) => Promise<TrendFetchResult>;
  /** Absent in tests that only exercise HTML. Production supplies the GitHub topics API. */
  topicFetch?: (fullName: string) => Promise<TopicFetchResult>;
  mode: "due" | "force";
}

interface TopicRepo { topics: string[] | null; fetchedAt: string | null }
interface TopicState {
  version: 1;
  hourStart: number;
  used: number;
  pauseUntil: number | null;
  repos: Record<string, TopicRepo>;
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
      topics: null,
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

/** topics 为 null 表示还没取到。空数组或有 topic 但无法唯一归类，都是未分类。 */
export function classifyTopics(topics: readonly string[] | null): TrendCategory {
  if (topics == null) return "pending";
  const hits = new Set<TrendCategory>();
  for (const raw of topics) {
    const topic = raw.toLowerCase();
    for (const [category, words] of Object.entries(TOPIC_RULES) as Array<["agent" | "devtools" | "infra", ReadonlySet<string>]>) {
      if (words.has(topic)) hits.add(category);
    }
  }
  if (hits.size === 1) return [...hits][0]!;
  return "unclassified";
}

function keptItem(value: unknown): TrendItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as TrendItem;
  if (typeof item.fullName !== "string" || !item.fullName.includes("/")) return null;
  if (typeof item.starsPeriod !== "number" || !Number.isSafeInteger(item.starsPeriod) || item.starsPeriod < 0) return null;
  if (item.starsTotal !== null && (typeof item.starsTotal !== "number" || !Number.isSafeInteger(item.starsTotal))) return null;
  const topics = Array.isArray(item.topics) ? item.topics.filter((topic) => typeof topic === "string") : null;
  return { ...item, topics, category: classifyTopics(topics) };
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

async function pull(io: TrendIO, url: string): Promise<TrendFetchResult> {
  let first: TrendFetchResult | null = null;
  try {
    first = await io.fetch(url);
    if (!retriable(first.status)) return first;
  } catch {
    first = null;
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  try {
    const second = await io.fetch(url);
    return second.retryAfter || !first?.retryAfter ? second : { ...second, retryAfter: first.retryAfter };
  } catch {
    return first ?? { status: 0, body: "", retryAfter: null };
  }
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

function emptyTopics(): TopicState {
  return { version: 1, hourStart: 0, used: 0, pauseUntil: null, repos: {} };
}

async function loadTopics(dir: string): Promise<TopicState> {
  const saved = await storeFor(dir).read("github-trend-topics");
  if (!saved || typeof saved !== "object") return emptyTopics();
  const record = saved as Partial<TopicState>;
  const repos: Record<string, TopicRepo> = {};
  for (const [name, value] of Object.entries(record.repos ?? {})) {
    if (!value || typeof value !== "object") continue;
    const row = value as TopicRepo;
    repos[name.toLowerCase()] = {
      topics: Array.isArray(row.topics) ? row.topics.filter((topic) => typeof topic === "string") : null,
      fetchedAt: typeof row.fetchedAt === "string" ? row.fetchedAt : null,
    };
  }
  return {
    version: 1,
    hourStart: typeof record.hourStart === "number" ? record.hourStart : 0,
    used: typeof record.used === "number" ? record.used : 0,
    pauseUntil: typeof record.pauseUntil === "number" ? record.pauseUntil : null,
    repos,
  };
}

async function saveTopics(dir: string, state: TopicState): Promise<void> {
  await storeFor(dir).write("github-trend-topics", state);
}

function topicDue(state: TopicState, name: string, now: number): boolean {
  const row = state.repos[name];
  if (!row?.fetchedAt) return true;
  return now - Date.parse(row.fetchedAt) >= TOPIC_TTL_MS;
}

function decorate(items: TrendItem[], state: TopicState): TrendItem[] {
  return items.map((item) => {
    const row = state.repos[item.fullName.toLowerCase()];
    const topics = row?.topics ?? null;
    return { ...item, topics, category: classifyTopics(topics) };
  });
}

/** Expired rows are ahead of never-fetched ones, so a full hour of new repos cannot freeze old topics. */
export function topicQueue(names: readonly string[], state: TopicState, now: number): string[] {
  return [...new Set(names.map((name) => name.toLowerCase()))].filter((name) => topicDue(state, name, now)).sort((a, b) => {
    const af = state.repos[a]?.fetchedAt;
    const bf = state.repos[b]?.fetchedAt;
    if (af && bf) return Date.parse(af) - Date.parse(bf) || a.localeCompare(b);
    if (af) return -1;
    if (bf) return 1;
    return a.localeCompare(b);
  });
}

async function enrichTopics(dir: string, names: readonly string[], io: TrendIO): Promise<void> {
  if (!io.topicFetch || names.length === 0) return;
  const state = await loadTopics(dir);
  const now = io.now();
  const hour = Math.floor(now / 3_600_000);
  if (state.hourStart !== hour) {
    state.hourStart = hour;
    state.used = 0;
  }
  if (state.pauseUntil !== null && now >= state.pauseUntil) state.pauseUntil = null;
  if (state.pauseUntil !== null && now < state.pauseUntil) {
    await saveTopics(dir, state);
    return;
  }
  let changed = state.hourStart === hour;
  for (const name of topicQueue(names, state, now)) {
    if (state.used >= TOPIC_HOUR_BUDGET) break;
    if (state.pauseUntil !== null && io.now() < state.pauseUntil) break;
    let result: TopicFetchResult;
    try {
      result = await io.topicFetch(name);
    } catch {
      result = { status: 0, topics: null, retryAfter: null, remaining: null, resetAt: null };
    }
    state.used += 1;
    changed = true;
    const limited = result.status === 403 || result.status === 429 || (result.remaining !== null && result.remaining < 10);
    if (limited && result.topics === null) {
      const reset = result.resetAt ?? (retryAfterMs(result.retryAfter, io.now()) !== null ? io.now() + (retryAfterMs(result.retryAfter, io.now()) ?? 0) : null);
      state.pauseUntil = reset ?? hour * 3_600_000 + 3_600_000;
      break;
    }
    if (result.status === 200 && result.topics) {
      state.repos[name] = { topics: result.topics.map((topic) => topic.toLowerCase()), fetchedAt: new Date(io.now()).toISOString() };
      if (result.remaining !== null && result.remaining < 10) state.pauseUntil = result.resetAt ?? hour * 3_600_000 + 3_600_000;
      continue;
    }
    const previous = state.repos[name];
    state.repos[name] = { topics: previous?.topics ?? null, fetchedAt: new Date(io.now()).toISOString() };
  }
  if (changed) await saveTopics(dir, state);
}

export async function readGithubTrend(io: Omit<TrendIO, "mode"> & { since: TrendSince }): Promise<TrendWindowResult> {
  const sourceUrl = SOURCE[io.since];
  if (!io.enabled) {
    return { status: "disabled", since: io.since, sourceUrl, fetchedAt: null, attemptedAt: null, nextRefreshAt: null, trigger: null, message: "GitHub 趋势未启用", items: [], demo: false };
  }
  const window = (await load(io.dir)).windows[io.since];
  const items = decorate(sortByPeriod(applyExclusions(window.items)), await loadTopics(io.dir));
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
    if (io.mode === "force" && envelope.forcedAt && io.now() - Date.parse(envelope.forcedAt) < FORCE_COOLDOWN_MS) return "cooldown" as const;
    const windows = { daily: { ok: true }, weekly: { ok: true }, monthly: { ok: true } };
    let any = false;
    const seen = new Set<string>();
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
      for (const item of current.items) seen.add(item.fullName.toLowerCase());
      current.fetchedAt = at;
      current.lastError = null;
      current.demo = false;
      current.nextRefreshAt = planAfter(io.now(), WINDOW_MS[since], null);
      windows[since] = { ok: true };
    }
    for (const since of SINCE) for (const item of envelope.windows[since].items) seen.add(item.fullName.toLowerCase());
    if (any || io.mode === "force") {
      if (io.mode === "force") envelope.forcedAt = new Date(io.now()).toISOString();
      await save(io.dir, envelope);
    }
    await enrichTopics(dirOf(io), [...seen], io);
    return windows;
  });
  if (ran === "locked") return { ok: false, reason: "locked", windows: idle };
  if (ran === "cooldown") return { ok: false, reason: "cooldown", windows: idle };
  return { ok: true, windows: ran };
}

function dirOf(io: TrendIO): string {
  return io.dir;
}

