import { data, useLoaderData } from "react-router";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import type { CodexData, CodexEvent } from "../contracts.ts";
import { codexResetEnabled, githubTrendEnabled } from "../flags.ts";
import { PRIVATE_HEADERS, ReaderFooter, ReaderNav, ReaderState, SourceLink, timeLabel, useReaderRefresh } from "./common.tsx";
import { pickFeaturedCodexEvent } from "./codex-featured.ts";
import { readPage } from "./reader.server.ts";
import { pageMeta } from "@aihot/web/lib/seo";
import { AsideCard, EmptyState, ReadingLayout } from "@aihot/web/components/ui/Page";
import { Kicker } from "@aihot/web/components/ui/Kicker";

const SOURCE_URL = "https://aihot.news/codex-reset";

export const handle = { tab: "models", name: "Tibo 重置监控" };

export async function loader({ request }: { request: Request }) {
  return data({
    result: await readPage<CodexData>("/api/mafi-readers/codex-resets", SOURCE_URL, request),
    now: new Date().toISOString(),
    flags: { codexReset: codexResetEnabled(), githubTrend: githubTrendEnabled() },
  }, { headers: PRIVATE_HEADERS });
}

export function meta() {
  return pageMeta({ title: "Tibo 重置监控", description: "跟踪公开的 Codex 额度与重置卡消息。", path: "/codex-reset", noindex: true });
}

const statusText: Record<string, string> = {
  announced: "已公告，尚未确认",
  in_progress: "进行中",
  confirmed: "来源已确认",
  expired_unconfirmed: "时间窗口已过，尚未确认",
  likely_completed: "可能已完成，尚未确认",
};

function eventStatus(event: CodexEvent) {
  const status = event.presentation?.status ?? event.status;
  return statusText[status] ?? "状态待确认";
}

function eventDate(event: CodexEvent) {
  return event.occurredOn ?? beijingDate(event.createdAt);
}

