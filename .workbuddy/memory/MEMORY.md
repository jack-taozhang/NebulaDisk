# MEMORY.md — NebulaDisk 项目长期笔记（核心铁律）

> 跨会话必须记住的**结论与铁律**。每日流水在 `YYYY-MM-DD.md`。
> 长案例、实测数据表、WM 细节、测试细节、排查手册全部在**同目录 `技术细节.md`**。
> ⚠️ 本文件是注入本，**不得超过 ~15KB**（超了会被截断，截断就看不见后半段）。新增内容写进附录。

## 项目本体

仿 Windows 云盘（NebulaDisk）+ kkFileView 合并镜像。工作目录 `D:\Docker\kkFileView`。

- 镜像 `nebula:1.0.0`（单容器双进程，supervisord）；网关 `/opt/nebula/`（FastAPI :8088，
  **单 worker uvicorn**）；kkFileView `/opt/kkFileView-5.0.2/`（:8012）；宿主 8089 → 网关
- 测试凭据 `admin` / `Nebula@***`（Form 参数）；**所有修复必须固化进镜像**（不许 `docker cp`）；
  重建 `bash nebula/build.sh --up`
- 环境：Docker 只能经 `wsl.exe -e docker`；Git Bash 每次调用要 re-export PATH；heredoc 吃 `'`/`$`
- **部署 `deploy/` 是部署唯一真相源**：`docker-compose.yml`（可 build，项目名 `nebuladisk`，
  网络固定名 `nebula-net`）· `gen-run-compose.py` 派生 `.run.yml` · `_common.sh` · `up.sh`（源码构建）·
  `install.sh`（离线包）· `export-bundle.sh` · `docker-compose.dev.yml` · `.env.example` ·
  `.env.nas.example`（一次真实 NAS 迁移的脱敏模板）· `README.md`（唯一部署文档）
- **后端 `nebula/app/`**：`config/auth/users/files/integrations/shares/webutil/share_web.py`
  + `routers/` 10 个。`main.py` 只装配（105 行）。**前端 `nebula/web/`**：
  `shell.js`(WM) `explorer.js` `viewer.js` `app.js` `icons.js` `api.js` `share.*`

## ★ 铁律 1：网关单 worker，响应路径禁止阻塞 IO，更禁止「闭环等待」★

uvicorn **没有 `--workers`** → 只有一个事件循环。`async def` 里任何同步阻塞
（`httpx.Client`/`requests`/`time.sleep`/大文件读写/`subprocess.run`）会冻结**全站**。
慢操作丢后台线程/进程或用 `httpx.AsyncClient`。**`/healthz` 是纯内存接口**，它一变慢
= 事件循环被占死 —— 最快的诊断信号。

**真实事故（2026-09-20）**：在 `proxy_preview` 响应路径加同步「探测+强制重解压」（≤300s），
实为**闭环死锁**：kkFileView 解压前必须 `GET http://nebula:8088/api/raw/...`（打回网关），
而网关唯一 worker 正阻塞等 kkFileView → 无人应答 → 30s 超时 → 解压失败 → 成员 404。
症状：`/onlinePreview` **每次精确 30.1s**（是超时值，不是解压耗时）；`/directory` 的 `children`
恒 `null`。**整体删除该逻辑**。
**教训**：反代层「等后端完成某件事」前，先确认**后端完成这件事是否需要回调本代理**。
诊断利器：**耗时是否恰好等于某个超时值**。（完整链条见附录 §1）

## ★ 铁律 2：反代拆开「浏览器源」与「服务端源」★

`X-Base-Url` = **浏览器**源，**必须带端口**，否则预览页白屏；绝不能用 `NEBULA_BASE_URL`。
服务端回拉走 `compress.ftl` 的 `__SERVER_BASE_URL__` 占位符 → 网关替换成容器内可达地址。

## ★ 铁律 3：URL 特殊字符必须编码 ★

压缩包名可含 `#` → 截断 URL，Java 抛 `URISyntaxException: Illegal character in fragment`。
模板侧 `encodeMemberPath()`；网关侧对 query 的 `kkCompressfilepath`/`urlPath` 再 `#`→`%23` 兜底。

