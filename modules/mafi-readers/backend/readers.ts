import type { AaData, AaRefreshResult, CodexData, ReadResult, RefreshInfo } from "../contracts.ts";
import type { GuardedFetchOptions, GuardedResponse } from "@aihot/backend/lib/http-fetch";
import { ReaderCache, UpstreamError, type LoadContext, type Loaded, type ReaderStore } from "./cache.ts";
import { parseAaPage, parseAaStored, parseCodex, recentCodex } from "./validate.ts";

export const AA_SOURCE = "https://artificialanalysis.ai/zh";
export const AUTHOR_SOURCE = "https://aihot.news";
const CODEX_URL = `${AUTHOR_SOURCE}/api/v1/codex-resets/recent`;
const AA_URL = "https://artificialanalysis.ai/api/v2/language/models/free";
const AA_TTL_MS = 86_400_000;
/** Between two pulls from the AA page's button: the list changes a few times a day at most. */
export const AA_MANUAL_COOLDOWN_MS = 5 * 60_000;
const AA_MAX_PAGES = 12;
export type ReaderFetch = (url: string, options: GuardedFetchOptions) => Promise<GuardedResponse>;
export interface ReaderOptions {
  siteUrl: string;
  aaKey?: () => string | undefined;
  fetch: ReaderFetch;
  store: ReaderStore;
  now?: () => number;
  /** When omitted, only the exact env string true turns Tibo collection back on. */
  codexEnabled?: () => boolean;
}
export function isLocalSite(siteUrl: string): boolean {
  try {
    const u = new URL(siteUrl);
    return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch { return false; }
}
function blocked<T>(sourceUrl: string, status: "local_only" | "needs_key"): ReadResult<T> {
  return { status, sourceUrl, fetchedAt: null, nextRefreshAt: null, message: status === "local_only" ? "该外部阅读器仅供本机个人使用，请将可信 SITE_URL 配为本机地址。" : "尚未配置 AA_API_KEY；可打开 Artificial Analysis 官方网站查看。", data: null };
}
function etag(response: GuardedResponse): string | null {
  const tag = response.headers.get("etag");
  return tag && tag.length <= 1024 && !/[\r\n]/.test(tag) ? tag : null;
}
export function createReaders(options: ReaderOptions) {
  const now = options.now ?? Date.now;
  const cache = new ReaderCache(options.store, now);
  async function request(url: string, headers: Record<string, string>, noteQuota?: LoadContext["noteQuota"]): Promise<GuardedResponse> {
    // URLs are assembled here only, never from upstream content or query-string addresses.
    const target = new URL(url);
    if (target.protocol !== "https:" || !["aihot.news", "artificialanalysis.ai"].includes(target.hostname) || target.username || target.password || target.port) throw new Error("Invalid reader destination");
    const response = await options.fetch(url, { method: "GET", headers: { "user-agent": "aihot-api/2.0.0", accept: "application/json", ...headers }, timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024, maxRedirects: 0, redirectPolicy: "same-origin" });
    noteQuota?.(...rateLimit(response));
    if (response.status !== 200 && response.status !== 304) {
      const retry = response.headers.get("retry-after");
      const parsed = retry && /^\d+$/.test(retry) ? now() + Number(retry) * 1000 : retry ? Date.parse(retry) : NaN;
      throw new UpstreamError(response.status, Number.isFinite(parsed) ? Math.min(Math.max(parsed, now()), now() + 30 * 86_400_000) : null);
    }
    if (response.truncated) throw new Error("Truncated reader response");
    return response;
  }
  return {
    async codexResets(): Promise<ReadResult<CodexData>> {
      const enabled = options.codexEnabled ? options.codexEnabled() : process.env.MAFI_CODEX_RESET_ENABLED === "true";
      if (!enabled) {
        let data: CodexData | null = null;
        let fetchedAt: string | null = null;
        try {
          const saved = await options.store.read("codex-resets");
          if (saved && typeof saved === "object") {
            const record = saved as { data?: unknown; fetchedAt?: unknown };
            if (record.data != null) data = recentCodex(parseCodex(record.data, true), now());
            fetchedAt = typeof record.fetchedAt === "string" ? record.fetchedAt : null;
          }
        } catch { data = null; fetchedAt = null; }
        return { status: "paused", sourceUrl: AUTHOR_SOURCE + "/codex-reset", fetchedAt, nextRefreshAt: null, message: "Tibo 重置监控已暂停，未请求上游。", data };
      }
      if (!isLocalSite(options.siteUrl)) return blocked(AUTHOR_SOURCE + "/codex-reset", "local_only");
      const result = await cache.get("codex-resets", AUTHOR_SOURCE + "/codex-reset", 600_000, (v) => parseCodex(v, true), async ({ etag: tag }) => {
        const response = await request(CODEX_URL, tag ? { "if-none-match": tag } : {});
        return { data: response.status === 304 ? null : parseCodex(JSON.parse(response.text())), etag: response.status === 304 ? etag(response) ?? tag : etag(response), notModified: response.status === 304 };
      });
      return { ...result, data: result.data ? recentCodex(result.data, now()) : null };
    },
    async aaModels(): Promise<ReadResult<AaData>> {
      if (!isLocalSite(options.siteUrl)) return blocked(AA_SOURCE, "local_only");
      const key = options.aaKey?.()?.trim();
      if (!key) return blocked(AA_SOURCE, "needs_key");
      const result = await cache.get("aa-models", AA_SOURCE, AA_TTL_MS, parseAaStored, (context) => loadAa(key, context));
      return { ...result, refresh: await aaRefreshInfo() };
    },
    /**
     * The AA page's "pull now": a complete fetch right away, unless one ran in the last 5 minutes or AA's window
     * has fewer requests left than a complete list takes. Says which models are new against the list it replaced.
     */
    async aaRefresh(): Promise<AaRefreshResult> {
      if (!isLocalSite(options.siteUrl)) return { ...summary(blocked(AA_SOURCE, "local_only")), refused: null, added: [], addedCount: 0, removedCount: 0 };
      const key = options.aaKey?.()?.trim();
      if (!key) return { ...summary(blocked(AA_SOURCE, "needs_key")), refused: null, added: [], addedCount: 0, removedCount: 0 };
      const outcome = await cache.refresh("aa-models", AA_SOURCE, AA_TTL_MS, parseAaStored, (context) => loadAa(key, context), {
        cooldownMs: AA_MANUAL_COOLDOWN_MS,
        cost: (data) => data?.pages ?? AA_MAX_PAGES,
      });
      const after = outcome.result.data;
      const pulled = outcome.refused === null && after !== null && after !== outcome.before;
      const old = new Set((outcome.before?.models ?? []).map((model) => model.id));
      const fresh = new Set((after?.models ?? []).map((model) => model.id));
      const added = pulled && outcome.before ? (after!.models).filter((model) => !old.has(model.id)) : [];
      return {
        ...summary({ ...outcome.result, refresh: await aaRefreshInfo() }),
        refused: outcome.refused,
        added: added.slice(0, 20).map((model) => ({ id: model.id, name: model.name })),
        addedCount: added.length,
        removedCount: pulled && outcome.before ? [...old].filter((id) => !fresh.has(id)).length : 0,
      };
    },
  };

  async function loadAa(key: string, { reserveAaRequest, noteQuota }: LoadContext): Promise<Loaded<AaData>> {
    let complete: AaData | null = null;
    let pageSize: number | null = null;
    let totalPages: number | null = null;
    const seen = new Set<string>();
    for (let page = 1; page <= AA_MAX_PAGES; page++) {
      await reserveAaRequest();
      // Never conditionally validate just page 1: that cannot establish all pages are unchanged.
      const response = await request(`${AA_URL}?page=${page}`, { "x-api-key": key }, noteQuota);
      if (response.status !== 200) throw new Error("Unexpected AA 304 without complete page validation");
      const parsed = parseAaPage(JSON.parse(response.text()));
      if (parsed.page !== page || parsed.totalPages > AA_MAX_PAGES) throw new Error("AA page limit or index mismatch");
      if (!complete) { complete = { tier: parsed.tier, intelligence_index_version: parsed.version, models: [], pages: parsed.totalPages }; pageSize = parsed.pageSize; totalPages = parsed.totalPages; }
      if (complete.intelligence_index_version !== parsed.version || complete.tier !== parsed.tier || pageSize !== parsed.pageSize || totalPages !== parsed.totalPages) throw new Error("AA pagination changed during refresh");
      for (const model of parsed.models) {
        if (seen.has(model.id)) throw new Error("Duplicate AA model identity");
        seen.add(model.id);
        complete.models.push(model);
      }
      if (!parsed.hasMore) return { data: complete, etag: null };
    }
    throw new Error("Incomplete AA model list");
  }

  async function aaRefreshInfo(): Promise<RefreshInfo> {
    const { quota, forcedAt, data } = await cache.status("aa-models", parseAaStored);
    const after = forcedAt ? Date.parse(forcedAt) + AA_MANUAL_COOLDOWN_MS : null;
    return {
      remaining: quota.remaining,
      limit: quota.limit,
      resetAt: quota.resetAt === null ? null : new Date(quota.resetAt).toISOString(),
      cost: data?.pages ?? AA_MAX_PAGES,
      manualAfter: after !== null && after > now() ? new Date(after).toISOString() : null,
    };
  }
}

/** X-RateLimit-Remaining / X-RateLimit-Reset (Unix seconds); null when either is missing or odd. */
function rateLimit(response: GuardedResponse): [number | null, number | null] {
  const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? NaN);
  const reset = Number(response.headers.get("x-ratelimit-reset") ?? NaN);
  if (!Number.isSafeInteger(remaining) || remaining < 0 || !Number.isFinite(reset) || reset <= 0) return [null, null];
  return [remaining, reset < 1e12 ? reset * 1000 : reset];
}

/** The refresh answer leaves the model list out: the page reads it again through its loader. */
function summary(result: ReadResult<AaData>): Omit<AaRefreshResult, "refused" | "added" | "addedCount" | "removedCount"> {
  return { status: result.status, fetchedAt: result.fetchedAt, message: result.message, total: result.data?.models.length ?? null, refresh: result.refresh ?? null };
}
export type Readers = ReturnType<typeof createReaders>;
