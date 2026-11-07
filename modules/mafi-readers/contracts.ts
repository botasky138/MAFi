/** Private, local reader data. Strings are plain text, never HTML. */
export type ReadStatus = "ready" | "stale" | "unavailable" | "needs_key" | "local_only" | "paused" | "disabled";
export interface ReadResult<T> {
  status: ReadStatus;
  sourceUrl: string;
  fetchedAt: string | null;
  nextRefreshAt: string | null;
  message: string | null;
  data: T | null;
}

export interface CodexContextPost {
  id: string; author: string; relation: "reply" | "quote";
  text: string | null; originalText: string; url: string;
}
export interface CodexPost {
  id: string; publishedAt: string; stage: string; text: string; originalText: string;
  fullText: string | null; fullOriginalText: string | null;
  context: CodexContextPost[]; url: string;
}
export interface CodexPresentation {
  status: "announced" | "in_progress" | "confirmed" | "expired_unconfirmed" | "likely_completed";
  scopeKnown: boolean; scopeLabel: string | null; kindExplicit: boolean; timeInferred: boolean;
  audienceZh: string | null; productsZh: string | null; reportedAt: string | null;
}
export interface CodexEvent {
  id: string; type: "direct_reset" | "reset_credit"; displayLabel: string;
  presentation: CodexPresentation | null;
  status: "announced" | "confirmed"; title: string;
  createdAt: string; updatedAt: string;
  /** Source confirmation post time; never an account credit receipt. */
  confirmedAt: string | null;
  occurredOn: string | null;
  confirmationBasis: "source_post" | "receipt_review" | null;
  schedule: { precision: "exact" | "approximate" | "deadline" | "date" | "window"; from: string; through: string; label: string } | null;
  estimate: { from: string; through: string; basis: "model" | "source" | "source_day" | "history"; label: string; reason: string } | null;
  posts: CodexPost[]; url: string;
}
export interface CodexActivity {
  id: string; publishedAt: string; eventIds: string[]; kind: "event_update" | "related";
  text: string | null; originalText: string; context: CodexContextPost[];
  statusChanged: boolean; action: "announce" | "confirm" | "amend" | "withdraw" | null; url: string;
}
export interface CodexData {
  timezone: "Asia/Shanghai"; today: string | null; checkedAt: string | null; historyFrom: string;
  events: CodexEvent[]; activities: CodexActivity[];
  monitor: { status: "healthy" | "delayed" | "attention" | "unknown"; lastAttemptAt: string | null; lastCollectedAt: string | null; lastVerifiedAt: string | null; heldWindowCount: number; pendingCount: number; reviewCount: number } | null;
  outage: { postId: string; publishedAt: string; text: string | null; originalText: string; recoveredAt: string | null; resetEventId: string | null; url: string } | null;
}

export interface AaModel {
  id: string; name: string; slug: string; release_date: string | null;
  model_creator: { id: string; name: string; slug?: string };
  evaluations: Record<string, number | null>;
  pricing: Record<string, number | null>;
  performance: Record<string, number | null>;
}
export interface AaData {
  tier: "free" | "pro" | "commercial";
  intelligence_index_version: number;
  /** Complete official page order; no invented ranks or composite scores. */
  models: AaModel[];
  pages: number;
}
