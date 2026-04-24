# OpenClaw Lobster Monitor

一个正式可部署的 OpenClaw 只读监控项目。

它包含两部分：

1. 一个可公网访问的监控服务端与像素风 Web 面板
2. 一个安装到 OpenClaw 节点上的只读监控插件

每个 OpenClaw agent 会在前端家庭像素场景里映射成一只小龙虾。面板实时展示：

- 当前已绑定的 agent 数量
- 每个 agent 的状态
- 每个 agent 与全局的 token 消耗

本项目只做监控，不提供任何控制 agent 的能力。

当前 UI 视觉方向参考了 [Star Office UI](https://github.com/ringhyacinth/Star-Office-UI) 的“星际办公室”氛围，但没有直接复用其素材资源；本项目保留了自己的家庭房间、龙虾状态映射和监控流程。

## 核心特性

- 正式版只读监控
- 默认支持 `HTTP 80` 端口访问
- 没有域名和 SSL 证书时，也能通过 `IP` 直接访问
- 有域名时可选切换到 `HTTPS`
- 服务端以 `systemd` 常驻后台运行
- 提供 Linux 一键部署脚本，自动检测系统并按需安装或升级 Node
- 默认目标 Node 版本为 `22`
- 前端通过 `SSE` 实时刷新，不依赖 WebSocket
- OpenClaw 客户端支持 Linux / Windows 一键安装
- `/setup` Web 部署向导可以直接生成部署命令和配置片段
- `INGEST_TOKEN` 改为系统自动生成，不再要求用户手动填写
- 插件默认采用“事件驱动状态 + 低频 CLI 校准”的混合采集架构：
  - `pollIntervalMs=15000`
  - `eventDebounceMs=150`
  - `requestTimeoutMs=4000`
  - `cliTimeoutMs=2500`

## 项目架构

```text
OpenClaw Gateway
  -> openclaw-lobster-monitor plugin
  -> HTTP POST /api/ingest
  -> dashboard-server
  -> GET /api/snapshot + SSE /api/events
  -> Browser Dashboard
```

### 服务端

路径：

- `apps/dashboard-server/server.js`

职责：

- 提供只读监控页面
- 接收 OpenClaw 插件上报的快照
- 聚合多节点状态
- 通过 `/api/snapshot` 和 `/api/events` 向浏览器输出实时数据
- 通过 `/setup` 页面输出部署引导

### Web 面板

路径：

- `apps/dashboard-server/public/index.html`
- `apps/dashboard-server/public/styles.css`
- `apps/dashboard-server/public/app.js`
- `apps/dashboard-server/public/setup.html`
- `apps/dashboard-server/public/setup.css`
- `apps/dashboard-server/public/setup.js`

职责：

- 首页展示实时监控
- `/setup` 页面生成服务端部署命令、客户端安装命令和配置片段
- UI 使用“星际办公室外壳 + 家庭像素房间”的形式展示龙虾状态

### OpenClaw 插件

路径：

- `plugins/openclaw-lobster-monitor/index.js`
- `plugins/openclaw-lobster-monitor/lib/collector.js`

职责：

- 以事件驱动方式实时更新 agent 状态，并以低频 CLI 周期做校准
- 优先尝试：
  - `openclaw status --json --usage`
  - `openclaw health --json`
- 当 CLI 数据不可用时，退回到 `openclaw.json` 中的 `agents.list` 和 `bindings`
- 将标准化结果单向上报到监控服务端

## 工作流程

1. OpenClaw 节点加载 `openclaw-lobster-monitor` 插件。
2. 插件通过 OpenClaw hook 监听 `message`、`command`、`agent` 等生命周期事件，实时更新本地状态缓存。
3. 状态事件会经过一个很小的 debounce 窗口后立即上报到 `POST /api/ingest`，让面板更快刷新。
4. 插件同时以低频 CLI 周期执行 `openclaw status --json --usage` 与 `openclaw health --json`，补齐 token、health 与漂移校准。
5. 每次 CLI 校准都会带超时保护，避免慢命令把整条上报链路拖慢。
6. 服务端按 `sourceId` 聚合多节点状态，并把最新快照写入本地 JSON。
7. 浏览器打开首页后，先拉取 `GET /api/snapshot`，再订阅 `GET /api/events`。
8. 前端把每个 agent 渲染成家庭像素房间中的一只龙虾。

## 只读安全边界

本项目的数据流是单向的：

```text
OpenClaw -> Plugin -> Monitor Server -> Browser
```

当前没有：

- 浏览器到 OpenClaw 的反向控制链路
- “停止 agent / 重启 agent / 发送命令”按钮
- 面向前端开放的控制 API

写入入口只有：

- `POST /api/ingest`

而且写入需要 `Bearer token`。

## INGEST_TOKEN 机制

`INGEST_TOKEN` 现在不再由用户手填，而是改成系统自动生成。

行为如下：

1. 如果部署时显式传入 `--ingest-token`，则使用该值。
2. 如果没有传入，但旧的环境文件里已经有 token，则自动复用旧 token。
3. 如果两者都没有，安装脚本会自动生成一个随机 token。
4. 如果你直接手工运行 `node server.js` 而没有提供 token，服务端也会自动生成并持久化。
5. `/setup` 页面会直接读取当前服务端 token，用它生成 OpenClaw 客户端一键安装命令。

默认持久化位置：

- Linux 安装脚本写入 `/etc/openclaw-lobster-monitor/dashboard.env`
- 手工启动时写入 `apps/dashboard-server/data/ingest-token.txt`

## `/setup` 页面说明

启动服务端后，可以直接访问：

```text
http://你的服务器IP/setup
```

或者：

```text
https://你的域名/setup
```

这个页面会实时生成：

- 服务端一键部署命令
- 服务端环境变量预览
- OpenClaw Linux 客户端一键安装命令
- OpenClaw Windows 客户端一键安装命令
- OpenClaw 插件配置片段

### 安全提示

为了降低部署学习成本，`/setup` 页面会展示当前服务端使用的 `INGEST_TOKEN`，方便你直接复制客户端安装命令。

如果你的监控面板面向不受信任的公网用户开放，建议额外做其中一种保护：

- 只允许内网或固定 IP 访问 `/setup`
- 通过 Nginx / Caddy 给 `/setup` 加 Basic Auth
- 把 `/setup` 放在受限的管理入口后面

## 仓库结构

```text
openclaw-lobster-monitor/
├─ apps/
│  └─ dashboard-server/
│     ├─ public/
│     │  ├─ index.html
│     │  ├─ styles.css
│     │  ├─ app.js
│     │  ├─ setup.html
│     │  ├─ setup.css
│     │  └─ setup.js
│     ├─ .env.example
│     ├─ .env.production.example
│     ├─ package.json
│     └─ server.js
├─ deploy/
│  ├─ linux/
│  │  ├─ caddy/Caddyfile
│  │  ├─ env/dashboard.env
│  │  └─ systemd/openclaw-lobster-monitor.service
│  └─ scripts/
│     ├─ bootstrap-server.sh
│     ├─ install-server.sh
│     ├─ install-openclaw-plugin.sh
│     └─ install-openclaw-plugin.ps1
├─ plugins/
│  └─ openclaw-lobster-monitor/
│     ├─ lib/collector.js
│     ├─ index.js
│     ├─ openclaw.plugin.json
│     └─ package.json
└─ README.md
```

## 拉取仓库

```bash
git clone https://github.com/GreenhandTan/openclaw-lobster-monitor.git
cd openclaw-lobster-monitor
```

## 本地开发启动

下面这段只适合本地开发调试，不建议作为正式部署方式：

```bash
cd apps/dashboard-server
PORT=80 PUBLIC_BASE_URL=http://127.0.0.1 node server.js
```

说明：

- 没有传 `INGEST_TOKEN` 时，服务端会自动生成
- 本地启动后可以直接打开 `/setup` 查看当前 token 和安装命令
- 正式部署请使用下面的 `bootstrap-server.sh`

访问地址：

```text
http://127.0.0.1
```

部署引导：

```text
http://127.0.0.1/setup
```

## 正式部署

### 推荐方式：Linux 一键部署脚本

正式环境不要手工输入 `PORT=80 PUBLIC_BASE_URL=... node server.js`。

推荐使用：

- `deploy/scripts/bootstrap-server.sh`

这个脚本会自动完成：

- 检测当前 Linux 发行版和版本
- 检查 `systemd`
- 安装缺失的基础依赖：`git`、`curl`、`tar`、`xz` 等
- 检查现有 Node 版本是否合适
- 如果现有 Node 不合适，则自动安装或升级到 Node 22 运行时
- 拉取或更新仓库
- 调用 `install-server.sh`
- 创建并启动 `systemd` 常驻服务

### 方案 A：没有域名，直接通过 IP 使用 HTTP

这是默认推荐方案，也是最轻量的正式部署方式。

```bash
curl -fsSL https://raw.githubusercontent.com/GreenhandTan/openclaw-lobster-monitor/main/deploy/scripts/bootstrap-server.sh -o /tmp/openclaw-lobster-bootstrap.sh
sudo bash /tmp/openclaw-lobster-bootstrap.sh \
  --repo-dir /opt/openclaw-lobster-monitor \
  --mode direct-http \
  --public-host 203.0.113.10 \
  --public-port 80 \
  --listen-port 80 \
  --target-node-major 22
```

完成后访问：

```text
http://203.0.113.10
```

部署向导：

```text
http://203.0.113.10/setup
```

### 方案 B：有域名，启用 HTTPS

```bash
curl -fsSL https://raw.githubusercontent.com/GreenhandTan/openclaw-lobster-monitor/main/deploy/scripts/bootstrap-server.sh -o /tmp/openclaw-lobster-bootstrap.sh
sudo bash /tmp/openclaw-lobster-bootstrap.sh \
  --repo-dir /opt/openclaw-lobster-monitor \
  --mode caddy-https \
  --public-host monitor.example.com \
  --public-port 443 \
  --listen-port 8787 \
  --target-node-major 22
```

完成后访问：

```text
https://monitor.example.com
```

部署向导：

```text
https://monitor.example.com/setup
```

### 如果仓库已经克隆到本机

也可以直接在仓库目录里运行：

```bash
sudo bash deploy/scripts/bootstrap-server.sh \
  --repo-dir /opt/openclaw-lobster-monitor \
  --mode direct-http \
  --public-host 203.0.113.10 \
  --public-port 80 \
  --listen-port 80 \
  --target-node-major 22
```

## OpenClaw 客户端一键安装

每个 OpenClaw 节点都安装一次插件。

最简单的方式不是手拼配置，而是先打开 `/setup` 页面，直接复制其中自动生成的安装命令。

### Linux / macOS

```bash
MONITOR_URL='http://203.0.113.10' \
INGEST_TOKEN='系统自动生成的 token' \
SOURCE_ID='office-gateway' \
SOURCE_LABEL='Office Gateway' \
OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json" \
bash -c "$(curl -fsSL http://203.0.113.10/api/setup/install/openclaw.sh)"
```

### Windows PowerShell

```powershell
$env:MONITOR_URL='http://203.0.113.10'; $env:INGEST_TOKEN='系统自动生成的 token'; $env:SOURCE_ID='office-gateway'; $env:SOURCE_LABEL='Office Gateway'; $env:OPENCLAW_CONFIG_PATH="$env:USERPROFILE\.openclaw\openclaw.json"; Invoke-Expression ((Invoke-WebRequest -UseBasicParsing 'http://203.0.113.10/api/setup/install/openclaw.ps1').Content)
```

安装脚本会自动完成：

- 下载插件文件
- 写入本地插件目录
- 更新 `openclaw.json`
- 尝试执行 `openclaw plugins install`

默认混合架构配置为：

- `pollIntervalMs=15000`
- `eventDebounceMs=150`
- `requestTimeoutMs=4000`
- `cliTimeoutMs=2500`

## OpenClaw 客户端卸载

如果你需要从某个 OpenClaw 节点移除监控插件，建议按下面的顺序操作：

1. 停止或重启前先备份当前 `openclaw.json`
2. 删除插件目录 `plugins/openclaw-lobster-monitor`
3. 从 `openclaw.json` 中移除：
   - `plugins.load.paths` 里的插件目录路径
   - `plugins.entries["openclaw-lobster-monitor"]`
4. 重启 OpenClaw Gateway

### Linux / macOS

默认情况下，一键安装脚本会把插件放到：

```text
$HOME/.openclaw/plugins/openclaw-lobster-monitor
```

或者更准确地说：

```text
$(dirname OPENCLAW_CONFIG_PATH)/plugins/openclaw-lobster-monitor
```

删除目录示例：

```bash
rm -rf "$HOME/.openclaw/plugins/openclaw-lobster-monitor"
```

然后编辑你的 `openclaw.json`，移除：

```json
{
  "plugins": {
    "load": {
      "paths": []
    },
    "entries": {}
  }
}
```

说明：

- 这里只是示意要删掉对应项，不代表要把你其他插件配置一起删空
- 如果安装脚本曾生成过 `openclaw.json.bak.时间戳` 备份，也可以按需对比后恢复

### Windows PowerShell

默认情况下，一键安装脚本会把插件放到：

```text
$env:USERPROFILE\.openclaw\plugins\openclaw-lobster-monitor
```

删除目录示例：

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.openclaw\plugins\openclaw-lobster-monitor"
```

然后编辑 `openclaw.json`，删除：

- `plugins.load.paths` 中对应的插件目录
- `plugins.entries.openclaw-lobster-monitor`

### 卸载后的检查

重启 OpenClaw Gateway 后，确认：

- 本地插件目录已经不存在
- `openclaw.json` 中不再包含 `openclaw-lobster-monitor`
- 面板上的对应 `sourceId` 在超出 `SOURCE_TTL_MS` 后会自动变为过期或离线，并最终被清理

## 手动插件配置

如果你不使用一键安装脚本，也可以手动配置：

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/plugins/openclaw-lobster-monitor"
      ]
    },
    "entries": {
      "openclaw-lobster-monitor": {
        "enabled": true,
        "config": {
          "serverUrl": "http://203.0.113.10",
          "ingestToken": "系统自动生成的 token",
          "sourceId": "office-gateway",
          "sourceLabel": "Office Gateway",
          "pollIntervalMs": 15000,
          "eventDebounceMs": 150,
          "requestTimeoutMs": 4000,
          "cliTimeoutMs": 2500,
          "enableCli": true
        }
      }
    }
  }
}
```

## 服务端脚本说明

### `deploy/scripts/bootstrap-server.sh`

这是正式部署入口，负责：

- 系统检测
- Node 22 自动准备
- 仓库拉取或更新
- 后台常驻部署

### `deploy/scripts/install-server.sh`

这是被 bootstrap 调用的底层安装脚本，负责：

- 创建运行用户
- 创建 `systemd` 服务
- 写入环境文件
- 创建数据目录
- 自动生成或复用 `INGEST_TOKEN`
- 启动并托管服务进程
- 在 HTTPS 模式下写入 Caddy 配置

默认路径：

- 数据目录：`/var/lib/openclaw-lobster-monitor`
- 环境文件：`/etc/openclaw-lobster-monitor/dashboard.env`
- 服务名：`openclaw-lobster-monitor`

## 常用运维命令

查看服务状态：

```bash
sudo systemctl status openclaw-lobster-monitor
```

查看实时日志：

```bash
sudo journalctl -u openclaw-lobster-monitor -f
```

重启服务：

```bash
sudo systemctl restart openclaw-lobster-monitor
```

查看最新快照：

```bash
sudo cat /var/lib/openclaw-lobster-monitor/snapshot-store.json
```

查看当前 token：

```bash
sudo grep '^INGEST_TOKEN=' /etc/openclaw-lobster-monitor/dashboard.env
```

## 当前实现边界

当前版本已经是正式可部署版本，但目标仍然聚焦在“轻量、只读、低学习成本”的 OpenClaw 监控上。

已完成：

- 多节点状态上报
- 像素风实时监控面板
- `/setup` Web 部署引导
- 服务端后台常驻部署
- Linux 一键部署脚本
- Node 22 自动安装或升级
- 一键 OpenClaw 客户端安装
- HTTP 80 默认访问
- 可选 HTTPS
- 自动生成 token
- 事件驱动状态 + 低频 CLI 校准的默认采集参数

尚未覆盖：

- 多用户登录
- 历史时序分析
- 告警策略
- 细粒度权限体系

如果后续继续扩展，建议优先增加：

1. 历史状态存储
2. 告警规则
3. 基础认证
4. 更细颗粒度的 OpenClaw 状态解析
