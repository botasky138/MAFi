# MAFi 绿联 NAS（DXP4800 Plus / UGOS Pro）+ Cloudflare Tunnel 上线指南

适用目标：
- **主机**：绿联 DXP4800 Plus（UGOS Pro，x86_64，16 GB 内存，常开机，本机或局域网已有代理）
- **域名**：`https://mafi.botasky.uk`（DNS 已托管在 Cloudflare，**仅本人自用**）
- **访问控制**：Cloudflare Tunnel + Cloudflare Zero Trust Access（零路由器端口映射、不暴露家庭宽带 IP）
- **数据库**：从旧 Windows 机器迁移现有数据并清理旧预览残留

---

## 1. 架构总览

不要把数据库放家里 NAS、而把 Web/API/Worker 放公网 VPS：MAFi 的 SSR 页面、API 与 `worker`（`pg-boss` 每 15 秒轮询）对数据库都是高频低延迟读写，且 `api` 与 `worker` 必须共用同一份 `/data` 目录（见 [部署文档](deploy.md)）。

在绿联 DXP4800 Plus 上运行完整 6 个容器最稳妥：

```text
浏览器 / 手机 (https://mafi.botasky.uk)
   │
   ▼
Cloudflare Edge + Cloudflare Zero Trust Access（邮箱 OTP / GitHub 登录保护）
   │  (Cloudflare Tunnel 加密隧道，无需公网 IP 或端口转发)
   ▼
[cloudflared] ──► [web :3000] ──► [api :3001] ──► [db :5432 (PostgreSQL 17)]
                                        ▲               ▲
                                        └── [worker] ───┘
                                              │
                         ┌────────────────────┴────────────────────┐
                         ▼                                         ▼
              国内信源（直连）                        海外信源 / GitHub / AA / 模型
         *.cn / cnpharm.com / stcn.com                  经 EGRESS_PROXY_URL 或直连
```

---

## 2. 从旧 Windows 迁移数据库并清理不兼容项

### 2.1 在旧 Windows 机器导出数据库

如果旧 Windows 上仍运行着 Docker 数据库（参考 [mafi-handoff.md](mafi-handoff.md)，常见容器名为 `mafi-postgres-test-20261021`，库名 `mafi_preview_20261021`，用户名 `mafi`）：

```powershell
# PowerShell（不要用 > 重定向二进制 dump，Windows PowerShell 5.1 会按 UTF-16 破坏文件）
docker exec mafi-postgres-test-20261021 pg_dump -U mafi -d mafi_preview_20261021 --format=custom --no-owner --no-privileges --file=/tmp/mafi-win-backup.dump
docker cp mafi-postgres-test-20261021:/tmp/mafi-win-backup.dump .\mafi-win-backup.dump
docker exec mafi-postgres-test-20261021 rm -f /tmp/mafi-win-backup.dump
```

> 同时把旧 Windows 里的 `.env`（记录 API Key）以及 `.data/uploads/`、`.data/mafi-readers/`（如有）一并拷贝出来备用。旧的 `mafi-*.cmd`、`scripts/mafi-auto-loop.mjs`、`.data/preview-pids.json` 属于 Windows 本机预览工具，**不需要迁移到 NAS**。

### 2.2 在绿联 NAS 准备目录与仓库

SSH 登录绿联 NAS（或使用 UGOS Pro 终端），创建持久化目录并克隆仓库：

```bash
mkdir -p /volume1/docker/mafi/pgdata /volume1/docker/mafi/data
cd /volume1/docker
git clone https://github.com/botasky138/MAFi.git mafi-app
cd /volume1/docker/mafi-app
git checkout deploy/nas-mafi
```

先完成第 4 节的 `.env` 配置（此时保持 `COLLECT_ENABLED=false`、`MODEL_CALLS_ENABLED=false`），再仅启动 `db` 容器：

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml up -d db
```

### 2.3 导入旧库并跑最新迁移

将 `mafi-win-backup.dump` 传到 `/volume1/docker/mafi/` 后，先清理新建空库结构再恢复（避免表已存在报错），随后运行 `setup` 自动补齐最新迁移（如 `0090`、`0127`、`0140` 等）：

```bash
# 1. 先构建应用镜像（国内建议加 npm 镜像），再重置空库 aihot（会清空新建空库里的数据，请确认库名无误）
docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml --profile tunnel \
  build --build-arg NPM_REGISTRY=https://registry.npmmirror.com

docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml exec -T db \
  psql -U aihot -d postgres -c "DROP DATABASE IF EXISTS aihot; CREATE DATABASE aihot OWNER aihot;"

