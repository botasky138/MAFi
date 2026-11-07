import { useEffect, type ReactNode } from "react";
import { Link, useRevalidator } from "react-router";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { IconArrowUpRight } from "@aihot/web/components/icons";
import type { ReadResult } from "../contracts.ts";

export const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };

export function timeLabel(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value)) ? `${beijingDate(value)} ${beijingTime(value)}` : "暂无记录";
}

export function externalUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return /^(https?:)$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function SourceLink({ href, children, className = "" }: { href: string | null | undefined; children: ReactNode; className?: string }) {
  const safe = externalUrl(href);
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1 hover:text-accent ${className}`}>{children}<IconArrowUpRight size={12} /></a> : <span className={className}>{children}</span>;
}

/** A page in the foreground checks again; the backend also enforces each source's minimum interval. */
export function useReaderRefresh(enabled = true, intervalMs = 600_000) {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void revalidator.revalidate();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, revalidator.revalidate]);
}

export interface ReaderFlags { codexReset: boolean; githubTrend: boolean }

export function ReaderState<T>({ result }: { result: ReadResult<T> }) {
  if (result.status === "ready") return null;
  return <div role="status" className="mb-5 rounded-card border border-line bg-surface px-4 py-3 text-[13px] leading-[1.8] text-ink-3">
    {result.status === "stale" && <strong className="mr-2 font-semibold text-ink">正在显示上次成功取得的数据</strong>}
    {result.message ?? (result.status === "needs_key" ? "连接数据源后即可查看。" : "数据源暂时不可用。")}
  </div>;
}

export function ReaderFooter<T>({ result, name }: { result: ReadResult<T>; name: string }) {
  return <footer className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4 text-[12px] leading-[1.8] text-ink-4">
    <SourceLink href={result.sourceUrl}>来源：{name}</SourceLink>
    <span>本机取得：{timeLabel(result.fetchedAt)} · 北京时间</span>
    <span>打开本页时每 10 分钟检查更新</span>
  </footer>;
}

export function ReaderNav({ active, flags, tone = "site" }: { active: "codex" | "aa" | "github"; flags: ReaderFlags; tone?: "site" | "inverse" }) {
  const links = [
    ["aa", "/leaderboard", "AA 模型榜", true],
    ["github", "/github-trending", "GitHub 趋势", flags.githubTrend],
    ["codex", "/codex-reset", "Tibo 重置监控", flags.codexReset],
  ] as const;
  const on = tone === "inverse" ? "font-semibold text-[#e8e8ec]" : "font-semibold text-ink";
  const off = tone === "inverse" ? "text-[#9a9aa4] hover:text-[#e8d48b]" : "text-ink-4 hover:text-accent";
  const rule = tone === "inverse" ? "border-[#3a3a40]" : "border-line";
  return <nav aria-label="外部观察" className={`mb-6 flex flex-wrap gap-x-6 gap-y-2 border-b pb-3 text-[13px] ${rule}`}>
    {links.filter(([, , , shown]) => shown).map(([key, to, label]) => <Link key={key} to={to} aria-current={active === key ? "page" : undefined} className={active === key ? on : off}>{label}</Link>)}
  </nav>;
}
