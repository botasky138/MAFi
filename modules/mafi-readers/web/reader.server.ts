import { apiGet } from "@aihot/web/lib/api.server";
import type { ReadResult } from "../contracts.ts";
import type { TrendSince, TrendWindowResult } from "../trend-contract.ts";

export async function readPage<T>(endpoint: string, sourceUrl: string, request: Request): Promise<ReadResult<T>> {
  return apiGet<ReadResult<T>>(endpoint, { signal: request.signal }).catch(() => ({
    status: "unavailable", sourceUrl, fetchedAt: null, nextRefreshAt: null, data: null,
    message: "暂时无法连接数据源，请稍后再看或打开来源页面。",
  }));
}

export async function readTrend(since: TrendSince, request: Request): Promise<TrendWindowResult> {
  const sourceUrl = `https://github.com/trending?since=${since}`;
  return apiGet<TrendWindowResult>(`/api/mafi-readers/github-trending?since=${since}`, { signal: request.signal }).catch(() => ({
    status: "unavailable", since, sourceUrl, fetchedAt: null, attemptedAt: null, nextRefreshAt: null,
    trigger: null, message: "暂时连不上本站后端，稍后再刷新试试。", items: [], demo: false, featured: [], starsAt: null, live: false,
  }));
}
