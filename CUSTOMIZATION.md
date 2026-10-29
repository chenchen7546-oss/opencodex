# 代理管理定制分支维护与部署

基础仓库：`https://github.com/lidge-jun/opencodex`，本次起点为 main 的 `d844ff4`（2.94.0）。
开发分支：`codex/account-proxy-management`。此文档描述本分支，不是上游发行承诺。

使用说明：[中文指南](docs-site/src/content/docs/zh-cn/guides/account-proxies.md)。
设计和接口边界：[架构文档](structure/account-proxy-management.md)。
当前部署方案：[Docker Compose 详细步骤](deploy/README.zh-CN.md)。定制镜像集成 Mihomo，构建与运行配置分离；下方 systemd 内容仅作为非容器部署参考。

20261029-4 增加[邮箱通知](docs-site/src/content/docs/zh-cn/guides/email-notifications.md)：通用 SMTP、多个收件邮箱分别启停、测试邮件、Codex 重新认证事件去重及发送记录。代理管理改为分区表单、明确空状态和响应式操作区。容器首次初始化补齐缺失的 Codex `config.toml`，保留已有配置；v1 切换错误提示改为整行显示。

## 合并上游时的主要检查点

| 定制范围 | 上游变更后需要核查的内容 |
| --- | --- |
| `src/proxy-manager/` | 独立数据层、路由、订阅、内核和统计；通常直接保留 |
| `src/notifications/`、`notification-routes.ts`、Notifications 页面 | 独立 SMTP／SQLite 模块；账号状态只通过 `runtime.ts` 适配现有 Codex 快照，界面只接管理接口 |
| `src/lib/account-egress*.ts`、`account-fetch.ts` | 核心仅依赖接口，不反向导入可选模块 |
| `src/lib/proxy-env.ts` | configuredOutboundFetch 仍经过账号路由，嵌套调用不重复统计 |
| `src/lib/provider-outbound.ts` | 验证／模型发现不能绕过绑定；保留 DNS 和目标安全检查 |
| `src/server/responses/fetch-helpers.ts`、`request-transport.ts` | 最终发送及重试重新绑定，WS 降级，外部 CLI 沿用自身网络设置 |
| `src/oauth/`、`src/codex/`、`src/providers/` | 新增验证／刷新／额度调用需进入公共 fetch 接口，并保留稳定账号身份 |
| `src/adapters/cursor/` | 绑定代理时使用 HTTP/1.1；不能走原生直连 HTTP/2 |
| 服务启动、CLI 入口、management-api 分发 | 注册、关闭模块和管理路由 |
| `gui/src/pages/proxy-manager/`、ProxyManager 页面 | 独立 UI；App、导航、路由和语言包各有少量接入点 |
| `deploy/`、`docker/custom/`、`scripts/custom/` | 复用上游 runtime 构建目标，保持原 Dockerfile/compose 不变；核查基础环境、token 路径、卷权限及健康检查 |
| `gui/src/lib/clipboard.ts` | 原生 dialog 内创建复制回退输入，失败时登录链接可手动全选；保留 focus/selection 恢复 |

代理绑定使用原仓库稳定 ID，不复制账号密码格式。流量和订阅保存在独立 SQLite 数据库，
上游修改 config.json 或账号结构时，优先调整 `accounts.ts` 这一适配层。
不能保证上游任意改动都能无冲突合并，但这些接入点可以集中复查。

维护流程：

1. 保存当前定制修改为有意义的提交，并确保工作区干净；备份运行实例的私有状态。
2. `git fetch origin`，确认上游当前默认分支。本次仓库默认分支是 main，不能照搬原项目文档里的 dev。
3. 在独立合并分支上执行 `git merge origin/main`，保留定制分支的提交历史。
4. 解决冲突后逐项核查上表，特别是新提供商和新传输。普通 HTTP 路径不能悄悄直连；外部 CLI 按已确认的例外沿用自身网络设置。
5. 执行下方检查，重新构建 GUI，在本地测试实例验收，再替换服务器程序。
6. 保留上一版本程序和与之匹配的状态备份。数据库版本不支持时会拒绝打开，不能强制降低版本号。

不要直接在这份定制安装上执行 `ocx update` 或用 npm 官方包覆盖程序目录。
`OCX_DISABLE_UPDATE_CHECK=1` 可关闭后台版本查询，但不是阻止手动覆盖的安全锁。
本分支不自动拉取、合并、发布或部署上游更新。

## 验证命令

在安装 Bun 1.4.4 的开发／CI 环境中：

```sh
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:tsc
bun test tests/lib/account-proxy-manager.test.ts tests/lib/account-proxy-import.test.ts tests/server/proxy-manager-api.test.ts
bun test tests/responses/provider-egress-fetch.test.ts tests/providers/provider-egress-outbound.test.ts tests/server/proxy-env.test.ts tests/providers/dsh-account.test.ts tests/oauth/dsh-login.test.ts
bun run privacy:scan
bun run structure:check
cd gui
bun install --frozen-lockfile
bun test tests/proxy-manager.test.tsx
bun run lint:i18n
bun run build
```

