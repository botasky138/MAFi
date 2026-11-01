// Selected news timeline: ordinary reports fold by fact; standalone and independent-source articles
// keep their own cards. Cards are ordered by publish time (a fact by its earliest selected report), newest first.
import type { GroupInfo, TimelineCard, TimelineFilters, TimelineResponse } from "@aihot/contracts/site";
import { beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { cachedByKey } from "../lib/cache.ts";
import { pickRepresentative, REPRESENTATIVE_COLUMNS, type RepresentativeRow } from "./representative.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import {
  ITEM_COLUMNS, ITEM_FROM, categoryCondition, channelCondition, tagCondition, toFeedItemSummary,
  type ItemRow,
} from "./items.ts";
import { evidenceCondition, foldableSelectionCondition, listedCondition, listingFreshCondition, ownFactEvidenceCondition, selectedCondition } from "./scope.ts";

export interface TimelineQuery extends TimelineFilters {
  cursor?: string | null;
  limit?: number;
  now?: Date;
}

interface GroupRow {
  gk: string;
  anchor_at: Date;
}

function filterSql(q: TimelineQuery) {
  return sql`${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(q.tag)}`;
}

function binding(q: TimelineQuery): string {
  return queryBinding({ c: q.channel, k: q.category, t: q.tag });
}

/**
 * Public pool reports linked to the given facts, under the same
 * filters (non-selected included): the sets "另外 N 家也报道了" expands and the group counts come from.
 */
async function groupPool(q: TimelineQuery, now: Date, factIds: number[]) {
  if (!factIds.length) return [];
  return sql<{ fact_id: number; article_id: string; source_id: string }[]>`
    SELECT DISTINCT f.id AS fact_id, p.article_id, p.source_id
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    WHERE f.id IN ${sql(factIds)}
      AND ${evidenceCondition()} AND ${listedCondition(now)} ${filterSql(q)}`;
}

/**
 * The selected set grouped into cards (fact or standalone item) with their anchor times, newest
 * first. Every timeline page and its day counts read this list; it is kept for five seconds per
 * filter scope (a newly selected report appears at most that much later).
 */
const groupedAnchors = cachedByKey(binding, (q: TimelineQuery) => queryGroupedAnchors(q, new Date()), { freshMs: 5000, maxStaleMs: 5000, maxKeys: 50 });

/**
 * Per-source 精选 quota (docs/mafi-source-quota-design.md). A module (mafi-preferences) may supply a
 * multiplier per source (bounded 0.5x–2x from reader votes); the engine never imports it. Each source
 * shows at most max(1, round(base × multiplier)) selected items per Beijing day, best score first.
 * The quota decides which items appear; it never changes their order (publish time, newest first).
 */
export type SourceQuotaProvider = () => Promise<ReadonlyMap<string, number>>;
let sourceQuotaProvider: SourceQuotaProvider | null = null;
export function setSelectedSourceQuotaProvider(provider: SourceQuotaProvider | null): void { sourceQuotaProvider = provider; }

export function selectedSourceDailyBase(): number {
  const raw = Number(process.env.MAFI_SELECTED_SOURCE_DAILY_QUOTA ?? 2);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2;
}

export function sourceQuota(base: number, multiplier: number | undefined): number {
  const m = Math.min(2, Math.max(0.5, Number.isFinite(multiplier) ? multiplier! : 1));
  return Math.max(1, Math.round(base * m));
}

async function quotaArrays(): Promise<{ base: number; ids: string[]; quotas: number[] }> {
  const base = selectedSourceDailyBase();
  let multipliers: ReadonlyMap<string, number> = new Map();
  if (base > 0 && sourceQuotaProvider) {
    try { multipliers = await sourceQuotaProvider(); } catch { multipliers = new Map(); }
  }
  const ids = [...multipliers.keys()];
  return { base, ids, quotas: ids.map((id) => sourceQuota(base, multipliers.get(id))) };
}

