import { mkdir, readFile, rename, writeFile, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ReadResult } from "../contracts.ts";
import { object, timestamp } from "./validate.ts";

export interface ReaderStore {
  read(key: string): Promise<unknown | null>;
  write(key: string, value: unknown): Promise<void>;
}
/** Only projected content, validators and cooldown state are persisted, never request headers. */
export class FileReaderStore implements ReaderStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  private file(key: string): string {
    if (!/^[a-z][a-z0-9-]{0,60}$/.test(key)) throw new Error("Invalid cache key");
    return path.join(this.directory, `${key}.json`);
  }
  async read(key: string): Promise<unknown | null> {
    const file = this.file(key);
    try {
      if ((await stat(file)).size > 16 * 1024 * 1024) return null;
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async write(key: string, value: unknown): Promise<void> {
    const file = this.file(key), temporary = `${file}.${randomUUID()}.tmp`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => {}); }
  }
}

interface Snapshot<T> {
  version: 1;
  data: T | null;
  fetchedAt: string | null;
  nextRefreshAt: string;
  etag: string | null;
  message: string | null;
  quotaWindowStart: number | null;
  requestCount: number;
  /** When a reader last asked for a pull now (the AA page's button), for its cooldown. */
  forcedAt: string | null;
  /** The upstream's own count of what is left in its window, and when the window resets (from its headers). */
  remaining: number | null;
  resetAt: number | null;
}
export class UpstreamError extends Error {
  readonly status: number;
  readonly retryAt: number | null;
  constructor(status: number, retryAt: number | null = null) { super(`Reader upstream HTTP ${status}`); this.status = status; this.retryAt = retryAt; }
}
export interface LoadContext {
  etag: string | null;
  /** Reserve and persist one AA request before sending it, including each pagination call. */
  reserveAaRequest(): Promise<void>;
  /** What the upstream said is left of its window (X-RateLimit-Remaining / -Reset); kept with the snapshot. */
  noteQuota(remaining: number | null, resetAt: number | null): void;
}
export interface Loaded<T> { data: T | null; etag: string | null; notModified?: boolean }

/** AA's free tier: 100 requests in a fixed 24-hour window that starts with the first request. */
export const QUOTA_LIMIT = 100;
const QUOTA_WINDOW_MS = 86_400_000;

export interface QuotaView { remaining: number; limit: number; resetAt: number | null }
export interface ManualRules<T> {
  cooldownMs: number;
  /** Requests a complete pull takes, from the snapshot it would replace. */
  cost: (data: T | null) => number;
}
export interface ManualOutcome<T> {
  result: ReadResult<T>;
  refused: null | { reason: "cooldown" | "quota"; until: string | null };
  /** The snapshot before the pull, to tell what changed. */
  before: T | null;
}

/** One process, demand-driven reads only. Persist the cooldown before attempting an upstream call. */
export class ReaderCache {
  private memory = new Map<string, Snapshot<unknown>>();
  private inflight = new Map<string, Promise<ReadResult<unknown>>>();
  private store: ReaderStore;
  private now: () => number;
  constructor(store: ReaderStore, now: () => number) { this.store = store; this.now = now; }