# 2. 导入 Windows 导出包（--no-owner --no-privileges 适配新库用户 aihot）
cat /volume1/docker/mafi/mafi-win-backup.dump | \
  docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml exec -T db \
  pg_restore -U aihot -d aihot --no-owner --no-privileges --exit-on-error

# 3. 补齐数据库迁移和种子检查（不会覆盖已有同名信源）
docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml run --rm setup
```

> 若旧库里包含旧 `pg_trgm` 等扩展创建语句导致 `pg_restore` 提示权限或已存在告警，可去掉 `--exit-on-error` 观察警告内容，确保无表数据缺失即可。

### 2.4 清理旧 Windows 环境残留记录

导入完成后，建议用 `psql` 检查并清理旧环境残留状态：

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml exec -T db psql -U aihot -d aihot <<'SQL'
-- 1. 清理旧机器主机名/PID 心跳与告警残留（新容器启动后会重新写入）
DELETE FROM settings WHERE key LIKE 'heartbeat.%' OR key = 'watchdog.worker';

-- 2. 查看当前预算熔断上限（确认 jina/socialdata/dajiala 仍为 0，llm/deepseek 处于安全值）
SELECT service, per_minute, per_hour, per_day FROM budgets ORDER BY service;

-- 3. 查看信源启用状态（确保需要停用的如 web-nmpa-* 仍为 false，cnpharm 替代源为 true）
SELECT id, name, enabled, health FROM sources ORDER BY enabled DESC, id;
SQL
```

如果旧 Windows 上曾经启过本地实验性 `pgboss` 队列且有卡死任务，可用下面语句只清理队列状态（不影响文章/精选/日报/投票业务数据）：

```sql
-- 仅在需要重置后台排队任务时执行
TRUNCATE TABLE pgboss.job;
```

（可选）如果旧 Windows `.data/uploads/` 或 `.data/mafi-readers/aa-models.json` 有历史附件或缓存，复制到 `/volume1/docker/mafi/data/` 对应子目录，并确保容器内 `node` 用户（UID `1000`）可读写：

```bash
chown -R 1000:1000 /volume1/docker/mafi/data
```

---

## 3. 配置 Cloudflare Tunnel 与 Zero Trust Access

### 3.1 创建 Tunnel

1. 登录 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks** → **Tunnels** → **Create a tunnel** → 选择 **Cloudflared**。
2. 命名例如 `ugreen-nas-mafi`，保存后复制页面给出的 **Tunnel Token**（以 `eyJ...` 开头，填入 `.env` 的 `CLOUDFLARE_TUNNEL_TOKEN`）。
3. 在该 Tunnel 的 **Public Hostname** 添加一条路由：
   - **Subdomain**：`mafi`
   - **Domain**：`botasky.uk`
   - **Type**：`HTTP`
   - **URL**：`web:3000`（同一 Compose 网络内直接用服务名 `web:3000`，无需暴露宿主机端口）

### 3.2 开启个人专属 Access 认证（强烈建议）

因为 `.env` 会开启 `MAFI_READERS_ALLOW_EXTERNAL_SITE=true`（允许在 `mafi.botasky.uk` 访问 AA 模型榜和 Tibo 页面，且 `/api/mafi-readers/aa-models/refresh` 依赖同源校验而非后台会话），**必须通过 Cloudflare Access 保证仅本人能打开该域名**：

1. Zero Trust → **Access** → **Applications** → **Add an application** → **Self-hosted**。
2. **Application domain**：`mafi.botasky.uk`，Session Duration 可设为 `1 month`。
3. **Policy**：Action 选 `Allow`，Include 选 **Emails**（填你自己的邮箱，通过一次性验证码登录）或绑定你的 GitHub 账号。
4. **不要配置 Bypass 放行匿名公网访问**（除非你专门用 Access Service Token 给私有 RSS/MCP 客户端放行）。

### 3.3 Cloudflare 缓存规则提示

- 保持默认缓存行为（不要为 `mafi.botasky.uk` 配置“Cache Everything”强制缓存动态 HTML、`/api/*` 或 `/feed*`）。
- 确保不篡改或丢弃浏览器发往源站的 `Origin` 请求头（点赞/踩 `/api/site/reactions` 与 AA 刷新按钮会校验 `Origin` 与 `SITE_URL` 同源）。

---

## 4. 绿联 NAS 生产 `.env` 配置说明

在 `/volume1/docker/mafi-app/.env` 创建配置（切勿提交到 Git）。先生成随机密钥（`POSTGRES_PASSWORD` 用 hex，避免特殊字符影响连接串解析）：

