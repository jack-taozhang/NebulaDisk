# NebulaDisk 部署指南

仿 Windows 界面的云盘 + kkFileView 预览，统一编排为三个服务：
**nebula**（云盘 + kkFileView，单镜像双进程）、**onlyoffice**、**cad-viewer**。

> 本文件是**唯一**部署文档（离线包里的 `安装说明.md` 就是它的拷贝）。
> 以前有两份（源码版 / 离线包版）会各自漂移，现在合并成这一份。

---

## 0. 先选一条路径

| | 路径 A：源码构建 | 路径 B：离线镜像包 |
|---|---|---|
| 适合 | 要改代码、要长期维护、机器能上外网 | 目标机不联网、只要跑起来 |
| 需要 | 源码 + Docker + 外网 | `dist/nebula-<ver>/` 整个目录 |
| 首次耗时 | **10~30 分钟**（Maven 编译 + 装依赖） | 1~5 分钟（只 `docker load`） |
| 入口 | `bash deploy/up.sh <部署目录>` | `bash install.sh` |
| 怎么更新 | 换源码 → 再跑一次 `up.sh` | 换 tar → 再跑一次 `install.sh` |

两条路径产出的**运行状态完全一样**（同一份编排、同样的容器名与网络），
可以随时从 B 切到 A 或反过来，数据不动。

---

## 1. 目录布局：源码目录 与 部署目录要分开

```
<源码目录>/                        例：/vol1/1000/Docker/NebulaDisk
├── deploy/                        ★ 部署的唯一真相来源
│   ├── docker-compose.yml           可 build（规范版）
│   ├── docker-compose.run.yml       纯运行（生成物，勿手改）
│   ├── gen-run-compose.py           由上面那份生成下面那份
│   ├── .env.example                 配置模板
│   ├── up.sh                        路径 A 入口
│   ├── install.sh                   路径 B 入口
│   ├── _common.sh                   两个入口共用的检查逻辑
│   ├── diagnose-oo.sh               OnlyOffice 现场诊断
│   ├── export-bundle.sh             生成 dist/ 离线包
│   └── README.md                    本文件
├── nebula/                        应用（Dockerfile / app / web / …）
├── src/                           kkFileView 上游源码（构建基础镜像用）
├── build.sh                       构建基础镜像 kkfileview:5.0.2
└── Dockerfile

<部署目录>/                        例：/vol1/1000/NebulaDisk
├── .env                           ★ 配置（从 deploy/.env.example 复制）
├── data/                          云盘 SQLite + 会话密钥
├── data-kk/{file,log}/            kkFileView 转换产物
└── onlyoffice/ 或命名卷 oo-*       OnlyOffice 数据
```

**为什么要分开**：`-f` 指定编排文件，`--project-directory` 决定 ① 从哪读 `.env`
② 相对路径以谁为基准。分开之后——

- **源码可以整体替换**（换 tar、`git pull`、重新拷贝），不用碰 `.env` 与数据；
- **升级不会丢账号/分享**：用户的 SQLite 库、分享记录、转换缓存都在部署目录里。

两处都靠 `up.sh` / `install.sh` 自动处理，正常用不到这条手工命令：

```bash
docker compose -f <源码>/deploy/docker-compose.yml \
               --project-directory <部署目录> up -d
```

### 接管一个已有的部署

换编排时不想丢数据：把 `.env` 里的目录写成**绝对路径**指向老部署目录即可。

```ini
NB_DATA_DIR=/vol1/1000/NebulaDisk/data
NB_KK_FILE_DIR=/vol1/1000/NebulaDisk/data-kk/file
NB_KK_LOG_DIR=/vol1/1000/NebulaDisk/data-kk/log
NB_SHARE_DIR=/vol1/1000/售前项目
NEBULA_MOUNTS=售前项目|/mnt/share|*;…
```

只要 `NEBULA_MOUNTS` 的**显示名**没变，已有的分享链接与用户权限就都还有效
（分享记的是「显示名 + 相对路径」）。

> **现成模板：`deploy/.env.nas.example`**
> 那份文件就是照一次真实的「旧 allinone 部署 → 新 `deploy/` 编排」迁移整理出来的，
> 每一段都注明了「为什么是这个值」。**值已脱敏**，照抄改掉占位符即可。

