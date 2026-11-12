// What the GitHub API says about the repos on the trend lists: the live star count every poll (kept for
// 26 hours), the repo's topics and creation date, and the purpose line the model wrote. One file in the
// reader store, written only by the refresh (worker or admin), read by every page view.
import { createHash } from "node:crypto";
import { FileReaderStore } from "./cache.ts";
import { RESIDENT_DAYS } from "../trend-config.ts";
import { TREND_CATEGORIES, isTrendCategory, type TrendBadge, type TrendCategory, type TrendItem, type TrendSince } from "../trend-contract.ts";

const HOUR_MS = 60 * 60 * 1000;
const KEEP_POINTS_MS = 26 * HOUR_MS;
/** Polls closer together than this replace the last point instead of adding one. */
const POINT_GAP_MS = 4 * 60 * 1000;
/** A repo off every list this long is forgotten. */
const FORGET_MS = 7 * 24 * HOUR_MS;
/** A daily-list gap longer than this restarts the 常驻 count. */
const RESIDENT_GAP_MS = 36 * HOUR_MS;
/** GitHub allows 5,000 requests an hour with a token and 60 without; stay well inside both. */
const HOUR_BUDGET = { token: 1_000, anonymous: 40 } as const;
const LOW_REMAINING = 10;
/** A failed purpose is tried again after this. */
const PURPOSE_RETRY_MS = HOUR_MS;
const PURPOSE_PER_RUN = 6;

export interface RepoMeta {
  description: string;
  topics: string[];
  language: string | null;
  createdAt: string | null;
  homepage: string | null;
  archived: boolean;
}

export interface RepoPurpose {
  text: string;
  category: TrendCategory;
  secondary: TrendCategory | null;
  /** Hash of what it was written from; a changed description or topics writes it again. */
  basis: string;
  model: string;
  at: string;
}

interface RepoRecord {
  fullName: string;
  /** [epoch ms, stargazers_count], oldest first. */
  points: Array<[number, number]>;
  polledAt: string | null;
  meta: RepoMeta | null;
  purpose: RepoPurpose | null;
  purposeTriedAt: string | null;
  dailyFirstSeen: string | null;
  dailyLastSeen: string | null;
  seenAt: string;
}

export interface RepoState {
  version: 1;
  hourStart: number;
  used: number;
  pauseUntil: number | null;
  starsAt: string | null;
  repos: Record<string, RepoRecord>;
}

export interface RepoFetchResult {
  status: number;
  repo: { stars: number; meta: RepoMeta } | null;
  remaining: number | null;
  resetAt: number | null;
}

export interface PurposeInput {
  fullName: string;
  description: string;
  topics: string[];
  language: string | null;
  homepage: string | null;
}

export interface PurposeOutput {
  purpose: string;
  category: TrendCategory;
  secondary: TrendCategory | null;
  model: string;
}

/** Thrown by a describer that cannot run at all now (model calls off, no key, budget spent): stop this run. */
export class DescribeUnavailableError extends Error {}

const KEY = "github-repos";

function emptyState(): RepoState {
  return { version: 1, hourStart: 0, used: 0, pauseUntil: null, starsAt: null, repos: {} };
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function keptMeta(value: unknown): RepoMeta | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return {
    description: str(row.description) ?? "",
    topics: Array.isArray(row.topics) ? row.topics.filter((t): t is string => typeof t === "string") : [],
    language: str(row.language),
    createdAt: str(row.createdAt),
    homepage: str(row.homepage),
    archived: row.archived === true,
  };
}

function keptPurpose(value: unknown): RepoPurpose | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.text !== "string" || !isTrendCategory(row.category)) return null;
  return {
    text: row.text,
    category: row.category,
    secondary: isTrendCategory(row.secondary) && row.secondary !== row.category ? row.secondary : null,
    basis: str(row.basis) ?? "",
    model: str(row.model) ?? "",
    at: str(row.at) ?? "",
  };
}

