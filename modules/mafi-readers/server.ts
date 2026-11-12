import path from "node:path";
import type { ServerModule } from "@aihot/backend/modules";
import { config } from "@aihot/backend/config";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { codexResetEnabled, githubTrendEnabled } from "./flags.ts";
import { FileReaderStore } from "./backend/cache.ts";
import { createReaders, type Readers } from "./backend/readers.ts";
import { isTrendSince, readGithubTrend, refreshGithubTrend, type TrendFetchResult } from "./backend/github-trend.ts";
import type { PurposeInput, PurposeOutput, RepoFetchResult } from "./backend/github-repos.ts";
import { PURPOSE_RECEIPT } from "./backend/github-purpose.ts";

export interface TrendControls {
  dir: string;
  now: () => number;
  fetch: (url: string) => Promise<TrendFetchResult>;
  repoFetch?: (fullName: string) => Promise<RepoFetchResult>;
  hasToken: () => boolean;
  describe?: (input: PurposeInput) => Promise<PurposeOutput>;
  enabled: () => boolean;
  authenticate: (cookie: string | undefined) => Promise<{ csrf: string } | null>;
}

async function fetchTrending(url: string): Promise<TrendFetchResult> {
  const target = new URL(url);
  const since = target.searchParams.get("since");
  if (target.protocol !== "https:" || target.hostname !== "github.com" || target.pathname !== "/trending" || !isTrendSince(since) || target.username || target.password || target.port) {
    throw new Error("Invalid trending destination");
  }
  const response = await guardedFetch(url, {
    method: "GET",
    timeoutMs: 15_000,
    maxBytes: 2_000_000,
    maxRedirects: 2,
    redirectPolicy: "same-origin",
    headers: { accept: "text/html" },
  });
  return { status: response.status, body: response.text(), retryAfter: response.headers.get("retry-after") };
}

function githubToken(): string | null {
  return process.env.GITHUB_TOKEN?.trim() || null;
}

/** One repo from the GitHub API: the live star count and what the page shows about it. The token never leaves this request. */
async function fetchRepo(fullName: string): Promise<RepoFetchResult> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo || owner === "." || owner === ".." || repo === "." || repo === "..") throw new Error("Invalid repository");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "mafi-readers" };
  const token = githubToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await guardedFetch(url, { method: "GET", timeoutMs: 15_000, maxBytes: 1_000_000, maxRedirects: 0, headers });
  const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? NaN);
  const reset = Number(response.headers.get("x-ratelimit-reset") ?? NaN);
  let found: RepoFetchResult["repo"] = null;
  if (response.status === 200) {
    try {
      const data = JSON.parse(response.text()) as Record<string, unknown>;
      const stars = data.stargazers_count;
      if (typeof stars === "number" && Number.isSafeInteger(stars) && stars >= 0) {
        found = {
          stars,
          meta: {
            description: typeof data.description === "string" ? data.description : "",
            topics: Array.isArray(data.topics) ? data.topics.filter((topic): topic is string => typeof topic === "string") : [],
            language: typeof data.language === "string" ? data.language : null,
            createdAt: typeof data.created_at === "string" ? data.created_at : null,
            homepage: typeof data.homepage === "string" && /^https?:\/\//.test(data.homepage) ? data.homepage : null,
            archived: data.archived === true,
          },
        };
      }
    } catch {
      found = null;
    }
  }
  return {
    status: response.status,
    repo: found,
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetAt: Number.isFinite(reset) ? reset * 1000 : null,
  };
}

async function describe(input: PurposeInput): Promise<PurposeOutput> {
  const { describeWithModel } = await import("./backend/github-purpose.ts");
  return describeWithModel(input);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A button on this site's own page, not another site's form or script: the browser's Origin (or, without one,
 * Sec-Fetch-Site) must be the site, and the custom header makes any other origin's fetch stop at a CORS
 * preflight this server never answers. The local site counts localhost and 127.0.0.1 as the same host.
 */
function fromOwnPage(origin: string | undefined, fetchSite: string | undefined, action: string | undefined): boolean {
  if (action !== "refresh") return false;
  if (origin) {
    try {
      const site = new URL(config.siteUrl), from = new URL(origin);
      const sameHost = from.hostname === site.hostname || (LOOPBACK.has(from.hostname) && LOOPBACK.has(site.hostname));
      return from.protocol === site.protocol && from.port === site.port && sameHost;
    } catch {
      return false;
    }
  }
  return fetchSite === "same-origin";
}