接管时的三条易漏项：

| 项 | 说明 |
|---|---|
| `NB_SRC_DIR` | 编排里写成 `${NB_SRC_DIR:?…}`。Compose **解析时会整份插值**，所以即使只 `up -d`（不 `--build`）也必须能取到值，否则直接报错。用 `deploy/up.sh` 时它会自动 export；手工跑 compose 就必须在 `.env` 里填绝对路径。 |
| 容器内路径是固定的 | 三个共享盘固定挂到 `/mnt/share`、`/mnt/photos`、`/mnt/private`。**老部署如果是 `/mnt/售前项目` 这类自定义路径，必须把 `NEBULA_MOUNTS` 的第二段一起改成新路径** —— 它与 compose 里 volumes 的右侧是逐字契约关系。 |
| 项目名 | 本编排写死 `name: nebuladisk`。若老部署的目录名也是 `NebulaDisk`（compose 默认取目录名），**项目名正好相同 → `up -d` 会原地重建同一批容器**，不会留下一堆孤儿。目录名不同时请显式 `-p nebuladisk`，否则会出现两套同名容器而报 `Conflict`。 |

---

## 2. 路径 A：源码构建

### 2.1 前提

1. **Docker + Compose**（NAS 上通常已装；Windows 用 Docker Desktop + WSL2）
2. **能上外网**：要拉 `maven` 镜像、装 apt 包、拉 pip 依赖、跑 Maven
3. **源码齐全**：必须有 `src/`（构建基础镜像用）。若只要重建应用层、且本地已有
   `kkfileview:5.0.2`，那 `src/` 可以不完整

### 2.2 一条命令

```bash
cd /vol1/1000/NebulaDisk          # 部署目录（放 .env 与数据的地方）
bash /vol1/1000/Docker/NebulaDisk/deploy/up.sh
```

它会依次做 7 件事：

```
1/7 检查环境（探 docker 通道与 compose）
2/7 准备 .env（不存在就从模板生成，并检查 NB_OO_SECRET 非空）
3/7 准备宿主机目录（缺的自动建 —— 否则容器会静默摘掉那个映射，界面上"盘不见了"）
4/7 准备基础镜像（缺 kkfileview:5.0.2 时自动调用仓库根的 ./build.sh）
5/7 构建应用镜像（docker compose build）
6/7 启动 + 等健康检查
7/7 验证（容器状态 + healthz + OnlyOffice 链路预检）
```

**首次构建耗时**：基础镜像要跑 Maven + 装 apt 包，网络好时约 10~20 分钟；
应用镜像只加 Python 运行时与应用代码，1~3 分钟（基础镜像层已缓存后）。

常用参数：

```bash
bash deploy/up.sh                  # 部署目录 = 当前目录
bash deploy/up.sh /vol1/1000/NebulaDisk
bash deploy/up.sh --no-build       # 跳过构建，直接用已有镜像 up -d
bash deploy/up.sh --no-verify      # 跳过 OnlyOffice 链路预检
```

### 2.3 想手动分步

```bash
cd <源码>/ && ./build.sh           # ① 基础镜像 kkfileview:5.0.2（必须在 WSL/Linux 里跑）
bash nebula/build.sh               # ② 应用镜像 nebula:1.0.0
bash deploy/up.sh --no-build       # ③ 起栈
```

### 2.4 改了代码怎么更新

```bash
bash deploy/up.sh                  # 重建应用镜像并滚动重启（基础镜像已缓存，1~3 分钟）
```

只改前端（`nebula/web/`）或后端（`nebula/app/`）时都是这条命令 ——
它们都在 `nebula` 镜像里，重建那层即可。

---

## 3. 路径 B：离线镜像包

离线包由源码树生成，**不要手工维护**：

```bash
bash deploy/export-bundle.sh --save     # 生成 dist/nebula-<ver>/，并导出镜像 tar
```

产出：

```
dist/nebula-1.0.0/
├── nebula-1.0.0.tar (+.sha256)            云盘 + kkFileView 镜像
├── nebula-cad-viewer-1.7.0.tar (+.sha256) CAD 查看器镜像
├── docker-compose.yml                     纯运行版（无 build:）
├── .env.example  _common.sh  install.sh  diagnose-oo.sh
└── 安装说明.md                             本文件的拷贝
```

