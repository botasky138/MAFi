# MAFi：Tibo 与 AA 外部数据

2026-10-22（Asia/Tokyo）。本人本机使用，继续沿用开源框架的精选、动态、热点、日报、主题与原有界面。外部模块目前只保留 Tibo Codex 公开消息和 Artificial Analysis 官方模型数据。

## 页面与费用

| 内容 | 查看方式 | 是否调用自己的模型 |
|---|---|---|
| Tibo Codex 重置与发卡 | /codex-reset，读取作者核验的近期记录 | 否 |
| AA 模型指标 | /leaderboard，读取 AA 官方免费接口 | 否；需要独立 AA key |
| 医药、AI、金融资讯 | MAFi 原有精选、动态与日报等页面 | 自动分析和写作仍按本站模型配置执行 |

AIHOT 资讯阅读页、相关 API、全局入口和接入说明已移除；不再同步六种资讯视图。Tibo 仍使用 AIHOT 整理的 Codex 数据，保留相应来源与原帖标注。本站常态采集、模型处理和推送仍关闭；此次外部数据读取不消耗 DeepSeek/MiniMax。

## AA 配置

AA key 只保存在被 Git 忽略的本机 .env 中，变量为 AA_API_KEY。示例 .env.example 保持空值；不要把密钥放进示例文件、聊天、Git 或浏览器代码。直接运行 Node 时须让 API 读取 .env；Docker API 使用 env_file，Web 不接收该密钥。专用本机预览仅将 AA key 交给后端，其他真实模型和采集密钥不装载。

新版官方接口为 GET https://artificialanalysis.ai/api/v2/language/models/free?page=1，服务端通过 x-api-key 认证。免费配额为首次请求起固定 24 小时窗口 100 次，同一 scope 与其他客户端共享，每页一次。本地至少间隔 24 小时刷新一轮、最多 12 页；分页不完整、版本变化或重复模型不覆盖成功快照。旧接口的 1,000 次/日不适用于新版。

页面显示官方智能指数、机构、速度和输入/输出价格，保留 API 顺序，不计算 MAFi 综合分或添加名次；完整排名以 [AA 官网](https://artificialanalysis.ai/zh)为准。未测量或未提供的指标显示“—”。没有 key 或上游失败时明确显示状态，不写示例分数。

## Tibo 暂停与 GitHub 趋势

`MAFI_CODEX_RESET_ENABLED` 只有小写 `true` 才恢复 Tibo 上游请求。缺省是暂停：路由和代码还在，不打上游，也不改写缓存，入口隐藏。AA 不受这个开关影响。恢复或再次暂停都要重启 API 和 Web。

`/github-trending` 在「AA 模型榜」下面，只是沿用「模型」这一段的位置，不是模型榜。数据和规则：

- **排序**：GitHub Trending 页上写的期间新增星数（今日 / 本周 / 本月），不是全站星增量榜。今日 30 分钟、本周 2 小时、本月 6 小时抓一次。
- **累计星数**：worker 每 5 分钟从 `api.github.com/repos/{owner}/{repo}` 读上榜仓库的实时数（有 `GITHUB_TOKEN` 时全部，没有时每小时约 40 次），保留 26 小时，用来算「近 1 小时 +N」和 24 小时迷你曲线。
- **较上次 +N**：浏览器记住每个仓库上次看到的累计星数（localStorage `mafi-gh-seen-v1`），刷新后有新增的会从旧值滚到新值，并飘出「+N ★」。只用真实差值；系统开了减少动态效果时只显示文字。
- **中文用途和类别**：模型步骤 `githubPurpose` 在 worker 里写，一句中文用途加主类 / 次类（AI Agent、LLM 应用/模型、开发工具、基础设施/运维、数据/数据库、前端/设计、安全、教程/清单、其他）。模型还没写到或模型调用关着时，用 topics、仓库名和描述的规则分类，并显示英文描述。
- **精选**：每个榜按期间星数取前三，跳过「常驻」。徽章：新星（创建不到 30 天）、爆发（这一期新增占累计三分之一以上）、常驻（连续 3 天以上在日榜）、三榜（同时在今日、本周、本月榜）。
- **排除名单**：`trend-config.ts`，现在为空。

`GET` 只读 `{dataDir}/mafi-readers/` 下的 `github-trending.json` 和 `github-repos.json`；采集只在 `MAFI_GITHUB_TREND_ENABLED=true` 的 worker 里跑。管理员强制采集（`POST /api/admin/mafi-readers/github-trending/refresh`，要登录和 CSRF）有 60 秒冷却，只抓榜单和星数、不调用模型，中文用途由下一轮 worker 写。Cloudflare 迁移边界见 [部署文档](deploy.md) 2026-11-09 一节。

## 更新与本机边界

前台页面每十分钟检查；关闭后没有独立后台监控或通知。后端 Tibo 至少十分钟、AA 完整快照至少 24 小时；保留冷却与缓存，失败显示上次成功数据及旧数据提示。缓存与请求合并适用于单 API 进程。

Tibo 近期接口含近七个北京时间日及仍待生效记录；日历只标记已加载记录，不代表 90 天或完整月份统计。未知范围不解释为全员，估计窗口、来源确认或发卡不代表本人账户到账，以 Codex 内显示为准。

可信 SITE_URL 必须是 localhost、127.0.0.1 或 ::1；实际私有性仍靠 Web/API 回环绑定。Docker 缺省使用 127.0.0.1:3000；旧 .env 显式写 PORT=3000 时仍须修正。私有数据不进入公开 v1、RSS 或 MCP，AA key 不写入缓存和响应。

旧 AIHOT 新闻缓存 aihot-selected/all/hot/daily/weekly/monthly.json 已随停用清理，AA 与 Tibo 缓存保留。已有独立研究快照、验证日志和人工标注不是业务缓存，继续作为历史证据保存。没有改数据库表或业务文章。

## 信源与后续运行

医药、AI 与金融原有信源配置保留。八个原始 AI 补充源目前默认暂停；本次删除外部资讯板块不自动开启自采、模型或付费请求。种子默认启用 12 个医药金融候选，共保留 28 个来源；seed 不覆盖已有数据库的同名来源。常态启用前仍需核对来源、请求预算及精选校准。

AA 免费数据只供内部阅读并保留署名，本地接入不包含公开原始数据再分发许可。Tibo 来源依照其数据使用规则读取。保留 MIT 声明，本站使用 MAFi 品牌。

依据：[AA 官方文档](https://artificialanalysis.ai/data-api/docs)、[字段参考](https://artificialanalysis.ai/data-api/docs/reference)、[迁移说明](https://artificialanalysis.ai/data-api/migrate-v2-data)、[AA 条款](https://artificialanalysis.ai/terms-of-use)、[数据平台条款](https://artificialanalysiscdn.com/legal/ProDataPlatformTerms.pdf)、[Tibo 数据来源](https://aihot.news/codex-reset)、[来源使用规则](https://aihot.news/terms)。
