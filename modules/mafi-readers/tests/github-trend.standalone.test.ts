import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { explicitlyEnabled } from "../flags.ts";
import {
  WINDOW_MS, applyExclusions, parseTrendingHtml, retryAfterMs, sortByPeriod,
  readGithubTrend, refreshGithubTrend,
} from "../backend/github-trend.ts";
import {
  DescribeUnavailableError, classifyByRules, hourlySpark, loadRepos, starsLastHour,
  type PurposeInput, type RepoFetchResult,
} from "../backend/github-repos.ts";
import { createReaderServer } from "../server.ts";

const AT = Date.parse("2026-11-07T12:00:00Z");

function card(full: string, period: string | null, total: string | null, description = "desc"): string {
  const [owner, repo] = full.split("/");
  const periodHtml = period == null ? "" : `<span class="d-inline-block float-sm-right">${period}</span>`;
  const totalHtml = total == null ? "" : `<a href="/${owner}/${repo}/stargazers">${total}</a>`;
  return `<article class="Box-row"><h2 class="h3 lh-condensed"><a href="/${owner}/${repo}">${owner} / ${repo}</a></h2><p class="col-9 color-fg-muted my-1">${description}</p><span itemprop="programmingLanguage">Go</span>${totalHtml}${periodHtml}</article>`;
}

const dailyHtml = [
  card("low/first", "10 stars today", "9,000"),
  card("high/second", "2,088 stars today", "100"),
  card("vercel-labs/agent-desktop", "500 stars today", "10"),
  card("TheDotMack/Claude-Mem", "400 stars today", "10"),
  card("missing/period", null, "80"),
  card("nototal/ok", "3 stars today", null),
].join("");

const HOUR = 60 * 60 * 1000;

function repoReply(stars: number, extra: Partial<{ topics: string[]; createdAt: string; description: string }> = {}): RepoFetchResult {
  return {
    status: 200,
    repo: { stars, meta: { description: extra.description ?? "desc", topics: extra.topics ?? [], language: "Go", createdAt: extra.createdAt ?? "2020-01-01T00:00:00Z", homepage: null, archived: false } },
    remaining: 4_000,
    resetAt: null,
  };
}

function pages(daily: string, weekly = card("acme/week", "4 stars this week", "8"), monthly = card("acme/month", "6 stars this month", "8")) {
  const by: Record<string, string> = { daily, weekly, monthly };
  return async (url: string) => ({ status: 200, body: by[new URL(url).searchParams.get("since") ?? "daily"] ?? "", retryAfter: null });
}

test("a 5-minute worker refreshes each window on its own interval and the list is never shown as stale", async () => {
  const directory = await dir();
  const fetched: Record<string, number[]> = { daily: [], weekly: [], monthly: [] };
  let clock = AT;
  const fetch = pages(dailyHtml);
  const timed = async (url: string) => {
    clock += 1_500; // the request takes a moment, so nextRefreshAt lands just after the matching tick
    fetched[new URL(url).searchParams.get("since")!]!.push(Math.round((clock - AT) / 60_000));
    return fetch(url);
  };
  let stale = 0;
  for (let minute = 0; minute < 6 * 60; minute += 5) {
    clock = AT + minute * 60_000;
    await refreshGithubTrend({ dir: directory, now: () => clock, enabled: true, fetch: timed, mode: "due" });
    clock = AT + minute * 60_000 + 4 * 60_000;
    if ((await readGithubTrend({ dir: directory, now: () => clock, enabled: true, fetch, since: "daily" })).status !== "ready") stale += 1;
  }
  assert.deepEqual(fetched.daily, [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]);
  assert.deepEqual(fetched.weekly, [0, 120, 240]);
  assert.deepEqual(fetched.monthly, [0]);
  assert.equal(stale, 0);
  await rm(directory, { recursive: true, force: true });
});

test("a description with links keeps its text", () => {
  const html = card("d4vinci/scrapling", "8 stars today", "100", "🕷️ Scraping framework, join <a href=\"https://discord.gg/x\" class=\"Link\">https://discord.gg/x</a> &amp; more");
  assert.equal(parseTrendingHtml(html, "daily").withPeriod[0]?.description, "🕷️ Scraping framework, join https://discord.gg/x & more");
});