export async function queryGroupedAnchors(q: TimelineQuery, now: Date) {
  const { base, ids, quotas } = await quotaArrays();
  const rows = (
    await sql<{ gk: string; anchor_at: Date }[]>`
      WITH base AS MATERIALIZED (
        SELECT p.published_at, p.source_id, p.score, p.article_id,
          CASE WHEN p.fact_id IS NOT NULL AND ${ownFactEvidenceCondition()} AND ${foldableSelectionCondition()}
          THEN 'f' || p.fact_id::text ELSE 'a' || p.article_id END AS gk
        FROM publications p
        WHERE ${selectedCondition(now)} AND ${listingFreshCondition(now)} ${filterSql(q)}
      ),
      quota AS (SELECT * FROM unnest(${ids}::text[], ${quotas}::int[]) AS t(source_id, quota)),
      ranked AS (
        SELECT b.*, coalesce(qt.quota, ${Math.max(1, base)}::int) AS quota,
          row_number() OVER (
            PARTITION BY b.source_id, (b.published_at AT TIME ZONE 'Asia/Shanghai')::date
            ORDER BY b.score DESC NULLS LAST, b.published_at DESC, b.article_id DESC
          ) AS rn
        FROM base b LEFT JOIN quota qt ON qt.source_id = b.source_id
      )
      SELECT gk, min(published_at) AS anchor_at FROM ranked
      WHERE ${base > 0 ? sql`rn <= quota` : sql`true`}
      GROUP BY gk ORDER BY anchor_at DESC NULLS LAST, gk COLLATE "C" DESC`
  ).map((r) => ({ gk: r.gk, anchor: r.anchor_at.getTime() }));
  return rows;
}

