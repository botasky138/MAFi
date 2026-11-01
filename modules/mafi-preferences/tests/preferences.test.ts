import test, { after } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { sql, closeDb } from "@aihot/backend/db";
import { ensureDeviceRow, setReaction, readVotes, readSourceCounts } from "../backend/store.ts";
import { createPreferenceServer } from "../server.ts";
import { DEVICE_COOKIE } from "../contracts.ts";
import { readDeviceId } from "../backend/identity.ts";
import { _resetLimitsForTest } from "../backend/limits.ts";

const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";

after(closeDb);

test("setReaction upserts; null clears without delete; devices isolated", async () => {
  await ensureDeviceRow(DEVICE_A);
  await ensureDeviceRow(DEVICE_B);
  // Use a real public article_id + source_id from the test DB (fixture helpers in this file).
  const { itemId, sourceId } = await pickPublicItem();

  const up = await setReaction(DEVICE_A, itemId, "up", sourceId);
  assert.equal(up.myVote, "up");
  assert.equal(up.source.ups, 1);
  assert.equal(up.source.downs, 0);

  const again = await setReaction(DEVICE_A, itemId, "up", sourceId);
  assert.equal(again.myVote, "up");
  assert.equal(again.source.ups, 1);

  const down = await setReaction(DEVICE_A, itemId, "down", sourceId);
  assert.equal(down.myVote, "down");
  assert.equal(down.source.ups, 0);
  assert.equal(down.source.downs, 1);

  const cleared = await setReaction(DEVICE_A, itemId, null, sourceId);
  assert.equal(cleared.myVote, null);
  assert.equal(cleared.source.ups, 0);
  assert.equal(cleared.source.downs, 0);

  const [row] = await sql<{ vote: string | null }[]>`
    SELECT vote FROM mafi_preference_reactions WHERE device_id = ${DEVICE_A} AND article_id = ${itemId}`;
  assert.ok(row);
  assert.equal(row.vote, null);

  await setReaction(DEVICE_A, itemId, "up", sourceId);
  const bVotes = await readVotes(DEVICE_B, [itemId]);
  assert.equal(bVotes.get(itemId) ?? null, null);
  const bCounts = await readSourceCounts(DEVICE_B, [sourceId]);
  assert.deepEqual(bCounts.get(sourceId) ?? { ups: 0, downs: 0 }, { ups: 0, downs: 0 });
});

async function app() {
  const f = Fastify();
  createPreferenceServer().http!(f);
  return f;
}