test("rules give a primary and a close secondary category, and fall back to other", () => {
  assert.deepEqual(classifyByRules("vercel-labs/agent-browser", "Browser automation CLI for AI agents", null), { category: "agent", secondary: "llm" });
  assert.deepEqual(classifyByRules("dsx/nvke", "NVIDIA Kubernetes Engine. A management plane for GPU clusters", ["kubernetes", "gpu"]), { category: "infra", secondary: null });
  assert.deepEqual(classifyByRules("sherlock-project/sherlock", "Hunt down social media accounts by username across social networks", ["osint", "cli"]), { category: "security", secondary: "devtools" });
  assert.deepEqual(classifyByRules("acme/thing", "", []), { category: "other", secondary: null });
});

test("live stars: an hour of polls gives the hourly gain and a 24-point spark", () => {
  assert.equal(starsLastHour([]), null);
  assert.equal(starsLastHour([[AT, 10], [AT + 30 * 60_000, 20]]), null);
  assert.equal(starsLastHour([[AT, 10], [AT + 55 * 60_000, 25]]), 15);
  const points: Array<[number, number]> = [];
  for (let m = 0; m <= 26 * 60; m += 5) points.push([AT + m * 60_000, 1_000 + m]);
  assert.equal(starsLastHour(points), 60);
  const spark = hourlySpark(points);
  assert.equal(spark.length, 25);
  assert.equal(spark.at(-1), 1_000 + 26 * 60);
  assert.equal(spark[0], 1_000 + 2 * 60);
});

test("the refresh polls live stars with a token, rations them without one, and pauses on GitHub's rate limit", async () => {
  const directory = await dir();
  const html = [card("a/one", "50 stars today", "900"), card("b/two", "40 stars today", "800"), card("c/three", "30 stars today", "700")].join("");
  const asked: string[] = [];
  const repoFetch = async (name: string) => { asked.push(name); return repoReply(1_000 + asked.length); };
  await refreshGithubTrend({ dir: directory, now: () => AT, enabled: true, fetch: pages(html), repoFetch, hasToken: true, mode: "due" });
  assert.deepEqual(new Set(asked), new Set(["a/one", "b/two", "c/three", "acme/week", "acme/month"]));
  const read = await readGithubTrend({ dir: directory, now: () => AT + 60_000, enabled: true, fetch: pages(html), since: "daily" });
  assert.equal(read.live, true);
  assert.equal(typeof read.items[0]?.starsTotal, "number");
  assert.notEqual(read.items[0]?.starsTotal, 900); // the API count replaces the page's
  const later = await readGithubTrend({ dir: directory, now: () => AT + 30 * 60_000, enabled: true, fetch: pages(html), since: "daily" });
  assert.equal(later.live, false);

  // Without a token, 11 ticks inside one hour would want 55 requests; GitHub's 60 an hour is shared, so 40.
  asked.length = 0;
  for (let tick = 1; tick <= 11; tick += 1) {
    await refreshGithubTrend({ dir: directory, now: () => AT + HOUR + tick * 5 * 60_000, enabled: true, fetch: pages(html), repoFetch, hasToken: false, mode: "due" });
  }
  assert.equal(asked.length, 40);
  assert.equal((await loadRepos(directory)).used, 40);

  asked.length = 0;
  const limited = async (name: string) => { asked.push(name); return { status: 403, repo: null, remaining: 0, resetAt: AT + 5 * HOUR } as RepoFetchResult; };
  await refreshGithubTrend({ dir: directory, now: () => AT + 3 * HOUR, enabled: true, fetch: pages(html), repoFetch: limited, hasToken: true, mode: "due" });
  assert.equal(asked.length, 1);
  await refreshGithubTrend({ dir: directory, now: () => AT + 4 * HOUR, enabled: true, fetch: pages(html), repoFetch: limited, hasToken: true, mode: "due" });
  assert.equal(asked.length, 1);
  await refreshGithubTrend({ dir: directory, now: () => AT + 5 * HOUR + 1, enabled: true, fetch: pages(html), repoFetch, hasToken: true, mode: "due" });
  assert.equal(asked.length > 1, true);
  await rm(directory, { recursive: true, force: true });
});

