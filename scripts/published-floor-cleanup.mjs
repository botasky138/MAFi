#!/usr/bin/env node
// One-shot (2026-10-29): withdraw publications published before MAFI_INGEST_PUBLISHED_FLOOR (soft, via setVisibility)
// and republish selected rows with no real publish date so the 精选 gate drops them. Pass DATABASE_URL.
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url || !/mafi_preview_|_test$|_ci$/.test(new URL(url).pathname)) throw new Error("DATABASE_URL must be a preview/_test DB");
Object.assign(process.env, { MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false", FEISHU_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false", LOG_LEVEL: "error" });
const sql = postgres(url, { max: 1, onnotice: () => {} });
const { INGEST_PUBLISHED_FLOOR: floor } = await import("@aihot/backend/content/floor");
const { setVisibility } = await import("@aihot/backend/admin/content");
const { publishArticle } = await import("@aihot/backend/publication/publish");
const old = await sql`SELECT p.article_id, p.source_id, p.selected, coalesce(eo.version,0)::int AS version FROM publications p
  LEFT JOIN editorial_overrides eo ON eo.article_id = p.article_id
  WHERE p.published_at < ${floor} AND p.visibility <> 'withdrawn'`;
const bySource = {}; let selectedOld = 0;
for (const r of old) {
  await setVisibility(r.article_id, { visibility: "withdrawn", reason: `published before ingest floor ${floor.toISOString()}`, version: r.version }, "mafi-published-floor");
  bySource[r.source_id] = (bySource[r.source_id] ?? 0) + 1; if (r.selected) selectedOld++;
}
const undated = await sql`SELECT article_id, source_id FROM publications WHERE selected AND published_at IS NULL`;
for (const r of undated) await publishArticle(r.article_id);
const [after] = await sql`SELECT count(*) FILTER (WHERE selected AND (published_at IS NULL OR published_at < ${floor}))::int AS bad_selected,
  count(*) FILTER (WHERE visibility='public' AND published_at < ${floor})::int AS public_old FROM publications`;
console.log(JSON.stringify({ db: new URL(url).pathname.slice(1), floor, withdrawn: old.length, selectedOld, bySource, undatedSelectedRepublished: undated.length, after }));
await sql.end(); const { closeDb } = await import("@aihot/backend/db"); await closeDb();