## ★ 铁律 4：按钮三套体系，绝不混用选择器 ★（两次真实故障都源于此）

| 选择器 | 谁产出 | 是谁 |
|---|---|---|
| `.tb-btn` + `data-act` | `Toolbar.build` 三键模板 | 窗口控制键（最小化/最大化/关闭）|
| `.tbtn` + `data-a` | `Toolbar.btn(...)` | 工具栏业务按钮（缩放/旋转/下载…）|
| `.nav-btn` + `data-act` | explorer 地址栏 | 后退/前进/上一级/刷新 |
| `.tb-btn nav-btn` + `data-a` | `viewer.js navBtns()` | **翻页键（class 像三键、属性像业务按钮！）**|

- 故障一：`_bindDrag` 豁免写成 `closest('.tb-btn')` → `.tbtn` 被 `preventDefault()` → 浏览器不派生
  `click` → 「最顶上其它按钮全部失效」。修法：豁免放宽到 `button, [role=button], input, textarea,
  select, a, [contenteditable], [data-no-drag]`
- 故障二：`_bindControls` 用 `querySelectorAll('.tb-btn')` + 监听里**无条件 `stopPropagation()`** →
  吞掉翻页键 click → 「点『下一个文件』没反应」。修法：收窄为 **`.tb-btn[data-act]`**
- **永久规矩**：①选择性监听的选择器必须带语义限定，不用裸 class；②`stopPropagation()` 必须放在
  确认这次点击真属于我**之后**；③新增按钮先确认归哪套。
  `_test_drag_buttons.js` §12 锁死了这套契约（源码形态断言）。

## ★ 铁律 5：置顶（focus）不能只挂 `mousedown` ★

`_bindDrag`/`_bindResize` 都在 pointerdown 里 `preventDefault()`，按 Pointer Events 规范这会
**一并抑制派生的 `mousedown`** → 走这两条路径的区域 `mousedown` 永不派发。
用户原话：「最顶上的工具栏（最小化，最大化，关闭这一行）目前没有涵盖在内，需要增加点击这个区域
也能前置显示窗口。」
**修法**：在这两处 pointerdown 里、**`preventDefault()` 与按钮豁免之前**调 `focus(state.id)`；
且**必须在 `if (state.maximized) return` 之前**。改 `_bindDrag` 就覆盖两种窗口（共用同一个
`.toolbar.win-toolbar[data-drag-handle]`）；`_bindResize` 热区不在工具栏里，必须单独补一次。
守护：`_test_drag_buttons.js` §11 + `_tf_run.sh`。

## ★ 铁律 6：拖动/缩放必须有整屏遮罩 + 指针捕获 ★

预览窗口 body 被 iframe 铺满，**指针进入嵌套浏览上下文后父文档 mousemove/mouseup 不再触发**
→ 拖动卡死、松手粘鼠标。两道保险（各自都能独立解决）：①`.wm-drag-shield`
（`position:fixed;inset:0;z-index:9998`）挂 `document.body`；②`setPointerCapture(e.pointerId)`。
手势一律 `pointerdown/move/up`。收尾挂 `state._dragUp`/`_resizeUp`；`close()` 兜底撤盾
（否则拖到一半关窗会永久留盾吃掉全桌面点击）。

## ★ 铁律 7：模块在全局**词法**环境，不在 `window` 上 ★

`shell.js`/`viewer.js`/`icons.js`/`api.js` 都是 `const WM/Viewer/Icons/API = (()=>{...})()`。
任何脚本能用**裸名**访问，但 **`window.WM`/`window.Viewer` 是 `undefined`**。
探针里必须裸名调用；写 `window.Viewer.step` 会得 `viewerKeys: []` 的**假阴性**。

## ★ 铁律 8：抄逻辑的测试 = 没有测试 ★