test("purpose lines: 精选 first, a few per run, kept until the description changes, retried an hour after a failure", async () => {
  const directory = await dir();
  const html = Array.from({ length: 9 }, (_, i) => card(`o/r${i}`, `${100 - i} stars today`, "1000")).join("");
  const described: string[] = [];
  let fail = "";
  const describe = async (input: PurposeInput) => {
    described.push(input.fullName);
    if (input.fullName === fail) throw new Error("unusable");
    return { purpose: `用途 ${input.fullName}`, category: "devtools" as const, secondary: "devtools" as const, model: "fake" };
  };
  const repoFetch = async () => repoReply(1000, { description: "desc" });
  const run = (at: number, extra: Partial<Parameters<typeof refreshGithubTrend>[0]> = {}) =>
    refreshGithubTrend({ dir: directory, now: () => at, enabled: true, fetch: pages(html, "", ""), repoFetch, hasToken: true, describe, mode: "due", ...extra });
  const first = await run(AT);
  assert.equal(first.purposes?.written, 6);
  assert.deepEqual(described.slice(0, 3), ["o/r0", "o/r1", "o/r2"]);
  const read = await readGithubTrend({ dir: directory, now: () => AT, enabled: true, fetch: pages(html), since: "daily" });
  assert.equal(read.items[0]?.purpose, "用途 o/r0");
  assert.equal(read.items[0]?.category, "devtools");
  assert.equal(read.items[0]?.secondary, null); // the same as the primary is dropped
  described.length = 0;
  fail = "o/r6";
  await run(AT + 5 * 60_000);
  assert.deepEqual(described, ["o/r6", "o/r7", "o/r8"]);
  described.length = 0;
  await run(AT + 10 * 60_000);
  assert.equal(described.length, 0);
  fail = "";
  await run(AT + 70 * 60_000);
  assert.deepEqual(described, ["o/r6"]);
  described.length = 0;
  await run(AT + 75 * 60_000, { repoFetch: async () => repoReply(1000, { description: "now something else" }) });
  assert.equal(described.length, 6);
  described.length = 0;
  const off = async (input: PurposeInput) => { described.push(input.fullName); throw new DescribeUnavailableError("MODEL_CALLS_ENABLED=false"); };
  await run(AT + 80 * 60_000, { describe: off, repoFetch: async () => repoReply(1000, { description: "third" }) });
  assert.equal(described.length, 1);
  await rm(directory, { recursive: true, force: true });
});

test("精选 skips a repo that has sat on the daily list for 3 days; badges for new, surge and all three lists", async () => {
  const directory = await dir();
  const daily = [card("old/resident", "900 stars today", "50000"), card("fresh/new", "800 stars today", "1500"), card("b/b", "700 stars today", "90000"), card("c/c", "600 stars today", "90000"), card("d/d", "500 stars today", "90000")].join("");
  const weekly = card("b/b", "5000 stars this week", "90000");
  const monthly = card("b/b", "9000 stars this month", "90000");
  const repoFetch = async (name: string) => repoReply(name === "fresh/new" ? 1500 : 90000, { createdAt: name === "fresh/new" ? new Date(AT - 5 * 24 * HOUR).toISOString() : "2020-01-01T00:00:00Z" });
  for (let hour = 0; hour <= 3 * 24; hour += 6) {
    const listed = hour < 2 * 24 ? card("old/resident", "900 stars today", "50000") : daily;
    await refreshGithubTrend({ dir: directory, now: () => AT + hour * HOUR, enabled: true, fetch: pages(listed, weekly, monthly), repoFetch, hasToken: true, mode: "due" });
  }
  const read = await readGithubTrend({ dir: directory, now: () => AT + 3 * 24 * HOUR, enabled: true, fetch: pages(daily), since: "daily" });
  assert.equal(read.items[0]?.fullName, "old/resident");
  assert.deepEqual(read.items[0]?.badges, ["resident"]);
  assert.deepEqual(read.featured, ["fresh/new", "b/b", "c/c"]);
  assert.deepEqual(read.items.find((item) => item.fullName === "fresh/new")?.badges, ["new", "surge"]);
  assert.deepEqual(read.items.find((item) => item.fullName === "b/b")?.badges, ["triple"]);
  const week = await readGithubTrend({ dir: directory, now: () => AT + 3 * 24 * HOUR, enabled: true, fetch: pages(daily), since: "weekly" });
  assert.deepEqual(week.featured, ["b/b"]);
  await rm(directory, { recursive: true, force: true });
});

