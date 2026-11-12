import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import type { GuardedFetchOptions, GuardedResponse } from "@aihot/backend/lib/http-fetch";
import { FileReaderStore, type ReaderStore } from "../backend/cache.ts";
import { createReaders, isLocalSite, type ReaderFetch } from "../backend/readers.ts";
import { config } from "@aihot/backend/config";
import { createReaderServer } from "../server.ts";
import { parseCodex, recentCodex } from "../backend/validate.ts";

const AT = Date.parse("2026-10-22T12:00:00Z");
const ISO = new Date(AT).toISOString();
class MemoryStore implements ReaderStore {
  values = new Map<string, unknown>();
  async read(key: string) { return structuredClone(this.values.get(key) ?? null); }
  async write(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
}
function response(value: unknown, status = 200, headers: Record<string, string> = {}): GuardedResponse {
  const body = Buffer.from(JSON.stringify(value));
  return { status, headers: new Headers(headers), body, url: "https://aihot.news/", truncated: false, text: () => body.toString() };
}
function codex() {
  return { schemaVersion: 1, timezone: "Asia/Shanghai", today: "2026-10-22", checkedAt: "2026-10-22T19:00:00+08:00", historyFrom: "2026-10-15T00:00:00+08:00", count: 1, events: [{ id: "reset-one", type: "direct_reset", label: "全员重置", displayLabel: "重置（形式未明确）", presentation: { status: "announced", scopeKnown: false, scopeLabel: null, kindExplicit: false, timeInferred: true, audienceZh: null, productsZh: null }, status: "announced", title: "Tibo 预告", createdAt: ISO, updatedAt: ISO, confirmedAt: null, occurredOn: null, confirmationBasis: null, schedule: null, estimate: { from: ISO, through: "2026-10-23T12:00:00+08:00", basis: "source", label: "来源预告", reason: "保留作者解释" }, posts: [{ id: "source-one", publishedAt: "2026-10-22T19:00:00+08:00", stage: "预告", text: "将重置", originalText: "reset soon", url: "https://x.com/thsottiaux/status/1", context: [] }], url: "https://aihot.news/codex-reset" }], activities: [] };
}
const EVAL_KEYS = ["intelligence", "coding", "agentic", "finance_and_accounting", "strategy_and_ops", "legal", "healthcare_and_medical", "engineering", "economics"];
function model(id: string) {
  return { id, name: `Model ${id}`, slug: `model-${id}`, release_date: null, model_creator: { id: "creator", name: "Creator" }, evaluations: Object.fromEntries(EVAL_KEYS.map((key) => [`artificial_analysis_${key}_index`, null])), pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: null }, performance: { median_output_tokens_per_second: 55, median_time_to_first_token_seconds: null, median_time_to_first_answer_token_seconds: null, median_end_to_end_response_time_seconds: null } };
}
function aaPage(page = 1, total = 1, id = `id-${page}`, version = 4.1) {
  return { tier: "free", intelligence_index_version: version, pagination: { page, page_size: 1, total_pages: total, has_more: page < total }, data: [model(id)] };
}
function harness(fetch: ReaderFetch, store: ReaderStore = new MemoryStore(), siteUrl = "http://localhost:3000", key: string | undefined = undefined, codexEnabled: () => boolean = () => true) {
  let now = AT;
  return { store, advance: (milliseconds: number) => { now += milliseconds; }, readers: () => createReaders({ fetch, store, siteUrl, aaKey: () => key, now: () => now, codexEnabled }) };
}

test("Tibo stays paused unless explicitly enabled: no upstream request and no cache write", async () => {
  let calls = 0;
  let writes = 0;
  const store: ReaderStore = { read: async () => null, write: async () => { writes += 1; } };
  const paused = createReaders({
    siteUrl: "http://localhost:3000",
    fetch: async () => { calls += 1; return response(codex()); },
    store,
    codexEnabled: () => false,
  });
  const off = await paused.codexResets();
  assert.equal(off.status, "paused");
  assert.equal(off.data, null);
  assert.match(off.message ?? "", /暂停/);
  assert.equal(calls, 0);
  assert.equal(writes, 0);

  const disk = new MemoryStore();
  await disk.write("codex-resets", { version: 1, data: codex(), fetchedAt: ISO, nextRefreshAt: new Date(AT + 600_000).toISOString(), etag: null, message: null, quotaWindowStart: null, requestCount: 0 });
  let diskWrites = 0;
  const reading: ReaderStore = { read: (key) => disk.read(key), write: async () => { diskWrites += 1; } };
  const kept = await createReaders({
    siteUrl: "http://localhost:3000",
    fetch: async () => { calls += 1; return response(codex()); },
    store: reading,
    codexEnabled: () => false,
    now: () => AT,
  }).codexResets();
  assert.equal(kept.status, "paused");
  assert.equal(kept.data?.events[0]?.title, "Tibo 预告");
  assert.equal(kept.fetchedAt, ISO);
  assert.equal(diskWrites, 0);
  assert.equal(calls, 0);

  let aaCalls = 0;
  const aa = await createReaders({
    siteUrl: "http://localhost:3000",
    fetch: async () => { aaCalls += 1; return response(aaPage()); },
    store: new MemoryStore(),
    aaKey: () => "synthetic-key",
    codexEnabled: () => false,
  }).aaModels();
  assert.equal(aa.status, "ready");
  assert.equal(aaCalls, 1);
});