`_test_resize_hit.js` 曾把 `_bindResize` **抄**一份进测试（还是过时参数）→ 产品有 bug 照样
12/12 **假绿**。**必须**：读产品源码用 `new Function` 注入桩执行（不抄）+ §0 源码同步性断言当
总开关 + 观测点必须是产品真实写入的位置 + 负向断言前先 `stripComments()` + 「能点到什么」用
`elementFromPoint` 而非 `dispatchEvent`（后者绕过命中测试）+ 拖动只写 left/top 故用 `posOf()`。
**完整 11 条见附录 §4.1**。

## ★ 铁律 9：真实浏览器报红 ≠ 产品有 bug ★

①**绝不能手写 `zIndex`** —— WM 的 `zTop` 从 100 起只增不减，手写 `"210"` 会让 `focus()`
永远打不过 → 必然假红；要让**产品自己的 `focus()` 建立层叠序**；②**先实测视口**
（本项目 **1264×625**，`--taskbar-h:48`）；③探针坐标先经 `elementFromPoint` 验明归属；
④**几何归属 ≠ 功能正确** —— 正确判据是**看 zIndex 是否变大/是否成为最顶**；
⑤**探针自己也要自检**：关键动作前后各放一个"必定有副作用"的对照动作，没反应就报
`probeBroken` 并**拒绝给结论**（**附录 §4.2/§4.3**）。

## ★ 铁律 10：Compose v2 反直觉语义（实测）★

①`build.context` 相对路径按 **`--project-directory`** 解析，**不是** compose 文件所在目录；
②**`networks:`（列表）合并多个 compose 文件时是「替换」而非「追加」**（只有 ports/expose/dns/tmpfs 追加）；
③`docker compose up -d` **会**创建**非活跃 profile** 的容器（只有 `--profile X up` 才跳过）；
④env 文件里的 `COMPOSE_PROFILES` 可**无 CLI 参数**自动启用 profile；
⑤项目名优先级：`-p` > `COMPOSE_PROJECT_NAME` > 顶层 `name:` > **当前目录名**；
⑥**`-f A.yml` 只**用 A.yml，**不叠加**默认文件 —— 「主 + 可选叠加」必须显式列全，
写漏的后果是**服务静默不启动且退出码 0**；
⑦`${VAR:?msg}` 在**解析时**就插值 ⇒ 即使只 `up -d` 不 `--build`，那个变量也必须取得到值；
⑧★ **`networks:` 下面的 key 不能改名**（想省掉各服务的 `networks:` 时最容易犯）★
compose 给网络打的标签是 **key**（`com.docker.compose.network=<key>`），不是 `name:`。
把 key 从 `nebula-net` 改成 `default` 会让 `up -d` 直接失败：
`network nebula-net was found but has incorrect label … set to "nebula-net" (expected: "default")`。
⇒ **key 与 `name:` 保持一致**；要让各服务不重复写，就把 `networks:` 放进 YAML 锚点
（`x-common: &common` 里带 `restart` + `networks`），服务只写 `<<: *common`。
⚠️ `<<` 是**浅合并**：服务自己也有 `environment:` 时，锚点里的 `environment` 会被整个覆盖，
所以 `TZ` 这类要放在服务自己的 `environment` 下写 `<<: *tzenv`。
（此错在解析网络阶段中止，**不会动到正在跑的容器**。）

## ★ 铁律 11：OnlyOffice「打开文件时发生错误」判读 ★

**一句话判据**：编辑器**外壳**（工具栏/页码/缩放）能渲染 ⇒ 配置与 JWT 都通；只有**正文**打不开
⇒ 失败在「**OO 服务端去 GET/转换文档**」这一步。分两类：

- **类 A 取不到文件**：①两容器不在同一 docker 网络 ②`NEBULA_BASE_URL` 未设 → 回退
  `127.0.0.1:8088` ③用了 **IP 字面量** → 撞 OO 私有 IP 过滤器（实测 `allowPrivateIPAddress=false`
  时**主机名照样能用**，它拦的是 IP 字面量）④写成宿主机端口（容器间要用 `:8088`）
  ⑤两侧 `JWT_SECRET` 不一致
