import path from "node:path";
import type { ServerModule } from "@aihot/backend/modules";
import { config } from "@aihot/backend/config";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { codexResetEnabled, githubTrendEnabled } from "./flags.ts";
import { FileReaderStore } from "./backend/cache.ts";
import { createReaders, type Readers } from "./backend/readers.ts";
import { isTrendSince, readGithubTrend, refreshGithubTrend, type TopicFetchResult, type TrendFetchResult, type TrendSince } from "./backend/github-trend.ts";

export interface TrendControls {
  dir: string;
  now: () => number;
  fetch: (url: string) => Promise<TrendFetchResult>;
  topicFetch?: (fullName: string) => Promise<TopicFetchResult>;
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

async function fetchTopics(fullName: string): Promise<TopicFetchResult> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo || owner === "." || owner === ".." || repo === "." || repo === "..") throw new Error("Invalid repository");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/topics`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "mafi-readers" };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await guardedFetch(url, { method: "GET", timeoutMs: 15_000, maxBytes: 1_000_000, maxRedirects: 0, headers });
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  let topics: string[] | null = null;
  if (response.status === 200) {
    try {
      const parsed = JSON.parse(response.text()) as { names?: unknown };
      topics = Array.isArray(parsed.names) ? parsed.names.filter((name): name is string => typeof name === "string") : [];
    } catch {
      topics = null;
    }
  }
  return {
    status: response.status,
    topics,
    retryAfter: response.headers.get("retry-after"),
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetAt: Number.isFinite(reset) ? reset * 1000 : null,
  };
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
    topicFetch: partial ? partial.topicFetch : fetchTopics,
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
  const io = (mode: "due" | "force") => ({ dir: controls.dir, now: controls.now, fetch: controls.fetch, topicFetch: controls.topicFetch, enabled: controls.enabled(), mode });
  return {
    name: "mafi-readers",
    schedules: [{
      name: "readers.github-trend",
      cron: "*/30 * * * *",
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
