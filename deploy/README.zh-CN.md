# 定制版 Docker Compose 部署指南

目标：内网 CentOS 7 x86_64（内核 3.10.0-1160.119.1.el7、Docker 26.1.4、Compose 2.27.1，可直接出网）。另保留 AlmaLinux 9／1 GB VPS 轻量配置。本指南针对定制分支，镜像不是上游官方发行版。
选择在开发机构建、在服务器导入运行；服务器不需要安装 Bun、Node、Git 或编译前端。

## 1. 本次交付与边界

- 镜像：`opencodex-custom:20261030-1`，Linux amd64。镜像的确切 ID 见部署包 `release.json`。
- 集成 Mihomo 1.19.33，构建时从官方 release 下载并核对固定 SHA-256；许可证在镜像 `/usr/share/licenses/mihomo/`。
- 普通 HTTP/HTTPS/SOCKS5/SOCKS5h 不启动内核；高级节点按需启动一个进程，不启用 TUN，不暴露控制器端口。
- 独立代理管理、账号绑定、跨提供商批量分配、订阅手动更新、出口检测、流量统计与限额均在管理页面操作。
- 增加独立“邮箱通知”页面，支持通用 SMTP、多个收件邮箱独立启停、测试邮件和 Codex 重新认证提醒。
- OAuth 服务器端验证、刷新、额度查询及模型 HTTP 请求使用绑定；浏览器自身登录网页的出口仍由浏览器网络决定。
- Claude CLI、CodeBuddy、Qoder 等外部命令行适配器沿用自身网络设置，账号代理不能控制其子进程连接。
- 流量统计是应用请求／响应正文量，包含检测与重试，不等于运营商计费流量。
- 复制登录链接已修复原生弹窗里的回退路径；浏览器完全拒绝复制时会提供可全选的手动复制框。

本机已用 Linux 容器和模拟上游验证 HTTP/Mihomo 路由、20 次节点更新、批量绑定、停用拒绝直连、统计、重建持久化、令牌保留和容器隔离。
镜像轻负载测试的空闲及启动内核后内存实测见部署包 `acceptance.json`。
这不是目标 VPS 压力测试，也没有使用你的真实供应商账号。ARM64 下载资产已固定，但本次没有构建或验收 ARM 镜像。

## 2. 服务器准备

先检查现有负载，保留其他服务。目标机器已有 Docker 26.1.4 和 Compose 2.27.1，直接使用现有安装，不需要执行下方的安装命令。

```bash
uname -m
uname -r
free -h
swapon --show
df -h /
sudo docker version
sudo docker compose version
```

