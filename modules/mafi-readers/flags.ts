/** Switches open only for the exact lowercase string, matching the rest of the site. */
export function explicitlyEnabled(value: string | undefined): boolean {
  return value === "true";
}

export function codexResetEnabled(): boolean {
  return explicitlyEnabled(process.env.MAFI_CODEX_RESET_ENABLED);
}

export function githubTrendEnabled(): boolean {
  return explicitlyEnabled(process.env.MAFI_GITHUB_TREND_ENABLED);
}

/**
 * Only enable on private/authenticated self-hosted deployments (e.g., behind Cloudflare Zero Trust Access)
 * so external readers like AA and Tibo work on a non-loopback SITE_URL without exposing them publicly.
 */
export function readersAllowExternalSite(): boolean {
  return explicitlyEnabled(process.env.MAFI_READERS_ALLOW_EXTERNAL_SITE);
}