test("POST reactions: set-on-first-write, idempotent, revoke, 404, origin, rate limit", async () => {
  _resetLimitsForTest();
  const f = await app();
  try {
    const { itemId } = await pickPublicItem(); // same helper as Task 2
    const origin = "http://localhost:3000";

    const first = await f.inject({
      method: "POST",
      url: "/api/site/reactions",
      headers: { origin, "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
      payload: { itemId, vote: "up" },
    });
    assert.equal(first.statusCode, 200);
    assert.match(String(first.headers["set-cookie"]), new RegExp(DEVICE_COOKIE));
    assert.equal(first.headers["cache-control"], "private, no-store");
    assert.equal(first.json().myVote, "up");
    const cookie = String(first.headers["set-cookie"]).split(";")[0];

    const dup = await f.inject({
      method: "POST",
      url: "/api/site/reactions",
      headers: { origin, cookie, "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
      payload: { itemId, vote: "up" },
    });
    assert.equal(dup.statusCode, 200);
    assert.equal(dup.json().myVote, "up");

    const revoke = await f.inject({
      method: "POST",
      url: "/api/site/reactions",
      headers: { origin, cookie, "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
      payload: { itemId, vote: null },
    });
    assert.equal(revoke.statusCode, 200);
    assert.equal(revoke.json().myVote, null);

    const missing = await f.inject({
      method: "POST",
      url: "/api/site/reactions",
      headers: { origin, cookie, "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
      payload: { itemId: "no-such-item-id-zzzz", vote: "down" },
    });
    assert.equal(missing.statusCode, 404);

    const cross = await f.inject({
      method: "POST",
      url: "/api/site/reactions",
      headers: { origin: "https://evil.example", cookie, "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
      payload: { itemId, vote: "down" },
    });
    assert.equal(cross.statusCode, 403);
  } finally {
    await f.close();
  }
});

test("POST reactions: burst over 10 returns 429", async () => {
  _resetLimitsForTest();
  const f = await app();
  try {
    const { itemId } = await pickPublicItem();
    const origin = "http://localhost:3000";
    const ip = "198.51.100.99";
    let saw429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await f.inject({
        method: "POST",
        url: "/api/site/reactions",
        headers: { origin, "content-type": "application/json", "x-forwarded-for": ip },
        payload: { itemId, vote: i % 2 === 0 ? "up" : "down" },
      });
      if (res.statusCode === 429) {
        saw429 = true;
        assert.ok(res.headers["retry-after"]);
        break;
      }
      assert.equal(res.statusCode, 200, `unexpected status at i=${i}: ${res.statusCode}`);
    }
    assert.equal(saw429, true);
  } finally {
    await f.close();
  }
});

async function pickPublicItem(): Promise<{ itemId: string; sourceId: string }> {
  const [row] = await sql<{ id: string; source_id: string }[]>`
    SELECT p.article_id AS id, p.source_id
    FROM publications p
    WHERE p.visibility = 'public'
    ORDER BY p.sort_at DESC
    LIMIT 1`;
  if (row) return { itemId: row.id, sourceId: row.source_id };

  // Template DBs (mafi_test) have schema but no seed pubs - insert a minimal fixture like alerts.test.ts.
  const sourceId = "mafi-pref-fixture-source";
  const itemId = "mafi-pref-fixture-item";
  const at = new Date();
  await sql`
    INSERT INTO sources (id, name, kind, tier, participation_mode)
    VALUES (${sourceId}, 'MAFi preference fixture', 'rss', 'T1', 'editorial')
    ON CONFLICT (id) DO NOTHING`;
  await sql`
    INSERT INTO articles (id, source_id, identity_key, url, title, published_at, discovered_at, timeline_at)
    VALUES (
      ${itemId}, ${sourceId}, ${itemId}, ${`https://example.com/${itemId}`}, ${itemId},
      ${at}, ${at}, ${at}
    )
    ON CONFLICT (id) DO NOTHING`;
  await sql`
    INSERT INTO publications (
      article_id, source_id, title, summary, eligible, selected, selection_candidate, visibility,
      selected_ready_at, discovered_at, timeline_at, sort_at, url, category, channel
    ) VALUES (
      ${itemId}, ${sourceId}, ${`Fixture ${itemId}`}, 'summary', true, false, true, 'public',
      ${at}, ${at}, ${at}, ${at}, ${`https://example.com/${itemId}`}, 'industry', 'news'
    )
    ON CONFLICT (article_id) DO NOTHING`;
  return { itemId, sourceId };
}

test("projectPool keeps engine order and only stamps myVote", async () => {
  const { projectPool } = await import("../backend/views.ts");
  const data = {
    filters: { channel: "all", category: null, tag: null, q: null, tab: "time" },
    items: [
      { id: "a", title: "A", summary: null, reason: null, source: { name: "S" }, publishedAt: null, timelineAt: "2026-10-24T00:00:00.000Z", category: null, tags: [], score: 1, selected: false, channel: "news", x: null },
      { id: "b", title: "B", summary: null, reason: null, source: { name: "S" }, publishedAt: null, timelineAt: "2026-10-24T00:00:00.000Z", category: null, tags: [], score: 1, selected: false, channel: "news", x: null },
    ],
    page: 1,
    pageCount: 3,
    total: 80,
    todayCount: 0,
    freshness: "2026-10-24T00:00:00.000Z",
  } as import("@aihot/contracts/site").PoolResponse;
  const candidates = [
    { itemId: "a", sourceId: "src", publicBaseScore: 100, publicTimeMs: 2 },
    { itemId: "b", sourceId: "src", publicBaseScore: 90, publicTimeMs: 1 },
  ];
  const votes = new Map([["a", "down" as const]]);
  const counts = new Map([["src", { ups: 0, downs: 1 }]]);
  const out = projectPool(data, candidates, votes, counts);
  assert.equal(out.pageCount, 3);
  assert.equal(out.total, 80);
  assert.deepEqual(out.items.map((i) => i.id), ["a", "b"]);
  assert.equal(out.items[0]!.myVote, "down");
  assert.equal(out.items[1]!.myVote, null);
  const rel = projectPool({ ...data, filters: { ...data.filters, tab: "relevance" } } as typeof data, candidates, votes, counts);
  assert.deepEqual(rel.items.map((i) => i.id), ["a", "b"]);
});

test("projectTimeline keeps publish-time order; votes only stamp", async () => {
  const { projectTimeline } = await import("../backend/views.ts");
  const feed = (id: string) => ({
    id, title: id, summary: null, reason: null, source: { name: "S" }, publishedAt: null,
    timelineAt: "2026-10-24T00:00:00.000Z", category: null, tags: [], score: 1, selected: true, channel: "news" as const, x: null,
  });
  const data = {
    filters: { channel: "all", category: null, tag: null },
    cards: [
      { key: "g1-weak", anchorAt: "2026-10-24T02:00:00.000Z", item: feed("g1-weak"), group: { factId: "fact-1", additionalSourceCount: 1, reportCount: 2, memberIds: ["g1-weak", "g1-strong"] } },
      { key: "g1-strong", anchorAt: "2026-10-24T02:00:00.000Z", item: feed("g1-strong"), group: { factId: "fact-1", additionalSourceCount: 1, reportCount: 2, memberIds: ["g1-weak", "g1-strong"] } },
      { key: "g2", anchorAt: "2026-10-24T01:00:00.000Z", item: feed("g2"), group: null },
    ],
    nextCursor: null,
    hot: null,
    dayCounts: {},
  } as import("@aihot/contracts/site").TimelineResponse;
  const candidates = [
    { itemId: "g1-weak", sourceId: "src", publicBaseScore: 50, publicTimeMs: 5, groupKey: "fact-1" },
    { itemId: "g1-strong", sourceId: "src", publicBaseScore: 100, publicTimeMs: 4, groupKey: "fact-1" },
    { itemId: "g2", sourceId: "src", publicBaseScore: 80, publicTimeMs: 3, groupKey: "g2" },
  ];
  const votes = new Map([["g1-weak", "down" as const]]);
  const counts = new Map([["src", { ups: 0, downs: 1 }]]);
  const out = projectTimeline(data, candidates, votes, counts);
  assert.deepEqual(out.cards.map((c) => c.item.id), ["g1-weak", "g1-strong", "g2"]);
  assert.equal(out.cards.find((c) => c.item.id === "g1-weak")!.item.myVote, "down");
  assert.equal(out.cards.find((c) => c.item.id === "g1-strong")!.item.myVote, null);
});

test("projectHot reorders story entries by max member finalSortKey within window", async () => {
  const { projectHot } = await import("../backend/views.ts");
  const data = {
    computedAt: "2026-10-24T00:00:00.000Z",
    windowHours: 48,
    entries: [
      { rank: 1, story: { publicId: "s-high", title: "High" }, heat: 100, trend: "flat" as const, trendPct: null, badges: [], participantCount: 2, sourceCount: 2, sourceNames: ["A"], participants: [], spark: [], summary: null, latest: null, cover: null },
      { rank: 2, story: { publicId: "s-mid", title: "Mid" }, heat: 80, trend: "flat" as const, trendPct: null, badges: [], participantCount: 2, sourceCount: 2, sourceNames: ["B"], participants: [], spark: [], summary: null, latest: null, cover: null },
    ],
  };
  const candidates = [
    { itemId: "rep-high", sourceId: "src", publicBaseScore: 100, publicTimeMs: 2, groupKey: "s-high" },
    { itemId: "rep-mid", sourceId: "src", publicBaseScore: 80, publicTimeMs: 1, groupKey: "s-mid" },
  ];
  const votes = new Map([["rep-high", "down" as const]]);
  const counts = new Map([["src", { ups: 0, downs: 1 }]]);
  const out = projectHot(data, candidates, votes, counts);
  assert.equal(out.entries[0]!.story.publicId, "s-mid");
  assert.equal(out.entries[1]!.story.publicId, "s-high");
  assert.equal(out.entries.length, 2);
});

test("timeline with device cookie is private and ordered; without cookie stays public", async () => {
  const { installModules } = await import("@aihot/backend/modules");
  const { SERVER_MODULES } = await import("@aihot/site/modules/server");
  const { buildApp } = await import("../../../apps/api/src/app.ts");

  installModules([...SERVER_MODULES]);

  const prefix = `mafi-pref-tl-${Date.now()}`;
  const sourceId = `${prefix}-src`;
  const highId = `${prefix}-high`;
  const lowId = `${prefix}-low`;
  const highAt = new Date("2026-10-25T12:00:00.000Z");
  const lowAt = new Date("2026-10-24T12:00:00.000Z");

  await sql`
    INSERT INTO sources (id, name, kind, tier, participation_mode)
    VALUES (${sourceId}, ${prefix}, 'rss', 'T1', 'editorial')
    ON CONFLICT (id) DO NOTHING`;
  for (const [itemId, at] of [[highId, highAt], [lowId, lowAt]] as const) {
    await sql`
      INSERT INTO articles (id, source_id, identity_key, url, title, published_at, discovered_at, timeline_at)
      VALUES (
        ${itemId}, ${sourceId}, ${itemId}, ${`https://example.com/${itemId}`}, ${itemId},
        ${at}, ${at}, ${at}
      )
      ON CONFLICT (id) DO NOTHING`;
    await sql`
      INSERT INTO publications (
        article_id, source_id, title, summary, eligible, selected, selection_candidate, visibility,
        selected_ready_at, discovered_at, timeline_at, sort_at, visible_after, url, category, channel
      ) VALUES (
        ${itemId}, ${sourceId}, ${`Fixture ${itemId}`}, 'summary', true, true, true, 'public',
        ${at}, ${at}, ${at}, ${at}, ${at}, ${`https://example.com/${itemId}`}, 'industry', 'news'
      )
      ON CONFLICT (article_id) DO UPDATE SET
        selected = true, eligible = true, visibility = 'public',
        sort_at = EXCLUDED.sort_at, timeline_at = EXCLUDED.timeline_at, visible_after = EXCLUDED.visible_after`;
  }

  await ensureDeviceRow(DEVICE_A);
  await setReaction(DEVICE_A, highId, "down", sourceId);

  const f = await buildApp();
  try {
    const publicRes = await f.inject({ method: "GET", url: "/api/site/timeline" });
    assert.equal(publicRes.statusCode, 200);
    assert.match(String(publicRes.headers["cache-control"]), /public/);
    const publicBody = publicRes.json() as { cards: { item: { id: string; myVote?: string | null } }[] };
    assert.equal(publicBody.cards.find((c) => c.item.id === highId)?.item.myVote, undefined);

    const cookie = `${DEVICE_COOKIE}=${DEVICE_A}`;
    const privateRes = await f.inject({ method: "GET", url: "/api/site/timeline", headers: { cookie } });
    assert.equal(privateRes.statusCode, 200);
    assert.equal(privateRes.headers["cache-control"], "private, no-store");
    assert.equal(privateRes.headers.etag, undefined);
    const privateBody = privateRes.json() as { cards: { item: { id: string; myVote: string | null } }[] };
    assert.ok(privateBody.cards.some((c) => c.item.myVote === "down"));
    const ids = privateBody.cards.map((c) => c.item.id);
    const hi = ids.indexOf(highId);
    const lo = ids.indexOf(lowId);
    assert.ok(hi >= 0 && lo >= 0, "seeded cards present");
    assert.ok(lo < hi, "downvoted higher-base item is demoted within window");
  } finally {
    await f.close();
    installModules([]);
  }
});

test("acceptance matrix", async () => {
  _resetLimitsForTest();
  const f = await app();
  try {
    const { itemId } = await pickPublicItem();
    const origin = new URL((await import("@aihot/backend/config")).config.siteUrl).origin;
    const ip = "198.51.100.50";

    const post = (headers: Record<string, string>, payload: object) =>
      f.inject({
        method: "POST",
        url: "/api/site/reactions",
        headers: { origin, "content-type": "application/json", "x-forwarded-for": ip, ...headers },
        payload,
      });

    const first = await post({}, { itemId, vote: "up" });
    assert.equal(first.statusCode, 200);
    const cookie = String(first.headers["set-cookie"]).split(";")[0]!;
    const dup = await post({ cookie }, { itemId, vote: "up" });
    assert.equal(dup.statusCode, 200);
    assert.equal(dup.json().myVote, "up");

    const revoked = await post({ cookie }, { itemId, vote: null });
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.json().myVote, null);
    const deviceId = readDeviceId(cookie);
    assert.ok(deviceId);
    const [retained] = await sql<{ vote: string | null }[]>`
      SELECT vote FROM mafi_preference_reactions WHERE article_id = ${itemId} AND device_id = ${deviceId}`;
    assert.ok(retained);
    assert.equal(retained.vote, null);

    await Promise.all([
      post({ cookie }, { itemId, vote: "up" }),
      post({ cookie }, { itemId, vote: "down" }),
    ]);
    const finalVote = (await readVotes(deviceId, [itemId])).get(itemId) ?? null;
    assert.ok(finalVote === "up" || finalVote === "down");

    const cross = await post({ cookie, origin: "https://evil.example" }, { itemId, vote: "up" });
    assert.equal(cross.statusCode, 403);

    const missing = await post({ cookie }, { itemId: "no-such-item-id-zzzz", vote: "up" });
    assert.equal(missing.statusCode, 404);

    _resetLimitsForTest();
    let saw429 = false;
    for (let i = 0; i < 20; i++) {
      const r = await post({ cookie, "x-forwarded-for": "198.51.100.77" }, { itemId, vote: i % 2 ? "up" : "down" });
      if (r.statusCode === 429) {
        saw429 = true;
        break;
      }
    }
    assert.equal(saw429, true);
  } finally {
    await f.close();
  }

  // Pool public/private cache assertions need the full site app (preference-only Fastify has no /api/site/pool).
  const { installModules } = await import("@aihot/backend/modules");
  const { SERVER_MODULES } = await import("@aihot/site/modules/server");
  const { buildApp } = await import("../../../apps/api/src/app.ts");
  installModules([...SERVER_MODULES]);
  const site = await buildApp();
  try {
    const { itemId } = await pickPublicItem();
    await ensureDeviceRow(DEVICE_A);
    const [pubRow] = await sql<{ source_id: string }[]>`
      SELECT source_id FROM publications WHERE article_id = ${itemId} LIMIT 1`;
    assert.ok(pubRow);
    await setReaction(DEVICE_A, itemId, "up", pubRow.source_id);
    const cookie = `${DEVICE_COOKIE}=${DEVICE_A}`;

    const pub = await site.inject({ method: "GET", url: "/api/site/pool" });
    assert.equal(pub.statusCode, 200);
    assert.match(String(pub.headers["cache-control"]), /public/);
    const pubBody = pub.json() as { items?: { id: string; myVote?: string | null }[] };
    assert.equal(pubBody.items?.[0]?.myVote, undefined);

    const priv = await site.inject({ method: "GET", url: "/api/site/pool", headers: { cookie } });
    assert.equal(priv.statusCode, 200);
    assert.equal(priv.headers["cache-control"], "private, no-store");
    const privBody = priv.json() as { items: { id: string; myVote?: string | null }[] };
    assert.ok(Array.isArray(privBody.items));
    assert.ok(
      privBody.items.every((it) => (it.id === itemId ? it.myVote === "up" : true)),
      "personalized pool should stamp myVote for voted item when present in window",
    );
  } finally {
    await site.close();
    installModules([]);
  }
});

test("voting does not change collect intervals", async () => {
  const before = await sql<{ id: string; interval_minutes: number; next_fetch_at: Date | null }[]>`
    SELECT id, interval_minutes, next_fetch_at FROM sources ORDER BY id`;
  const { itemId, sourceId } = await pickPublicItem();
  await ensureDeviceRow(DEVICE_A);
  await setReaction(DEVICE_A, itemId, "down", sourceId);
  const after = await sql<{ id: string; interval_minutes: number; next_fetch_at: Date | null }[]>`
    SELECT id, interval_minutes, next_fetch_at FROM sources ORDER BY id`;
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i]!.id, before[i]!.id);
    assert.equal(after[i]!.interval_minutes, before[i]!.interval_minutes);
    assert.equal(String(after[i]!.next_fetch_at), String(before[i]!.next_fetch_at));
  }
});
