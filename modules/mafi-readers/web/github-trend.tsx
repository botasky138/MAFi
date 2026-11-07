import { useEffect, useRef, useState } from "react";
import { data, Link, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";
import { pageMeta } from "@aihot/web/lib/seo";
import { reducedMotion } from "@aihot/web/lib/motion";
import { codexResetEnabled, githubTrendEnabled } from "../flags.ts";
import { isTrendSince, type TrendSince, type TrendWindowResult } from "../trend-contract.ts";
import { PRIVATE_HEADERS, ReaderNav, useReaderRefresh, type ReaderFlags } from "./common.tsx";
import { readTrend } from "./reader.server.ts";

export const handle: Screen = { tab: "models", name: "GitHub 趋势" };
export const headers = () => PRIVATE_HEADERS;
export const meta = () => pageMeta({
  title: "GitHub 趋势",
  description: "GitHub 趋势页公开候选，按期间新增星数排列。不是全站星增量榜，也不是模型榜。",
  path: "/github-trending",
  noindex: true,
});

const LABELS: Record<TrendSince, string> = { daily: "今日", weekly: "本周", monthly: "本月" };
const PERIOD: Record<TrendSince, string> = { daily: "今日新增", weekly: "本周新增", monthly: "本月新增" };

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const since = url.searchParams.get("since") ?? "daily";
  const flags: ReaderFlags = { codexReset: codexResetEnabled(), githubTrend: githubTrendEnabled() };
  if (!isTrendSince(since)) {
    return data({ result: null, since: "daily" as const, flags, invalid: true }, { status: 400, headers: PRIVATE_HEADERS });
  }
  const result = await readTrend(since, request);
  return data({ result, since, flags, invalid: false }, { headers: PRIVATE_HEADERS });
}