- **类 B 转换失败/本地 IO**：典型 `EACCES mkdir '/tmp/ASC_CONVERT…'`。根因：OO 的
  `converter`/`docservice` 以**非 root 用户 `ds`(uid=101) 运行**，要在 `/tmp` 建临时目录。
  ★★ **必须给 `/tmp` 挂 tmpfs 且显式写 `mode=1777`** ★★：
  `tmpfs: [ "/tmp:rw,exec,size=2G,mode=1777" ]`。
  两个坑：①**同一 `onlyoffice/documentserver:latest` 标签在不同机器上 digest 不同、镜像自带
  `/tmp` 也不同**（开发机 `drwxrwxrwt` vs 目标 NAS `drwxr-xr-x 1001:1002`）→
  「用镜像自带的就行」**不能作为通用建议**；②**有些 NAS 的 Docker 给 tmpfs 的默认 mode 是
  0755** → **不能**简写成 `- /tmp` 或 `- /tmp:size=2G`
- **数据目录**：宿主绑定**看属主**。若 `root:root 755` 会**盖掉**镜像自带属主 → ds 不可写，
  改用**命名卷**（Docker 用「镜像内容 + 属主」初始化，得 `101:102`）
- **诊断工具**：`deploy/diagnose-oo.sh`（只读）。完整实测表见**附录 §6**

## ★ 铁律 12：`.dockerignore` 作用域 ★

Docker 只读**两个位置**：①**上下文根**的 `.dockerignore`；②**`<Dockerfile 名>.dockerignore`**，
与该 Dockerfile **同目录**，只对它生效且**优先级高于根那份**（不合并）。
子目录里随便放叫 `.dockerignore` 的文件 = **完全不被读取**。曾写成 `nebula/.dockerignore` →
一直失效 → 每次把 `nebula/sample/`(219MB)、`demo/`、`src/`、**`nebula/.env`（含密钥）** 全传给 daemon。
**验证**：`BUILDKIT_PROGRESS=plain docker build ... 2>&1 | grep 'transferring context'`
→ 期望 **~256–426kB**；几百 MB 说明 ignore 没生效。
⚠️ `docker/` **不能**被排掉（基础镜像构建要 `docker/maven/settings.xml`、`docker/healthcheck.sh`）。
⚠️ `deploy/.env` `deploy/.env.*` 也要排掉（含管理员口令与 JWT 密钥）。

## ★ 铁律 13：FastAPI 0.141 路由表内部结构 ★

`include_router` **不再把路由摊平进 `app.routes`**，而是包成 `_IncludedRouter`，它**没有 `.path`
也没有 `.routes`**，真路由表在 **`.original_router`**。
⇒ 遍历路由的自检/审计脚本必须递归：对每个 `r` 先取 `.path`，再对 `("routes","original_router")`
递归（限深）。曾因此把**正常的 app 判成假红**。

## ★ 铁律 14：交付给 Linux 的文件必须 LF —— 而 Windows 上「测不出来」★

**Git Bash 容忍 CRLF，Linux 不容忍。** `.sh` 是 CRLF 时在 NAS 上直接
`set: pipefail: invalid option name` / `syntax error near unexpected token $'{\r'`，脚本报废；
而 `.py` 容忍 CRLF，本机跑什么都是绿的。

**元凶是本项目常用的打补丁姿势**：
```python
p.write_text(s.replace(old, new))                        # ❌ Windows 上按 os.linesep 写回 \r\n
p.write_bytes(s.replace("\r\n","\n").encode("utf-8"))     # ✅
```
（`open(f,'w')` 同理会转；`Write` 工具本身安全。）

**护栏**：`nebula/tools/check_eol.py` + `run_static_checks.sh` 第 2 步。
扫描根**显式列出**（`nebula/ deploy/ 根级白名单`），**故意不含 `src/`** —— 上游 kkFileView
仓库本来就满是 CRLF，动了会坏、报了是假红。根 `.gitattributes` 已写
`* text=auto eol=lf` + `src/** -text`。
★ 附带教训：`grep -c $'\r' file` 在 MSYS 上会**静默变成空 pattern**（匹配每一行）→
「192 行全是 CRLF」这种假阳性。判断换行符一律用 Python 读 bytes 数 `\r\n`。