function Calendar({ events, today }: { events: CodexEvent[]; today: string }) {
  const month = today.slice(0, 7);
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const leading = (first.getUTCDay() + 6) % 7;
  const byDate = new Map<string, CodexEvent[]>();
  for (const event of events) {
    const date = eventDate(event);
    if (date.startsWith(`${month}-`)) byDate.set(date, [...(byDate.get(date) ?? []), event]);
  }
  const cells = [...Array(leading).fill(null), ...Array.from({ length: dayCount }, (_, i) => i + 1)];
  return <div className="mt-3">
    <div className="mb-2 text-[13px] font-semibold text-ink">{year}年{monthNumber}月</div>
    <div className="grid grid-cols-7 gap-1 text-center">
      {["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day} className="py-1 text-[11px] text-ink-4">{day}</span>)}
      {cells.map((day, i) => {
        if (!day) return <span key={`blank-${i}`} />;
        const date = `${month}-${String(day).padStart(2, "0")}`;
        const matches = byDate.get(date) ?? [];
        const label = `${day}${matches.length ? `，已加载记录 ${matches.length} 条` : ""}`;
        return matches.length
          ? <a key={date} href={`#event-${matches[0]!.id}`} aria-label={label} title={label} className="relative grid aspect-square place-items-center rounded-control bg-accent-soft text-[12px] font-semibold text-accent hover:bg-accent-softer">{day}<span aria-hidden="true" className="absolute bottom-1 size-1 rounded-full bg-accent" /></a>
          : <span key={date} aria-label={label} className="grid aspect-square place-items-center rounded-control text-[12px] text-ink-3">{day}</span>;
      })}
    </div>
  </div>;
}

export default function CodexResetPage() {
  const { result, now, flags } = useLoaderData<typeof loader>();
  useReaderRefresh(result.status !== "paused");
  const codex = result.data;
  const today = codex?.today ?? beijingDate(now);
  const featured = pickFeaturedCodexEvent(codex?.events);
  const activities = codex?.activities.slice(0, 10) ?? [];
  const activityDays = new Set(activities.map((activity) => beijingDate(activity.publishedAt))).size;

  return <ReadingLayout aside={<>
    <AsideCard title="记录日历">
      {codex ? <>
        <Calendar events={codex.events} today={today} />
        <p className="mt-3 text-[11px] leading-[1.7] text-ink-4">日历标记“已加载记录”。接口仅提供近 7 个北京时间日及未生效记录；实际发生日未知时按公告日期归档。</p>
      </> : <p className="text-[13px] leading-[1.7] text-ink-4">数据载入后显示记录日期。</p>}
    </AsideCard>
    <AsideCard title="监控进度">
      <dl className="space-y-2 text-[12px] leading-[1.7]">
        <div><dt className="text-ink-4">检查时间</dt><dd className="mono text-ink-2">{timeLabel(codex?.checkedAt)}</dd></div>
        <div><dt className="text-ink-4">最近尝试</dt><dd className="mono text-ink-2">{timeLabel(codex?.monitor?.lastAttemptAt)}</dd></div>
        <div><dt className="text-ink-4">最近采集</dt><dd className="mono text-ink-2">{timeLabel(codex?.monitor?.lastCollectedAt)}</dd></div>
        <div><dt className="text-ink-4">最近核验</dt><dd className="mono text-ink-2">{timeLabel(codex?.monitor?.lastVerifiedAt)}</dd></div>
      </dl>
      <p className="mt-3 text-[11px] leading-[1.7] text-ink-4">打开本页每 10 分钟更新，关闭后不后台监控。AIHOT 整理，非 OpenAI 官方页面；账户状态以 Codex 内显示为准。</p>
    </AsideCard>
  </>}>
    <ReaderNav active="codex" flags={flags} />
    <header>
      <Kicker>公开消息观察</Kicker>
      <h1 data-page-title="" className="mt-2 text-[24px] font-semibold leading-[1.3] text-ink">Tibo 重置监控</h1>
      <p className="mt-2 text-[14.5px] leading-relaxed text-ink-3">跟踪公开的 Codex 额度与重置卡消息，区分原帖说明、AIHOT 估计窗口和来源确认。</p>
    </header>
    <ReaderState result={result} />
    {featured ? <section className="card mt-6 p-5 sm:p-6" id={`event-${featured.id}`}>
      <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent">{featured.displayLabel}</span><span className="text-[12px] text-ink-4">{eventStatus(featured)}</span></div>
      <h2 className="mt-3 text-[19px] font-semibold leading-snug text-ink">{featured.title}</h2>
      <p className="mt-2 text-[13px] text-ink-3">适用范围：{featured.presentation?.scopeKnown && featured.presentation.scopeLabel ? featured.presentation.scopeLabel : "原帖未明确适用范围"}</p>
      {featured.schedule && <p className="mt-2 text-[13px] leading-relaxed text-ink-2">原帖给出的时间：{featured.schedule.label}</p>}
      {featured.estimate && <p className="mt-2 text-[13px] leading-relaxed text-ink-2">AIHOT 估计窗口：{featured.estimate.label}<span className="block text-[11px] text-ink-4">{featured.estimate.reason}</span></p>}
      {featured.confirmedAt && <p className="mt-2 text-[12px] text-ink-4">来源确认帖时间：{timeLabel(featured.confirmedAt)}（不代表当前账户已到账）</p>}
      <div className="mt-4 border-t border-line pt-4">
        <div className="mb-2 text-[11px] font-semibold text-ink-4">原帖</div>
        {featured.posts[0] ? <div className="space-y-2 text-[13px] leading-[1.8] text-ink-2"><p className="whitespace-pre-wrap">{featured.posts[0].text || featured.posts[0].originalText}</p><SourceLink href={featured.posts[0].url} className="text-[12px] text-accent">查看 X 原帖</SourceLink></div> : <SourceLink href={featured.url} className="text-[12px] text-accent">查看来源记录</SourceLink>}
      </div>
    </section> : <div className="mt-6"><EmptyState title="暂无可显示的重置记录">数据源尚未提供可展示的事件。</EmptyState></div>}

    <section className="mt-8">
      <div className="mb-3 flex items-end justify-between gap-3"><div><Kicker>近期记录</Kicker><h2 className="mt-1 text-[18px] font-semibold text-ink">公开消息</h2></div><span className="text-[11px] text-ink-4">覆盖 {activityDays} 个北京时间日</span></div>
      {codex?.events.filter((event) => event.id !== featured?.id).map((event) => <article key={event.id} id={`event-${event.id}`} className="card mb-3 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-4"><time dateTime={event.createdAt}>{beijingDate(event.createdAt)} {beijingTime(event.createdAt)} · 北京时间</time><span>{eventStatus(event)}</span></div>
        <p className="mt-2 text-[13px] font-medium text-ink-2">{event.displayLabel} · {event.title}</p>
        <p className="mt-1 text-[12px] text-ink-4">适用范围：{event.presentation?.scopeKnown && event.presentation.scopeLabel ? event.presentation.scopeLabel : "原帖未明确适用范围"}</p>
        <SourceLink href={event.posts[0]?.url ?? event.url} className="mt-2 text-[11px] text-accent">查看 X 原帖</SourceLink>
      </article>)}
      {activities.length ? <ol className="space-y-3">{activities.map((activity) => <li key={activity.id} className="card px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-ink-4"><time dateTime={activity.publishedAt}>{beijingDate(activity.publishedAt)} {beijingTime(activity.publishedAt)} · 北京时间</time><span>{activity.kind === "event_update" ? "重置相关动态" : "相关公开消息"}</span></div>
        <p className="mt-2 whitespace-pre-wrap text-[13px] leading-[1.75] text-ink-2">{activity.text || activity.originalText}</p>
        <SourceLink href={activity.url} className="mt-2 text-[11px] text-accent">查看 X 原帖</SourceLink>
      </li>)}</ol> : <EmptyState title="近期没有加载到记录">接口只返回近 7 个北京时间日及未生效记录；这不代表更早时段没有消息。</EmptyState>}
      <p className="mt-3 text-[11px] leading-[1.7] text-ink-4">记录由 AIHOT 整理。近期列表覆盖接口返回范围，不代表 90 天或完整月份统计。账户是否到账，以 Codex 内显示为准。</p>
    </section>
    <ReaderFooter result={result} name="AIHOT" />
  </ReadingLayout>;
}
