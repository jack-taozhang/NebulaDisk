/* ==========================================================================
   NebulaDisk —— 分享落地页逻辑
   --------------------------------------------------------------------------
   与 SPA 分开写（不 import app.js / shell.js）：
     分享页的读者是**外部访客**，不该拖进整个桌面环境（窗口管理、任务栏、
     图标层…），体积小、加载快、出错面小。

   状态机（只有一个入口 render()，按 __SHARE__ 决定渲染什么）：
     error     → 链接失效页
     !unlocked → 提取码页
     unlocked  → 浏览页（目录逐层 / 单文件直接预览+下载）
   ========================================================================== */
(() => {
  'use strict';

  const BOOT = window.__SHARE__ || {};
  const TOKEN = BOOT.token || '';

  const $ = (id) => document.getElementById(id);
  const main = $('sh-main');
  const meta = $('sh-meta');
  const navEl = $('sh-nav');
  const pathEl = $('sh-path');
  const upBtn = $('sh-up');
  const zipBtn = $('sh-zip');
  const selAllBtn = $('sh-selall');

  let curPath = '';       // 当前相对分享根的子路径（'' = 根）
  let curEntries = [];
  // ★ 选择集（勾选的项名，相对当前目录）★
  //   2026-09-30 用户追加需求：「应该可以 根据 选择 然后打包下载」。
  //   只给"整目录打包"不够 —— 常见诉求是"这个目录里我只要这几个"：
  //   逐个文件单独下会得到一堆散包，整目录打包又太重。
  let sel = new Set();

  // ---- 小工具 -------------------------------------------------------------
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function toast(msg, ms = 3000) {
    const t = $('sh-toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }

  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtLeft(expiresAt) {
    if (!expiresAt) return '永久有效';
    const left = expiresAt - Math.floor(Date.now() / 1000);
    if (left <= 0) return '已过期';
    const d = Math.floor(left / 86400);
    if (d >= 1) return `剩余 ${d} 天`;
    const h = Math.floor(left / 3600);
    if (h >= 1) return `剩余 ${h} 小时`;
    return `剩余 ${Math.max(1, Math.floor(left / 60))} 分钟`;
  }

  /** 拼分享内的取流/预览地址（path 是相对分享根的子路径） */
  const apiBase = () => `/api/s/${encodeURIComponent(TOKEN)}`;
  const rawUrl = (sub, download) =>
    `${apiBase()}/raw?` + new URLSearchParams({ path: sub || '', download: download ? 'true' : 'false' });
  const previewUrl = (sub) =>
    `${apiBase()}/preview?` + new URLSearchParams({ path: sub || '' });
  /** 目录分享的「打包下载」：只打勾选的项；没勾就给整层（流式，服务端边压边发） */
  const zipUrl = (sub, items) => {
    const q = new URLSearchParams({ path: sub || '' });
    (items || []).forEach((n) => q.append('item', n));
    return `${apiBase()}/zip?${q}`;
  };

  async function jget(url) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    let d = null;
    try { d = await r.json(); } catch { /* 非 JSON */ }
    if (!r.ok) {
      throw new Error((d && (d.error || d.detail)) || `请求失败 (HTTP ${r.status})`);
    }
    return d;
  }

  // ---- 图标（内联 SVG，避免额外请求）--------------------------------------
  const ICON_DIR = '<svg class="sh-ico dir" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.4c.4 0 .8.16 1.06.44L11.4 6h7.1A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>';
  const ICON_FILE = '<svg class="sh-ico" viewBox="0 0 24 24" fill="currentColor"><path d="M6 2h7l5 5v15H6z" opacity=".85"/><path d="M13 2l5 5h-5z" opacity=".45"/></svg>';

  function iconFor(e) {
    return e.isDir ? ICON_DIR : ICON_FILE;
  }

  // ---- 渲染：错误页 -------------------------------------------------------
  function renderError(msg) {
    main.innerHTML = `<div class="sh-card">
      <h2>无法打开该分享</h2>
      <p>${esc(msg)}</p>
    </div>`;
    meta.textContent = '';
    navEl.hidden = true;
  }

  // ---- 渲染：提取码页 -----------------------------------------------------
  function renderLocked() {
    navEl.hidden = true;
    main.innerHTML = `<div class="sh-card">
      <h2>需要提取码</h2>
      <p>「${esc(BOOT.name || '该文件')}」需要提取码才能访问。</p>
      <div class="field">
        <input type="password" id="sh-pw" placeholder="请输入提取码" autocomplete="off">
      </div>
      <button class="btn primary" id="sh-unlock" style="width:100%">访问</button>
      <div class="sh-dim" id="sh-lock-err" style="margin-top:10px;color:var(--danger)"></div>
    </div>`;

    const pw = $('sh-pw'), btn = $('sh-unlock'), err = $('sh-lock-err');
    const submit = async () => {
      err.textContent = '';
      btn.disabled = true;
      try {
        const fd = new FormData();
        fd.append('password', pw.value);
        const r = await fetch(`${apiBase()}/unlock`, { method: 'POST', body: fd, credentials: 'same-origin' });
        let d = null; try { d = await r.json(); } catch { /* */ }
        if (!r.ok) throw new Error((d && (d.error || d.detail)) || '提取码不正确');
        // 解锁成功 → 重载（服务端已种 Cookie，这次会直接渲染浏览页）
        location.reload();
      } catch (e) {
        err.textContent = e.message || String(e);
        btn.disabled = false;
        pw.select();
      }
    };
    btn.addEventListener('click', submit);
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    setTimeout(() => pw.focus(), 80);
  }

  // ---- 渲染：浏览页 -------------------------------------------------------
  function renderEntry(e, idx) {
    const on = sel.has(e.name);
    // data-name 是选择集的键（而不是行序号）——列表会重排，序号不可靠
    return `<div class="sh-row${e.isDir ? ' dir' : ''}${on ? ' is-selected' : ''}"
                 data-i="${idx}" data-name="${esc(e.name)}">
      <div class="sh-check">
        <input type="checkbox" class="sh-cb"${on ? ' checked' : ''}
               aria-label="选择 ${esc(e.name)}">
      </div>
      <div class="sh-name">${iconFor(e)}<span class="nm" title="${esc(e.name)}">${esc(e.name)}</span></div>
      <div class="sh-size">${esc(fmtSize(e.size))}</div>
      <div class="sh-time">${esc(fmtTime(e.mtime))}</div>
    </div>`;
  }

  /**
   * 把选择集同步到"看得见的地方"：行的高亮、复选框、按钮文案。
   *
   * ★ 为什么不整表重渲染 ★
   *   勾选是高频操作，重渲染会丢掉滚动位置、也会让刚点的复选框闪一下。
   *   这里只改类名与属性。
   */
  function syncSelection() {
    const rows = [...main.querySelectorAll('.sh-row')];
    rows.forEach((row) => {
      const on = sel.has(row.dataset.name);
      row.classList.toggle('is-selected', on);
      const cb = row.querySelector('.sh-cb');
      if (cb) cb.checked = on;
    });
    const n = sel.size;
    const label = zipBtn.querySelector('span');
    if (label) label.textContent = n ? `下载选中 ${n} 项` : '打包下载';
    zipBtn.title = n ? `把勾选的 ${n} 项打成 ZIP 下载` : '把当前文件夹打成 ZIP 下载';
    selAllBtn.hidden = rows.length === 0;
    selAllBtn.textContent =
      (n && n === rows.length) ? '取消全选' : `全选${n && n < rows.length ? ` (还有 ${rows.length - n})` : ''}`;
  }

  function renderBrowse(data) {
    const sh = data.share || {};
    curEntries = data.entries || [];
    sel = new Set();                      // 换层/换分享 → 选择集必须清空

    // 顶栏：分享者 + 有效期
    meta.innerHTML = `由 <b>${esc(sh.owner || '')}</b> 分享 · ${esc(fmtLeft(sh.expiresAt))}`;

    // 面包屑
    const base = (sh.name || '分享');
    const sub = data.path ? '/' + data.path.split('/').filter(Boolean).join('/') : '';
    pathEl.textContent = base + sub;
    pathEl.title = base + sub;           // 长了被 ellipsis 截断时，悬停能看全

    // ★ 导航条只在**目录分享**出现 ★
    //   单文件分享的卡片自带「预览 / 下载」，再顶一条面包屑是重复信息。
    //   上一级/打包下载都在这里面（顶部靠左），不再回到底部角落 —— 见 share.css 的说明。
    navEl.hidden = !!data.single;
    upBtn.hidden = !data.path;            // 已经在分享根 → 没有上一级可去
    zipBtn.hidden = false;
    // ★ 按钮的打什么由"选择集"决定★
    //   没勾 → 整个当前层；勾了 → 只打那几项。
    //   onclick 每次都重算，所以勾选状态变了不用重建按钮。
    zipBtn.onclick = () => { location.href = zipUrl(curPath, [...sel]); };

    // 单文件分享：直接给"预览 + 下载"
    if (data.single) {
      const e = curEntries[0] || {};
      const subF = data.path || '';
      main.innerHTML = `<div class="sh-card">
        <h2>${esc(e.name || sh.name || '文件')}</h2>
        <p>${esc(fmtSize(e.size))} · ${esc(fmtTime(e.mtime))}</p>
        <button class="btn primary" id="sh-open" style="width:100%">预览</button>
        <button class="btn" id="sh-save" style="width:100%;margin-top:8px">下载</button>
      </div>`;
      $('sh-open').addEventListener('click', () => openPreview(subF, e));
      $('sh-save').addEventListener('click', () => { location.href = rawUrl(subF, true); });
      return;
    }

    if (!curEntries.length) {
      main.innerHTML = `<div class="sh-center"><div class="sh-dim">这个文件夹是空的</div></div>`;
      return;
    }

    // 排序：目录在前，再按名字（与桌面端 explorer 的习惯一致）
    const list = [...curEntries].sort((a, b) => {
      if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN', { numeric: true });
    });

    main.innerHTML = `<div class="sh-list">${list.map((e, i) => renderEntry(e, i)).join('')}</div>`;

    main.querySelectorAll('.sh-row').forEach((row) => {
      const e = list[Number(row.dataset.i)];
      const cb = row.querySelector('.sh-cb');

      // ① 复选框 = 纯多选（勾/取消勾），不碰别的项
      //    stopPropagation：否则事件冒到行上，又被"单选"逻辑改成只留它一个。
      cb.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (cb.checked) sel.add(e.name); else sel.delete(e.name);
        syncSelection();
      });

      // ② 点行体 = 单选（保持原有习惯）；Ctrl/Cmd+点 = 加选/减选（桌面顺手）
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('.sh-check')) return;   // 上面①已经处理过了
        if (ev.ctrlKey || ev.metaKey) {
          if (sel.has(e.name)) sel.delete(e.name); else sel.add(e.name);
        } else {
          sel = new Set([e.name]);
        }
        syncSelection();
      });
      row.addEventListener('dblclick', () => activate(e));
    });

    syncSelection();      // 初始状态：按钮文案、全选按钮的显隐
  }

  function subOf(name) {
    return curPath ? `${curPath}/${name}` : name;
  }

  function activate(e) {
    if (e.isDir) { load(subOf(e.name)); return; }
    // ★ 传整个 entry ★
    //   路由要看 e.route（后端 route_of 的结果）与 e.ext，
    //   只传文件名就成了「前端自己按扩展名猜」，会与网盘漂移。
    openPreview(subOf(e.name), e);
  }

  async function load(path) {
    main.innerHTML = `<div class="sh-center"><div class="spinner"></div><div class="sh-dim">正在载入…</div></div>`;
    try {
      const data = await jget(`${apiBase()}/list?` + new URLSearchParams({ path: path || '' }));
      curPath = data.path || '';
      renderBrowse(data);
    } catch (err) {
      renderError(err.message || String(err));
    }
  }

  // ---- 预览 ---------------------------------------------------------------
  /* ★★★ 这段路由必须与网盘 web/js/viewer.js 的 nativeKind()/kindOf() 一致 ★★★

     为什么单列一段注释（2026-09-30 用户报障）：
       用户原话：「/s/页面上的预览路由和网盘的路由不一致，需要调整为一样」。
       原分享页只做了「图片 / 其它」两分，其余一律丢给 kkFileView，
       于是同一个 DWG 在网盘里由 cad-viewer 渲染、在分享页却被 kkFileView 打开；
       视频、音频、纯文本也从「浏览器原生（零转换）」退化成 kk 的转换预览。

     ⇒ 这里把 viewer.js 的决策树**照搬**过来，优先级一字不差：
          cad → onlyoffice → 原生(图片/视频/音频/文本) → kkfileview → 下载
     ⚠️ 改这里就要同步改 viewer.js（反之亦然）。
        tools/check_preview_route_parity.py 会静态比对两边的扩展名表与优先级，
        并在 run_static_checks.sh 里跑 —— 漂移会被当场拦下。
     ★ 判定依据是后端 list/stat 给的 entry.route（= config.route_of 的结果），
       不是前端自己猜，这样三处（后端 / 网盘 / 分享页）只有一个真相来源。 */

  /** 浏览器原生就能渲染的类型（与 viewer.js 逐字一致） */
  function nativeKind(ext) {
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif'].includes(ext))
      return 'image';
    if (['mp4', 'webm', 'ogv', 'm4v'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'].includes(ext)) return 'audio';
    if (['txt', 'log', 'md', 'markdown', 'json', 'xml', 'csv', 'ini', 'conf',
         'yml', 'yaml', 'css', 'js', 'ts', 'py', 'java', 'go', 'rs', 'c', 'cpp',
         'h', 'sh', 'bat', 'sql', 'properties', 'toml', 'env', 'gitignore'].includes(ext))
      return 'text';
    return null;
  }

  /** 与 viewer.js 的 kindOf() 同序：顺序变了就等于换了引擎 */
  function kindOf(e) {
    if (!e || e.isDir) return null;
    const ext = ((e.ext || (String(e.name).split('.').pop()) || '') + '').toLowerCase();
    if (e.route === 'cad') return 'cad';
    if (e.route === 'onlyoffice') return 'onlyoffice';
    const native = nativeKind(ext);
    if (native) return native;
    if (e.route === 'kkfileview') return 'kkfileview';
    return null;
  }

  /**
   * 智能解码：先按 UTF-8 严格解，有非法序列就试 GBK。
   * 与 viewer.js 的 decodeSmart() 同一套（中文用户里 GBK 文本非常多）。
   */
  function decodeSmart(buf) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      for (const enc of ['gbk', 'gb18030', 'big5', 'utf-16le']) {
        try {
          const t = new TextDecoder(enc).decode(buf);
          const bad = (t.match(/\uFFFD/g) || []).length;
          if (bad / Math.max(1, t.length) < 0.01) return t;
        } catch { /* 浏览器不支持该编码，跳过 */ }
      }
      return new TextDecoder('utf-8').decode(buf);
    }
  }

  function showDownloadFallback(sub, tip) {
    const body = $('sh-viewer-body');
    body.innerHTML = `<div class="sh-center">
      <div class="sh-dim">${esc(tip || '该格式暂不支持在线预览')}</div>
      <button class="btn primary" id="sh-fallback-dl">下载文件</button>
    </div>`;
    $('sh-fallback-dl').addEventListener('click', () => { location.href = rawUrl(sub, true); });
    $('sh-viewer').hidden = false;
  }

  async function openPreview(sub, e) {
    const viewer = $('sh-viewer');
    const body = $('sh-viewer-body');
    const name = (e && e.name) || '';
    $('sh-viewer-name').textContent = name;

    const kind = kindOf(e);
    const src = rawUrl(sub, false);       // inline 取流（预览用，不是下载）
    const escSrc = esc(src);

    // ① 图片：直接 <img>，省一次预览服务往返（也更快）
    if (kind === 'image') {
      body.innerHTML = `<img src="${escSrc}" alt="${esc(name)}">`;
      viewer.hidden = false;
      return;
    }

    // ② 视频 / 音频：浏览器原生播放器（与网盘 openMedia 同一条腿）
    if (kind === 'video' || kind === 'audio') {
      body.innerHTML = `<div class="sh-media-wrap">${
        kind === 'video'
          ? `<video class="sh-media" src="${escSrc}" controls autoplay playsinline></video>`
          : `<audio class="sh-media" src="${escSrc}" controls autoplay></audio>`
      }</div>`;
      viewer.hidden = false;
      return;
    }

    // ③ 纯文本：取流后本地解码（编码嗅探与网盘一致），不走任何转换服务
    if (kind === 'text') {
      viewer.hidden = false;
      body.innerHTML = `<div class="sh-media-wrap"><div class="spinner"></div></div>`;
      try {
        const r = await fetch(src, { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = await r.arrayBuffer();
        body.innerHTML = `<pre class="sh-text">${esc(decodeSmart(buf))}</pre>`;
      } catch (err) {
        showDownloadFallback(sub, '读取失败：' + (err.message || err));
      }
      return;
    }

    // ④ 其余交给后端路由：cad-viewer / OnlyOffice / kkFileView
    //    ★ 后端只返回「用哪个引擎」，具体地址由它给 —— 前端不拼引擎地址 ★
    try {
      const cfg = await jget(previewUrl(sub));
      body.innerHTML = '';
      if (cfg.route === 'onlyoffice' && cfg.config) {
        // OnlyOffice：用官方 api.js 挂载（与桌面端同一套）
        const holder = document.createElement('div');
        holder.id = 'sh-oo-holder';
        holder.style.cssText = 'width:100%;height:100%';
        body.appendChild(holder);
        // ★ 地址由服务端给（它知道浏览器该用哪个 OnlyOffice 地址）★
        //   自己在客户端拼 '/oo/web-apps/...' 是错的：本地开发/反代/多端口下
        //   都对不上 —— 桌面端也是由 /api/oo/config 返回 apiJs，保持一致。
        await ensureOOApi(cfg.apiJs);
        /* global DocsAPI */
        DocsAPI.DocEditor('sh-oo-holder', cfg.config);
      } else if (cfg.url) {
        // ★ cad 与 kkFileView 都是「同源反代深链」，同一条腿 ★
        //   （cad 是 /lite?kind=cad&target=%2Fcad%2F%3Fopen%3D…  —— 外层 /lite 把
        //      CAD 的功能区/右侧工具条/命令行/状态栏用 CSS 收掉，见 pages.py 的
        //      _LITE_HIDE；kk 是 /preview/onlinePreview?url=…）
        //   两个地址都由后端给，前端原样用，不自己拼。
        const f = document.createElement('iframe');
        f.src = cfg.url;
        f.setAttribute('referrerpolicy', 'no-referrer');
        body.appendChild(f);
      } else {
        // 后端明确回了 route=download（无在线预览能力）→ 与网盘一样只给下载
        throw new Error('该格式不支持在线预览');
      }
      viewer.hidden = false;
    } catch (err) {
      // 预览失败不阻断：给一个"直接下载"的出口
      toast('无法在线预览：' + (err.message || err));
      showDownloadFallback(sub);
    }
  }

  /** 按需加载 OnlyOffice 的 api.js（只加载一次）。地址由调用方传入。 */
  let ooApiPromise = null;
  function ensureOOApi(src) {
    if (ooApiPromise) return ooApiPromise;
    ooApiPromise = new Promise((resolve, reject) => {
      if (!src) { reject(new Error('编辑器地址缺失')); return; }
      // 同一文档打开两次时不必重复插 <script>
      if (document.querySelector(`script[data-nebula-oo="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.dataset.nebulaOo = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('无法加载编辑器'));
      document.head.appendChild(s);
    });
    return ooApiPromise;
  }

  // ---- 事件绑定 -----------------------------------------------------------
  upBtn.addEventListener('click', () => {
    const parts = curPath.split('/').filter(Boolean);
    parts.pop();
    load(parts.join('/'));
  });

  // 全选 / 取消全选：已全选时再点就是清空，否则全选
  selAllBtn.addEventListener('click', () => {
    const names = [...main.querySelectorAll('.sh-row')].map((r) => r.dataset.name);
    sel = (sel.size && sel.size === names.length) ? new Set() : new Set(names);
    syncSelection();
  });

  $('sh-viewer-close').addEventListener('click', () => {
    const viewer = $('sh-viewer');
    viewer.hidden = true;
    $('sh-viewer-body').innerHTML = '';   // 立即拆掉 iframe，停掉音频/视频
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('sh-viewer').hidden) $('sh-viewer-close').click();
  });

  // ---- 启动 ---------------------------------------------------------------
  (function boot() {
    if (BOOT.error) { renderError(BOOT.error); return; }
    if (!BOOT.unlocked) { renderLocked(); return; }
    load('');
  })();
})();