## ★ 铁律 15：远程长任务必须 `setsid nohup ... &`，不能只写 `&` ★

SSH 在 NAS 上跑 `./build.sh`（20+ 分钟）时只写 `cmd &`，**SSH 一断 job 就跟着死**
（实测丢了整整一轮构建，日志一片空白）。正确姿势：
```bash
setsid nohup bash ./build.sh > /var/log/xx.log 2>&1 < /dev/null &
```
然后**轮询远端日志文件**，不要在同一会话里等。
另：`echo pw | sudo -S bash -s <<'EOF'` 会**抢 stdin**（密码与脚本都从 stdin 读）→ 什么都不执行；
要靠 `sudo -S bash <上传到 /tmp 的脚本>`。

## ★ 铁律 16：BuildKit 被 registry mirror 401 拒时，先 `docker pull` ★

现象（NAS 建基础镜像）：
`ERROR: failed to resolve source metadata for docker.io/library/maven:… :
unexpected status from HEAD request to https://docker.fnnas.com/v2/library/maven/manifests/…: 401 Unauthorized`
根因：`docker build` 由 **BuildKit** 探测 manifest，走 mirror 的**匿名**通道 → 401；
而 `docker pull` 走**带鉴权**通道，**能成功**。
解法：先 `docker pull <镜像>`，本地有镜像后 BuildKit 直接吃本地 store、不再探测 → 构建通过。
诊断顺序：先看 `docker pull` 行不行，行就说明是 BuildKit 探测路径问题，不是网络不通。

## ★ 铁律 17：`app/` 拆包后必须跑名字解析检查 ★

把 `app/main.py`(1445 行) 拆成 `app/routers/` 后，`make_raw_url` 留在了 `rawlink.py`，
而 `onlyoffice.py`/`preview.py`/`cad.py` 都调用它、**却没 import** →
**OnlyOffice + kkFileView + CAD 三条预览链路全部 500**（前端只看到「无法打开编辑器
Internal Server Error」）。而 `run_unit_tests.sh` / `selfcheck.py` / `import app.main` /
Dockerfile 的 `compileall` **全绿** —— 因为是**调用时**才 NameError。
⇒ **拆包/大改后端后必跑 `bash nebula/tools/run_static_checks.sh`**（名字解析 + 换行符 +
**两套护栏的自检**：拿 `_undef_fixtures/`、`_eol_fixtures/` 跑，必须**恰好**报出预期数量、
正例零误伤。护栏没被验证过 = 没有护栏）。
**共用助手一律放 `webutil.py`**，不要留在某个 router 里让别的 router 反向 import。

## ★ 铁律 18：OnlyOffice 预检要查「能不能真转换」，不只是「网络通不通」★

`up.sh` 的 `preflight_oo` 原先只查 共同网络 / OO 内取 `/healthz` / JWT 一致 —— **全绿也可能
完全不能转换**。真实案例：重构 `deploy/docker-compose.yml` 时**漏掉了 onlyoffice 的 `/tmp`
tmpfs**（旧编排有 `- /tmp:rw,exec,size=2G,mode=1777`），而目标 NAS 的 OO 镜像自带 `/tmp` 是
`drwxr-xr-x 1001:1002` → 转换必 EACCES，**而预检照样报全 ✓**。
⇒ `preflight_oo` 已新增 **§③：以 `--user ds` 真在 `/tmp` 建一次目录**，不通过就报错 + 给修法。
⇒ 端到端**决定性判据**永远是**真跑一次转换**：`{"payload":{...}}` 做 HS256 → POST `/converter`
→ 期望 `percent:100 endConvert:true`。
★ 字段名是 **`outputtype`**（不是 `outputformat`！写错只得到 `{"error":-7}`，
docservice 日志才说 `convertRequest unexpected outputtype = `）。

## ★ NAS 生产部署（TPNAS，2026-09-21 迁移后）★