test("only the exact string true enables a switch", () => {
  assert.equal(explicitlyEnabled("true"), true);
  for (const value of [undefined, "", "false", "TRUE", "1", " true"]) assert.equal(explicitlyEnabled(value), false);
});

test("period stars sort the list and a missing period is not stored as zero", () => {
  const parsed = parseTrendingHtml(dailyHtml, "daily");
  assert.equal(parsed.rawCards, 6);
  assert.equal(parsed.withPeriod.length, 5);
  const names = sortByPeriod(applyExclusions(parsed.withPeriod)).map((item) => item.fullName);
  // The exclusion list is empty since 2026-11-09 (trend-config.ts): both former entries are listed again.
  assert.deepEqual(names, ["high/second", "vercel-labs/agent-desktop", "TheDotMack/Claude-Mem", "low/first", "nototal/ok"]);
  const high = sortByPeriod(applyExclusions(parsed.withPeriod))[0]!;
  assert.equal(high.starsPeriod, 2088);
  assert.equal(high.starsTotal, 100);
  assert.notEqual(high.starsPeriod, high.starsTotal);
  const bare = sortByPeriod(applyExclusions(parsed.withPeriod)).find((item) => item.fullName === "nototal/ok");
  assert.equal(bare?.starsTotal, null);
  assert.equal(bare?.starsPeriod, 3);
  assert.equal(parsed.withPeriod.some((item) => item.starsPeriod === 0 && item.fullName === "missing/period"), false);
});

test("a weekly phrase does not count as today's stars", () => {
  const html = card("acme/tool", "12 stars this week", "40");
  const parsed = parseTrendingHtml(html, "daily");
  assert.equal(parsed.rawCards, 1);
  assert.equal(parsed.withPeriod.length, 0);
});

async function dir() {
  return mkdtemp(path.join(tmpdir(), "mafi-trend-"));
}

test("a read never calls fetch, and an overdue snapshot is stale", async () => {
  const directory = await dir();
  let calls = 0;
  const fetch = async () => { calls += 1; return { status: 200, body: dailyHtml, retryAfter: null }; };
  await refreshGithubTrend({ dir: directory, now: () => AT, enabled: true, fetch, mode: "due" });
  assert.equal(calls, 3);
  calls = 0;
  const fresh = await readGithubTrend({ dir: directory, now: () => AT + 1_000, enabled: true, fetch, since: "daily" });
  assert.equal(fresh.status, "ready");
  assert.equal(fresh.items[0]?.fullName, "high/second");
  assert.equal(calls, 0);
  const onTime = await readGithubTrend({ dir: directory, now: () => AT + WINDOW_MS.daily + 10 * 60_000, enabled: true, fetch, since: "daily" });
  assert.equal(onTime.status, "ready");
  const stale = await readGithubTrend({ dir: directory, now: () => AT + WINDOW_MS.daily + 16 * 60_000, enabled: true, fetch, since: "daily" });
  assert.equal(stale.status, "stale");
  assert.equal(stale.items.length, fresh.items.length);
  assert.match(stale.message ?? "", /采集可能停了/);
  assert.equal(calls, 0);
  await rm(directory, { recursive: true, force: true });
});

test("cards without a period do not replace a good snapshot", async () => {
  const directory = await dir();
  const pages: Record<string, string> = {
    daily: dailyHtml,
    weekly: card("acme/week", "4 stars this week", "8"),
    monthly: card("acme/month", "6 stars this month", "8"),
  };
  let calls = 0;
  const fetch = async (url: string) => {
    calls += 1;
    const since = new URL(url).searchParams.get("since") ?? "daily";
    return { status: 200, body: pages[since] ?? "", retryAfter: null };
  };
  await refreshGithubTrend({ dir: directory, now: () => AT, enabled: true, fetch, mode: "due" });
  const good = await readGithubTrend({ dir: directory, now: () => AT, enabled: true, fetch, since: "daily" });
  pages.daily = card("broken/one", null, "10") + card("broken/two", null, "11");
  const failed = await refreshGithubTrend({ dir: directory, now: () => AT + WINDOW_MS.daily, enabled: true, fetch, mode: "due" });
  assert.equal(failed.windows.daily.ok, false);
  const kept = await readGithubTrend({ dir: directory, now: () => AT + WINDOW_MS.daily, enabled: true, fetch, since: "daily" });
  assert.equal(kept.fetchedAt, good.fetchedAt);
  assert.equal(kept.items[0]?.fullName, "high/second");
  assert.notEqual(kept.attemptedAt, kept.fetchedAt);
  assert.equal(kept.status, "stale");

  assert.equal(calls > 0, true);
  await rm(directory, { recursive: true, force: true });
});

