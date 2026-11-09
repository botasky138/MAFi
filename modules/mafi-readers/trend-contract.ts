export type TrendSince = "daily" | "weekly" | "monthly";

/** Order matters: a tie in the rules goes to the earlier category. */
export const TREND_CATEGORIES = ["agent", "llm", "devtools", "infra", "data", "frontend", "security", "learning", "other"] as const;
export type TrendCategory = (typeof TREND_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<TrendCategory, string> = {
  agent: "AI Agent",
  llm: "LLM 应用/模型",
  devtools: "开发工具",
  infra: "基础设施/运维",
  data: "数据/数据库",
  frontend: "前端/设计",
  security: "安全",
  learning: "教程/清单",
  other: "其他",
};

/**
 * new: created within 30 days. surge: at least a third of its stars came in this period.
 * resident: on the daily list for 3+ days in a row (it stays listed but gives up its 精选 seat).
 * triple: on the daily, weekly and monthly lists at once.
 */
export type TrendBadge = "new" | "surge" | "resident" | "triple";

export const BADGE_LABELS: Record<TrendBadge, string> = { new: "新星", surge: "爆发", resident: "常驻", triple: "三榜" };

export interface TrendItem {
  fullName: string;
  url: string;
  description: string;
  language: string | null;
  /** The live count from the GitHub API when it has been polled, else the trending page's. */
  starsTotal: number | null;
  /** The trending page's own number for this period. */
  starsPeriod: number;
  periodText: string;
  /** Stars gained over the last hour of polls; null until an hour of polls exists. */
  starsHour: number | null;
  /** Hourly totals over the last 24 hours, oldest first; empty without polls. */
  spark: number[];
  category: TrendCategory;
  secondary: TrendCategory | null;
  /** One Chinese sentence written by the purpose model; null until written. */
  purpose: string | null;
  topics: string[] | null;
  createdAt: string | null;
  badges: TrendBadge[];
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
  /** Full names of the 精选 cards, in order. */
  featured: string[];
  /** The last successful star poll. */
  starsAt: string | null;
  /** Stars were polled within the last 20 minutes. */
  live: boolean;
}

export function isTrendSince(value: string | null): value is TrendSince {
  return value === "daily" || value === "weekly" || value === "monthly";
}

export function isTrendCategory(value: unknown): value is TrendCategory {
  return typeof value === "string" && (TREND_CATEGORIES as readonly string[]).includes(value);
}