拷到目标机后：

```bash
cd /volume1/docker/nebula-1.0.0
vi .env                                  # 至少改目录、管理员密码、NB_OO_SECRET
bash install.sh
```

`install.sh` 幂等，会：导入镜像（有 `.sha256` 就先校验）→ 备 `.env` →
建宿主机目录 → 起栈 → 等健康 → OnlyOffice 链路预检。

> ★ 包内 compose **绝不含 `build:`** ★
> 群晖 Container Manager / 威联通 Container Station 这类图形化容器管理器不支持
> `build:`，会转而按 `image:` 去联网拉取 → 表现为「镜像明明导入了却一直卡在 Pulling」。
> `export-bundle.sh` 每次都会断言这一点。

---

## 4. 配置 `.env`

> ### 先记住两条约定，就不会在「这个值到底在哪配」上绕圈
>
> **① 不变的默认值在 `nebula/Dockerfile` 的 ENV 里，不在 compose 里。**
> compose 只写「**随部署变化**」的东西。像 `NEBULA_DATA_DIR`、`NEBULA_PORT`、
> kkFileView 的 `KK_*` 开关这些产品固定值，都在 Dockerfile 里定义一次。
> ⇒ 想查某个变量的默认值：**先去 Dockerfile 搜**。
> ⇒ 想临时覆盖：在 `.env` 里写对应的 `NB_*`，或在 compose 的 `environment` 里
> 直接写容器侧变量名（`environment` 优先于镜像 ENV）。
>
> **② `.env` 里的变量一律 `NB_` 前缀，由 compose 映射成容器内的 `NEBULA_*` / `KK_*`。**
> 绕一层是为了**不撞车**：容器里的 `NEBULA_*` 是产品自己的名字，而 `.env` 属于宿主
> 环境，同名很容易被外部环境变量意外覆盖。
>
> 三条「看起来多余、其实不能删」的默认值（删了会**覆盖成空串**，反而更糟）：
> `NEBULA_ADMIN_USER: ${NB_ADMIN_USER:-admin}` 这类写法里的 `:-默认值`。
> 若写成 `${NB_ADMIN_USER:-}`，`.env` 没设时容器会收到**空字符串**，
> 把 Dockerfile 里正确的 `admin` 覆盖掉 —— 这是 compose 最经典的坑之一。

从 `deploy/.env.example` 复制。**变量含义在模板里逐条注释**，这里只列必改的：

```ini
# ★ 你的真实目录（宿主机路径）
NB_SHARE_DIR=/volume1/共享
NB_PHOTOS_DIR=/volume2/照片
NB_PRIVATE_DIR=/volume1/私密

# 云盘数据目录（必须持久化，否则重建容器就丢用户）
NB_DATA_DIR=/volume1/nebula/data

# ★ 管理员密码（留空 = 随机生成并打进日志）
NB_ADMIN_PASSWORD=你的密码

# ★★ OnlyOffice 密钥：必填，留空会**直接启动失败** ★★
#   编排里两边读的是同一个变量，所以填一次即可，不会出现"两边不一致"
NB_OO_SECRET=自己定一个强密码

# ★ 浏览器访问 OnlyOffice 的地址（NAS 的真实 IP/域名）
NB_OO_PUBLIC=http://192.168.1.10:8082
```

### 共享盘：挂几个都行，只改一个地方

**一句话**：要挂哪些目录，只在 `.env` 的 `NB_MOUNTS` 里写；写完重跑 `up.sh`。

```ini
#          显示名 | 宿主机路径      | 容器内路径      | 可见用户
NB_MOUNTS=共享|/volume1/共享|/mnt/share|*;\
照片|/volume2/照片|/mnt/photos|*;\
私密|/volume1/私密|/mnt/private|admin
```

**加一个盘**（比如再挂一个「图纸」目录）：

```ini
NB_MOUNTS=共享|/volume1/共享|/mnt/share|*;照片|/volume2/照片|/mnt/photos|*;私密|/volume1/私密|/mnt/private|admin;图纸|/volume1/图纸|/mnt/图纸|*
#                                                                                                                                 ↑ 就加这一段
```