test("a disabled read does not fetch and a forced refresh waits 60 seconds", async () => {
  const directory = await dir();
  let calls = 0;
  const fetch = async () => { calls += 1; return { status: 200, body: dailyHtml, retryAfter: null }; };
  const off = await readGithubTrend({ dir: directory, now: () => AT, enabled: false, fetch, since: "weekly" });
  assert.equal(off.status, "disabled");
  assert.equal(calls, 0);
  const first = await refreshGithubTrend({ dir: directory, now: () => AT, enabled: true, fetch, mode: "force" });
  assert.equal(first.ok, true);
  const second = await refreshGithubTrend({ dir: directory, now: () => AT + 59_000, enabled: true, fetch, mode: "force" });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "cooldown");
  const before = calls;
  const third = await refreshGithubTrend({ dir: directory, now: () => AT + 60_000, enabled: true, fetch, mode: "force" });
  assert.equal(third.ok, true);
  assert.equal(calls > before, true);
  await rm(directory, { recursive: true, force: true });
});

test("403 is not retried and a dead lock is recoverable", async () => {
  const directory = await dir();
  let calls = 0;
  const fetch = async (url: string) => {
    calls += 1;
    const since = new URL(url).searchParams.get("since");
    if (since === "daily") return { status: 403, body: "nope", retryAfter: null };
    return { status: 200, body: card(since === "weekly" ? "acme/week" : "acme/month", since === "weekly" ? "2 stars this week" : "3 stars this month", "5"), retryAfter: null };
  };
  await refreshGithubTrend({ dir: directory, now: () => AT, enabled: true, fetch, mode: "due" });
  assert.equal(calls, 3);
  const daily = await readGithubTrend({ dir: directory, now: () => AT, enabled: true, fetch, since: "daily" });
  assert.equal(daily.status, "unavailable");
  const weekly = await readGithubTrend({ dir: directory, now: () => AT, enabled: true, fetch, since: "weekly" });
  assert.equal(weekly.status, "ready");

  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "github-trending.lock"), "999999\n1");
  let during = 0;
  const recovered = await refreshGithubTrend({
    dir: directory,
    now: () => AT + WINDOW_MS.weekly,
    enabled: true,
    fetch: async (url) => { during += 1; return fetch(url); },
    mode: "due",
  });
  assert.equal(recovered.ok, true);
  assert.equal(during > 0, true);
  await rm(directory, { recursive: true, force: true });
});

test("GitHub's frequent 504s are tried four times, and a failed window is tried again 10 minutes later", async () => {
  const directory = await dir();
  const waits: number[] = [];
  const sleep = async (ms: number) => { waits.push(ms); };
  const replies: Record<string, number[]> = { daily: [504, 504, 504, 200], weekly: [504, 504, 504, 504], monthly: [429] };
  const calls: Record<string, number> = { daily: 0, weekly: 0, monthly: 0 };
  const fetch = async (url: string) => {
    const since = new URL(url).searchParams.get("since")!;
    const status = replies[since]![calls[since]!] ?? 504;
    calls[since]! += 1;
    const phrase = since === "weekly" ? "2 stars this week" : since === "monthly" ? "3 stars this month" : "4 stars today";
    return { status, body: status === 200 ? card("acme/flaky", phrase, "9") : "", retryAfter: status === 429 ? "120" : null };
  };
  await refreshGithubTrend({ dir: directory, now: () => AT, enabled: true, fetch, sleep, mode: "due" });
  assert.deepEqual(calls, { daily: 4, weekly: 4, monthly: 1 });
  assert.deepEqual(waits, [2_000, 4_000, 8_000, 2_000, 4_000, 8_000]);
  const daily = await readGithubTrend({ dir: directory, now: () => AT, enabled: true, fetch, since: "daily" });
  assert.equal(daily.status, "ready");
  const weekly = await readGithubTrend({ dir: directory, now: () => AT, enabled: true, fetch, since: "weekly" });
  assert.equal(weekly.status, "unavailable");
  assert.equal(Date.parse(weekly.nextRefreshAt!) - AT, 10 * 60_000);
  replies.weekly = [200];
  calls.weekly = 0;
  await refreshGithubTrend({ dir: directory, now: () => AT + 10 * 60_000, enabled: true, fetch, sleep, mode: "due" });
  assert.equal((await readGithubTrend({ dir: directory, now: () => AT + 10 * 60_000, enabled: true, fetch, since: "weekly" })).status, "ready");
  await rm(directory, { recursive: true, force: true });
});