  async get<T>(key: string, sourceUrl: string, ttl: number, restore: (value: unknown) => T, load: (context: LoadContext) => Promise<Loaded<T>>): Promise<ReadResult<T>> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<ReadResult<T>>;
    const work = (async () => {
      const state = await this.restoreState(key, restore);
      if (Date.parse(state.nextRefreshAt) > this.now()) return this.view(state, sourceUrl);
      return this.pull(key, state, sourceUrl, ttl, load);
    })();
    this.inflight.set(key, work as Promise<ReadResult<unknown>>);
    try { return await work; } finally { this.inflight.delete(key); }
  }

  /**
   * A reader's explicit "pull now" (the AA page's button): ignores the TTL, but not the cooldown between such
   * pulls, nor a window too spent for a complete pull, so a click can never leave a half-fetched list. It waits
   * for a read or pull already under way: two clicks at once pull once, and the cooldown answers the second.
   */
  async refresh<T>(key: string, sourceUrl: string, ttl: number, restore: (value: unknown) => T, load: (context: LoadContext) => Promise<Loaded<T>>, rules: ManualRules<T>): Promise<ManualOutcome<T>> {
    for (let running = this.inflight.get(key); running; running = this.inflight.get(key)) await running.catch(() => null);
    const work = this.manual(key, sourceUrl, ttl, restore, load, rules);
    const result = work.then((outcome) => outcome.result);
    result.catch(() => {});
    this.inflight.set(key, result as Promise<ReadResult<unknown>>);
    try { return await work; } finally { this.inflight.delete(key); }
  }

  private async manual<T>(key: string, sourceUrl: string, ttl: number, restore: (value: unknown) => T, load: (context: LoadContext) => Promise<Loaded<T>>, rules: ManualRules<T>): Promise<ManualOutcome<T>> {
    const state = await this.restoreState(key, restore);
    const now = this.now();
    const before = state.data;
    if (state.forcedAt && now - Date.parse(state.forcedAt) < rules.cooldownMs) {
      return { result: this.view(state, sourceUrl), refused: { reason: "cooldown", until: new Date(Date.parse(state.forcedAt) + rules.cooldownMs).toISOString() }, before };
    }
    const quota = this.quotaOf(state, now);
    if (quota.remaining < rules.cost(state.data)) {
      return { result: this.view(state, sourceUrl), refused: { reason: "quota", until: quota.resetAt === null ? null : new Date(quota.resetAt).toISOString() }, before };
    }
    state.forcedAt = new Date(now).toISOString();
    return { result: await this.pull(key, state, sourceUrl, ttl, load), refused: null, before };
  }

  /** The cached state as the page reports it: what is left of the window and when a manual pull is allowed again. */
  async status<T>(key: string, restore: (value: unknown) => T): Promise<{ quota: QuotaView; forcedAt: string | null; data: T | null }> {
    const state = await this.restoreState(key, restore);
    return { quota: this.quotaOf(state, this.now()), forcedAt: state.forcedAt, data: state.data };
  }

  /** The upstream's own count while its window has not reset, else ours. */
  private quotaOf(state: Snapshot<unknown>, now: number): QuotaView {
    if (state.remaining !== null && state.resetAt !== null && state.resetAt > now) return { remaining: state.remaining, limit: QUOTA_LIMIT, resetAt: state.resetAt };
    if (state.quotaWindowStart !== null && now < state.quotaWindowStart + QUOTA_WINDOW_MS) {
      return { remaining: Math.max(0, QUOTA_LIMIT - state.requestCount), limit: QUOTA_LIMIT, resetAt: state.quotaWindowStart + QUOTA_WINDOW_MS };
    }
    return { remaining: QUOTA_LIMIT, limit: QUOTA_LIMIT, resetAt: null };
  }

  private view<T>(state: Snapshot<T>, sourceUrl: string): ReadResult<T> {
    return { status: state.data === null ? "unavailable" : state.message ? "stale" : "ready", sourceUrl, fetchedAt: state.fetchedAt, nextRefreshAt: state.nextRefreshAt, message: state.message, data: state.data };
  }

  private async restoreState<T>(key: string, restore: (value: unknown) => T): Promise<Snapshot<T>> {
    let state = this.memory.get(key) as Snapshot<T> | undefined;
    if (!state) {
      try {
        const saved = await this.store.read(key);
        if (saved !== null) {
          const x = object(saved);
          if (x.version !== 1 || (x.etag !== null && (typeof x.etag !== "string" || x.etag.length > 1024 || /[\r\n]/.test(x.etag))) || (x.message !== null && typeof x.message !== "string")) throw new Error("Invalid cache envelope");
          const fetchedAt = x.fetchedAt === null ? null : timestamp(x.fetchedAt);
          const nextRefreshAt = timestamp(x.nextRefreshAt);
          if (typeof x.requestCount !== "number" || !Number.isSafeInteger(x.requestCount) || x.requestCount < 0 || x.requestCount > QUOTA_LIMIT || (x.quotaWindowStart !== null && (typeof x.quotaWindowStart !== "number" || !Number.isFinite(x.quotaWindowStart)))) throw new Error("Invalid quota state");
          state = {
            version: 1, data: x.data === null ? null : restore(x.data), fetchedAt, nextRefreshAt, etag: x.etag as string | null, message: x.message as string | null,
            quotaWindowStart: x.quotaWindowStart as number | null, requestCount: x.requestCount,
            // Absent in snapshots written before 2026-11-10.
            forcedAt: typeof x.forcedAt === "string" && Number.isFinite(Date.parse(x.forcedAt)) ? x.forcedAt : null,
            remaining: typeof x.remaining === "number" && Number.isSafeInteger(x.remaining) && x.remaining >= 0 ? x.remaining : null,
            resetAt: typeof x.resetAt === "number" && Number.isFinite(x.resetAt) ? x.resetAt : null,
          };
          if ((state.data === null) !== (state.fetchedAt === null)) throw new Error("Incomplete cache envelope");
        }
      } catch { state = undefined; }
    }
    state ??= { version: 1, data: null, fetchedAt: null, nextRefreshAt: new Date(0).toISOString(), etag: null, message: null, quotaWindowStart: null, requestCount: 0, forcedAt: null, remaining: null, resetAt: null };
    this.memory.set(key, state);
    return state;
  }

  private async pull<T>(key: string, state: Snapshot<T>, sourceUrl: string, ttl: number, load: (context: LoadContext) => Promise<Loaded<T>>): Promise<ReadResult<T>> {
    const now = this.now();
    state.nextRefreshAt = new Date(now + ttl).toISOString();
    state.message = "刷新尚未完成；保留上次成功内容，冷却后再核验。";
    try {
      // A failed disk write prevents the fetch: restart must not bypass a request reservation.
      await this.store.write(key, state);
      const loaded = await load({
        etag: state.etag,
        reserveAaRequest: async () => {
          const at = this.now();
          if (state.quotaWindowStart === null || at >= state.quotaWindowStart + QUOTA_WINDOW_MS) {
            state.quotaWindowStart = at;
            state.requestCount = 0;
          }
          if (state.requestCount >= QUOTA_LIMIT) throw new UpstreamError(429, state.quotaWindowStart + QUOTA_WINDOW_MS);
          state.requestCount += 1;
          await this.store.write(key, state);
        },
        noteQuota: (remaining, resetAt) => {
          if (remaining !== null && resetAt !== null) { state.remaining = remaining; state.resetAt = resetAt; }
        },
      });
      if (loaded.notModified && state.data === null) throw new Error("304 without snapshot");
      const next = loaded.notModified ? state.data : loaded.data;
      if (next === null) throw new Error("Empty snapshot");
      const success: Snapshot<T> = { ...state, data: next, fetchedAt: new Date(this.now()).toISOString(), nextRefreshAt: new Date(Math.max(Date.parse(state.nextRefreshAt), this.now() + ttl)).toISOString(), etag: loaded.etag, message: null };
      // Commit in memory only after the validated complete snapshot is safely persisted.
      await this.store.write(key, success);
      this.memory.set(key, success);
      return this.view(success, sourceUrl);
    } catch (error) {
      state.nextRefreshAt = new Date(Math.max(Date.parse(state.nextRefreshAt), this.now() + ttl)).toISOString();
      if (error instanceof UpstreamError && error.retryAt !== null) state.nextRefreshAt = new Date(Math.max(Date.parse(state.nextRefreshAt), error.retryAt)).toISOString();
      state.message = error instanceof UpstreamError && error.status === 429 ? "来源请求限流，已暂停刷新；保留上次成功内容。" : "来源暂不可用或返回结构未通过验证；保留上次成功内容。";
      await this.store.write(key, state).catch(() => {});
      return this.view(state, sourceUrl);
    }
  }
}