export async function loadRepos(dir: string): Promise<RepoState> {
  const saved = await new FileReaderStore(dir).read(KEY);
  if (!saved || typeof saved !== "object") return emptyState();
  const record = saved as Partial<RepoState>;
  const repos: Record<string, RepoRecord> = {};
  for (const [name, value] of Object.entries(record.repos ?? {})) {
    if (!value || typeof value !== "object") continue;
    const row = value as Partial<RepoRecord>;
    repos[name.toLowerCase()] = {
      fullName: typeof row.fullName === "string" ? row.fullName : name,
      points: Array.isArray(row.points)
        ? row.points.filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isSafeInteger(p[1]))
        : [],
      polledAt: str(row.polledAt),
      meta: keptMeta(row.meta),
      purpose: keptPurpose(row.purpose),
      purposeTriedAt: str(row.purposeTriedAt),
      dailyFirstSeen: str(row.dailyFirstSeen),
      dailyLastSeen: str(row.dailyLastSeen),
      seenAt: str(row.seenAt) ?? new Date(0).toISOString(),
    };
  }
  return {
    version: 1,
    hourStart: typeof record.hourStart === "number" ? record.hourStart : 0,
    used: typeof record.used === "number" ? record.used : 0,
    pauseUntil: typeof record.pauseUntil === "number" ? record.pauseUntil : null,
    starsAt: str(record.starsAt),
    repos,
  };
}

export async function saveRepos(dir: string, state: RepoState): Promise<void> {
  await new FileReaderStore(dir).write(KEY, state);
}

function record(state: RepoState, fullName: string, now: number): RepoRecord {
  const key = fullName.toLowerCase();
  state.repos[key] ??= {
    fullName, points: [], polledAt: null, meta: null, purpose: null, purposeTriedAt: null,
    dailyFirstSeen: null, dailyLastSeen: null, seenAt: new Date(now).toISOString(),
  };
  return state.repos[key]!;
}

/**
 * Notes which repos are on the lists now and forgets long-gone ones. A freshly fetched daily list also moves
 * the 常驻 count: the first day of an unbroken run on it.
 */
export function noteListed(state: RepoState, listed: readonly string[], freshDaily: readonly string[] | null, now: number): void {
  const at = new Date(now).toISOString();
  for (const name of listed) record(state, name, now).seenAt = at;
  for (const name of freshDaily ?? []) {
    const row = record(state, name, now);
    const last = row.dailyLastSeen ? Date.parse(row.dailyLastSeen) : null;
    if (!row.dailyFirstSeen || last === null || now - last > RESIDENT_GAP_MS) row.dailyFirstSeen = at;
    row.dailyLastSeen = at;
  }
  for (const [key, row] of Object.entries(state.repos)) if (now - Date.parse(row.seenAt) > FORGET_MS) delete state.repos[key];
}

/** Oldest poll first, never-polled first of all. */
export function pollQueue(state: RepoState, names: readonly string[]): string[] {
  const unique = [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];
  const at = (name: string) => {
    const polled = state.repos[name.toLowerCase()]?.polledAt;
    return polled ? Date.parse(polled) : -Infinity;
  };
  return unique.sort((a, b) => at(a) - at(b) || a.localeCompare(b));
}

/**
 * Reads the live star count, topics and creation date of the listed repos. With a token every listed repo
 * each run; without one about 40 an hour, oldest first. Stops until GitHub's reset time when it runs low.
 */
