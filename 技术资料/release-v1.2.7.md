# NebulaDisk v1.2.7

**镜像骨架变更 + 三个用户报障修复。** 本版是**破坏性**的部署变更（编排从 3 服务变 4 服务），
升级步骤见文末。

---

## 一、镜像骨架：KK 剥离、反代并入（本次主线）

| | 改前 | 改后 |
|---|---|---|
| `nebula` 镜像 | `FROM kkfileview:5.0.2` + Python + supervisord（**KK 与应用同体**），**2.78GB** | `FROM ubuntu:24.04` + **nginx（前门）** + Python + supervisord，**约 0.7GB** |
| 反代 | 独立容器 `nebula-front`（nginx:1.27-alpine）+ **宿主目录绑定挂载配置** | **并进 nebula 镜像**，由 supervisord 管 nginx(80) + 应用(8088) |
| kkFileView | 在 nebula 容器内（127.0.0.1:8012） | **独立服务** `kkfileview:<ver>`，应用用 `NEBULA_PREVIEW=http://kkfileview:8012` 访问 |

**为什么值得这么做**

- KK 那 2.05GB 的层（JRE21 + LibreOffice + 中日韩字体）与云盘本体无关，
  却让「改一行前端也要重建 2GB」；剥离后应用镜像缩到约 1/4。
- 反代那份 conf 与应用的取值方式**是一对**（`Host` / `X-Forwarded-Proto` / Cookie 兜底），
  分开存放必然漂移。实测事故：只传了 `nebula-front.conf` 没传它 `include` 的
  `_oo-proxy.inc` ⇒ `nginx -t` **照样通过**、行为一点没变（map 定义了但没人引用）。
  并进镜像后这一整组永远同版本、同发布节奏。
- 顺带修掉一个**正在发生的**漂移：容器里的 `shell.js` 一直停在镜像里的旧版
  （比仓库少 359 行、缺 `Dialog.isOpen()`），而 `app.js`/`explorer.js` 正在调它
  ⇒ 运行中就在抛 TypeError。根因是 `shell.js` 从来不在补回清单里。

**KK 的定制去哪了（重要）**

KK 镜像保持**官方源码原样、零定制**。我们那 3 个定制模板
（`compress.ftl` / `svg.ftl` / `online3D.ftl`）改为**外置模板目录**：

```
kk-templates/web/*.ftl  →(挂载)→  /opt/kk-templates/web/SPRING_FREEMARKER_TEMPLATE_LOADER_PATH=file:/opt/kk-templates/web/,classpath:/web/
```

`file:` 在前 ⇒ 我们目录里的同名模板**优先命中**，其余自动回落 jar 内的 classpath。
⚠️ 顺序不能反（反了 classpath 先命中，覆盖一点不生效）。
于是「KK 用官方源码直接生成」与「我们的页面定制」两件事不再互相绑死。

---

## 二、三个用户报障修复

1. **链接管理窗口点「复制」复制不进剪贴板**（要求手动复制，不方便）
   根因：全站只认 `navigator.clipboard`。**http:// 内网直连**下它是 `undefined`，
   取 `.writeText` **同步抛 TypeError** ⇒ `.catch()` 接不到 ⇒ 点了**一声不响**。
   修法：统一走 `shell.js` 的 `Clipboard.copy()`——async → textarea+`execCommand`
   （**同步**，保住用户手势）→ contenteditable+Range → 取不到才弹「手动复制」框（**已全选**）。

2. **CAD viewer 显示完整界面（含菜单、工具条）**
   CAD 深链默认**不再拼 `&embed=1`**（= 完整界面）；需要收 UI 的调用方显式带 `embed=1`，
   机制保留在 `/cad/` 代理里。守门判据已随之反转并补了自检坏例。

3. **OO 打开文件报「打开文件时发生错误」**
   根因：**容器的 `/tmp`（2GB tmpfs）被占满**，不是宿主磁盘满（此时 `df` 还有 7TB）。
   OO 的 converter 把下载的源文档写进 `/tmp/ASC_CONVERT*/source`；
   实测被两样东西占满：挪进 /tmp 当备份的旧缓存（1.3G）+ 失败转换残留（439M/316M）。
   修法：清空 + 顺手清 OO 文档缓存；并加**自愈**：
   `deploy/oo-tmpclean.sh` + root cron 每小时跑（只删 /tmp 顶层、匹配 `ASC_*` /
   `old-cache*` 且闲置 >60 分钟的，绝不碰其它文件）。

---

## 三、升级步骤（从 1.2.6 及更早）

```bash
# 1) 导入三个镜像（离线包里的 tar）
docker load -i nebula-1.2.7.tar
docker load -i nebula-kkfileview-5.0.2.tar
docker load -i nebula-cad-viewer-1.7.0.tar

# 2) 部署目录：用新版编排 + 拷贝外置模板
cp dist/nebula-1.2.7/docker-compose.yml       <部署目录>/
cp dist/nebula-1.2.7/.env.example             <部署目录>/.env.example
cp -r dist/nebula-1.2.7/kk-templates          <部署目录>/     # ★ 新：KK 外置模板

# 3) .env 里确认/新增：
#    NB_VERSION=1.2.7
#    NB_KK_VERSION=5.0.2
#    NB_PREVIEW_URL=http://kkfileview:8012        （KK 已独立，不能再用 127.0.0.1）

# 4) 起栈（旧容器 nebula-front 可以停掉了 —— 反代已在 nebula 容器里）
docker compose -f docker-compose.yml up -d
docker stop nebula-front && docker rm nebula-front
```

> ⚠️ **别重建 onlyoffice 容器**：它的 `local.json` **不在挂载卷上**（overlay 层），
> 里面装着 JWT 密钥、`allowPrivateIPAddress`、大文件上限。重建 = 丢这些设置
> （宿主备份在 `./onlyoffice/local.json`，需手工重打）。

---

## 四、离线包内容

```
dist/nebula-1.2.7/
├── nebula-1.2.7.tar (+.sha256)            云盘 + 前门 nginx 镜像
├── nebula-kkfileview-5.0.2.tar (+.sha256) kkFileView 镜像（官方源码构建，零定制）
├── nebula-cad-viewer-1.7.0.tar (+.sha256) CAD 查看器镜像
├── kk-templates/                          ★ KK 外置模板（挂进 KK 容器）
├── docker-compose.yml                     单文件自洽（含默认共享盘挂载）
├── docker-compose.base.yml                纯运行版（不含共享盘）
├── .env.example  _common.sh  install.sh  diagnose-oo.sh  gen-mounts.py
└── 安装说明.md                             本文件 · 见 deploy/README.md
```