```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # IMG_PROXY_SIGN_SECRET
openssl rand -hex 18   # POSTGRES_PASSWORD
openssl rand -base64 15 | tr '/+' '_-'  # ADMIN_PASSWORD（不少于 12 位）
```

参考模板（按你的实际密钥和 NAS 代理端口填写）：

```dotenv
# ===== 站点与反向代理 =====
SITE_URL=https://mafi.botasky.uk
TRUST_PROXY=true
# 仅监听本机回环（Cloudflare Tunnel 容器内直连 web:3000）；若想在家里局域网直接访问可改成 3000
PORT=127.0.0.1:3000
NAS_DATA_ROOT=/volume1/docker/mafi

# ===== Cloudflare Tunnel =====
CLOUDFLARE_TUNNEL_TOKEN=<你的 Tunnel Token>

# ===== MAFi 读者模块与个人外部域名放行 =====
# 仅在 Cloudflare Access 保护下开启
MAFI_READERS_ALLOW_EXTERNAL_SITE=true
MAFI_GITHUB_TREND_ENABLED=true
MAFI_CODEX_RESET_ENABLED=false
GITHUB_TOKEN=<只读 Public repositories token，提升 GitHub Trending 实时星数配额>
AA_API_KEY=<Artificial Analysis API Key>

# ===== 管理员与安全密钥 =====
ADMIN_PASSWORD=<12位以上随机密码>
SESSION_SECRET=<64位hex>
IMG_PROXY_SIGN_SECRET=<64位hex>
POSTGRES_PASSWORD=<36位hex，若导入了旧库也可保持随机新密码，db 容器仅首次初始化认它>

# ===== 大模型配置 =====
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=<DeepSeek API Key>
LLM_MODEL=deepseek-flash
LLM_EXTRA_JSON={"thinking":{"type":"disabled"}}
# 如需使用 MiniMax-M3：
# MINIMAX_BASE_URL=https://api.minimax.io/v1
# MINIMAX_API_KEY=<MiniMax 国际平台 Key>

# ===== 网络出站与代理（绿联 NAS 容器连 NAS 代理） =====
# 容器内关闭网卡绑定的 DoH 直连，由容器桥接网络直连国内源（*.cn 与 site/site.ts 的 cnpharm.com/stcn.com）
MAFI_CN_DIRECT_LOCAL_ADDRESS=off
# 指向 NAS 上的代理（代理软件需开启 Allow LAN / 允许局域网连接）
# docker-compose.yml 已为后端配置 host.docker.internal:host-gateway；如果代理跑在另一容器或局域网设备，也可直接填 http://<NAS局域网IP>:<端口>
EGRESS_PROXY_URL=http://host.docker.internal:7890

# ===== 安全阀：首次冷启动务必保持 false =====
COLLECT_ENABLED=false
MODEL_CALLS_ENABLED=false
FEISHU_CONTENT_PUSH_ENABLED=false
FEISHU_INTERNAL_ENABLED=false
INDEXNOW_SUBMIT_ENABLED=false

# ===== 异地自动备份（推荐 Cloudflare R2，每日 04:10 自动上传） =====
# DB_BACKUP_STORE_SECRET_ID=<R2 Access Key ID>
# DB_BACKUP_STORE_SECRET_KEY=<R2 Secret Access Key>
# DB_BACKUP_STORE_BUCKET=<R2 Bucket 名称>
# DB_BACKUP_STORE_REGION=auto
# DB_BACKUP_STORE_DOMAIN=<AccountID>.r2.cloudflarestorage.com/<Bucket名称>
```

> **代理与直连说明**：
> - `site/site.ts` 的 `DEPLOYMENT.directFetchHosts` 已列入 `www.cnpharm.com`、`cnpharm.com`、`www.stcn.com`、`stcn.com`；叠加框架对 `*.cn` 的自动直连策略，国内官媒/财经源不会经过海外代理。
> - `EGRESS_PROXY_URL` 仅用于抓取海外信源（OpenAI/Anthropic/GitHub/Fed/CNBC）及图片代理、AA/Tibo 接口；模型请求（DeepSeek/MiniMax）直连，不走 `EGRESS_PROXY_URL`。如果代理跑在 NAS 宿主机，`http://host.docker.internal:<端口>` 与 `http://<NAS局域网IP>:<端口>` 均可使用。
> - `NAS_DATA_ROOT` 写在 `.env` 里仅供 `deploy/docker-compose.nas.override.yml` 变量替换使用；不要把 `NAS_DATA_ROOT` 加回 `.env.example`（架构测试 `tests/architecture.test.ts` 会检查 `.env.example` 中的变量必须被代码或主 `docker-compose.yml` 使用）。
> - 若家里宽带屏蔽或限速 QUIC（UDP 7844）导致 `cloudflared` 频繁断连，可在 `deploy/docker-compose.nas.override.yml` 的 `cloudflared.environment` 中添加 `TUNNEL_TRANSPORT_PROTOCOL: http2`。

