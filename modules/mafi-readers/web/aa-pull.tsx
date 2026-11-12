import { useState } from "react";
import { useRevalidator } from "react-router";
import { beijingTime } from "@aihot/contracts/time";
import type { AaRefreshResult, RefreshInfo } from "../contracts.ts";
import { timeLabel } from "./common.tsx";

type Note = { tone: "ok" | "warn"; text: string };

function describe(result: AaRefreshResult): Note {
  const refresh = result.refresh;
  if (result.refused?.reason === "cooldown") {
    return { tone: "warn", text: `5 分钟内只能手动拉一次${result.refused.until ? `，${beijingTime(result.refused.until)} 后再试` : ""}。` };
  }
  if (result.refused?.reason === "quota") {
    const left = refresh ? `还剩 ${refresh.remaining} 次，完整拉一次要 ${refresh.cost} 次` : "剩余次数不够";
    return { tone: "warn", text: `AA 免费额度不够完整拉一次（${left}）${result.refused.until ? `，${timeLabel(result.refused.until)} 重置后再试` : ""}。` };
  }
  if (result.status === "needs_key" || result.status === "local_only") return { tone: "warn", text: result.message ?? "AA 数据源还没连接。" };
  if (result.status !== "ready") return { tone: "warn", text: `AA 这次没有返回完整的列表，仍显示 ${timeLabel(result.fetchedAt)} 取得的数据。` };
  const names = result.added.map((model) => model.name);
  const added = result.addedCount
    ? `，新增 ${result.addedCount} 个：${names.join("、")}${result.addedCount > names.length ? " 等" : ""}`
    : "，和上次相比没有新模型";
  const removed = result.removedCount ? `，${result.removedCount} 个已不在列表里` : "";
  return { tone: "ok", text: `已从 AA 更新：共 ${result.total ?? 0} 个模型${added}${removed}。` };
}

/**
 * "从 AA 拉取最新": a complete pull right now instead of waiting for the 24-hour refresh. The server refuses
 * one within 5 minutes of the last, or when AA's free window has fewer requests left than the pull takes.
 */
export function AaPull({ refresh, fetchedAt, onAdded }: { refresh: RefreshInfo | undefined; fetchedAt: string | null; onAdded: (ids: string[]) => void }) {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  async function pull() {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/mafi-readers/aa-models/refresh", { method: "POST", headers: { "x-mafi-action": "refresh" }, credentials: "same-origin" });
      if (response.status === 403) {
        setNote({ tone: "warn", text: "只接受本站页面发起的拉取。" });
        return;
      }
      if (!response.ok && response.status !== 429) {
        setNote({ tone: "warn", text: `本站后端没有完成这次拉取（HTTP ${response.status}），稍后再试。` });
        return;
      }
      const result = (await response.json()) as AaRefreshResult;
      setNote(describe(result));
      if (!result.refused) {
        onAdded(result.added.map((model) => model.id));
        await revalidator.revalidate();
      }
    } catch {
      setNote({ tone: "warn", text: "连不上本站后端，稍后再试。" });
    } finally {
      setBusy(false);
    }
  }

  return <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-card border border-line bg-surface px-4 py-3 text-[12px] leading-[1.8] text-ink-4">
    <div className="min-w-0">
      <p>数据取得于 {timeLabel(fetchedAt)}（北京时间），每 24 小时自动更新一次。</p>
      {refresh && <p>
        AA 免费额度：剩 <span className="num font-medium text-ink-3">{refresh.remaining}</span> / {refresh.limit} 次
        {refresh.resetAt ? `，${timeLabel(refresh.resetAt)} 重置` : ""} · 完整拉一次用 {refresh.cost} 次
        {refresh.manualAfter ? ` · ${beijingTime(refresh.manualAfter)} 后可再手动拉` : ""}
      </p>}
      {note && <p role="status" className={note.tone === "ok" ? "font-medium text-ink" : "font-medium text-ink-3"}>{note.text}</p>}
    </div>
    <button
      type="button"
      onClick={() => void pull()}
      disabled={busy}
      className="shrink-0 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] font-medium text-ink hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-60"
    >
      {busy ? "正在从 AA 拉取…" : "从 AA 拉取最新"}
    </button>
  </div>;
}
