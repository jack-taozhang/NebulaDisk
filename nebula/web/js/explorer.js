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
      // ★ 递归搜索结果（null = 未在搜索）★
      //   需求（原文）：「网盘文件夹窗口上面的搜索功能 不支持后缀名和子文件夹
      //   的搜索」。S.filter 那套是**本地即时筛选**（只看当前目录 S.entries），
      //   这里存的是**后端递归搜索**的结果 —— 两者并存：
      //     · 输入为纯关键词 → 立刻本地筛（0 延迟，符合直觉）
      //     · 同时并发请求 /api/search（递归 + 后缀名匹配）
      //       回来后用 S.search 接管渲染，命中项可来自任意子目录。
      //   这样既保留了「打字即见」的顺畅，又真的能搜到子文件夹里的东西。
      search: null,
      searchSeq: 0,        // 请求序号，防抖后回包的乱序覆盖
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
      // ★ 必须传 `win.bodyEl`，不是 `win` ★
      //   2026-09-30 真机探针抓到的真 bug：原来写的是 `load(win, S)`，
      //   而 `win` 是 **WM 的窗口状态对象**，`load(body, S)` 要的是渲染用的
      //   DOM 容器。于是按 F5 会走到
      //       renderLoading(win, S) → win.querySelector is not a function
      //   而 `renderLoading` 又在 `try` **之前** ⇒ 异常直接穿出 load()，
      //   第 684 行刚置上的 `S.loading = true` 永远不会被 finally 复位
      //   ⇒ 这个资源管理器窗口**从此永久卡在"正在加载…"**（后面所有
      //   `if (S.loading) return` 全部静默吞掉）。
      //   修法两条：① 用正确的对象；② 把 renderLoading 挪进 try 里
      //   （见 load()），让任何渲染异常都不能再造成永久卡死。
      refresh: () => load(win.bodyEl, S),
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
            // ★ 新建下拉菜单：文件夹 + 多种文件类型 ★
            //   用一个带下拉箭头的按钮替代原「新建文件夹」单按钮，
            //   点击后展开 ContextMenu，列出所有可新建的类型。
            `<div class="tbtn-dropdown" data-a="new-menu" title="新建">
               <button class="tbtn" data-a="new-menu">
                 ${Icons.ui('plus')}
                 <span class="tbtn-text">新建</span>
                 <svg class="tbtn-caret" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>
               </button>
             </div>`,
            WM.Toolbar.btn('upload', 'upload', '上传'),
            WM.Toolbar.sep(),
            WM.Toolbar.btn('rename', 'rename', '', '', '重命名'),
            WM.Toolbar.btn('download', 'download', '', '', '下载'),
            WM.Toolbar.btn('delete', 'trash', '', '', '删除'),
          ],
          right: [
            // ★ 占位文案必须说清「含子文件夹」★
            //   老文案是「搜索当前目录…」，而用户报障正是「不支持后缀名和子
            //   文件夹的搜索」—— 文案本身就在暗示能力边界，会导致用户以为
            //   搜不到是设计如此。现在真的递归了，文案必须跟上。
            `<div class="searchbox">${Icons.ui('search')}`
              + `<input type="text" data-role="filter"`
              + ` placeholder="搜索（含子文件夹，支持 .pdf / *.pdf）" title="在当前目录及其所有子文件夹中递归搜索；输入 .pdf 或 *.pdf 可按后缀名筛选；空格/逗号分隔多个关键词（任一命中即可）"></div>`,
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

  /** 单次递归搜索请求的页大小。
   *
   *  后端 `/api/search` 的 limit 上限就是 `_SEARCH_MAX_HITS = 500`，
   *  传超过会被 `min()` 夹回 500 —— 所以这里直接写 500，不装模作样传 1000。
   *  超过 500 条时后端 `hasMore=true`，界面上明确写「仅列出相关度最高的 N 条」，
   *  不能让用户以为这就是全部（这正是 task24 修 `truncated` 的初衷）。
   */
  const SEARCH_PAGE = 500;

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
      if (act === 'new-menu') openNewMenu(body, S, btn);
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
      applyFilter(body, S, filterInput.value);
    }, 140));
    // Esc 清空并退出搜索（与 bindKeys 里 Esc 取消选中区分：输入框内优先清搜索）
    filterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && filterInput.value) {
        e.stopPropagation();
        filterInput.value = '';
        exitSearch(body, S);
      }
    });

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

      // ★★ 弹窗开着 → 本窗口一律不吃按键 ★★
      //   「弹窗开着，后面的窗口还能操作」这条报障，鼠标那半边由
      //   `.modal-mask` 挡住；键盘这半边必须靠这个判断 ——
      //   否则链接管理开着按 Delete 就是**真删后面资源管理器里选中的文件**。
      //   （窗口的 .focused 类在弹窗打开时并不会被摘掉，所以不能靠它。）
      if (Dialog.isOpen()) return;

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
        // ★ 搜索态下 Esc 优先「退出搜索」★
        //   用户按 Esc 的心理预期是「退出当前这个非常规状态」；搜索就是那个
        //   状态。只有在没搜索时，Esc 才退而求其次去取消选中。
        if (S.search) { e.preventDefault(); exitSearch(body, S); return; }
        if (!S.selected.size) return;
        S.selected.clear();
        renderFiles(body, S);
        updateToolbar(body, S);
        updateStatus(body, S);
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
    // ★ 换目录必须退出搜索 ★
    //   搜索结果是「相对某个起始目录」的，换了目录之后那批命中项就失去参照，
    //   继续显示会让人以为「新目录里也有这些文件」。
    //   同时把输入框清空 —— 否则框里还留着上次的关键词，看着像没生效。
    resetSearch(S);
    // 新建窗口时 body 可能还没绑定，需要重新定位元素
    const host = WM.get(winIdOf(S)) ? WM.get(winIdOf(S)).bodyEl : body;
    clearSearchInput(host);
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
    resetSearch(S);          // 同 navigate()：换目录即退出搜索
    const host = WM.get(winIdOf(S)) ? WM.get(winIdOf(S)).bodyEl : body;
    clearSearchInput(host);
    load(host, S);
  }

  async function load(body, S) {
    if (S.loading) return;
    S.loading = true;

    try {
      // ★ renderLoading 必须在 try **里面** ★
      //   它原来在第 685 行、try 之前 —— 一旦它自己抛异常（例如调用方
      //   传错对象，见 nav.refresh 的说明），异常会绕过下面的 finally，
      //   于是 `S.loading` 永久停在 true，这个窗口再也加载不了任何目录。
      renderLoading(body, S);
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
  /* ======================================================================
     递归搜索（后端 /api/search）

     需求（原文）：「网盘文件夹窗口上面的搜索功能 不支持后缀名和子文件夹的搜索」

     ★ 为什么光靠本地筛选做不到 ★
       老实现是 `S.entries.filter((e) => e.name.toLowerCase().includes(q))`：
         · `S.entries` 只有**当前目录一层** ⇒ 子文件夹里的东西永远搜不到；
         · `includes` 遇到 `*.pdf` 会原样拿去比对 ⇒ 一个也匹配不上，
           这就是用户体感里的「不支持后缀名」。
       而后端 `/api/search`（task24 起）本来就是递归 + 后缀名归一的
       （`_search_terms` 把 `.pdf` / `*.pdf` 都归一成 `pdf`；`_hit_rank`
       把扩展名精确命中排在第 3 档，优先级高于子串命中）。
       所以这里是**把已经存在的能力接上**，不是重写一套搜索。

     ★ 两种态如何切换（避免每敲一个字就闪一次）★
       · 输入非空且此前不在搜索态 → 先做一次**本地即时筛**（0 延迟反馈），
         同时并发发递归请求；请求回来后由 `S.search` 接管渲染。
       · 已在搜索态再改关键词 → **不回落到本地筛**，只把旧结果标记为
         `loading`（显示「搜索中…」）并保留上批结果，等新结果覆盖。
         否则列表会在「本地结果 ↔ 服务端结果」之间反复横跳。
       · 输入清空 / 输入框里按 Esc / 换目录 / 点「退出搜索」→ `resetSearch`
         回到普通浏览。
     ====================================================================== */

  /** 选中键：浏览态 = name（同目录内唯一）；搜索态 = 相对挂载根的 path（跨目录唯一）
   *
   *  ★ 为什么搜索态必须换键 ★
   *    `S.selected` 原来存的是**文件名**。搜索结果来自不同子目录，
   *    `a/readme.md` 与 `b/readme.md` 同名 ⇒ 按名字存会「选中一个，
   *    两个都高亮」，下载/删除还会指向错误的目录。
   *    所以搜索态一律用条目自带的 `path`（相对挂载根，`/api/search`
   *    的每条 hit 都带）作键。
   */
  function selKey(S, e) {
    return S.search ? (e.path || e.name) : e.name;
  }

  /** 由选中键反解出「相对**挂载根**的完整路径」
   *
   *  所有写操作（下载 / 删除 / 重命名 / 移动）都必须走这个函数，
   *  不能再自己拼 `joinPath(S.path, key)` —— 搜索态下那会指错目录。
   */
  function selPath(S, key) {
    return S.search ? key : joinPath(S.path, key);
  }

  /** 当前渲染用的列表：搜索态是命中项，浏览态是可见条目 */
  function curList(S) {
    return S.search ? (S.search.hits || []) : visibleEntries(S);
  }

  /** 命中项相对于「搜索起点」的所在目录；就在起点目录里时返回 '' */
  function relOf(S, e) {
    if (!S.search) return '';
    const base = normPath(S.search.base || '/');
    let p = String(e.path || '');
    if (!p) return '';
    if (base !== '/' && p.startsWith(base + '/')) p = p.slice(base.length + 1);
    else if (p.startsWith('/')) p = p.slice(1);
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }

  /** 只清状态，不碰 DOM（navigate/historyGo 用；之后 load 会整体重渲染） */
  function resetSearch(S) {
    S.searchSeq++;          // 在途请求全部作废
    S.search = null;
    S.filter = '';
  }

  function clearSearchInput(body) {
    const inp = body && body.querySelector
      ? body.querySelector('[data-role="filter"]') : null;
    if (inp && inp.value) inp.value = '';
  }

  /** 退出搜索，回到普通浏览 */
  function exitSearch(body, S) {
    resetSearch(S);
    clearSearchInput(body);
    renderFiles(body, S);
    updateStatus(body, S);
    updateToolbar(body, S);
  }

  /** 输入变化 → 本地即时筛 + 并发递归搜索 */
  function applyFilter(body, S, raw) {
    const q = String(raw == null ? '' : raw).trim();
    if (!q) { exitSearch(body, S); return; }

    S.filter = q.toLowerCase();

    if (!S.search) {
      // 首次进入搜索：先给本地筛选结果，用户立刻有反馈
      renderFiles(body, S);
    } else if (S.search.q !== q || S.search.base !== S.path) {
      // 已在搜索态 → 保留上批结果，只标记「正在搜新的」
      S.search = Object.assign({}, S.search, { q, base: S.path, loading: true });
      renderFiles(body, S);
    }
    runSearch(body, S, q);
  }

  async function runSearch(body, S, q) {
    const seq = ++S.searchSeq;
    const base = S.path;
    try {
      const r = await API.search(S.mount, q, base, SEARCH_PAGE, 0);
      // ★ 乱序保护 ★ 期间用户又改了关键词 / 换了目录 / 退出了搜索 → 丢弃
      if (seq !== S.searchSeq || S.path !== base) return;
      S.search = {
        q,
        base,
        hits: r.hits || [],
        total: r.total || 0,
        reachable: r.reachable || 0,
        hasMore: !!r.hasMore,
        depthCapped: !!r.depthCapped,
        scanned: r.scanned || 0,
        terms: r.terms || [],
        loading: false,
      };
    } catch (err) {
      if (seq !== S.searchSeq) return;
      // 搜索失败不改产品数据、也不把列表打空：退回本地筛选 + 明确报错
      S.search = null;
      renderFiles(body, S);
      updateStatus(body, S);
      updateToolbar(body, S);
      Toast.error('搜索失败', err.message);
      return;
    }
    renderFiles(body, S);
    updateStatus(body, S);
    updateToolbar(body, S);
  }

  /** 打开某项所在位置：跳到它的父目录并选中它 */
  function revealEntry(body, S, e) {
    const full = normPath(e.path || '');
    if (!full || full === '/') { exitSearch(body, S); return; }
    const dir = parentPath(full);
    const nm = baseName(full);
    resetSearch(S);
    clearSearchInput(body);
    navigate(body, S, dir, { push: true });
    // navigate 会异步 load；选中要在列表渲染出来之后落
    setTimeout(() => {
      S.selected.clear();
      S.selected.add(nm);
      renderFiles(body, S);
      updateToolbar(body, S);
      updateStatus(body, S);
    }, 0);
  }

  function searchItemMenu(body, S, x, y, e) {
    const items = [
      { label: '打开', icon: e.isDir ? 'folder' : 'eye',
        onClick: () => activate(body, S, e) },
      { label: '打开所在位置', icon: 'folder', accel: 'Ctrl+Enter',
        onClick: () => revealEntry(body, S, e) },
    ];
    if (!e.isDir) {
      items.push({ sep: true });
      items.push({
        label: '下载', icon: 'download',
        onClick: () => downloadPaths(body, S, [e.path || '']),
      });
      items.push({
        label: '复制路径', icon: 'copy',
        onClick: () => {
          const t = e.path || '';
          navigator.clipboard && navigator.clipboard.writeText(t)
            .then(() => Toast.ok('已复制路径', t))
            .catch(() => Toast.info('路径', t));
        },
      });
    }
    ContextMenu.show(x, y, items);
  }

  function renderSearchResults(wrap, body, S) {
    const hits = S.search.hits || [];
    const baseLabel = (S.search.base && S.search.base !== '/')
      ? S.search.base : S.mount;

    const head = `
      <div class="search-head">
        <span class="sh-sum">
          ${Icons.ui('search', 14)}
          在「<b title="${esc(baseLabel)}">${esc(baseLabel)}</b>」及其子文件夹下
          找到 <b>${S.search.total}</b> 个匹配项
          ${S.search.hasMore
            ? `<em class="sh-note">仅列出相关度最高的 ${hits.length} 条</em>` : ''}
          ${S.search.depthCapped
            ? '<em class="sh-note">目录过深，未全部扫描</em>' : ''}
          ${S.search.loading ? '<em class="sh-note sh-busy">搜索中…</em>' : ''}
        </span>
        <span class="sh-acts">
          <!-- ★ 刻意**不用** class="tbtn" ★
               那是 WM.Toolbar.btn 的模板专属类，重名会被
               _test_drag_buttons.js §12 判为「手写业务按钮 → 与工具栏模板漂移」，
               而且 .tbtn 的尺寸/间距是按工具栏 29px 高设计的，
               塞进这条汇总条里会把行高撑歪。这里用自己的 .sh-btn。 -->
          <button class="sh-btn" data-role="search-exit" title="回到普通浏览（Esc）">
            ${Icons.ui('close', 13)}<span>退出搜索</span>
          </button>
        </span>
      </div>`;

    if (!hits.length) {
      wrap.innerHTML = head + `<div class="state-box">
        ${Icons.ui('search', 56)}
        <div class="sb-title">没有匹配项</div>
        <div class="sb-hint">
          已扫描 ${S.search.scanned} 个项目。按后缀名找文件可以直接输入
          <code>.pdf</code> 或 <code>*.pdf</code>；多个关键词用空格分隔（任一命中即可）。
        </div>
      </div>`;
    } else {
      wrap.innerHTML = head + `
        <table class="list-view search-view">
          <thead><tr>
            <th style="width:34%">名称</th>
            <th style="width:32%">所在位置</th>
            <th style="width:150px">修改日期</th>
            <th class="num" style="width:100px">大小</th>
            <th style="width:36px"></th>
          </tr></thead>
          <tbody>${hits.map((e, i) => {
            const rel = relOf(S, e);
            const key = selKey(S, e);
            return `
            <tr class="${S.selected.has(key) ? 'selected' : ''}"
                data-i="${i}" data-key="${esc(key)}">
              <td class="cell-name" title="${esc(e.path || e.name)}">
                ${listThumb(e, S)}
                <span>${esc(e.name)}</span>
              </td>
              <td class="cell-loc">
                <button class="loc-link" data-loc="${i}"
                        title="打开所在位置：${esc(rel || baseLabel)}">
                  ${Icons.ui('folder', 13)}
                  <span>${esc(rel || '（当前目录）')}</span>
                </button>
              </td>
              <td>${esc(fmtTime(e.mtime))}</td>
              <td class="num">${e.isDir ? '' : esc(fmtSize(e.size))}</td>
              <td class="num">${e.isDir ? '' : `
                <button class="row-dl" data-dl="${i}" title="下载这个文件">
                  ${Icons.ui('download', 14)}
                </button>`}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>`;
    }

    // 退出搜索
    const exitBtn = wrap.querySelector('[data-role="search-exit"]');
    if (exitBtn) exitBtn.addEventListener('click', () => exitSearch(body, S));

    // 打开所在位置（按钮命中优先，别被行的单击选中吃掉）
    wrap.querySelectorAll('[data-loc]').forEach((b) => {
      b.addEventListener('mousedown', (ev) => ev.stopPropagation());
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        revealEntry(body, S, hits[+b.dataset.loc]);
      });
    });

    // 行内下载
    wrap.querySelectorAll('[data-dl]').forEach((b) => {
      b.addEventListener('mousedown', (ev) => ev.stopPropagation());
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        downloadPaths(body, S, [hits[+b.dataset.dl].path || '']);
      });
    });

    // 行交互：单击选中（用 path 作键）、双击打开、右键菜单
    wrap.querySelectorAll('tr[data-i]').forEach((tr) => {
      const idx = +tr.dataset.i;
      const e = hits[idx];
      const key = selKey(S, e);

      tr.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return;
        if (ev.ctrlKey || ev.metaKey) {
          S.selected.has(key) ? S.selected.delete(key) : S.selected.add(key);
        } else if (ev.shiftKey && S.lastClickIdx >= 0) {
          const a = Math.min(S.lastClickIdx, idx), b = Math.max(S.lastClickIdx, idx);
          for (let i = a; i <= b; i++) S.selected.add(selKey(S, hits[i]));
        } else {
          S.selected.clear();
          S.selected.add(key);
        }
        S.lastClickIdx = idx;
        wrap.querySelectorAll('tr[data-key]').forEach((n) => {
          n.classList.toggle('selected', S.selected.has(n.dataset.key));
        });
        updateToolbar(body, S);
        updateStatus(body, S);
      });

      tr.addEventListener('dblclick', (ev) => {
        ev.preventDefault();
        activate(body, S, e);
      });

      tr.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!S.selected.has(key)) {
          S.selected.clear();
          S.selected.add(key);
          wrap.querySelectorAll('tr[data-key]').forEach((n) => {
            n.classList.toggle('selected', S.selected.has(n.dataset.key));
          });
          updateToolbar(body, S);
          updateStatus(body, S);
        }
        searchItemMenu(body, S, ev.clientX, ev.clientY, e);
      });
    });
  }

  /** 按「相对挂载根的路径」批量下载（搜索态唯一安全的下载方式） */
  function downloadPaths(body, S, paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    list.forEach((p, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = API.downloadUrl(S.mount, p);
        a.download = baseName(p) || 'download';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 400);
    });
    if (list.length > 1) {
      Toast.info('开始下载', `${list.length} 个文件，浏览器可能询问保存位置`);
    }
  }

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
    if (!wrap) return;

    // ★ 搜索态走独立渲染器 ★
    //   不能复用 renderList：搜索结果的「所在位置」列、行内下载、以及
    //   「选中键是 path 而不是 name」这几条都和普通列表不同。
    if (S.search) { renderSearchResults(wrap, body, S); return; }

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
      // ★ 这里只代表「本地筛选没命中」★
      //   递归搜索正在进行 / 已失败时会走到这里，所以文案不能写死
      //   「未找到匹配项」—— 那会让用户在结果还没回来时就以为搜完了。
      return `<div class="state-box">
        ${Icons.ui('search', 56)}
        <div class="sb-title">当前目录没有匹配项</div>
        <div class="sb-hint">正在这个文件夹及其子文件夹里继续查找「${esc(S.filter)}」…</div>
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
      <div class="tile ${S.selected.has(selKey(S, e)) ? 'selected' : ''}"
           data-name="${esc(e.name)}" data-key="${esc(selKey(S, e))}"
           data-i="${i}" title="${esc(e.name)}"
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
    // ★ 搜索态必须用条目自带的完整相对路径 ★
    //   搜索结果的 e.name 只是文件名，真正的目录在 e.path 里；
    //   继续用 joinPath(S.path, e.name) 会指向「当前目录下的同名文件」
    //   —— 要么 404 破图，要么（更糟）显示了**另一个**文件的缩略图。
    const p = (S.search && e.path) ? e.path : joinPath(S.path, e.name);
    const q = new URLSearchParams({ mount: S.mount, path: p, inline: 'true' });
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
            <tr class="${S.selected.has(selKey(S, e)) ? 'selected' : ''}"
                data-name="${esc(e.name)}" data-key="${esc(selKey(S, e))}"
                data-i="${i}" draggable="true">
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
      // ★ imgUrl 必须能识别搜索态 ★
      //   搜索命中项可能来自任意子目录，用 joinPath(S.path, e.name) 拼会
      //   指向错误的路径（缩略图全变破图）。imgUrl 内部已按 S.search 分流。
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
        // ★ 选中键走 selKey() ★
        //   浏览态就是文件名；万一将来也在搜索态复用这个绑定，
        //   它会自动换成 path，不会把不同子目录里的同名文件一起选中。
        if (ev.ctrlKey || ev.metaKey) {
          const k = selKey(S, e);
          S.selected.has(k) ? S.selected.delete(k) : S.selected.add(k);
        } else if (ev.shiftKey && S.lastClickIdx >= 0) {
          const a = Math.min(S.lastClickIdx, idx), b = Math.max(S.lastClickIdx, idx);
          for (let i = a; i <= b; i++) S.selected.add(selKey(S, list[i]));
        } else {
          S.selected.clear();
          S.selected.add(selKey(S, e));
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
        const k = selKey(S, e);
        const names = S.selected.has(k) && S.selected.size
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
        if (!S.selected.has(selKey(S, e))) {
          S.selected.clear();
          S.selected.add(selKey(S, e));
          syncSelection(wrap, S);
          updateToolbar(body, S);
          updateStatus(body, S);
        }
        itemContextMenu(body, S, ev.clientX, ev.clientY);
      });
    });
  }

  function syncSelection(wrap, S) {
    wrap.querySelectorAll('[data-key]').forEach((n) => {
      n.classList.toggle('selected', S.selected.has(n.dataset.key));
    });
  }

  /** 双击行为：文件夹 → 进入该目录；文件 → 按路由打开预览器 */
  function activate(body, S, e) {
    if (e.isDir) {
      // ★ 搜索态：直接进入命中的那个目录 ★
      //   命中项的 `path` 就是「相对挂载根的完整路径」，直接 navigate 即可，
      //   不能再走 openChild(body, S, e.name) —— 那会拼成
      //   `joinPath(S.path, name)`，指的是**当前目录下的同名文件夹**（多半不存在）。
      if (S.search) {
        const target = normPath(e.path || '');
        resetSearch(S);
        clearSearchInput(body);
        navigate(body, S, target || '/', { push: true });
        return;
      }
      openChild(body, S, e.name);
      return;
    }

    // ★ 搜索态：不退出搜索（用户多半还要接着看下一条命中）★
    //   翻页上下文只给这一条：命中项来自不同子目录，把整批命中当成
    //   「同级文件列表」会让「下一个」从 /a/x.pdf 跳到 /b/y.pdf，
    //   位置计数也变成无意义的「第 3 / 87」。dirPath 取它的真实父目录，
    //   这样后续 explorer 载入该目录时 refreshContext 还能正确接手。
    if (S.search) {
      const full = normPath(e.path || '');
      if (!full || full === '/') return;
      Viewer.open(S.mount, full, e, [e], parentPath(full));
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
      // ★ 「新建」子菜单（悬停展开，Windows 风格）★
      {
        label: '新建',
        icon: 'plus',
        submenu: true,
        submenuItems: newMenuItems(body, S),
      },
      { label: '上传文件', icon: 'upload', onClick: () => actUpload(body, S) },
      { sep: true },
      // ★ 在空白处右键 → 分享**当前这个文件夹**本身 ★
      //   这是"分享整个目录"最自然的入口：不用先退到上一级再去点文件夹。
      //   根目录（S.path === '/'）也允许分享 —— 那是"分享整个映射"。
      {
        label: S.path === '/' ? `分享整个「${S.mount}」` : '分享整个文件夹',
        icon: 'share',
        onClick: () => actShare(body, S, {
          name: S.path === '/' ? S.mount : (S.path.split('/').filter(Boolean).pop() || S.mount),
          isDir: true,
          // ★ path 要用「这个目录自身的相对路径」，不是它的父路径 ★
          //   所以这里显式告诉 actShare 走目录本身：
          _selfPath: S.path,
        }),
      },
      { label: '管理我的链接…', icon: 'share', onClick: () => LinkManager.open() },
      { sep: true },
      { label: S.view === 'grid' ? '切换为列表视图' : '切换为图标视图',
        icon: 'list', onClick: () => toggleView(body, S) },
      {
        label: S.infoOpen ? '隐藏详细信息' : '显示详细信息',
        icon: 'info', onClick: () => toggleInfo(body, S),
      },
    ]);
  }

  /** 复制当前路径到剪贴板（功能保留，供其他地方调用） */
  async function copyCurrentPath(body, S) {
    const p = `${S.mount}${S.path === '/' ? '' : S.path}`;
    try {
      await navigator.clipboard.writeText(p);
      Toast.ok('已复制', p);
    } catch { Toast.error('复制失败', '浏览器拒绝了剪贴板访问'); }
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


  /* ======================================================================
     新建文件
     ====================================================================== */

  // 可新建的文件类型列表（与后端 create_file 支持的类型对应）
  //   ext      —— 扩展名（小写，不含点）
  //   label    —— 右键菜单/下拉菜单里显示的名称
  //   icon     —— UI 图标名（Icons.ui 用的）
  //   defaultName —— 默认文件名（不含扩展名，用户可修改）
  const NEW_FILE_TYPES = [
    { ext: 'txt',    label: '文本文档',      icon: 'text',   defaultName: '新建文本文档' },
    { ext: 'md',     label: 'Markdown 文档', icon: 'doc',    defaultName: '新建 Markdown 文档' },
    { ext: 'json',   label: 'JSON 文件',     icon: 'code',   defaultName: '新建 JSON 文件' },
    { ext: 'csv',    label: 'CSV 表格',      icon: 'table',  defaultName: '新建 CSV 表格' },
    { ext: 'xml',    label: 'XML 文件',      icon: 'code',   defaultName: '新建 XML 文件' },
    { ext: 'html',   label: 'HTML 网页',     icon: 'code',   defaultName: '新建 HTML 网页' },
    { sep: true },
    { ext: 'docx',   label: 'Word 文档',     icon: 'doc',    defaultName: '新建 Word 文档' },
    { ext: 'xlsx',   label: 'Excel 工作簿',  icon: 'table',  defaultName: '新建 Excel 工作簿' },
    { ext: 'pptx',   label: 'PowerPoint 演示', icon: 'slide', defaultName: '新建 PowerPoint 演示' },
  ];

  /** 新建一个指定类型的文件。弹出命名对话框 → 调用 API → 刷新列表 */
  async function actNewFile(body, S, ext) {
    const type = NEW_FILE_TYPES.find((t) => t.ext === ext);
    if (!type) return;
    const defaultBase = type.defaultName || '新文件';
    const name = await Dialog.prompt({
      title: `新建${type.label}`,
      value: defaultBase,
      selectBase: true,     // 默认选中主名，用户直接打字就能覆盖
      placeholder: '文件名称',
      hint: `自动带 .${ext} 后缀；名称不能包含 / \\ : * ? " < > |`,
    });
    if (!name) return;
    // 确保文件名带正确的扩展名（用户手动加了就不重复加）
    let finalName = name.trim();
    if (!finalName.toLowerCase().endsWith('.' + ext)) {
      finalName += '.' + ext;
    }
    try {
      await API.createFile(S.mount, S.path, finalName);
      Toast.ok('已创建', finalName);
      await load(body, S);
      S.selected.clear();
      S.selected.add(finalName);
      renderFiles(body, S);
    } catch (e) { Toast.error('创建失败', e.message); }
  }

  /** 从工具栏「新建」按钮展开菜单 */
  function openNewMenu(body, S, btn) {
    const r = btn.getBoundingClientRect();
    const items = newMenuItems(body, S);
    ContextMenu.show(r.left, r.bottom + 4, items);
  }

  /** 从右键「新建」子菜单位置展开（二级菜单在右侧） */
  function showNewSubMenu(body, S, x, y) {
    const items = newMenuItems(body, S);
    ContextMenu.show(x, y, items);
  }

  /** 组装「新建」菜单的条目列表（文件夹 + 各文件类型） */
  function newMenuItems(body, S) {
    const items = [
      { label: '文件夹', icon: 'folderAdd', onClick: () => actNewFolder(body, S) },
      { sep: true },
    ];
    for (const t of NEW_FILE_TYPES) {
      if (t.sep) { items.push({ sep: true }); continue; }
      items.push({
        label: t.label,
        icon: t.icon,
        onClick: () => actNewFile(body, S, t.ext),
      });
    }
    return items;
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
       - 同一个对话框里可以「管理我的链接」——不用再去找别的入口
       - ★ 目标是**文件**时，顺手把「直链」也取回来一并显示（2026-09-30）★
         一次拿到两种地址：分享链接（有落地页/提取码）与直链（免登录直取字节）。
         两者由后端同一张 links 表承载，管理也在同一处 ⇒
         用户那句「网盘里面自带的分享也纳入一起，采用短链的方式分享。
         管理纳入一起」在**一个对话框里就闭环**了。
         ⚠️ 直链取失败（旧后端）要**静默**——分享本身已经建好，
            不该因为附赠品拿不到而弹红。

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

  /* ---------------------------------------------------------------- 分享 */

  /**
   * ★★ 一个目标只留一条分享（2026-10-01 用户要求）★★
   *
   * 用户报障（原话 + 截图：同一个 `天津康希诺提升机图纸.dwg` 在链接管理里
   * 并排出现两条 `/s/…`）：
   *
   *   「同一个文件目前可以分享多个路径，这样调整为同一个文件只能分享一个
   *    路径，直连一个路径。」
   *
   * 后端已经用**部分唯一索引 + 幂等创建**兜住了（见 app/shortlink.py 顶部），
   * 前端这一层的责任是：**别再制造"看起来像新建"的交互**。
   * 所以打开对话框时先查这个目标上有没有链接 ——
   *
   *   有分享 → 直接把它显示出来（并带上直链），主按钮换成「编辑分享设置…」；
   *   没有   → 才是「创建链接」表单。
   *
   * ⚠️ 查失败（接口异常 / 老后端）要**静默降级**成表单：
   *    创建本身是幂等的（后端会把参数写到已有那条上），
   *    绝不会因为这里多走一步而多出一条链接。
   */
  const normRel = (p) => String(p == null ? '' : p)
    .replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');

  /**
   * ★ 防连点（2026-10-01）★
   *
   * ⚠️ 这个 `let` 必须**和 actShare 在同一个作用域**里。
   *    实测事故：只加了 `if (shareBusy) return;` 和 `shareBusy = true;`
   *    却漏了这行声明 ⇒ `actShare` 第一句就
   *       `ReferenceError: shareBusy is not defined`
   *    （读未声明的标识符直接抛，不像赋值会自动建全局）
   *    ⇒ 右键「分享」**点了完全没反应**（异常在 onClick 里被吞掉）。
   *    这条是用户报的「右键的分享功能不能用了」的真因。
   *    —— 教训：`grep 标识符` 时**只看引用不看声明**等于没查；
   *       新引入的模块级变量一定要 grep 出 `let/const/var` 那一行。
   */
  let shareBusy = false;

  /** 查这个目标上已有的链接。失败返回 {}，**绝不抛**。 */
  async function lookupLinks(mount, rel) {
    try {
      const r = await API.links();
      const items = (r && r.items) || [];
      const want = normRel(rel);
      const hit = (kind) => items.find((x) => x.kind === kind
        && x.mount === mount && normRel(x.path) === want);
      return { share: hit('share'), file: hit('file') };
    } catch (e) {
      return {};
    }
  }

  /** 有效期 / 提取码 / 次数 这三项的说明文字（结果区与已有态共用） */
  function shareHintText(sh) {
    return [
      sh.hasPassword ? '需要提取码' : '无需提取码',
      sh.expiresAt
        ? `有效期至 ${new Date(sh.expiresAt * 1000).toLocaleDateString()}`
        : '永久有效',
      sh.maxVisits ? `限 ${sh.maxVisits} 次访问` : '不限次数',
    ].join(' · ');
  }

  /** 直链那一段的说明文字 */
  function directHintText(d) {
    // ★ 直链默认 7 天 ⇒ 必须把失效时间告诉用户 ★
    //   否则他 7 天后发现链接打不开，只会以为"坏了"。
    return d.expiresAt
      ? `有效至 ${new Date(d.expiresAt * 1000).toLocaleString()}`
        + '（可在「链接管理」里续期或改为永久）'
      : '永久有效（可在「链接管理」里撤销）';
  }

  async function actShare(body, S, entry) {
    // 防连点：下面要 await 一次网络请求，不拦会开出两个对话框。
    if (shareBusy) return;
    shareBusy = true;
    try {
      // entry._selfPath 存在 → 分享的是「当前目录自身」（空白处右键进来的）
      //   否则 → 分享选中条目（S.path + name）
      const rel = entry._selfPath !== undefined
        ? entry._selfPath
        : joinPath(S.path, entry.name);

      // ★ 先查有没有已存在的链接：这是"一个目标一条分享"的前端落点 ★
      const exist = await lookupLinks(S.mount, rel);

      const dlg = Dialog.custom({ title: '分享', wide: true, maskClose: false });

      dlg.el.innerHTML = `
      <div class="share-dlg">
        <div class="share-target">
          <div class="share-tname">${esc(entry.name)}</div>
          <div class="share-tsub" data-role="tsub">${entry.isDir
            ? '文件夹（访客可只读浏览）' : '文件'}</div>
        </div>

        <div class="share-opts" data-role="opts">
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

        <!-- 「已有分享」态：不动表单，直接把用户引到同一个编辑器 -->
        <div class="share-hint" data-role="reuse" hidden></div>

        <div class="share-result" data-role="result" hidden>
          <!-- ★ 顺序：直链 → 分享链接（用户要求换位）★
               直链是"立刻能用、默认 7 天"的那条，放上面；分享链接带落地页与
               提取码/次数，是"正式分享"那条，放下面。 -->
          <div data-role="directwrap" hidden>
            <div class="share-label">直链（免登录 · 直接打开 / 下载）</div>
            <div class="share-linkrow">
              <input type="text" data-role="direct" readonly>
              <button class="btn" data-role="dcopy">复制</button>
            </div>
            <div class="share-hint" data-role="dhint"></div>
          </div>

          <div data-role="sharewrap" style="margin-top:14px">
            <div class="share-label">分享链接（落地页 · 可设提取码 / 有效期）</div>
            <div class="share-linkrow">
              <input type="text" data-role="link" readonly>
              <button class="btn" data-role="copy">复制</button>
            </div>
            <div class="share-hint" data-role="hint"></div>
          </div>

          <div class="share-hint" style="margin-top:12px">
            同一个目标只会有一条分享与一条直链 —— 重复创建不会多出地址，
            而是把设置写到同一条上（**地址保持不变**，已发出去的链接继续有效）。
            续期 / 改成永久 / 换地址 / 撤销都在「链接管理」里。
          </div>
        </div>
      </div>`;

      // ★ 底部按钮顺序：**「关闭」放最右**（2026-10-01 用户要求）★
      //   用户原话（两句要一起看）：
      //     · 「这两个窗口 关闭按钮 改到右边」
      //     · 「保存 都放在 最右侧」
      //   合起来的规则：
      //     ① 「关闭」类按钮不能甩在最左，要落在**右侧那一组**里；
      //     ② 主按钮（保存 / 创建链接）**仍然压在最右**。
      //   本弹窗在"已有分享"态下主按钮（创建链接）会被隐藏，剩下的
      //   `[编辑分享设置…] [关闭]` 里「关闭」就是唯一的主按钮 ⇒ 让它最右；
      //   在"新建"态下则是 `[关闭] [创建链接]` —— 创建链接压最右。
      //   ⚠️ 所以这里**不是**简单地"关闭永远最右"，而是：
      //      关闭排在主按钮之后，主按钮本来就最右。
      //      links.js 的「编辑分享设置」弹窗（`[取消] [保存]`）遵循同一规则，
      //      两处要一起看，改一处就得改另一处。
      dlg.foot.innerHTML = `
      <button class="btn" data-role="manage" style="margin-right:auto">管理我的链接…</button>
      <button class="btn" data-role="edit" hidden>编辑分享设置…</button>
      <button class="btn" data-role="create">创建链接</button>
      <button class="btn" data-role="close">关闭</button>`;

      const q = (r) => dlg.el.querySelector(`[data-role="${r}"]`);
      const resBox = q('result');
      const optsBox = q('opts');
      const reuseBox = q('reuse');
      const tsub = q('tsub');
      const createBtn = dlg.foot.querySelector('[data-role="create"]');
      const editBtn = dlg.foot.querySelector('[data-role="edit"]');

      dlg.foot.querySelector('[data-role="close"]').onclick = () => dlg.close();
      dlg.foot.querySelector('[data-role="manage"]').onclick = () => {
        dlg.close();
        LinkManager.open();
      };

      const copyFrom = async (input, label) => {
        try {
          await navigator.clipboard.writeText(input.value);
          Toast.ok('已复制', label || '链接已复制到剪贴板');
        } catch {
          // 剪贴板被拒（非 HTTPS / 权限）：退回"选中让用户自己复制"
          input.select();
          Toast.info('请手动复制', '浏览器拒绝了剪贴板访问，已为你全选');
        }
      };

      q('copy').onclick = () => copyFrom(q('link'));
      q('dcopy').onclick = () => copyFrom(q('direct'), '直链已复制');

      /** 画直链那一块（目录没有直链 → 整块隐藏） */
      function paintDirect(d) {
        const dw = q('directwrap');
        dw.hidden = true;
        if (!d || !d.url) return;
        q('direct').value = d.url;
        q('dhint').textContent = directHintText(d);
        dw.hidden = false;
      }

      /**
       * 画结果区。
       *   how = 'existing' 打开时就已有分享（不给创建按钮，指向链接管理）
       *         'created'  刚新建（同一个对话框里可以继续改设置再保存）
       *         'reused'   刚把参数写到了已有那条上（地址没变）
       */
      function paint(sh, direct, how) {
        resBox.hidden = false;
        q('link').value = sh.url || `${location.origin}/s/${sh.token}`;
        q('hint').textContent = shareHintText(sh);
        paintDirect(direct);

        if (how === 'existing') {
          optsBox.hidden = true;
          createBtn.hidden = true;
          editBtn.hidden = false;
          tsub.textContent = `${entry.isDir ? '文件夹' : '文件'} · 已有一条分享`;
          reuseBox.hidden = false;
          reuseBox.innerHTML =
            '<b>这个目标已经有一条分享</b>，不会再建第二条。'
            + '要改有效期 / 提取码 / 次数上限，用下面的<b>「编辑分享设置…」</b>；'
            + '要换一条新地址（旧地址立即失效），去「链接管理 → 更新分享地址」。';
          editBtn.onclick = () => {
            dlg.close();
            LinkManager.edit(sh);
          };
        } else {
          tsub.textContent = `${entry.isDir ? '文件夹' : '文件'} · `
            + (how === 'reused' ? '已更新' : '已创建');
          reuseBox.hidden = false;
          reuseBox.innerHTML = how === 'reused'
            ? '这个目标已经有分享，本次设置已<b>写在这条上</b>（地址没有变）。'
            : '已创建。同一个目标只会有一条分享：下次再改设置会写在<b>同一条</b>上。';
          createBtn.textContent = '保存设置';
        }
      }

      // ---- 打开时：已有分享就直接展示（这是"一个文件一条分享"的入口责任）----
      if (exist.share) {
        paint(exist.share, exist.file
          || (entry.isDir ? null : { url: `${location.origin}`
            + API.downloadUrl(S.mount, rel) }), 'existing');
      }

      createBtn.onclick = async (ev) => {
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

          // ★ 先把「直链」取回来再一次性渲染（只对文件；目录没有直链）★
          //   顺序换位后直链在上面，如果先显示分享链接、直链再异步补上，
          //   用户会看到上方先空一格再"跳"出来 —— 观感很差。所以先取后画。
          //   ⚠️ 失败要**静默**：后端没这功能（旧版）时只隐藏那一块，
          //      分享本身已经建好了，不该因为"附赠品"拿不到而弹红。
          let direct = null;
          if (!entry.isDir) {
            try { direct = await API.shortlink(S.mount, rel); } catch { direct = null; }
          }

          paint(sh, direct, r.reused ? 'reused' : 'created');
          if (r.reused) {
            Toast.ok('已更新这条分享', '地址没有变，已发出的链接继续有效');
          } else {
            Toast.ok('已创建分享', '链接已生成');
          }
        } catch (e) {
          Toast.error('创建分享失败', e.message);
        } finally {
          btn.disabled = false;
        }
      };
    } finally {
      shareBusy = false;
    }
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
    const keys = [...S.selected];
    if (!keys.length) return;
    // ★ 搜索态必须按「相对挂载根的路径」下载 ★
    //   搜索结果的选中键本来就是 path（见 selKey），而 downloadSelected
    //   会再拼一次 S.path ⇒ 得到 `/当前目录/a/b.txt` 这种错路径。
    if (S.search) { downloadPaths(body, S, keys); return; }
    downloadSelected(body, S, keys);
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
    //
    //   title0 记录按钮出厂 title：禁用时改写成禁用原因，重新启用时要还回去，
    //   否则会残留上一次的「无法重命名」提示（曾造成“按钮明明可用却写着禁用”）。
    const set = (act, on, why) => {
      const b = body.querySelector(`[data-a="${act}"]`);
      if (!b) return;
      if (b.dataset.title0 === undefined) b.dataset.title0 = b.title || '';
      b.disabled = !on;
      b.title = on ? b.dataset.title0 : (why || b.dataset.title0);
    };

    // ★★ 搜索态：写操作一律禁用 ★★
    //   重命名 / 删除 / 移动 / 新建 / 上传 的语义都是「在**当前浏览目录**里
    //   对选中的名字做操作」（内部一律 `joinPath(S.path, key)`）。
    //   而搜索结果的选中键是「相对挂载根的路径」，两者语义不匹配 ——
    //   照旧执行就会指向错误的位置（轻则 404，重则删掉别的目录里的同名文件）。
    //   要改搜索结果里的文件，先「打开所在位置」再操作，这是一步明确动作。
    if (S.search) {
      set('rename', false, '搜索状态下不能重命名，请先「打开所在位置」');
      set('delete', false, '搜索状态下不能删除，请先「打开所在位置」');
      set('new-menu', false, '搜索状态下不提供新建');
      set('upload', false, '搜索状态下不提供上传');
      set('download', n >= 1);
      return;
    }

    set('rename', n === 1);
    set('download', n >= 1);
    set('delete', n >= 1);

    // 只读挂载时禁用所有写操作
    if (S.mountReadonly) {
      ['new-menu', 'upload', 'rename', 'delete'].forEach((a) => {
        set(a, false, '该目录为只读挂载');
      });
    }
  }

  function updateStatus(body, S) {
    const c = body.querySelector('[data-role="st-count"]');
    const s = body.querySelector('[data-role="st-sel"]');
    if (!c) return;

    // ★ 搜索态：状态栏说的是「搜了什么 / 命中多少 / 扫了多少」★
    //   不能继续报「N 个项目」—— 那是当前目录的条目数，和搜索结果无关，
    //   用户会以为搜索没生效。
    if (S.search) {
      c.textContent = `搜索「${S.search.q}」· 命中 ${S.search.total} 项`
        + (S.search.hasMore ? `（仅列出前 ${S.search.hits.length} 项）` : '')
        + ` · 已扫描 ${S.search.scanned} 个项目`
        + (S.search.depthCapped ? ' · 目录过深未扫完' : '')
        + (S.mountReadonly ? ' · 只读' : '');
      if (s) {
        if (!S.selected.size) { s.textContent = ''; return; }
        const sel = S.search.hits.filter((e) => S.selected.has(selKey(S, e)));
        const bytes = sel.reduce((a, e) => a + (e.isDir ? 0 : (e.size || 0)), 0);
        s.textContent = `已选中 ${sel.length} 项`
          + (bytes ? ` · ${fmtSize(bytes)}` : '');
      }
      return;
    }

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