test("Tibo TTL and simultaneous page reads share a single request, then use an ETag 304", async () => {
  const calls: { url: string; options: GuardedFetchOptions }[] = [];
  const h = harness(async (url, options) => {
    calls.push({ url, options });
    await new Promise((resolve) => setImmediate(resolve));
    return calls.length === 1 ? response(codex(), 200, { etag: '"author-1"' }) : response(null, 304);
  });
  const r = h.readers();
  const [a, b] = await Promise.all([r.codexResets(), r.codexResets()]);
  assert.deepEqual(a, b);
  assert.equal(a.status, "ready");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://aihot.news/api/v1/codex-resets/recent");
  assert.equal(calls[0].options.maxRedirects, 0);
  assert.equal(calls[0].options.headers?.["user-agent"], "aihot-api/2.0.0");
  h.advance(599_999);
  await r.codexResets();
  assert.equal(calls.length, 1);
  h.advance(1);
  const unchanged = await r.codexResets();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers?.["if-none-match"], '"author-1"');
  assert.equal(unchanged.status, "ready");
  assert.deepEqual(unchanged.data, a.data);
  assert.equal(unchanged.fetchedAt, new Date(AT + 600_000).toISOString());
});

test("an author 200 without ETag clears the previous validator so a return to older source content is fetched", async () => {
    let calls = 0;
    const validators: (string | undefined)[] = [];
    const content = (title: string) => {
      const x = codex(); x.events[0].title = title; return x;
    };
    const h = harness(async (_url, options) => {
      calls++;
      const tag = options.headers?.["if-none-match"];
      validators.push(tag);
      if (calls === 1) return response(content("Source A"), 200, { etag: '"A"' });
      if (calls === 2) return response(content("Source B"));
      // The source is back at A: its conditional 304 is correct only for a client retaining A.
      return tag === '"A"' ? response(null, 304, { etag: '"A"' }) : response(content("Source A"), 200, { etag: '"A"' });
    });
    const readers = h.readers();
    const read = () => readers.codexResets();
    const titleOf = (data: Awaited<ReturnType<typeof read>>["data"]) => data?.events[0].title;
    assert.equal(titleOf((await read()).data), "Source A");
    h.advance(600_000);
    assert.equal(titleOf((await read()).data), "Source B");
    h.advance(600_000);
    const returned = await read();
    assert.equal(returned.status, "ready");
    assert.equal(titleOf(returned.data), "Source A");
    assert.equal(validators[1], '"A"');
    assert.equal(validators[2], undefined);
    assert.equal(calls, 3);
});

test("429 Retry-After persists through restart without replacing successful content", async () => {
  let calls = 0;
  const h = harness(async () => ++calls === 1 ? response(codex()) : response({ error: "limited" }, 429, { "retry-after": "3600" }));
  const r = h.readers();
  const first = await r.codexResets();
  h.advance(600_000);
  const limited = await r.codexResets();
  assert.equal(limited.status, "stale");
  assert.deepEqual(limited.data, first.data);
  assert.equal(limited.fetchedAt, first.fetchedAt);
  assert.equal(limited.nextRefreshAt, new Date(AT + 600_000 + 3_600_000).toISOString());
  h.advance(600_000);
  const restarted = await h.readers().codexResets();
  assert.equal(calls, 2);
  assert.deepEqual(restarted, limited);
});

test("malformed responses, unsafe links and upstream failures cannot poison an existing cache", async () => {
  let next = response(codex());
  const h = harness(async () => next), r = h.readers();
  const first = await r.codexResets();
  for (const bad of [response({ ...codex(), schemaVersion: 9 }), ...["javascript:alert(1)", "http://127.0.0.1/private"].map((url) => response({ ...codex(), events: [{ ...codex().events[0], url }] })), response(null, 503)]) {
    h.advance(600_000); next = bad;
    const stale = await r.codexResets();
    assert.equal(stale.status, "stale");
    assert.deepEqual(stale.data, first.data);
    assert.equal(stale.fetchedAt, first.fetchedAt);
  }
});

test("cold failures retain cooldown after restart and a 304 without snapshot is unavailable", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return response(null, 304); });
  assert.equal((await h.readers().codexResets()).status, "unavailable");
  assert.equal((await h.readers().codexResets()).status, "unavailable");
  assert.equal(calls, 1);
});

