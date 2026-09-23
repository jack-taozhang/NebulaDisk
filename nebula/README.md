# NebulaDisk 部署指南

仿 Windows 界面的云盘，与 kkFileView 合并为**单个镜像**，Office 文件调用独立部署的
OnlyOffice 官方镜像进行在线编辑。

---

## 1. 它是什么

一个容器里跑两个进程（由 supervisord 管理）：

| 进程 | 端口 | 职责 |
|---|---|---|
| kkFileView | 8012 | 非 Office 文件预览（PDF、图片、视频、压缩包、CAD、代码等） |
| NebulaDisk | 8088 | 仿 Windows 云盘界面、目录映射、多用户鉴权、文件管理 |

**OnlyOffice 不在这个镜像里**，它作为独立容器运行。原因见
「[为什么 OnlyOffice 不合并进来](#4-为什么-onlyoffice-不合并进来)」。

### 双击一个文件之后会发生什么

```
用户在界面里双击 xxx.docx
        │
        ▼
  NebulaDisk 判断扩展名
        │
        ├── Office 类型（docx/xlsx/pptx…）─────────► OnlyOffice 编辑器
        │                                             └─ OnlyOffice 服务端反拉
        │                                                /api/raw/<文件名>?…&sig=…
        │                                                  （主机名必须是容器名，见 §3.3）
        │
        ├── 浏览器原生类型（图片/视频/音频/文本）───► 前端直接渲染（零延迟，不走转换）
        │
        └── 其它（PDF/CAD/压缩包/代码…）───────────► kkFileView 转换预览
                                                      └─ 云盘把预览页反代到同源
```

「同源反代」是刻意设计的：kkFileView 的预览页由云盘在 `/preview/...` 下转发，
浏览器看到的是同一个 origin，从而彻底绕开 iframe 的跨域 / 第三方 Cookie 问题。

---

## 2. 前置条件

1. **Docker 与 Docker Compose**（NAS 上通常已装）
2. **基础镜像 `kkfileview:5.0.2`** 必须已在本地存在
   ```bash
   docker images kkfileview
   # 没有的话，先在仓库根目录执行 ./build.sh
   ```
3. **OnlyOffice 容器已在运行**
   ```bash
   docker ps | grep onlyoffice
   ```
4. 记下 OnlyOffice 的**三样东西**（下面要用）：
   ```bash
   # ① 所在网络名
   docker inspect <onlyoffice容器名> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
   # ② JWT 密钥
   docker inspect <onlyoffice容器名> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep JWT_SECRET
   # ③ 对外地址（NAS 的 IP + OnlyOffice 映射端口）
   ```

---

## 3. 部署步骤

### 3.1 准备配置

```bash
cd nebula
cp .env.example .env
```

编辑 `.env`，**必改的三处**：

```ini
# ① 你的真实目录（宿主机路径）
NB_SHARE_DIR=/volume1/共享
NB_PHOTOS_DIR=/volume2/照片
NB_PRIVATE_DIR=/volume1/私密

# ② OnlyOffice 浏览器地址 —— 必须填 NAS 的真实 IP 或域名
NB_OO_PUBLIC=http://192.168.1.10:8082

# ③ OnlyOffice 的 JWT 密钥 —— 必须与容器里的完全一致
NB_OO_SECRET=你的密钥
```

### 3.2 声明目录映射

`.env` 里的 `NEBULA_MOUNTS` 决定界面上看到几个盘、谁能看：

```ini
# 格式：显示名|容器内路径|可见用户
#   * = 所有登录用户可见；多个用户用逗号分隔；用 ; 分隔多条
NEBULA_MOUNTS=共享|/mnt/share|*;照片|/mnt/photos|*;私密|/mnt/private|admin
```

⚠️ **容器内路径必须与 compose 里 `volumes` 右侧完全一致**。改了一边忘了另一边，
启动日志会明确提示哪个路径不存在。

格式的两个要点：

- **分隔符是 `|` 不是 `:`**。因为冒号在 Windows 路径（`E:\data`）里天然存在，
  用它做分隔符会导致解析歧义。
- 第三条（可见用户）可省略，省略等同 `*`。

### 3.3 构建并启动

```bash
./build.sh --up
```

或者分两步：

```bash
./build.sh              # 只构建
docker compose up -d    # 再启动
```

### 3.4 拿到管理员密码

```bash
docker logs nebula 2>&1 | grep -A2 '管理员'
```

如果 `.env` 里设了 `NB_ADMIN_PASSWORD`，就按那个登录，不用查日志。

### 3.5 打开界面

浏览器访问：

```
http://<NAS_IP>:8089
```

---

## 4. 为什么 OnlyOffice 不合并进来

你最初的需求是「与 kkFileView 合并为一个镜像」。kkFileView 合并了，
**OnlyOffice 没有** —— 这是刻意的技术决定，原因有三：

1. **体积**：官方 `onlyoffice/documentserver` 是 **6.83 GB**，内含 PostgreSQL、
   RabbitMQ、Nginx、Node.js、.NET 一整套。合并后镜像会到 8 GB+。
2. **端口冲突**：它自带 Nginx 占 80 端口，和容器内已有的服务需要额外协调。
3. **架构冲突**：它是一个自成体系的「文档服务器」，官方定位就是**独立部署、
   多客户端共享**。硬塞进另一个镜像既没有收益，也脱离了官方的支持路径。

**实际做法**：两者通过 docker 网络互通，效果与合并到一个镜像完全相同，
用户感知不到差别。

```
┌──────────────────────┐         ┌──────────────────────────┐
│   nebula 容器         │         │  maple-onlyoffice 容器    │
│  ┌────────────────┐  │         │                          │
│  │ NebulaDisk     │  │  ①签名URL │  OnlyOffice              │
│  │   :8088        │──┼────────►│   Documentserver         │
│  └────────────────┘  │         │      :80 (宿主 8082)      │
│  ┌────────────────┐  │  ②反拉文档 │                          │
│  │ kkFileView     │◄─┼─────────│                          │
│  │   :8012        │  │         │                          │
│  └────────────────┘  │         └──────────────────────────┘
└──────────────────────┘
        ▲                                   ▲
        │                                   │
   浏览器 :8089                      浏览器加载 api.js
```

### 关键：OnlyOffice 必须能「反方向」访问到云盘

这是最容易踩的坑。OnlyOffice **不是**把文档推给浏览器，而是：

1. 浏览器把文档地址交给 OnlyOffice
2. **OnlyOffice 服务端**自己去 GET 那个地址

所以文档 URL 的**主机名必须从 OnlyOffice 容器内部可达**。这带来两个约束：

- 地址里**不能**用 `127.0.0.1`（那是 OnlyOffice 自己），要用服务名或容器 IP
- **不能**依赖用户会话 Cookie（OnlyOffice 带不了），所以云盘提供的是
  **HMAC 签名的短期直链** `/api/raw/<文件名>?mount=..&path=..&exp=..&sig=..`
  —— 单个链接只对一个文件有效，且会过期

> **为什么文件名必须出现在 URL 路径里？**
> kkFileView 判文件类型靠「取 url 字符串里最后一个 `.` 之后的内容」。
> 如果只写 `/api/raw?mount=..&exp=1789882982&sig=..`，它命中的是 `exp`
> 里的小数点，截出非法区间后抛 `StringIndexOutOfBoundsException`，
> 前端只看到「系统还不支持该格式文件的在线预览」，极难排查。
> 把文件名放进路径（`/api/raw/readme.md?...`）后后缀解析才正常。
> 文件名只用于取后缀，鉴权始终靠签名。

### 3.3 三个地址变量，别填混

| 变量 | 谁用它 | 填什么 | 填错的表现 |
|---|---|---|---|
| `NB_OO_URL` | 云盘服务端 → OnlyOffice | 容器间地址，如 `http://maple-onlyoffice` | 云盘里 OnlyOffice 健康检查失败 |
| `NB_OO_PUBLIC` | 浏览器 → OnlyOffice | NAS 真实 IP/域名，如 `http://192.168.1.10:8082` | 编辑器白屏、api.js 404 |
| `NB_BASE_URL` | **OnlyOffice 容器 → 云盘** | 容器名 + **容器端口**，如 `http://nebula:8088` | 编辑器一直转圈 / 提示下载文件失败 |

`NB_BASE_URL` 最容易填错，因为它是「反向」的 —— 前面两个填宿主机视角的地址，
这个必须填**容器视角**的地址，而且端口是 8088（容器端口），不是 8089（宿主机映射端口）。
默认值已经是 `http://nebula:8088`，只要 compose 服务名不改就不用动。

日志里能看到线索：
- `[main] ⚠️ NEBULA_BASE_URL 未配置` → 回退到了 `127.0.0.1:8088`，OnlyOffice 打不开文件
- `[onlyoffice] 写回失败: All connection attempts failed` → 保存时拉不到 OnlyOffice 给的临时地址

---

## 5. 多用户

### 5.1 用户从哪来

首次启动会自动创建管理员（`NEBULA_ADMIN_USER`）。
界面里的「用户管理」可以新建用户、改密码。

### 5.2 目录级权限

每个映射的第三条决定谁能看到：

```ini
NEBULA_MOUNTS=公共|/mnt/public|*;财务|/mnt/finance|alice,bob;我的|/mnt/private|admin
```

- 用户在界面上**只会看到自己有权限的盘**，没权限的压根不出现
- 直接构造 API 请求访问无权目录，返回 **404 而不是 403**
  —— 403 等于告诉对方「这个目录存在」，404 不会泄露任何信息

### 5.3 每个用户独立的目录

如果想让每个人有独立空间，最直观的做法是每人在宿主机上建一个目录，
各自映射：

```ini
NEBULA_MOUNTS=alice|/mnt/alice|alice;bob|/mnt/bob|bob
```

---

## 6. 日常运维

```bash
./build.sh --logs      # 跟踪日志
./build.sh --smoke     # 冒烟测试（首页/健康/鉴权/kkFileView）
./build.sh --down      # 停止并移除容器
./build.sh --up        # 重新构建并启动
```

### 状态怎么看

容器内两个进程，日志前缀区分：

```
INFO:     ... uvicorn          ← 云盘
[nebula]  ...                  ← 云盘启动信息 / 进程退出告警
... kkFileView ...             ← kkFileView
```

启动时会打印每个映射的检查结果：

```
[nebula-entrypoint] ✓ 映射 共享 -> /mnt/share  可见: *
[nebula-entrypoint] ✗ 映射路径不存在：/mnt/foo（显示名 测试）
```

### 健康检查

```bash
curl http://127.0.0.1:8089/healthz
# {"ok":true,"mounts":3,"onlyoffice":true}
```

---

## 7. 常见问题

### 编辑器能打开，但正文报「打开文件时发生错误」

**判读方法**：编辑器**外壳**（工具栏、页码、缩放）渲染出来了，说明配置与
JWT 都是通的；只有**正文**失败 ⇒ 一定是「OnlyOffice 服务端去 GET 文档」这一步黄了。
所以只需查两件事：**网络能不能互通**、**地址填得对不对**。

用 `dist/nebula-1.0.0/diagnose-oo.sh` 一键把证据摊开：

```bash
bash diagnose-oo.sh
```

按频率排序的根因：

| 现象 | 根因 | 修复 |
|---|---|---|
| OnlyOffice 容器内 `getent hosts nebula` 无输出 / 取流超时 | **两个容器不在同一 docker 网络** | `.env` 里 `NB_OO_NETWORK` 改成 OnlyOffice 所在网络名（`docker network ls` 看真名），`docker compose up -d` |
| 返回 403 / 422 | 网络通了，签名被拒 | 查 `NEBULA_JWT_SECRET`、是否有多实例 |
| converter 日志有 `It is private IP address` | `NB_BASE_URL` 用了 **IP 字面量**，而 OnlyOffice 默认拒绝私有 IP | 改用主机名；或放开 `request-filtering-agent.allowPrivateIPAddress` |

⚠️ `NB_OO_NETWORK` 若保持 ``.env.example`` 的默认值（一个占位空网络），
OnlyOffice 解析不了 `nebula` **就是必然的**。容器名解析不出来时，
`NB_BASE_URL` 填得再对也没用。

### 界面能打开，但 Office 文件点开白屏

按顺序排查：

1. `NB_OO_PUBLIC` 是否为**浏览器可达**的地址？
   在浏览器里直接打开 `http://<NB_OO_PUBLIC>/web-apps/apps/api/documents/api.js`
   —— 能下载到 JS 才说明配对了。
2. `NB_OO_SECRET` 是否与 OnlyOffice 容器**完全一致**？
   ```bash
   docker inspect maple-onlyoffice --format '{{range .Config.Env}}{{println .}}{{end}}' | grep JWT_SECRET
   ```
3. 云盘与 OnlyOffice 是否在同一网络？
   ```bash
   docker exec nebula curl -s -o /dev/null -w '%{http_code}\n' http://maple-onlyoffice/healthcheck
   ```
   期望 `200`。

### 非 Office 文件（PDF/CAD 等）预览 403

kkFileView 4.4+ 有 SSRF 白名单。默认已在 compose 里设为 `KK_TRUST_HOST=*`；
若你改过，确认它允许云盘自己（容器内 `127.0.0.1`）。

### 中文文本文件预览乱码

界面对文本会先按 UTF-8 严格解码，失败则依次回退 GBK / GB18030 / Big5 / UTF-16LE。
若仍乱码，说明是其它编码，可反馈具体文件。

### 上传大文件失败

默认上限 2 GB（`NB_MAX_UPLOAD_MB`）。调大它，同时确认宿主机的
`client_max_body_size`（走了 nginx 的话）与磁盘空间。

### 重启后所有人都要重新登录

说明会话密钥没落在持久卷上。检查 `NB_DATA_DIR` 是否真的挂到了宿主机目录
（`docker inspect nebula | grep -A5 Mounts`）。
密钥文件是 `/var/lib/nebula/secret.key`。

### 删除了 kkFileView 的产物目录后，预览变白屏

kkFileView 依据产物文件名做**内存缓存**判定，删文件但缓存还记着「已转换」，
于是跳过转换直接返回页面 → 引用的 PDF 不存在 → 白屏。
**正确做法**：删产物后必须重启容器（`docker restart nebula`）。

---

## 8. NAS 适配要点

| NAS | 典型路径 | 备注 |
|---|---|---|
| 群晖 Synology | `/volume1/xxx` | 常用 |
| 威联通 QNAP | `/share/xxx` | 注意 `/share/CACHEDEV1_DATA` |
| 绿联 / Ugreen | `/mnt/xxx` | |
| 极空间 | `/sata/xxx` | |

**权限**：容器内以 root 运行，但宿主机目录如果本身限制严格，
仍可能读写失败。用 `docker exec nebula touch /mnt/share/.wtest` 验证写权限。

**内存**：kkFileView 会用 LibreOffice 做转换，比较吃内存。
`NB_MEMORY_LIMIT` 建议不低于 `4g`；NAS 内存紧张时，
调小 `NB_JAVA_OPTS` 的 `MaxRAMPercentage`，并接受转换变慢。

**/dev/shm**：转换大文件需要它。compose 里已设 `shm_size: 2gb`，
不改的话 soffice 会被 SIGABRT 杀掉（日志里是 `exit code 134`）。

---

## 9. 目录结构

```
nebula/
├── app/                    后端（FastAPI）
│   ├── main.py             路由、反代、OnlyOffice 回调
│   ├── config.py           配置 + 映射解析（| 分隔）
│   ├── auth.py             会话 JWT（HS256）
│   ├── users.py            SQLite 用户库
│   ├── files.py            路径安全层（★ 安全关键）
│   └── integrations.py     OnlyOffice / kkFileView 对接
├── web/                    前端（原生 HTML/CSS/JS，无构建步骤）
│   ├── index.html
│   ├── css/app.css         Win11 视觉语言
│   └── js/
│       ├── shell.js        窗口管理器 / 右键菜单 / 弹窗
│       ├── explorer.js     文件管理器
│       ├── viewer.js       预览路由（4 种引擎）
│       ├── icons.js        Fluent 图标 + Windows 式文件图标
│       ├── api.js          API 客户端
│       └── app.js          启动引导
├── deploy/                 容器内编排
│   ├── supervisord.conf    双进程管理
│   ├── nebula-entrypoint.sh 启动前配置检查
│   └── supervisor-exitmon.py 进程退出告警
├── tools/                  测试工具（不进镜像）
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── build.sh
```

---

## 10. 自检与测试（改动后请全跑）

```bash
# ① 后端静态检查（不需要 docker）——**必跑**，见下方说明
bash nebula/tools/run_static_checks.sh

# ② 前端单元测试（8 套 JS，316 条断言）
bash nebula/tools/run_unit_tests.sh

# ③ 分享功能集成测试（48 条，纯 Python，用临时 sqlite）
bash nebula/tools/run_share_tests.sh

# ④ 对**运行中**镜像的活体冒烟（纯 curl）
bash nebula/tools/_share_e2e.sh

# ⑤ 真浏览器探针（需要 agent-browser；点工具栏/热区要能前置窗口）
bash nebula/tools/_tf_run.sh
```

### 为什么「① 静态检查」不能省

> 2026-09-21 把 `app/main.py`（1445 行）拆成 `app/routers/` 包之后，
> `make_raw_url` 留在了 `routers/rawlink.py`，而 `onlyoffice.py` /
> `preview.py` / `cad.py` 都调用它、**却没 import**。
>
> 后果：**OnlyOffice + kkFileView + CAD 三条预览链路全部 500**
> （前端只看到「无法打开编辑器 Internal Server Error」）。
> 而当时下面这些检查**全是绿的**：
>
> | 检查 | 为什么没抓到 |
> |---|---|
> | `run_unit_tests.sh`（8 套） | 只覆盖前端 JS |
> | `run_share_tests.sh` | 只走分享链路，不碰 OO/CAD |
> | `selfcheck.py`「全部自检通过」 | 只校验**路由是否存在**；handler 挂上去时不做名字解析 |
> | `python -c "import app.main"` | 导入模块**不执行函数体** |
> | Dockerfile 的 `python3 -m compileall app` | 编译只查语法，不查名字 |
>
> ⇒ 这类「只在调用路径上炸」的错误必须靠**静态名字解析**兜住。
> `tools/check_undefined.py` 是 pyflakes 的最小可用替身（纯标准库 AST），
> 会报出所有「用了但静态解析不到」的名字。
>
> `run_static_checks.sh` 还包含**护栏自检**：拿 `_undef_fixtures/` 里的
> 两个真实坏例跑一遍，必须**恰好**报出 2 处，且正例文件无假红、
> `import *` 的文件被明确标注跳过。护栏没被验证过 = 没有护栏。

---

## 11. 安全说明

| 机制 | 说明 |
|---|---|
| 密码存储 | bcrypt（rounds=12） |
| 会话 | HS256 JWT，HttpOnly + SameSite=lax Cookie |
| 路径穿越 | 先 `resolve()`（展开符号链接）再做**路径层级**包含检查 |
| 越权访问 | 无权映射返回 404（不泄露目录是否存在） |
| OnlyOffice 取文档 | HMAC 签名短期链接，单文件单次有效 |
| 上传文件名 | 过滤 `/ \ : * ? " < > \|`，重名自动改名 |
| 审计 | 登录、增删改、打开文档等写入 SQLite（保留最近 5000 条） |

关于路径穿越的检查方式：用的是「路径层级」（`Path.is_relative_to`），
**不是**字符串前缀 —— 因为 `/mnt/docs-evil` 的前缀恰好是 `/mnt/docs`，
但它并不是 `/mnt/docs` 的子路径。字符串前缀判断会在这里放行。