---

## 5. 分阶段冷启动、开闸与验收

### 5.1 构建并冷启动（安全阀关闭）

如果 NAS 在国内拉取 npm 依赖较慢，可传入 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com`：

```bash
cd /volume1/docker/mafi-app
docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml --profile tunnel \
  build --build-arg NPM_REGISTRY=https://registry.npmmirror.com

docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml --profile tunnel up -d
```

先看日志确认 `db`、`setup`、`api`、`worker`、`web`、`cloudflared` 全部启动无报错：

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml --profile tunnel ps
docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml --profile tunnel logs -f --tail 80 api worker web cloudflared
```

### 5.2 登录后台核对预算与信源

1. 浏览器打开 `https://mafi.botasky.uk/admin`，完成 Cloudflare Access 验证后用 `ADMIN_PASSWORD` 登录后台。
2. 进入 **设置 → 付费请求上限**，确认 `llm` / `deepseek` 上限处于你可接受范围（例如日上限 `500`、时上限 `450`、分上限 `20`），`jina` / `socialdata` / `dajiala` 均为 `0`。
3. 进入 **信源** 页核对启用的信源名单。

### 5.3 两步开闸

1. **第一步（先开采集与 GitHub 趋势，模型继续关闭）**：
   - 将 `.env` 中 `COLLECT_ENABLED=true`，重启服务使新配置生效：
     ```bash
     docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml --profile tunnel up -d api worker web
     ```
   - 观察 10–15 分钟，在 `/admin` 的「信源」和「运行」页确认国内源与海外源均正常抓回文章、`/github-trending` 有数据。
2. **第二步（开启模型精选与中文用途）**：
   - 将 `.env` 中 `MODEL_CALLS_ENABLED=true`，重启 `api` 与 `worker`：
     ```bash
     docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml --profile tunnel up -d api worker
     ```
   - 在 `/admin` 的「运行」和「模型与评测」页观察 `content.sweep` 与 `githubPurpose` 调用次数与预算消耗正常。

### 5.4 上线验收清单

- [ ] `https://mafi.botasky.uk/`、`/all`、`/hot`、`/daily`、`/leaderboard`、`/github-trending`、`/api/health` 均可正常访问（HTTP 200）。
- [ ] 侧栏底部状态灯显示绿灯 **运行正常**（`worker` 心跳、`collect`、`analyze` 状态正常）。
- [ ] 点击文章卡片 👍/👎 投票返回正常，浏览器 Cookie `mafi_device` 带有 `Secure` 属性。
- [ ] `/leaderboard` 能正常加载模型数据，「从 AA 拉取最新」按钮可用（无 403 / `local_only`）。
- [ ] `/admin` 登录、登出正常；未登录访问 `/api/admin/me` 返回 401。

---

## 6. 异地自动备份与日常更新

### 6.1 异地备份（Cloudflare R2）

在 `.env` 配置 `DB_BACKUP_STORE_*` 后，`worker` 会在每天北京时间 **04:10** 自动执行 `pg_dump` + `/data/uploads` 打包并校验后上传到对象存储（同时在 `/data/backups/` 保留最近 3 份本地副本）。注意 `backup.ts` 上传时使用 Node 原生 `fetch` 直连 `https://${DB_BACKUP_STORE_DOMAIN}`，在 NAS 上配好 R2 后建议在后台「运行」页或手工确认一次上传连通性。

### 6.2 日常更新流程

按 [部署文档](deploy.md) 规范，更新时先排空 `worker`（Compose 已配置 `stop_grace_period: 515s`，避免打断进行中的模型调用或备份）：

```bash
cd /volume1/docker/mafi-app
# 1. 更新前手动留一份数据库备份
docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml exec -T db \
  pg_dump -U aihot -Fc aihot > /volume1/docker/mafi/pre-update-$(date +%F).dump

# 2. 拉代码并构建新镜像
git pull
docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml --profile tunnel build

# 3. 停旧业务进程，执行迁移，再拉起新版本
docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml stop api worker web
docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml run --rm setup
docker compose -f docker-compose.yml -f deploy/docker-compose.nas.override.yml --profile tunnel up -d
```
