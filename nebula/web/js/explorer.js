/* ==========================================================================
   NebulaDisk —— 资源管理器（主应用）
   --------------------------------------------------------------------------
   这是整个云盘的核心界面。一个 Explorer 实例 = 一个窗口 = 一个映射目录的
   浏览会话。多开时互不干扰（历史栈、选中项、视图模式都各自独立）。

   关键交互：
     - 双击文件夹 → 进入；双击文件 → 按 route 打开预览器
     - 单击选中，Ctrl/Shift 多选，框选
     - 右键菜单：文件/文件夹/空白区 三套
     - 地址栏面包屑可点击跳转
     - 视图模式（图标/列表）与排序持久化到 localStorage
   ========================================================================== */

const Explorer = (() => {

  const state = {
    instances: new Map(),
  };

  /** 打开一个资源管理器窗口
   *
   *  ★ 窗口 id 的粒度：**一个映射一个窗口** ★
   *
   *  曾经这里有个 `opts.newWindow` 开关，双击文件夹时会用
   *  `explorer:<mount>:<path>` 作窗口 id 另开一扇。现已废除 ——
   *  用户明确判定那只行为不对（见 openChild() 的完整说明）：
   *  真实的 Windows 资源管理器双击文件夹是**在当前窗口原地前进**。
   *
   *  因此窗口 id 恒为 `explorer:<mount>`：
   *    - 再次打开同一映射 → 复用同一个窗口（下面 existing 分支），不叠窗
   *    - 进入子目录 → navigate() 原地换目录，同样不产生新窗口
   *  这样「双击文件夹冒出第二个窗口」从根上不可能再发生。
   */
  function open(mountLabel, initialPath = '', opts = {}) {
    const winId = `explorer:${mountLabel}`;

    // 已开则聚焦并跳转（同一映射重复打开只聚焦，不叠窗）
    const existing = WM.get(winId);
    if (existing && existing.opts.nav) {
      existing.opts.nav.go(initialPath, { push: true });
      WM.restore(winId);
      return existing;
    }

    const S = {
      winId,
      mount: mountLabel,
      path: '/',
      history: [],
      hIndex: -1,
      entries: [],
      selected: new Set(),
      // 默认列表视图：文件名/大小/时间属性一眼可见，比图标网格更适合文件管理
      view: localStorage.getItem('nebula.view') || 'list',
      sortKey: localStorage.getItem('nebula.sortKey') || 'name',
      sortAsc: localStorage.getItem('nebula.sortAsc') !== 'false',
      filter: '',
      loading: false,
      lastClickIdx: -1,
      infoOpen: false,
    };

    // ★ 标题 ★
    //   恒为映射名（盘符名）—— 因为一个映射只有一个窗口，
    //   不存在「并排好几个同盘符窗口分不清谁是谁」的问题。
    const title = mountLabel;

    const win = WM.open({
      id: winId,
      title,
      icon: Icons.ui('folder', 16),
      width: 1100, height: 700,
      minWidth: 560, minHeight: 380,
      // 与所有预览/编辑窗口统一：无标题栏，动作按钮靠左、窗口三键靠最右
      chromeless: true,
      render: (body) => renderShell(body, S),
    });

    if (!win) return null;
    state.instances.set(winId, S);

    // 暴露给外部（app.js 需要用它做导航）
    win.opts.nav = {
      go: (p, o) => navigate(win, S, p, o),
      get path() { return S.path; },
      get mount() { return S.mount; },
      refresh: () => load(win, S),
    };

    // ★ 拖拽上传：把「文件拖进文件夹窗口」接到 actUpload 的上传管线上 ★
    //   app.js 的全局 drop 兜底会用 activeExplorer() 找窗口，但那只在
    //   窗口自身没接管时才用得上；真正的落点高亮与命中判定放在窗口内部
    //   （见 bindDropUpload），这样多开时也不会传错目录。
    win.opts.onDropFiles = (files) => {
      if (files && files.length) uploadFiles(win.bodyEl, S, files);
    };

    // 首屏
    navigate(win, S, initialPath || '/', { replace: true });
    return win;
  }


  /* ----------------------------------------------------------------------
     双击文件夹 → 在**当前窗口内**进入该目录

     需求（原文）：「文件夹窗口 双击文件夹，目前是打开的新的文件夹窗口，
     这是不对的。」

     ★ 历史反复，这里说清楚为什么最终选「原地进入」★
       曾一度改成 open(..., {newWindow:true})（每个目录一个窗口），
       理由是"资源管理器双击会开新窗口"。但那是我误读了 Windows 行为：
       真实资源管理器双击文件夹是**在当前窗口原地前进**，
       只有按住 Ctrl / 双击新标签 才会另开一扇。
       用户明确判定「打开新的文件夹窗口……是不对的」，故改回原地进入。

     ★ 现在行为 ★
       navigate(body, S, childPath, { push: true })
         - 在当前窗口内换目录，并压入历史栈（可用后退回到上层）
         - 地址栏、面包屑、标题、列表随之更新
         - 不产生任何新窗口

     注：本函数也被右键菜单「打开」与信息面板「打开」复用，
     三处入口行为自此一致。
     ------------------------------------------------------------------ */
  function openChild(body, S, name) {
    const childPath = joinPath(S.path, name);
    return navigate(body, S, childPath, { push: true });
  }


  /* ======================================================================
     界面骨架
     ====================================================================== */
  function renderShell(body, S) {
    // ★ 无侧栏 ★
    //   需求：去掉左侧的导航/挂载点/服务状态侧栏，让文件区占满整个窗口。
    //   磁盘与目录入口改由「此电脑」窗口承担（双击桌面上的「此电脑」），
    //   服务健康状态同样在「此电脑」里以卡片形式展示（含 CAD 查看器）。
    //   因此这里不再渲染 <aside class="sidebar">，renderSidebar 也不再调用。
    body.innerHTML = `
      <div class="content">
        <!--
          ★ 文件夹窗口**可拖动** ★
            用户需求变更（原文）：「文件夹窗口不能拖动，需要增加可以点住鼠标拖动。」

            历史：早先用户要求「编辑/预览窗口可以移动，文件夹窗口不能移动」，
            所以这条手写工具栏**故意不加** data-drag-handle —— WM._bindDrag
            找不到 [data-role="titlebar"] 就退化为 [data-drag-handle]，两者都
            没有就完全拖不动。现在需求反过来了，把 data-drag-handle 加回来。

          ★ 2026-09-21 重构：工具栏不再手写，改为复用 WM.Toolbar.build ★
            以前这里是一大段手写 HTML，与预览窗口（走 WM.Toolbar.build）
            各维护一份**结构相同**的工具栏。两份必然漂移，而且已经造成过
            「两种窗口都要改」的反复返工（拖拽/置顶/按钮失效都遇到过）。
            现在只有**一个**工具栏工厂：

              左  [业务按钮…]  …spacer…  [搜索/视图/排序…]  [— □ ×]  右

            它同时还提供 data-drag-handle（整条工具栏都是拖动区）、
            统一的 [data-role="titlebar"] 兜底与三键 —— 与预览窗口逐字一致。

            ★ 按钮属性约定 ★
              业务按钮： class="tbtn"    +  data-a="动作"
              窗口控制键：class="tb-btn"  +  data-act="min|max|close"
              （判据要 class + 属性一起看：地址栏的 .nav-btn 也带 data-act，
                但它不是 .tb-btn，所以不会被 _bindControls 选中。
                详见 shell.js 里 Toolbar 的注释。）
        -->
        ${WM.Toolbar.build({
          left: [
            WM.Toolbar.btn('new-folder', 'folderAdd', '新建文件夹'),
            WM.Toolbar.btn('upload', 'upload', '上传'),
            WM.Toolbar.sep(),
            WM.Toolbar.btn('rename', 'rename', '', '', '重命名'),
            WM.Toolbar.btn('download', 'download', '', '', '下载'),
            WM.Toolbar.btn('delete', 'trash', '', '', '删除'),
          ],
          right: [
            `<div class="searchbox">${Icons.ui('search')}`
              + `<input type="text" placeholder="搜索当前目录…" data-role="filter"></div>`,
            WM.Toolbar.sep(),
            WM.Toolbar.btn('view-grid', 'grid', '', 'viewbtn', '图标视图'),
            WM.Toolbar.btn('view-list', 'list', '', 'viewbtn', '列表视图'),
            WM.Toolbar.sep(),
            WM.Toolbar.btn('sort', 'sort', '', '', '排序方式'),
            WM.Toolbar.btn('info', 'info', '', '', '详细信息'),
          ],
        })}

        <div class="addrbar">
          <button class="nav-btn" data-act="back" title="后退">${Icons.ui('back')}</button>
          <button class="nav-btn" data-act="forward" title="前进">${Icons.ui('forward')}</button>
          <button class="nav-btn" data-act="up" title="上一级">${Icons.ui('up')}</button>
          <button class="nav-btn" data-act="refresh" title="刷新">${Icons.ui('refresh')}</button>
          <div class="crumbs" data-role="crumbs"></div>
        </div>

        <div class="files-wrap" data-role="files"></div>

        <div class="statusbar">
          <span data-role="st-count">就绪</span>
          <span data-role="st-sel"></span>
          <span class="sb-right">
            <span data-role="st-oo"></span>
            <span data-role="st-view"></span>
          </span>
        </div>
      </div>
      <aside class="info-panel" data-role="info"></aside>
    `;

    bindShell(body, S);
    bindDropUpload(body, S);
    bindDragMove(body, S);

    // 视图状态（侧栏已移除，不再有 renderSidebar）
    applyViewMode(body, S);
    // ★ 工具栏按钮的可用态要**首屏就正确** ★
    //   按钮现在由 WM.Toolbar.build 生成，模板里不再写死 disabled，
    //   所以必须在渲染完立刻算一遍，否则「重命名/下载/删除」会短暂显示为可用。
    updateToolbar(body, S);
  }


  /* ------------------------------------------------------------------
     拖拽上传

     需求：「文件夹窗口可以支持拖拽上传文件」。
     实现要点：
       1. dragover 时必须 preventDefault，否则浏览器不认这是「可放置区」，
          drop 事件根本不会触发（这是最容易踩的坑）。
       2. 只在真的拖了**文件**时才高亮 —— 拖选中的文本也会触发 dragenter，
          用 dataTransfer.types 里有没有 'Files' 来区分。
       3. dragenter/dragleave 在子元素间移动时会成对冒泡，用一个计数变量
          depth 抵消，否则鼠标划过图标就会闪一下高亮。
       4. 落点判定走窗口自己的 .content，因此多开时各自独立，不会串目录。
       5. 上传复用 uploadFiles()，与「上传」按钮走同一条管线（进度/取消/回读）。
     ------------------------------------------------------------------ */
  function bindDropUpload(body, S) {
    const zone = body.querySelector('.content');
    if (!zone) return;

    // 高亮遮罩：盖在文件区上，明确告诉用户「松手即上传到当前目录」
    const mask = document.createElement('div');
    mask.className = 'drop-mask';
    mask.innerHTML = `<div class="dm-inner">
      ${Icons.ui('upload', 34)}
      <div class="dm-title">释放以上传到「${esc(S.path === '/' ? S.mount : S.path)}」</div>
      <div class="dm-sub">支持多文件同时上传</div>
    </div>`;
    zone.appendChild(mask);

    let depth = 0;
    const hasFiles = (e) =>
      !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');

    const show = () => { depth++; mask.classList.add('show'); };
    const hide = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) mask.classList.remove('show');
    };

    zone.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      show();
    });
    zone.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      // ★ 不 preventDefault 就不会有 drop ★
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!mask.classList.contains('show')) show();
    });
    zone.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      hide();
    });
    zone.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();     // 别让 app.js 的全局兜底再处理一遍（会传两次）
      // 打标记：兜底处理器据此跳过，双保险（stopPropagation 已足够，
      // 但拖动来源/浏览器差异偶有例外，标记更稳）
      e.__nebulaHandled = true;
      depth = 0;
      mask.classList.remove('show');
      const files = [...(e.dataTransfer.files || [])];
      if (files.length) uploadFiles(body, S, files);
    });
  }


  /* ------------------------------------------------------------------
     ★ 内部拖拽移动 ★

     需求（原文）：「文件夹窗口中，鼠标左键点住文件或文件夹图标，可以进行
     拖动，拖到指定文件夹中进行移动。」

     为什么用 HTML5 DnD 而不是 pointer 手动拖：
       同一份代码还要兼容「拖到文件夹 tile 上」「拖到窗口空白处」两类目标，
       HTML5 DnD 的 dragover/drop 天然给出"当前悬停在哪个元素"，
       不用自己算命中；而且它与已有的**上传**拖放共用同一套事件，
       浏览器行为一致。

     ★ 与「拖文件进来上传」严格区分 ★
       上传用的是 dataTransfer 里的 'Files'（操作系统给的），
       内部拖动用的是自定义 MIME 'application/x-nebula-names'。
       二者互不干扰：bindDropUpload 只处理 hasFiles()，本函数只处理
       自定义类型，因此不会出现"内部拖动被当成上传"的串扰。

     ★ 三类放置目标 ★
       ① 文件夹条目（.tile / tr[data-name] 且 entry.isDir）
          → 移动进该文件夹
       ② 资源管理器工具栏左侧的"上级"按钮 / 面包屑：不支持（语义混乱，不做）
       ③ 文件区空白（.grid-view / .list-view 本体）
          → 移动到"当前目录"（等于原地不动）。这种情况**只有跨窗口**才有意义：
             把 A 窗口的条目拖到 B 窗口的空白 → 移进 B 的当前目录。
             单窗口内拖到空白则忽略（避免无意义的"移到自己所在目录"）。

     ★ 安全约束（每条都对应一类真实误操作）★
       · 不能把文件夹拖进它自己 / 它的子孙目录（会造成目录环）—— 用路径前缀判断。
       · 不能移动到**它当前所在的同一个目录**（同名冲突、且毫无意义）—— 跳过。
       · 只读挂载不做任何移动，也不显示任何放置提示。
       · 多选时作为一个整体移动；若其中某项非法，只跳过该项并在最后汇总提示。
     ------------------------------------------------------------------ */
  const DND_MIME = 'application/x-nebula-names';

  /** 记录当前正在拖的条目（跨窗口共享：拖动源窗口写入，目标窗口读取） */
  let dragPayload = null;

  /** 判断 candidatePath 是否是 basePath 本身或其后代（用于阻止"拖进自己"） */
  function isSelfOrDescendant(candidatePath, basePath) {
    const a = normPath(candidatePath), b = normPath(basePath);
    if (a === b) return true;
    // 注意 a 必须以 b + '/' 开头才算后代；否则 "/ab" 会被误判为 "/a" 的后代
    return a.startsWith(b === '/' ? '/' : b + '/');
  }

  function bindDragMove(body, S) {
    const filesEl = body.querySelector('[data-role="files"]');
    if (!filesEl) return;

    const clearMarks = () => {
      filesEl.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
      filesEl.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
      filesEl.classList.remove('drop-target-cwd');
    };

    // ---- 拖动源：由 bindTiles 在每个条目上绑 dragstart，这里只做全局收尾 ----
    filesEl.addEventListener('dragend', () => {
      clearMarks();
      dragPayload = null;
    });

    // ---- 判定一次 dragover/drop 应该把东西放到哪里 ----
    //
    //   返回 { kind:'item', entry } | { kind:'cwd' } | null
    const targetOf = (e) => {
      const node = e.target.closest && e.target.closest('[data-name]');
      if (node) {
        const nm = node.dataset.name;
        const entry = (S.entries || []).find((x) => x.name === nm);
        if (entry && entry.isDir) return { kind: 'item', entry };
        return null;                      // 落到文件上：不接受（Windows 也不接受）
      }
      // 空白 → 当前目录（仅跨窗口有意义，见下方判定）
      if (e.target === filesEl
          || (e.target.classList
              && (e.target.classList.contains('grid-view')
                  || e.target.classList.contains('list-view')))) {
        return { kind: 'cwd' };
      }
      return null;
    };

    /** 从 event 里解出拖动载荷；同窗口用内存变量，跨窗口用 dataTransfer */
    const payloadOf = (e) => {
      let raw = '';
      try { raw = e.dataTransfer.getData(DND_MIME) || ''; } catch (_) { raw = ''; }
      if (!raw) return dragPayload;       // 多数浏览器只在 drop 阶段允许读 dataTransfer
      try { return JSON.parse(raw); } catch (_) { return dragPayload; }
    };

    const markTarget = (t) => {
      clearMarks();
      if (!t) return;
      if (t.kind === 'item') {
        const sel = '.tile[data-name="' + cssEsc(t.entry.name) + '"], '
                  + 'tr[data-name="' + cssEsc(t.entry.name) + '"]';
        // 拖到自己头上不给提示（拖到自身无意义）
        if (dragPayload && dragPayload.mount === S.mount
            && dragPayload.dir === S.path
            && dragPayload.names.indexOf(t.entry.name) >= 0) return;
        const n = filesEl.querySelector(sel);
        if (n) n.classList.add('drop-target');
      } else {
        filesEl.classList.add('drop-target-cwd');
      }
    };

    filesEl.addEventListener('dragover', (e) => {
      if (!dragPayload) return;           // 不是内部拖动（可能是上传/外部拖动）
      const t = targetOf(e);
      if (!t) return;
      // ★ 必须 preventDefault，否则 drop 不会触发 ★
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      markTarget(t);
    });

    filesEl.addEventListener('dragleave', (e) => {
      if (!dragPayload) return;
      // 离开到文件区之外才清；区域内部移动交给下一次 dragover 重画
      if (!filesEl.contains(e.relatedTarget)) clearMarks();
    });

    filesEl.addEventListener('drop', (e) => {
      const pl = payloadOf(e);
      if (!pl) return;                    // 非内部拖动 → 交给上传逻辑
      const t = targetOf(e);
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      e.__nebulaHandled = true;           // 别让 app.js 的全局兜底再当成上传
      clearMarks();

      doMove(body, S, pl, t);
    });
  }

  /** 转义成 CSS 选择器里可用的字符串（引号/反斜杠是唯一危险字符） */
  function cssEsc(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /** 真正执行移动：按 target 计算目标目录，逐项调用 API.move */
  async function doMove(body, S, pl, target) {
    const destDir = target.kind === 'item'
      ? joinPath(S.path, target.entry.name)
      : S.path;

    // 只读挂载：直接拒绝
    if (S.mountReadonly) {
      Toast.error('该位置为只读', '不能移动其中的项目');
      return;
    }

    // 目标就是来源目录 → 什么都不做（Windows 同样不响应）
    if (pl.mount === S.mount && normPath(destDir) === normPath(pl.dir)) return;

    const skipped = [];
    const todo = [];
    pl.names.forEach((name) => {
      const srcPath = joinPath(pl.dir, name);
      // ① 不能把文件夹拖进它自己或它的子孙目录
      if (target.kind === 'item' && isSelfOrDescendant(destDir, srcPath)) {
        skipped.push(`${name}（不能移动到自身内部）`);
        return;
      }
      // ② 源与目标同名也会失败，提前跳过给准确提示
      if (normPath(srcPath) === normPath(joinPath(destDir, name))) {
        skipped.push(`${name}（已在该位置）`);
        return;
      }
      todo.push(name);
    });

    if (!todo.length) {
      if (skipped.length) Toast.error('无法移动', skipped[0]);
      return;
    }

    let okCount = 0, failed = [];
    for (const n of todo) {
      try {
        await API.move(pl.mount, joinPath(pl.dir, n), destDir, true);
        okCount++;
      } catch (e) { failed.push(`${n}: ${e.message}`); }
    }

    // ★ 两个窗口都要刷新 ★
    //   拖动源窗口（pl 所在）与当前目标窗口都变了内容；如果它们是同一个
    //   窗口（同目录内拖进子文件夹），只刷一次即可。
    try {
      await load(body, S);
      const srcWin = WM.get(pl.winId);
      if (srcWin && srcWin.id !== S.winId && srcWin.opts && srcWin.opts.onReload) {
        srcWin.opts.onReload();
      }
    } catch (_) { /* 刷新失败不影响移动结果，下面仍给出正确提示 */ }

    if (failed.length) Toast.error(`${failed.length} 项移动失败`, failed[0]);
    else if (skipped.length) Toast.info(`已移动 ${okCount} 项`,
      `跳过：${skipped[0]}${skipped.length > 1 ? ` 等 ${skipped.length} 项` : ''}`);
    else Toast.ok('已移动', `${okCount} 个项目 → ${destDir === '/' ? S.mount : destDir}`);
  }


  function bindShell(body, S) {
    const q = (sel) => body.querySelector(sel);

    // ★ 只认业务按钮（[data-a]），窗口三键不在这里处理 ★
    //   三键是 `.tb-btn[data-act]`，由 shell.js 的 _bindControls 挂监听并
    //   在按钮上 stopPropagation()，事件根本冒泡不到这里 ——
    //   所以重构前那段 `act === 'min'|'max'|'close'` 的分支是**死代码**，
    //   已删除（留着只会让人以为这里有两条处理路径）。
    q('.toolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-a]');
      if (!btn || btn.disabled) return;
      const act = btn.dataset.a;
      if (act === 'new-folder') actNewFolder(body, S);
      else if (act === 'upload') actUpload(body, S);
      else if (act === 'rename') actRename(body, S);
      else if (act === 'download') actDownload(body, S);
      else if (act === 'delete') actDelete(body, S);
      else if (act === 'view-grid') setView(body, S, 'grid');
      else if (act === 'view-list') setView(body, S, 'list');
      else if (act === 'sort') openSortMenu(body, S, btn);
      else if (act === 'info') toggleInfo(body, S);
    });

    q('.addrbar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) {
        const act = btn.dataset.act;
        if (act === 'back') historyGo(body, S, -1);
        else if (act === 'forward') historyGo(body, S, +1);
        else if (act === 'up') navigate(body, S, parentPath(S.path), { push: true });
        else if (act === 'refresh') load(body, S);
        return;
      }
      const crumb = e.target.closest('.crumb');
      if (crumb) navigate(body, S, crumb.dataset.path, { push: true });
    });

    const filterInput = q('[data-role="filter"]');
    filterInput.addEventListener('input', debounce(() => {
      S.filter = filterInput.value.trim().toLowerCase();
      renderFiles(body, S);
    }, 140));

    // 空白区右键 / 点击取消选中
    const files = q('[data-role="files"]');
    files.addEventListener('mousedown', (e) => {
      if (e.target === files || e.target.classList.contains('grid-view')
          || e.target.classList.contains('list-view')) {
        S.selected.clear();
        renderFiles(body, S);
      }
    });
    files.addEventListener('contextmenu', (e) => {
      // 空白区菜单（元素上的菜单在 tile 上单独绑定并阻止冒泡）
      const onItem = e.target.closest('[data-name]');
      if (!onItem) {
        e.preventDefault();
        blankContextMenu(body, S, e.clientX, e.clientY);
      }
    });

    bindKeys(body, S);
  }


  /* ------------------------------------------------------------------
     键盘快捷键

     需求（原文）：「键盘上的 delete 可以删除文件。」

     ★ 为什么挂在 document 而不是 body 上 ★
       窗口失焦后 body 收不到 keydown。挂 document 才能保证「点过这个
       窗口之后再按 Del」有效。代价是必须自己判断「这个窗口是不是当前的」
       —— 否则多开两个窗口时按一次 Del 会把每个窗口的选中项都删掉。

     ★ 判断依据：WM 的 focused 类 ★
       WM.focus() 会给激活窗口加 .focused、给其他窗口移除。所以只要
       当前窗口的根元素带 .focused，这个窗口才有资格响应按键。

     ★ 输入框里不劫持 ★
       在搜索框里按 Del 应该删字符，不是删文件。用 typing 判断跳过。
       （改名用 Dialog.prompt，那是独立的模态输入框，不受影响。）

     ★ 为什么不用 key === 'Backspace' 也删 ★
       Backspace 在浏览器里是「后退」，劫持它容易误删，只认 Delete。
     ------------------------------------------------------------------ */
  function bindKeys(body, S) {
    const onKey = (e) => {
      // 输入框 / 可编辑区域里让原生行为优先
      if (e.target.matches('input, textarea, [contenteditable]')) return;

      const winId = winIdOf(S);
      const st = WM.get(winId);
      if (!st) { document.removeEventListener('keydown', onKey); return; }
      if (!st.el.classList.contains('focused')) return;

      if (e.key === 'Delete') {
        if (!S.selected.size) return;
        e.preventDefault();
        actDelete(body, S);
      } else if (e.key === 'F2') {
        if (S.selected.size !== 1) return;
        e.preventDefault();
        actRename(body, S);
      } else if (e.key === 'F5') {
        e.preventDefault();
        load(body, S);
      } else if (e.key === 'Escape') {
        if (!S.selected.size) return;
        S.selected.clear();
        renderFiles(body, S);
      }
    };
    document.addEventListener('keydown', onKey);

    // 窗口关闭时摘掉监听，否则会随开关窗口不断堆积（内存泄漏 + 重复触发）
    const st = WM.get(winIdOf(S));
    if (st && st.opts) {
      const prev = st.opts.onClose;
      st.opts.onClose = (w) => {
        document.removeEventListener('keydown', onKey);
        return prev ? prev(w) : undefined;
      };
    }
  }




  /* ======================================================================
     导航与加载
     ====================================================================== */
  function navigate(body, S, path, o = {}) {
    path = normPath(path);

    if (!o.replace) {
      if (o.push) {
        S.history = S.history.slice(0, S.hIndex + 1);
        S.history.push({ mount: S.mount, path });
        S.hIndex = S.history.length - 1;
      }
    } else {
      S.history = [{ mount: S.mount, path }];
      S.hIndex = 0;
    }

    S.path = path;
    S.selected.clear();
    // 新建窗口时 body 可能还没绑定，需要重新定位元素
    const host = WM.get(winIdOf(S)) ? WM.get(winIdOf(S)).bodyEl : body;
    load(host, S);
  }

  // ★ 必须返回 S.winId，不能拼 `explorer:${S.mount}` ★
  //   双击文件夹另开的窗口 id 是 `explorer:<mount>:<path>`，
  //   如果这里仍然按 mount 拼，WM.get() 会返回 undefined ——
  //   后果是：标题不再随目录更新、键盘快捷键整套失效（bindKeys 里
  //   `if (!st) return`）、navigate 拿不到 bodyEl 而渲染到旧节点上。
  //   S.winId 在 open() 里就已写好，这里直接透传即可。
  function winIdOf(S) { return S.winId; }

  function historyGo(body, S, delta) {
    const i = S.hIndex + delta;
    if (i < 0 || i >= S.history.length) return;
    S.hIndex = i;
    S.path = S.history[i].path;
    S.selected.clear();
    load(body, S);
  }

  async function load(body, S) {
    if (S.loading) return;
    S.loading = true;
    renderLoading(body, S);

    try {
      const data = await API.list(S.mount, S.path);
      S.path = data.path || S.path;
      S.entries = data.entries || [];
      S.mountReadonly = !!(data.mount && data.mount.readonly);

      // ★ 目录内容变了 → 通知预览窗口刷新「上一个/下一个」的兄弟列表 ★
      //   场景：预览 a.png 的同时把 b.png 删了 / 重命名了 / 上传了新文件，
      //   预览窗口记的还是旧数组 → 「下一个」会指向已不存在的文件，
      //   或者漏掉刚上传进来的文件。
      //   这里把最新列表交回 viewer，它会按 mount+dir 匹配到对应的
      //   预览窗口，并把 index 重新对齐到「用户当前正在看的那个文件」。
      //   ★ 同样必须传 visibleEntries(S) ★
      //     否则会把「用户看到的排序」又换回接口原始顺序，
      //     位置计数与「下一个」的目标文件再次错位。
      //   （refreshContext 会跳过 mount/dir 不匹配的窗口，代价可忽略。）
      try {
        Viewer.refreshContext &&
          Viewer.refreshContext(S.mount, S.path, visibleEntries(S));
      } catch (e) {
        // 刷新翻页上下文失败不该影响目录本身渲染
        console.warn('[nebula] 刷新预览翻页上下文失败:', e);
      }

      // ★ 渲染也必须包在 try 里 ★
      //   原来只有 API 调用被 try 覆盖，渲染阶段一旦抛异常（例如缩略图取
      //   上下文失败），就直接穿出 load()，而 S.loading 已经在上面被置 true，
      //   于是这个目录永久停在「正在加载…」，连重试按钮都出不来。
      renderCrumbs(body, S);
      renderFiles(body, S);
      updateNavButtons(body, S);
      updateToolbar(body, S);
      updateStatus(body, S);
      // ★ 换目录后「详细信息」面板必须复位 ★
      //   否则面板会一直挂着上一个目录里某个文件的详情（名称/大小/位置
      //   全对不上当前目录），是最容易让人以为「点错了」的观感 bug。
      //   注意：navigate()/historyGo() 都会清空 S.selected 后再 load，
      //   所以这里传 null 稳定渲染成「选中一个项目以查看详细信息」。
      if (S.infoOpen) {
        const ip = body.querySelector('[data-role="info"]');
        if (ip) {
          const one = S.selected.size === 1 ? [...S.selected][0] : null;
          openInfo(body, S, one);
        }
      }

      const win = WM.get(winIdOf(S));
      if (win) {
        // ★ 标题 ★
        //   根目录 → 「映射名」
        //   深层目录 → 「文件夹名 — 映射名」（父目录可辨识）
        //   双击另开的窗口标题也保持一致 —— 用户在上面一栏切目录时
        //   标题必须跟着变，否则「文件夹窗口」的标题会和内容对不上。
        const title = S.path === '/'
          ? S.mount
          : `${baseName(S.path)} — ${S.mount}`;
        WM.setTitle(winIdOf(S), title);
      }
    } catch (e) {
      console.error('[nebula] 目录加载/渲染失败:', e);
      renderError(body, S, e);
    } finally {
      // 无论成功失败都必须复位，否则后续刷新会被开头的 `if (S.loading) return` 静默吞掉
      S.loading = false;
    }
  }


  /* ======================================================================
     地址栏面包屑
     ====================================================================== */
  function normPath(p) {
    if (!p) return '/';
    p = String(p).replace(/\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    p = p.replace(/\/+/g, '/');
    if (p.length > 1) p = p.replace(/\/$/, '');
    return p || '/';
  }

  function parentPath(p) {
    p = normPath(p);
    if (p === '/') return '/';
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }

  /** 取路径最后一段（文件夹名）。根目录返回空串。 */
  function baseName(p) {
    p = normPath(p);
    if (p === '/') return '';
    const i = p.lastIndexOf('/');
    return i < 0 ? p : p.slice(i + 1);
  }

  function renderCrumbs(body, S) {
    const el = body.querySelector('[data-role="crumbs"]');
    const parts = S.path.split('/').filter(Boolean);

    let html = `<span class="crumb ${parts.length === 0 ? 'current' : ''}"
                      data-path="/">${Icons.ui('hdd', 13)}&nbsp;${esc(S.mount)}</span>`;
    let acc = '';
    parts.forEach((seg, i) => {
      acc += '/' + seg;
      html += `<span class="crumb-sep">${Icons.ui('chevron', 11)}</span>`;
      html += `<span class="crumb ${i === parts.length - 1 ? 'current' : ''}"
                     data-path="${esc(acc)}" title="${esc(seg)}">${esc(seg)}</span>`;
    });
    el.innerHTML = html;

    // 滚动到最右，长路径时能看到当前目录
    requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth; });
  }

  function updateNavButtons(body, S) {
    body.querySelector('[data-act="back"]').disabled = S.hIndex <= 0;
    body.querySelector('[data-act="forward"]').disabled = S.hIndex >= S.history.length - 1;
    body.querySelector('[data-act="up"]').disabled = S.path === '/';
  }


  /* ======================================================================
     文件列表渲染
     ====================================================================== */
  function visibleEntries(S) {
    let list = S.entries;
    if (S.filter) {
      list = list.filter((e) => e.name.toLowerCase().includes(S.filter));
    }
    const dir = S.sortAsc ? 1 : -1;
    const k = S.sortKey;
    list = [...list].sort((a, b) => {
      // 文件夹永远排前面（Windows 行为）
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let r = 0;
      if (k === 'size') r = (a.size || 0) - (b.size || 0);
      else if (k === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
      else if (k === 'type') r = (a.ext || '').localeCompare(b.ext || '');
      else r = a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      return r * dir;
    });
    return list;
  }

  function renderFiles(body, S) {
    const wrap = body.querySelector('[data-role="files"]');
    const list = visibleEntries(S);

    if (!list.length) {
      wrap.innerHTML = emptyState(S);
      return;
    }

    if (S.view === 'list') renderList(wrap, body, S, list);
    else renderGrid(wrap, body, S, list);

    updateStatus(body, S);
    updateToolbar(body, S);
  }

  function emptyState(S) {
    if (S.filter) {
      return `<div class="state-box">
        ${Icons.ui('search', 56)}
        <div class="sb-title">未找到匹配项</div>
        <div class="sb-hint">没有名称包含「${esc(S.filter)}」的文件或文件夹</div>
      </div>`;
    }
    return `<div class="state-box">
      ${Icons.ui('folder', 56)}
      <div class="sb-title">此文件夹为空</div>
      <div class="sb-hint">把文件拖到这里上传，或点击工具栏的「上传」按钮</div>
    </div>`;
  }

  function renderLoading(body, S) {
    const wrap = body.querySelector('[data-role="files"]');
    if (!wrap) return;
    wrap.innerHTML = `<div class="state-box"><div class="spinner"></div>
      <div class="sb-title">正在加载…</div></div>`;
  }

  function renderError(body, S, err) {
    const wrap = body.querySelector('[data-role="files"]');
    if (!wrap) return;
    wrap.innerHTML = `<div class="state-box">
      ${Icons.ui('warn', 56)}
      <div class="sb-title">无法打开此位置</div>
      <div class="sb-hint">${esc(err.message || String(err))}</div>
      <button class="btn" data-role="retry" style="margin-top:8px">重试</button>
    </div>`;
    const r = wrap.querySelector('[data-role="retry"]');
    if (r) r.addEventListener('click', () => load(body, S));
  }

  /* ---------------- 网格视图 ---------------- */
  function renderGrid(wrap, body, S, list) {
    wrap.innerHTML = `<div class="grid-view">${list.map((e, i) => `
      <div class="tile ${S.selected.has(e.name) ? 'selected' : ''}"
           data-name="${esc(e.name)}" data-i="${i}" title="${esc(e.name)}"
           draggable="true">
        <span class="tile-img">${tileImg(e, S)}</span>
        <span class="tile-name">${esc(e.name)}</span>
      </div>`).join('')}</div>`;
    bindTiles(wrap, body, S, list);
  }

  /** 图片类型用缩略图（走 /api/download?inline 同源直出，省一次请求）
   *  ★ S 必须由调用方透传，不能用 state.cur ★
   *   grid/list 模板是先拼 innerHTML、拼完才调 bindTiles()，而 state.cur
   *   恰恰是在 bindTiles() 里才赋值的（见下方）。所以「首次渲染」时
   *   state.cur 还是 undefined，取 S.mount 直接抛 TypeError，
   *   且异常发生在 load() 的 try 之外 → S.loading 永远卡在 true →
   *   目录列表永久停在「正在加载…」，刷新也没用。
   */
  function tileImg(e, S) {
    if (e.isDir) return Icons.file(null, true);
    const kind = EXT_KIND[(e.ext || '').toLowerCase()];
    if (kind === 'image' && e.size < 12 * 1024 * 1024) {
      // 图片用真实缩略图；解码失败时回退成图标（如损坏文件 / 非真图片）
      return `<img class="tile-thumb" loading="lazy" src="${esc(imgUrl(e, S))}" alt=""
                   onerror="this.replaceWith(Object.assign(document.createElement('span'),
                     {innerHTML: Icons.file('${esc(e.name).replace(/'/g, "\\'")}')}))">`;
    }
    return Icons.file(e.name);
  }

  function imgUrl(e, S) {
    S = S || state.cur;        // 兜底：理论上传参一定给，这里只是防御
    if (!S) return '';         // 再兜一层，绝不因缩略图把整个列表搞崩
    const q = new URLSearchParams({
      mount: S.mount, path: joinPath(S.path, e.name), inline: 'true',
    });
    return '/api/download?' + q.toString();
  }

  /* ---------------- 列表视图 ---------------- */
  function renderList(wrap, body, S, list) {
    const arrow = (k) => {
      if (S.sortKey !== k) return '';
      return S.sortAsc ? ' ▲' : ' ▼';
    };
    wrap.innerHTML = `
      <table class="list-view">
        <thead><tr>
          <th data-sort="name" style="width:auto">名称${arrow('name')}</th>
          <th data-sort="mtime" style="width:150px">修改日期${arrow('mtime')}</th>
          <th data-sort="type" style="width:120px">类型${arrow('type')}</th>
          <th data-sort="size" class="num" style="width:100px">大小${arrow('size')}</th>
        </tr></thead>
        <tbody>
          ${list.map((e, i) => `
            <tr class="${S.selected.has(e.name) ? 'selected' : ''}"
                data-name="${esc(e.name)}" data-i="${i}" draggable="true">
              <td class="cell-name">
                ${listThumb(e, S)}
                <span title="${esc(e.name)}">${esc(e.name)}</span>
              </td>
              <td>${esc(fmtTime(e.mtime))}</td>
              <td>${esc(typeName(e))}</td>
              <td class="num">${e.isDir ? '' : esc(fmtSize(e.size))}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    wrap.querySelectorAll('thead th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (S.sortKey === k) S.sortAsc = !S.sortAsc;
        else { S.sortKey = k; S.sortAsc = true; }
        localStorage.setItem('nebula.sortKey', S.sortKey);
        localStorage.setItem('nebula.sortAsc', String(S.sortAsc));
        renderFiles(body, S);
      });
    });
    bindTiles(wrap, body, S, list);
  }

  function listThumb(e, S) {
    if (e.isDir) return Icons.file(null, true);
    const kind = EXT_KIND[(e.ext || '').toLowerCase()];
    if (kind === 'image' && e.size < 12 * 1024 * 1024) {
      return `<img class="row-thumb" loading="lazy" src="${esc(imgUrl(e, S))}" alt="">`;
    }
    // 列表里图标尺寸小，复用同一套彩色图标即可
    return `<span style="display:grid;place-items:center;width:16px;height:16px"
                  >${Icons.file(e.name)}</span>`;
  }


  /* ======================================================================
     条目交互（选中 / 双击 / 右键）
     ====================================================================== */
  function bindTiles(wrap, body, S, list) {
    state.cur = S;   // 供 imgUrl 读取当前上下文（同一时刻只有一个窗口在渲染）

    wrap.querySelectorAll('[data-name]').forEach((node) => {
      const idx = +node.dataset.i;
      const e = list[idx];

      node.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return;
        if (ev.ctrlKey || ev.metaKey) {
          S.selected.has(e.name) ? S.selected.delete(e.name) : S.selected.add(e.name);
        } else if (ev.shiftKey && S.lastClickIdx >= 0) {
          const a = Math.min(S.lastClickIdx, idx), b = Math.max(S.lastClickIdx, idx);
          for (let i = a; i <= b; i++) S.selected.add(list[i].name);
        } else {
          S.selected.clear();
          S.selected.add(e.name);
        }
        S.lastClickIdx = idx;
        syncSelection(wrap, S);
        updateToolbar(body, S);
        updateStatus(body, S);
        // ★ 单击选中后必须刷新「详细信息」面板 ★
        //   原实现只在右键菜单里调 openInfo，单击只更新高亮，
        //   于是详情面板一直停在上一次查看的那个文件上 ——
        //   看起来像「点了没反应 / 面板不更新」。
        //   多选时 openInfo 会拿到 null 条目 → 面板显示「未选中」提示，
        //   这正是资源管理器的行为（多选不展示单个文件详情）。
        if (S.infoOpen) {
          openInfo(body, S, S.selected.size === 1 ? [...S.selected][0] : null);
        }
      });

      node.addEventListener('dblclick', (ev) => {
        ev.preventDefault();
        activate(body, S, e);
      });

      // ★ 拖动移动：把这个条目（连同已选中的其它条目）拖到文件夹上 ★
      //
      //   拖谁：如果按下的这一项**在已选集合里**，就拖整个选中的一批
      //         （Windows 行为：拖动多选中的任一项 = 拖全部）；
      //         否则只拖这一项（此时上面的 mousedown 已把选中集重置为它）。
      node.addEventListener('dragstart', (ev) => {
        if (S.mountReadonly) { ev.preventDefault(); return; }
        const names = S.selected.has(e.name) && S.selected.size
          ? [...S.selected]
          : [e.name];

        dragPayload = {
          mount: S.mount,        // 来源挂载
          dir: S.path,           // 来源目录（相对路径）
          names,                 // 被拖的条目名（相对 dir）
          winId: S.winId,        // 来源窗口，移动完要刷新它
        };

        try {
          ev.dataTransfer.effectAllowed = 'move';
          // 自定义 MIME：与「拖文件进来上传」的 'Files' 严格区分
          ev.dataTransfer.setData(DND_MIME, JSON.stringify(dragPayload));
        } catch (_) { /* 个别环境不允许写自定义类型，内存变量兜底 */ }

        // 拖动期间给选中的条目加淡出视觉
        wrap.querySelectorAll('[data-name]').forEach((n) => {
          if (names.indexOf(n.dataset.name) >= 0) n.classList.add('dragging');
        });
      });

      node.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!S.selected.has(e.name)) {
          S.selected.clear();
          S.selected.add(e.name);
          syncSelection(wrap, S);
          updateToolbar(body, S);
          updateStatus(body, S);
        }
        itemContextMenu(body, S, ev.clientX, ev.clientY);
      });
    });
  }

  function syncSelection(wrap, S) {
    wrap.querySelectorAll('[data-name]').forEach((n) => {
      n.classList.toggle('selected', S.selected.has(n.dataset.name));
    });
  }

  /** 双击行为：文件夹 → 新开一个文件夹窗口；文件 → 按路由打开预览器 */
  function activate(body, S, e) {
    if (e.isDir) {
      openChild(body, S, e.name);
      return;
    }
    // ★ 把「当前目录 + 同级可预览文件列表 + 目录路径」一并交给预览窗口 ★
    //   只有这样预览窗口才能实现「上一个 / 下一个文件」（与表格里的顺序一致），
    //   并在翻页时**原地换内容**而不是新开窗口。
    //
    //   ★★ 必须传 visibleEntries(S) 而不是 S.entries ★★
    //   用户看到的顺序 = visibleEntries（文件夹优先 + 当前排序键 + 过滤），
    //   而 S.entries 是接口返回的**原始**顺序。若传原始数组：
    //     · 位置计数会显示一个跟界面完全对不上的「第 n / 共 m」（比如
    //       界面上第 10 个文件却写着 20 / 25），
    //     · 「下一个」会跳到一个用户根本预料不到的文件。
    //   「类似看图片上一张，下一张」的前提，就是顺序与列表所见一致。
    Viewer.open(S.mount, joinPath(S.path, e.name), e, visibleEntries(S), S.path);
  }


  /* ======================================================================
     右键菜单
     ====================================================================== */
  function ctxBase() {
    return [
      { label: '打开', icon: 'eye', onClick: null },
      { sep: true },
    ];
  }

  function itemContextMenu(body, S, x, y) {
    const names = [...S.selected];
    if (!names.length) return;
    const single = names.length === 1 ? S.entries.find((e) => e.name === names[0]) : null;

    const items = [
      {
        label: single && single.isDir ? '打开' : '打开（预览）',
        icon: single && single.isDir ? 'folder' : 'eye',
        onClick: () => {
          if (single) activate(body, S, single);
          else names.forEach((n) => {
            const e = S.entries.find((z) => z.name === n);
            if (e) activate(body, S, e);
          });
        },
      },
    ];

    // 单个 Office/PDF 文件 → 用 OnlyOffice 打开
    if (names.length === 1 && single && !single.isDir
        && single.route === 'onlyoffice') {
      items.push({
        label: '使用 OnlyOffice 编辑',
        icon: 'edit',
        onClick: () => Viewer.openOnlyOffice(
          S.mount, joinPath(S.path, single.name), single, visibleEntries(S), S.path),
      });
    }

    // ★ 压缩包 → 解压 ★
    //   需求（原文）：「集成右键对压缩文件解压功能。」
    //   只在选中的是**单个压缩包**时出现 —— 批量解压容易在 NAS 上引起
    //   大量磁盘写入，且落点命名会互相冲突，暂时不做。
    if (single && !single.isDir && isArchiveName(single.name)) {
      items.push({ sep: true });
      items.push({
        label: '解压到当前文件夹',
        icon: 'unzip',
        onClick: () => actExtract(body, S, single, false),
      });
      items.push({
        label: '解压到指定文件夹…',
        icon: 'folderAdd',
        onClick: () => actExtract(body, S, single, true),
      });
    }

    items.push({ sep: true });
    items.push({
      label: '下载', icon: 'download',
      onClick: () => downloadSelected(body, S, names),
    });

    // ★ 分享 ★
    //   只在**选中单个条目**时出现：批量分享的语义（一个链接对多个文件？）
    //   会让落地页复杂度暴涨，且 NAS 场景下单条分享已够用。
    if (names.length === 1 && single) {
      items.push({ sep: true });
      items.push({
        label: '分享',
        icon: 'share',
        onClick: () => actShare(body, S, single),
      });
    }

    items.push({ sep: true });
    items.push({
      label: '重命名', icon: 'rename',
      disabled: names.length !== 1,
      accel: 'F2',
      onClick: () => actRename(body, S),
    });
    items.push({
      label: '复制到…', icon: 'copy',
      onClick: () => actCopyMove(body, S, false),
    });
    items.push({
      label: '移动到…', icon: 'move',
      onClick: () => actCopyMove(body, S, true),
    });

    if (names.length === 1) {
      items.push({ sep: true });
      items.push({
        label: '属性', icon: 'info',
        onClick: () => { openInfo(body, S, names[0]); },
      });
    }

    items.push({ sep: true });
    items.push({
      label: names.length > 1 ? `删除这 ${names.length} 项` : '删除',
      icon: 'trash', danger: true, accel: 'Del',
      onClick: () => actDelete(body, S),
    });

    ContextMenu.show(x, y, items);
  }

  function blankContextMenu(body, S, x, y) {
    ContextMenu.show(x, y, [
      { label: '刷新', icon: 'refresh', accel: 'F5', onClick: () => load(body, S) },
      { sep: true },
      { label: '新建文件夹', icon: 'folderAdd', onClick: () => actNewFolder(body, S) },
      { label: '上传文件', icon: 'upload', onClick: () => actUpload(body, S) },
      { sep: true },
      // ★ 在空白处右键 → 分享**当前这个文件夹**本身 ★
      //   这是"分享整个目录"最自然的入口：不用先退到上一级再去点文件夹。
      //   根目录（S.path === '/'）也允许分享 —— 那是"分享整个映射"。
      {
        label: S.path === '/' ? `分享整个「${S.mount}」` : '分享此文件夹',
        icon: 'share',
        onClick: () => actShare(body, S, {
          name: S.path === '/' ? S.mount : (S.path.split('/').filter(Boolean).pop() || S.mount),
          isDir: true,
          // ★ path 要用「这个目录自身的相对路径」，不是它的父路径 ★
          //   所以这里显式告诉 actShare 走目录本身：
          _selfPath: S.path,
        }),
      },
      { label: '管理我的分享…', icon: 'share', onClick: () => openShareManager() },
      { sep: true },
      { label: S.view === 'grid' ? '切换为列表视图' : '切换为图标视图',
        icon: 'list', onClick: () => toggleView(body, S) },
      {
        label: S.infoOpen ? '隐藏详细信息' : '显示详细信息',
        icon: 'info', onClick: () => toggleInfo(body, S),
      },
      { sep: true },
      { label: '在浏览器中打开原链接', icon: 'external', disabled: true },
      {
        label: '复制当前路径', icon: 'copy',
        onClick: async () => {
          const p = `${S.mount}${S.path === '/' ? '' : S.path}`;
          try {
            await navigator.clipboard.writeText(p);
            Toast.ok('已复制', p);
          } catch { Toast.error('复制失败', '浏览器拒绝了剪贴板访问'); }
        },
      },
    ]);
  }


  /* ======================================================================
     操作实现
     ====================================================================== */
  async function actNewFolder(body, S) {
    const name = await Dialog.prompt({
      title: '新建文件夹',
      value: '新建文件夹',
      selectBase: false,
      placeholder: '文件夹名称',
      hint: '名称不能包含 / \\ : * ? " < > |',
    });
    if (!name) return;
    try {
      await API.mkdir(S.mount, S.path, name);
      Toast.ok('已创建', name);
      await load(body, S);
      S.selected.clear();
      S.selected.add(name);
      renderFiles(body, S);
    } catch (e) { Toast.error('创建失败', e.message); }
  }

  function actUpload(body, S) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => {
      const files = [...input.files];
      if (files.length) uploadFiles(body, S, files);
    });
    input.click();
  }

  /* ======================================================================
     分享
     ======================================================================
     需求（原文）：「增加文件分享的功能。」

     交互设计：
       - 右键单个文件/文件夹 → 「分享」→ 弹出设置对话框（有效期 / 次数 / 提取码）
       - 生成后**立刻把链接放进对话框并自动复制**（分享的最高频动作就是"拿到链接"）
       - 同一个对话框里可以「管理我的分享」——不用再去找别的入口

     ★ 一个易错点 ★
       分享的 path 必须是**相对于映射根**的路径（S.path + name），
       不是相对于当前目录。后端 files.resolve() 也是按映射根解析的。
       joinPath(S.path, name) 就是这个语义。
     ====================================================================== */

  /** 有效期选项（天）。0 = 永久 */
  const SHARE_TTL = [
    { v: 1, t: '1 天' },
    { v: 7, t: '7 天' },
    { v: 30, t: '30 天' },
    { v: 0, t: '永久有效' },
  ];

  async function actShare(body, S, entry) {
    // entry._selfPath 存在 → 分享的是「当前目录自身」（空白处右键进来的）
    //   否则 → 分享选中条目（S.path + name）
    const rel = entry._selfPath !== undefined
      ? entry._selfPath
      : joinPath(S.path, entry.name);
    const dlg = Dialog.custom({ title: '分享', wide: true, maskClose: false });

    dlg.el.innerHTML = `
      <div class="share-dlg">
        <div class="share-target">
          <div class="share-tname">${esc(entry.name)}</div>
          <div class="share-tsub">${entry.isDir ? '文件夹（访客可只读浏览）' : '文件'}</div>
        </div>

        <div class="share-opts">
          <label class="share-opt">
            <span>有效期</span>
            <select data-role="ttl">
              ${SHARE_TTL.map((o, i) =>
                `<option value="${o.v}"${i === 1 ? ' selected' : ''}>${o.t}</option>`).join('')}
            </select>
          </label>

          <label class="share-opt">
            <span>访问次数上限</span>
            <select data-role="visits">
              <option value="0" selected>不限</option>
              <option value="1">仅 1 次</option>
              <option value="5">5 次</option>
              <option value="20">20 次</option>
            </select>
          </label>

          <label class="share-opt">
            <span>提取码（可选）</span>
            <input type="text" data-role="pw" placeholder="留空则无需提取码" maxlength="32">
          </label>

          <label class="share-opt">
            <span>备注（可选）</span>
            <input type="text" data-role="note" placeholder="仅自己可见" maxlength="80">
          </label>
        </div>

        <div class="share-result" data-role="result" hidden>
          <div class="share-label">分享链接</div>
          <div class="share-linkrow">
            <input type="text" data-role="link" readonly>
            <button class="btn" data-role="copy">复制</button>
          </div>
          <div class="share-hint" data-role="hint"></div>
        </div>
      </div>`;

    dlg.foot.innerHTML = `
      <button class="btn" data-role="manage" style="margin-right:auto">管理分享…</button>
      <button class="btn" data-role="close">关闭</button>
      <button class="btn primary" data-role="create">创建链接</button>`;

    const q = (r) => dlg.el.querySelector(`[data-role="${r}"]`);
    const resBox = q('result');

    dlg.foot.querySelector('[data-role="close"]').onclick = () => dlg.close();
    dlg.foot.querySelector('[data-role="manage"]').onclick = () => {
      dlg.close();
      openShareManager();
    };

    q('copy').onclick = async () => {
      const link = q('link');
      try {
        await navigator.clipboard.writeText(link.value);
        Toast.ok('已复制', '链接已复制到剪贴板');
      } catch {
        // 剪贴板被拒（非 HTTPS / 权限）：退回"选中让用户自己复制"
        link.select();
        Toast.info('请手动复制', '浏览器拒绝了剪贴板访问，已为你全选');
      }
    };

    dlg.foot.querySelector('[data-role="create"]').onclick = async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const r = await API.shareCreate(S.mount, rel, {
          ttlDays: Number(q('ttl').value),
          maxVisits: Number(q('visits').value),
          password: q('pw').value.trim(),
          note: q('note').value.trim(),
        });
        const sh = r.share || {};
        resBox.hidden = false;
        q('link').value = sh.url || `${location.origin}/s/${sh.token}`;
        q('hint').textContent = [
          sh.hasPassword ? '需要提取码' : '无需提取码',
          sh.expiresAt ? `有效期至 ${new Date(sh.expiresAt * 1000).toLocaleDateString()}` : '永久有效',
          sh.maxVisits ? `限 ${sh.maxVisits} 次访问` : '不限次数',
        ].join(' · ');
        btn.textContent = '重新创建';
        btn.disabled = false;
        Toast.ok('已创建分享', '链接已生成');
      } catch (e) {
        btn.disabled = false;
        Toast.error('创建分享失败', e.message);
      } finally {
        btn.disabled = false;
      }
    };
  }

  /** 分享管理：列出我的分享，可复制 / 撤销。 */
  async function openShareManager() {
    const dlg = Dialog.custom({ title: '我的分享', wide: true });
    dlg.el.innerHTML = '<div class="share-hint">正在载入…</div>';
    dlg.foot.innerHTML = '<button class="btn" data-role="close">关闭</button>';
    dlg.foot.querySelector('[data-role="close"]').onclick = () => dlg.close();

    const render = async () => {
      let list = [];
      try {
        const r = await API.shares();
        list = r.shares || [];
      } catch (e) {
        dlg.el.innerHTML = `<div class="share-hint" style="color:var(--danger)">载入失败：${esc(e.message)}</div>`;
        return;
      }
      if (!list.length) {
        dlg.el.innerHTML = '<div class="share-hint">还没有分享记录。</div>';
        return;
      }
      dlg.el.innerHTML = `<div class="share-list">${list.map((s, i) => `
        <div class="share-item${s.alive ? '' : ' dead'}" data-i="${i}">
          <div class="share-item-main">
            <div class="share-item-name">${esc(s.name || s.path || '(未命名)')}</div>
            <div class="share-item-sub">
              ${esc(s.mount)}${esc(s.path && s.path !== s.name ? ':' + s.path : '')} ·
              ${s.alive ? '有效' : (s.expired ? '已过期' : '次数用尽')} ·
              ${s.visits} 次访问${s.hasPassword ? ' · 有提取码' : ''}
            </div>
          </div>
          <div class="share-item-btns">
            <button class="btn" data-act="copy" data-i="${i}">复制</button>
            <button class="btn danger" data-act="kill" data-i="${i}">撤销</button>
          </div>
        </div>`).join('')}</div>`;

      dlg.el.querySelectorAll('[data-act]').forEach((b) => {
        b.addEventListener('click', async () => {
          const s = list[Number(b.dataset.i)];
          if (!s) return;
          if (b.dataset.act === 'copy') {
            const url = s.url || `${location.origin}/s/${s.token}`;
            try { await navigator.clipboard.writeText(url); Toast.ok('已复制', url); }
            catch { Toast.info('链接', url); }
            return;
          }
          const ok = await Dialog.confirm({
            title: '撤销分享',
            message: `撤销「${s.name || s.path}」的分享链接？撤销后旧链接立即失效。`,
            okText: '撤销', danger: true,
          });
          if (!ok) return;
          try {
            await API.shareRevoke(s.token);
            Toast.ok('已撤销');
            await render();
          } catch (e) { Toast.error('撤销失败', e.message); }
        });
      });
    };
    await render();
  }

  async function uploadFiles(body, S, files) {
    const dlg = Dialog.custom({ title: `正在上传 ${files.length} 个文件`, wide: false });
    dlg.foot.innerHTML = `<button class="btn" data-role="cancel">取消</button>`;
    dlg.el.innerHTML = `
      <div data-role="list" style="max-height:220px;overflow-y:auto;font-size:12.5px"></div>
      <div class="progress-wrap">
        <div class="progress-bar"><i data-role="bar"></i></div>
        <div style="display:flex;justify-content:space-between;margin-top:6px;
                    font-size:11.5px;color:var(--text-3)">
          <span data-role="stat">准备中…</span>
          <span data-role="pct">0%</span>
        </div>
      </div>`;

    const listEl = dlg.el.querySelector('[data-role="list"]');
    const bar = dlg.el.querySelector('[data-role="bar"]');
    const stat = dlg.el.querySelector('[data-role="stat"]');
    const pct = dlg.el.querySelector('[data-role="pct"]');
    let cancelled = false;
    dlg.foot.querySelector('[data-role="cancel"]').addEventListener('click', () => {
      cancelled = true;
      dlg.close();
    });

    let done = 0, failed = [];
    for (const f of files) {
      if (cancelled) break;
      const row = document.createElement('div');
      row.style.cssText = 'padding:3px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      row.textContent = `⏳ ${f.name}  (${fmtSize(f.size)})`;
      listEl.appendChild(row);
      listEl.scrollTop = listEl.scrollHeight;
      stat.textContent = `正在上传：${f.name}`;

      try {
        await API.upload({ mount: S.mount, path: S.path }, f, (frac) => {
          const overall = (done + frac) / files.length;
          bar.style.width = (overall * 100).toFixed(1) + '%';
          pct.textContent = Math.round(overall * 100) + '%';
        });
        row.textContent = `✅ ${f.name}`;
        done++;
      } catch (e) {
        row.textContent = `❌ ${f.name} — ${e.message}`;
        failed.push(`${f.name}: ${e.message}`);
      }
      bar.style.width = (done / files.length * 100).toFixed(1) + '%';
      pct.textContent = Math.round(done / files.length * 100) + '%';
    }

    if (!cancelled) dlg.close();
    if (failed.length) {
      Toast.error(`${failed.length} 个文件上传失败`, failed[0]);
    } else if (done) {
      Toast.ok('上传完成', `成功上传 ${done} 个文件`);
    }
    await load(body, S);
  }

  /* ------------------------------------------------------------------
     解压

     需求（原文）：「集成右键对压缩文件解压功能。」
     后端在 /api/extract（files.extract_archive），含 zip-slip 防护、
     单文件/总量/条目数上限。

     into 参数：
       false —— 解到「当前目录下、与压缩包同名的文件夹」（Windows 习惯）
       true  —— 弹目录选择器，解到用户指定的目录下
     ------------------------------------------------------------------ */
  function isArchiveName(name) {
    const n = String(name || '').toLowerCase();
    return ['.zip', '.tar', '.gz', '.gzip', '.bz2', '.xz',
            '.tgz', '.tbz2', '.txz'].some((s) => n.endsWith(s));
  }

  async function actExtract(body, S, entry, chooseDir) {
    const srcRel = joinPath(S.path, entry.name);
    let dest = '';

    if (chooseDir) {
      const target = await pickFolder(S.mount, S.path);
      if (target === null) return;
      // 选中的目录作为父目录，下面再套一层「压缩包主名」
      const base = entry.name.replace(/\.(tar\.)?(gz|gzip|bz2|xz|zip)$/i, '')
                              .replace(/\.(tgz|tbz2|txz)$/i, '');
      dest = joinPath(target, base);
      if (dest === S.path) dest = joinPath(target, base);
    }

    const dlg = Dialog.custom({ title: '正在解压', footer: false });
    dlg.el.innerHTML = `
      <div style="font-size:12.5px;line-height:1.7">
        <div style="color:var(--text-2)">${esc(entry.name)}</div>
        <div class="progress-wrap">
          <div class="progress-bar"><i style="width:45%;animation:pulse 1.2s ease-in-out infinite"></i></div>
        </div>
        <div style="font-size:11.5px;color:var(--text-3);margin-top:6px">
          大压缩包可能需要几十秒，请勿关闭窗口…
        </div>
      </div>`;

    try {
      const r = await API.extract(S.mount, srcRel, dest);
      dlg.close();
      const skipped = r.skippedCount
        ? `，跳过 ${r.skippedCount} 个不安全条目` : '';
      Toast.ok('解压完成',
        `${r.files} 个文件 · ${fmtSize(r.bytes)}${skipped}`);
      await load(body, S);
      // 解压出的文件夹默认选中，方便直接双击进去看
      const dirName = (r.dir || '').split('/').filter(Boolean).pop();
      if (dirName) {
        S.selected.clear();
        S.selected.add(dirName);
        renderFiles(body, S);
      }
    } catch (e) {
      dlg.close();
      // 目标已存在时给一个「改用别的名字」的二次机会
      if (/已存在/.test(e.message)) {
        const ok = await Dialog.confirm({
          title: '目标已存在',
          message: `${e.message}。是否解压到一个新的文件夹？`,
          okText: '换个名字解压',
        });
        if (!ok) return;
        const alt = `${(dest || entry.name.replace(/\.[^.]+$/, ''))}-1`;
        try {
          const r2 = await API.extract(S.mount, srcRel, alt);
          Toast.ok('解压完成', `${r2.files} 个文件 · ${fmtSize(r2.bytes)}`);
          await load(body, S);
        } catch (e2) { Toast.error('解压失败', e2.message); }
        return;
      }
      Toast.error('解压失败', e.message);
    }
  }

  async function actRename(body, S) {
    const names = [...S.selected];
    if (names.length !== 1) return;
    const old = names[0];
    const name = await Dialog.prompt({
      title: '重命名',
      message: '为这个项目输入新名称：',
      value: old,
      selectBase: true,
      hint: '名称不能包含 / \\ : * ? " < > |',
    });
    if (!name || name === old) return;
    try {
      await API.rename(S.mount, joinPath(S.path, old), name);
      Toast.ok('已重命名', `${old} → ${name}`);
      await load(body, S);
      S.selected.clear();
      S.selected.add(name);
      renderFiles(body, S);
    } catch (e) { Toast.error('重命名失败', e.message); }
  }

  async function actDelete(body, S) {
    const names = [...S.selected];
    if (!names.length) return;
    const dirs = S.entries.filter((e) => names.includes(e.name) && e.isDir);

    const listHtml = `<div class="danger-list">${
      names.slice(0, 30).map((n) => `<div>${esc(n)}</div>`).join('')
    }${names.length > 30 ? `<div>… 以及另外 ${names.length - 30} 项</div>` : ''}</div>`;

    const warnHtml = dirs.length
      ? `<div class="alert danger">${Icons.ui('warn', 16)}
           <span>其中包含 <strong>${dirs.length}</strong> 个文件夹，
           文件夹内的<strong>所有内容都会被一并删除</strong>，无法撤销。</span></div>`
      : '';

    const ok = await Dialog.confirm({
      title: names.length > 1 ? `删除 ${names.length} 个项目` : '删除项目',
      message: '确定要永久删除以下内容吗？此操作不可撤销。',
      html: listHtml + warnHtml,
      okText: '永久删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;

    let failed = [];
    for (const n of names) {
      try {
        await API.remove(S.mount, joinPath(S.path, n));
      } catch (e) { failed.push(`${n}: ${e.message}`); }
    }
    S.selected.clear();
    await load(body, S);

    if (failed.length) Toast.error(`${failed.length} 项删除失败`, failed[0]);
    else Toast.ok('已删除', `${names.length} 个项目已移除`);
  }

  function actDownload(body, S) {
    downloadSelected(body, S, [...S.selected]);
  }

  function downloadSelected(body, S, names) {
    if (!names.length) return;
    // 多个文件时逐个触发；浏览器会串行弹保存框，这是预期行为
    names.forEach((n, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = API.downloadUrl(S.mount, joinPath(S.path, n));
        a.download = n;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 400);
    });
    if (names.length > 1) {
      Toast.info('开始下载', `${names.length} 个文件，浏览器可能询问保存位置`);
    }
  }

  /** 复制 / 移动到另一个目录（用目录选择器） */
  async function actCopyMove(body, S, isMove) {
    const names = [...S.selected];
    if (!names.length) return;

    const target = await pickFolder(S.mount, S.path);
    if (target === null) return;

    let failed = [], okCount = 0;
    for (const n of names) {
      try {
        await API.move(S.mount, joinPath(S.path, n), target, isMove);
        okCount++;
      } catch (e) { failed.push(`${n}: ${e.message}`); }
    }
    await load(body, S);

    if (failed.length) Toast.error(`${failed.length} 项操作失败`, failed[0]);
    else Toast.ok(isMove ? '已移动' : '已复制', `${okCount} 个项目 → ${target}`);
  }

  /** 目录选择器：列出所有映射 + 当前映射的目录树（逐层进入） */
  function pickFolder(mount, startPath) {
    return new Promise((resolve) => {
      let cur = '/';
      const dlg = Dialog.custom({ title: '选择目标文件夹' });
      dlg.el.style.minHeight = '320px';

      dlg.el.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <button class="btn" data-role="p-up" style="padding:0 10px">${Icons.ui('up', 14)}</button>
          <div style="flex:1;font-size:12.5px;color:var(--text-2);
                      overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
               data-role="p-path">/</div>
        </div>
        <div data-role="p-list"
             style="height:260px;overflow-y:auto;border:1px solid var(--border);
                    border-radius:5px;background:var(--bg-layer);padding:4px"></div>`;

      dlg.foot.innerHTML = `
        <button class="btn" data-role="p-cancel">取消</button>
        <button class="btn primary" data-role="p-ok">选择此文件夹</button>`;

      const listEl = dlg.el.querySelector('[data-role="p-list"]');
      const pathEl = dlg.el.querySelector('[data-role="p-path"]');

      async function loadDir(p) {
        cur = p;
        pathEl.textContent = p === '/' ? `/${mount}` : p;
        listEl.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-3)">
          <div class="spinner" style="margin:0 auto"></div></div>`;
        try {
          const data = await API.list(mount, p);
          const dirs = (data.entries || []).filter((e) => e.isDir);
          if (!dirs.length) {
            listEl.innerHTML = `<div style="padding:14px;text-align:center;
              color:var(--text-3);font-size:12.5px">没有子文件夹</div>`;
            return;
          }
          listEl.innerHTML = dirs.map((d) => `
            <div data-d="${esc(d.name)}"
                 style="display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;
                        border-radius:4px;cursor:default;font-size:13px">
              ${Icons.ui('folder', 15)}<span>${esc(d.name)}</span>
            </div>`).join('');
          listEl.querySelectorAll('[data-d]').forEach((n) => {
            n.addEventListener('mouseenter', () => n.style.background = 'var(--bg-hover)');
            n.addEventListener('mouseleave', () => n.style.background = '');
            n.addEventListener('dblclick', () => loadDir(joinPath(cur, n.dataset.d)));
            n.addEventListener('click', () => {
              listEl.querySelectorAll('[data-d]').forEach((z) => z.style.background = '');
              n.style.background = 'var(--bg-selected)';
            });
          });
        } catch (e) {
          listEl.innerHTML = `<div style="padding:14px;text-align:center;
            color:var(--danger);font-size:12.5px">${esc(e.message)}</div>`;
        }
      }

      dlg.el.querySelector('[data-role="p-up"]').addEventListener('click', () => loadDir(parentPath(cur)));
      dlg.foot.querySelector('[data-role="p-cancel"]').addEventListener('click', () => {
        dlg.close(); resolve(null);
      });
      dlg.foot.querySelector('[data-role="p-ok"]').addEventListener('click', () => {
        dlg.close(); resolve(cur);
      });
      dlg.mask.addEventListener('mousedown', (e) => {
        if (e.target === dlg.mask) { dlg.close(); resolve(null); }
      });

      loadDir(startPath || '/');
    });
  }


  /* ======================================================================
     视图 / 工具栏 / 状态栏
     ====================================================================== */

  /** 排序下拉：挂在「排序」按钮下方，样式复用右键菜单 */
  function openSortMenu(body, S, btn) {
    const r = btn.getBoundingClientRect();
    const set = (k, asc) => {
      S.sortKey = k; S.sortAsc = asc;
      localStorage.setItem('nebula.sortKey', S.sortKey);
      localStorage.setItem('nebula.sortAsc', String(S.sortAsc));
      renderFiles(body, S);
    };
    const mark = (k, asc) => (S.sortKey === k && S.sortAsc === asc ? 'check' : '');
    ContextMenu.show(r.left, r.bottom + 4, [
      { label: '名称 升序',  icon: mark('name', true),  onClick: () => set('name', true) },
      { label: '名称 降序',  icon: mark('name', false), onClick: () => set('name', false) },
      { sep: true },
      { label: '大小 升序',  icon: mark('size', true),  onClick: () => set('size', true) },
      { label: '大小 降序',  icon: mark('size', false), onClick: () => set('size', false) },
      { sep: true },
      { label: '修改时间 升序', icon: mark('mtime', true),  onClick: () => set('mtime', true) },
      { label: '修改时间 降序', icon: mark('mtime', false), onClick: () => set('mtime', false) },
      { sep: true },
      { label: '类型 升序',  icon: mark('ext', true),   onClick: () => set('ext', true) },
      { label: '类型 降序',  icon: mark('ext', false),  onClick: () => set('ext', false) },
    ]);
  }

  /** 设置视图模式。mode = 'grid' | 'list' */
  function setView(body, S, mode) {
    if (S.view === mode) return;
    S.view = mode;
    localStorage.setItem('nebula.view', mode);
    applyViewMode(body, S);
    renderFiles(body, S);
  }

  function toggleView(body, S) {
    setView(body, S, S.view === 'grid' ? 'list' : 'grid');
  }

  function applyViewMode(body, S) {
    // 两个独立按钮：命中当前模式的置灰并高亮，另一个可点
    // （按钮由 WM.Toolbar.btn 生成 → 属性是 data-a）
    body.querySelectorAll('.viewbtn').forEach((b) => {
      const on = b.dataset.a === `view-${S.view}`;
      b.classList.toggle('active', on);
      b.disabled = on;
    });
    const st = body.querySelector('[data-role="st-view"]');
    if (st) st.textContent = S.view === 'grid' ? '图标视图' : '列表视图';
    const files = body.querySelector('[data-role="files"]');
    if (files) files.style.padding = S.view === 'grid' ? '0' : '0';
  }

  function toggleInfo(body, S) {
    S.infoOpen = !S.infoOpen;
    const panel = body.querySelector('[data-role="info"]');
    panel.classList.toggle('open', S.infoOpen);
    if (S.infoOpen) {
      const one = S.selected.size === 1 ? [...S.selected][0] : null;
      if (one) openInfo(body, S, one);
      else renderInfoPanel(panel, null, S);
    }
  }

  function openInfo(body, S, name) {
    const panel = body.querySelector('[data-role="info"]');
    if (!panel) return;
    if (!S.infoOpen) { S.infoOpen = true; panel.classList.add('open'); }
    // name 允许为 null（多选 / 空选的场景），此时渲染「未选中」占位，
    // 而不是抛异常。renderInfoPanel 对 e 为空已有分支处理。
    const e = name == null ? null : S.entries.find((x) => x.name === name);
    renderInfoPanel(panel, e, S);
  }

  function renderInfoPanel(panel, e, S) {
    if (!e) {
      panel.innerHTML = `<div style="color:var(--text-3);font-size:12.5px;padding:8px 0">
        选中一个项目以查看详细信息</div>`;
      return;
    }
    const kind = EXT_KIND[(e.ext || '').toLowerCase()];
    const canThumb = !e.isDir && kind === 'image' && e.size < 12 * 1024 * 1024;

    panel.innerHTML = `
      <div style="font-size:12.5px;font-weight:600;color:var(--text-2);margin-bottom:10px">
        详细信息
      </div>
      <div class="ip-preview">
        ${canThumb
          ? `<img src="${esc(imgUrl(e, S))}" alt="">`
          : Icons.file(e.name, e.isDir)}
      </div>
      <div class="ip-name">${esc(e.name)}</div>
      <div class="ip-row"><span class="k">类型</span><span class="v">${esc(typeName(e))}</span></div>
      ${e.isDir ? '' : `<div class="ip-row"><span class="k">大小</span>
        <span class="v">${esc(fmtSize(e.size))} (${e.size.toLocaleString()} 字节)</span></div>`}
      <div class="ip-row"><span class="k">修改时间</span>
        <span class="v">${esc(fmtTimeFull(e.mtime))}</span></div>
      <div class="ip-row"><span class="k">位置</span>
        <span class="v" title="${esc(S.mount + S.path)}">${esc(S.mount + S.path)}</span></div>
      <div class="ip-row"><span class="k">打开方式</span>
        <span class="v">${esc(routeLabel(e))}</span></div>
      ${e.readonly ? `<div class="alert warn" style="margin-top:12px">
        ${Icons.ui('lock', 16)}<span>此项为只读，无法修改。</span></div>` : ''}

      <div style="margin-top:14px;display:flex;flex-direction:column;gap:6px">
        <button class="btn" data-role="ip-open">打开</button>
        <button class="btn" data-role="ip-dl">下载</button>
      </div>`;

    panel.querySelector('[data-role="ip-open"]').addEventListener('click', () => {
      const w = WM.get(winIdOf(S));
      if (w) activate(w.bodyEl, S, e);
    });
    panel.querySelector('[data-role="ip-dl"]').addEventListener('click', () => {
      downloadSelected(null, S, [e.name]);
    });
  }

  function routeLabel(e) {
    if (e.isDir) return '—';
    if (e.route === 'onlyoffice') return 'OnlyOffice（可编辑）';
    if (e.route === 'kkfileview') return 'kkFileView 预览';
    return '仅下载';
  }

  function updateToolbar(body, S) {
    const n = S.selected.size;
    // ★ 业务按钮的属性是 data-a（由 WM.Toolbar.btn 生成）★
    //   别写成 data-act —— 那是**窗口三键**的专属标记，
    //   两者故意分开（见 renderShell 里的说明）。
    const set = (act, on) => {
      const b = body.querySelector(`[data-a="${act}"]`);
      if (b) b.disabled = !on;
    };
    set('rename', n === 1);
    set('download', n >= 1);
    set('delete', n >= 1);

    // 只读挂载时禁用所有写操作
    if (S.mountReadonly) {
      ['new-folder', 'upload', 'rename', 'delete'].forEach((a) => {
        const b = body.querySelector(`[data-a="${a}"]`);
        if (b) { b.disabled = true; b.title = '该目录为只读挂载'; }
      });
    }
  }

  function updateStatus(body, S) {
    const c = body.querySelector('[data-role="st-count"]');
    const s = body.querySelector('[data-role="st-sel"]');
    if (!c) return;

    const total = S.entries.length;
    const dirs = S.entries.filter((e) => e.isDir).length;
    const files = total - dirs;
    let txt = `${total} 个项目`;
    if (total) txt += `（${dirs} 个文件夹，${files} 个文件）`;
    if (S.filter) txt += ` · 筛选出 ${visibleEntries(S).length} 项`;
    if (S.mountReadonly) txt += ' · 只读';
    c.textContent = txt;

    if (s) {
      if (!S.selected.size) { s.textContent = ''; return; }
      const sel = S.entries.filter((e) => S.selected.has(e.name));
      const bytes = sel.reduce((a, e) => a + (e.isDir ? 0 : (e.size || 0)), 0);
      s.textContent = `已选中 ${sel.length} 项`
        + (bytes ? ` · ${fmtSize(bytes)}` : '');
    }
  }

  function joinPath(dir, name) {
    dir = normPath(dir);
    return dir === '/' ? name : `${dir}/${name}`;
  }


  /* ======================================================================
     外部接口
     ====================================================================== */
  return {
    open,
    /** 刷新所有已打开的资源管理器窗口 */
    refreshAll() {
      WM.list().forEach((w) => {
        if (w.id.startsWith('explorer:') && w.opts.nav) w.opts.nav.refresh();
      });
    },
    /** 供 app.js 定位：打开某映射的某路径 */
    reveal(mount, path) {
      const w = open(mount, parentPath(path));
      return w;
    },
  };
})();
