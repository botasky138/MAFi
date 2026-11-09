import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { data, Link, useLoaderData, useRevalidator } from "react-router";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";
import { readJson, writeRaw } from "@aihot/web/lib/local-state";
import { reducedMotion } from "@aihot/web/lib/motion";
import { pageMeta } from "@aihot/web/lib/seo";
import {
  BADGE_LABELS, CATEGORY_LABELS, TREND_CATEGORIES, isTrendSince,
  type TrendBadge, type TrendCategory, type TrendItem, type TrendSince,
} from "../trend-contract.ts";
import { PRIVATE_HEADERS, ReaderNav, useReaderRefresh } from "./common.tsx";
import { readTrend } from "./reader.server.ts";

export const handle: Screen = { tab: "models", name: "GitHub 趋势" };
export const headers = () => PRIVATE_HEADERS;
export const meta = () => pageMeta({
  title: "GitHub 趋势",
  description: "GitHub Trending 今日、本周、本月上榜仓库，按期间新增星数排列，附中文用途、分类和实时星数。",
  path: "/github-trending",
  noindex: true,
});

const WINDOWS: Record<TrendSince, { tab: string; gained: string }> = {
  daily: { tab: "今日", gained: "今日新增" },
  weekly: { tab: "本周", gained: "本周新增" },
  monthly: { tab: "本月", gained: "本月新增" },
};

export async function loader({ request }: { request: Request }) {
  const since = new URL(request.url).searchParams.get("since") ?? "daily";
  if (!isTrendSince(since)) return data({ result: null, since: "daily" as const, invalid: true }, { status: 400, headers: PRIVATE_HEADERS });
  return data({ result: await readTrend(since, request), since, invalid: false }, { headers: PRIVATE_HEADERS });
}

// Palette of this page (near black, cool grey metal, champagne gold), kept apart from the site's theme.
const C = { bg: "#0a0a0c", panel: "#121216", line: "#3a3a40", text: "#e8e8ec", soft: "#c8c8d0", muted: "#9a9aa4", gold: "#c9a227", pale: "#e8d48b" };

const MOTION_CSS = `
@keyframes mafi-gh-rise { 0% { transform: translateY(4px); opacity: 0 } 15% { opacity: 1 } 70% { opacity: 1 } 100% { transform: translateY(-26px); opacity: 0 } }
@keyframes mafi-gh-spark { 0% { transform: translate(0, 0) scale(.5); opacity: 0 } 20% { opacity: 1 } 100% { transform: translate(var(--dx), var(--dy)) scale(1); opacity: 0 } }
@keyframes mafi-gh-glint { 0%, 100% { color: ${C.pale} } 35% { color: #fff4c8 } }
@keyframes mafi-gh-pulse { 0%, 100% { opacity: .35 } 50% { opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .mafi-gh-anim { animation: none !important } }
`;

/** Stars this browser saw last time, per repo: the "+N ★" is the real difference, not an animation for show. */
const SEEN_KEY = "mafi-gh-seen-v1";
const SEEN_MAX = 400;

type Seen = Record<string, [number, number]>;

function readSeen(): Seen {
  const raw = readJson(SEEN_KEY);
  if (!raw || typeof raw !== "object") return {};
  const out: Seen = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value) && Number.isSafeInteger(value[0]) && Number.isFinite(value[1])) out[key] = [value[0], value[1]];
  }
  return out;
}

function writeSeen(seen: Seen) {
  const kept = Object.entries(seen).sort((a, b) => b[1][1] - a[1][1]).slice(0, SEEN_MAX);
  writeRaw(SEEN_KEY, JSON.stringify(Object.fromEntries(kept)));
}

interface Gain { from: number; gain: number; stamp: number }

/** Compares each total with what this browser saw before (last visit or the previous refresh) and remembers the new one. */
function useStarGains(items: readonly TrendItem[]): Record<string, Gain> {
  const [gains, setGains] = useState<Record<string, Gain>>({});
  useEffect(() => {
    const seen = readSeen();
    const now = Date.now();
    const next: Record<string, Gain> = {};
    for (const item of items) {
      if (item.starsTotal == null) continue;
      const key = item.fullName.toLowerCase();
      const before = seen[key]?.[0];
      if (before != null && item.starsTotal > before) next[key] = { from: before, gain: item.starsTotal - before, stamp: now };
      seen[key] = [item.starsTotal, now];
    }
    writeSeen(seen);
    setGains(next);
  }, [items]);
  return gains;
}

const fmt = (value: number) => value.toLocaleString("en-US");

