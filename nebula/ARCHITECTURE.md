# 云盘架构设计（NebulaDisk）

## 一、需求回顾

| 需求 | 落地方式 |
|---|---|
| 仿 Windows 界面 | 单页应用，Windows 11 风格：桌面 + 任务栏 + 资源管理器窗口 |
| 部署在 NAS | 纯 Linux 容器，无外部依赖；多阶段构建，支持 amd64/arm64 |
| 映射文件夹 | 环境变量声明多个宿主机目录 → 挂载为容器内 `/mnt/<name>` |
| 双击预览文件 | 前端双击 → 按扩展名路由到对应预览器 |
| Office 调用 OnlyOffice | 复用现有 `maple-onlyoffice`（8082），JWT 签名 |
| 与 kkFileView 合并为一个镜像 | 单镜像双进程，supervisord 管理 |

## 二、关键技术约束（已实测确认）

1. **OnlyOffice 无法合并进单一镜像**
   - 官方镜像 6.83GB，内含 PostgreSQL + RabbitMQ + Nginx + Node.js + .NET 后端
   - 必须以独立容器运行 → 复用现有 `maple-onlyoffice`
   - 决策：云盘作为 sidecar 调用它，对用户完全透明

2. **OnlyOffice 必须能反向访问云盘**
   - OnlyOffice 的转换/编辑服务需要**主动去 GET 文档 URL**
   - 所以文档 URL 里的主机名必须是**从 OnlyOffice 容器可达的地址**
   - 已实测：`maple-onlyoffice` 在 `deploy_default` 网络（172.19.0.3），
     云盘必须加入同名网络才能被它访问

3. **kkFileView 与云盘合并**
   - kkFileView 是 Java（JDK21 + LibreOffice），云盘是 Python
   - 单镜像双进程，用 supervisord 管理
   - 对外只暴露一个端口，由云盘后端反向代理 `/preview/` 到 kkFileView

4. **权限隔离靠 Linux 权限**
   - 多用户各自目录 → 每个用户映射到独立的宿主机目录
   - 后端做路径校验，防止越权（`..` 穿越、符号链接逃逸）

## 三、技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 后端 | Python 3 + FastAPI + uvicorn | 单文件可跑、依赖轻、异步支持好、易读易改 |
| 前端 | 原生 HTML + CSS + JS（无框架） | 零构建步骤，改完即生效；NAS 上不需要 node 工具链 |
| 认证 | 自签 JWT（HS256）+ bcrypt 密码 | 无外部依赖，轻量 |
| 用户库 | SQLite | 单文件，随镜像走，便于 NAS 部署 |
| 进程管理 | supervisord | 单镜像双进程的标准做法 |
| 反向代理 | FastAPI 内做代理转发 | 避免再引入 nginx，减少一层 |

## 四、镜像分层

```
┌─────────────────────────────────────────────────────┐
│  nebula-disk:1.0.0                                  │
│  ┌───────────────────────────────────────────────┐  │
│  │ supervisord                                   │  │
│  │  ├── kkfileview  (JDK21 + LibreOffice :8012)  │  │
│  │  └── nebula      (FastAPI + uvicorn   :8088)  │  │
│  └───────────────────────────────────────────────┘  │
│  对外端口: 8088  (nebula 统一入口)                  │
│    ├── /              → 仿 Windows 界面            │
│    ├── /api/*         → 云盘后端                   │
│    └── /preview/*     → 反代到 kkfileview:8012     │
└─────────────────────────────────────────────────────┘
              │ 同一 Docker 网络
              ▼
┌─────────────────────────────────────────────────────┐
│  maple-onlyoffice:latest  (复用现有, :80)           │
│  JWT_SECRET 需与云盘一致                            │
└─────────────────────────────────────────────────────┘
```

**构建策略（关键）**：以已构建好的 `kkfileview:5.0.2` 为基础镜像叠加，
不重复装 LibreOffice/JDK —— 省时且保证预览能力一致。

```dockerfile
FROM kkfileview:5.0.2
RUN apt-get install -y python3 python3-pip supervisor
COPY app/ /opt/nebula/
RUN pip install -r requirements.txt
COPY supervisor/nebula.conf /etc/supervisor/conf.d/
```

## 五、目录映射约定

环境变量 `NEBULA_MOUNTS` 声明映射（**`|` 分隔字段，`;` 分隔多组**）：

```
NEBULA_MOUNTS=文档|/mnt/docs|alice,bob;照片|/mnt/photos|alice;公共|/mnt/public|*
```

格式：`显示名|容器内路径|可见用户(逗号分隔,*=所有人)`

**为什么用 `|` 而不是 `:`**（这是实测踩到的坑）：
初版用冒号分隔，Windows 盘符路径 `E:\data` 直接被切成 `['E','\data']`。
改成「两端夹逼 + 盘符启发式」后能跑，但两段式 `公共:/mnt/public`
到底是「显示名:路径」还是「路径:用户」**格式本身无法区分**，任何启发式都只能猜。
换成 `|`（路径里绝不会出现的字符）后，冒号可以自由出现在路径中，
解析退化成无歧义的 `split("|")`。旧冒号格式仍兼容，但启动时会提示迁移。

compose 侧对应挂载：

```yaml
volumes:
  - /volume1/docs:/mnt/docs:ro      # NAS 上按需改路径
  - /volume1/photos:/mnt/photos
```

## 六、预览路由

双击文件后，前端按扩展名决策：

| 类型 | 路由 | 说明 |
|---|---|---|
| Office（doc/docx/xls/xlsx/ppt/pptx） | **OnlyOffice**（可编辑） | JWT 签名，编辑后回调保存 |
| PDF / 图片 / 视频 / 音频 / 文本 / Markdown / 代码 | **kkFileView**（只读） | 走 `/preview/onlinePreview` |
| 压缩包 / CAD / OFD 等 | **kkFileView** | kkFileView 原生支持 |
| 其他未知 | 下载 | 兜底 |

## 七、安全要点

1. **路径穿越防护**：所有路径参数经 `resolve()` 后必须仍在映射根目录内
2. **JWT 签名**：OnlyOffice 回调必须验签，防止未授权写入
3. **密码存储**：bcrypt 加盐哈希，绝不明文
4. **目录可见性**：用户只能看到 `NEBULA_MOUNTS` 中授权的目录
5. **危险文件**：`.sh`/`.exe` 等不做在线预览，只提供下载