test("the admin's forced refresh never calls the model; the worker's tick does", async () => {
  const directory = await dir();
  const described: string[] = [];
  const describe = async (input: PurposeInput) => { described.push(input.fullName); return { purpose: "用途", category: "agent" as const, secondary: null, model: "fake" }; };
  const server = createReaderServer(undefined, {
    dir: directory, now: () => AT, fetch: pages(card("acme/tool", "5 stars today", "9")), repoFetch: async () => repoReply(10),
    hasToken: () => true, describe, enabled: () => true, authenticate: async () => ({ csrf: "t" }),
  });
  const app = Fastify();
  server.http!(app);
  const forced = await app.inject({ method: "POST", url: "/api/admin/mafi-readers/github-trending/refresh", headers: { "x-csrf-token": "t" } });
  assert.equal(forced.statusCode, 200);
  assert.equal(described.length, 0);
  await server.schedules![0]!.run();
  assert.equal(described.includes("acme/tool"), true);
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

test("a live lock refuses a second refresh and the GET route does not fetch", async () => {
  const directory = await dir();
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const fetch = async (url: string) => {
    calls += 1;
    if (calls === 1) await gate;
    const since = new URL(url).searchParams.get("since") ?? "daily";
    const phrase = since === "weekly" ? "2 stars this week" : since === "monthly" ? "3 stars this month" : "4 stars today";
    return { status: 200, body: card("acme/live", phrase, "9"), retryAfter: null };
  };
  const first = refreshGithubTrend({ dir: directory, now: () => AT, enabled: true, fetch, mode: "force" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const blocked = await refreshGithubTrend({ dir: directory, now: () => AT + 61_000, enabled: true, fetch, mode: "force" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "locked");
  release!();
  assert.equal((await first).ok, true);

  calls = 0;
  const app = Fastify();
  let clock = AT + 1_000;
  let principal: { csrf: string } | null = null;
  createReaderServer(undefined, { dir: directory, now: () => clock, fetch, enabled: () => true, authenticate: async () => principal }).http!(app);
  const ok = await app.inject("/api/mafi-readers/github-trending?since=daily");
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().status, "ready");
  assert.equal(calls, 0);
  assert.equal(ok.json().items[0].fullName, "acme/live");
  const bad = await app.inject("/api/mafi-readers/github-trending?since=year");
  assert.equal(bad.statusCode, 400);
  const denied = await app.inject({ method: "POST", url: "/api/admin/mafi-readers/github-trending/refresh" });
  assert.equal(denied.statusCode, 401);
  principal = { csrf: "secret" };
  const wrong = await app.inject({ method: "POST", url: "/api/admin/mafi-readers/github-trending/refresh", headers: { "x-csrf-token": "other" } });
  assert.equal(wrong.statusCode, 403);
  clock = AT + 120_000;
  const allowed = await app.inject({ method: "POST", url: "/api/admin/mafi-readers/github-trending/refresh", headers: { "x-csrf-token": "secret" } });
  assert.equal(allowed.statusCode, 200);
  assert.equal(calls > 0, true);
  const disk = await readFile(path.join(directory, "github-trending.json"), "utf8");
  assert.equal(disk.includes("acme/live"), true);
  assert.deepEqual(ok.json().featured, ["acme/live"]);
  await app.close();
  await rm(directory, { recursive: true, force: true });
});