/** Counts requested Beijing days over anchors already sorted newest first. */
export function countTimelineDays(grouped: readonly { anchor: number }[], days: ReadonlySet<string>): Record<string, number> {
  const firstBelow = (bound: number) => {
    let lo = 0, hi = grouped.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (grouped[mid]!.anchor >= bound) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const counts: Record<string, number> = {};
  for (const day of days) {
    const start = beijingMidnight(day).getTime();
    const count = firstBelow(start) - firstBelow(start + 86_400_000);
    if (count) counts[day] = count;
  }
  return counts;
}

export async function loadTimeline(q: TimelineQuery): Promise<Omit<TimelineResponse, "hot">> {
  const now = q.now ?? new Date();
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 40);
  const bind = binding(q);
  let after: { a: number; g: string } | null = null;
  if (q.cursor) {
    const c = decodeCursor<{ a: number; g: string; b: string }>("tl2", q.cursor);
    if (c.b !== bind || typeof c.a !== "number" || typeof c.g !== "string") throw new InvalidCursorError("cursor does not match this query");
    after = { a: c.a, g: c.g };
  }

  // A given clock (tests, replays) reads afresh.
  const grouped = q.now ? await queryGroupedAnchors(q, now) : await groupedAnchors(q);
  const start = after ? grouped.findIndex((g) => g.anchor < after!.a || (g.anchor === after!.a && g.gk < after!.g)) : 0;
  const groups: GroupRow[] = (start < 0 ? [] : grouped.slice(start, start + limit + 1)).map((g) => ({ gk: g.gk, anchor_at: new Date(g.anchor) }));

  const page = groups.slice(0, limit);
  const hasMore = groups.length > limit;

  const factIds = page.filter((g) => g.gk.startsWith("f")).map((g) => Number(g.gk.slice(1)));

  // Read only ranking fields for the whole group; bodies, media and translations are hydrated for this page's representatives.
  type Member = RepresentativeRow & Pick<ItemRow, "id"> & { fact_id: number };
  const [members, pool] = await Promise.all([
    factIds.length
      ? sql<Member[]>`
        SELECT p.fact_id, p.article_id AS id, p.body_mode, p.score, p.timeline_at, ${REPRESENTATIVE_COLUMNS}
        FROM publications p JOIN sources s ON s.id = p.source_id LEFT JOIN facts f ON f.id = p.fact_id
        WHERE p.fact_id IN ${sql(factIds)}
          AND ${selectedCondition(now)} AND ${ownFactEvidenceCondition()} AND ${foldableSelectionCondition()} ${filterSql(q)}`
      : Promise.resolve([] as Member[]),
    groupPool(q, now, factIds),
  ]);
  const factInfo = new Map(
    factIds.length ? (await sql<{ id: number; public_id: string }[]>`SELECT id, public_id FROM facts WHERE id IN ${sql(factIds)}`).map((f) => [f.id, f]) : [],
  );

  const planned: Array<{ key: string; anchorAt: string; id: string; group: GroupInfo | null }> = [];
  for (const g of page) {
    if (g.gk.startsWith("a")) {
      planned.push({ key: g.gk, anchorAt: g.anchor_at.toISOString(), id: g.gk.slice(1), group: null });
      continue;
    }
    const factId = Number(g.gk.slice(1));
    const candidates = members.filter((m) => m.fact_id === factId);
    if (!candidates.length) continue;
    const rep = pickRepresentative(candidates);
    const reports = pool.filter((r) => r.fact_id === factId);
    const repSource = reports.find((r) => r.article_id === rep.id)?.source_id;
    const group: GroupInfo = {
      factId: factInfo.get(factId)?.public_id ?? String(factId),
      additionalSourceCount: new Set(reports.filter((r) => r.source_id !== repSource).map((r) => r.source_id)).size,
      reportCount: new Set(reports.map((r) => r.article_id)).size,
      memberIds: [...new Set(candidates.map((m) => m.id))],
    };
    const showGroup = group.reportCount > 1;
    planned.push({ key: g.gk, anchorAt: g.anchor_at.toISOString(), id: rep.id, group: showGroup ? group : null });
  }

  // Recheck scope when hydrating: a withdrawal may commit after the narrow representative read.
  const rows = new Map(planned.length ? (await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN ${sql(planned.map((p) => p.id))}
      AND ${selectedCondition(now)} ${filterSql(q)}`).map((row) => [row.id, row]) : []);
  const cards: TimelineCard[] = planned.flatMap(({ id, key, anchorAt, group }) => {
    const row = rows.get(id);
    if (!row) return [];
    return [{ key, anchorAt, item: toFeedItemSummary(row), group }];
  });

  // Day header counts for the days on this page, over the full grouped set.
  const days = new Set(page.map((g) => beijingDate(g.anchor_at)));
  const dayCounts = countTimelineDays(grouped, days);

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor("tl2", { a: last.anchor_at.getTime(), g: last.gk, b: bind }) : null;
  return { filters: { channel: q.channel, category: q.category, tag: q.tag }, cards, nextCursor, dayCounts };
}

/** Internal window evidence for device preference projection (same cursor window only). */
export interface TimelineReaderCandidate {
  itemId: string;
  sourceId: string;
  publicBaseScore: number;
  publicTimeMs: number;
  groupKey: string;
}

export interface TimelineReaderWindow {
  data: Omit<TimelineResponse, "hot">;
  candidates: TimelineReaderCandidate[];
}

/**
 * Public timeline page plus per-card (and group member) candidates.
 * groupKey is the fact public id when folded, else the item id. Votes never change eligibility.
 */
export async function loadTimelineReaderWindow(q: TimelineQuery): Promise<TimelineReaderWindow> {
  const data = await loadTimeline(q);
  if (!data.cards.length) return { data, candidates: [] };

  const memberIds = new Set<string>();
  const cardMeta = new Map<string, { groupKey: string; publicBaseScore: number; publicTimeMs: number }>();
  for (const card of data.cards) {
    const groupKey = card.group?.factId ?? card.item.id;
    const publicTimeMs = Date.parse(card.anchorAt);
    const publicBaseScore = publicTimeMs;
    cardMeta.set(card.item.id, { groupKey, publicBaseScore, publicTimeMs });
    if (card.group?.memberIds?.length) {
      for (const id of card.group.memberIds) {
        memberIds.add(id);
        if (!cardMeta.has(id)) cardMeta.set(id, { groupKey, publicBaseScore, publicTimeMs });
      }
    } else {
      memberIds.add(card.item.id);
    }
  }

  const ids = [...memberIds];
  const rows = ids.length
    ? await sql<{ article_id: string; source_id: string }[]>`
        SELECT p.article_id, p.source_id FROM publications p WHERE p.article_id IN ${sql(ids)}`
    : [];
  const sourceById = new Map(rows.map((r) => [r.article_id, r.source_id]));

  const candidates: TimelineReaderCandidate[] = [];
  for (const id of ids) {
    const meta = cardMeta.get(id);
    const sourceId = sourceById.get(id);
    if (!meta || !sourceId) continue;
    candidates.push({
      itemId: id,
      sourceId,
      publicBaseScore: meta.publicBaseScore,
      publicTimeMs: meta.publicTimeMs,
      groupKey: meta.groupKey,
    });
  }
  return { data, candidates };
}
