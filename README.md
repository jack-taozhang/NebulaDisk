# NebulaDisk

自建网盘：**自研 FastAPI 后端 + kkFileView / OnlyOffice / cad-viewer 三种预览引擎**，
并做了完整的离线部署编排。配套的思源笔记插件见
[SiyuanDisk](https://github.com/jack-taozhang/SiyuanDisk)。

## 本仓库各部分

| 路径 | 内容 |
|---|---|
| `nebula/` | ★ **自研网盘后端**（FastAPI + SQLite）：登录/权限、挂载点、文件浏览、上传下载、在线编辑、分享、免签直链。详见 [nebula/README.md](nebula/README.md) |
| `nebula/web/` | 网盘前端（原生 JS，无构建步骤） |
| `deploy/` | 一体化编排：nebula + onlyoffice + cad-viewer，含诊断脚本 |
| `技术资料/` | 部署说明、工作日誌、长期笔记 |
| `Dockerfile` `docker-compose.yml` `build.sh` `config/` `nginx/` `demo/` | **kkFileView 5.0.2 的 Docker 构建与 iframe 嵌入**配置，说明见下方 |
| `src/` | kkFileView 上游源码，**未入库**（150MB）。需要时自行 clone，见下方「前置条件」 |

> 说明：`src/` 已在 `.gitignore` 中排除，因为它是 kkFileView 上游仓库的完整拷贝。
> 下方的 README 原文针对的是仓库根目录这套 kkFileView 构建配置。

---

# kkFileView 5.0.2 · Docker 构建与 iframe 嵌入

把 [kkFileView](https://github.com/kekingcn/kkFileView) 最新稳定版（**v5.0.2**，2026-08-14 发布）
打成 Docker 镜像，并针对「**业务系统用 iframe 嵌入预览页**」这一场景做好配置。

---

## 一、目录结构

```
.
├─ Dockerfile                      自包含多阶段构建（ubuntu:24.04 + JRE + LibreOffice）
├─ docker-compose.yml              编排（含可选的 nginx 同源反代）
├─ .env                            所有可调部署参数
├─ build.sh                        一键构建脚本
├─ docker/
│  ├─ maven/settings.xml           构建加速（central → 阿里云）
│  └─ healthcheck.sh               容器健康检查（不依赖 curl）
├─ nginx/kkfileview.conf           同源反向代理配置 ← iframe 场景的关键
├─ demo/iframe-preview.html        iframe 嵌入验证页
├─ config/application.properties   官方配置完整副本（按需挂载）
└─ src/                            kkFileView v5.0.2 源码
```

---

## 二、前置条件

| 项 | 要求 |
|---|---|
| Docker | 20.10+，支持 compose v2（`docker compose`） |
| 磁盘 | ≥ 5 GB（LibreOffice 较大） |
| 内存 | 建议 ≥ 4 GB 给容器 |
| 构建网络 | 需能访问 apt 源（默认走阿里云）与 Maven 仓库 |

> 本机 Docker 装在 WSL 里，所以**构建要在 WSL 终端内执行**，不能在 Windows 侧直接跑。

### 本机环境的两个坑（已在脚本里处理）

**1. 容器 DNS 不可用。** WSL2 自动生成的 `/etc/resolv.conf` 指向 `10.255.255.254`，
该 DNS 代理在 docker bridge 网段不可达，任何容器里都会报
`Temporary failure resolving`。后果是 apt / Maven 全下载不了。
脚本与 compose 统一加了 `--network=host` 绕过。
（治本方案：给 `/etc/docker/daemon.json` 加 `"dns": ["223.5.5.5","119.29.29.29"]`
后重启 Docker，但会重启所有容器，故未擅自改动。）

**2. Docker Hub 直连不通。** `registry-1.docker.io` 超时。daemon 已配了 4 个国内
镜像源（1ms.run / daocloud / 1panel / rat.dev），`library/*` 与 `keking/kkfileview`
都能拉。

> 注意：**官方基础镜像 `keking/kkfileview-base` 在所有可达镜像站都取不到**
> （1ms.run、rat.dev 报 not found，daocloud、xuanyuan、1panel 报 403）。
> 因此本项目**不依赖它**，改为用 `ubuntu:24.04` 自行构建等价运行时层，
> 镜像完全自包含、可复现。

---

## 三、构建与启动

```bash
# 1) 进入 WSL
wsl -d <你的发行版>

# 2) 到项目目录（Windows 的 D:\Docker\kkFileView）
cd /mnt/d/Docker/kkFileView

# 3) 构建并启动
./build.sh --up
```

常用变体：

```bash
./build.sh                     # 只构建，不起容器
./build.sh --only-base         # 只构建运行时基础层，快速自检（不跑 Maven）
./build.sh --no-cache          # 全量重建（依赖或源码有诡异问题时用）
./build.sh --arch arm64        # 构建 arm64 镜像
./build.sh --sync v5.0.2       # 先按 tag 同步源码再构建
./build.sh --apt-mirror ""     # 不用 apt 加速源
```

构建完成后：

| 地址 | 说明 |
|---|---|
| http://localhost:8012/ | 预览服务首页 |
| http://localhost:8012/actuator/health | 健康检查 |

带同源反代 + 演示页：

```bash
docker compose --profile proxy up -d
# → http://localhost:8090/            演示页（验证 iframe 嵌入）
# → http://localhost:8090/kkfileview/ 预览服务（挂在子路径下）
```

> ⚠️ 反代默认端口是 **8090**，不是 8080 —— 本机 8080 已被 `maple-cloud` 占用。
> 改端口在 `.env` 的 `NGINX_HOST_PORT`，改完 `docker compose --profile proxy up -d`。

---

## 四、iframe 嵌入怎么做

先说结论：**kkFileView 自身全程不发送 `X-Frame-Options`，也不发 CSP `frame-ancestors`**
（已核对 5.0.2 源码，全仓库无相关代码）。所以「能不能嵌」不取决于 kkFileView，
而取决于**部署链路**。

### 4.1 预览地址的拼法

```
{服务地址}/onlinePreview?url={URLEncode(Base64(文件地址))}
```

`url` 参数是**双重编码**：先标准 Base64，再 `encodeURIComponent`。少了 Base64 会直接报
「Base64解码失败，请检查你的 url 是否采用 Base64 + urlEncode 双重编码了」。

```js
function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);   // 必须按 UTF-8 取字节，否则中文路径出错
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

const previewSrc = '/kkfileview/onlinePreview?url='
                 + encodeURIComponent(b64utf8('https://你的文件服务器/报告.docx'));
```

```html
<iframe src="/kkfileview/onlinePreview?url=..." allowfullscreen></iframe>
```

> 不要给 iframe 加 `sandbox` 属性——会连带屏蔽 PDF 打印、下载等能力。

### 4.2 两种部署方式

**方式 A：直连（跨源嵌入）**

业务系统在 `https://app.example.com`，kkFileView 在 `http://10.0.0.5:8012`，
iframe 直接引 `http://10.0.0.5:8012/onlinePreview?...`。

能跑，但有三个麻烦：

1. **混合内容**：业务系统是 HTTPS 时，浏览器会拦掉 HTTP 的 iframe，iframe 区域直接空白。
2. **资源地址错乱**：预览页内部资源用 `baseUrl` 拼绝对地址，跨源时容易拼成内网地址。
3. **Cookie 策略**：跨站 iframe 下 `SameSite=Lax` 的 Cookie 不会发送，有鉴权时不生效。

所以直连只适合内网、纯 HTTP、无鉴权的场景。

**方式 B：同源反代（推荐）**

用 nginx 把 kkFileView 挂到业务系统同一个 origin 的子路径下，上面三个问题一次性消失。
配置见 [`nginx/kkfileview.conf`](nginx/kkfileview.conf)，核心就两行：

```nginx
location /kkfileview/ {
    proxy_pass http://kkfileview:8012/;                    # 末尾 / 剥掉前缀
    proxy_set_header X-Base-Url $scheme://$host/kkfileview; # ★ 必须
}
```

第二行是关键。kkFileView 的 `BaseUrlFilter` 会**优先读 `X-Base-Url` 请求头**来生成页面内的
资源地址；不传的话，反代场景下它会用内网主机名/端口去拼，浏览器访问不到，症状就是
**iframe 里一直转圈或白屏**。

源码依据（`WebUtils` / `BaseUrlFilter`）：

```java
// BaseUrlFilter.doFilter()
final String urlInHeader = servletRequest.getHeader("X-Base-Url");   // 优先级最高
if (StringUtils.isNotEmpty(urlInHeader)) { baseUrl = urlInHeader; }
```

如果不用 `X-Base-Url`，也可以直接写死配置：`.env` 里设
`KK_BASE_URL=https://app.example.com/kkfileview`（末尾不带 `/`）。

### 4.3 ⚠️ 反代必须用 `$http_host`，不能用 `$host`（**实测踩到的坑**）

nginx 里这两个变量**行为不同**：

| 变量 | 含义 | 示例 |
|---|---|---|
| `$host` | 只含主机名，**不含端口** | `127.0.0.1` |
| `$http_host` | 客户端原始 `Host` 头，**含端口** | `127.0.0.1:8090` |

对外端口不是 80/443 时，用 `$host` 拼 `X-Base-Url` 会得到
`http://127.0.0.1/kkfileview/` —— **端口丢了**。浏览器会去请求 80 端口，
结果就是 **iframe 白屏/转圈**，而服务端日志一切正常，极难排查。

```nginx
# ✗ 错误：非标准端口下会丢端口
proxy_set_header X-Base-Url $scheme://$host/kkfileview;

# ✓ 正确
proxy_set_header X-Base-Url $scheme://$http_host/kkfileview;
```

实测对比（对外端口 8090）：

```
用 $host      → baseUrl = 'http://127.0.0.1/kkfileview/'        ← 白屏
用 $http_host → baseUrl = 'http://127.0.0.1:8090/kkfileview/'   ← 正常
```

自检方法（把响应里 `baseUrl` 拎出来看一眼即可）：

```bash
curl -s "http://127.0.0.1:8090/kkfileview/onlinePreview?url=<base64>" \
  | grep -oE "baseUrl = '[^']*'"
```

> 本项目的 `nginx/kkfileview.conf` 已使用 `$http_host`。
> 另外若 nginx 前面还有一层网关（如公司统一入口），要确保它**透传原始 Host**
> （`proxy_set_header Host $http_host;`），否则外层的端口同样会丢。

### 4.4 ⚠️ 别在网关/反代上加这些响应头
```nginx
# 下面任意一条都会让 iframe 嵌入被浏览器拒绝（refused to connect）
add_header X-Frame-Options DENY;
add_header X-Frame-Options SAMEORIGIN;
add_header Content-Security-Policy "frame-ancestors 'self'";
```

这是最常见的「明明服务是好的，iframe 就是打不开」的原因。排查时看浏览器 Network 里
预览页请求的响应头即可。

---

## 五、iframe 场景必配的两个参数

这两个都在 `.env` 里，**不改的话大概率预览不了**。

### `KK_TRUST_HOST` — 文件来源白名单（防 SSRF）

4.4.0 起默认**拒绝所有外部文件**。不配白名单，预览任何远程文件都会提示「不信任的文件源」。

```ini
# 生产环境务必收窄到自己的文件服务器
KK_TRUST_HOST=oss.aliyuncs.com,cdn.example.com,*.internal.example.com

# 黑名单优先级更高，建议顺手封掉内网段
KK_NOT_TRUST_HOST=localhost,127.0.0.1,192.168.*,10.*,172.16.*
```

> `.env` 里默认给的 `KK_TRUST_HOST=*` 是**匿名放行所有外部地址**，只适合联调，
> 上线前必须换掉。

### `KK_BASE_URL` — 对外基地址

```ini
KK_BASE_URL=default                              # 直连，按请求头自动拼
KK_BASE_URL=https://app.example.com/kkfileview   # 反代/HTTPS 场景
```

---

## 六、常用配置速查

改 `.env` 后 `docker compose up -d` 生效。

| 变量 | 默认 | 说明 |
|---|---|---|
| `KK_HOST_PORT` | 8012 | 宿主机端口 |
| `KK_CONTEXT_PATH` | `/` | 应用上下文路径，挂子路径时改 |
| `KK_BASE_URL` | `default` | 对外基地址，反代必配 |
| `KK_TRUST_HOST` | `*` | 文件来源白名单，**上线前必须收窄** |
| `KK_NOT_TRUST_HOST` | 空 | 黑名单，优先级更高 |
| `KK_OFFICE_PREVIEW_TYPE` | `pdf` | `pdf`（推荐）或 `image` |
| `KK_OFFICE_QUALITY` | 80 | 转换图片质量 1–100 |
| `KK_CACHE_TYPE` | `jdk` | `jdk` 单机内存 / `default` RocksDB / `redis` |
| `KK_JAVA_OPTS` | `-XX:MaxRAMPercentage=50.0` | JVM 参数 |
| `KK_MEMORY_LIMIT` | `4g` | 容器内存上限 |
| `WATERMARK_TXT` | 空 | 水印文字，留空不加水印 |
| `KK_DELETE_PASSWORD` | `false` | 删除接口，默认关闭 |

**没有环境变量的配置项**（如 `kk.Getcorsfile`、`file.upload.disable`、`kk.scriptjs`、
`pdf.print.disable`、`office.preview.switch.disabled`）需要挂载配置文件：

```yaml
# docker-compose.yml 中打开注释
- ./config/application.properties:/opt/kkFileView-5.0.2/config/application.properties:ro
```

---

## 七、常见问题

### 构建阶段

**`docker build` 报 `Temporary failure resolving 'mirrors.aliyun.com'`**

容器 DNS 不可用（见第二节「本机环境的两个坑」）。加 `--network=host`：

```bash
docker build --network=host -t kkfileview:5.0.2 .
# 或直接用脚本，它已默认带上
./build.sh
```

**想给所有容器彻底修好 DNS**

编辑 `/etc/docker/daemon.json`（WSL 内），加上 DNS 后重启 Docker：

```json
{
  "registry-mirrors": ["https://docker.1ms.run", "https://docker.m.daocloud.io",
                       "https://docker.1panel.live", "https://hub.rat.dev"],
  "dns": ["223.5.5.5", "119.29.29.29"]
}
```

```bash
sudo systemctl restart docker
```

⚠️ 这会重启**所有**容器（n8n、onlyoffice 等都会中断），所以构建套件没有擅自改它。

**Maven 阶段卡在下载依赖**

首次构建要拉 500MB+ 依赖。如果 aspose 私服（`repository.aspose.com`）慢，
可以改用已编译好的发行包方案：下载官方 `kkFileView-5.0.2.tar.gz`，
把 Dockerfile 的 builder 阶段换成 `COPY` 该 tar.gz。

**`ttf-wqy-microhei` / `ttf-wqy-zenhei` 找不到**

上游 Dockerfile 用的是这两个旧包名，在 Ubuntu 24.04 上已改名为
`fonts-wqy-microhei` / `fonts-wqy-zenhei`。本项目的 Dockerfile 已修正。

**拉不到 `keking/kkfileview-base`**

本来就不需要它了。该镜像在常用国内镜像站均取不到，本项目改用 `ubuntu:24.04`
自建等价运行时层。

**`mvn package` 报 `Could not find artifact javax.media:jai_core:jar:1.1.3`**

```
Could not find artifact javax.media:jai_core:jar:1.1.3
  at specified path /build/server/lib/jai_core-1.1.3.jar
```

`server/lib/jai_core-1.1.3.jar` 与 `jai_codec-1.1.3.jar` 是 pom 里的
**system scope 依赖**（`<scope>system</scope>` + `<systemPath>${pom.basedir}/lib/...`），
Maven **不走仓库、只按文件路径找**。所以它们必须随源码一起 COPY 进构建上下文：

```dockerfile
COPY src/server/lib ./server/lib
```

报错措辞是 "Could not **find artifact**"，很容易误判成私服/网络问题，
实际是本地文件没进上下文。本项目的 Dockerfile 已包含这一行。

### 运行阶段

**iframe 一片空白 / 转圈**

按顺序查：
1. 浏览器 Network → 预览页请求的状态码与响应头，有没有 `X-Frame-Options`；
2. 反代有没有传 `X-Base-Url`（或配 `KK_BASE_URL`）；
3. HTTPS 页面套 HTTP iframe 会被拦，控制台有 mixed content 报错；
4. 看 `data/logs/` 下日志。

**提示「不信任的文件源」**

`KK_TRUST_HOST` 没配或没匹配上。注意白名单是**完全匹配**，`*.example.com` 不匹配根域
`example.com`。

**预览一直卡在「转换中」**

多半是内存不够。Office 转换由 LibreOffice 子进程完成，不吃 JVM 堆，所以
`KK_JAVA_OPTS` 里的 `MaxRAMPercentage` 别调太高，同时把 `KK_MEMORY_LIMIT` 提上去。
也可以看 `docker logs kkfileview`。

**启动日志里刷 `Office process died with exit code 81 / 134`**

这是 **LibreOffice 多实例并行冷启动互相抢占**导致的，属配置问题，本套件已默认修好。

原因：官方配置 `office.plugin.server.ports = 2001,2002` 要求**同时起 2 个** soffice 进程。
容器内两个实例并行初始化时会互相踩到（`81` = 启动即失败，`134` = SIGABRT），
典型日志：

```
10:45:05.843  Starting process with --accept '...port=2002...'
10:45:05.843  Starting process with --accept '...port=2001...'   ← 同时启动
10:45:06.408  Office process died with exit code 81; restarting it   ← 两个都挂
10:45:07.705  Connected: '...port=2001...'                       ← 重试后 2001 活了
              （2002 重试仍失败 → 抛 OfficeException，该实例彻底废掉）
```

后果不只是日志难看：**并发容量反而从 2 降到 1**，而且 `134` 崩溃会留下 core dump。

修法（本套件已内置）：

```ini
# .env —— 单机只留 1 个实例
KK_OFFICE_PORTS=2001

# .env —— /dev/shm 默认仅 64MB，是 SIGABRT 的主要诱因
KK_SHM_SIZE=2gb
```

需要真并发时再逐个增加端口（如 `2001,2002,2003`），并**同步加大** `KK_SHM_SIZE`
与 `KK_MEMORY_LIMIT`，否则会把问题放大。

**容器根目录冒出 `core.<pid>` 大文件**

soffice 被 SIGABRT 杀掉时，因为 `ulimit -c` 默认 `unlimited`、`core_pattern=core`，
会在工作目录写下几百 MB 的 core 文件，直接吃掉 `data/` 卷空间。
本套件的 Dockerfile 已在 `final` 阶段写死 `limits.conf`，并在 `ENTRYPOINT` 里
`ulimit -c 0` 兜底（`limits.conf` 对已运行的 PID 1 不生效，两层都要有）。
清理遗留文件：

```bash
docker exec kkfileview sh -c 'rm -f /opt/kkFileView-5.0.2/core.*'
```

**中文显示成方块**

运行时层已装 `fonts-wqy-microhei`、`fonts-wqy-zenhei`、`fonts-noto-cjk`，正常不该出现。
若仍有问题，把字体文件加进 Dockerfile 的 `runtime-base` 阶段后重建。

**PDF 里 Arial / Times New Roman 版式有细微差异**

运行时层没装 `ttf-mscorefonts-installer`（它需联网从 SourceForge 下载并接受 EULA，
网络不通会中断构建），改用度量兼容的 `fonts-liberation2` + `fonts-crosextra-carlito`。
如确实需要微软原字体，在 Dockerfile 的 apt 步骤后追加安装即可。

**`docker compose up` 报镜像拉不下来**

Docker Hub 直连不通。daemon 的 `registry-mirrors` 已配好，确认那几个镜像站还活着；
必要时替换 `.env` 里的基础镜像名。

---

## 八、升级版本

以升到 v5.0.3 为例：

```bash
# 1) 同步新版本源码
./build.sh --sync v5.0.3        # 只同步源码，不构建

# 2) 改 Dockerfile 里 ENTRYPOINT 的硬编码路径：
#    把两处 /opt/kkFileView-5.0.2/ 与 .../kkFileView-5.0.2.jar 的版本号改成新版本，
#    同时改 ARG KK_VERSION 的默认值。
#    （exec form 的 ENTRYPOINT 不展开变量，只能写死；
#      Dockerfile 有版本自检，漏改会在构建时直接报错，不会产出坏镜像）

# 3) 改 .env 里的 KK_VERSION / KK_IMAGE，以及 docker-compose.yml 的默认值

# 4) 重建
./build.sh --up
```

挂载了 `config/application.properties` 的话，记得把新版本源码
`src/server/src/main/config/application.properties` 重新覆盖一份过来，
否则会丢掉新版本新增的配置项。

---

## 九、安全提醒

- `KK_TRUST_HOST=*` **仅限联调**，上线前换成明确白名单；配合 `KK_NOT_TRUST_HOST` 封内网段。
- 删除接口默认关闭。要开就设独立强密码，且调用方必须改成 `POST /deleteFile`。
- 5.0.2 起预览 HTML 文件默认在不可信沙箱 iframe 中渲染且禁用 JS（`kk.scriptjs=false`）。
  非必要不要打开。
- 预览产物落在 `./data/file/`，默认每天 03:00 清理。磁盘紧张时调小 `KK_CACHE_CLEAN_CRON`
  的间隔，或挂到独立分区。