function RollingNumber({ from, to, className = "" }: { from: number | null; to: number; className?: string }) {
  const [shown, setShown] = useState(to);
  useEffect(() => {
    if (from == null || from === to || reducedMotion()) {
      setShown(to);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 1100);
      setShown(Math.round(from + (to - from) * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [from, to]);
  return <span className={`tabular-nums ${className}`}>{fmt(shown)}</span>;
}

const SPARKS = [[-18, -14], [16, -18], [-8, -24], [22, -6], [-22, -2]];

/** "+N ★" rising off the number, with a few small sparks; under reduced motion the gain is plain text beside it. */
function StarBurst({ gain, place }: { gain: Gain; place: "left" | "up" }) {
  return (
    <span key={gain.stamp} aria-hidden="true" className={`pointer-events-none absolute select-none ${place === "up" ? "bottom-full right-0 mb-1" : "right-full top-0 mr-2"}`}>
      <span className="mafi-gh-anim absolute right-0 top-0 whitespace-nowrap text-[12px] font-semibold" style={{ color: C.pale, animation: "mafi-gh-rise 1.8s ease-out forwards" }}>+{fmt(gain.gain)} ★</span>
      {SPARKS.slice(0, Math.min(SPARKS.length, 2 + Math.floor(Math.log10(gain.gain + 1)) * 2)).map(([dx, dy], i) => (
        <span
          key={i}
          className="mafi-gh-anim absolute right-2 top-1 text-[9px]"
          style={{ color: C.gold, opacity: 0, "--dx": `${dx}px`, "--dy": `${dy}px`, animation: `mafi-gh-spark 1.2s ${0.1 + i * 0.08}s ease-out forwards` } as CSSProperties}
        >✦</span>
      ))}
    </span>
  );
}

function Spark({ values, width = 76, height = 20 }: { values: readonly number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const points = values.map((v, i) => [(i / (values.length - 1)) * (width - 3) + 1.5, height - 2 - ((v - min) / span) * (height - 4)] as const);
  const last = points.at(-1)!;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label={`近 24 小时累计星数 ${fmt(values[0]!)} → ${fmt(values.at(-1)!)}`} role="img">
      <polyline points={points.map((p) => p.join(",")).join(" ")} fill="none" stroke={C.gold} strokeOpacity="0.75" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="2" fill={C.pale} />
    </svg>
  );
}

function Chip({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "gold" | "solid" }) {
  const style = tone === "solid"
    ? { backgroundColor: C.gold, borderColor: C.gold, color: C.bg }
    : tone === "gold" ? { borderColor: "rgba(201,162,39,.6)", color: C.pale } : { borderColor: C.line, color: C.soft };
  return <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11.5px] leading-[1.4]" style={style}>{children}</span>;
}

const BADGE_TONE: Record<TrendBadge, "plain" | "gold" | "solid"> = { new: "gold", surge: "solid", resident: "plain", triple: "gold" };
const BADGE_TITLE: Record<TrendBadge, string> = {
  new: "创建不到 30 天",
  surge: "这一期新增占累计星数的三分之一以上",
  resident: "连续 3 天以上在日榜，不占精选位",
  triple: "同时在今日、本周、本月榜",
};

function Badges({ badges }: { badges: readonly TrendBadge[] }) {
  return <>{badges.map((badge) => <span key={badge} title={BADGE_TITLE[badge]}><Chip tone={BADGE_TONE[badge]}>{BADGE_LABELS[badge]}</Chip></span>)}</>;
}

function Categories({ item, gold }: { item: TrendItem; gold?: boolean }) {
  return <>
    <Chip tone={gold ? "gold" : "plain"}>{CATEGORY_LABELS[item.category]}</Chip>
    {item.secondary && <Chip>{CATEGORY_LABELS[item.secondary]}</Chip>}
    {item.language && <span className="text-[12px]" style={{ color: C.muted }}>{item.language}</span>}
  </>;
}

/** The total, rolling up from what this browser saw last; the "+N ★" rises above it (cards) or beside it (rows). */
function Total({ item, gain, burst = "left" }: { item: TrendItem; gain?: Gain; burst?: "left" | "up" }) {
  if (item.starsTotal == null) return <span style={{ color: C.muted }}>累计 未知</span>;
  return (
    <span className="relative inline-flex items-baseline gap-1">
      <span style={{ color: C.muted }}>累计</span>
      <RollingNumber from={gain?.from ?? null} to={item.starsTotal} className={gain ? "mafi-gh-anim" : ""} />
      {gain && <span className="text-[11px]" style={{ color: C.pale }}>（较上次 +{fmt(gain.gain)}）</span>}
      {gain && !reducedMotion() && <StarBurst gain={gain} place={burst} />}
    </span>
  );
}

function FeaturedCard({ item, rank, since, gain }: { item: TrendItem; rank: number; since: TrendSince; gain?: Gain }) {
  return (
    <li
      className="flex min-w-0 flex-col rounded-card border px-4 pb-4 pt-3.5"
      style={{ borderColor: "rgba(201,162,39,.45)", background: "linear-gradient(180deg,#17171c 0%,#111114 100%)", boxShadow: "inset 0 1px 0 rgba(232,212,139,.12)" }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[12px] font-semibold tracking-[0.08em]" style={{ color: C.gold }}>No.{rank}</span>
        <Badges badges={item.badges} />
      </div>
      <a href={item.url} target="_blank" rel="noopener noreferrer" className="mt-2 break-words text-[17px] font-semibold leading-snug hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ color: C.text, outlineColor: C.gold }}>
        {item.fullName}
      </a>
      {item.purpose
        ? <p className="mt-1.5 text-[14px] leading-relaxed" style={{ color: C.text }}>{item.purpose}</p>
        : item.description && <p className="mt-1.5 line-clamp-3 text-[13.5px] leading-relaxed" style={{ color: C.soft }}>{item.description}</p>}
      {item.purpose && item.description && <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed" style={{ color: C.muted }}>{item.description}</p>}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5"><Categories item={item} gold /></div>
      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        <div>
          <div className="text-[28px] font-semibold leading-none tabular-nums" style={{ color: C.pale }}>{fmt(item.starsPeriod)}</div>
          <div className="mt-1 text-[11.5px]" style={{ color: C.muted }}>{WINDOWS[since].gained}{item.starsHour != null && item.starsHour > 0 ? ` · 近 1 小时 +${fmt(item.starsHour)}` : ""}</div>
        </div>
        <div className="text-right text-[12px]" style={{ color: C.soft }}>
          <Spark values={item.spark} />
          <div className="mt-1"><Total item={item} gain={gain} burst="up" /></div>
        </div>
      </div>
    </li>
  );
}

/** Phone: the numbers sit in a line under the repo. Wider screens: a column on the right. */
function Row({ item, rank, since, gain }: { item: TrendItem; rank: number; since: TrendSince; gain?: Gain }) {
  return (
    <li className="rounded-card border px-3.5 py-3 sm:flex sm:gap-4 sm:px-4" style={{ borderColor: C.line, backgroundColor: C.panel, boxShadow: "inset 0 1px 0 rgba(232,212,139,.05)" }}>
      <div className="flex min-w-0 flex-1 gap-3">
      <span className="w-6 shrink-0 pt-0.5 text-right text-[13px] tabular-nums" style={{ color: C.muted }}>{rank}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <a href={item.url} target="_blank" rel="noopener noreferrer" className="break-all text-[15px] font-semibold hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ color: C.text, outlineColor: C.gold }}>{item.fullName}</a>
          <Badges badges={item.badges} />
        </div>
        {(item.purpose || item.description) && <p className={`mt-1 text-[13.5px] leading-relaxed ${item.purpose ? "" : "line-clamp-2"}`} style={{ color: item.purpose ? C.soft : C.muted }}>{item.purpose ?? item.description}</p>}
        {item.purpose && item.description && <p className="mt-0.5 line-clamp-1 text-[12px]" style={{ color: C.muted }}>{item.description}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5"><Categories item={item} /></div>
      </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t pl-9 pt-2 sm:mt-0 sm:shrink-0 sm:flex-col sm:flex-nowrap sm:items-end sm:justify-start sm:gap-1 sm:border-0 sm:pl-0 sm:pt-0 sm:text-right" style={{ borderColor: C.line }}>
        <div className="flex items-baseline gap-1.5 sm:flex-col sm:items-end sm:gap-1">
          <span className="text-[19px] font-semibold leading-none tabular-nums sm:text-[21px]" style={{ color: C.pale }}>{fmt(item.starsPeriod)}</span>
          <span className="text-[11px]" style={{ color: C.muted }}>{WINDOWS[since].gained}{item.starsHour != null && item.starsHour > 0 ? ` · 近 1 小时 +${fmt(item.starsHour)}` : ""}</span>
        </div>
        <div className="hidden sm:block"><Spark values={item.spark} width={64} height={16} /></div>
        <div className="whitespace-nowrap text-[11.5px]" style={{ color: C.soft }}><Total item={item} gain={gain} /></div>
      </div>
    </li>
  );
}

function stamp(value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? `${beijingDate(value)} ${beijingTime(value)}` : "暂无";
}

/** "3 分钟前", worked out in the browser after it loads so the server's render never disagrees with it. */
function useAgo(value: string | null): string | null {
  const [ago, setAgo] = useState<string | null>(null);
  useEffect(() => {
    if (!value) return setAgo(null);
    const update = () => {
      const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
      setAgo(minutes < 1 ? "刚刚" : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`);
    };
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, [value]);
  return ago;
}

export default function GithubTrendPage() {
  const { result, since, invalid } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  useReaderRefresh(Boolean(result && result.status !== "disabled"), 60_000);
  const [category, setCategory] = useState<TrendCategory | "all">("all");
  const [language, setLanguage] = useState<string>("all");
  const items = useMemo(() => result?.items ?? [], [result]);
  const gains = useStarGains(items);
  const starsAgo = useAgo(result?.starsAt ?? null);
  const busy = revalidator.state !== "idle";
  const rank = useMemo(() => new Map(items.map((item, i) => [item.fullName, i + 1])), [items]);
  const counts = useMemo(() => {
    const out = new Map<TrendCategory, number>();
    for (const item of items) out.set(item.category, (out.get(item.category) ?? 0) + 1);
    return out;
  }, [items]);
  const languages = useMemo(() => [...new Set(items.map((item) => item.language).filter((l): l is string => Boolean(l)))].sort(), [items]);
  const filtering = category !== "all" || language !== "all";
  const shown = items.filter((item) => (category === "all" || item.category === category || item.secondary === category) && (language === "all" || item.language === language));
  const featured = filtering ? [] : (result?.featured ?? []).map((name) => items.find((item) => item.fullName === name)).filter((item): item is TrendItem => Boolean(item));
  const rest = filtering ? shown : shown.filter((item) => !result?.featured.includes(item.fullName));
  // Reset the filters when the window changes: another list may not have that category or language.
  const lastSince = useRef(since);
  useEffect(() => {
    if (lastSince.current === since) return;
    lastSince.current = since;
    setCategory("all");
    setLanguage("all");
  }, [since]);

  return (<>
    <style>{MOTION_CSS}</style>
    <PhoneBar back={{ to: "/leaderboard", label: "AA 模型榜" }} title="GitHub 趋势" />
    <div className="mt-2 rounded-card px-4 pb-8 pt-5 sm:px-5 lg:mt-0 lg:px-6 lg:pt-6" style={{ backgroundColor: C.bg, color: C.text }}>
      <ReaderNav active="github" tone="inverse" />
      <header className="max-w-[68ch]">
        <h1 data-page-title="" className="text-[26px] font-semibold leading-tight tracking-[-0.02em]">GitHub 趋势</h1>
        <p className="mt-2 text-[14px] leading-relaxed" style={{ color: C.muted }}>
          GitHub Trending 上榜仓库，按这一期新增星数排序；累计星数每 5 分钟更新，“较上次”是比你上次打开时多的星。
        </p>
      </header>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="时间范围" className="flex rounded-full border p-1" style={{ borderColor: C.line, backgroundColor: C.panel }}>
          {(["daily", "weekly", "monthly"] as const).map((key) => (
            <Link
              key={key}
              to={key === "daily" ? "/github-trending" : `/github-trending?since=${key}`}
              aria-current={since === key ? "page" : undefined}
              className="rounded-full px-3.5 py-1.5 text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              style={since === key ? { backgroundColor: C.gold, color: C.bg, fontWeight: 600, outlineColor: C.gold } : { color: C.muted, outlineColor: C.gold }}
            >
              {WINDOWS[key].tab}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3 text-[12.5px]" style={{ color: C.muted }}>
          {result?.live
            ? <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="mafi-gh-anim inline-block size-1.5 rounded-full" style={{ backgroundColor: C.pale, animation: "mafi-gh-pulse 2.4s ease-in-out infinite" }} />星数实时{starsAgo ? ` · ${starsAgo}` : ""}</span>
            : result && result.status !== "disabled" && <span>{result.starsAt ? `星数停在 ${stamp(result.starsAt)}` : "累计星数取自榜单页"}</span>}
          <button
            type="button"
            onClick={() => revalidator.revalidate()}
            disabled={busy || invalid}
            className="rounded-full border px-3 py-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: C.line, backgroundColor: C.panel, color: C.soft, outlineColor: C.gold }}
          >
            {busy ? "刷新中" : "刷新"}
          </button>
        </div>
      </div>

      {items.length > 0 && (
        <div className="-mx-4 mt-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0" role="group" aria-label="按类别和语言筛选">
          {(["all", ...TREND_CATEGORIES.filter((c) => counts.has(c))] as const).map((key) => {
            const on = category === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                onClick={() => setCategory(key)}
                className="shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[12.5px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={on ? { borderColor: C.gold, color: C.pale, backgroundColor: "rgba(201,162,39,.1)", outlineColor: C.gold } : { borderColor: C.line, color: C.muted, outlineColor: C.gold }}
              >
                {key === "all" ? `全部 ${items.length}` : `${CATEGORY_LABELS[key]} ${counts.get(key)}`}
              </button>
            );
          })}
          {languages.length > 1 && (
            <select
              aria-label="语言"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              className="shrink-0 rounded-full border px-2.5 py-1 text-[12.5px]"
              style={{ borderColor: C.line, backgroundColor: C.panel, color: C.soft }}
            >
              <option value="all">全部语言</option>
              {languages.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          )}
        </div>
      )}

      {invalid && <p role="alert" className="mt-4 text-[13px]" style={{ color: C.pale }}>时间范围只能是今日、本周或本月。</p>}
      {result?.demo && <p role="status" className="mt-4 rounded-card border px-4 py-3 text-[13px] font-semibold" style={{ borderColor: C.gold, color: C.pale }}>测试数据，不是线上实测。</p>}
      {result && result.message && result.status !== "disabled" && (
        <p role="status" className="mt-4 rounded-card border px-4 py-3 text-[13px] leading-relaxed" style={{ borderColor: C.line, backgroundColor: C.panel, color: C.soft }}>{result.message}</p>
      )}
      {result?.status === "disabled" && (
        <p className="mt-8 text-center text-[15px] font-semibold">
          GitHub 趋势还没打开
          <span className="mt-1.5 block text-[13px] font-normal" style={{ color: C.muted }}>站长在 .env 里把 MAFI_GITHUB_TREND_ENABLED 设为 true 并重启后，这里才会有数据。</span>
        </p>
      )}

      {featured.length > 0 && (
        <section aria-labelledby="gh-featured" className="mt-6">
          <h2 id="gh-featured" className="mb-3 text-[12px] font-semibold tracking-[0.18em]" style={{ color: C.gold }}>精选</h2>
          <ol className="grid gap-3 lg:grid-cols-3">
            {featured.map((item) => <FeaturedCard key={item.fullName} item={item} rank={rank.get(item.fullName)!} since={since} gain={gains[item.fullName.toLowerCase()]} />)}
          </ol>
        </section>
      )}

      {rest.length > 0 && (
        <section aria-labelledby="gh-list" className="mt-7">
          <h2 id="gh-list" className="mb-3 text-[12px] font-semibold tracking-[0.18em]" style={{ color: C.muted }}>{filtering ? `筛选结果 ${rest.length}` : "榜单"}</h2>
          <ol className="space-y-2.5">
            {rest.map((item) => <Row key={item.fullName} item={item} rank={rank.get(item.fullName)!} since={since} gain={gains[item.fullName.toLowerCase()]} />)}
          </ol>
        </section>
      )}

      {result && result.status !== "disabled" && !invalid && items.length === 0 && (
        <p className="mt-8 text-center text-[15px] font-semibold">
          {result.status === "ready" ? "这一期没有可显示的仓库" : "还没有可显示的榜单"}
          <span className="mt-1.5 block text-[13px] font-normal" style={{ color: C.muted }}>{result.status === "ready" ? "上榜的仓库都在排除名单里。" : "后台每 5 分钟检查一次，第一次采集完成后这里就会出现。"}</span>
        </p>
      )}
      {filtering && shown.length === 0 && items.length > 0 && <p className="mt-8 text-center text-[13px]" style={{ color: C.muted }}>没有符合筛选的仓库。</p>}

      <footer className="mt-10 space-y-1 border-t pt-4 text-[12px] leading-relaxed" style={{ borderColor: C.line, color: C.muted }}>
        <p>榜单采集于 {stamp(result?.fetchedAt ?? null)}，累计星数读取于 {stamp(result?.starsAt ?? null)}（北京时间）。</p>
        <p>排序和期间新增星数来自 GitHub Trending，累计星数来自 GitHub API；中文用途和类别由模型根据仓库描述写成，可能不准。</p>
        <p><a className="hover:underline" style={{ color: C.pale }} href={`https://github.com/trending?since=${since}`} target="_blank" rel="noopener noreferrer">打开 GitHub Trending（{WINDOWS[since].tab}）</a></p>
      </footer>
    </div>
  </>);
}