```bash
bash deploy/up.sh <部署目录>      # 自动：生成挂载编排 → 建缺失的宿主机目录 → 重建容器
```

**五条约定**

| 字段 | 说明 |
|---|---|
| 显示名 | 界面上看到的盘符名，可用中文。**它也是分享链接的依据** —— 改显示名会让已有的分享失效 |
| 宿主机路径 | 绝对路径，或相对**部署目录**的相对路径（`./mnt/share`）。不存在会自动创建 |
| 容器内路径 | **必须以 `/mnt/` 开头**（防止误盖数据目录）。改它**不影响**用户数据，只影响容器内挂载点 |
| 可见用户 | `*` 所有人；或 `alice,bob`；省略等同 `*` |
| 分隔符 | 字段用竖线 `\|`，多条用分号 `;`。**路径里不要再出现这两个字符** |

- **用户只看到自己有权限的盘**；直接构造 API 访问无权目录返回 **404**（不是 403 —— 403 等于告诉对方"这个目录存在"）
- 为什么字段用 `|` 而不是冒号：冒号在 Windows 盘符（`E:\data`）、UNC、URL 里天然存在，切成两段就有歧义

> ### ★ 为什么只改一处就够 ★
> compose 的 `volumes:` 是**静态**的，没法从环境变量动态长出条目。所以「加一个盘」
> 原本要同时改两处、而且必须**逐字一致**：
> `docker-compose.yml` 的 `volumes` 绑定 ＋ 容器内 `NEBULA_MOUNTS` 的第二段。
> 漏改任一处，表现只是「某个盘不见了」，很难联想到是拼写不一致。
>
> 现在由 `deploy/gen-mounts.py` 从 `NB_MOUNTS` **机械派生**这两处，所以不可能对不上：
> - **源码路径**：生成 `docker-compose.mounts.yml`，由 `up.sh` 以 `-f` 叠加在主编排之后
> - **离线包**：合并进 `docker-compose.yml` 成**单文件**（图形化容器管理器只吃一个文件）
>
> 两处都由 `up.sh` / `install.sh` 自动调用，你不用手动跑。
> 想单独校验格式：`python3 deploy/gen-mounts.py <部署目录> --check`

---

## 5. 验证与自检

```bash
# 云盘健康接口（同时反映 kkFileView / OnlyOffice / CAD 的状态）
docker exec nebula curl -s http://127.0.0.1:8088/healthz
# {"ok":true,"mounts":3,"onlyoffice":true,"cad":true,"time":…}

# 每个映射的检查结果（启动时打印）
docker logs nebula 2>&1 | grep '\[nebula-entrypoint\]'
# [nebula-entrypoint] ✓ 映射 共享 -> /mnt/share  可见: *

# 写权限
docker exec nebula touch /mnt/share/.wtest && docker exec nebula rm /mnt/share/.wtest && echo 可读写

# OnlyOffice 链路（不做这一步的话，问题会推迟到"点开文档"才暴露）
docker exec onlyoffice curl -s -o /dev/null -w '%{http_code}\n' http://nebula:8088/healthz
# 期望 200
```

---

## 6. ★ 报「打开文件时发生错误」怎么查 ★

这是**换机器部署后最常见的问题**。先记住一条判读方法：

> 编辑器**外壳**（工具栏、页码、缩放百分比）能正常渲染出来
> ⇒ 配置下发与 JWT 都是通的；
> 只有**正文**打不开
> ⇒ 失败发生在「**OnlyOffice 服务端拿到并处理文档**」这一步。

之后**要分两类**，只想着网络会跑偏：

- **类 A：取不到文件** —— 服务端 GET 文档失败（网络 / 地址 / 私有 IP 限制）
- **类 B：取到了但转换失败** —— 本地 IO / 权限问题（**`/tmp` 不可写最常见**）

**一键诊断**（在部署机器上跑，只读不改，覆盖这两类）：

```bash
bash deploy/diagnose-oo.sh        # 离线包里是 bash diagnose-oo.sh
```

它会把证据一次摊开：两边容器的网络交集、从 OnlyOffice 容器里真实请求文档地址的
结果、**converter 的 `/tmp` 是否可写（并以 `ds` 身份实测建目录）**、
两边 JWT 比对、以及 converter 日志里的原始报错行。