function PeriodNumber({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const previous = useRef(value);
  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (from === value || reducedMotion()) {
      setShown(value);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 400);
      const eased = 1 - (1 - progress) ** 3;
      setShown(Math.round(from + (value - from) * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <span className="tabular-nums">{shown.toLocaleString("en-US")}</span>;
}

function stamp(value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? `${beijingDate(value)} ${beijingTime(value)}` : "暂无";
}

export default function GithubTrendPage() {
  const { result, since, flags, invalid } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [params] = useSearchParams();
  useReaderRefresh(Boolean(result && result.status !== "disabled"), 300_000);
  const active = (isTrendSince(params.get("since")) ? params.get("since") : "daily") as TrendSince;
  const windowSince = since ?? active;
  const busy = revalidator.state !== "idle";
  return (
    <div className="pb-[calc(88px+env(safe-area-inset-bottom))] text-[#e8e8ec] lg:pb-10" style={{ backgroundColor: "#0a0a0c", color: "#e8e8ec" }}>
      <PhoneBar back={{ to: "/leaderboard", label: "AA 模型榜" }} title="GitHub 趋势" />
      <ReaderNav active="github" flags={flags} tone="inverse" />
      <header className="max-w-[68ch]">
        <h1 data-page-title="" className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-[#e8e8ec]">GitHub 趋势</h1>
        <p className="mt-3 text-[14.5px] leading-relaxed text-[#9a9aa4]">
          放在「AA 模型榜」下面只是沿用侧栏位置。这里不是模型排行。列表来自 GitHub 趋势页当时的公开候选，按该页写出的期间新增星数从高到低排列，不是全站新增星数榜。旁边的累计星数不参与排序。刷新只读取本站已经采集的快照。
        </p>
      </header>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="时间范围" className="flex rounded-full border border-[#3a3a40] bg-[#121216] p-1">
          {(["daily", "weekly", "monthly"] as const).map((key) => (
            <Link
              key={key}
              to={key === "daily" ? "/github-trending" : `/github-trending?since=${key}`}
              aria-current={windowSince === key ? "page" : undefined}
              className={`rounded-full px-3 py-1.5 text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9a227] ${windowSince === key ? "bg-[#c9a227] font-semibold text-[#0a0a0c]" : "text-[#9a9aa4] hover:text-[#e8e8ec]"}`}
            >
              {LABELS[key]}
            </Link>
          ))}
        </nav>
        <button
          type="button"
          onClick={() => revalidator.revalidate()}
          disabled={busy || invalid}
          className="rounded-full border border-[#3a3a40] bg-[#121216] px-3 py-1.5 text-[13px] text-[#c8c8d0] hover:border-[#4a4a52] hover:text-[#e8e8ec] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9a227] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "正在读取缓存" : "刷新显示"}
        </button>
      </div>
      {invalid && <p role="alert" className="mt-4 text-[13px] text-[#e8d48b]">时间范围只能是今日、本周或本月。</p>}
      {result?.demo && <p role="status" className="mt-4 rounded-card border border-[#c9a227] bg-[#121216] px-4 py-3 text-[13px] font-semibold text-[#e8d48b]">测试数据，不是线上实测。</p>}
      {result && result.status !== "ready" && (
        <p role="status" className="mt-4 rounded-card border border-[#3a3a40] bg-[#121216] px-4 py-3 text-[13px] leading-relaxed text-[#c8c8d0]">{result.message ?? "数据暂不可用。"}</p>
      )}
      {result && result.items.length > 0 && (
        <ol className="mt-5 space-y-3">
          {result.items.map((item, index) => (
            <li key={item.fullName} className="rounded-card border border-[#3a3a40] px-4 py-3.5 shadow-[inset_0_1px_0_rgba(232,212,139,0.08)]" style={{ backgroundColor: "#121216", color: "#e8e8ec" }}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-[16px] font-semibold text-[#e8e8ec] underline-offset-4 hover:text-[#e8d48b] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9a227]">{item.fullName}</a>
                  {item.description && <p className="mt-1 text-[13px] leading-relaxed text-[#9a9aa4]">{item.description}</p>}
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[#9a9aa4]">
                    <span className={`rounded-full border px-2 py-0.5 ${item.category === "pending" || item.category === "unclassified" || index >= 3 ? "border-[#3a3a40] text-[#c8c8d0]" : "border-[#c9a227] text-[#e8d48b]"}`}>{item.category === "agent" ? "Agent/AI" : item.category === "devtools" ? "开发工具" : item.category === "infra" ? "基础设施" : item.category === "unclassified" ? "未分类" : "待确认"}</span>
                    {item.language && <span>{item.language}</span>}
                    <span>第 {index + 1} 名</span>
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[22px] font-semibold leading-none text-[#e8d48b]"><PeriodNumber value={item.starsPeriod} /></div>
                  <div className="mt-1 text-[11px] text-[#9a9aa4]">{PERIOD[windowSince]} · 趋势页文案</div>
                  <div className="mt-1 text-[12px] text-[#c8c8d0]">累计 {item.starsTotal == null ? "未知" : item.starsTotal.toLocaleString("en-US")}</div>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {result && result.items.length === 0 && result.status !== "disabled" && !invalid && (
        <p className="mt-8 text-center text-[15px] font-semibold text-[#e8e8ec]">
          {result.status === "ready" ? "这次没有可显示的仓库" : "还没有可显示的快照"}
          <span className="mt-1.5 block text-[13px] font-normal text-[#9a9aa4]">{result.status === "ready" ? "合法候选都在排除名单里。" : "打开采集并等到计划任务，或由管理员强制采集。刷新不会临时去抓 GitHub。"}</span>
        </p>
      )}
      <footer className="mt-8 space-y-1 border-t border-[#3a3a40] pt-4 text-[12px] leading-relaxed text-[#9a9aa4]">
        <p>数据截至（快照）{stamp(result?.fetchedAt ?? null)} · 北京时间</p>
        <p>最近尝试 {stamp(result?.attemptedAt ?? null)} · 北京时间</p>
        <p>计划不早于 {stamp(result?.nextRefreshAt ?? null)} · 北京时间。这是计划，不保证到点更新。</p>
        <p><a className="text-[#e8d48b] hover:underline" href={`https://github.com/trending?since=${windowSince}`}>来源：GitHub Trending {windowSince}</a></p>
      </footer>
    </div>
  );
}
