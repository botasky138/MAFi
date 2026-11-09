import { useEffect, useMemo, useRef, useState } from "react";
import { data, useLoaderData } from "react-router";
import type { Screen } from "@aihot/web/components/shell/screens";
import { EmptyState } from "@aihot/web/components/ui/Page";
import { pageMeta } from "@aihot/web/lib/seo";
import type { AaData, AaModel } from "../contracts.ts";
import { PRIVATE_HEADERS, ReaderFooter, ReaderNav, ReaderState, SourceLink, useReaderRefresh } from "./common.tsx";
import { readPage } from "./reader.server.ts";
import {
  AA_LEADERBOARD_STORAGE_KEY,
  buildAaModelTree,
  filterAaModels,
  intelligenceIndex,
  modelFilterLabel,
  parseAaLeaderboardPrefs,
  reasoningFilterLabel,
  reasoningKind,
  sanitizeStoredModelIds,
  serializeAaLeaderboardPrefs,
  sortAaModels,
  topByIntelligence,
  type AaSortKey,
  type ReasoningKind,
} from "./aa-rank.ts";
import { DarkModelTreeSelect, DarkMultiSelect, DarkSingleSelect, FilterField } from "./aa-filters.tsx";

export const handle: Screen = { tab: "models", name: "AA 模型榜" };
export const headers = () => PRIVATE_HEADERS;
export const meta = () => pageMeta({ title: "AA 模型榜", description: "Artificial Analysis 官方模型评测指标与榜单入口。", path: "/leaderboard", noindex: true });

export async function loader({ request }: { request: Request }) {
  return data({ result: await readPage<AaData>("/api/mafi-readers/aa-models", "https://artificialanalysis.ai/zh", request) }, { headers: PRIVATE_HEADERS });
}

const number = (value: number | null | undefined, digits = 1) => value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits });

const SORT_OPTIONS: { value: AaSortKey; label: string }[] = [
  { value: "intelligence", label: "智能指数" },
  { value: "speed", label: "输出速度" },
  { value: "latency", label: "延迟 TTFT" },
  { value: "input_price", label: "输入价格" },
  { value: "output_price", label: "输出价格" },
  { value: "name", label: "模型名" },
  { value: "source", label: "AA 返回顺序" },
];

const REASONING_OPTIONS: { value: ReasoningKind; label: string }[] = [
  { value: "reasoning", label: "推理 (Reasoning)" },
  { value: "non_reasoning", label: "非推理 (Non-reasoning)" },
  { value: "unmarked", label: "名称未标注" },
];

const TOP_N_OPTIONS = [
  { value: 10, label: "前 10 名" },
  { value: 15, label: "前 15 名" },
  { value: 20, label: "前 20 名" },
  { value: 30, label: "前 30 名" },
] as const;