test("Tibo display qualifiers, source timestamps and a 31-day-old successful snapshot stay unchanged", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return calls === 1 ? response(codex()) : response(null, 503); });
  const r = h.readers(), first = await r.codexResets();
  assert.equal(first.status, "ready");
  const e = first.data!.events[0];
  assert.equal(e.displayLabel, "重置（形式未明确）");
  assert.equal("label" in e, false);
  assert.equal(e.presentation!.scopeKnown, false);
  assert.equal(e.presentation!.timeInferred, true);
  assert.equal(e.confirmedAt, null);
  assert.equal(e.estimate!.through, "2026-10-23T12:00:00+08:00");
  assert.equal(e.posts[0].publishedAt, "2026-10-22T19:00:00+08:00");
  h.advance(599_999); await r.codexResets(); assert.equal(calls, 1);
  h.advance(1); assert.equal((await r.codexResets()).status, "stale"); assert.equal(calls, 2);
  h.advance(31 * 86_400_000);
  const old = await h.readers().codexResets();
  assert.equal(old.status, "stale");
  assert.deepEqual(old.data, first.data);
  assert.equal(old.fetchedAt, first.fetchedAt);
  assert.equal(old.data!.checkedAt, codex().checkedAt);
});

test("Tibo recent retains an October 15 Beijing morning event within the source historyFrom window", () => {
  const original = codex().events[0];
  const morning = "2026-10-15T08:00:00.000+08:00";
  const data = parseCodex({ ...codex(), events: [{ ...original, createdAt: morning, updatedAt: morning, status: "confirmed", confirmedAt: morning, estimate: null, presentation: { ...original.presentation, status: "confirmed" }, posts: [{ ...original.posts[0], publishedAt: morning }] }] });
  const result = recentCodex(data, Date.parse("2026-10-22T19:30:00+08:00"));
  assert.equal(result.events.length, 1);
  assert.deepEqual(result, data);
  assert.equal(result.historyFrom, "2026-10-15T00:00:00+08:00");
  assert.equal(result.events[0].posts[0].publishedAt, morning);
});

test("Tibo recent retains the source's old pending event even before historyFrom without changing its status", () => {
  const original = codex().events[0];
  const old = "2026-08-01T08:00:00.000+08:00";
  const data = parseCodex({ ...codex(), events: [{ ...original, createdAt: old, updatedAt: old, posts: [{ ...original.posts[0], publishedAt: old }] }] });
  const result = recentCodex(data, Date.parse("2026-10-22T19:30:00+08:00"));
  assert.equal(result.events.length, 1);
  assert.deepEqual(result, data);
  assert.equal(result.events[0].status, "announced");
  assert.equal(result.events[0].confirmedAt, null);
  assert.equal(result.events[0].posts[0].publishedAt, old);
});

test("missing AA key and public deployments never fetch or disclose private cached data", async () => {
  let calls = 0;
  const fetch: ReaderFetch = async () => { calls++; return response(codex()); };
  const noKey = harness(fetch);
  assert.equal((await noKey.readers().aaModels()).status, "needs_key");
  assert.equal(calls, 0);
  await noKey.readers().codexResets();
  const publicReaders = harness(fetch, noKey.store, "https://mafi.example.com", "synthetic-key").readers();
  for (const result of [await publicReaders.codexResets(), await publicReaders.aaModels()]) {
    assert.equal(result.status, "local_only"); assert.equal(result.data, null); assert.equal(result.fetchedAt, null);
  }
  assert.equal(calls, 1);
  for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) assert.equal(isLocalSite(url), true);
  for (const url of ["https://localhost.attacker.example", "http://127.0.0.2", "http://localhost@evil.example", "file://localhost", "garbage"]) assert.equal(isLocalSite(url), false);
});

test("AA full pagination preserves official response order, nulls, version and per-request counts across restart", async () => {
  const urls: string[] = [];
  const store = new MemoryStore();
  const h = harness(async (url, options) => {
    urls.push(url);
    assert.equal(options.headers?.["x-api-key"], "synthetic-key");
    const page = Number(new URL(url).searchParams.get("page"));
    return response({ ...aaPage(page, 2, page === 1 ? "z" : "a"), tier: "pro" });
  }, store, "http://localhost:3000", "synthetic-key");
  const first = await h.readers().aaModels();
  assert.equal(first.status, "ready"); assert.equal(first.data!.tier, "pro");
  assert.equal(first.data!.intelligence_index_version, 4.1);
  assert.deepEqual(first.data!.models.map((m) => m.id), ["z", "a"]);
  assert.equal(first.data!.models[0].evaluations.artificial_analysis_healthcare_and_medical_index, null);
  assert.equal(first.data!.models[0].pricing.price_1m_output_tokens, null);
  assert.equal("rank" in first.data!.models[0], false);
  assert.equal((store.values.get("aa-models") as { requestCount: number }).requestCount, 2);
  assert.equal(JSON.stringify(store.values.get("aa-models")).includes("synthetic-key"), false);
  h.advance(86_399_999);
  assert.deepEqual(await h.readers().aaModels(), first);
  assert.equal(urls.length, 2);
  h.advance(1);
  await h.readers().aaModels();
  assert.equal(urls.length, 4);
  assert.equal((store.values.get("aa-models") as { requestCount: number }).requestCount, 2);
});

