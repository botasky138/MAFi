import type { FeedItemSummary, HotResponse, PoolResponse, TimelineResponse } from "@aihot/contracts/site";
import type { SourceCounts, Vote } from "../contracts.ts";

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

/*
 * Votes never reorder anything. 动态/精选/热点 keep the engine's order (publish time newest first,
 * or relevance for search); a device's votes are only stamped as myVote. Votes act on 精选 through
 * the per-source quota (backend/quota.ts), which changes which items appear, not their order.
 */

export function projectPool(
  data: PoolResponse,
  _candidates: readonly ReaderCandidate[],
  votes: Map<string, Vote>,
  _counts: Map<string, SourceCounts>,
): PoolResponse {
  return { ...data, items: data.items.map((i) => stamp(i, votes.get(i.id))) };
}

export function projectTimeline(
  data: TimelineResponse,
  _candidates: readonly ReaderCandidate[],
  votes: Map<string, Vote>,
  _counts: Map<string, SourceCounts>,
): TimelineResponse {
  return { ...data, cards: data.cards.map((card) => ({ ...card, item: stamp(card.item, votes.get(card.item.id)) })) };
}

export function projectHot(
  data: HotResponse,
  _candidates: readonly ReaderCandidate[],
  _votes: Map<string, Vote>,
  _counts: Map<string, SourceCounts>,
): HotResponse {
  return data;
}
