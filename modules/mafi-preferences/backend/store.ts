import { sql, type Db } from "@aihot/backend/db";
import type { ReactionResult, SourceCounts, Vote } from "../contracts.ts";
import { sourceWeight } from "./weights.ts";
import { invalidateSourceQuota } from "./quota.ts";

export async function ensureDeviceRow(deviceId: string, db: Db = sql): Promise<void> {
  await db`
    INSERT INTO mafi_preference_devices (device_id, user_id) VALUES (${deviceId}, null)
    ON CONFLICT (device_id) DO UPDATE SET updated_at = now()`;
}

async function countsFor(deviceId: string, sourceId: string, db: Db): Promise<SourceCounts> {
  const [row] = await db<SourceCounts[]>`
    SELECT
      count(*) FILTER (WHERE vote = 'up')::int AS ups,
      count(*) FILTER (WHERE vote = 'down')::int AS downs
    FROM mafi_preference_reactions
    WHERE device_id = ${deviceId} AND source_id = ${sourceId} AND vote IS NOT NULL`;
  return { ups: row?.ups ?? 0, downs: row?.downs ?? 0 };
}

export async function setReaction(deviceId: string, itemId: string, vote: Vote, sourceId: string, db: Db = sql): Promise<ReactionResult> {
  await ensureDeviceRow(deviceId, db);
  await db`
    INSERT INTO mafi_preference_reactions (device_id, article_id, source_id, vote, updated_at)
    VALUES (${deviceId}, ${itemId}, ${sourceId}, ${vote}, now())
    ON CONFLICT (device_id, article_id) DO UPDATE SET
      source_id = EXCLUDED.source_id,
      vote = EXCLUDED.vote,
      updated_at = now()`;
  invalidateSourceQuota();
  const source = await countsFor(deviceId, sourceId, db);
  return { itemId, myVote: vote, source: { ...source, weight: sourceWeight(source) } };
}

export async function readVotes(deviceId: string, itemIds: readonly string[], db: Db = sql): Promise<Map<string, Vote>> {
  const out = new Map<string, Vote>();
  if (itemIds.length === 0) return out;
  const rows = await db<{ article_id: string; vote: Vote }[]>`
    SELECT article_id, vote FROM mafi_preference_reactions
    WHERE device_id = ${deviceId} AND article_id IN ${db(itemIds as string[])} AND vote IS NOT NULL`;
  for (const row of rows) out.set(row.article_id, row.vote);
  return out;
}

export async function readSourceCounts(deviceId: string, sourceIds: readonly string[], db: Db = sql): Promise<Map<string, SourceCounts>> {
  const out = new Map<string, SourceCounts>();
  for (const id of sourceIds) out.set(id, { ups: 0, downs: 0 });
  if (sourceIds.length === 0) return out;
  const rows = await db<{ source_id: string; ups: number; downs: number }[]>`
    SELECT source_id,
      count(*) FILTER (WHERE vote = 'up')::int AS ups,
      count(*) FILTER (WHERE vote = 'down')::int AS downs
    FROM mafi_preference_reactions
    WHERE device_id = ${deviceId} AND source_id IN ${db(sourceIds as string[])} AND vote IS NOT NULL
    GROUP BY source_id`;
  for (const row of rows) out.set(row.source_id, { ups: row.ups, downs: row.downs });
  return out;
}