export async function pollRepos(
  state: RepoState,
  names: readonly string[],
  io: { now: () => number; repoFetch?: (fullName: string) => Promise<RepoFetchResult>; hasToken: boolean },
): Promise<{ polled: number; ok: number }> {
  if (!io.repoFetch) return { polled: 0, ok: 0 };
  const hour = Math.floor(io.now() / HOUR_MS);
  if (state.hourStart !== hour) {
    state.hourStart = hour;
    state.used = 0;
  }
  if (state.pauseUntil !== null && io.now() >= state.pauseUntil) state.pauseUntil = null;
  const budget = io.hasToken ? HOUR_BUDGET.token : HOUR_BUDGET.anonymous;
  let polled = 0, ok = 0;
  for (const name of pollQueue(state, names)) {
    if (state.pauseUntil !== null || state.used >= budget) break;
    let result: RepoFetchResult;
    try {
      result = await io.repoFetch(name);
    } catch {
      result = { status: 0, repo: null, remaining: null, resetAt: null };
    }
    state.used += 1;
    polled += 1;
    const now = io.now();
    const row = record(state, name, now);
    row.polledAt = new Date(now).toISOString();
    if (result.status === 200 && result.repo) {
      ok += 1;
      const last = row.points.at(-1);
      if (last && now - last[0] < POINT_GAP_MS) row.points[row.points.length - 1] = [now, result.repo.stars];
      else row.points.push([now, result.repo.stars]);
      row.points = row.points.filter(([at]) => now - at <= KEEP_POINTS_MS);
      row.meta = result.repo.meta;
      state.starsAt = row.polledAt;
    }
    const limited = result.status === 403 || result.status === 429 || (result.remaining !== null && result.remaining < LOW_REMAINING);
    if (limited) state.pauseUntil = result.resetAt && result.resetAt > now ? result.resetAt : (hour + 1) * HOUR_MS;
  }
  return { polled, ok };
}

export function purposeBasis(description: string, topics: readonly string[]): string {
  return createHash("sha256").update(`${description}\n${[...topics].sort().join(",")}`).digest("hex").slice(0, 16);
}

/**
 * Writes the purpose line for listed repos that lack one or whose description or topics changed, in the
 * given order (the caller puts 精选 first), a few per run. A repo waits for its topics when stars are polled.
 */
export async function describeRepos(
  state: RepoState,
  ordered: ReadonlyArray<{ fullName: string; description: string; language: string | null }>,
  io: { now: () => number; describe?: (input: PurposeInput) => Promise<PurposeOutput>; waitForMeta: boolean },
): Promise<{ written: number; failed: number }> {
  if (!io.describe) return { written: 0, failed: 0 };
  let written = 0, failed = 0;
  for (const item of ordered) {
    if (written + failed >= PURPOSE_PER_RUN) break;
    const now = io.now();
    const row = record(state, item.fullName, now);
    if (io.waitForMeta && !row.meta) continue;
    const description = row.meta?.description || item.description;
    const topics = row.meta?.topics ?? [];
    const basis = purposeBasis(description, topics);
    if (row.purpose?.basis === basis) continue;
    if (row.purposeTriedAt && now - Date.parse(row.purposeTriedAt) < PURPOSE_RETRY_MS) continue;
    try {
      const out = await io.describe({ fullName: row.fullName, description, topics, language: row.meta?.language ?? item.language, homepage: row.meta?.homepage ?? null });
      row.purpose = {
        text: out.purpose.trim(),
        category: out.category,
        secondary: out.secondary && out.secondary !== out.category ? out.secondary : null,
        basis,
        model: out.model,
        at: new Date(io.now()).toISOString(),
      };
      row.purposeTriedAt = null;
      written += 1;
    } catch (error) {
      if (error instanceof DescribeUnavailableError) break;
      row.purposeTriedAt = new Date(io.now()).toISOString();
      failed += 1;
    }
  }
  return { written, failed };
}

