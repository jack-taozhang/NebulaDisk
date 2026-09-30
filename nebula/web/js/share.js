/* ==========================================================================
   NebulaDisk —— 分享落地页逻辑（2026-09-30 第三次重做：左侧文件树 + 铺满预览）

   与 SPA 分开写（不 import app.js / shell.js）：
     分享页的读者是**外部访客**，不该拖进整个桌面环境（窗口管理、任务栏、
     图标层…），体积小、加载快、出错面小。

   用户这一轮的要求（原话，逐条编号，代码里用 a~f 标注对应实现）：
     a、最上面那个整条去掉，包括网盘 logo 都去掉；
     b、预览窗口铺满整个页面；
     c、每行右边显示 文件大小和下载图标，不显示日期；
     d、文件树显示在左边，自动隐藏（不要太宽），鼠标靠边面板就可以从左边
        显示出来，宽度可以手动调整；
     e、多选下载按钮 也放到左边的面板上；
     f、有固定图标，固定后就固定在边上，如果没有固定（在预览页面上面），
        点击预览窗口，那文件树就自动隐藏。

   状态机：
     error       → 链接失效页
     !unlocked   → 提取码页
     单文件      → 直接铺满预览（只有一枚浮动下载按钮）
     目录        → 左侧文件树（懒加载子目录）+ 右侧铺满预览

   ★ 为什么前两版都不行（别走回头路）★
     第 1 版：品牌栏 + 导航条 + 裸表格 —— 三条横带，信息只有一条。
     第 2 版：压成两条（顶栏 + 信息卡）并把列表做了类型着色，信息层级好了，
             但**顶栏仍然常驻**。用户要的正是"把那条去掉"。
     ⇒ 问题不在"横带里放了什么"，而在"有一条常驻横带"本身：
       它把所有内容往下推，预览就永远不可能铺满整页。
       所以这一版把身份信息并进左面板头部，页面上不再有任何常驻横带。
   ========================================================================== */
