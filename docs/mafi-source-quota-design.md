# MAFi 来源配额设计（👍/👎 → 每来源精选配额，不影响排序）

## 原则
- 👍/👎 **永不影响任何排序**。精选、动态按发布时间（published_at）倒序，空值置后（列表本身已要求 published_at 非空且 ≥ 入库下限）；热点按热度指数排，和名次一致（2026-11-12 起，之前按最新进展时间排，名次会乱）。
- 投票只改变 **哪些条目出现 / 每个来源出现多少条**：精选中每个来源每个北京日的展示配额。

## 公式
对来源 s，汇总所有设备的有效投票（每设备每条目一票，表 `mafi_preference_reactions`）：

- 时间衰减：每票权重 w = 0.5^(age / H)，半衰期 **H = 30 天**（age = now − updated_at）。
- 反刷：单设备对单来源的衰减后 👍、👎 各自封顶 **5**（一台设备不能单独把配额推到极限）。
- U = Σ w(👍)，D = Σ w(👎)。
- 贝叶斯平滑（冷启动）：p = (U + α) / (U + D + α + β)，**α = β = 2**（先验 0.5；没有投票时 p = 0.5）。
- 乘数：m = clamp(2^(2·(p − 0.5)·2), 0.5, 2)，即 p=0→0.5x、p=0.5→1x、p=1→2x（指数对称映射，有界 **0.5x–2x**）。
- 配额：quota(s) = max(1, round(base · m))。**永不为 0**（除非显式把 base 设为 0 = 关闭配额）。
- base：环境变量 `MAFI_SELECTED_SOURCE_DAILY_QUOTA`，默认 **2**（当前预览数据每源每日最多 2 条精选）；`0` 关闭限制。

## 聚合范围：全局（跨设备）
- 精选是共享、可公共缓存（`public, max-age=60`）的列表；按设备配额会让同一 URL 内容随人而变、破坏缓存，并把“推送频率”变成个人过滤。
- 需求是“来源的推送频率”，属于编辑层面的群体信号；全局聚合 + 单设备封顶 + 衰减可兼顾代表性与抗刷。
- 个人票仍保存在原表中（myVote 回显），未来如需个人视图可在此基础上扩展。

## 存储
- 不新增表：直接从 `mafi_preference_reactions`（模块已有，含 device_id/article_id/source_id/vote/updated_at）按需计算（衰减随时间自然生效，无需定时任务）。
- 计算在 mafi-preferences 模块（`backend/quota.ts`），结果进程内缓存 60 秒；投票写入后立即失效。
- 引擎不依赖模块：`packages/backend/src/publication/timeline.ts` 暴露 `setSelectedSourceQuotaProvider()`，模块在 API 进程注册；未安装模块时所有来源乘数 = 1。

## 应用位置（精选选取管线）
- `timeline.ts` `queryGroupedAnchors`：在“已精选 + 新鲜 + 过滤条件”的基础集上，按 (source_id, 北京日) 分区、按 score DESC（同分按发布时间新者优先）取前 quota(s) 条，其余不进入精选卡片（仍在动态里可读）。
- 然后再按事实分组，卡片锚点 = 组内最早发布时间 min(published_at)，按锚点倒序。排序与投票完全无关。
- publish 管线（selected/seat/同步账本/RSS/v1）不变：配额只作用于精选展示选取，不改写数据，回滚无数据迁移。

## 排序修复（根因）
- 精选：旧锚点用 sort_at（入库时间线锚），且带设备 cookie 时 `projectTimeline` 用 `reorderGrouped` 把时间戳乘以投票/来源权重重新排序。
- 动态：带 cookie 的 relevance 视图仍用 `reorderFlat` 乘权重；前端 DayList 显示 timelineAt 而非发布时间。
- 热点：9dbac65 改成按最新进展时间排，2026-11-12 改回按热度排（投票照样不影响）。
