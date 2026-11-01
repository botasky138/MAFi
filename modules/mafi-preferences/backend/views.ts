import type { FeedItemSummary, HotResponse, PoolResponse, TimelineResponse } from "@aihot/contracts/site";
import type { SourceCounts, Vote } from "../contracts.ts";
import { reorderFlat, reorderGrouped, type Rankable } from "./weights.ts";

export interface ReaderCandidate {
  itemId: string;
  sourceId: string;
  publicBaseScore: number;
  publicTimeMs: number;
  groupKey?: string;
}

function stamp(item: FeedItemSummary, vote: Vote | undefined): FeedItemSummary {
  return { ...item, myVote: vote ?? null };
}

export function projectPool(
  data: PoolResponse,
  candidates: readonly ReaderCandidate[],
  votes: Map<string, Vote>,
  counts: Map<string, SourceCounts>,
): PoolResponse {
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const ranked: (Rankable & { item: FeedItemSummary })[] = [];
  for (const c of candidates) {
    const item = byId.get(c.itemId);
    if (!item) continue;
    const vote = votes.get(c.itemId) ?? null;
    ranked.push({
      id: c.itemId,
      publicBaseScore: c.publicBaseScore,
      publicTimeMs: c.publicTimeMs,
      vote,
      sourceCounts: counts.get(c.sourceId) ?? { ups: 0, downs: 0 },
      item: stamp(item, vote),
    });
  }
  // The time tab is strictly newest-first by publish time (SQL order); votes only stamp, never reorder.
  if (data.filters.tab !== "relevance") return { ...data, items: data.items.map((i) => stamp(i, votes.get(i.id) ?? undefined)) };
  return { ...data, items: reorderFlat(ranked).map((r) => r.item) };
}

export function projectTimeline(
  data: TimelineResponse,
  candidates: readonly ReaderCandidate[],
  votes: Map<string, Vote>,
  counts: Map<string, SourceCounts>,
): TimelineResponse {
  const byId = new Map(data.cards.map((c) => [c.item.id, c]));
  // Rank every window member so group order uses max member finalSortKey; emit cards only.
  const ranked: Rankable[] = [];
  for (const c of candidates) {
    const vote = votes.get(c.itemId) ?? null;
    ranked.push({
      id: c.itemId,
      groupKey: c.groupKey,
      publicBaseScore: c.publicBaseScore,
      publicTimeMs: c.publicTimeMs,
      vote,
      sourceCounts: counts.get(c.sourceId) ?? { ups: 0, downs: 0 },
    });
  }
  const order = reorderGrouped(ranked.length ? ranked : data.cards.map((card) => {
    const vote = votes.get(card.item.id) ?? null;
    return {
      id: card.item.id,
      groupKey: card.group?.factId ?? card.item.id,
      publicBaseScore: Date.parse(card.anchorAt),
      publicTimeMs: Date.parse(card.anchorAt),
      vote,
      sourceCounts: { ups: 0, downs: 0 },
    };
  }));
  const seen = new Set<string>();
  const cards: typeof data.cards = [];
  for (const r of order) {
    const card = byId.get(r.id);
    if (!card || seen.has(card.key)) continue;
    seen.add(card.key);
    cards.push({ ...card, item: stamp(card.item, votes.get(card.item.id) ?? undefined) });
  }
  for (const card of data.cards) {
    if (seen.has(card.key)) continue;
    seen.add(card.key);
    cards.push({ ...card, item: stamp(card.item, votes.get(card.item.id) ?? undefined) });
  }
  return { ...data, cards };
}

export function projectHot(
  data: HotResponse,
  _candidates: readonly ReaderCandidate[],
  _votes: Map<string, Vote>,
  _counts: Map<string, SourceCounts>,
): HotResponse {
  // 热点 is shown newest-first by each story's latest public report time (loadHot order). Votes used to
  // multiply epoch timestamps here, which jumbled the board; they no longer reorder it.
  return data;
}
