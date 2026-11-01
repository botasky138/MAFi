// Global per-source quota multipliers from reader votes (docs/mafi-source-quota-design.md).
// Votes never reorder anything; they only scale how many 精选 items a source may show per day.
import { sql, type Db } from "@aihot/backend/db";

export const QUOTA_HALF_LIFE_DAYS = 30;
export const QUOTA_PRIOR_UP = 2;
export const QUOTA_PRIOR_DOWN = 2;
export const QUOTA_DEVICE_CAP = 5;
export const QUOTA_MIN = 0.5;
export const QUOTA_MAX = 2;

/** Bayesian-smoothed approval p in (0,1), mapped symmetrically to [0.5, 2] (p=0.5 -> 1x). */
export function quotaMultiplier(ups: number, downs: number): number {
  const p = (ups + QUOTA_PRIOR_UP) / (ups + downs + QUOTA_PRIOR_UP + QUOTA_PRIOR_DOWN);
  const m = 2 ** (4 * (p - 0.5));
  return Math.min(QUOTA_MAX, Math.max(QUOTA_MIN, m));
}

export interface SourceVoteMass { sourceId: string; ups: number; downs: number; multiplier: number }

/** Decayed (half-life) vote mass per source across all devices; each device capped per source. */
export async function readSourceVoteMass(db: Db = sql): Promise<SourceVoteMass[]> {
  const rows = await db<{ source_id: string; ups: number; downs: number }[]>`
    WITH per_device AS (
      SELECT source_id, device_id,
        sum(power(0.5, extract(epoch FROM now() - updated_at) / ${QUOTA_HALF_LIFE_DAYS * 86400}::float8)) FILTER (WHERE vote = 'up') AS ups,
        sum(power(0.5, extract(epoch FROM now() - updated_at) / ${QUOTA_HALF_LIFE_DAYS * 86400}::float8)) FILTER (WHERE vote = 'down') AS downs
      FROM mafi_preference_reactions WHERE vote IS NOT NULL
      GROUP BY source_id, device_id
    )
    SELECT source_id,
      sum(least(coalesce(ups, 0), ${QUOTA_DEVICE_CAP}))::float8 AS ups,
      sum(least(coalesce(downs, 0), ${QUOTA_DEVICE_CAP}))::float8 AS downs
    FROM per_device GROUP BY source_id`;
  return rows.map((r) => ({ sourceId: r.source_id, ups: r.ups, downs: r.downs, multiplier: quotaMultiplier(r.ups, r.downs) }));
}

let cache: { at: number; value: Map<string, number> } | null = null;
const CACHE_MS = 60_000;

export function invalidateSourceQuota(): void { cache = null; }

export async function sourceQuotaMultipliers(): Promise<Map<string, number>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = new Map((await readSourceVoteMass()).map((r) => [r.sourceId, r.multiplier]));
  cache = { at: Date.now(), value };
  return value;
}