// Rules for repos the model has not described yet (or when model calls are off). Topics weigh 2, words in
// the name or description 1; the earlier category wins a tie.
const TOPIC_RULES: Record<Exclude<TrendCategory, "other">, ReadonlySet<string>> = {
  agent: new Set(["agent", "agents", "ai-agent", "ai-agents", "agentic", "agentic-ai", "autonomous-agents", "coding-agent", "llm-agent", "multi-agent", "computer-use", "computer-use-agent", "mcp", "mcp-server", "model-context-protocol", "claude-code", "claude-skills", "agent-skills", "codex", "cursor", "copilot"]),
  llm: new Set(["llm", "llms", "large-language-models", "rag", "langchain", "openai", "chatgpt", "gpt", "transformers", "inference", "fine-tuning", "embeddings", "deepseek", "ollama", "vllm", "machine-learning", "deep-learning", "ai", "artificial-intelligence", "generative-ai", "diffusion", "stable-diffusion", "multimodal", "tts", "speech-recognition", "pytorch", "robotics", "reinforcement-learning"]),
  devtools: new Set(["developer-tools", "devtools", "cli", "command-line", "terminal", "ide", "vscode", "vscode-extension", "neovim", "vim", "git", "github", "testing", "linter", "formatter", "compiler", "build-tool", "debugging", "code-review", "productivity", "sdk"]),
  infra: new Set(["kubernetes", "k8s", "docker", "devops", "infrastructure", "cloud", "serverless", "observability", "monitoring", "platform-engineering", "terraform", "networking", "proxy", "self-hosted", "homelab", "gpu", "linux", "operating-system", "wayland", "window-manager", "nvidia"]),
  data: new Set(["database", "sql", "postgresql", "postgres", "mysql", "sqlite", "redis", "vector-database", "data-engineering", "etl", "analytics", "data-visualization", "big-data", "scraping", "web-scraping", "crawler", "spreadsheet", "ontology", "knowledge-graph"]),
  frontend: new Set(["react", "vue", "svelte", "nextjs", "frontend", "css", "tailwindcss", "ui", "ui-components", "design-system", "design", "figma", "animation", "web-components"]),
  security: new Set(["security", "cybersecurity", "infosec", "pentest", "penetration-testing", "osint", "vulnerability", "malware", "reverse-engineering", "cryptography", "privacy", "ctf", "red-team"]),
  learning: new Set(["awesome", "awesome-list", "tutorial", "tutorials", "course", "learning", "education", "roadmap", "interview", "books", "resources", "cheatsheet", "guide", "examples"]),
};

const WORD_RULES: Record<Exclude<TrendCategory, "other">, RegExp> = {
  agent: /\bagents?\b|\bagentic\b|claude code|computer[- ]use|\bmcp\b|copilot|coding assistant|\bskills?\b/i,
  llm: /\bllms?\b|language models?|\brag\b|\binference\b|fine-?tun|embedding|transformer|diffusion|\bgpt\b|chatbot|\bai\b|machine learning|physics engine|robot/i,
  devtools: /\bcli\b|command[- ]line|\bterminal\b|\bide\b|\beditor\b|vs ?code|neovim|\bgit\b|worktree|\blint|formatter|compiler|debugg|code review|pull request|\bsdk\b/i,
  infra: /kubernetes|\bk8s\b|docker|container|devops|observability|monitoring|terraform|serverless|self-?host|homelab|\bgpu\b|cluster|\bproxy\b|\bvpn\b|operating system|window manager|compositor|management plane/i,
  data: /database|\bsql\b|postgres|sqlite|redis|vector (db|database|store)|\betl\b|analytics|dataset|scrap(e|er|ing)|crawl|spreadsheet|knowledge graph|ontology/i,
  frontend: /\breact\b|\bvue\b|svelte|next\.?js|front-?end|\bcss\b|tailwind|\bui\b|design system|component library|figma|landing page|animation/i,
  security: /security|\bosint\b|pentest|penetration|vulnerab|exploit|malware|reverse engineering|privacy|encrypt|\bctf\b|red team|social media accounts by username/i,
  learning: /awesome|tutorial|\bcourse\b|roadmap|interview|cheat ?sheet|curated list|collection of|\blearn|\bguide\b|examples|quickstart|\bbook\b/i,
};

export function classifyByRules(name: string, description: string, topics: readonly string[] | null): { category: TrendCategory; secondary: TrendCategory | null } {
  const scores = new Map<TrendCategory, number>();
  const text = `${name.replace(/[-_/]/g, " ")} ${description}`;
  for (const category of TREND_CATEGORIES) {
    if (category === "other") continue;
    let score = 0;
    for (const topic of topics ?? []) if (TOPIC_RULES[category].has(topic.toLowerCase())) score += 2;
    if (WORD_RULES[category].test(text)) score += 1;
    if (score > 0) scores.set(category, score);
  }
  const ranked = TREND_CATEGORIES.filter((c) => scores.has(c)).sort((a, b) => scores.get(b)! - scores.get(a)!);
  if (ranked.length === 0) return { category: "other", secondary: null };
  const top = scores.get(ranked[0]!)!;
  const second = ranked[1];
  return { category: ranked[0]!, secondary: second && scores.get(second)! * 2 >= top ? second : null };
}

