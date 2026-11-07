export type TrendSince = "daily" | "weekly" | "monthly";
export type TrendCategory = "agent" | "devtools" | "infra" | "unclassified" | "pending";

export interface TrendItem {
  fullName: string;
  url: string;
  description: string;
  language: string | null;
  starsTotal: number | null;
  starsPeriod: number;
  periodText: string;
  /** pending：topics 还没取到。unclassified：取到了但规则不能唯一归类。 */
  category: TrendCategory;
  /** null 表示还没有成功取到 topics。空数组表示仓库没有 topic。 */
  topics: string[] | null;
}

export interface TrendWindowResult {
  status: "ready" | "stale" | "unavailable" | "disabled";
  since: TrendSince;
  sourceUrl: string;
  fetchedAt: string | null;
  attemptedAt: string | null;
  nextRefreshAt: string | null;
  trigger: "schedule" | "admin" | null;
  message: string | null;
  items: TrendItem[];
  demo: boolean;
}

export function isTrendSince(value: string | null): value is TrendSince {
  return value === "daily" || value === "weekly" || value === "monthly";
}