`uname -m` 应为 `x86_64`。已有 Docker 时直接跳到下一节，保持现有服务和配置。
CentOS 7 不在当前 Docker 官方安装支持列表中；下面安装命令仅供**新建 AlmaLinux 9 主机**参考，不能原样用于 CentOS 7。
[Bun 官方](https://bun.com/docs/installation)说明可运行于 Linux 3.10，但推荐 5.6 及以上。Docker 不会替换宿主机内核，是否兼容仍以目标机器的容器自检为准；本机容器测试不等于 CentOS 7 实机验收。

需要新装 Docker 时，AlmaLinux 9 可使用兼容的 Enterprise Linux 9 仓库方案；下面依据
[Docker CentOS 安装文档](https://docs.docker.com/engine/install/centos/)，不是 Docker 对 AlmaLinux 的官方支持承诺。
遇到现有 Podman/runc/containerd 包冲突先评估其用途，不要直接卸载其他应用的依赖。

```bash
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

核对包来源与安装提示后确认。使用 Compose v2 或更新版；只有开发机的源码构建需要 Compose >= 2.17 的 additional_contexts 支持。
磁盘需同时容纳压缩包、镜像、旧版本及状态。此镜像展开约 630 MiB，建议部署前至少留出 3 GB 可用空间。
Docker 29 的存储可能同时涉及 `/var/lib/docker` 与 `/var/lib/containerd`，以 `docker info` 和实际挂载为准。

## 3. 上传并验证部署包

本机生成目录为 `dist/custom/opencodex-custom-20261030-1/`，里面包含镜像归档、Compose、环境变量示例、本指南、版本和验收记录。
先在服务器创建部署父目录，然后在 Windows PowerShell 上传；替换 `SERVER_IP` 和登录用户：

```powershell
ssh root@SERVER_IP "mkdir -p /opt/opencodex-custom/releases"
scp -r .\dist\custom\opencodex-custom-20261030-1 root@SERVER_IP:/opt/opencodex-custom/releases/
```

在服务器运行：

```bash
cd /opt/opencodex-custom/releases/opencodex-custom-20261030-1
sha256sum -c SHA256SUMS
sudo docker load --input opencodex-image.tar.gz
sudo docker image inspect opencodex-custom:20261030-1 --format '{{.Id}} {{.Os}}/{{.Architecture}}'
cat release.json
```

所有文件校验通过，镜像 ID 与 `release.json` 相同，平台为 `linux/amd64` 后再启动。
包里不含本机预览实例的账号、令牌或数据卷；这些状态在服务器首次运行时生成。

## 4. 初始化并启动

```bash
umask 077
test -f .env || cp .env.centos7.example .env
chmod 600 .env
```

内网服务器示例上限为 2 GiB 内存、2 CPU，按机器实际余量调整；原 1 GB VPS 使用 `.env.example`。
按需编辑 `.env`。模板默认只监听服务器 `127.0.0.1:10100`；本次内网直接访问方案将 `OPENCODEX_BIND_ADDRESS=192.168.120.108`，地址为 `http://192.168.120.108:10100/`。仅绑定实际内网地址；下面健康检查的 IP 也应替换为这个地址。保留回环绑定时可使用第 5 节的 SSH 隧道。
定义一个仅在当前 shell 生效的命令，后文均从上述部署目录执行：

```bash
dc() { sudo docker compose --project-name opencodex-custom --env-file .env -f compose.yaml "$@"; }
dc config --quiet
dc run --rm --no-deps --entrypoint bun hub -e 'const d=new (require("bun:sqlite").Database)(":memory:");d.exec("SELECT 1");console.log("Bun / SQLite OK", Bun.version, process.arch)'
dc run --rm --no-deps --entrypoint /usr/local/bin/mihomo hub -v
dc run --rm -T hub bun docker/custom/init.ts
dc up -d --wait --wait-timeout 90 --no-build
dc ps
curl --fail http://127.0.0.1:10100/healthz
curl --fail http://127.0.0.1:10100/readyz
```

初始化在私有卷内生成数据接口令牌，并在缺失时写入最小默认 `config.toml`（`features.multi_agent_v2=false`），不输出令牌。重复执行保留已有文件；不要手动删除令牌文件来升级。默认配置让新容器可以切换 base／v1；v2 仍需具备对应功能的 Codex CLI，不能仅靠模板启用。
如果上述自检出现 `Illegal instruction`、`Operation not permitted` 或进程无法启动，先保留错误输出，核对 CPU 指令集、内核与容器运行时；不要通过关闭证书校验、SELinux 或使用特权容器跳过问题。
两条健康检查成功表示进程及服务就绪，真实账号和模型还需下一节验证。
若启动失败，先检查 `dc logs --tail 100 hub`，不要通过删除数据卷尝试修复。

## 5. 打开管理页面并验证真实账号

保持下面的 PowerShell 窗口运行，建立本机到服务器的隧道：

```powershell
ssh -N -L 18101:127.0.0.1:10100 root@SERVER_IP
```

本机浏览器打开 `http://127.0.0.1:18101/`。首次登录需要管理令牌，在服务器自己的终端读取：

```bash
dc exec -T hub cat /home/bun/.opencodex/admin-api-token
```

将输出粘贴到管理页面，不要发到聊天或日志。模型客户端使用另一份数据接口令牌：

```bash
dc exec -T hub cat /home/bun/.opencodex/service-api-token
```

模型客户端基础 URL 为 `http://127.0.0.1:18101/v1`（使用该 SSH 隧道时）。管理令牌与模型访问令牌不可混用。

建议按此顺序测试：

1. 在“代理管理”添加国内 HTTP/SOCKS 代理，或导入高级节点；自建 VPS 必须先运行对应代理服务，只有 IP 地址不能转发。
2. 点击“检测出口”，确认出口 IP；再验证目标提供商连通性，检测成功不代表所有网站都接受这个 IP。
3. DSH 等需要指定地区的提供商，先给“提供商默认（含新登录）”设置代理，再新增账号；已有账号可以单独覆盖。
4. 多选账号，批量指定代理，验证账号、查询额度并发送一条真实模型请求。
5. 查看该代理的上传、下载和请求计数；核对账号绑定；短暂停用该代理时请求应报错，不能悄悄直连。
6. OAuth 如果跳转到无法访问的 localhost 回调，按页面提示粘贴完整重定向 URL 或授权码；不要共享这个链接。
7. 进入“邮箱通知”，配置 SMTP 和多个收件邮箱，保存后向每个已启用邮箱发送测试邮件，确认收件后启用通知总开关并保存。

SMTP 直接使用服务器的出网路径，通常需要放行到邮件服务器的 TCP 465 或 587。无需开放本机入站邮件端口。
通知读取已观察到的账号状态，不额外消耗模型请求或额度；成功通知持久去重，恢复后再次异常才再次提醒。
SMTP 授权码与通知记录随 `ocx-state` 数据卷保存，备份按凭据保管。日志只记录 SMTP 接收结果，不保证最终进入收件箱。

容器内的 `127.0.0.1` 指容器自己，不能填成 Windows 代理监听地址。商业代理填写供应商提供的可达地址。
如需访问宿主机代理，需要另外配置宿主机监听／防火墙及 Docker host-gateway；默认方案不扩大宿主机网络访问。

## 6. 内网服务器与 1 GB 轻量配置

内网 CentOS 7 使用 `.env.centos7.example`：2 GiB 内存上限、512 MiB 内存软预留、3 GiB 内存加 swap 上限、2 CPU。它们是可调的容器限额，不是系统的实际资源需求；请为同机其他服务预留余量。
下面是仍保留的 `.env.example` 轻量方案。

默认资源配置：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `OPENCODEX_MEMORY_LIMIT` | `640m` | 应用与 Mihomo 总内存上限 |
| `OPENCODEX_MEMORY_RESERVATION` | `384m` | 软限制，不是预分配或保证 |
| `OPENCODEX_MEMORY_SWAP_LIMIT` | `896m` | 内存加 swap 总额度，即最多额外 256 MiB swap |
| `OPENCODEX_CPUS` | `1.0` | CPU 时间上限 |
| `/tmp` tmpfs | `32m` | 计入内存占用 |
| Docker 日志 | `10m` × 3 | 防止容器日志持续占满磁盘 |

swap 额度不会创建宿主机 swap，主机必须已有可用 swap。实际容器限制以 `docker inspect` 为准。
首次初始化的 OpenAI 提供商并发为 1；新提供商应另外设置 `requestPacing.enabled=true`、`maxConcurrentRequests=1`。
这是每个提供商的限制，多提供商同时工作仍会叠加。升级不会用镜像初始配置覆盖已有卷内配置。
代理统计默认保留 90 天、每 15 秒落盘、出口检测并发 2；不需要 Redis 或数据库容器。

```bash
sudo docker stats --no-stream
free -h
sudo docker inspect "$(dc ps -q hub)" --format '{{.State.OOMKilled}} {{.RestartCount}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}'
dc logs --tail 100 hub
sudo docker system df
```

先用少量账号、小并发验证，再观察长响应、大上下文和流式请求。持续换页、延迟明显增长或 OOM 时，先降低负载再考虑扩容。
不要在这台机器上构建镜像，不要运行全局 `docker system prune --volumes`；清理镜像应明确指定已不用的版本。

## 7. 备份、恢复与更新

项目名固定为 `opencodex-custom`，两个数据卷分别是 `opencodex-custom_ocx-state` 与 `opencodex-custom_codex-state`。
前者包含应用配置、代理数据库、密码和统计；后者是独立 Codex 状态。不要合并两个目录，正常维护不要使用 `down -v`。

停服务后备份整个卷（包含 SQLite WAL），以下在服务器 Bash 执行。归档经标准输出写入宿主机，避免额外 SELinux 绑定目录配置：

```bash
umask 077
backup_dir="/opt/opencodex/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
dc stop
sudo docker run --rm --user 0 --entrypoint tar --mount type=volume,source=opencodex-custom_ocx-state,target=/state,readonly opencodex-custom:20261030-1 -C /state -czf - . > "$backup_dir/ocx-state.tar.gz"
sudo docker run --rm --user 0 --entrypoint tar --mount type=volume,source=opencodex-custom_codex-state,target=/state,readonly opencodex-custom:20261030-1 -C /state -czf - . > "$backup_dir/codex-state.tar.gz"
tar -tzf "$backup_dir/ocx-state.tar.gz" >/dev/null
tar -tzf "$backup_dir/codex-state.tar.gz" >/dev/null
cp .env "$backup_dir/deploy.env"
sudo docker image inspect opencodex-custom:20261030-1 --format '{{.Id}}' > "$backup_dir/image-id.txt"
dc start
```

逐条确认成功；归档失败时不要把空文件当备份。升级后备份命令的镜像标签改为当前版本。
备份含私密凭据，只保存在你控制的位置。在线复制单个 SQLite 主文件不构成完整备份。

恢复建议先使用新项目和**全新**卷，保留原卷以便回退。例如确认 `opencodex-restore_*` 两个卷不存在后：

```bash
sudo docker volume create opencodex-restore_ocx-state
sudo docker volume create opencodex-restore_codex-state
sudo docker run --rm -i --user 0 --entrypoint tar --mount type=volume,source=opencodex-restore_ocx-state,target=/state opencodex-custom:20261030-1 -C /state -xzpf - < "$backup_dir/ocx-state.tar.gz"
sudo docker run --rm -i --user 0 --entrypoint tar --mount type=volume,source=opencodex-restore_codex-state,target=/state opencodex-custom:20261030-1 -C /state -xzpf - < "$backup_dir/codex-state.tar.gz"
sudo docker compose --project-name opencodex-restore --env-file .env -f compose.yaml up -d --wait --no-build
```

恢复启动前先停旧实例释放端口，或在恢复专用 `.env` 中换端口。使用备份时对应的镜像版本，验证完成后再决定切换。

更新流程：在本机合并上游、测试、构建新的唯一标签和部署包 → 服务器备份状态 → 校验并导入新镜像 →
把现有 `.env` 复制到新版本目录并只更新镜像标签 → 从新目录使用**同一个项目名**运行 `dc up -d --wait --no-build`。
旧镜像和备份保留到验证通过。回滚先恢复旧镜像标签；若数据库格式发生变化，用匹配的备份恢复到新卷，不能强行降版本号。
不要在容器内执行 `ocx update`、npm 覆盖安装或修改镜像源码。上游原 `Dockerfile` 和 `compose.yaml` 未改，定制层单独维护。

## 8. 开发机重新构建、验收和打包

以下从仓库根目录运行，要求 Docker Desktop 使用 Linux 容器，或 Linux Docker Engine；Bun 为本仓库工具链版本。
源码新文件需纳入 Git 索引，兼容性清单以实际受版本管理的源码为准。生成器是清单的唯一写入方。

```bash
bun scripts/generate-compatibility-version.ts
docker compose -f deploy/compose.build.yaml build hub
bun scripts/custom/docker-smoke.ts opencodex-custom:20261030-1
bun scripts/custom/export-image.ts opencodex-custom:20261030-1
```

导出脚本要求镜像 ID 与成功验收记录相同；已有输出目录不会被覆盖。修改源码后使用新标签并重新验收。
可通过 `OPENCODEX_IMAGE` 环境变量指定构建标签；`compose.build.yaml` 仅用于 `build hub`，运行使用 `compose.yaml`。
验收使用随机独立项目和模拟凭据，清理自己的临时资源，不清理其他应用；导出采用流式 gzip，不把整个镜像读入内存。

Windows 本机预览已使用独立项目 `opencodex-preview`，地址 `http://127.0.0.1:18100/`。查看管理令牌：

```powershell
docker exec opencodex-preview-hub-1 cat /home/bun/.opencodex/admin-api-token
```

停止或重新启动预览（保留测试账号数据）：

```powershell
$env:OPENCODEX_PORT='18100'
docker compose --project-name opencodex-preview -f deploy/compose.yaml stop
docker compose --project-name opencodex-preview -f deploy/compose.yaml up -d --wait --no-build
```

## 9. 维护参考

- 源码与合并接入点：仓库根目录 `CUSTOMIZATION.md`、`structure/account-proxy-management.md`。
- 代理使用指南：`docs-site/src/content/docs/zh-cn/guides/account-proxies.md`。
- Docker 构建依赖：[Compose build specification](https://docs.docker.com/reference/compose-file/build/)。
- 内存、swap、日志配置：[Compose services specification](https://docs.docker.com/reference/compose-file/services/)。
- 内核版本与许可证：[Mihomo v1.19.33](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33)。

当前验证范围为定制模块、相关回归、浏览器复制操作和本机 Linux Docker 验收。完整上游测试套件规模较大，
本轮使用针对改动路径的测试；完整 CI、真实提供商端到端验证及目标 VPS 负载测试仍需在相应环境执行。

## 10. 内网 HTTP 记住设备

定制 Compose 部署可以设置 `OPENCODEX_HTTP_REMEMBER_ORIGIN=http://192.168.1.10:10100`，为一个指定的内网 IPv4 HTTP 地址启用记住设备。将示例替换为实际访问地址后重新创建容器。默认留空；公网 IP、域名、通配符和 URL 路径均不接受，端口和来源必须完全匹配。HTTP 会以未加密方式传输会话凭据，只应在可信内网启用；管理员令牌仍不保存在浏览器存储中。清空此选项并重建容器会禁止这些 HTTP 会话继续恢复；“忘记此设备”会撤销当前设备。
