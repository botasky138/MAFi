import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { explicitlyEnabled } from "../flags.ts";
import {
  WINDOW_MS, applyExclusions, parseTrendingHtml, sortByPeriod,
  readGithubTrend, refreshGithubTrend,
} from "../backend/github-trend.ts";
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

test("only the exact string true enables a switch", () => {
  assert.equal(explicitlyEnabled("true"), true);
  for (const value of [undefined, "", "false", "TRUE", "1", " true"]) assert.equal(explicitlyEnabled(value), false);
});

test("period stars sort the list and a missing period is not stored as zero", () => {
  const parsed = parseTrendingHtml(dailyHtml, "daily");
  assert.equal(parsed.rawCards, 6);
  assert.equal(parsed.withPeriod.length, 5);
  const names = sortByPeriod(applyExclusions(parsed.withPeriod)).map((item) => item.fullName);
  assert.deepEqual(names, ["high/second", "low/first", "nototal/ok"]);
  const high = sortByPeriod(applyExclusions(parsed.withPeriod))[0]!;
  assert.equal(high.starsPeriod, 2088);
  assert.equal(high.starsTotal, 100);
  assert.notEqual(high.starsPeriod, high.starsTotal);
  const bare = sortByPeriod(applyExclusions(parsed.withPeriod)).find((item) => item.fullName === "nototal/ok");
  assert.equal(bare?.starsTotal, null);
  assert.equal(bare?.starsPeriod, 3);
  assert.equal(parsed.withPeriod.some((item) => item.starsPeriod === 0 && item.fullName === "missing/period"), false);
  assert.equal(applyExclusions(parsed.withPeriod).some((item) => /agent-desktop|claude-mem/i.test(item.fullName)), false);
  assert.equal(new Set(["vercel-labs/agent-desktop", "thedotmack/claude-mem"]).size, 2);
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
  const stale = await readGithubTrend({ dir: directory, now: () => AT + WINDOW_MS.daily + 1, enabled: true, fetch, since: "daily" });
  assert.equal(stale.status, "stale");
  assert.equal(stale.items.length, fresh.items.length);
  assert.match(stale.message ?? "", /计划间隔/);
  assert.equal(calls, 0);
  await rm(directory, { recursive: true, force: true });
});

test("cards without a period do not replace a good snapshot; an all-excluded page can be an empty success", async () => {
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

  pages.daily = card("vercel-labs/agent-desktop", "9 stars today", "1") + card("thedotmack/claude-mem", "8 stars today", "1");
  await refreshGithubTrend({ dir: directory, now: () => AT + WINDOW_MS.daily * 2, enabled: true, fetch, mode: "due" });
  const empty = await readGithubTrend({ dir: directory, now: () => AT + WINDOW_MS.daily * 2, enabled: true, fetch, since: "daily" });
  assert.equal(empty.status, "ready");
  assert.deepEqual(empty.items, []);
  assert.notEqual(empty.fetchedAt, good.fetchedAt);
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
  assert.equal(disk.includes("agent-desktop"), false);
  await app.close();
  await rm(directory, { recursive: true, force: true });
});
