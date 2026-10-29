// Hard published-date floor for ingest and 精选 (2026-10-29). Overridable via MAFI_INGEST_PUBLISHED_FLOOR.
export const DEFAULT_INGEST_PUBLISHED_FLOOR = "2026-10-01T00:00:00+08:00";

function parseFloor(raw: string | undefined): Date {
  const d = new Date(raw && raw.trim() ? raw.trim() : DEFAULT_INGEST_PUBLISHED_FLOOR);
  return Number.isFinite(d.getTime()) ? d : new Date(DEFAULT_INGEST_PUBLISHED_FLOOR);
}

/** Items published before this instant never enter storage, 精选 or any public feed. */
export const INGEST_PUBLISHED_FLOOR: Date = parseFloor(process.env.MAFI_INGEST_PUBLISHED_FLOOR);

/** True when the item carries a real publish date that is older than the floor (reject at ingest). */
export function isBeforeIngestFloor(publishedAt: Date | null | undefined, floor: Date = INGEST_PUBLISHED_FLOOR): boolean {
  return !!publishedAt && Number.isFinite(publishedAt.getTime()) && publishedAt.getTime() < floor.getTime();
}

/** 精选 requires a real, parsed publish date on/after the floor; undated (fetch-time) items never qualify. */
export function meetsPublishedFloor(publishedAt: Date | null | undefined, floor: Date = INGEST_PUBLISHED_FLOOR): boolean {
  return !!publishedAt && Number.isFinite(publishedAt.getTime()) && publishedAt.getTime() >= floor.getTime();
}
