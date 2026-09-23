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
  const pathEl = $('sh-path');
  const upBtn = $('sh-up');
  const dlBtn = $('sh-dl');

  let curPath = '';       // 当前相对分享根的子路径（'' = 根）
  let curEntries = [];
  let selected = null;

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
    pathEl.textContent = '';
    upBtn.hidden = dlBtn.hidden = true;
  }

  // ---- 渲染：提取码页 -----------------------------------------------------
  function renderLocked() {
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
    const sel = selected === e.name ? ' is-selected' : '';
    return `<div class="sh-row${e.isDir ? ' dir' : ''}${sel}" data-i="${idx}">
      <div class="sh-name">${iconFor(e)}<span class="nm" title="${esc(e.name)}">${esc(e.name)}</span></div>
      <div class="sh-size">${esc(fmtSize(e.size))}</div>
      <div class="sh-time">${esc(fmtTime(e.mtime))}</div>
    </div>`;
  }

  function renderBrowse(data) {
    const sh = data.share || {};
    curEntries = data.entries || [];
    selected = null;

    // 顶栏：分享者 + 有效期
    meta.innerHTML = `由 <b>${esc(sh.owner || '')}</b> 分享 · ${esc(fmtLeft(sh.expiresAt))}`;

    // 面包屑
    const base = (sh.name || '分享');
    const sub = data.path ? '/' + data.path.split('/').filter(Boolean).join('/') : '';
    pathEl.textContent = base + sub;
    upBtn.hidden = !data.path;

    // 单文件分享：直接给"预览 + 下载"
    if (data.single) {
      const e = curEntries[0] || {};
      const sub = data.path || '';
      main.innerHTML = `<div class="sh-card">
        <h2>${esc(e.name || sh.name || '文件')}</h2>
        <p>${esc(fmtSize(e.size))} · ${esc(fmtTime(e.mtime))}</p>
        <button class="btn primary" id="sh-open" style="width:100%">预览</button>
        <button class="btn" id="sh-save" style="width:100%;margin-top:8px">下载</button>
      </div>`;
      $('sh-open').addEventListener('click', () => openPreview(sub, e.name));
      $('sh-save').addEventListener('click', () => { location.href = rawUrl(sub, true); });
      dlBtn.hidden = false;
      dlBtn.onclick = () => { location.href = rawUrl(curPath, true); };
      return;
    }

    dlBtn.hidden = true;

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
      row.addEventListener('click', () => {
        selected = e.name;
        main.querySelectorAll('.sh-row').forEach((r) => r.classList.remove('is-selected'));
        row.classList.add('is-selected');
      });
      row.addEventListener('dblclick', () => activate(e));
    });
  }

  function subOf(name) {
    return curPath ? `${curPath}/${name}` : name;
  }

  function activate(e) {
    if (e.isDir) { load(subOf(e.name)); return; }
    openPreview(subOf(e.name), e.name);
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
  async function openPreview(sub, name) {
    const viewer = $('sh-viewer');
    $('sh-viewer-name').textContent = name || '';
    const body = $('sh-viewer-body');

    const ext = (String(name).split('.').pop() || '').toLowerCase();
    const IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'];

    // 图片直接 <img>，省一次预览服务往返（也更快）
    if (IMG.includes(ext)) {
      body.innerHTML = '';
      const img = document.createElement('img');
      img.src = rawUrl(sub, false);
      img.alt = name;
      body.appendChild(img);
      viewer.hidden = false;
      return;
    }

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
        const f = document.createElement('iframe');
        f.src = cfg.url;
        f.setAttribute('referrerpolicy', 'no-referrer');
        body.appendChild(f);
      } else {
        throw new Error('预览不可用');
      }
      viewer.hidden = false;
    } catch (e) {
      // 预览失败不阻断：给一个"直接下载"的出口
      toast('无法在线预览：' + (e.message || e));
      body.innerHTML = `<div class="sh-center" style="color:#333">
        <div>该格式暂不支持在线预览</div>
        <button class="btn primary" id="sh-fallback-dl">下载文件</button>
      </div>`;
      $('sh-fallback-dl').addEventListener('click', () => { location.href = rawUrl(sub, true); });
      viewer.hidden = false;
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
