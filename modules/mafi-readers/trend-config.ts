// MAFi's own choices for the GitHub trend page.

/**
 * Repositories never shown, lowercase owner/repo. Empty since 2026-11-09: vercel-labs/agent-desktop and
 * thedotmack/claude-mem were hidden for crowding the list, not for being worthless; the 常驻 rule now keeps
 * a repo that sits on the daily list for days out of the 精选 seats while it stays in the list.
 */
export const EXCLUDED_REPOS: readonly string[] = [];

/** A repo on the daily list this many days in a row is 常驻. */
export const RESIDENT_DAYS = 3;