(() => {
  'use strict';

  const BOOT = window.__SHARE__ || {};
  const TOKEN = BOOT.token || '';

  const $ = (id) => document.getElementById(id);
  const main = $('sh-main');
  const tree = $('sh-tree');
  const treeBody = $('sh-tree-body');
  const treeName = $('sh-id-name');
  const treeSub = $('sh-id-sub');
  const treeIcon = $('sh-id-icon');
  const chipsEl = $('sh-chips');
  const pinBtn = $('sh-pin');
  const edgeEl = $('sh-edge');
  const gripEl = $('sh-grip');
  const zipBtn = $('sh-zip');
  const zipLabel = $('sh-zip-label');
  const selAll = $('sh-selall');
  const allLabel = $('sh-all-label');
  const floatBar = $('sh-float');
  const floatName = $('sh-float-name');
  const floatDl = $('sh-float-dl');

  // ---- 运行状态 -----------------------------------------------------------
  let SH = null;                 // 分享元数据
  let isSingle = false;          // 单文件分享
  let rootEntries = [];          // 根层条目
  // 目录展开状态：path -> { open, children, loading, err }
  //   children === null 表示"还没取过"（懒加载）—— 这与"取到了但是空的"不同，
  //   两者必须分开，否则空目录每次展开都会重新请求。
  const dirs = new Map();
  let sel = new Set();           // 勾选项：**相对分享根的路径**（可跨目录）
  let curFile = '';              // 正在预览的文件路径
  let pinned = false;            // f：是否固定面板
  let closeTimer = 0;
  // ★ 是否正在拖宽度（2026-10-01 用户报障后新增）★
  //   用户原话：「左边 文件树 鼠标调整宽度 目前操作有点问题。需求是按住鼠标
  //             左键移动 左右调整大小。」
  //   真因：拖过宽度上下限（200 / 560）时，面板边缘停在夹取处、而光标继续走
  //   ⇒ 光标离开了面板 ⇒ `mouseleave` → `scheduleClose` → 240ms 后**面板被收走**，
  //   而用户手指还按着呢。松手那一刻光标若落在面板外沿，同样触发。
  //   ⇒ 拖拽期间（以及刚松手的一小段）一律不许自动收起。
  let draggingPanel = false;

  // ---- 小工具 -------------------------------------------------------------
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function toast(msg, ms = 3600) {
    const t = $('sh-toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    // 必须自己消失：切到下一层/下一个文件时还挂着会挡内容
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

  /**
   * 打包下载地址。
   *
   * ★ items 是「相对**分享根**的路径」，所以 path 一律传空 ★
   *   后端 /api/s/{t}/zip 的原语义是「path 目录下的一组名字」，
   *   只适合"当前这一层里勾几项"。但左侧文件树可以让访客勾选**跨目录**的项
   *   （展开 a/ 勾一个、展开 b/ 再勾一个）—— 那种选择集用一个 path 表达不了。
   *   为此后端放开了 item 里的 `/`（仍然逐个过 `_resolve_in_share` 做越权校验，
   *   只是不再要求"必须是当前目录下的一个名字"），于是这里统一用
   *   `path=''` + 根相对路径。items 为空 = 打包整个分享根。
   *
   *   包内保留目录层级（arcname 就是那条相对路径）—— 不同目录下的同名文件
   *   因此不会互相覆盖。
   */
  const zipUrl = (items) => {
    const q = new URLSearchParams({ path: '' });
    (items || []).forEach((p) => q.append('item', p));
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
  //   ★ 每个图标带一个 `k-<类型>` class ★
  //     颜色由 share.css 的 --c-* 变量表决定 —— 树里因此一眼能分出
  //     文件夹/图片/视频/音频/文档/图纸/压缩包，而不是一列灰方块。
  const SVG = (cls, body) => `<svg class="sh-ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
  const ICON = {
    dir: SVG('k-dir', '<path fill="currentColor" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.4c.4 0 .8.16 1.06.44L11.4 6h7.1A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
    file: SVG('k-file', '<path fill="currentColor" d="M6 2h7l5 5v15H6z" opacity=".9"/><path fill="currentColor" d="M13 2l5 5h-5z" opacity=".5"/>'),
    image: SVG('k-image', '<path fill="currentColor" d="M4 4h16v16H4z" opacity=".22"/><path fill="currentColor" d="M6 16.5 9.6 12l2.6 3.2L15 11l3 5.5z"/><circle cx="8.6" cy="8.2" r="1.7" fill="currentColor"/>'),
    video: SVG('k-video', '<path fill="currentColor" d="M4 5h16v14H4z" opacity=".22"/><path fill="currentColor" d="M10 8.5l6 3.5-6 3.5z"/>'),
    audio: SVG('k-audio', '<path fill="currentColor" d="M9 5.2 18 3v13.4a2.6 2.6 0 1 1-1.6-2.4V6.1L10.6 7.4v9.9A2.6 2.6 0 1 1 9 14.9z"/>'),
    text: SVG('k-text', '<path fill="currentColor" d="M5 3h14v18H5z" opacity=".2"/><path stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M8 8h8M8 12h8M8 16h5"/>'),
    doc: SVG('k-doc', '<path fill="currentColor" d="M6 2h7l5 5v15H6z" opacity=".9"/><path fill="currentColor" d="M13 2l5 5h-5z" opacity=".5"/><path stroke="currentColor" stroke-opacity=".35" stroke-width="1.3" d="M8.5 13h7M8.5 16h5"/>'),
    pdf: SVG('k-pdf', '<path fill="currentColor" d="M6 2h7l5 5v15H6z" opacity=".9"/><path fill="currentColor" d="M13 2l5 5h-5z" opacity=".5"/><path stroke="currentColor" stroke-opacity=".35" stroke-width="1.3" d="M8.5 13h7M8.5 16h5"/>'),
    cad: SVG('k-cad', '<path fill="currentColor" d="M4 4h16v16H4z" opacity=".18"/><path stroke="currentColor" stroke-width="1.5" fill="none" d="M7 15.5 10 8l3 7.5M8 13h4M15.5 8v7.5h3"/>'),
    archive: SVG('k-archive', '<path fill="currentColor" d="M5 3h14v18H5z" opacity=".9"/><path fill="currentColor" d="M11 3h2v3h-2zM11 8h2v3h-2zM11 13h2v3h-2z" opacity=".45"/><path fill="currentColor" d="M10.4 17h3.2v4h-3.2z"/>'),
  };
  const BIG = {
    dir: SVG('k-dir', '<path fill="currentColor" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.4c.4 0 .8.16 1.06.44L11.4 6h7.1A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
    file: SVG('k-file', '<path fill="currentColor" d="M6 2h7l5 5v15H6z" opacity=".9"/><path fill="currentColor" d="M13 2l5 5h-5z" opacity=".5"/>'),
    image: SVG('k-image', '<path fill="currentColor" d="M4 4h16v16H4z" opacity=".2"/><path fill="currentColor" d="M6 16.5 9.6 12l2.6 3.2L15 11l3 5.5z"/><circle cx="8.6" cy="8.2" r="1.7" fill="currentColor"/>'),
    video: SVG('k-video', '<path fill="currentColor" d="M4 5h16v14H4z" opacity=".2"/><path fill="currentColor" d="M10 8.5l6 3.5-6 3.5z"/>'),
    audio: SVG('k-audio', '<path fill="currentColor" d="M9 5.2 18 3v13.4a2.6 2.6 0 1 1-1.6-2.4V6.1L10.6 7.4v9.9A2.6 2.6 0 1 1 9 14.9z"/>'),
    text: SVG('k-text', '<path fill="currentColor" d="M5 3h14v18H5z" opacity=".18"/><path stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M8 8h8M8 12h8M8 16h5"/>'),
    doc: SVG('k-doc', '<path fill="currentColor" d="M6 2h7l5 5v15H6z" opacity=".9"/><path fill="currentColor" d="M13 2l5 5h-5z" opacity=".5"/>'),
    pdf: SVG('k-pdf', '<path fill="currentColor" d="M6 2h7l5 5v15H6z" opacity=".9"/><path fill="currentColor" d="M13 2l5 5h-5z" opacity=".5"/>'),
    cad: SVG('k-cad', '<path fill="currentColor" d="M4 4h16v16H4z" opacity=".18"/><path stroke="currentColor" stroke-width="1.5" fill="none" d="M7 15.5 10 8l3 7.5M8 13h4M15.5 8v7.5h3"/>'),
    archive: SVG('k-archive', '<path fill="currentColor" d="M5 3h14v18H5z" opacity=".9"/><path fill="currentColor" d="M11 3h2v3h-2zM11 8h2v3h-2zM11 13h2v3h-2z" opacity=".45"/>'),
  };

  const DL_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<path d="M8 2.2v7.2m0 0 2.9-2.9M8 9.4 5.1 6.5M3 12.6h10" stroke="currentColor"'
    + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CARET = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<path d="M6 3.6 10.4 8 6 12.4" stroke="currentColor" stroke-width="1.7"'
    + ' stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICONSVG_EMPTY = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
    + '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3l1.6 2h8.4A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"'
    + ' stroke="currentColor" stroke-width="1.6"/></svg>';

  const ARCHIVE_EXT = ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso'];

  function extOf(e) {
    return String((e && (e.ext || String(e.name || '').split('.').pop())) || '').toLowerCase();
  }

  /** 类型键：决定图标与配色（dir / image / video / audio / text / doc / pdf / cad / archive / file） */
  function iconKey(e) {
    if (e && e.isDir) return 'dir';
    const ext = extOf(e);
    if (ext === 'pdf') return 'pdf';
    if (ARCHIVE_EXT.includes(ext)) return 'archive';
    const k = kindOf(e);
    if (k === 'onlyoffice') return 'doc';
    if (k === 'kkfileview') return 'file';
    return k || 'file';
  }

  // ==========================================================================
  //  一、左面板的开合 / 固定 / 宽度    （对应需求 d、f）
  // ==========================================================================

  function openTree() {
    clearTimeout(closeTimer);
    tree.dataset.open = 'true';
  }

  function closeTree() {
    // 固定状态下不许自动收起（f：「固定后就固定在边上」）
    if (pinned) return;
    // ★ 正在拖宽度时也不许收 ★（见 draggingPanel 的说明：用户报障的"一拖就跑掉"）
    if (draggingPanel) return;
    clearTimeout(closeTimer);
    tree.dataset.open = 'false';
  }

  /** 延迟收起：鼠标只是"路过"面板边缘时不要一闪一闪 */
  function scheduleClose() {
    if (pinned || draggingPanel) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      // 鼠标又回到面板/热区里了就别收
      if (tree.matches(':hover') || edgeEl.matches(':hover')) return;
      closeTree();
    }, 240);
  }

  function setPinned(v) {
    pinned = !!v;
    tree.dataset.pinned = pinned ? 'true' : 'false';
    pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    pinBtn.title = pinned ? '取消固定（之后鼠标移开会自动收起）' : '固定面板（固定后不会自动收起）';
    if (pinned) openTree();
    try { localStorage.setItem('nebula.shareTreePin', pinned ? '1' : '0'); } catch { /* 隐私模式 */ }
  }

  /** d：宽度可手动调整（拖右缘手柄） */
  function setWidth(px, persist) {
    // 下限 200（再窄名字就看不全了）、上限 min(560, 视口 62%)
    const max = Math.min(560, Math.round(window.innerWidth * 0.62));
    const w = Math.max(200, Math.min(max, Math.round(px)));
    document.documentElement.style.setProperty('--sh-tree-w', w + 'px');
    if (persist) {
      try { localStorage.setItem('nebula.shareTreeW', String(w)); } catch { /* 忽略 */ }
    }
  }

  function bindGrip() {
    if (!gripEl) return;
    let dragging = false;
    let grace = 0;        // 松手后的"别急着收"计时器
    let rearm = null;     // 松手后挂上去的「一次性重新武装」监听
    gripEl.addEventListener('pointerdown', (e) => {
      dragging = true;
      draggingPanel = true;
      clearTimeout(grace);
      if (rearm) { document.removeEventListener('pointermove', rearm, true); rearm = null; }
      tree.classList.add('no-anim');
      gripEl.classList.add('is-dragging');
      // 全局变成"左右拖"光标：不然光标一出面板就恢复成箭头，
      // 拖到预览区 iframe 上更是直接被 iframe 的默认光标接管，
      // 用户完全不知道自己还在拖 —— 这就是"操作有点问题"的一半。
      document.documentElement.classList.add('is-grip-drag');
      // ★ setPointerCapture 是必须的 ★
      //   不捕获的话，鼠标快速划过预览区的 iframe，指针进了嵌套浏览上下文，
      //   父文档收不到 pointermove/pointerup ⇒ 手柄卡住、松手还在拖。
      try { gripEl.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
      e.preventDefault();
    });
    gripEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      setWidth(e.clientX, false);
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      tree.classList.remove('no-anim');
      gripEl.classList.remove('is-dragging');
      document.documentElement.classList.remove('is-grip-drag');
      try { gripEl.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
      setWidth(parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--sh-tree-w')) || 268, true);

      // ★★ 松手后**不要**立刻恢复「鼠标移开就收起」★★
      //   报障就是这个：拖到宽度上下限时，面板边缘停在光标**内侧**
      //   （宽度被夹住，光标还在往外走）⇒ 松手那一刻光标本来就在面板外。
      //   若此时按"鼠标不在面板上"来判，`scheduleClose` 会在 240ms 后
      //   把用户刚拖好的面板**收走**。
      //   正解：松手后先保持"拖拽态"；等用户**下一次真的移动鼠标**
      //   （那才是他自己要走开）时，再重新武装正常的自动收起。
      clearTimeout(grace);
      grace = setTimeout(() => { draggingPanel = false; }, 200);
      if (rearm) document.removeEventListener('pointermove', rearm, true);
      rearm = (ev) => {
        // 指针还在面板上 → 用户没走，继续等（监听保持武装）
        if (tree.matches(':hover')) return;
        // 落在左边缘热区里也算"没走"（面板收起时靠它滑出来）
        const ew = parseInt(getComputedStyle(document.documentElement)
          .getPropertyValue('--sh-edge-w'), 10) || 12;
        if (ev && ev.clientX <= ew) return;
        // 到这里才是"用户自己把鼠标移开了" ⇒ 恢复正常的自动收起
        document.removeEventListener('pointermove', rearm, true);
        rearm = null;
        clearTimeout(grace);
        draggingPanel = false;
        scheduleClose();
      };
      document.addEventListener('pointermove', rearm, true);
    };
    gripEl.addEventListener('pointerup', end);
    gripEl.addEventListener('pointercancel', end);
  }

  function bindPanel() {
    // d：鼠标靠左边缘 → 滑出
    edgeEl.addEventListener('mouseenter', openTree);
    edgeEl.addEventListener('click', openTree);
    // 鼠标进入面板本身 → 保持打开
    tree.addEventListener('mouseenter', () => { clearTimeout(closeTimer); openTree(); });
    tree.addEventListener('mouseleave', scheduleClose);

    // f：固定图标
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setPinned(!pinned);
    });

    // f：未固定时，点击预览区 → 文件树自动收起
    //   ★ 用 mousedown 而不是 click ★
    //     click 要等 mouseup 且要求按下/抬起在同一元素；访客在图片上拖一下
    //     选区就不触发了。mousedown 更贴近"我去操作预览了"这个意图。
    //   ⚠️ iframe 预览（kk / CAD / OnlyOffice）里的事件父文档收不到 ——
    //     那种情况下靠"鼠标移出面板即收起"（scheduleClose）兜底。
    main.addEventListener('mousedown', () => closeTree());

    // 键盘：Esc 收起面板（未固定时）
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !pinned && tree.dataset.open === 'true') closeTree();
    });

    // 视口变化时把宽度重新夹一遍（否则缩小窗口后面板会盖满整页）
    window.addEventListener('resize', () => {
      const cur = parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--sh-tree-w')) || 268;
      setWidth(cur, false);
    });

    // 恢复上次的宽度与固定状态
    try {
      const w = Number(localStorage.getItem('nebula.shareTreeW'));
      if (w > 0) setWidth(w, false);
      if (localStorage.getItem('nebula.shareTreePin') === '1') setPinned(true);
    } catch { /* 隐私模式：用默认值 */ }

    bindGrip();
  }

  // ==========================================================================
  //  二、文件树    （对应需求 c、d、e）
  // ==========================================================================

  function sortEntries(list) {
    // 目录在前，再按名字（与桌面端 explorer 的习惯一致）
    return [...list].sort((a, b) => {
      if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN', { numeric: true });
    });
  }

  /**
   * 一行的 HTML。
   *   ★ c：右侧只有「大小 + 下载图标」，**没有日期** ★
   *     之前那一版有「修改日期」列。分享页的访客关心的是"这是什么、
   *     多大、怎么拿走"，日期既不帮他判断也不帮他决策，却稳定占掉
   *     面板里最宝贵的一列宽度（面板本来就"不要太宽"）。
   *   ★ 文件夹行没有下载按钮 ★
   *     下载一个文件夹是"打包为 zip"的语义，和文件行的"直接取流"不是
   *     一回事；把它做成同一个图标只会让人误以为会下到一个文件夹。
   *     要打包文件夹 → 勾上它，用底部的「打包下载」。
   */
  function nodeRow(e, path, depth, isOpen) {
    const key = iconKey(e);
    const picked = sel.has(path);
    const indent = 2 + depth * 13;
    const twist = e.isDir
      ? `<button type="button" class="sh-twist" data-twist="${esc(path)}"
                 aria-label="${isOpen ? '收起' : '展开'} ${esc(e.name)}">${CARET}</button>`
      : '<span class="sh-twist leaf"></span>';
    const dl = e.isDir ? ''
      : `<button type="button" class="sh-row-dl" data-dl="${esc(path)}"
                 title="下载 ${esc(e.name)}" aria-label="下载 ${esc(e.name)}">${DL_SVG}</button>`;
    return `<div class="sh-node${picked ? ' is-picked' : ''}${path === curFile ? ' is-current' : ''}"
                 role="treeitem" data-node="${esc(path)}" data-dir="${e.isDir ? 1 : 0}"
                 ${e.isDir ? `data-open="${isOpen ? 'true' : 'false'}"` : ''}
                 style="padding-left:${indent}px">
      ${twist}
      <input type="checkbox" class="sh-cb" data-cb="${esc(path)}"${picked ? ' checked' : ''}
             aria-label="选择 ${esc(e.name)}">
      ${ICON[key]}
      <span class="nm" title="${esc(path)}">${esc(e.name)}</span>
      <span class="sz">${e.isDir ? '' : esc(fmtSize(e.size))}</span>
      ${dl}
    </div>`;
  }

  function indentOf(depth) { return 2 + depth * 13 + 16; }

  function renderTree() {
    if (isSingle) return;
    const rows = [];
    const walk = (entries, depth, parent) => {
      for (const e of sortEntries(entries)) {
        const p = parent ? `${parent}/${e.name}` : e.name;
        const st = dirs.get(p);
        const isOpen = !!(st && st.open);
        rows.push(nodeRow(e, p, depth, isOpen));
        if (!e.isDir || !isOpen) continue;
        const pad = indentOf(depth + 1);
        if (st.loading) {
          rows.push(`<div class="sh-node-loading" style="padding-left:${pad}px">载入中…</div>`);
        } else if (st.err) {
          rows.push(`<div class="sh-node-empty" style="padding-left:${pad}px">读取失败：${esc(st.err)}</div>`);
        } else if (!st.children || !st.children.length) {
          rows.push(`<div class="sh-node-empty" style="padding-left:${pad}px">（空文件夹）</div>`);
        } else {
          walk(st.children, depth + 1, p);
        }
      }
    };
    walk(rootEntries, 0, '');
    treeBody.innerHTML = rows.length ? rows.join('')
      : '<div class="sh-node-empty">（空文件夹）</div>';
    bindTreeRows();
    syncSel();
  }

  async function toggleDir(path) {
    const st = dirs.get(path) || { open: false, children: null };
    if (st.open) {
      st.open = false;
      dirs.set(path, st);
      renderTree();
      return;
    }
    st.open = true;
    dirs.set(path, st);
    if (!st.children) {                       // 懒加载：第一次展开才取
      st.loading = true;
      renderTree();
      try {
        const data = await jget(`${apiBase()}/list?` + new URLSearchParams({ path }));
        st.children = data.entries || [];
        st.err = '';
      } catch (err) {
        st.children = [];
        st.err = err.message || String(err);
      }
      st.loading = false;
      dirs.set(path, st);
    }
    renderTree();
  }

  function bindTreeRows() {
    treeBody.querySelectorAll('[data-twist]').forEach((b) => {
      b.addEventListener('click', (e) => { e.stopPropagation(); toggleDir(b.dataset.twist); });
    });
    treeBody.querySelectorAll('[data-cb]').forEach((cb) => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        const p = cb.dataset.cb;
        if (cb.checked) sel.add(p); else sel.delete(p);
        syncSel();
      });
    });
    treeBody.querySelectorAll('[data-dl]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        location.href = rawUrl(b.dataset.dl, true);
      });
    });
    treeBody.querySelectorAll('[data-node]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-twist]') || e.target.closest('.sh-cb')
            || e.target.closest('.sh-row-dl')) return;
        const p = row.dataset.node;
        if (row.dataset.dir === '1') { toggleDir(p); return; }
        const ent = findEntry(p);
        if (ent) previewFile(p, ent);
      });
    });
  }

  /** 按「相对分享根路径」在当前已展开的树里找回那条 entry */
  function findEntry(path) {
    const segs = String(path).split('/');
    let list = rootEntries;
    for (let i = 0; i < segs.length; i++) {
      const e = list.find((x) => x.name === segs[i]);
      if (!e) return null;
      if (i === segs.length - 1) return e;
      const st = dirs.get(segs.slice(0, i + 1).join('/'));
      if (!st || !st.children) return null;
      list = st.children;
    }
    return null;
  }

  // ---- e：多选 + 打包下载（按钮在左面板底部）------------------------------
  /** 当前"看得见"的所有行路径 —— 全选只作用于它们，不做"猜不到的暗选" */
  function visiblePaths() {
    return [...treeBody.querySelectorAll('[data-node]')].map((n) => n.dataset.node);
  }

  function syncSel() {
    // 行的勾选态
    treeBody.querySelectorAll('[data-node]').forEach((row) => {
      const on = sel.has(row.dataset.node);
      row.classList.toggle('is-picked', on);
      const cb = row.querySelector('.sh-cb');
      if (cb) cb.checked = on;
    });

    const paths = visiblePaths();
    const pickedVisible = paths.filter((p) => sel.has(p)).length;

    selAll.checked = paths.length > 0 && pickedVisible === paths.length;
    selAll.indeterminate = pickedVisible > 0 && pickedVisible < paths.length;
    allLabel.textContent = pickedVisible && pickedVisible === paths.length
      ? '取消全选' : '全选';

    const n = sel.size;
    zipLabel.textContent = n ? `下载选中 ${n} 项` : '打包下载';
    zipBtn.title = n
      ? `把勾选的 ${n} 项打成 ZIP 下载`
      : '把整个分享内容打成 ZIP 下载';
    zipBtn.disabled = false;
  }

  function bindFooter() {
    selAll.addEventListener('change', () => {
      const paths = visiblePaths();
      if (selAll.checked) paths.forEach((p) => sel.add(p));
      else paths.forEach((p) => sel.delete(p));
      syncSel();
    });
    zipBtn.addEventListener('click', () => {
      // items 为空 → 整包；否则只打勾选的（可跨目录）
      location.href = zipUrl([...sel]);
    });
  }

  // ---- 分享身份（原来信息卡的内容，压进面板头部）--------------------------
  function renderMeta() {
    if (!SH) return;
    const key = iconKey({ isDir: SH.isDir });
    treeIcon.className = 'sh-tree-ico';
    treeIcon.innerHTML = BIG[key] || BIG.file;
    treeName.textContent = SH.name || '文件分享';
    treeName.title = treeName.textContent;
    treeSub.textContent = SH.owner ? `由 ${SH.owner} 分享` : '';

    const out = [];
    if (SH.isDir) out.push(`${rootEntries.length} 项`);
    out.push(fmtLeft(SH.expiresAt));
    if (SH.hasPassword) out.push('需提取码');
    chipsEl.innerHTML = out.map((c) => {
      const warn = c === '已过期';
      return `<span class="sh-chip${warn ? ' warn' : ''}">${esc(c)}</span>`;
    }).join('');
  }

  // ==========================================================================
  //  三、错误 / 提取码
  // ==========================================================================
  function renderError(msg) {
    tree.hidden = true;
    edgeEl.hidden = true;
    main.innerHTML = `<div class="sh-center">
      <div class="sh-card-ico">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.7"/>
          <path d="M12 7.8v5M12 16.1h.01" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="sh-full">${esc(msg || '这个分享链接不可用')}</div>
      <div class="sh-dim">请联系分享给你的人重新获取一条链接。</div>
    </div>`;
  }

  function renderLocked() {
    tree.hidden = true;
    edgeEl.hidden = true;
    main.innerHTML = `<div class="sh-center">
      <div class="sh-card-ico">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
          <rect x="5" y="10.5" width="14" height="9.5" rx="2" stroke="currentColor" stroke-width="1.7"/>
          <path d="M8.4 10.5V8a3.6 3.6 0 0 1 7.2 0v2.5" stroke="currentColor" stroke-width="1.7"/>
        </svg>
      </div>
      <div class="sh-full">这条分享需要提取码</div>
      <div class="sh-lock-form">
        <input type="password" id="sh-pw" placeholder="请输入提取码" autocomplete="off">
        <button type="button" class="sh-btn primary" id="sh-unlock">打开</button>
      </div>
      <div class="sh-dim" id="sh-pw-err"></div>
    </div>`;

    const pw = $('sh-pw');
    const errEl = $('sh-pw-err');
    const btn = $('sh-unlock');
    const submit = async () => {
      const v = pw.value.trim();
      if (!v) return;
      btn.disabled = true;
      errEl.textContent = '';
      try {
        const fd = new FormData();
        fd.append('password', v);
        const r = await fetch(`${apiBase()}/unlock`, { method: 'POST', body: fd, credentials: 'same-origin' });
        let d = null;
        try { d = await r.json(); } catch { /* 非 JSON */ }
        if (!r.ok || !(d && d.ok)) throw new Error((d && (d.error || d.detail)) || '提取码不正确');
        // 解锁成功后整页重载：服务端会带上 Cookie 渲染出真正的分享页
        location.reload();
      } catch (err) {
        errEl.textContent = err.message || '提取码不正确';
        btn.disabled = false;
        pw.select();
      }
    };
    btn.addEventListener('click', submit);
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    setTimeout(() => pw.focus(), 80);
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
    const ext = extOf(e);
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

  /**
   * 渲染下载兜底（预览失败 / 该格式没有引擎）。
   * ★ 一定要给出"出口" ★ 只报一句"无法预览"等于把访客堵死。
   */
  function renderPreviewFallback(box, sub) {
    box.innerHTML = `<div class="sh-center">
      <div class="sh-card-ico">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">
          <path d="M12 4.5v10m0 0 4-4m-4 4-4-4M5 18.5h14" stroke="currentColor"
                stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="sh-dim">该格式暂不支持在线预览</div>
      <button type="button" class="sh-btn primary" data-role="fb-dl">下载文件</button>
    </div>`;
    const b = box.querySelector('[data-role="fb-dl"]');
    if (b) b.addEventListener('click', () => { location.href = rawUrl(sub, true); });
  }

  /**
   * 把预览装进容器（单文件分享的整页 / 目录分享点开文件后的整页，同一条腿）。
   * 这样"单文件直接打开"和"目录里点开文件"不会走出两套渲染逻辑。
   */
  async function mountPreview(box, sub, e) {
    const kind = kindOf(e);
    const src = rawUrl(sub, false);       // inline 取流（预览用，不是下载）
    const nm = (e && e.name) || '';

    // ① 图片：直接 <img>，省一次预览服务往返（也更快）
    if (kind === 'image') {
      box.innerHTML = `<img src="${esc(src)}" alt="${esc(nm)}">`;
      return;
    }

    // ② 视频 / 音频：浏览器原生播放器（与网盘 openMedia 同一条腿）
    if (kind === 'video' || kind === 'audio') {
      box.innerHTML = `<div class="sh-media-wrap">${
        kind === 'video'
          ? `<video class="sh-media" src="${esc(src)}" controls autoplay playsinline></video>`
          : `<audio class="sh-media" src="${esc(src)}" controls autoplay></audio>`
      }</div>`;
      return;
    }

    // ③ 纯文本：取流后本地解码（编码嗅探与网盘一致），不走任何转换服务
    if (kind === 'text') {
      box.innerHTML = '<div class="sh-center"><div class="spinner"></div></div>';
      try {
        const r = await fetch(src, { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = await r.arrayBuffer();
        box.innerHTML = `<pre class="sh-text">${esc(decodeSmart(buf))}</pre>`;
      } catch (err) {
        renderPreviewFallback(box, sub);
      }
      return;
    }

    // ④ 其余交给后端路由：cad-viewer / OnlyOffice / kkFileView
    //    ★ 后端只返回「用哪个引擎」，具体地址由它给 —— 前端不拼引擎地址 ★
    try {
      const cfg = await jget(previewUrl(sub));
      box.innerHTML = '';
      if (cfg.route === 'onlyoffice' && cfg.config) {
        // OnlyOffice：用官方 api.js 挂载（与桌面端同一套）
        const holder = document.createElement('div');
        holder.className = 'sh-fill';
        holder.id = 'sh-oo-holder';
        box.appendChild(holder);
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
        box.appendChild(f);
      } else {
        // 后端明确回了 route=download（无在线预览能力）→ 与网盘一样只给下载
        throw new Error('没有可用的预览器');
      }
    } catch (err) {
      // 预览失败不阻断：给一个"直接下载"的出口
      toast('无法在线预览：' + (err.message || err));
      renderPreviewFallback(box, sub);
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

  /** 在**整页主区**里预览一个文件（目录分享点开某项） */
  async function previewFile(path, e) {
    curFile = path;
    floatBar.hidden = true;
    treeBody.querySelectorAll('[data-node]').forEach((n) => {
      n.classList.toggle('is-current', n.dataset.node === path);
    });
    main.innerHTML = '<div class="sh-center"><div class="spinner"></div></div>';
    await mountPreview(main, path, e);
  }

  // ==========================================================================
  //  四、加载与启动
  // ==========================================================================
  async function loadRoot() {
    treeBody.innerHTML = '<div class="sh-node-loading">载入中…</div>';
    const data = await jget(`${apiBase()}/list?` + new URLSearchParams({ path: '' }));
    SH = data.share || SH || {};
    isSingle = !!data.single;
    rootEntries = data.entries || [];

    if (isSingle) {
      // ---- 单文件分享：不要文件树，直接铺满预览（a + b）----
      tree.hidden = true;
      edgeEl.hidden = true;
      renderMeta();
      const e = rootEntries[0] || { name: SH.name || '文件', isDir: false };
      // ★ 「文件名 + 下载」这枚浮动条在**显示区右下角**（位置由 share.css 定）
      //   用户要求（原话）：「所有单文件分享界面 文件名 和 下载按钮 放到
      //   显示区域的右下角。包括OO」
      //   ⚠️ **对 OO 也要显示**，别因为"OnlyOffice 自带下载按钮"把它藏掉 ——
      //      那是被用户否掉的一版（先要求藏、随即要求改为放右下角）。
      //      要藏的话，藏掉的是访客唯一的通用出口，OO 一旦打不开就没有下载入口。
      floatName.textContent = e.name || SH.name || '文件';
      floatName.title = floatName.textContent;
      floatDl.href = rawUrl('', true);
      floatBar.hidden = false;
      await mountPreview(main, '', e);
      return;
    }

    renderMeta();
    renderTree();
    openTree();      // 首次打开先露一下面板，否则访客不知道左边有东西
    // 根层第一个文件先预览起来 —— 否则整页是空的，像坏了。
    // （只预览文件；根层全是文件夹时就留空态提示。）
    const first = sortEntries(rootEntries).find((x) => !x.isDir);
    if (first) await previewFile(first.name, first);
    else renderEmptyMain();
  }

  function renderEmptyMain() {
    main.innerHTML = `<div class="sh-empty">
      ${ICONSVG_EMPTY}
      <div class="t">从左侧文件树选择一个文件</div>
      <div class="h">鼠标移到屏幕左边缘即可拉出文件树</div>
    </div>`;
  }

  (function boot() {
    if (BOOT.error) { renderError(BOOT.error); return; }
    if (!BOOT.unlocked) {
      renderLocked();
      return;
    }
    // 提取码页/错误页不需要面板与热区（它们在 renderLocked/renderError 里被隐藏）
    bindPanel();
    bindFooter();
    loadRoot().catch((err) => renderError(err.message || String(err)));
  })();
})();
