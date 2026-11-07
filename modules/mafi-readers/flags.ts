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
