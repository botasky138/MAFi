import fs_pin from "node:fs";
function requirePreviewDatabaseUrl(value) {
  if (!value) throw new Error("Set PREVIEW_DATABASE_URL before running this helper");
  const parsed = new URL(value);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("PREVIEW_DATABASE_URL must use PostgreSQL");
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!/(?:^|[_-])preview(?:[_-]|$)|(?:_test|_ci)$/i.test(database)) throw new Error("Use a dedicated preview, _test or _ci database");
  // Pin (2026-10-30): refuse to run against any DB other than the pinned preview DB (no silent drift).
  {
    let pin = process.env.MAFI_PREVIEW_DB;
    if (!pin) { try { const m = fs_pin.readFileSync(".env", "utf8").match(/^MAFI_PREVIEW_DB=(.+)$/m); if (m) pin = m[1].trim().replace(/^["']|["']$/g, ""); } catch {} }
    pin ||= "mafi_preview_20261021";
    if (pin && database !== pin) throw new Error(`Preview DB drift: PREVIEW_DATABASE_URL points at "${database}" but MAFI_PREVIEW_DB pins "${pin}"`);
    console.error(`[mafi] preview database: ${database}${pin ? " (pinned)" : " (UNPINNED)"}`);
  }
  return value;
}
import postgres from "postgres";

const sql = postgres(requirePreviewDatabaseUrl(process.env.PREVIEW_DATABASE_URL), { max: 1 });

const categoryBySource = {
  "web-nmpa-devices": "device-policy",
  "web-nmpa-trends": "device-policy",
  "web-smpaa-notices": "device-procurement",
  "web-nhsa-news": "device-policy",
  "web-nbs-releases": "macro",
  "web-pboc-news": "macro",
  "web-safe-news": "macro",
  "rss-fed-press": "macro",
  "web-csrc-market": "markets",
  "rss-cnbc-top": "markets",
  "web-stcn-news": "markets",
  "web-shfe-notices": "derivatives",
};

const rows = await sql`
  SELECT a.id, a.source_id, a.title, a.url, a.excerpt, a.published_at, a.discovered_at, a.timeline_at, a.backfill,
         s.tier, s.name AS source_name, s.tags
  FROM articles a
  JOIN sources s ON s.id = a.source_id
  WHERE a.source_id = ANY(${Object.keys(categoryBySource)})
  ORDER BY a.timeline_at DESC
`;

let inserted = 0;
let seqRow = await sql`SELECT coalesce(max(seq), 0)::bigint AS seq FROM selected_ledger`;
let seq = Number(seqRow[0].seq);

for (const a of rows) {
  const category = categoryBySource[a.source_id];
  const title = String(a.title || "").trim() || "(untitled)";
  const summary = (a.excerpt && String(a.excerpt).trim()) || `采集预览：${a.source_name}`;
  const reason = "collect-preview（MODEL_CALLS_ENABLED=false；非模型精选）";
  const tags = Array.isArray(a.tags) ? a.tags.slice(0, 6) : [];
  const searchText = [title, summary, a.source_name, ...tags].filter(Boolean).join(" ").toLowerCase();
  const now = new Date();
  const firstParty = a.tier === "T1";

  await sql`
    INSERT INTO publications (
      article_id, analysis_id, revision, visibility, eligible, selected, selection_candidate,
      title, original_title, summary, reason, category, tags, score,
      source_id, channel, first_party, url, published_at, discovered_at, timeline_at, backfill,
      selected_ready_at, visible_after, body_mode, syndicate, indexable, story_id, fact_id,
      search_text, sort_at, seat, updated_at
    ) VALUES (
      ${a.id}, null, 1, 'public', true, true, false,
      ${title}, null, ${summary}, ${reason}, ${category}, ${tags}, 70.0,
      ${a.source_id}, 'news', ${firstParty}, ${a.url}, ${a.published_at}, ${a.discovered_at}, ${a.timeline_at}, ${a.backfill},
      ${now}, ${now}, 'summary', false, false, null, null,
      ${searchText}, ${a.timeline_at}, true, now()
    )
    ON CONFLICT (article_id) DO UPDATE SET
      visibility='public', eligible=true, selected=true, seat=true,
      title=EXCLUDED.title, summary=EXCLUDED.summary, reason=EXCLUDED.reason,
      category=EXCLUDED.category, tags=EXCLUDED.tags, score=EXCLUDED.score,
      search_text=EXCLUDED.search_text, sort_at=EXCLUDED.sort_at,
      selected_ready_at=COALESCE(publications.selected_ready_at, EXCLUDED.selected_ready_at),
      visible_after=COALESCE(publications.visible_after, EXCLUDED.visible_after),
      updated_at=now()
  `;

  await sql`
    INSERT INTO pool_search (article_id, direct, body)
    VALUES (${a.id}, ${searchText}, '')
    ON CONFLICT (article_id) DO UPDATE SET direct=EXCLUDED.direct
  `;

  const payload = {
    id: a.id,
    title,
    summary,
    source: a.source_name,
    url: a.url,
    category,
    selected: true,
    collectPreview: true,
  };
  seq += 1;
  await sql`
    INSERT INTO selected_ledger (seq, article_id, op, changed_at, visible_at, payload)
    VALUES (${seq}, ${a.id}, 'upsert', now(), now(), ${sql.json(payload)})
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO selected_state (article_id, in_set, payload_hash, last_seq)
    VALUES (${a.id}, true, ${String(seq)}, ${seq})
    ON CONFLICT (article_id) DO UPDATE SET in_set=true, last_seq=EXCLUDED.last_seq, payload_hash=EXCLUDED.payload_hash
  `;
  inserted += 1;
}

const pub = await sql`SELECT count(*)::int AS n FROM publications WHERE eligible AND selected`;
const items = await sql`
  SELECT count(*)::int AS n FROM publications p
  WHERE p.visibility='public' AND p.selected AND p.seat AND p.visible_after <= now()
`;
console.log(JSON.stringify({ articles: rows.length, upserted: inserted, publicationsSelected: pub[0].n, seatedNow: items[0].n }));
await sql.end();