/** Stars gained over the last hour of polls: null until the polls span at least 50 minutes. */
export function starsLastHour(points: ReadonlyArray<[number, number]>): number | null {
  const last = points.at(-1);
  if (!last) return null;
  let base: [number, number] | undefined;
  for (const point of points) if (point[0] <= last[0] - HOUR_MS) base = point;
  if (!base) {
    const first = points[0]!;
    if (last[0] - first[0] < 50 * 60 * 1000) return null;
    base = first;
  }
  return last[1] - base[1];
}

/** The count at each of the last 24 hours (the latest point last), skipping hours before the first poll. */
export function hourlySpark(points: ReadonlyArray<[number, number]>): number[] {
  const last = points.at(-1);
  if (!last) return [];
  const out: number[] = [];
  for (let h = 24; h >= 0; h -= 1) {
    const at = last[0] - h * HOUR_MS;
    let value: number | null = null;
    for (const point of points) if (point[0] <= at) value = point[1];
    if (value !== null) out.push(value);
  }
  return out;
}

export interface Listed {
  since: TrendSince;
  items: readonly TrendItem[];
  /** Repos on all three lists, lowercase. */
  triple: ReadonlySet<string>;
  /** The order this ranking replaced (rank 1 first); null before the order has ever changed. */
  previous?: readonly string[] | null;
}

/**
 * Decorates a list from the repo state, marks each repo's move against the ranking this one replaced, and
 * picks the 精选: the top three by period stars that are not 常驻.
 */
export function decorateList(state: RepoState, listed: Listed, now: number): { items: TrendItem[]; featured: string[] } {
  const before = listed.previous ? new Map(listed.previous.map((name, i) => [name.toLowerCase(), i + 1])) : null;
  const items = listed.items.map((item, index): TrendItem => {
    const rankPrev = before?.get(item.fullName.toLowerCase()) ?? null;
    const rank = index + 1;
    const row = state.repos[item.fullName.toLowerCase()];
    const latest = row?.points.at(-1);
    const total = latest ? latest[1] : item.starsTotal;
    const topics = row?.meta?.topics ?? null;
    const description = row?.meta?.description || item.description;
    const ruled = classifyByRules(item.fullName, description, topics);
    const purpose = row?.purpose ?? null;
    const createdAt = row?.meta?.createdAt ?? null;
    const badges: TrendBadge[] = [];
    if (createdAt && now - Date.parse(createdAt) <= 30 * 24 * HOUR_MS) badges.push("new");
    if (total && total > 0 && item.starsPeriod * 3 >= total) badges.push("surge");
    if (listed.since === "daily" && row?.dailyFirstSeen && now - Date.parse(row.dailyFirstSeen) >= RESIDENT_DAYS * 24 * HOUR_MS) badges.push("resident");
    if (listed.triple.has(item.fullName.toLowerCase())) badges.push("triple");
    return {
      ...item,
      description,
      language: row?.meta?.language ?? item.language,
      starsTotal: total,
      starsHour: row ? starsLastHour(row.points) : null,
      spark: row ? hourlySpark(row.points) : [],
      category: purpose?.category ?? ruled.category,
      secondary: purpose ? purpose.secondary : ruled.secondary,
      purpose: purpose?.text ?? null,
      topics,
      createdAt,
      badges,
      rankPrev,
      rankChange: before === null ? null : rankPrev === null ? "new" : rankPrev > rank ? "up" : rankPrev < rank ? "down" : "same",
    };
  });
  const featured = items.filter((item) => !item.badges.includes("resident")).slice(0, 3).map((item) => item.fullName);
  return { items, featured };
}
