// Hard publish-date floor (2026-10-01 00:00 Asia/Shanghai): older items are rejected at ingest and
// undated items never qualify for 精选.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_INGEST_PUBLISHED_FLOOR, INGEST_PUBLISHED_FLOOR, isBeforeIngestFloor, meetsPublishedFloor } from "@aihot/backend/content/floor";

test("default floor is 2026-10-01 00:00 +08:00", () => {
  assert.equal(DEFAULT_INGEST_PUBLISHED_FLOOR, "2026-10-01T00:00:00+08:00");
  if (!process.env.MAFI_INGEST_PUBLISHED_FLOOR) assert.equal(INGEST_PUBLISHED_FLOOR.toISOString(), "2026-09-30T16:00:00.000Z");
});

test("ingest rejects dated items before the floor, keeps undated for later date fill", () => {
  const floor = new Date(DEFAULT_INGEST_PUBLISHED_FLOOR);
  assert.equal(isBeforeIngestFloor(new Date("2025-12-04T00:00:00+08:00"), floor), true);
  assert.equal(isBeforeIngestFloor(new Date("2026-09-30T23:59:59+08:00"), floor), true);
  assert.equal(isBeforeIngestFloor(new Date("2026-10-01T00:00:00+08:00"), floor), false);
  assert.equal(isBeforeIngestFloor(null, floor), false);
});

test("精选 requires a real publish date on/after the floor", () => {
  const floor = new Date(DEFAULT_INGEST_PUBLISHED_FLOOR);
  assert.equal(meetsPublishedFloor(null, floor), false);
  assert.equal(meetsPublishedFloor(new Date("invalid"), floor), false);
  assert.equal(meetsPublishedFloor(new Date("2026-09-30T23:59:59+08:00"), floor), false);
  assert.equal(meetsPublishedFloor(new Date("2026-10-01T00:00:00+08:00"), floor), true);
});
