import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Hot rankings and reports carry their own dates (computed_at / generated_at); the article
// published_at ingest floor must never be applied to them (regression 2026-10-29).
for (const f of ["packages/backend/src/events/hot.ts", "packages/backend/src/publication/reports.ts"]) {
  test(`${f} does not apply the article published floor`, () => {
    const src = readFileSync(f, "utf8");
    for (const banned of ["publishedFloorCondition", "listingFreshCondition", "INGEST_PUBLISHED_FLOOR", "meetsPublishedFloor", "isBeforeIngestFloor"]) {
      assert.ok(!src.includes(banned), `${f} must not reference ${banned}`);
    }
  });
}