| 项 | 值 |
|---|---|
| 源码目录 | `/vol1/1000/Docker/NebulaDisk`（共享给其他电脑编译；旧副本 `.bak-<ts>`） |
| 部署目录 | `/vol1/1000/NebulaDisk`（`.env` + 数据；旧 allinone compose 留存为 `.bak-*`） |
| 编排 / 入口 | `deploy/docker-compose.yml`，项目名 `nebuladisk`，网络 `nebula-net`；<br>`bash /vol1/1000/Docker/NebulaDisk/deploy/up.sh /vol1/1000/NebulaDisk` |
| 访问 | `http://172.16.30.128:8089`（管理员 `tao_zhang`） |
| 三个盘 | `/vol1/1000/{售前项目,研发立项,项目设计}` → 容器 `/mnt/{share,photos,private}` |
| 数据 | `data/`（`nebula.db` + `secret.key`，**复用即保住老会话与分享链接**）、`data-kk/`、`onlyoffice/` |
| 宿主 | uid 1000 `tao_zhang`（`Administrators` 组）；docker 需 `sudo`（密码同 SSH） |

- **项目名恰好相同是关键**：旧栈 working_dir 是 `/vol1/1000/NebulaDisk`，compose 取目录名 →
  也是 `nebuladisk`；新编排写死 `name: nebuladisk` ⇒ `up -d` **原地接管同一批容器**，不留孤儿。
  目录名不同的机器要显式 `-p nebuladisk`。
- ★ **容器内路径是固定契约**：`/mnt/share|photos|private`。老部署若用 `/mnt/售前项目` 这类
  自定义路径，**必须同步改 `NEBULA_MOUNTS` 第二段**。分享记的是「显示名 + 相对路径」，
  **显示名没变就都还有效**。
- ★ `NB_SRC_DIR` **看似只有构建用，实际必须填**（见铁律 10⑦）。
- NAS 的 registry mirror 是 `docker.fnnas.com` / `registry.hub.docker.com`
  （见铁律 16）；`registry-1.docker.io` 直连不通。Docker root `/vol1/docker`（7.1T 可用）；
  **NAS 上 pip 出网约 200KB/s**，Maven/apt 走阿里云。

## 其他关键约定（全部细节在附录，按需读）

- **WM**（窗口管理器）：`--toolbar-h:29px`；**resize 热区是 JS 动态生成、样式全在 inline**；
  窗口 id 恒为 `explorer:<mount>`（`opts.newWindow` 已废除）；**iframe 置顶必须每次 load 后重绑**；
  **`n` 边右端必须紧贴 `ne` 角，不许为三键挖空**（会留 ~110px 死区）；热区必须**严丝合缝铺满
  周长**；几何起点用 `_posOf()`；拖动钳位只有 `KEEP=120px`；**可用桌面高度 = `vh − taskbarH`**；
  预览窗口 id 不含文件路径 → 翻页必须走 `Viewer.step → reopenInto → WM.reopen` —— **附录 §2**
- **预览窗口两条不变量**：①**翻页只在同 kind 内**（`kindOf` 判定顺序必须与 `open()` 路由优先级
  一致，三处接线点漏一个就退化，列表来源是 `visibleEntries(S)`）；②**iframe 窗口靠透明点击盾
  `.iframe-shield` 置顶** —— **附录 §10**
- **预览引擎分工**：**只有 13 个走 OnlyOffice**（`doc docx docm · xls xlsx xlsm · ppt pptx pptm ·
  pdf csv tsv rtf`），其余全走 kkFileView；护栏 `OO_EDIT_EXT ⊆ KK_EXT` 且 `len ≤ 15` —— **附录 §11**
- **测试**：**必跑** `bash nebula/tools/run_static_checks.sh`（后端静态，最易漏）+ `run_unit_tests.sh`
  （8 套 JS/316 条）+ `run_share_tests.sh`（48 条）+ `_share_e2e.sh` + 真浏览器 `_tf_run.sh` 等
- **测试环境**、**压缩包预览已知行为**、**CAD 查看器**、**共享拷贝**、**运维**、
  **agent-browser 三个致命坑** —— 全部见**附录 §12 / 附录 §1 / CAD 节 / §8 / §12 / §5**