| 类 | 现象 / 日志 | 根因 | 修复 |
|---|---|---|---|
| **B** | `EACCES: permission denied, mkdir '/tmp/ASC_CONVERT…'`（在 converter 日志里）<br>`docker exec onlyoffice ls -ldn /tmp` **不是** `drwxrwxrwt` | converter 以**非 root 用户 `ds`(uid 101)** 运行，必须在 `/tmp` 建临时目录。成因：① 镜像自带的 `/tmp` 权限就是错的（实测见过被重打过的镜像把 `/tmp` 做成 `0755`）；② 你的 Docker 给 tmpfs 的**默认 mode 是 0755**（不是标准的 1777） | 给 `/tmp` 挂 tmpfs 且**必须显式写 `mode=1777`**：`tmpfs:` / `  - /tmp:rw,exec,size=2G,mode=1777`。<br>⚠️ 只写 `- /tmp` 或只写 `size=` **都不行**，实测仍是 `drwxr-xr-x`。<br>同时**不要**设 `read_only: true`、**不要**设 `user:` |
| **A** | 容器里 `getent hosts nebula` 无输出；请求 `NB_BASE_URL/healthz` 超时 | 两个容器**不在同一 docker 网络** | 本编排把三个服务都放在 `nebula-net` 上，正常不会遇到。若你替成了别的编排：让两者至少共享一张网络，或 `docker network connect <网络> nebula`（重建容器会掉） |
| **A** | 返回 **403 / 422** | 网络通了但**签名校验被拒** | 确认只有一台云盘实例；`NB_JWT_SECRET` 是否被改过 |
| **A** | converter 日志出现 `It is private IP address` | OnlyOffice **默认拒绝从私有 IP 拉文档**，而 `NB_BASE_URL` 写成了 IP 字面量 | 改成**主机名**（`http://nebula:8088`，不受此限制）；或把 `default.json` 的 `services.CoAuthoring.requestFilteringAgent` 下 `allowPrivateIPAddress` / `allowMetaIPAddress` 改为 `true` 后重启 |
| **A** | `NB_BASE_URL=http://<NAS_IP>:8089` | 容器间互通要用**容器端口 8088**，不是宿主机映射端口 | 改回 `http://nebula:8088` |
| — | 两边 `JWT_SECRET` 不一致 | 通常编辑器**外壳也出不来**（与本节现象不同） | 本编排两边读同一个变量，正常不会不一致 |

> ⚠️ **别把「本机能用」当作「目标机也能用」**。同一个
> `onlyoffice/documentserver:latest` 标签，不同时间/不同镜像源拉到的
> **digest 可能不同、内容也可能不同**（实测见过一份被重打过的镜像，`/tmp` 被做成 0755）。
> 凡是涉及「镜像自带什么 / 内核默认给什么」的结论，**必须在目标机器上实测一遍**。

---

## 7. 常见问题

**端口被占用** 改 `.env` 里的 `NB_HOST_PORT`（只影响宿主机侧，容器内固定 8088）

**重启后所有人要重新登录** `NB_DATA_DIR` 没真正挂到宿主机。检查
`docker inspect nebula --format '{{json .Mounts}}'`；密钥文件是 `/var/lib/nebula/secret.key`

**删了 `data-kk/file` 下的产物后预览白屏** kkFileView 有内存缓存，删文件但缓存
还记着「已转换」。删完必须 `docker restart nebula`

**中文文档预览成方块** 基础镜像里已装中日韩字体，正常不会。若出现，检查是否替换过基础镜像

**内存不够 / 转换被 SIGABRT 杀掉（exit 134）** LibreOffice 转换吃内存也吃 `/dev/shm`。
确认编排里的 `shm_size: 2gb` 生效，并按需下调 `NB_MEMORY_LIMIT` 与 `NB_JAVA_OPTS`

**改了代码但界面没变** 前端在 `nebula` 镜像里，必须重建：`bash deploy/up.sh`。
另外浏览器会缓存静态资源，强刷一次（Ctrl+F5）