function IntelligenceChart({ models }: { models: ReturnType<typeof topByIntelligence> }) {
  const max = models[0]?.score ?? 1;
  if (!models.length) {
    return <EmptyState title="当前筛选下没有可画图的智能指数">换一组模型或类型，或清空筛选后再试。</EmptyState>;
  }
  return (
    <ol className="space-y-3" aria-label="按 AA 智能指数排名的条形图">
      {models.map((row) => {
        const width = Math.max(2, Math.round((row.score / max) * 100));
        return (
          <li key={row.model.id} className="grid grid-cols-[2rem_minmax(0,1fr)_3.25rem] items-center gap-2 text-[12px]">
            <span className="num text-right text-ink-4" aria-hidden="true">{row.rank}</span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="truncate font-medium text-ink" title={`${row.model.name} · ${row.model.model_creator.name}`}>{row.model.name}</span>
                <span className="shrink-0 text-ink-4">{row.model.model_creator.name}</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-line" role="presentation">
                <div className="h-full rounded-full bg-accent" style={{ width: `${width}%` }} />
              </div>
            </div>
            <span className="num text-right font-semibold text-ink">{number(row.score)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function metricCells(model: AaModel) {
  return {
    intelligence: intelligenceIndex(model),
    speed: model.performance.median_output_tokens_per_second,
    latency: model.performance.median_time_to_first_token_seconds,
    input: model.pricing.price_1m_input_tokens,
    output: model.pricing.price_1m_output_tokens,
  };
}

function readStoredPrefs() {
  if (typeof window === "undefined") return null;
  try {
    return parseAaLeaderboardPrefs(window.localStorage.getItem(AA_LEADERBOARD_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredPrefs(prefs: Parameters<typeof serializeAaLeaderboardPrefs>[0]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AA_LEADERBOARD_STORAGE_KEY, serializeAaLeaderboardPrefs(prefs));
  } catch {
    /* quota / private mode */
  }
}

export default function AaModels() {
  const { result } = useLoaderData<typeof loader>();
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [reasoningKinds, setReasoningKinds] = useState<ReasoningKind[]>([]);
  const [sort, setSort] = useState<AaSortKey>("intelligence");
  const [topN, setTopN] = useState<(typeof TOP_N_OPTIONS)[number]["value"]>(15);
  const [prefsReady, setPrefsReady] = useState(false);
  const skipNextPersist = useRef(true);
  useReaderRefresh();

  const allModels = result.data?.models ?? [];
  const allModelIds = useMemo(() => allModels.map((model) => model.id), [allModels]);
  const modelTree = useMemo(() => buildAaModelTree(allModels), [allModels]);

  useEffect(() => {
    const stored = readStoredPrefs();
    if (stored) {
      setModelIds(sanitizeStoredModelIds(stored.modelIds, allModelIds.length ? allModelIds : stored.modelIds));
      setReasoningKinds(stored.reasoningKinds);
      setSort(stored.sort);
      setTopN(stored.topN as (typeof TOP_N_OPTIONS)[number]["value"]);
    }
    setPrefsReady(true);
    // Restore once on mount; snapshot ids may arrive in the same paint via loader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!prefsReady || !allModelIds.length) return;
    setModelIds((prev) => sanitizeStoredModelIds(prev, allModelIds));
  }, [prefsReady, allModelIds]);

  useEffect(() => {
    if (!prefsReady) return;
    if (skipNextPersist.current) {
      skipNextPersist.current = false;
      return;
    }
    writeStoredPrefs({ modelIds, reasoningKinds, sort, topN });
  }, [prefsReady, modelIds, reasoningKinds, sort, topN]);

  const savePrefs = () => {
    writeStoredPrefs({ modelIds, reasoningKinds, sort, topN });
  };

  const filtered = useMemo(
    () => filterAaModels(allModels, { modelIds, reasoningKinds }),
    [allModels, modelIds, reasoningKinds],
  );
  const ranked = useMemo(() => sortAaModels(filtered, sort), [filtered, sort]);
  const chartRows = useMemo(() => topByIntelligence(filtered, topN), [filtered, topN]);

  return <div className="pb-8 pt-4 lg:pt-0">
    <ReaderNav active="aa" />
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">AA 模型榜</h1>
        <p className="mt-2 text-[13px] leading-[1.8] text-ink-4">Artificial Analysis 官方评测指标 · 个人本机查看</p>
      </div>
      <SourceLink href="https://artificialanalysis.ai/zh" className="text-[13px] font-medium text-accent">打开 AA 官方榜单</SourceLink>
    </div>
    <ReaderState result={result} />
    {result.data ? <>
      <div className="mb-4 flex flex-col gap-3 rounded-card border border-line bg-surface px-4 py-3 text-[12px] text-ink-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>AA 智能指数 v{result.data.intelligence_index_version} · 已取得 {result.data.models.length} 个模型 · 当前筛选 {filtered.length} 个</span>
          <span className="text-ink-4">免费 API 快照不含开放权重 / 模态字段；推理类型由模型名标注推断。未勾选模型时显示全部。</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FilterField label="模型">
            <DarkModelTreeSelect
              label="按模型筛选"
              summary={modelFilterLabel(modelIds, allModels.length)}
              tree={modelTree}
              selected={modelIds}
              onChange={setModelIds}
              onSave={savePrefs}
              searchPlaceholder="Search..."
            />
          </FilterField>
          <FilterField label="模型类型">
            <DarkMultiSelect
              label="按推理类型筛选"
              summary={reasoningFilterLabel(reasoningKinds)}
              options={REASONING_OPTIONS}
              selected={reasoningKinds}
              onChange={(next) => setReasoningKinds(next as ReasoningKind[])}
              searchable={false}
            />
          </FilterField>
          <FilterField label="表格排序">
            <DarkSingleSelect label="表格排序指标" value={sort} options={SORT_OPTIONS} onChange={setSort} />
          </FilterField>
          <FilterField label="图表 Top N">
            <DarkSingleSelect
              label="图表显示前 N 名"
              value={topN}
              options={TOP_N_OPTIONS}
              onChange={setTopN}
            />
          </FilterField>
        </div>
      </div>

      <section className="mb-6 max-w-full overflow-hidden rounded-card border border-line p-4" aria-labelledby="aa-chart-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="aa-chart-heading" className="text-[15px] font-semibold text-ink">智能指数 Top {topN}</h2>
          <p className="text-[12px] text-ink-4">按 AA Intelligence Index 排序 · 随上方筛选变化</p>
        </div>
        <IntelligenceChart models={chartRows} />
      </section>

      <div className="max-w-full overflow-x-auto rounded-card border border-line">
        <table className="w-full min-w-[760px] text-left text-[13px]">
          <caption className="sr-only">Artificial Analysis 官方数据；默认按智能指数排序，可改筛选与排序。价格单位为美元每百万 token；延迟为中位首 token 秒数。</caption>
          <thead className="border-b border-line text-[12px] text-ink-4"><tr>
            <th scope="col" className="px-4 py-3 text-right font-medium">#</th>
            <th scope="col" className="px-4 py-3 font-medium">模型 / 机构</th>
            <th scope="col" className="px-4 py-3 font-medium">类型</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">智能指数</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">输出 token/秒</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">延迟 TTFT</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">输入 $/百万</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">输出 $/百万</th>
          </tr></thead>
          <tbody>{ranked.map((model, index) => {
            const cells = metricCells(model);
            const kind = reasoningKind(model.name);
            const kindLabel = kind === "reasoning" ? "推理" : kind === "non_reasoning" ? "非推理" : "—";
            return <tr key={model.id} className="border-b border-line-soft last:border-0">
              <td className="num px-4 py-4 text-right text-ink-4">{index + 1}</td>
              <th scope="row" className="px-4 py-4 font-medium text-ink"><span>{model.name}</span><span className="mt-1 block text-[12px] font-normal text-ink-4">{model.model_creator.name}</span></th>
              <td className="px-4 py-4 text-ink-3">{kindLabel}</td>
              <td className="num px-4 py-4 text-right font-semibold text-ink">{number(cells.intelligence)}</td>
              <td className="num px-4 py-4 text-right text-ink-3">{number(cells.speed)}</td>
              <td className="num px-4 py-4 text-right text-ink-3">{number(cells.latency, 2)}</td>
              <td className="num px-4 py-4 text-right text-ink-3">{number(cells.input, 3)}</td>
              <td className="num px-4 py-4 text-right text-ink-3">{number(cells.output, 3)}</td>
            </tr>;
          })}</tbody>
        </table>
        {!ranked.length && <EmptyState title="没有匹配的模型">试试在模型树里勾选更多项，或将类型设为全部。</EmptyState>}
      </div>
      <p className="mt-4 text-[12px] leading-[1.8] text-ink-4">指标来自 Artificial Analysis；图表与默认排序使用官方 Intelligence Index，完整名次以官网为准。“—”表示未提供、未测量或名称未标注推理类型。本页复用本机 AA 快照，不额外消耗付费配额。开放权重 / 模态等字段不在免费 API 快照中。</p>
    </> : <div className="card">
      <EmptyState title={result.status === "needs_key" ? "尚未连接 AA 数据源" : "暂时没有可展示的 AA 数据"} action={<SourceLink href="https://artificialanalysis.ai/data-api" className="text-[13px] font-medium text-accent">申请 AA 免费 API key</SourceLink>}>
        连接后显示 AA 官方智能指数、速度与价格。现在可以直接打开官网查看完整榜单。
      </EmptyState>
    </div>}
    <ReaderFooter result={result} name="Artificial Analysis" />
    <p className="mt-2 text-[12px] text-ink-4">Source: <SourceLink href="https://artificialanalysis.ai/">Artificial Analysis</SourceLink></p>
  </div>;
}
