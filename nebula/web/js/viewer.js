/* ==========================================================================
   NebulaDisk —— 文件查看器 / 编辑器
   --------------------------------------------------------------------------
   按扩展名路由到三套引擎：
     - onlyoffice : Office 文档 + PDF，可编辑，改完自动存回磁盘
     - kkfileview : 图片/压缩包/CAD/OFD/代码等只读预览（kkFileView 的强项）
     - native     : 图片/视频/音频/纯文本直接用浏览器原生能力，最快也最稳
     - download   : 无预览能力，只能下载

   为什么原生的类型不走 kkFileView？
     图片、音视频、纯文本浏览器自己就能渲染，本地打开是**零延迟**的；
     绕到 kkFileView 反而要等一次服务端转换和一次跳转。
     所以策略是：能用原生就用原生，原生搞不定才交给 kkFileView。
   ========================================================================== */

const Viewer = (() => {

  /* ----------------------------------------------------------------------
     ★ 每次载入都刷新「浏览器真实 host / 协议」Cookie（2026-10-03）★
     ----------------------------------------------------------------------
     为什么必须放在**顶层**，而不是只在 openOnlyOffice 里写：

       飞牛 App 是**按会话分配端口**的（实测见过 34043 / 42651 / 46023 三个），
       而 Cookie 不区分端口 ⇒ 上一次会话写下的 `oo_host=<旧端口>` 会一直留着。
       nginx 的 `$fwd_host`（即后端 `_origin()` 拼绝对地址的依据）会沿用这个值，
       于是**新会话里生成的图纸/文档地址指向上一次会话的端口** ⇒ 浏览器跨源取不到
       ⇒ CAD 一直转圈。

       实证（2026-10-03 探针 + nginx 日志）：
         · `/api/cad/preview` 请求：`fwd=office.app.5ddd.com:34043`（旧 Cookie）
           而 `ref="https://office.app.5ddd.com:46023/"`（浏览器真实当前地址）
           ⇒ 后端把图纸地址拼成 `…:34043/api/raw/xxx.dwg`
         · 页面在 `:46023` ⇒ 跨源 ⇒ 图纸与 libredwg-web.wasm 都取不到（各 0 条请求）。

       nginx 侧已同时改成「Referer 优先、Cookie 兜底」；
       这里再保证**没有 Referer 的请求（如 WebSocket 握手）**也能拿到当次会话的 host。
     ---------------------------------------------------------------------- */
  try {
    document.cookie = `oo_host=${location.host}; path=/; SameSite=Lax`;
    document.cookie = `oo_proto=${location.protocol.replace(':', '')}; path=/; SameSite=Lax`;
  } catch { /* 尽力而为 */ }

  /* ----------------------------------------------------------------------
     ★ 临时诊断上报（2026-10-03，定位完必须删）★
     ----------------------------------------------------------------------
     借道一个必然 404 的路径，**目的只是让它落进 nebula-front 的 access log**
     （不依赖后端加接口、不依赖三方服务）。日志里搜 `__oodiag__` 即可。

     原本它只是 openOnlyOffice() 里的局部函数，所以「媒体/图片等原生路径」
     根本不上报 —— 而手机上「点 mp4 毫无反应、服务端零请求」正好落在盲区里。
     现在提升到模块级，并额外挂全局错误捕获，覆盖**所有**打开路径。
     ---------------------------------------------------------------------- */
  const diag = (tag, info) => {
    try {
      const s = `${tag}|${typeof info === 'string' ? info : JSON.stringify(info)}`.slice(0, 700);
      const img = new Image();
      img.src = `/__oodiag__/${encodeURIComponent(s)}?_=${Date.now()}`;
    } catch { /* 尽力而为，绝不影响主流程 */ }
  };

  // 全局兜底：任何未捕获的异常/拒绝都上报（一次注册，覆盖全部路径）
  try {
    window.addEventListener('error', (ev) => {
      diag('win-error', `${(ev && ev.message) || ''} @ ${(ev && ev.filename) || ''}:${(ev && ev.lineno) || 0}`);
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev && ev.reason;
      diag('win-reject', String((r && r.message) || r || '').slice(0, 200));
    });
  } catch { /* 忽略 */ }

  /* ----------------------------------------------------------------------
     预览上下文：记录「当前窗口是从哪个文件夹、按什么顺序打开的」
     ----------------------------------------------------------------------
     需求（原文）：「在预览窗口，增加可以切换上一个和下一个文件。
     这样的预览和编辑 不单独打开窗口。类似看图片上一张，下一张这样。」

     要做到「上一张 / 下一张」，窗口必须知道三件事：
       1) 当前在哪个挂载点、哪个目录；
       2) 这个目录里**可预览**的文件有哪些、顺序如何（与资源管理器列表一致）；
       3) 当前是其中第几个。

     这些信息由资源管理器在打开预览时一并传来（Viewer.open 的第 4 个参数），
     存进下面这个 map。key 用的是**窗口 id 的前缀**（引擎类型），
     因为同一个文件可能被不同引擎打开（例如 docx 既能 OO 又能 KK 兜底），
     而窗口 id 里已经包含了 mount+path，天然唯一。

     ⚠️ 为什么不让 viewer 自己去 list 一遍目录？
        那样会多一次网络请求，而且**顺序可能与用户看到的列表不一致**
       （资源管理器有自己的排序：文件夹在前、目录优先等）。
        直接用资源管理器当前的那份列表，才能保证「上一张/下一张」
        与用户眼前的顺序完全对应。
     ---------------------------------------------------------------------- */
  const ctxOf = new Map();   // winId -> { mount, dir, files:[{name,ext,route,isDir}], index }

  // ★ 预览窗口序号 ★
  //   让「同一个挂载点」可以同时开多个预览/编辑窗口：
  //   id 末尾带上自增序号，WM.open 才不会因 id 相同而复用旧窗口
  //   （原来的 id 是 `类型:${mount}`，不含文件路径）。
  //   窗口内的「上一个/下一个」仍是原地换内容（WM.reopen），不受影响。
  let viewSeq = 0;

  function setContext(winId, ctx) {
    if (winId && ctx) ctxOf.set(winId, ctx);
  }

  /** 从候选列表里挑出「真正能被预览/编辑」的文件（文件夹与不可预览项跳过） */
  function previewableList(entries) {
    return (entries || []).filter((e) => e && !e.isDir && e.name && e.name[0] !== '.');
  }

  /* ----------------------------------------------------------------------
     ★ 「同类文件」判定 —— 翻页不许跨类型 ★

     需求（原文）：「照片预览 上面的总数目前是所有文件的总数，但是切换时
     到别的类型文件时，提示无法显示这张照片。而不是调用其他程序打开该文件。」

     根因：翻页列表原来只是「所有可预览文件」—— 于是看照片时按「下一个」
     会走进 工时表.csv / 脚本.py 这类文件，交给 <img> 自然就是
     「无法显示这张照片」。用户要的是**图片只翻图片**。

     设计：给每个文件算一个 kind，翻页只在**同 kind** 范围内进行。
     这样：
       · 图片窗口的「n / m」= 本目录里图片的数量（不再把所有文件都算进去）
       · 「下一个」永远落到另一个能真被这个引擎渲染的文件上
       · 到同类末尾就置灰，而不是跳到别的类型去报错

     kind 的取值（与 open() 的路由分支一一对应）：
       'image' | 'video' | 'audio' | 'text' | 'cad' | 'onlyoffice' | 'kkfileview' | null
       返回 null 表示这个文件没有内置预览器（只提供下载），不参与翻页。
     ---------------------------------------------------------------------- */
  function kindOf(entry, path) {
    if (!entry || entry.isDir) return null;
    const name = entry.name || (path || '').split('/').pop() || '';
    const ext = ((entry.ext || guessExt(name)) + '').toLowerCase();

    // ★ 顺序必须与 open() 的路由优先级一致 ★
    //   否则会出现「判定成一类、却由另一个引擎打开」的错位。
    if (entry.route === 'cad') return 'cad';
    if (entry.route === 'onlyoffice') return 'onlyoffice';

    const native = nativeKind(ext);
    if (native) return native;          // image / video / audio / text

    if (entry.route === 'kkfileview') return 'kkfileview';
    return null;                        // 只能下载
  }

  /** 只留与 target 同为 kind 的文件（翻页的候选集） */
  function siblingsOfKind(entries, kind) {
    if (!kind) return [];
    return previewableList(entries).filter((e) => kindOf(e) === kind);
  }

  function ctxFor(winId) {
    return ctxOf.get(winId) || null;
  }

  /** 记录某个窗口当前正在展示的文件名（供 refreshContext 重新定位 index） */
  function noteCurrent(winId, name) {
    const c = ctxFor(winId);
    if (c) c.currentName = name;
  }

  /**
   * 目录内容变化后（新建/删除/重命名/上传），刷新某个目录下所有预览窗口的
   * 兄弟列表，并把 index 重新定位到「当前文件」。
   *
   * 为什么要这个：如果用户在预览 a.png 时把 b.png 删了，
   * 窗口里记的 files 还是旧数组 → 「下一个」会指向一个已经不存在的文件。
   * 资源管理器在自己刷新后调用这里，预览窗口的翻页就始终对得上。
   *
   * 注意：如果**当前正在预览的文件**本身被删了，我们不动窗口
   * （用户可能正在看最后一眼），只把 index 标成 -1 → 翻页暂时禁用，
   * 等用户自己翻页或关窗。
   */
  function refreshContext(mount, dir, entries) {
    ctxOf.forEach((c, winId) => {
      if (c.mount !== mount || c.dir !== dir) return;
      // ★ 必须继续按 kind 过滤 ★
      //   否则目录一刷新，列表就被换成"所有可预览文件"，
      //   「图片只翻图片」当场失效 —— 本文件改动前正是这个行为。
      //   kind 为空的窗口（旧上下文）退回原来的宽松列表，保持兼容。
      const list = c.kind
        ? siblingsOfKind(entries, c.kind)
        : previewableList(entries);
      // ★ 先定位「用户当前正在看的那个文件」，再换列表 ★
      //   优先用 currentName（step 翻页时会更新它）；
      //   若拿不到（历史窗口没登记过），就退回用**旧列表里 index 指向的名字**
      //   —— 这点很关键：如果只依赖 currentName，那些通过 setContext 直接
      //   打开、从没翻过页的窗口会算出 index = -1，翻页按钮当场消失。
      let nm = c.currentName;
      if (!nm && c.files && c.index != null && c.index >= 0) {
        const old = c.files[c.index];
        if (old) nm = old.name;
      }
      c.files = list;
      const i = nm ? list.findIndex((e) => e.name === nm) : -1;
      c.index = i;
      if (i >= 0) c.currentName = nm;
    });
  }

  /** 给定窗口上下文，算出上一个/下一个文件（返回 null 表示到头了） */
  function neighbor(winId, delta) {
    const c = ctxFor(winId);
    if (!c || !c.files || !c.files.length) return null;
    const i = c.index;
    if (i == null || i < 0) return null;
    const j = i + delta;
    if (j < 0 || j >= c.files.length) return null;
    return { entry: c.files[j], index: j };
  }

  function canGo(winId, delta) { return !!neighbor(winId, delta); }

  /**
   * 在当前窗口里切到「上一个/下一个」。
   * ★ 用 WM.reopen 原地重开 —— 不新开窗口、不闪、几何与层级都保持 ★
   * 这正是用户要的「类似看图片上一张，下一张」。
   */
  function step(winId, delta) {
    const c = ctxFor(winId);
    const nb = neighbor(winId, delta);
    if (!c || !nb) return false;
    const e = nb.entry;
    // ★ 最后一道防线：绝不允许跨类型翻页 ★
    //   列表本身已经按 kind 过滤过（见 makeCtx / refreshContext），
    //   这里再挡一次是为了防住"旧上下文"（kind 为空、列表还是老的宽列表）
    //   以及将来有人误改过滤逻辑 —— 一旦跨类型，图片窗口就会拿到
    //   非图片文件并显示「无法显示这张照片」，正是用户报的问题。
    if (c.kind && kindOf(e) !== c.kind) return false;
    c.index = nb.index;
    c.currentName = e.name;
    const p = joinPath(c.dir, e.name);
    // 原地重开：opts 由 open() 那套工厂按新文件重新生成
    reopenInto(winId, c.mount, p, e);
    return true;
  }

  /* ----------------------------------------------------------------------
     入口
     ---------------------------------------------------------------------- */

  /**
   * 统一构造预览上下文。
   *
   * 对外开放的 openXxx 有两种调用姿势：
   *   · Viewer.open(...)            → 内部已经算好 ctx，直接传对象；
   *   · Viewer.openOnlyOffice(...)  → 右键菜单直接调用，传的是
   *                                   (mount, path, entry, siblings, dirPath)。
   * 为免得每个入口都写一遍兼容分支，这里统一收口：
   * 传入对象就当 ctx（补齐缺省字段），传入数组/undefined 就现算。
   */
  function makeCtx(mount, path, siblingsOrCtx, dirPath) {
    const name = (path || '').split('/').pop();
    if (siblingsOrCtx && !Array.isArray(siblingsOrCtx)
        && typeof siblingsOrCtx === 'object' && 'files' in siblingsOrCtx) {
      const c = siblingsOrCtx;
      return {
        mount: c.mount != null ? c.mount : mount,
        dir: c.dir != null ? c.dir : (dirPath != null ? dirPath : dirnameOf(path)),
        files: c.files || [],
        index: c.index != null ? c.index : -1,
        currentName: c.currentName || name,
        // ★ kind 必须一并继承 ★ 翻页时要靠它判断"还能不能往前走"，
        //   丢了它就会退化成"所有文件都能翻"（本次要修的老毛病）。
        kind: c.kind != null ? c.kind : null,
      };
    }

    // ★ 只取「与当前文件同类型」的兄弟 ★
    //   这就是「图片只翻图片」的实现点：m 从此等于本目录图片数，
    //   而不是本目录所有文件数。
    const all = Array.isArray(siblingsOrCtx) ? siblingsOrCtx : [];
    const dir = dirPath != null ? dirPath : dirnameOf(path);
    const me = all.find((e) => e && e.name === name) || null;
    const kind = kindOf(me, path);
    const list = kind ? siblingsOfKind(all, kind) : previewableList(all);
    let index = -1;
    if (list.length) index = list.findIndex((e) => e.name === name);
    return { mount, dir, files: list, index, currentName: name, kind };
  }

  function open(mount, path, entry, siblings, dirPath) {
    const ext = (entry && entry.ext ? entry.ext : guessExt(path)).toLowerCase();
    const name = path.split('/').pop();
    const ctx = makeCtx(mount, path, siblings, dirPath);

    // ★ 临时诊断：到底走没走到这里、判成了什么（2026-10-03，定位完删）★
    //   手机上「点 mp4 毫无反应、服务端零请求」需要先确认是**没进 open()**
    //   （多半是单点/双击的差别）还是**进了 open() 但后面炸了**。
    diag('open', `${name}|ext=${ext}|route=${(entry && entry.route) || '-'}`
      + `|native=${nativeKind(ext)}|n=${(siblings || []).length}`);

    // 1) CAD 图纸 → 独立 cad-viewer 服务（渲染质量最好，优先于其它引擎）
    if (entry && entry.route === 'cad') {
      return openCAD(mount, path, name, ctx);
    }

    // 2) Office / PDF → OnlyOffice
    if (entry && entry.route === 'onlyoffice') {
      return openOnlyOffice(mount, path, entry, ctx);
    }

    // 3) 浏览器原生能搞定的
    const native = nativeKind(ext);
    if (native === 'image')  return openImage(mount, path, name, ctx);
    if (native === 'video')  return openMedia(mount, path, name, 'video', ctx);
    if (native === 'audio')  return openMedia(mount, path, name, 'audio', ctx);
    if (native === 'text')   return openText(mount, path, name, ctx);

    // 4) 交给 kkFileView
    if (entry && entry.route === 'kkfileview') {
      return openKK(mount, path, name, ctx);
    }

    // 5) 兜底：询问是否下载
    askDownload(mount, path, name);
  }

  /** 目录部分（用于把「文件名」还原成完整路径） */
  function dirnameOf(p) {
    const i = (p || '').lastIndexOf('/');
    return i < 0 ? '/' : (i === 0 ? '/' : p.slice(0, i));
  }

  /** 路径规范化 —— 与 explorer.js 的 normPath 语义保持一致 */
  function normPath(p) {
    if (!p) return '/';
    p = String(p).replace(/\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    p = p.replace(/\/+/g, '/');
    if (p.length > 1) p = p.replace(/\/$/, '');
    return p || '/';
  }

  /**
   * 拼接目录与文件名。
   * ★ 注意与 explorer.js 的 joinPath 完全同语义 ★
   *   根目录时结果是 `name`（**不带**前导斜杠），不是 `/name`。
   *   这点很关键：预览接口按 mount+path 取文件，多一个斜杠就可能 404。
   *   （explorer 的 joinPath 是它 IIFE 内的私有函数，没有挂到 window，
   *    所以这里不能借用，必须自己实现一份同语义的。）
   */
  function joinPath(dir, name) {
    const d = normPath(dir);
    return d === '/' ? name : `${d}/${name}`;
  }

  /**
   * 原地把某个预览窗口换成另一个文件。
   * 由各 openXxx 注册进 reg（见下），这样 step() 不必知道引擎细节。
   */
  const reg = new Map();   // winId -> (mount, path, entry) => void
  // ★ winId -> DocsAPI.DocEditor 实例（2026-10-03 加）★
  //   为什么必须有这个 Map：OnlyOffice 的编辑器实例**吃内存极大**
  //   （单 sdk-all.js 就 28.8MB，运行时还要建 canvas / WebSocket / 各种定时器），
  //   而原来的 onClose 只清 reg/ctxOf，**从不调用 destroyEditor()**
  //   ⇒ 窗口关掉的只是 DOM，JS 实例还活着、内存不还。
  //   手机（飞牛 App 的 webview）内存本来就紧，用户连开几次 Office 文件后
  //   （实测 13:53–14:04 反复打开同一个 xlsx 8 次，日志里出现 5 个
  //     frameEditorId=oo-host-oo_____-1…-5）内存会累积到撑不住
  //   ⇒ 编辑器起不来、报「下载失败」。关窗必须显式销毁。
  const editors = new Map();   // winId -> editor

  function reopenInto(winId, mount, path, entry) {
    const fn = reg.get(winId);
    if (fn) { fn(mount, path, entry); return; }
    // 没注册过（异常情况）→ 退化成新开窗口，至少功能可用
    open(mount, path, entry);
  }

  function guessExt(path) {
    const n = path.split('/').pop() || '';
    return n.includes('.') ? n.split('.').pop() : '';
  }

  function nativeKind(ext) {
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif'].includes(ext))
      return 'image';
    if (['mp4', 'webm', 'ogv', 'm4v'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'].includes(ext)) return 'audio';
    // ⚠️ txt 不在 OnlyOffice 的编辑白名单里时走原生；这里只在 route 判定为
    //    kkfileview/download 时才会被调用，所以列出的都是「原生更优」的类型
    if (['txt', 'log', 'md', 'markdown', 'json', 'xml', 'csv', 'ini', 'conf',
         'yml', 'yaml', 'css', 'js', 'ts', 'py', 'java', 'go', 'rs', 'c', 'cpp',
         'h', 'sh', 'bat', 'sql', 'properties', 'toml', 'env', 'gitignore'].includes(ext))
      return 'text';
    return null;
  }

  const rawUrl = (mount, path, inline = false) =>
    API.downloadUrl(mount, path, inline);

  /* ----------------------------------------------------------------------
     视频「能播」地址  GET /api/play
     ----------------------------------------------------------------------
     服务端会探测视频轨编码：**不是 HEVC 就 302 回原来的流**（零成本、行为不变），
     是 HEVC 才用 ffmpeg 转成 H.264 再发（结果落盘缓存）。

     为什么不一开始就用它：非 HEVC 时每一次 Range 请求都要多过一次探测，
     而原流本来就没问题 —— 没必要绕。
     所以**只在原生播放报「格式不支持」(error.code=4) 时才切过来**。
     背景：手机 WebView 不解 H.265 —— 同一个 mp4 电脑能播、手机黑屏，
     就是这一条。详见后端 routers/fileops.py 的 /api/play 说明。
     ---------------------------------------------------------------------- */
  const playUrl = (mount, path) =>
    '/api/play?' + new URLSearchParams({ mount, path }).toString();

  /* ----------------------------------------------------------------------
     上一个 / 下一个（各预览窗口共用的导航条）
     ----------------------------------------------------------------------
     · 只有在**同目录里还有可预览的兄弟文件**时才显示，
       且位置信息（第 n / 共 m）只在确实有多于一个文件时才给，
       避免单个文件时出现无意义的「1 / 1」。
     · 到头时按钮置灰（disabled），而不是隐藏 —— 位置稳定，用户能预期。
     · 数据来源是打开时传进来的 ctx（与资源管理器列表同序），
       所以「下一个」就是用户眼里表格里的下一行。
     ---------------------------------------------------------------------- */
  function navBtns(winId) {
    const c = ctxFor(winId);
    const total = c && c.files ? c.files.length : 0;
    if (total <= 1 || !c || c.index < 0) return '';
    const prevOk = canGo(winId, -1);
    const nextOk = canGo(winId, +1);
    return `
      ${WM.Toolbar.sep()}
      <button class="tb-btn nav-btn" data-a="prev" title="${prevOk ? '上一个文件' : '已经是第一个'}"
              ${prevOk ? '' : 'disabled'}>${Icons.ui('prev')}</button>
      <span class="wt-num nav-pos" data-role="navpos">${c.index + 1} / ${total}</span>
      <button class="tb-btn nav-btn" data-a="next" title="${nextOk ? '下一个文件' : '已经是最后一个'}"
              ${nextOk ? '' : 'disabled'}>${Icons.ui('next')}</button>`;
  }

  /** 统一的翻页点击处理：返回 true 表示本次点击已被导航消费掉 */
  function handleNavClick(winId, a) {
    if (a === 'prev') return step(winId, -1), true;
    if (a === 'next') return step(winId, +1), true;
    return false;
  }

  /* ----------------------------------------------------------------------
     图片查看器（带缩放/旋转/适应窗口）
     ---------------------------------------------------------------------- */
  function openImage(mount, path, name, ctx) {
    // ★ 窗口 id 不再包含文件路径 ★
    //   因为「上一个/下一个」要**原地换内容**，如果用 `img:mount:path` 做 id，
    //   换个文件就变成另一个 id 了，reopen 找不到窗口，只能新开一个 ——
    //   正是用户明确不要的行为。所以 id 只跟「这是哪个预览窗口」有关。
    //   一个文件夹里同时开两个图片预览会合并成一个窗口，这符合看图软件的直觉。
    const id = `img:${mount}-${++viewSeq}`;
    setContext(id, ctx);

    const render = (body, m2, p2, nm) => {
      // 状态跟着窗口走（换文件时重置为新文件的初始视图）
      const st = { zoom: 1, rotate: 0, fit: true };

      const bar = WM.Toolbar.build({
        title: nm,
        left: [
          WM.Toolbar.btn('zoomout', 'zoomOut', '缩小'),
          WM.Toolbar.btn('zoomin', 'zoomIn', '放大'),
          WM.Toolbar.btn('fit', 'fit', '适应窗口'),
          WM.Toolbar.btn('rotate', 'refresh', '旋转'),
        ],
        right: [
          `<span data-role="zlabel" class="wt-num">适应</span>`,
          navBtns(id),
          WM.Toolbar.sep(),
          WM.Toolbar.btn('open', 'external', '新标签打开'),
          WM.Toolbar.btn('save', 'download', '下载'),
        ],
      });
      body.innerHTML = `
        <div class="win-col">
          ${bar}
          <div class="media-stage" data-role="stage"
               style="background:#0f0f0f">
            <img data-role="img" src="${esc(rawUrl(m2, p2, true))}"
                 alt="${esc(nm)}" draggable="false"
                 style="transform-origin:center;transition:transform 120ms ease-out">
          </div>
        </div>`;

      const img = body.querySelector('[data-role="img"]');
      const stage = body.querySelector('[data-role="stage"]');
      const zlabel = body.querySelector('[data-role="zlabel"]');

      function apply() {
        if (st.fit) {
          img.style.maxWidth = '100%';
          img.style.maxHeight = '100%';
          img.style.transform = `rotate(${st.rotate}deg)`;
          zlabel.textContent = '适应';
        } else {
          img.style.maxWidth = 'none';
          img.style.maxHeight = 'none';
          img.style.transform = `scale(${st.zoom}) rotate(${st.rotate}deg)`;
          zlabel.textContent = Math.round(st.zoom * 100) + '%';
        }
      }
      apply();

      body.querySelector('.win-toolbar').addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (!b || b.disabled) return;
        const a = b.dataset.a;
        if (handleNavClick(id, a)) return;      // ★ 上一个 / 下一个
        if (a === 'zoomin')       { st.fit = false; st.zoom = Math.min(8, st.zoom * 1.25); }
        else if (a === 'zoomout') { st.fit = false; st.zoom = Math.max(0.08, st.zoom / 1.25); }
        else if (a === 'fit')     { st.fit = true; st.zoom = 1; }
        else if (a === 'rotate')  { st.rotate = (st.rotate + 90) % 360; }
        else if (a === 'open')    { window.open(rawUrl(m2, p2, true), '_blank'); return; }
        else if (a === 'save')    { download(m2, p2, nm); return; }
        apply();
      });

      // 滚轮缩放（符合看图软件习惯）
      stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        st.fit = false;
        st.zoom = Math.max(0.08, Math.min(8, st.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        apply();
      }, { passive: false });

      // 拖拽平移（放大后才有意义）
      let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      stage.addEventListener('mousedown', (e) => {
        if (st.fit || st.zoom <= 1) return;
        dragging = true; sx = e.clientX; sy = e.clientY;
        ox = stage.scrollLeft; oy = stage.scrollTop;
        stage.style.cursor = 'grabbing';
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        stage.scrollLeft = ox - (e.clientX - sx);
        stage.scrollTop = oy - (e.clientY - sy);
      });
      document.addEventListener('mouseup', () => {
        dragging = false;
        stage.style.cursor = '';
      });

      img.addEventListener('error', () => {
        // ★ 兜底要给出"出口"，不能只报一句无法显示 ★
        //   用户原文：「到别的类型文件时，提示无法显示这张照片。
        //              而不是调用其他程序打开该文件。」
        //   两道保障：① 翻页已经按 kind 过滤，正常不会走到这里；
        //            ② 万一真走到（文件损坏 / 其实是伪装扩展名），
        //               必须给出「下载」与「新标签打开」两条现成出路。
        stage.innerHTML = `<div style="color:#ddd;text-align:center;padding:30px;max-width:420px">
          <div style="font-size:15px;margin-bottom:8px">无法显示这张图片</div>
          <div style="font-size:12.5px;opacity:.7;margin-bottom:16px">
            ${esc(nm)} 不是浏览器能直接显示的图片格式，或文件已损坏。
          </div>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
            <button class="btn" data-role="err-open">在新标签打开</button>
            <button class="btn" data-role="err-save">下载到本地</button>
          </div>
        </div>`;
        const bo = stage.querySelector('[data-role="err-open"]');
        const bs = stage.querySelector('[data-role="err-save"]');
        if (bo) bo.addEventListener('click', () => window.open(rawUrl(m2, p2, true), '_blank'));
        if (bs) bs.addEventListener('click', () => download(m2, p2, nm));
      });
    };

    // 注册「原地换文件」：翻页时 WM.reopen 会用新文件重跑同一个 render
    reg.set(id, (m2, p2) => {
      const nm = p2.split('/').pop();
      WM.reopen(id, {
        title: nm, icon: Icons.ui('image', 16),
        render: (body) => render(body, m2, p2, nm),
      });
    });

    return WM.open({
      id, title: name, icon: Icons.ui('image', 16),
      width: 940, height: 680, minWidth: 400, minHeight: 300,
      chromeless: true,
      render: (body) => render(body, mount, path, name),
      // ★ 多开时 reg/ctxOf 以 winId 为 key 会随窗口数累积 ⇒ 关窗必须清理 ★
      onClose: () => { reg.delete(id); ctxOf.delete(id); },
    });
  }


  /* ----------------------------------------------------------------------
     媒体播放器
     ---------------------------------------------------------------------- */
  /* 在媒体窗口里浮一条提示（「正在转码…」/「编码不支持」）。
     故意不做成 modal：转码是后台行为，期间用户仍能拖进度条、点下载。 */
  function showMediaTip(body, text) {
    const stage = body.querySelector('.media-stage');
    if (!stage) return;
    let t = stage.querySelector('.media-tip');
    if (!t) {
      t = document.createElement('div');
      t.className = 'media-tip';
      stage.appendChild(t);
    }
    t.textContent = text;
  }

  function openMedia(mount, path, name, kind, ctx) {
    const id = `media:${mount}:${kind}-${++viewSeq}`;   // ★ id 不含 path，见 openImage 的说明
    setContext(id, ctx);

    const render = (body, m2, p2, nm) => {
      const src = esc(rawUrl(m2, p2, true));
      const bar = WM.Toolbar.build({
        title: nm,
        left: [WM.Toolbar.btn('save', 'download', '下载')],
        right: [navBtns(id)],
      });
      body.innerHTML = `
        <div class="win-col">
          ${bar}
          <div class="media-stage">
            ${kind === 'video'
              ? `<video src="${src}" controls autoplay playsinline
                        style="max-width:100%;max-height:100%"></video>`
              : `<audio src="${src}" controls autoplay style="width:min(440px,90%)"></audio>`}
          </div>
        </div>`;
      body.querySelector('.win-toolbar').addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (!b || b.disabled) return;
        if (handleNavClick(id, b.dataset.a)) return;
        if (b.dataset.a === 'save') download(m2, p2, nm);
      });

      // ★ 临时诊断：媒体元素到底走没走（2026-10-03，定位完删）★
      //   三件事分开看：
      //     media-el    元素建出来了、src 是什么
      //     media-meta  浏览器真的取到流并解出元数据（= 有网络请求且成功了）
      //     media-err   取流/解码失败（error.code：1中止 2网络 3解码 4不支持）
      //   若只有 media-el、两条都没来 ⇒ 浏览器**根本没发请求**
      //   （Android WebView 的自动播放策略 / src 不可达都会这样）。
      try {
        const mediaEl = body.querySelector('video,audio');
        if (mediaEl) {
          diag('media-el', `${kind}|${src}`);
          mediaEl.addEventListener('loadedmetadata', () => diag(
            'media-meta',
            `${mediaEl.videoWidth || 0}x${mediaEl.videoHeight || 0}|rs=${mediaEl.readyState}`));

          // ── 播放失败自愈：H.265 自动转码 ─────────────────────────────
          //   error.code === 4（MEDIA_ERR_SRC_NOT_SUPPORTED）= 编码/容器不支持。
          //   实测最常见的是 **H.265 / HEVC**：桌面 Chrome 能解，而飞牛 App 的
          //   Android WebView 解不了 ⇒ 同一个文件「电脑能播、手机黑屏」。
          //   这里自动切到 /api/play（服务端探到 HEVC 才转码），并给出提示——
          //   否则用户只看到黑屏，不知道在等什么。
          //   ⚠️ 只重试一次，且**只在 code=4 时**：网络中断(2)/解码出错(3)重试没意义。
          let retried = false;
          mediaEl.addEventListener('error', () => {
            const code = (mediaEl.error && mediaEl.error.code) || 0;
            diag('media-err', `${code}|${(mediaEl.error && mediaEl.error.message) || ''}`);

            if (kind !== 'video') return;
            if (code !== 4) return;
            if (retried) {
              showMediaTip(body,
                '这个视频当前设备打不开。可点上方「下载」用本地播放器打开。');
              return;
            }
            retried = true;
            showMediaTip(body, '正在转码，请稍候…（该视频为 H.265 编码，首次播放需转换）');
            mediaEl.src = playUrl(m2, p2);
            mediaEl.load();
            mediaEl.play().catch(() => { /* 自动播放被拦就等用户点播放 */ });
          });
        } else {
          diag('media-el', 'NONE');
        }
      } catch { /* 忽略 */ }
    };

    reg.set(id, (m2, p2) => {
      const nm = p2.split('/').pop();
      WM.reopen(id, {
        title: nm, icon: Icons.ui(kind === 'video' ? 'play' : 'music', 16),
        render: (body) => render(body, m2, p2, nm),
      });
    });

    // ★ `chromeless: true` 是必须的 —— 少了它就是**两层窗口按钮** ★
    //   用户报障原话：「网盘内部 视频文件 打开，有两层 最小化，最大化，关闭按钮。
    //                  可以参照图片预览窗口」。
    //   根因：`WM.Toolbar.build()` 默认就会在**最右**渲染 min/max/close 三键
    //     （见 shell.js：`controls === false` 时才不渲染）；
    //   而 `WM.open` 不传 `chromeless` 又会渲染一个**独立标题栏**，里面
    //     也有一套 `.tb-btn[data-act]` 三键。
    //   ⇒ 视频/音频窗口里外各一套 = 用户看到的两层。
    //   图片预览（openImage）早就传了 chromeless，所以只有一层 —— 正是用户
    //     拿来对照的那个"参照物"。这里补齐为同一种形态：
    //     无标题栏，三键由工具栏承载，整条工具栏兼作拖拽手柄。
    //   ⚠️ 新增预览器时必须一起传 chromeless，否则同一个坑会再来一次；
    //      `tools/_test_window_controls.js` 会静态锁死这条约束。
    return WM.open({
      id, title: name, icon: Icons.ui(kind === 'video' ? 'play' : 'music', 16),
      width: kind === 'video' ? 880 : 520,
      height: kind === 'video' ? 560 : 180,
      chromeless: true,
      minWidth: kind === 'video' ? 420 : 320,
      minHeight: kind === 'video' ? 280 : 140,
      render: (body) => render(body, mount, path, name),
      // ★ 多开时 reg/ctxOf 以 winId 为 key 会随窗口数累积 ⇒ 关窗必须清理 ★
      onClose: () => { reg.delete(id); ctxOf.delete(id); },
    });
  }

  /* ----------------------------------------------------------------------
     文本查看器（带行号、自动换行开关）
     ---------------------------------------------------------------------- */
  function openText(mount, path, name, ctx) {
    const id = `text:${mount}-${++viewSeq}`;   // ★ id 不含 path，见 openImage 的说明
    setContext(id, ctx);

    const render = async (body, m2, p2, nm) => {
      const bar = WM.Toolbar.build({
        title: nm,
        left: [
          WM.Toolbar.btn('wrap', 'text', '自动换行'),
          WM.Toolbar.btn('copy', 'copy', '复制全文'),
          WM.Toolbar.btn('save', 'download', '下载'),
        ],
        right: [
          `<span data-role="meta" class="wt-num" style="min-width:0">加载中…</span>`,
          navBtns(id),
        ],
      });
      body.innerHTML = `
        <div class="win-col">
          ${bar}
          <pre class="text-view" data-role="text">正在读取…</pre>
        </div>`;

      const pre = body.querySelector('[data-role="text"]');
      const meta = body.querySelector('[data-role="meta"]');
      let wrapped = false;
      // 翻页后本次异步读取可能已过期（用户又翻了）→ 用 token 丢弃旧结果
      const token = ++readToken;
      body.__readToken = token;

      try {
        const resp = await fetch(rawUrl(m2, p2, true), { credentials: 'same-origin' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        if (token !== readToken) return;      // 已被更新的一次读取取代
        // 编码嗅探：优先 UTF-8，失败则回退 GBK（中文文本常见）
        let text = decodeSmart(buf);
        const lines = text.split('\n').length;
        pre.textContent = text;
        meta.textContent = `${lines} 行 · ${fmtSize(buf.byteLength)} · UTF-8`;
      } catch (e) {
        if (token !== readToken) return;
        pre.textContent = `读取失败：${e.message}`;
        meta.textContent = '读取失败';
      }

      body.querySelector('.win-toolbar').addEventListener('click', async (e) => {
        const b = e.target.closest('[data-a]');
        if (!b || b.disabled) return;
        const a = b.dataset.a;
        if (handleNavClick(id, a)) return;
        if (a === 'wrap') {
          wrapped = !wrapped;
          pre.style.whiteSpace = wrapped ? 'pre-wrap' : 'pre';
          pre.style.wordBreak = wrapped ? 'break-word' : 'normal';
        } else if (a === 'copy') {
          // ★ 2026-10-04：改走全局 `copyText`（原来只认 navigator.clipboard，
          //   在 App WebView / http:// 下点了没反应）★
          copyText(pre.textContent, '全文已复制到剪贴板');
        } else if (a === 'save') {
          download(m2, p2, nm);
        }
      });
    };

    reg.set(id, (m2, p2) => {
      const nm = p2.split('/').pop();
      WM.reopen(id, {
        title: nm, icon: Icons.ui('code', 16),
        render: (body) => render(body, m2, p2, nm),
      });
    });

    return WM.open({
      id, title: name, icon: Icons.ui('code', 16),
      width: 900, height: 640,
      chromeless: true,
      render: (body) => render(body, mount, path, name),
      // ★ 多开时 reg/ctxOf 以 winId 为 key 会随窗口数累积 ⇒ 关窗必须清理 ★
      onClose: () => { reg.delete(id); ctxOf.delete(id); },
    });
  }

  // 文本读取的「代」计数：翻页会 +1，旧的异步结果据此自弃
  let readToken = 0;

  /**
   * 智能解码：先按 UTF-8 严格解，有非法序列就试 GBK。
   * 纯靠 UTF-8 解会把中文乱码，而中文用户里 GBK 文件非常多。
   */
  function decodeSmart(buf) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      for (const enc of ['gbk', 'gb18030', 'big5', 'utf-16le']) {
        try {
          const t = new TextDecoder(enc).decode(buf);
          // 出现大量替换字符说明也不对，继续试下一个
          const bad = (t.match(/\uFFFD/g) || []).length;
          if (bad / Math.max(1, t.length) < 0.01) return t;
        } catch { /* 浏览器不支持该编码，跳过 */ }
      }
      return new TextDecoder('utf-8').decode(buf);
    }
  }

  /* ----------------------------------------------------------------------
     kkFileView 预览（iframe 内嵌，同源反代）

     ★ chromeless：不渲染标题栏 ★
       需求是「去掉 文件名—预览 那一行标题栏，把 最小化/最大化/关闭 放到工具栏
       最左边」。所以这里用 chromeless 打开窗口，窗口控制按钮改由工具栏承载，
       顺序为：[最小化][最大化][关闭] | 重新加载 新标签打开 下载
       工具栏本身带 [data-drag-handle]，拖拽/双击最大化仍然可用。
       文件名不再显示（任务栏与 tooltip 里仍有，避免丢失信息）。
     ---------------------------------------------------------------------- */
  function openKK(mount, path, name, ctx) {
    const id = `kk:${mount}-${++viewSeq}`;   // ★ id 不含 path：翻页要原地换内容，见 openImage 说明
    setContext(id, ctx);

    const render = (body, m2, p2, nm) => {
      // 统一工具栏：操作按钮在左，翻页与窗口三键在右（WM.Toolbar 保证一致）
      const bar = WM.Toolbar.build({
        title: nm,
        left: [
          WM.Toolbar.btn('reload', 'refresh', '重新加载'),
          WM.Toolbar.btn('newtab', 'external', '新标签打开'),
          WM.Toolbar.btn('download', 'download', '下载'),
        ],
        right: [navBtns(id)],
      });
      body.innerHTML = `
        <div class="win-col">
          ${bar}
          <div class="kk-frame-wrap">
            <div class="state-box" data-role="boot">
              <div class="spinner"></div>
              <div class="sb-title">正在准备预览…</div>
              <div class="sb-hint">首次打开需要服务端转换，大文件可能要等几秒</div>
            </div>
            <iframe class="viewer-frame" data-role="frame"
                    style="visibility:hidden" allowfullscreen></iframe>
          </div>
        </div>`;

      const frame = body.querySelector('[data-role="frame"]');
      const boot = body.querySelector('[data-role="boot"]');

      async function go() {
        boot.style.display = '';
        // ★ 用 visibility 而不是 display:none ★
        //   display:none 会把 iframe 从布局里摘掉，于是 iframe 内部
        //   clientWidth/clientHeight 全是 **0**。SVG 预览页在 window.onload
        //   里就要算「适应窗口」比例，拿到 0 就会算出 ~0 的缩放，
        //   图纸尺寸被设成 0.96px —— 表现就是「页面加载完了，但一片空白」。
        //   先让它参与布局（只是不可见），尺寸就是对的。
        frame.style.visibility = 'hidden';
        try {
          const r = await API.previewUrl(m2, p2);
          frame.src = r.url;
        } catch (e) {
          frame.style.visibility = 'visible';
          boot.innerHTML = `<div class="state-box-inner" style="text-align:center">
            ${Icons.ui('warn', 48)}
            <div class="sb-title">无法预览</div>
            <div class="sb-hint">${esc(e.message)}</div></div>`;
        }
      }

      frame.addEventListener('load', () => {
        frame.style.visibility = 'visible';
        boot.style.display = 'none';
      });

      body.querySelector('.win-toolbar').addEventListener('click', async (e) => {
        const b = e.target.closest('[data-a]');
        if (!b || b.disabled) return;
        const a = b.dataset.a;
        if (handleNavClick(id, a)) return;
        if (a === 'reload') go();
        else if (a === 'newtab') window.open(frame.src, '_blank');
        else if (a === 'download') download(m2, p2, nm);
      });

      go();
    };

    reg.set(id, (m2, p2) => {
      const nm = p2.split('/').pop();
      WM.reopen(id, {
        title: `${nm} — 预览`, icon: Icons.ui('eye', 16),
        render: (body) => render(body, m2, p2, nm),
      });
    });

    return WM.open({
      id, title: `${name} — 预览`, icon: Icons.ui('eye', 16),
      width: 1000, height: 700,
      chromeless: true,
      render: (body) => render(body, mount, path, name),
      // ★ 多开时 reg/ctxOf 以 winId 为 key 会随窗口数累积 ⇒ 关窗必须清理 ★
      onClose: () => { reg.delete(id); ctxOf.delete(id); },
    });
  }

  /* ----------------------------------------------------------------------
     CAD 查看器（独立服务，走 /cad 反代）

     和 openKK 结构几乎一致，区别只在取地址的接口（/api/cad/preview）
     与 iframe 的 src。工具栏、状态框、加载时序全部复用同一套写法，
     保证两个预览器的观感完全统一。
     ---------------------------------------------------------------------- */
  function openCAD(mount, path, name, ctx) {
    const id = `cad:${mount}-${++viewSeq}`;   // ★ id 不含 path，见 openImage 的说明
    setContext(id, ctx);

    const render = (body, m2, p2, nm) => {
      const bar = WM.Toolbar.build({
        title: nm,
        left: [
          WM.Toolbar.btn('reload', 'refresh', '重新加载'),
          WM.Toolbar.btn('newtab', 'external', '新标签打开'),
          WM.Toolbar.btn('download', 'download', '下载图纸'),
        ],
        right: [navBtns(id)],
      });
      body.innerHTML = `
        <div class="win-col">
          ${bar}
          <div class="kk-frame-wrap">
            <div class="state-box" data-role="boot">
              <div class="spinner"></div>
              <div class="sb-title">正在加载图纸…</div>
              <div class="sb-hint">CAD 查看器在浏览器内解析 DWG/DXF，大图纸需稍等</div>
            </div>
            <iframe class="viewer-frame" data-role="frame"
                    style="visibility:hidden" allowfullscreen></iframe>
          </div>
        </div>`;

      const frame = body.querySelector('[data-role="frame"]');
      const boot = body.querySelector('[data-role="boot"]');

      async function go() {
        boot.style.display = '';
        frame.style.visibility = 'hidden';
        try {
          const r = await API.cadUrl(m2, p2);
          frame.src = r.url;
        } catch (e) {
          frame.style.visibility = 'visible';
          boot.innerHTML = `<div class="state-box-inner" style="text-align:center">
            ${Icons.ui('warn', 48)}
            <div class="sb-title">无法打开图纸</div>
            <div class="sb-hint">${esc(e.message)}</div></div>`;
        }
      }

      frame.addEventListener('load', () => {
        frame.style.visibility = 'visible';
        boot.style.display = 'none';
      });

      body.querySelector('.win-toolbar').addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (!b || b.disabled) return;
        const a = b.dataset.a;
        if (handleNavClick(id, a)) return;
        if (a === 'reload') go();
        else if (a === 'newtab') window.open(frame.src, '_blank');
        else if (a === 'download') download(m2, p2, nm);
      });

      go();
    };

    reg.set(id, (m2, p2) => {
      const nm = p2.split('/').pop();
      WM.reopen(id, {
        title: `${nm} — CAD 预览`, icon: Icons.ui('ruler', 16),
        render: (body) => render(body, m2, p2, nm),
      });
    });

    return WM.open({
      id, title: `${name} — CAD 预览`, icon: Icons.ui('ruler', 16),
      width: 1100, height: 740,
      chromeless: true,
      render: (body) => render(body, mount, path, name),
      // ★ 多开时 reg/ctxOf 以 winId 为 key 会随窗口数累积 ⇒ 关窗必须清理 ★
      onClose: () => { reg.delete(id); ctxOf.delete(id); },
    });
  }

  /* ----------------------------------------------------------------------
     OnlyOffice 编辑器
     ---------------------------------------------------------------------- */
  // 记录每个窗口加载的 api.js，避免重复插入 <script>
  let ooApiLoading = null;

  function loadOnlyOfficeApi(apiJsUrl) {
    if (window.DocsAPI) return Promise.resolve();
    if (ooApiLoading) return ooApiLoading;

    ooApiLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = apiJsUrl;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        ooApiLoading = null;
        reject(new Error(`无法加载 OnlyOffice 接口脚本：${apiJsUrl}`));
      };
      document.head.appendChild(s);
      // 兜底超时：api.js 挂了不能让界面一直转圈
      setTimeout(() => {
        if (!window.DocsAPI) {
          ooApiLoading = null;
          reject(new Error('OnlyOffice 接口脚本加载超时（20 秒）'));
        }
      }, 20000);
    });
    return ooApiLoading;
  }

  function openOnlyOffice(mount, path, entry, siblingsOrCtx, dirPath) {
    const name = path.split('/').pop();
    const id = `oo:${mount}-${++viewSeq}`;   // ★ id 不含 path，见 openImage 的说明
    setContext(id, makeCtx(mount, path, siblingsOrCtx, dirPath));

    // ★★★ 临时诊断探针（2026-10-03，查完即删）★★★
    //   背景：手机（飞牛 App 的 webview）打开 Office 报 OnlyOffice 自己的
    //   「下载失败」，但**服务端一条相关请求都收不到**
    //   （`/cache/files/<key>/Editor.bin` 手机 0 条、电脑 8 条），
    //   从后端完全看不到真相 ⇒ 让客户端把关键信息"借道"回传：
    //   请求一个必然 404 的路径，**目的只是让它落进 nebula-front 的 access log**
    //   （不依赖后端加接口，也不依赖任何三方服务）。
    //   日志里搜 `__oodiag__` 即可看到全部回传内容。
    //   （已提升到模块级 —— 见文件顶部，因为「原生/媒体」路径也要上报）
    diag('env', {
      ua: navigator.userAgent.slice(0, 110),
      origin: location.origin,
      mobile: /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent),
      sw: !!navigator.serviceWorker,
      w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
    });
    diag('ua-mobile-detect', /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent) ? 'MOBILE' : 'DESKTOP');

    // ★★ 告诉 nginx「当前是哪个编辑器」（2026-10-03）★★
    //   手机（飞牛 App 的 webview）里 OO 的 iframe 停在 about:blank，
    //   它内部所有**相对** fetch 都被解析到根（/locale/zh.json 等）⇒ 404。
    //   nginx 端要把这些裸路径补回 /web-apps/apps/<app>/main/ 前缀，
    //   但**它认不出是哪个 app** —— 因为那种请求的 Referer 是父页面根地址
    //   （`https://<host>/`），里面没有 app 名。
    //   ⇒ 只能由父页面（这里）提前把 app 名写进 Cookie，让 nginx 读得到。
    //   （三个编辑器的 locale 文件内容各不相同，不能随便挑一个兜底。）
    try {
      const ext2 = (name.split('.').pop() || '').toLowerCase();
      const appName = ['docx', 'doc', 'odt', 'rtf', 'txt'].includes(ext2) ? 'documenteditor'
        : ['xlsx', 'xls', 'csv', 'ods'].includes(ext2) ? 'spreadsheeteditor'
          : ['pptx', 'ppt', 'odp'].includes(ext2) ? 'presentationeditor'
            : ext2 === 'pdf' ? 'pdfeditor' : '';
      if (appName) document.cookie = `oo_app=${appName}; path=/; SameSite=Lax`;
    } catch { /* 尽力而为 */ }

    // ★★ 记下"浏览器实际使用的 host / 协议"（2026-10-03）★★
    //   这是本次排查最关键的一环：手机（飞牛 App）经网关访问时，网关会**改写 Host 头**
    //   （把 office.app.5ddd.com:35359 换成 nebuladisk-main.alumaple.fnos.net），
    //   而后端 `_origin()` 与 OO 容器都按收到的 Host 生成**绝对地址**。
    //   ⇒ OO 给出的文档下载地址变成 https://nebuladisk-main.../cache/files/…/Editor.bin
    //     而手机只能访问 office.app.5ddd.com ⇒ 请求直接失败 ➜ OO 弹「下载失败」。
    //
    //   为什么不能只靠 Referer 修正 Host（已经踩过）：
    //     · JS 发起的 **WebSocket `/doc/<key>/c/` 请求不带 Referer**（实测 ref="-"），
    //       而 OO 正是用那条请求的 Host 生成 Editor.bin 地址 ⇒ 必须有别的来源。
    //   ⇒ 由父页面主动把 host/proto 写进 Cookie（同域 Cookie 在 WS 握手里也会带上）。
    try {
      document.cookie = `oo_host=${location.host}; path=/; SameSite=Lax`;
      document.cookie = `oo_proto=${location.protocol.replace(':', '')}; path=/; SameSite=Lax`;
    } catch { /* 尽力而为 */ }

    // ★ 诊断：Service Worker 状态（2026-10-03）★
    //   OO 会注册 SW 来托管编辑器的请求。若 SW 在手机 webview 里注册/拦截异常，
    //   请求会在 SW 内部就失败 ⇒ **网络上一条都看不到**，正好是本次的症状。
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        navigator.serviceWorker.getRegistrations().then((rs) => {
          diag('sw-list', rs.map((r) => (r.active && r.active.scriptURL) || r.scope).join(' , ') || '(none)');
        }).catch((e) => diag('sw-list-fail', String(e).slice(0, 100)));
      }
    } catch { /* 忽略 */ }

    //   （父页面自身的 JS 异常改由文件顶部的全局监听统一上报，这里不再重复注册）

    const render = (body, m2, p2, nm) => {
      // 统一工具栏：动作按钮靠左，翻页靠右，最小化/最大化/关闭由 Toolbar 贴最右
      const bar = WM.Toolbar.build({
        title: nm,
        left: [
          WM.Toolbar.btn('save', 'save', '保存', '', '手动保存（OnlyOffice 也会自动保存）'),
          // ★ 这里**不再**放「只读预览」按钮 ★
          //   用户原文：「红框里面的按钮去除，下面已经有了这个按钮。」
          //
          //   冗余点：工具栏的「只读预览」与内容区在编辑器失败时弹出的
          //   「改用只读预览」是**同一个动作**（都执行 WM.close + openKK，
          //   见下面 [data-a="fallback"] 与 [data-role="fb"] 两处）。
          //   保留工具栏那个反而稀释了工具栏的关注点，所以去掉，
          //   只留内容区按需出现的那一个。
          WM.Toolbar.btn('dl', 'download', '下载'),
        ],
        right: [
          `<span data-role="state" class="wt-num"></span>`,
          navBtns(id),
        ],
      });
      body.innerHTML = `<div class="win-col">${bar}
          <div class="win-fill" style="background:var(--bg-layer)">
            <div class="state-box" data-role="boot">
              <div class="spinner"></div>
              <div class="sb-title">正在连接 OnlyOffice…</div>
              <div class="sb-hint">正在为文档生成编辑会话</div>
            </div>
            <div id="oo-host-${cssId(id)}" data-role="host"
                 style="position:absolute;inset:0;display:none"></div>
          </div>
        </div>`;

      const boot = body.querySelector('[data-role="boot"]');
      const host = body.querySelector('[data-role="host"]');
      const stateEl = body.querySelector('[data-role="state"]');
      let editor = null;

      function fail(title, hint, extra) {
        boot.style.display = '';
        host.style.display = 'none';
        boot.innerHTML = `
          <div style="text-align:center;max-width:440px">
            ${Icons.ui('warn', 52)}
            <div class="sb-title">${esc(title)}</div>
            <div class="sb-hint" style="margin-top:8px">${esc(hint)}</div>
            ${extra || ''}
          </div>`;
        const fb = boot.querySelector('[data-role="fb"]');
        if (fb) fb.addEventListener('click', () => {
          WM.close(id);
          // ★ 必须把翻页上下文一起传过去 ★
          //   否则「改用只读预览」新开的 kk 窗口没有兄弟列表 →
          //   上一个/下一个直接消失，用户会觉得按钮"又丢了"。
          //   这里沿用本窗口已登记的 ctx（mount/dir/files/index 都在里面），
          //   并把它重新对齐到当前这个文件。
          const ctx = ctxFor(id);
          openKK(m2, p2, nm, ctx ? Object.assign({}, ctx, {
            currentName: nm,
            index: ctx.files ? ctx.files.findIndex((x) => x.name === nm) : -1,
          }) : null);
        });
      }

      async function start() {
        let cfgResp;
        try {
          cfgResp = await API.ooConfig(m2, p2);
        } catch (e) {
          diag('cfg-fail', String(e && e.message || e));
          fail('无法打开编辑器', e.message,
            `<button class="btn" data-role="fb" style="margin-top:14px">改用只读预览</button>`);
          return;
        }

        // 诊断：把本次拿到的关键地址回传（看 apiJs / 文档 url / key 是否合理）
        try {
          const c = cfgResp.config || {};
          diag('cfg', {
            editorType: cfgResp.editorType,
            apiJs: cfgResp.apiJs,
            docUrl: (c.document || {}).url,
            key: (c.document || {}).key,
            type: c.type,
            docType: c.documentType,
          });
        } catch { /* 忽略 */ }

        stateEl.textContent = cfgResp.mode === 'edit' ? '可编辑' : '只读';

        try {
          await loadOnlyOfficeApi(cfgResp.apiJs);
          diag('api-ok', cfgResp.apiJs);
        } catch (e) {
          diag('api-fail', `${cfgResp.apiJs} :: ${String(e && e.message || e)}`);
          fail('OnlyOffice 不可达', e.message,
            `<div class="sb-hint" style="margin-top:10px">
               请确认 OnlyOffice 容器已启动，且
               <code>NEBULA_OO_PUBLIC</code> 地址在浏览器里可以访问。
             </div>
             <button class="btn" data-role="fb" style="margin-top:14px">改用只读预览</button>`);
          return;
        }

        // ★ 翻页竞态：用户可能在上一次 start() 还没跑完时又翻了页。
        //   此时本函数已被新一轮 render 取代 → 直接放弃，不要再建编辑器，
        //   否则会在同一个 host 里叠两个 DocEditor（严重的资源泄漏）。
        if (body.__ooGen !== gen) return;

        boot.style.display = 'none';
        host.style.display = '';

        const config = Object.assign({}, cfgResp.config, {
          width: '100%',
          height: '100%',
          events: {
            onAppReady: () => { diag('oo-ready', 'appReady'); stateEl.textContent = '就绪'; },
            onDocumentReady: () => { diag('oo-docReady', 'documentReady'); stateEl.textContent = '已就绪'; },
            onDocumentStateChange: (e) => {
              stateEl.textContent = e.data ? '有未保存修改（自动保存中）' : '已保存';
            },
            onError: (e) => {
              console.error('[onlyoffice] 错误事件', e);
              // ★ 诊断：OO 报的错误码是破案关键（-4=文档下载失败 / -2=打开超时）
              diag('oo-onError', { data: e && e.data, code: e && e.errorCode, msg: describeOOError(e) });
              stateEl.textContent = '编辑器报错';
              Toast.error('OnlyOffice 报错', describeOOError(e));
            },
            onWarning: (e) => {
              console.warn('[onlyoffice] 警告', e);
              diag('oo-onWarning', { data: e && e.data, msg: describeOOError(e) });
              Toast.info('OnlyOffice 提示', describeOOError(e));
            },
            onRequestClose: () => {
              WM.close(id);
            },
          },
        });

        try {
          /* global DocsAPI */
          // ★ OnlyOffice 的 api.js 注入的全局，**不是我们源码里的东西** ★
          //   （share.js 的分享页那处早就有这行注解，这里一直漏着 ——
          //     静态作用域闸门 `tools/_test_js_scope.js` 会因此报"未声明的标识符"。
          //     注解是"本文件的"外部全局声明，比往闸门白名单里堆名字准确。）
          editor = new DocsAPI.DocEditor(`oo-host-${cssId(id)}`, config);
          editors.set(id, editor);   // ★ 登记给 onClose 用（见文件顶部说明）★

          // ★★ 诊断（2026-10-03，查完即删）★★
          //   拦截编辑器 iframe 内的 fetch / XHR，把「它想请求什么 URL」和
          //   「为什么失败」回传上来。
          //   为什么能做：OO 编辑器的 iframe 用相对路径（/9.4.0-…/web-apps/…）
          //   创建 ⇒ 与父页面**同源** ⇒ 父页面拿得到 contentWindow，能包一层 fetch。
          //   手机上恰恰是"请求一条都到不了服务器"，这一层是唯一能看到真相的地方。
          let patched = false;
          const patchTimer = setInterval(() => {
            if (patched) return;
            // ★ 放宽查找（第一版只找 `#oo-host-* iframe` 没命中，说明 OO 生成的
            //   iframe 不一定挂在那层，或者 id/结构随版本不同）：
            //   直接扫全页所有 iframe，挑 src 像编辑器的那个。
            const all = [...document.querySelectorAll('iframe')];
            const fr = all.find((f) => /web-apps|oo-ver/.test(f.getAttribute('src') || '')) || all[0];
            if (!fr) return;
            let w = null;
            try { w = fr.contentWindow; } catch { /* 跨域，读不到就算了 */ }
            if (!w) { diag('iframe-cw-blocked', all.length); patched = true; clearInterval(patchTimer); return; }
            patched = true;
            clearInterval(patchTimer);
            try {
              diag('iframe-found', `${all.length}|${(fr.getAttribute('src') || '').slice(0, 140)}`);
              // ★ 决定性测量（2026-10-03）★
              //   已知症状：iframe 内 fetch('locale/zh.json') 被解析成 **根路径**
              //   `/locale/zh.json`（404），而 HTML 里 <link href="resources/...">
              //   却解析到正确位置 ⇒ 说明 fetch 用的 baseURI 不是 iframe 自己的 URL。
              //   这里把 iframe 的真实 location / baseURI / src 三者都量出来，
              //   看它们是否一致（不一致就是根因所在）。
              try {
                diag('iframe-url', {
                  src: (fr.getAttribute('src') || '').slice(0, 110),
                  loc: String(w.location && w.location.href || '').slice(0, 110),
                  base: String(w.document && w.document.baseURI || '').slice(0, 110),
                  parent: String(location.href).slice(0, 80),
                });
              } catch (e) { diag('iframe-url-fail', String(e).slice(0, 100)); }
              // iframe 内的 JS 异常（这是"编辑器起不来"最直接的证据）
              w.addEventListener('error', (ev) => {
                diag('frame-error', `${(ev && ev.message) || ''} @ ${(ev && ev.filename) || ''}:${(ev && ev.lineno) || 0}`);
              });
              w.addEventListener('unhandledrejection', (ev) => {
                let r = '';
                try { r = String((ev && ev.reason && (ev.reason.message || ev.reason)) || ''); } catch { /* */ }
                diag('frame-reject', r.slice(0, 200));
              });
              const of = w.fetch;
              if (of) {
                w.fetch = function (...a) {
                  const u = String((a[0] && a[0].url) || a[0]);
                  // 带上"这次 fetch 时的 baseURI 尾巴"，用来验证相对路径为何解析到根
                  let base = '';
                  try { base = String(w.document.baseURI || '').slice(-58); } catch { /* */ }
                  return of.apply(this, a).then(
                    (r) => {
                      if (!r.ok) diag('fetch-bad', `${r.status} ${u} [base=${base}]`);
                      return r;
                    },
                    (e) => {
                      diag('fetch-err', `${u} :: ${String(e).slice(0, 110)} [base=${base}]`);
                      throw e;
                    });
                };
              }
              const xo = w.XMLHttpRequest && w.XMLHttpRequest.prototype.open;
              if (xo) {
                w.XMLHttpRequest.prototype.open = function (m, u, ...r) {
                  this.addEventListener('error', () => diag('xhr-err', `${m} ${u}`));
                  this.addEventListener('load', () => {
                    if (this.status >= 400) diag('xhr-bad', `${this.status} ${m} ${u}`);
                  });
                  return xo.call(this, m, u, ...r);
                };
              }
              diag('iframe-patched', 'ok');
            } catch (e) {
              diag('iframe-patch-fail', String(e).slice(0, 130));
            }
          }, 300);
          setTimeout(() => clearInterval(patchTimer), 90000);
        } catch (e) {
          fail('编辑器初始化失败', e.message || String(e));
          return;
        }
      }

      // 每次 render（含翻页）都 ++，用于让过期的 start() 自行放弃
      body.__ooGen = ++ooGen;
      const gen = body.__ooGen;

      body.querySelector('.win-toolbar').addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (!b || b.disabled) return;
        const a = b.dataset.a;
        if (handleNavClick(id, a)) {
          // ★ 翻页时先把旧的编辑器实例销毁，避免多个编辑器共用同一个 host ★
          try { editor && editor.destroyEditor(); } catch { /* 已销毁 */ }
          editor = null;
          editors.delete(id);
          return;
        }
        if (a === 'save') {
          // downloadAs 触发编辑器把当前内容提交到 callbackUrl
          try {
            editor && editor.serviceCommand('forcesave');
            stateEl.textContent = '正在保存…';
            setTimeout(() => Editor.refreshAfterSave(m2, p2), 2500);
          } catch (err) { Toast.error('保存失败', err.message); }
        } else if (a === 'dl') {
          download(m2, p2, nm);
        }
        // 注：工具栏已无 'fallback' 按钮（用户要求去掉冗余项），
        //     「改用只读预览」只在内容区按需出现，由 [data-role="fb"] 处理。
      });

      start();
    };

    reg.set(id, (m2, p2) => {
      const nm = p2.split('/').pop();
      WM.reopen(id, {
        title: `${nm} — OnlyOffice`, icon: Icons.file(nm),
        render: (body) => render(body, m2, p2, nm),
      });
    });

    return WM.open({
      id,       title: `${name} — OnlyOffice`, icon: Icons.file(name),
      width: 1200, height: 780, minWidth: 640, minHeight: 420,
      chromeless: true,   // 统一无标题栏外观；按钮行见 WM.Toolbar
      render: (body) => render(body, mount, path, name),
      // ★ 多开时 reg/ctxOf 以 winId 为 key 会随窗口数累积 ⇒ 关窗必须清理 ★
      // ★★ 2026-10-03：**光清 Map 不够，必须 destroyEditor()** ★★
      //   原来的实现只 reg.delete / ctxOf.delete ⇒ 关窗只拆了 DOM，
      //   编辑器实例（几十 MB 内存 + WebSocket + 定时器）全都还活着。
      //   手机上连开几个 Office 文件就撑爆 ⇒ 编辑器起不来 / 报「下载失败」。
      //   实测：13:53–14:04 反复打开同一 xlsx 8 次，日志里出现 5 个
      //   frameEditorId=oo-host-oo_____-1…-5（= 5 个编辑器实例同时活着）。
      //   详见文件顶部 `editors` 的说明。
      onClose: () => {
        const e = editors.get(id);
        if (e) { try { e.destroyEditor(); } catch { /* 已销毁 */ } }
        editors.delete(id);
        reg.delete(id);
        ctxOf.delete(id);
      },
    });
  }

  // OnlyOffice 渲染代次（翻页会让上一代 start() 自行放弃）
  let ooGen = 0;


  function cssId(s) {
    return s.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  /** OnlyOffice 错误码 → 人话 */
  function describeOOError(e) {
    const code = e && (e.data || e.errorCode || e);
    const map = {
      '-1': '未知错误',
      '-2': '文档打开超时或网络中断',
      '-3': '文档转换失败，文件可能已损坏',
      '-4': '文档下载失败，云盘地址对 OnlyOffice 不可达',
      '-5': '密码错误',
      '-6': '文档编辑时下载失败',
      '-7': '编辑会话已结束',
      '-8': '强制保存时无法下载文档',
      '-9': '强制保存超时',
      '-10': '服务端内部错误',
    };
    return map[String(code)] || `错误码 ${code}`;
  }

  /* ----------------------------------------------------------------------
     下载 / 兜底
     ---------------------------------------------------------------------- */
  function download(mount, path, name) {
    const a = document.createElement('a');
    a.href = rawUrl(mount, path);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function askDownload(mount, path, name) {
    const ok = await Dialog.confirm({
      title: '无法在线预览',
      message: `「${name}」这类文件没有内置的预览器。`,
      html: `<div class="alert info">${Icons.ui('info', 16)}
        <span>可以下载到本地后用对应软件打开。</span></div>`,
      okText: '下载文件',
      cancelText: '取消',
    });
    if (ok) download(mount, path, name);
  }

  return {
    open, openOnlyOffice, openKK, openCAD, download,
    // 供 Explorer 在「当前目录内容变了」时刷新翻页上下文（如删除/重命名后）
    setContext, refreshContext,
    step, canGo,        // 上一个 / 下一个（也有快捷键入口）
    kindOf,             // 文件 → 预览类型（翻页"只翻同类"的判据，供测试与调试）
  };
})();


/* ==========================================================================
   编辑器辅助
   ========================================================================== */
const Editor = {
  /** OnlyOffice 保存完成后刷新资源管理器，让列表里的时间/大小跟上 */
  refreshAfterSave(mount, path) {
    // 短暂延迟：callback 写盘 + 下一次 stat 需要一点时间
    setTimeout(() => {
      Explorer.refreshAll();
      Toast.ok('已保存', '文档修改已写回磁盘');
    }, 1200);
  },
};