test("the AA page's pull ignores the 24-hour TTL, says what is new, and waits 5 minutes before the next one", async () => {
  let version = 1;
  const urls: string[] = [];
  const h = harness(async (url) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    const ids = version === 1 ? ["a", "b"] : ["a", "c"];
    return response(aaPage(page, 2, ids[page - 1]));
  }, new MemoryStore(), "http://localhost:3000", "synthetic-key");
  const r = h.readers();
  const first = await r.aaModels();
  assert.deepEqual(first.data!.models.map((m) => m.id), ["a", "b"]);
  assert.equal(first.refresh!.cost, 2);
  assert.equal(first.refresh!.remaining, 98);
  assert.equal(first.refresh!.manualAfter, null);
  h.advance(60 * 60_000);
  version = 2;
  assert.deepEqual((await r.aaModels()).data!.models.map((m) => m.id), ["a", "b"]); // the TTL still holds for page loads
  assert.equal(urls.length, 2);
  const pulled = await r.aaRefresh();
  assert.equal(pulled.refused, null);
  assert.equal(urls.length, 4);
  assert.equal(pulled.total, 2);
  assert.deepEqual(pulled.added, [{ id: "c", name: "Model c" }]);
  assert.equal(pulled.addedCount, 1);
  assert.equal(pulled.removedCount, 1);
  assert.equal(pulled.fetchedAt, new Date(AT + 60 * 60_000).toISOString());
  assert.equal("data" in pulled, false);
  assert.deepEqual((await r.aaModels()).data!.models.map((m) => m.id), ["a", "c"]);
  h.advance(4 * 60_000);
  const early = await r.aaRefresh();
  assert.equal(early.refused?.reason, "cooldown");
  assert.equal(early.refused?.until, new Date(AT + 65 * 60_000).toISOString());
  assert.equal(early.refresh!.manualAfter, new Date(AT + 65 * 60_000).toISOString());
  assert.equal(urls.length, 4);
  h.advance(60_000);
  const [again, twice, read] = await Promise.all([r.aaRefresh(), r.aaRefresh(), r.aaModels()]); // a double click
  assert.equal(again.refused, null);
  assert.deepEqual(again.added, []);
  assert.equal(twice.refused?.reason, "cooldown");
  assert.equal(read.fetchedAt, again.fetchedAt);
  assert.equal(urls.length, 6);
});

