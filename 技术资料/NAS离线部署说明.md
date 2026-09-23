# NebulaDisk 离线部署说明（镜像包版）

把这一整个目录拷到目标 NAS 上，**不需要源码、不需要联网构建**。

镜像里已经烤好了两件事：

| 进程 | 端口 | 职责 |
|---|---|---|
| NebulaDisk | 8088 | 仿 Windows 云盘界面、目录映射、多用户鉴权、文件管理、分享 |
| kkFileView | 8012 | 非 Office 文件预览（PDF / 图片 / 视频 / 压缩包 / 代码 / CAD…） |

---

## 1. 包内容

```
nebula-1.0.0/
├── nebula-1.0.0.tar         ← 镜像本体（docker save 出来的，约 1.7 GB）
├── nebula-1.0.0.tar.sha256  ← 上面的校验值
├── docker-compose.yml       ← 只有 image:，没有 build:；带 pull_policy: never
├── .env.example             ← 配置模板
├── install.sh               ← 一键安装（校验+导入镜像 + 建网络 + 建目录 + 启动）
└── 安装说明.md               ← 本文件
```

**拷完先校验完整性**（1.7GB 传输损坏很隐蔽，`install.sh` 也会自动校验一遍）：

```bash
sha256sum -c nebula-1.0.0.tar.sha256
```

---

## 2. 三步部署

### 2.1 拷过去

把整个 `nebula-1.0.0/` 目录放到 NAS 上任意位置，例如
群晖的 `/volume1/docker/nebula-1.0.0/`。

### 2.2 改配置

```bash
cd /volume1/docker/nebula-1.0.0
cp .env.example .env
vi .env
```

**必改的三处**（其余可以先不动）：

```ini
# ① 你的真实目录（宿主机路径）
NB_SHARE_DIR=/volume1/共享
NB_PHOTOS_DIR=/volume2/照片
NB_PRIVATE_DIR=/volume1/私密

# ② 管理员密码（留空则随机生成，去容器日志里翻，不推荐）
NB_ADMIN_PASSWORD=你想设的密码
```

改完目录后，**同一个文件里**的映射声明要跟着对齐（容器内路径必须一致）：

```ini
NEBULA_MOUNTS=共享|/mnt/share|*;照片|/mnt/photos|*;私密|/mnt/private|admin
```

> 格式是 `显示名|容器内路径|可见用户`：
> - `*` = 所有登录用户可见；也可写 `alice,bob`
> - 分隔符是**竖线 `|`**，不是冒号 —— 冒号在 Windows 路径里天然存在，会歧义

### 2.3 跑起来

```bash
bash install.sh
```

脚本是幂等的，会依次完成：检查 docker → 导入镜像 → 建占位网络 → 生成 `.env` → 启动 → 等健康检查。

也可以手动三步：

```bash
docker load -i nebula-1.0.0.tar
docker network create nebula-oo        # 没有 OnlyOffice 时才需要这步，见 §4
docker compose up -d
```

打开 `http://<NAS的IP>:8089`。

---

## 3. 部署后自检

```bash
# 两个进程都活着、映射都在
docker exec nebula curl -s http://127.0.0.1:8088/healthz
# {"ok":true,"mounts":3,"onlyoffice":false,"cad":false,"time":...}

# 启动日志里每个映射的检查结果
docker logs nebula 2>&1 | grep '\[nebula-entrypoint\]'
# [nebula-entrypoint] ✓ 映射 共享 -> /mnt/share  可见: *
```

`mounts` 数量不对，说明 `NEBULA_MOUNTS` 与 `volumes` 没对齐 —— 启动日志会点名
哪个容器内路径不存在。

写权限：

```bash
docker exec nebula touch /mnt/share/.wtest && docker exec nebula rm /mnt/share/.wtest \
  && echo "可读写"
```

---

## 4. 可选组件（没有也能用）

这个镜像**自带** kkFileView，所以 PDF / 图片 / 视频 / 压缩包 / 代码 / CAD 都能直接预览。
下面两个是外挂的，缺了只影响对应格式：

