# GitHub 趋势专页与 Tibo 默认暂停（实现计划）

基准：已批准的 `github_trend_plan.md`（HEAD 调查时 `89bea7908d06b3271c1695c181b10b0b8127337b`，本计划落笔时该提交仍是 `main`）。只在 `botasky138/MAFi` 的功能分支上改。不合并 `main`，不改上游，不改本机 `.env` 与线上进程。

## 范围

- `MAFI_CODEX_RESET_ENABLED === "true"` 才请求 Tibo。否则路由仍在，上游 0 次、缓存 0 写入，AA 不受影响。
- 新页面 `/github-trending`：今日 / 本周 / 本月按趋势页期间星数降序。两个仓库服务端读写都排除。缺期间星数不填 0。
- `GET` 只读缓存。worker 在开关为 `true` 时每 30 分钟检查；daily 30 分钟、weekly 2 小时、monthly 6 小时才抓。失败或快照超龄为 `stale`，`nextRefreshAt` 只是计划。
- 管理员 `POST /api/admin/mafi-readers/github-trending/refresh`：会话 + CSRF，60 秒冷却，与定时任务抢同一 dataDir 上的锁；死进程可夺锁。
- 解析、存储、抓取、调度分成函数，实现仍是本机文件与进程 cron。文档写明 Cloudflare 仅反代可以沿用，Workers/Pages 不能直接部署。
- 不做 topics 规则、不做模型分类。类别保持「待确认」。不启用 `web-github-trending`。
- 导航在「AA 模型榜」下，段名只是位置。页内近黑、冷灰金属边、香槟金，无巨型 hero，遵守减少动态效果。

## 顺序

1. 先写会失败的测试（暂停、解析、排除、只读、陈旧、冷却、锁）。
2. 再写最小实现直到这些测试通过。
3. 页面、导航、`.env.example`、`docs/deploy.md`、`docs/mafi-readers.md`。
4. 隔离进程验证（不加载仓库 `.env`）。能抓到公开趋势页就用真实快照，否则界面标明测试数据。
5. 功能 commit 之后，用该 commit 的时间换算成北京时间，再写更新日志（日志 commit 不把自己的 SHA 当成功能 SHA）。