可选真实内核测试需要将 `OCX_PROXY_CORE_TEST_BIN` 设置为本机 Mihomo 可执行文件的绝对路径。
测试使用模拟账号、临时数据库和本机代理，不需要真实供应商凭据。验证过的测试内核版本为 1.19.33。
本次 Windows 环境的原仓库协调锁拒绝重解析目录，专项后端测试使用保留真实主目录保护的独立
隔离 preload 执行；没有修改或绕过生产权限检查。原仓库 `test:changed` 默认比较 dev，
本仓库没有该引用，需用实际存在的基准运行 `bun scripts/test.ts --changed=origin/main`。
完整上游测试、Linux 实机负载和真实供应商连通性应在发布前的对应环境验证。

本次本地验收：新增后端 27 项、GUI 3 项专项测试通过；真实 HTTP、SOCKS5 和 Mihomo
转发均使用本机测试代理完成。相关上游出站、DSH、Cursor、刷新锁回归通过；测试分类和
可选模块边界共 54 项检查通过。Bun／TypeScript 类型检查、GUI 文案检查与构建、隐私扫描、
文件大小及结构检查通过；最新文档站构建生成 609 页并验证 88,101 个内部链接。
没有运行完整上游测试套件，也没有连接真实供应商账号或目标 VPS。

Docker Compose 集成验收在本机 Linux 容器完成，覆盖 HTTP/Mihomo 路由、20 次节点更新、跨提供商批量绑定、停用拒绝、流量与重建持久化。
导出脚本要求验收记录与镜像 ID 匹配，部署包不包含运行数据卷。复制相关 GUI 回归共 39 项通过，
真实浏览器验证了原弹窗复制失败及修复后的粘贴结果。最新容器验收结果随部署包保存。
固定内核版本的端口开放早于转发就绪，因此独立回环检测完成后才放行首个请求；检测不消耗供应商流量。
新增打包校验 3 项及测试分类／可选模块边界的合并回归 63 项通过，脚本另做严格类型检查。

## AlmaLinux 9 x86_64 / 1 GB 部署

本次没有连接或部署到生产 VPS。先在开发机或 CI 构建前端，将本分支代码、构建后的 `gui/dist/`
和 Bun 锁文件带到服务器，避免在 1 GB VPS 上运行前端构建。Linux 生产依赖需要在 Linux 上按锁文件
安装，不能复制 Windows 的 node_modules。建议用独立普通用户运行，状态目录与程序版本目录分开。

目录示例：程序 `/opt/opencodex/current`，Bun `/usr/local/bin/bun`，状态 `/var/lib/opencodex/state`。
在状态目录的 config.json 设置监听地址 `127.0.0.1`，使用 SSH 隧道访问管理页面，或按原项目文档
配置有认证的 HTTPS 反向代理。模型接口继续使用原有的访问控制；代理管理只接受管理员／GUI 会话。

systemd 单元示例（先按实际路径和服务用户修改）：

```ini
[Unit]
Description=OpenCodex custom account proxies
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=opencodex
Group=opencodex
WorkingDirectory=/opt/opencodex/current
Environment=HOME=/var/lib/opencodex
Environment=OPENCODEX_HOME=/var/lib/opencodex/state
Environment=OCX_DISABLE_UPDATE_CHECK=1
# 只在已安装高级节点内核时添加：
# Environment=OPENCODEX_PROXY_CORE=/usr/local/bin/mihomo
ExecStart=/usr/local/bin/bun /opt/opencodex/current/src/cli/index.ts start --port 3000
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=control-group
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/opencodex
MemoryAccounting=true
MemoryHigh=600M
MemoryMax=750M
MemorySwapMax=512M

[Install]
WantedBy=multi-user.target
```

这些内存限制只是可调整的保护边界，不代表应用一定能在这个额度内运行。单元还未在目标 VPS 验证。
截图中服务器已有约 617 MB 已用内存且使用了 swap，因此部署前应检查现有服务和实际可用内存。
先只启用 HTTP／SOCKS 代理，模型请求并发从 1–2 开始；上游提供商的
`requestPacing: { enabled: true, maxConcurrentRequests: 2 }` 是**每个提供商**的限制，不是全局总限制。
多个提供商同时使用会叠加，需要按实际负载调低。

代理统计默认 90 天、15 秒落盘、检测并发 2；无需额外数据库服务。
SS／VLESS／Hysteria2 等需要额外 Mihomo 内存，普通 HTTP／SOCKS 不会启动它。
服务器进程共享一个内核；同时运行独立 CLI 命令时，CLI 可能短暂启动自己的内核。
持续观察 `free -m`、`systemctl status`、`journalctl` 及 OOM／swap 活动。
若持续换页、请求延迟恶化或触发内存限制，应先降低并发／上下文和停用不需要的模块，再评估扩容。

备份时停止服务，复制整个私有状态目录，包括 `proxy-manager/` 的数据库与 WAL 文件。
该目录含代理密码、节点密钥和订阅凭据，权限应仅限服务用户。迁移只复制状态，不把它放进 Git。
Mihomo 使用的 `core-*` 是私有临时配置；异常退出遗留的目录可在所有服务停止后清理。
- 2026-10-29：订阅内置插件与超时参数兼容、防重复；指定内网 HTTP 地址记住设备；账号名称/邮箱展示及复用上游别名编辑接口。

20261029-5 补齐原生 Codex 登录后验证、后台验证、备用额度和额度重置的账号代理身份，区分网络验证失败与认证失败；代理绑定在每次物理请求时读取，内核启动期间切换会重新检查，新请求跟随新绑定，已有流完成后释放原连接。