| 组件 | 缺了会怎样 | 怎么接 |
|---|---|---|
| OnlyOffice | `docx/xlsx/pptx` 点开不走在线编辑，走下载 | 另起一个 `onlyoffice/documentserver` 容器，与本容器**同一 docker 网络**，然后在 `.env` 填 `NB_OO_URL` / `NB_OO_PUBLIC` / `NB_OO_SECRET` / `NB_OO_NETWORK` |
| cad-viewer | `dwg/dxf` 图纸预览不可用 | 同上，填 `NB_CAD_URL` |

**关于 `oonet` 这个外部网络**：compose 里 `oonet` 是 `external: true`，
如果那个网络不存在，`docker compose up` 会**直接失败**。所以：

- 暂时不用 OnlyOffice → 先 `docker network create nebula-oo`（`install.sh` 已自动做），
  让它挂着当占位，以后接 OnlyOffice 时直接 `docker network connect` 即可；
- 或者编辑 `docker-compose.yml`，删掉 `networks` 段的 `oonet` 和 service 里的 `- oonet`。

### 接 OnlyOffice 时最容易错的一个变量

```ini
# ✅ 对：OnlyOffice **容器**能访问到的地址，用服务名 + 容器端口 8088
NB_BASE_URL=http://nebula:8088
# ❌ 错：127.0.0.1 是 OnlyOffice 自己
# ❌ 错：NAS_IP:8089 那是宿主机映射端口
```

原因：OnlyOffice 是**用服务端**去 GET 文档的，不是浏览器发请求。
这个地址填错的表现是「编辑器一直转圈」或「下载文件失败」。

---

## 5. 常见问题

**端口被占用**
改 `.env` 里的 `NB_HOST_PORT`（只影响宿主机侧，容器内固定 8088）。

**中文文档预览成方块**
基础镜像里已装中日韩字体，正常不会。若出现，检查是否自行替换过基础镜像。

**删了 `data-kk/file` 下的产物后预览白屏**
kkFileView 有内存缓存，删文件但缓存还记着「已转换」。删完必须
`docker restart nebula`。

**重启后所有人要重新登录**
说明 `NB_DATA_DIR` 没真正挂到宿主机。检查
`docker inspect nebula --format '{{json .Mounts}}'`。
密钥文件是 `/var/lib/nebula/secret.key`。

**内存不够 / 转换被 SIGABRT 杀掉（exit 134）**
LibreOffice 转换吃内存也吃 `/dev/shm`。确认 compose 里的
`shm_size: 2gb` 生效，并按需下调 `NB_MEMORY_LIMIT` 与 `NB_JAVA_OPTS`。

**NAS 典型路径对照**

| NAS | 典型路径 |
|---|---|
| 群晖 Synology | `/volume1/xxx` |
| 威联通 QNAP | `/share/xxx`（注意 `/share/CACHEDEV1_DATA`） |
| 绿联 Ugreen | `/mnt/xxx` |
| 极空间 | `/sata/xxx` |

---

## 6. 分享功能怎么用

登录后在文件上**右键 → 分享**，或在空白处右键 → 「分享此文件夹」/「管理我的分享…」。

- 生成的短链形如 `http://<NAS的IP>:8089/s/<32位token>`，可以发给任何人，**对方不需要账号**
- 可选：设访问密码、设有效期、设最大访问次数
- 收件人打开就是一个独立的浏览页，能进子目录、能预览、能下载
- **删掉源文件或改名，对应分享会自动失效**（不留死链）
- 撤销：右键空白处 → 「管理我的分享…」 → 删除

安全边界（已由 48 项集成测试覆盖）：访客的路径是「相对分享根」的子路径，
会被二次校验必须仍在分享根之内，`../` 类穿越一律拒绝。

---

## 7. 和「源码版部署」的区别

| | 本包（离线） | 源码仓库 |
|---|---|---|
| 需要源码 | ❌ | ✅ |
| 需要联网构建 | ❌ | ✅（装 apt/pip 依赖） |
| 构建耗时 | 无（只 load） | 数分钟 |
| 升级方式 | 换新 tar + `docker load` + `compose up -d` | `./build.sh --up` |
| 适用 | 直接部署、内网、异地 NAS | 开发调试、改代码 |

两种方式产出的**镜像内容完全相同**，`docker-compose.yml` 只差一个 `build:` 段。