test("the AA pull goes by AA's own count of what is left, falls back to ours, and keeps the list when AA fails", async () => {
  let remaining = 50;
  let fail = false;
  let calls = 0;
  const reset = Math.floor((AT + 3 * 60 * 60_000) / 1000);
  const store = new MemoryStore();
  const h = harness(async (url) => {
    calls++;
    if (fail) return response({ error: "busy" }, 503);
    const page = Number(new URL(url).searchParams.get("page"));
    remaining -= 1;
    return response(aaPage(page, 2), 200, { "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(reset) });
  }, store, "http://localhost:3000", "synthetic-key");
  const r = h.readers();
  await r.aaModels();
  assert.equal((await r.aaModels()).refresh!.remaining, 48); // AA's count, though only 2 of ours are spent
  assert.equal((await r.aaModels()).refresh!.resetAt, new Date(reset * 1000).toISOString());
  remaining = 2; // other clients of the same key spent the rest
  h.advance(10 * 60_000);
  assert.equal((await r.aaRefresh()).refused, null);
  h.advance(10 * 60_000);
  const short = await r.aaRefresh();
  assert.equal(short.refused?.reason, "quota");
  assert.equal(short.refused?.until, new Date(reset * 1000).toISOString());
  assert.equal(calls, 4);
  h.advance(3 * 60 * 60_000); // AA's window reset: our own count decides again
  remaining = 100;
  fail = true;
  const before = await r.aaModels();
  const failed = await r.aaRefresh();
  assert.equal(failed.refused, null);
  assert.equal(failed.status, "stale");
  assert.deepEqual(failed.added, []);
  assert.equal(failed.fetchedAt, before.fetchedAt);
  const local = new MemoryStore();
  const fresh = harness(async () => response(aaPage(1, 2)), local, "http://localhost:3000", "synthetic-key");
  await fresh.readers().aaModels().catch(() => {});
  local.values.set("aa-models", { ...(local.values.get("aa-models") as object), requestCount: 99, quotaWindowStart: AT, remaining: null, resetAt: null });
  const spent = await fresh.readers().aaRefresh();
  assert.equal(spent.refused?.reason, "quota");
});

test("only this site's own page can ask for an AA pull", async () => {
  let calls = 0;
  const h = harness(async (url) => { calls++; return response(aaPage(Number(new URL(url).searchParams.get("page")), 1)); }, new MemoryStore(), "http://localhost:3000", "synthetic-key");
  const app = Fastify();
  createReaderServer(h.readers()).http!(app);
  const site = new URL(config.siteUrl);
  const own = site.origin;
  const twin = `${site.protocol}//${site.hostname === "localhost" ? "127.0.0.1" : "localhost"}${site.port ? `:${site.port}` : ""}`;
  const post = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/api/mafi-readers/aa-models/refresh", headers });
  try {
    const refused: Array<Record<string, string>> = [{}, { origin: own }, { origin: "https://evil.example", "x-mafi-action": "refresh" }, { "sec-fetch-site": "cross-site", "x-mafi-action": "refresh" }, { "x-mafi-action": "refresh" }];
    for (const headers of refused) {
      assert.equal((await post(headers)).statusCode, 403, JSON.stringify(headers));
    }
    assert.equal(calls, 0);
    const ok = await post({ origin: own, "x-mafi-action": "refresh" });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().refused, null);
    assert.equal(ok.headers["cache-control"], "private, no-store");
    assert.equal(calls, 1);
    const soon = await post({ origin: twin, "x-mafi-action": "refresh" });
    assert.equal(soon.statusCode, 429);
    assert.equal(soon.json().refused.reason, "cooldown");
    const sameSite = await post({ "sec-fetch-site": "same-origin", "x-mafi-action": "refresh" });
    assert.equal(sameSite.statusCode, 429);
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test("AA rejects duplicate IDs, mixed versions, changing pagination, unknown schema and bounded partial lists", async () => {
  for (const failure of ["duplicate", "version", "pages", "schema", "limit"] as const) {
    let broken = false;
    const h = harness(async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (!broken) return response(aaPage(1, 1, "complete"));
      if (failure === "schema") return response({ data: [] });
      if (failure === "limit") return response(aaPage(1, 13));
      return response(aaPage(page, failure === "pages" && page === 2 ? 3 : 2, failure === "duplicate" ? "same" : `new-${page}`, failure === "version" && page === 2 ? 4.2 : 4.1));
    }, new MemoryStore(), "http://localhost", "synthetic-key");
    const r = h.readers(), first = await r.aaModels();
    h.advance(86_400_000); broken = true;
    const result = await r.aaModels();
    assert.equal(result.status, "stale", failure);
    assert.deepEqual(result.data, first.data, failure);
    assert.equal(result.fetchedAt, first.fetchedAt, failure);
  }
});

test("AA invalid numeric metrics and version strings are refused without exposing raw errors or keys", async () => {
  for (const bad of [{ ...aaPage(), intelligence_index_version: "4.1" }, { ...aaPage(), data: [{ ...model("x"), evaluations: { artificial_analysis_intelligence_index: "90" } }] }]) {
    const h = harness(async () => response(bad), new MemoryStore(), "http://localhost", "synthetic-key");
    const result = await h.readers().aaModels();
    assert.equal(result.status, "unavailable"); assert.equal(result.data, null);
    assert.equal(JSON.stringify(result).includes("synthetic-key"), false);
  }
});

test("AA quota reservations stop incomplete pagination before the 101st request, including after restart", async () => {
  let calls = 0;
  const store = new MemoryStore();
  const h = harness(async () => { calls++; return response(aaPage()); }, store, "http://localhost", "synthetic-key");
  const first = await h.readers().aaModels();
  const state = store.values.get("aa-models") as { requestCount: number; nextRefreshAt: string };
  state.requestCount = 99;
  state.nextRefreshAt = new Date(AT - 1).toISOString();
  const readers = createReaders({ store, siteUrl: "http://localhost", aaKey: () => "synthetic-key", now: () => AT + 1000, fetch: async () => { calls++; return response(aaPage(1, 2, "partial")); } });
  const limited = await readers.aaModels();
  assert.equal(calls, 2);
  assert.equal(limited.status, "stale");
  assert.deepEqual(limited.data, first.data);
  assert.equal((store.values.get("aa-models") as { requestCount: number }).requestCount, 100);
  await h.readers().aaModels();
  assert.equal(calls, 2);
});

test("real file persistence restores successful content and a failure cooldown after process recreation", async () => {
  const parent = path.resolve(import.meta.dirname);
  const directory = await mkdtemp(path.join(parent, ".tmp-reader-test-"));
  assert.equal(path.dirname(path.resolve(directory)), parent);
  try {
    let calls = 0;
    const store = new FileReaderStore(directory);
    const h = harness(async () => ++calls === 1 ? response(codex(), 200, { etag: '"disk-v1"' }) : response(null, 429, { "retry-after": "1200" }), store);
    const first = await h.readers().codexResets();
    assert.deepEqual(await h.readers().codexResets(), first); assert.equal(calls, 1);
    h.advance(600_000);
    const limited = await h.readers().codexResets();
    const recreated = createReaders({ siteUrl: "http://localhost", store: new FileReaderStore(directory), fetch: async () => { throw new Error("Restart must use disk cooldown"); }, now: () => AT + 700_000, codexEnabled: () => true });
    assert.deepEqual(await recreated.codexResets(), limited);
    const disk = await readFile(path.join(directory, "codex-resets.json"), "utf8");
    assert.equal(disk.includes("authorization"), false);
    let aaCalls = 0;
    const aa = harness(async () => { aaCalls++; return response(aaPage()); }, store, "http://localhost", "synthetic-key");
    const aaFirst = await aa.readers().aaModels();
    const aaRecreated = createReaders({ siteUrl: "http://localhost", store: new FileReaderStore(directory), aaKey: () => "synthetic-key", fetch: async () => { throw new Error("Restart must use disk AA snapshot"); }, now: () => AT + 60_000 });
    assert.deepEqual(await aaRecreated.aaModels(), aaFirst);
    assert.equal(aaCalls, 1);
    const aaDisk = await readFile(path.join(directory, "aa-models.json"), "utf8");
    assert.equal(aaDisk.includes("synthetic-key"), false);
    assert.equal(JSON.parse(aaDisk).requestCount, 1);
    await assert.rejects(store.read("../escape"), /Invalid cache key/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a failed reservation write prevents upstream traffic", async () => {
  let calls = 0;
  const store: ReaderStore = { read: async () => null, write: async () => { throw new Error("Disk unavailable"); } };
  const h = harness(async () => { calls++; return response(codex()); }, store);
  assert.equal((await h.readers().codexResets()).status, "unavailable");
  assert.equal(calls, 0);
});

test("HTTP routes preserve AA and Tibo private access while the removed news API returns 404", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return response(codex()); });
  const app = Fastify();
  createReaderServer(h.readers()).http!(app);
  try {
    const ok = await app.inject("/api/mafi-readers/codex-resets");
    assert.equal(ok.statusCode, 200); assert.equal(ok.json().status, "ready");
    for (const endpoint of ["/api/mafi-readers/aihot", "/api/mafi-readers/aihot?view=selected", "/api/mafi-readers/aihot?view=all"]) {
      const removed = await app.inject(endpoint);
      assert.equal(removed.statusCode, 404);
    }
    assert.equal(calls, 1);
    const key = await app.inject("/api/mafi-readers/aa-models");
    assert.equal(key.json().status, "needs_key"); assert.equal(calls, 1);
    for (const r of [ok, key]) { assert.equal(r.headers["cache-control"], "private, no-store"); assert.match(String(r.headers["x-robots-tag"]), /noindex/); }
  } finally { await app.close(); }
});

test("Tibo source links and original timestamps survive normalization and disk restoration", () => {
  assert.deepEqual(parseCodex(parseCodex(codex()), true), parseCodex(codex()));
  const result = parseCodex(codex());
  assert.equal(result.events[0].url, codex().events[0].url);
  assert.equal(result.events[0].posts[0].url, codex().events[0].posts[0].url);
  assert.equal(result.events[0].posts[0].publishedAt, codex().events[0].posts[0].publishedAt);
});
test("AA leaderboard helpers filter by model tree/reasoning, rank by intelligence, and keep nulls at the bottom", async () => {
  const {
    buildAaModelTree,
    collectTreeModelIds,
    filterAaModelTree,
    filterAaModels,
    organizationNames,
    organizationFilterLabel,
    modelFilterLabel,
    parseAaLeaderboardPrefs,
    reasoningFilterLabel,
    reasoningKind,
    releaseDateValue,
    sanitizeStoredModelIds,
    serializeAaLeaderboardPrefs,
    sortAaModels,
    splitAaModelName,
    topByIntelligence,
    intelligenceIndex,
    isAllSelected,
    variantEffortRank,
    AA_LEADERBOARD_STORAGE_KEY,
  } = await import("../web/aa-rank.ts");
  assert.equal(reasoningKind("Claude Opus (Reasoning)"), "reasoning");
  assert.equal(reasoningKind("GLM-4.5V (Non-reasoning)"), "non_reasoning");
  assert.equal(reasoningKind("Sonar Reasoning Pro"), "reasoning");
  assert.equal(reasoningKind("GPT-4o"), "unmarked");

  assert.deepEqual(splitAaModelName("Claude Opus 5.5 (Xhigh, Default Fallback)"), { family: "Claude Opus 5.5", variantLabel: "Xhigh, Default Fallback" });
  assert.deepEqual(splitAaModelName("Claude Sonnet 4.6 (Non-reasoning, High)"), { family: "Claude Sonnet 4.6", variantLabel: "Non-reasoning, High" });
  assert.deepEqual(splitAaModelName("Gemini 2.5 Flash Preview (Sep '25) (Reasoning)"), { family: "Gemini 2.5 Flash Preview (Sep '25)", variantLabel: "Reasoning" });
  assert.deepEqual(splitAaModelName("GPT-4o"), { family: "GPT-4o", variantLabel: null });
  assert.deepEqual(splitAaModelName("HyperNova 60B 2605 (High, Based on gpt-oss-120b)"), { family: "HyperNova 60B 2605", variantLabel: "High, Based on gpt-oss-120b" });

  assert.equal(releaseDateValue("2026-10-07"), Date.parse("2026-10-07T00:00:00Z"));
  assert.equal(releaseDateValue(null) < releaseDateValue("2020-01-01"), true);
  assert.ok(variantEffortRank("Xhigh, Default Fallback") < variantEffortRank("High, Default Fallback"));
  assert.equal(AA_LEADERBOARD_STORAGE_KEY, "mafi-aa-leaderboard-prefs-v1");

  const models = [
    { ...model("low"), name: "Low (Reasoning)", release_date: "2024-01-01", model_creator: { id: "a", name: "Alpha" }, evaluations: { ...model("low").evaluations, artificial_analysis_intelligence_index: 10 }, performance: { ...model("low").performance, median_output_tokens_per_second: 90, median_time_to_first_token_seconds: 2 }, pricing: { price_1m_input_tokens: 5, price_1m_output_tokens: 10 } },
    { ...model("high"), name: "High (Non-reasoning)", release_date: "2025-06-01", model_creator: { id: "b", name: "Beta" }, evaluations: { ...model("high").evaluations, artificial_analysis_intelligence_index: 50 }, performance: { ...model("high").performance, median_output_tokens_per_second: 20, median_time_to_first_token_seconds: 0.5 }, pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 2 } },
    { ...model("mid"), name: "Mid Model", release_date: "2025-12-01", model_creator: { id: "a", name: "Alpha" }, evaluations: { ...model("mid").evaluations, artificial_analysis_intelligence_index: 30 }, performance: { ...model("mid").performance, median_output_tokens_per_second: null, median_time_to_first_token_seconds: null }, pricing: { price_1m_input_tokens: null, price_1m_output_tokens: null } },
    { ...model("none"), name: "None (Reasoning)", release_date: "2023-01-01", model_creator: { id: "b", name: "Beta" }, evaluations: { ...model("none").evaluations, artificial_analysis_intelligence_index: null } },
    { ...model("opus-xhigh"), name: "Claude Opus 5.5 (Xhigh, Default Fallback)", release_date: "2026-10-07", model_creator: { id: "anth", name: "Anthropic" }, evaluations: { ...model("opus-xhigh").evaluations, artificial_analysis_intelligence_index: 70 } },
    { ...model("opus-high"), name: "Claude Opus 5.5 (High, Default Fallback)", release_date: "2026-10-07", model_creator: { id: "anth", name: "Anthropic" }, evaluations: { ...model("opus-high").evaluations, artificial_analysis_intelligence_index: 68 } },
    { ...model("sonnet-med"), name: "Claude Sonnet 5.5 (Medium, Default Fallback)", release_date: "2026-09-01", model_creator: { id: "anth", name: "Anthropic" }, evaluations: { ...model("sonnet-med").evaluations, artificial_analysis_intelligence_index: 60 } },
    { ...model("haiku-old"), name: "Claude 3 Haiku", release_date: "2024-03-04", model_creator: { id: "anth", name: "Anthropic" }, evaluations: { ...model("haiku-old").evaluations, artificial_analysis_intelligence_index: 20 } },
  ];

  const tree = buildAaModelTree(models);
  assert.deepEqual(tree.map((org) => org.name), ["Alpha", "Anthropic", "Beta"]);
  const anthropic = tree.find((org) => org.name === "Anthropic");
  assert.ok(anthropic);
  assert.deepEqual(anthropic.families.map((family) => family.name), ["Claude Opus 5.5", "Claude Sonnet 5.5", "Claude 3 Haiku"]);
  assert.deepEqual(anthropic.families[0].leaves.map((leaf) => leaf.label), ["Xhigh, Default Fallback", "High, Default Fallback"]);
  assert.deepEqual(collectTreeModelIds(tree).sort(), ["haiku-old", "high", "low", "mid", "none", "opus-high", "opus-xhigh", "sonnet-med"]);
  const alpha = tree.find((org) => org.name === "Alpha");
  assert.deepEqual(alpha!.families.map((family) => family.leaves.map((leaf) => leaf.id)), [["mid"], ["low"]]);

  const filteredTree = filterAaModelTree(tree, "opus xhigh");
  assert.deepEqual(filteredTree.map((org) => org.name), ["Anthropic"]);
  assert.deepEqual(filteredTree[0].families.map((family) => family.name), ["Claude Opus 5.5"]);
  assert.deepEqual(filteredTree[0].families[0].leaves.map((leaf) => leaf.id), ["opus-xhigh"]);
  assert.equal(filterAaModelTree(tree, "nope").length, 0);
  assert.equal(filterAaModelTree(tree, "alpha").length, 1);

  assert.deepEqual(organizationNames(models), ["Alpha", "Anthropic", "Beta"]);
  assert.equal(isAllSelected([], ["Alpha", "Beta"]), true);
  assert.equal(isAllSelected(["Alpha", "Beta"], ["Alpha", "Beta"]), true);
  assert.equal(isAllSelected(["Alpha"], ["Alpha", "Beta"]), false);
  assert.equal(organizationFilterLabel([], ["Alpha", "Beta"]), "全部机构");
  assert.equal(organizationFilterLabel(["Alpha"], ["Alpha", "Beta"]), "已选 1 个机构");
  assert.equal(modelFilterLabel([], 707), "已选择 707/707 个模型");
  assert.equal(modelFilterLabel(["a", "b"], 707), "已选择 2/707 个模型");
  assert.equal(modelFilterLabel(Array.from({ length: 707 }, (_, i) => String(i)), 707), "已选择 707/707 个模型");
  assert.equal(reasoningFilterLabel([]), "全部类型");
  assert.equal(reasoningFilterLabel(["reasoning"]), "推理 (Reasoning)");
  assert.equal(reasoningFilterLabel(["reasoning", "unmarked"]), "已选 2 种类型");

  assert.deepEqual(filterAaModels(models, { modelIds: ["low", "mid"] }).map((m) => m.id), ["low", "mid"]);
  assert.deepEqual(filterAaModels(models, { modelIds: [] }).map((m) => m.id), models.map((m) => m.id));
  assert.deepEqual(filterAaModels(models, { organizations: ["Alpha"] }).map((m) => m.id), ["low", "mid"]);
  assert.deepEqual(filterAaModels(models, { organizations: ["Alpha", "Beta"] }).map((m) => m.id), ["low", "high", "mid", "none"]);
  assert.deepEqual(filterAaModels(models, { organizations: ["Beta", "Alpha"] }).map((m) => m.id).sort(), ["high", "low", "mid", "none"]);
  assert.deepEqual(filterAaModels(models, { reasoningKinds: ["non_reasoning"] }).map((m) => m.id), ["high"]);
  assert.deepEqual(filterAaModels(models, { reasoningKinds: ["reasoning", "unmarked"] }).map((m) => m.id), ["low", "mid", "none", "opus-xhigh", "opus-high", "sonnet-med", "haiku-old"]);
  assert.deepEqual(filterAaModels(models, { modelIds: ["low", "high"], reasoningKinds: ["reasoning"] }).map((m) => m.id), ["low"]);
  assert.deepEqual(filterAaModels(models, { query: "beta high" }).map((m) => m.id), ["high"]);
  assert.equal(filterAaModels(models, { query: "nope" }).length, 0);
  assert.equal(filterAaModels(models, {}).length, 8);

  assert.deepEqual(sortAaModels(models, "intelligence").map((m) => m.id), ["opus-xhigh", "opus-high", "sonnet-med", "high", "mid", "haiku-old", "low", "none"]);
  assert.deepEqual(sortAaModels(models.slice(0, 4), "speed").map((m) => m.id), ["low", "none", "high", "mid"]);
  assert.deepEqual(sortAaModels(models.slice(0, 4), "latency").map((m) => m.id), ["high", "low", "mid", "none"]);
  assert.deepEqual(sortAaModels(models.slice(0, 4), "input_price").map((m) => m.id), ["high", "none", "low", "mid"]);
  assert.deepEqual(sortAaModels(models, "source").map((m) => m.id), models.map((m) => m.id));

  const top = topByIntelligence(models, 2);
  assert.deepEqual(top.map((row) => [row.rank, row.model.id, row.score]), [[1, "opus-xhigh", 70], [2, "opus-high", 68]]);
  assert.equal(intelligenceIndex(models[3]), null);
  assert.equal(topByIntelligence(models, 0).length, 0);
  assert.equal(topByIntelligence(models, 99).length, 7);

  const filteredForChart = filterAaModels(models, { modelIds: ["low", "mid"] });
  assert.deepEqual(topByIntelligence(filteredForChart, 15).map((row) => row.model.id), ["mid", "low"]);

  assert.deepEqual(sanitizeStoredModelIds(["opus-xhigh", "gone", "mid"], models.map((m) => m.id)), ["opus-xhigh", "mid"]);
  assert.deepEqual(sanitizeStoredModelIds([], models.map((m) => m.id)), []);
  assert.deepEqual(sanitizeStoredModelIds(["gone"], models.map((m) => m.id)), []);
  const roundTrip = parseAaLeaderboardPrefs(serializeAaLeaderboardPrefs({
    modelIds: ["opus-xhigh", "mid"],
    reasoningKinds: ["reasoning"],
    sort: "speed",
    topN: 20,
  }));
  assert.deepEqual(roundTrip, { modelIds: ["opus-xhigh", "mid"], reasoningKinds: ["reasoning"], sort: "speed", topN: 20 });
  assert.equal(parseAaLeaderboardPrefs("not-json"), null);
  assert.equal(parseAaLeaderboardPrefs(null), null);
});