**`network nebula-net was found but has incorrect label com.docker.compose.network
set to "nebula-net" (expected: "default")`** 你把 `networks:` 下面那个 **key 改名**了
（常见于"顺手改成 `default` 好看点"）。compose 会给网络打标签
`com.docker.compose.network = <key>`，改 key 后标签对不上既有网络，它就**拒绝复用**。
⇒ **key 与 `name:` 保持一致**（本项目都是 `nebula-net`）。想让各服务不重复写
`networks:`，用文件里那个 `x-common` 锚点，别改 key。
（这个错**不会**动到正在跑的容器 —— compose 在解析网络阶段就中止了。）

**NAS 典型路径**

| NAS | 典型路径 |
|---|---|
| 群晖 Synology | `/volume1/xxx` |
| 威联通 QNAP | `/share/xxx`（注意 `/share/CACHEDEV1_DATA`） |
| 绿联 Ugreen | `/mnt/xxx` |
| 极空间 | `/sata/xxx` |

---

## 8. 分享功能怎么用

登录后在文件上**右键 → 分享**，或在空白处右键 → 「分享此文件夹」/「管理我的分享…」。

- 短链形如 `http://<NAS的IP>:8089/s/<32位token>`，可以发给任何人，**对方不需要账号**
- 可选：设访问密码、有效期、最大访问次数
- 收件人打开是独立浏览页，能进子目录、能预览、能下载
- **删掉源文件或改名，对应分享会自动失效**（不留死链）
- 撤销：右键空白处 → 「管理我的分享…」 → 删除

安全边界（由 48 项集成测试覆盖）：访客的路径是「相对分享根」的子路径，
会被二次校验必须仍在分享根之内，`../` 类穿越一律拒绝。

---

## 9. 工具与脚本一览

| 文件 | 干什么 |
|---|---|
| `deploy/up.sh` | 路径 A 入口：建基础镜像 → 建应用镜像 → 起栈 → 验证 |
| `deploy/install.sh` | 路径 B 入口：导入镜像 → 起栈 → 验证（幂等） |
| `deploy/_common.sh` | 两条路径共用的检查逻辑（探 docker / 备 .env / 建目录 / 等健康 / OO 预检） |
| `deploy/docker-compose.yml` | ★ 编排唯一真相（可 build） |
| `deploy/gen-run-compose.py` | 由上面那份生成纯运行版（剥 build、加 pull_policy） |
| `deploy/diagnose-oo.sh` | OnlyOffice 打不开文档时的现场诊断（只读） |
| `deploy/export-bundle.sh` | 生成 `dist/` 离线镜像包；`--save` 顺带导出 tar |
| `deploy/.env.example` | 配置模板（变量含义逐条注释） |
| `build.sh` | 构建基础镜像 `kkfileview:5.0.2`（需 `src/`） |
| `nebula/build.sh` | 只构建应用镜像 `nebula:1.0.0`（等价 `up.sh --no-*` 的构建部分） |
| `nebula/selfcheck.py` | 后端自检：配置解析 / 路径穿越防护 / 路由齐全 |
| `nebula/tools/run_unit_tests.sh` | 前端逻辑单元测试（8 套） |
| `nebula/tools/run_share_tests.sh` | 分享功能集成测试 |

---

## 10. 安全说明

| 机制 | 说明 |
|---|---|
| 密码存储 | bcrypt（rounds=12） |
| 会话 | HS256 JWT，HttpOnly + SameSite=lax Cookie |
| 路径穿越 | 先 `resolve()`（展开符号链接）再做**路径层级**包含检查（不是字符串前缀 —— `/mnt/docs-evil` 的前缀恰好是 `/mnt/docs`，但它不是子路径） |
| 越权访问 | 无权映射返回 **404**（不泄露目录是否存在） |
| OnlyOffice 取文档 | HMAC 签名短期直链，单文件单次有效 |
| 访客分享 | 32 字符随机 token；可选密码（存 bcrypt）；路径二次校验必须落在分享根内 |
| 上传文件名 | 过滤 `/ \ : * ? " < > \|`，重名自动改名 |
| 审计 | 登录、增删改、打开文档等写入 SQLite（保留最近 5000 条） |

> `.env` 里有 `NB_OO_SECRET` 与 `NB_ADMIN_PASSWORD`，**别提交进版本库**（`.gitignore` 已含 `.env`）。
