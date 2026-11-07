export type TrendSince = "daily" | "weekly" | "monthly";

export interface TrendItem {
  fullName: string;
  url: string;
  description: string;
  language: string | null;
  starsTotal: number | null;
  starsPeriod: number;
  periodText: string;
  category: "pending";
  topics: [];
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