async function defaultAuthenticate(cookie: string | undefined): Promise<{ csrf: string } | null> {
  const { sessionPrincipal } = await import("@aihot/backend/admin/auth");
  const admin = await sessionPrincipal(cookie);
  return admin ? { csrf: admin.csrf } : null;
}

function trendControls(partial?: Partial<TrendControls>): TrendControls {
  return {
    dir: partial?.dir ?? path.join(config.dataDir, "mafi-readers"),
    now: partial?.now ?? Date.now,
    fetch: partial?.fetch ?? fetchTrending,
    // Tests pass their own; leaving one out there means "no GitHub API" and "no model", never the real ones.
    repoFetch: partial ? partial.repoFetch : fetchRepo,
    hasToken: partial?.hasToken ?? (() => githubToken() !== null),
    describe: partial ? partial.describe : describe,
    enabled: partial?.enabled ?? githubTrendEnabled,
    authenticate: partial?.authenticate ?? defaultAuthenticate,
  };
}

export function createReaderServer(readers?: Readers, trend?: Partial<TrendControls>): ServerModule {
  let service = readers;
  const controls = trendControls(trend);
  const getReaders = () => service ??= createReaders({
    siteUrl: config.siteUrl,
    aaKey: () => process.env.AA_API_KEY,
    fetch: guardedFetch,
    store: new FileReaderStore(path.join(config.dataDir, "mafi-readers")),
    codexEnabled: codexResetEnabled,
  });
  // The admin's forced run is an API request: it fetches lists and stars, and leaves the purpose lines to
  // the worker's next tick, since models are called only in worker jobs.
  const io = (mode: "due" | "force") => ({
    dir: controls.dir, now: controls.now, fetch: controls.fetch, repoFetch: controls.repoFetch, hasToken: controls.hasToken(),
    describe: mode === "due" ? controls.describe : undefined, enabled: controls.enabled(), mode,
  });
  return {
    name: "mafi-readers",
    models: {
      githubPurpose: { label: "GitHub 趋势用途（给上榜仓库写一句中文用途并归类）", env: "GITHUB_PURPOSE_MODEL", purposes: [PURPOSE_RECEIPT] },
    },
    // Every 5 minutes: live stars each tick; the trending pages only when their window is due.
    schedules: [{
      name: "readers.github-trend",
      cron: "*/5 * * * *",
      when: githubTrendEnabled,
      run: () => refreshGithubTrend(io("due")),
    }],
    http(app) {
      app.addHook("onRequest", async (request, reply) => {
        if (request.url.split("?")[0].startsWith("/api/mafi-readers/")) {
          reply.header("Cache-Control", "private, no-store");
          reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
        }
      });
      app.get("/api/mafi-readers/codex-resets", async () => getReaders().codexResets());
      app.get("/api/mafi-readers/aa-models", async () => getReaders().aaModels());
      app.post("/api/mafi-readers/aa-models/refresh", async (request, reply) => {
        const header = (name: string) => { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; };
        if (!fromOwnPage(header("origin"), header("sec-fetch-site"), header("x-mafi-action"))) return reply.code(403).send({ message: "只接受本站 AA 页面上的按钮发起拉取" });
        const result = await getReaders().aaRefresh();
        return reply.code(result.refused ? 429 : 200).send(result);
      });
      app.get("/api/mafi-readers/github-trending", async (request, reply) => {
        const since = (request.query as { since?: string }).since ?? "daily";
        if (!isTrendSince(since)) return reply.code(400).send({ message: "since 只能是 daily、weekly 或 monthly" });
        return readGithubTrend({ ...io("due"), since });
      });
      app.post("/api/admin/mafi-readers/github-trending/refresh", async (request, reply) => {
        reply.header("Cache-Control", "private, no-store");
        const admin = await controls.authenticate(request.headers.cookie);
        if (!admin) return reply.code(401).send({ message: "需要管理员登录" });
        const csrf = request.headers["x-csrf-token"];
        if (csrf !== admin.csrf) return reply.code(403).send({ message: "缺少或过期的 CSRF token" });
        const result = await refreshGithubTrend(io("force"));
        if (!result.ok && result.reason === "locked") return reply.code(409).send(result);
        if (!result.ok && result.reason === "cooldown") return reply.code(429).send(result);
        return result;
      });
    },
  };
}

export default createReaderServer();
