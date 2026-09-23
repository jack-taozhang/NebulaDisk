/* ==========================================================================
   NebulaDisk —— 窗口管理器 + 桌面外壳
   --------------------------------------------------------------------------
   这是一个极简的窗口管理器（约 400 行），不引任何库。核心能力：
     - 多窗口并存，层级 z-index 管理，点击任意处激活
     - 拖拽移动 / 八向调整大小 / 最大化 / 最小化 / 关闭
     - 最大化时保留「还原」时的原始几何信息
     - 任务栏按钮与窗口状态双向同步
     - 窗口内容由工厂函数提供（便于同一 App 开多个实例）

   为什么自己写而不引库：
     NAS 部署希望零构建、零外部依赖；而资源管理器这种「单主体 App」的
     窗口需求很有限，引一个 100KB 的库不划算。
   ========================================================================== */

const WM = (() => {
  let zTop = 100;
  const windows = new Map();   // id -> winState
  let seq = 0;

  /** 量出本窗口右上角「三键」占的总宽，用于 resize 热区让位。
   *
   *  为什么要量而不是写死：三键宽度由 CSS（.win-controls .tb-btn { width: 34px }）
   *  决定，且可能随主题/字号调整。写死 34*3 会在样式变化后失准，导致
   *  热区又压回按钮上 —— 这正是本次要修的 bug，不能再引入同类隐患。
   *
   *  量不到时（例如 chromeless 且 controls:false 的窗口）返回 0，表示无需让位。
   */
  function windowControlsWidth(state) {
    try {
      const box = state.el.querySelector('.win-controls, .tb-controls');
      if (!box) return 0;
      // getBoundingClientRect 在窗口尚未布局时可能为 0，此时退回 3 键 * 34px
      const w = box.getBoundingClientRect().width;
      return w > 0 ? Math.ceil(w) : 102;
    } catch (_) {
      return 102;
    }
  }

  const layer = () => document.getElementById('window-layer');

  /* ------------------------------------------------------------------
     ★ 拖拽遮罩（drag shield）★

     需求（原文）：「窗口拖动的位置 有时不能跟随鼠标位置。」

     根因（本会话定位，两个叠加）：
       A. **iframe 吞指针事件**。预览/编辑窗口的 body 被 iframe 铺满
          （viewer.js 的 .kk-frame-wrap > iframe.viewer-frame，或
          OnlyOffice 的 host）。拖动时窗口跟手有 1 帧延迟：快速拖、或
          往下拖的时候，鼠标指针会先跑到 iframe 上方，然后 ——
          **父文档 document 上的 mousemove 立刻停止触发**。
          因为指针进了一个嵌套浏览上下文，事件属于 iframe 自己的文档。
          拖动就此**卡死**：窗口停在原地，鼠标继续走。
          这完美解释了用户说的「有时」：只在指针越过 iframe 时才发生。
       B. **mouseup 也丢**。同理，若松手时指针在 iframe 上，父文档收不到
          mouseup → `dragging` 永远是 true → 之后鼠标随便扫过窗口就把
          窗口瞬移到指针位置（更吓人的表现）。

     修法（两道保险，都能独立解决 A/B）：
       ① **整屏透明遮罩**：拖动/缩放期间在 document.body 上盖一层
          position:fixed; inset:0 的透明 div。它在所有 iframe 之上，
          指针永远落在这一层上，所以父文档 mousemove/mouseup 永不丢失。
          顺带解决拖动时把界面文字选蓝、以及光标跳回默认箭头的问题。
       ② **指针捕获**：mousedown 时 `bar.setPointerCapture(e.pointerId)`。
          按规范，被捕获的元素之后会收到**所有**指针事件，与指针位置无关
          —— 即使指针在 iframe 上方也照收。这是最"正"的解法。

     为什么两个都要：
       ② 是规范层的保证，但个别环境（老 WebKit / 某些嵌入式壳）对
       pointer capture 的实现有瑕疵；① 是纯 CSS/DOM 的兜底，不依赖任何
       规范细节。两者叠加后，「指针离开父文档」这件事在结构上不可能发生。
     ------------------------------------------------------------------ */
  let _shield = null;
  let _shieldCount = 0;      // 允许嵌套（拖动 + 缩放理论上可能交叠）

  function _shieldOn(cursor) {
    _shieldCount++;
    if (!_shield) {
      _shield = document.createElement('div');
      _shield.className = 'wm-drag-shield';
      document.body.appendChild(_shield);
    }
    _shield.style.cursor = cursor || 'default';
    _shield.classList.add('on');
    // 拖动期间禁止选中文本（原来靠 body.style.userSelect，现在交给遮罩）
    document.body.style.userSelect = 'none';
  }

  function _shieldOff() {
    _shieldCount = Math.max(0, _shieldCount - 1);
    if (_shieldCount === 0) {
      if (_shield) _shield.classList.remove('on');
      document.body.style.userSelect = '';
    }
  }

  /** 无条件撤掉遮罩（不管计数）。用于「手势丢了」的兜底。 */
  function _shieldForceOff() {
    _shieldCount = 0;
    if (_shield) _shield.classList.remove('on');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }

  /* ------------------------------------------------------------------
     ★ 遮罩泄漏的全局安全网 ★

     问题（用户原文：「目前点击中间部分才能前置，其他位置没有反应。」）：
       整屏遮罩是**必须**在拖动/缩放结束时撤销的。如果某次手势没能走到
       `up()`（典型场景：鼠标在**浏览器窗口外**松开 —— 此时父文档收不到
       pointerup；或者手势途中窗口被 reopen()/关闭打断），`_shieldCount`
       就会停在 >0，那层 `position:fixed; inset:0; z-index:9998;
       pointer-events:auto` 的透明遮罩**永远留着**。
       此后屏幕上的每一次点击都先落在这层遮罩上：
         · 它不是任何 .window 的子节点 → `_winOfNode()` 归属为 null;
         · 窗口自身 `el` 上的 mousedown 监听收不到（被遮罩吃掉）;
       于是「点哪儿都没反应」，看起来就像"只有点某处才行"。

     安全网：在 document 上以**捕获**阶段监听 pointerup / pointercancel /
     mouseup / window.blur。只要事件来了，就无条件把遮罩撤掉。
       为什么用 pointerup 而不是 pointermove：拖动中途 pointermove 频繁，
       不能撤（撤了 iframe 就开始吃事件）。pointerup 一到即代表手势结束。
       为什么要 window.blur：鼠标在浏览器外松开时，浏览器会给 window
       发 blur，这是唯一能感知"用户已经松手"的信号。
       capture:true 是为了抢在遮罩自己的处理之前先撤掉，避免顺序依赖。
     ------------------------------------------------------------------ */
  function _installShieldSafetyNet() {
    if (window.__nebulaShieldNet) return;
    window.__nebulaShieldNet = true;
    const bail = () => { if (_shieldCount > 0) _shieldForceOff(); };
    document.addEventListener('pointerup', bail, true);
    document.addEventListener('pointercancel', bail, true);
    document.addEventListener('mouseup', bail, true);
    window.addEventListener('blur', bail);
  }
  _installShieldSafetyNet();

  /** 拖拽用的几何起点。
   *
   *  为什么不用 offsetLeft：它是 **取整** 的、且相对 offsetParent。
   *  #window-layer 是 absolute;inset:0 且在 #desktop(fixed) 里，所以
   *  offsetParent 确实是 layer，正常情况两者相等；但窗口做过带小数
   *  的 resize（style.left 会是 "207.314px"）之后，offsetLeft 会取整成
   *  207，而真实待写回的值是 207.314 —— 每次拖动都吃掉 <1px，多次拖动
   *  后肉眼可见「起点偏移」。
   *  改用 getBoundingClientRect() 与 layer 的差，取到真实的小数坐标，
   *  和 style.left 的写入语义严格一致。
   */
  function _posOf(state) {
    const r = state.el.getBoundingClientRect();
    const L = layer();
    const lr = L ? L.getBoundingClientRect() : { left: 0, top: 0 };
    // 减去 layer 的滚动（当前不出滚动条，但这样写与 offsetParent 语义等价且更稳）
    return {
      x: r.left - lr.left + (L ? L.scrollLeft : 0),
      y: r.top - lr.top + (L ? L.scrollTop : 0),
      // ★ 宽高也取 rect（小数、含边框），不要用取整的 offsetWidth ★
      //   .window 有 1px 边框，rect.width 与 offsetWidth 都含边框，
      //   但后者取整。缩放时用它做基准会让「宽度 += dx」每次都丢零头。
      w: r.width,
      h: r.height,
    };
  }

  /* ------------------------------------------------------------------
     创建窗口
     opts = {
       id, title, icon, width, height, x, y, resizable, maximizable,
       minWidth, minHeight, single  (同 id 是否复用已有窗口)
       chromeless  (true = 不渲染标题栏；由内容区自己提供窗口控制按钮)
       render(bodyEl, win) -> void          内容渲染
       onClose, onResize, onFocus
     }

     ★ chromeless 的用法与约束 ★
       预览类窗口希望把「最小化/最大化/关闭」挪到自己的工具栏里、并与
       工具栏按钮排成一行，所以不需要独立的标题栏。此时：
         - 不渲染 .titlebar
         - 拖拽改由内容区顶部的 [data-drag-handle] 承担（见 _bindDrag）
         - 控制按钮由调用方用 data-act="min|max|close" 自行放置，
           _bindControls 会自动挂上事件（它查的是整棵 el）
     ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------
     统一工具栏（所有窗口共用同一套布局，避免各写各的又长歪）

     约定（用户明确要求，别再改回去）：
       左  ← [操作按钮 …]              …             [— □ ×] →  右
       即「最小化/最大化/关闭」永远在最右边；所有业务操作按钮在最左边。
       左右之间用 .tb-spacer 撑开。

     还约定：
       - 整条工具栏兼作窗口拖拽手柄（data-drag-handle）
       - 行高由 --toolbar-h 统一控制（全窗口一致）
       - 配色走 .toolbar 的 CSS 变量，跟随主题

     ★ 两类按钮、两个属性 —— 判据必须是「class + 属性」一起看 ★
       · 业务按钮（本工厂产出）：`class="tbtn"` + **`data-a`**
           谁产出的业务逻辑自己读 `btn.dataset.a`（explorer.js / viewer.js）。
       · **窗口控制键（唯一判据）：`class="tb-btn"` + `data-act`**
           shell.js 的 `_bindControls` 就是用 `.tb-btn[data-act]` 精确圈定它们。

       为什么判据要「两个条件一起」：项目里还有第三类按钮 ——
       explorer 地址栏的导航键（`class="nav-btn"` + `data-act`）。
       它们带 `data-act` 但**不是** `.tb-btn`，所以不会被 _bindControls 选中。
       反之，如果哪天把三键的选择器写成裸的 `.tb-btn`，那么
       预览窗口的翻页键（`tb-btn nav-btn`）就会被误选中并在第一行
       `stopPropagation()` —— 历史上这正是「点『下一个文件』没反应」的根因。
       ⇒ 记住：**业务按钮看 `data-a`；窗口键看 `.tb-btn[data-act]`。**

     用法：
       const bar = Toolbar.build({
         left:  [Toolbar.btn('new-folder', 'folderAdd', '新建文件夹')],
         right: [],
         winId: id,                       // 有就渲染三键，没有就纯工具栏
       });
       body.innerHTML = `<div style="...flex column...">${bar}<div class="win-fill">…</div></div>`;
  ------------------------------------------------------------------ */
  const Toolbar = {
    /**
     * 单个工具按钮。label 为空则只显示图标。
     * extra     —— 追加到 class 上的修饰符（如 'text'）
     * tooltip   —— 悬停提示；缺省时回退到 label
     */
    btn(act, icon, label, extra = '', tooltip = '') {
      const tip = tooltip || label || '';
      return `<button class="tbtn ${extra}" data-a="${act}" title="${esc(tip)}">`
        + `${icon ? Icons.ui(icon) : ''}`
        + `${label ? `<span class="tbtn-text">${esc(label)}</span>` : ''}`
        + `</button>`;
    },

    /** 分隔线 */
    sep() { return `<span class="tb-sep"></span>`; },

    /**
     * 组装工具栏。
     * opts = { left: [html], center: [html], right: [html], controls: bool, title: string }
     *   controls=true 时在**最右**渲染 最小化/最大化/关闭 三键。
     */
    build(opts = {}) {
      const left = (opts.left || []).join('');
      const center = (opts.center || []).join('');
      const right = (opts.right || []).join('');
      const controls = opts.controls === false ? '' : `
        <div class="win-controls">
          <button class="tb-btn" data-act="min" title="最小化">${Icons.ui('min')}</button>
          <button class="tb-btn max" data-act="max" title="最大化">${Icons.ui('max')}</button>
          <button class="tb-btn close" data-act="close" title="关闭">${Icons.ui('close')}</button>
        </div>`;
      const titleAttr = opts.title ? ` title="${esc(opts.title)}"` : '';
      return `<div class="toolbar win-toolbar" data-drag-handle${titleAttr}>
        <div class="wt-left">${left}</div>
        ${center}
        <span class="tb-spacer"></span>
        <div class="wt-right">${right}</div>
        ${controls}
      </div>`;
    },
  };

  function open(opts) {
    const id = opts.id || `win-${++seq}`;

    if (opts.single !== false && windows.has(id)) {
      const w = windows.get(id);
      if (w.minimized) restore(id); else focus(id);
      if (opts.onReuse) opts.onReuse(w);
      return w;
    }

    const el = document.createElement('div');
    el.className = 'window';
    el.dataset.winId = id;

    // ★ 可用桌面高度必须**扣掉任务栏** ★
    //
    //   原来写的是 `Math.min(opts.height, vh - 24)` —— 只留 24px 边距，
    //   完全没考虑底部任务栏（--taskbar-h，默认 48px）。
    //   600px 高的窗口在 625px 视口里会得到 H=601，而任务栏从 y=577 起，
    //   于是窗口**下边缘连同 s / se / sw 三个热区一起被任务栏盖住** ——
    //   用户在那附近按下去命中的是任务栏按钮，不是 resize 手柄。
    //   这正是「调整窗口大小有 BUG」在底边长期存在的一部分原因。
    //
    //   修法：可用高度 = 视口高 − 任务栏高。
    //   任务栏高度从 CSS 变量实读（可能随响应式断点变化），读不到时用 48。
    const cssNum = (name, dflt) => {
      try {
        const v = parseFloat(getComputedStyle(document.documentElement)
          .getPropertyValue(name));
        return Number.isFinite(v) && v > 0 ? v : dflt;
      } catch (_) { return dflt; }
    };
    const taskbarH = cssNum('--taskbar-h', 48);
    const vw = window.innerWidth, vh = window.innerHeight;
    const availW = vw - 24;
    const availH = Math.max(200, vh - taskbarH - 24);   // ← 扣掉任务栏
    const W = Math.min(opts.width || 980, availW);
    const H = Math.min(opts.height || 620, availH);

    // 默认位置：层叠偏移，避免每个窗口都盖在同一个点
    const offset = (windows.size % 6) * 26;
    const X = opts.x != null ? opts.x : Math.max(8, Math.round((vw - W) / 2) + offset - 60);
    const Y = opts.y != null ? opts.y : Math.max(8, Math.round((vh - taskbarH - H) / 2) + offset - 60);
    // 兜底：无论如何不许整块越出可用桌面（否则底部热区又抓不到）
    const clX = Math.max(8, Math.min(vw - 120, X));
    const clY = Math.max(8, Math.min(vh - taskbarH - 120, Y));

    Object.assign(el.style, {
      left: clX + 'px', top: clY + 'px', width: W + 'px', height: H + 'px',
      zIndex: ++zTop,
    });

    el.innerHTML = `
      ${opts.chromeless ? '' : `<div class="titlebar" data-role="titlebar">
        <span class="tb-icon">${opts.icon || Icons.ui('file', 16)}</span>
        <span class="tb-title">${esc(opts.title || '')}</span>
        <div class="tb-controls">
          <button class="tb-btn" data-act="min" title="最小化">${Icons.ui('min')}</button>
          <button class="tb-btn max" data-act="max" title="最大化">${Icons.ui('max')}</button>
          <button class="tb-btn close" data-act="close" title="关闭">${Icons.ui('close')}</button>
        </div>
      </div>`}
      <div class="win-body" data-role="body"></div>
    `;

    layer().appendChild(el);

    const bodyEl = el.querySelector('[data-role="body"]');
    const state = {
      id, el, bodyEl, opts,
      minimized: false, maximized: false,
      // 最大化前的几何，用于还原
      restoreRect: { x: X, y: Y, w: W, h: H },
      dirty: false,
    };
    windows.set(id, state);

    // 内容渲染（先渲染再绑定尺寸相关逻辑，避免拿到 0 宽）
    try {
      opts.render && opts.render(bodyEl, state);
    } catch (e) {
      console.error(`[wm] 窗口 ${id} 渲染失败`, e);
      bodyEl.innerHTML = `<div class="state-box">
        <div class="sb-title">界面加载失败</div>
        <div class="sb-hint">${esc(String(e && e.message || e))}</div>
      </div>`;
    }

    // ---- 事件绑定 ----
    _bindControls(state);
    if (opts.resizable !== false) _bindResize(state);
    _bindDrag(state);

    el.addEventListener('mousedown', () => focus(id), true);

    // ★ iframe 窗口必须额外接管焦点 ★
    //
    //   需求（原文）：「在弹出的窗口上，如果弹出的是onlyoffice或者kkfileview
    //   或者cad的窗口，那么点击窗口不会对窗口做弹最前，需要修复。」
    //
    //   根因：
    //     这三种预览窗口的内容都是 <iframe>。用户**点在 iframe 里面**时，
    //     浏览器把该事件算作 iframe 自己文档的事件，**不会**冒泡到父文档，
    //     所以上面那句 el.addEventListener('mousedown', ...) 根本收不到，
    //     focus(id) 不执行 → 窗口永远不置顶。
    //     （自己渲染 DOM 的窗口没有这个问题，所以只有这三种窗口出故障。）
    //
    //   解法：
    //     借助「焦点转移」信号。点击 iframe 内部时，父窗口的 window 会收到
    //     blur，而 iframe 的 window 会收到 focus。这里监听 iframe 的
    //     load 后挂上 focus 监听（**同源**才能监听，而本应用的预览都是
    //     同源反代 /preview/，所以可监听；跨域时下面的 try/catch 会静默跳过，
    //     这属于预期降级——跨域 iframe 本就拿不到任何内部事件）。
    //
    //   另外还要处理 iframe 自身盖住 mousedown 的情况：即使父文档的
    //     listener 生效范围没问题，用户从其它窗口切过来时第一下也常落在
    //     iframe 上。用 window.blur + document.activeElement 兜底：
    //     只要「当前激活元素是本窗口的 iframe」，就把本窗口置顶。
    if (!opts.noIframeFocus) {
      _bindIframeFocus(state);
    }

    // 双击标题栏 = 最大化切换（Windows 习惯）。
    // chromeless 窗口没有标题栏，调用方可用 [data-drag-handle] 承担同样行为。
    const tb = el.querySelector('[data-role="titlebar"]') || el.querySelector('[data-drag-handle]');
    if (tb) {
      tb.addEventListener('dblclick', (e) => {
        if (e.target.closest('.tb-btn')) return;
        if (opts.maximizable !== false) toggleMax(id);
      });
    }

    focus(id);
    _syncTaskbar();
    return state;
  }

  /* ------------------------------------------------------------------
     iframe 窗口的焦点接管
     ------------------------------------------------------------------ */

  // ★ 点击盾的全局单例状态（模块级，只初始化一次）★
  //   _shieldSyncHooks：所有 iframe 窗口的 syncShield 回调集合。
  //     任意窗口被 focus 时，都要重算「谁该挂盾」——
  //     刚上来的窗口撤盾、被压下去的窗口挂盾。
  //   用 Set + 统一回调，避免每个窗口各自在 document 上挂一个
  //   mousedown 监听（那种写法会互相抢着置顶，是上一版的真实缺陷）。
  let _shieldSyncHooks = null;
  let _shieldGlobalBound = false;
  let _onAnyFocusSync = null;

  function _bindIframeFocus(state) {
    const id = state.id;
    // 本窗口内已发现的所有 iframe（供盾的开关批量操作）
    state._iframes = state._iframes || [];

    /** 把一个 iframe 的「内部点击」接回本窗口的置顶逻辑。
     *
     *  ★ 必须在**每次 load 之后重新绑定**，这是本函数的核心修正 ★
     *
     *  踩过的坑（用户原文：「预览和编辑窗口被挡住后：点击窗口内部
     *  不能实现点击的窗口显示在前面。」）：
     *     旧实现只绑定一次，且用一个 `fr.__nebulaFocusBound` 标志位
     *     防止重复绑定。问题是绑定的时机在**窗口刚打开**时 —— 那时
     *     viewer 还没设置 iframe.src（它是异步 await previewUrl 之后
     *     才 `frame.src = r.url`）。
     *     对没有 src 的 iframe，`contentWindow` 指向 about:blank 那个
     *     文档；等真正的 src 加载完成，浏览器**换掉了整个 document**，
     *     挂在旧 window 上的 mousedown 监听随之**全部失效**。
     *     再加上标志位已置 true，后续再也不会重绑 →
     *     用户点 iframe 内部永远不触发 focus(id) → 窗口不置顶。
     *
     *  修法：
     *     每次 `load` 事件后重新取 contentWindow 并绑定。
     *     标志位改成记录「已绑定的那个 window 对象」，换了 window 才重绑
     *     （避免同一文档被 load 多次时叠加重复监听）。
     */
    const bindFrame = (fr) => {
      // 路径 1：同源 iframe —— 进它的 window 挂 mousedown。
      //   同源才能访问 contentWindow；跨域会抛错，交给路径 2/4。
      try {
        const cw = fr.contentWindow;
        if (!cw) return;
        // 已经绑过**同一个** window 就不再重复绑（文档没换）
        if (fr.__nebulaFocusWin === cw) return;
        fr.__nebulaFocusWin = cw;

        const grab = () => focus(id);
        cw.addEventListener('focus', grab);
        // mousedown 也要：点击**已处于焦点**的 iframe 时浏览器不再派发
        // focus/focusin（状态没变化），只有 mousedown 每次都发。
        cw.addEventListener('mousedown', grab, true);
      } catch (_) { /* 跨域：忽略，交给几何兜底 */ }
    };

    const attach = () => {
      state._iframes = state._iframes || [];
      state.el.querySelectorAll('iframe').forEach((fr) => {
        if (!state._iframes.includes(fr)) state._iframes.push(fr);
        // ★ 路径 4：给每个 iframe 盖一层透明点击盾（跨域也有效）★
        makeShield(fr);
        // 路径 2：父文档侧 —— activeElement 变成这个 iframe 时置顶。
        if (!fr.__nebulaFocusEvt) {
          fr.__nebulaFocusEvt = true;
          fr.addEventListener('focus', () => focus(id));
        }
        // 路径 1：立即尝试一次（src 已就绪的情况）；
        //   并在每次 load 后重试（src 后设的情况，这是常态）。
        bindFrame(fr);
        if (!fr.__nebulaLoadEvt) {
          fr.__nebulaLoadEvt = true;
          fr.addEventListener('load', () => {
            bindFrame(fr);
            // 内容换文档后，盾的开关状态要按当前 z 序重算一次
            syncShield && syncShield();
          });
        }
      });
      // 新造出来的盾默认按当前 z 序决定开/关
      syncShield && syncShield();
    };

    // ★ 注意：attach() 的调用必须放在 makeShield / syncShield 定义**之后** ★
    //   它们都是 const 声明的箭头函数，有暂时性死区（TDZ）。
    //   放前面会直接抛
    //     ReferenceError: Cannot access 'makeShield' before initialization
    //   —— 而这会让**每一个** iframe 预览窗口打开即崩。
    //   （这个坑是被 _test_iframe_shield.js 抓出来的，别再调回去。）

    // 路径 3：全局兜底。父窗口收到 focusin、且激活元素是本窗口内的 iframe →
    //   说明用户点进了我们的 iframe，置顶。
    //   （挂在 document 上，close 时由 _unbindIframeFocus 移除。）
    const onDocFocusIn = (e) => {
      if (!windows.has(id)) return;
      const t = e.target;
      if (t && t.tagName === 'IFRAME' && state.el.contains(t)) focus(id);
    };
    document.addEventListener('focusin', onDocFocusIn, true);
    state._iframeFocusIn = onDocFocusIn;

    // 路径 4：**透明点击盾（跨域也 100% 可靠的一条）** ★★★
    //
    //   需求（原文，用户第三次强调）：
    //     「编辑和预览文件的窗口 目前还没有实现 点击窗口任何地方就聚焦成
    //       最前端显示。」
    //     「目前点击中间部分才能前置，其他位置没有反应」
    //
    //   ── 为什么前面三条路都不够 ──
    //     ① 跨域 iframe（只在真机 https + 独立 Office/CAD 容器时出现）
    //        contentWindow 抛错 → 路径 1 死。
    //     ② 路径 1/2/3 **全部依赖「焦点发生转移」**。
    //        用户点第一下时焦点已给了 iframe；之后无论点多少次，
    //        activeElement 没变 → 浏览器**不再派发** focus/focusin
    //        → 窗口纹丝不动。这正是「点中间没反应、点其他地方没反应」。
    //     ③ 几何兜底（旧路径 4）在父文档上听 mousedown，
    //        可**跨域 iframe 内部的点击根本不会派发到父文档**
    //        （事件被 iframe 自己的浏览上下文吃掉），父文档监听收不到。
    //        而且它靠 elementFromPoint 猜归属，重叠窗口时会互相抢着置顶。
    //        ——实测两个 IF 窗口重叠时 A 被点却仍被 B 压住，就是这个原因。
    //
    //   ── 透明点击盾的原理（标准做法，与是否同源、是否跨域全无关）──
    //     在 iframe **上面**盖一层透明 div（.iframe-shield），尺寸与 iframe
    //     完全一致。它属于父文档，所以它的 mousedown **一定**会冒泡到
    //     el 上的捕获监听 → focus(id) 必定执行。
    //
    //     关键是「什么时候撤掉盾」：
    //       · 本窗口**不是**最顶层时 → 盾生效（吃掉点击，只用于置顶）；
    //       · 置顶之后 → 立即撤掉盾（pointer-events:none），
    //         让后续点击、滚动、拖选都能真正进入 iframe 内部。
    //     于是行为跟 Windows 一致：第一下点「激活 + 置顶」，
    //     之后再点就能正常操作内容，且**任意位置**都有效。
    //
    //     重挂时机：任何**别的**窗口被 focus、或本窗口失焦时，
    //     重新把盾装上（此时本窗口又变成「非最顶层」）。
    //     用 zIndex 判定最顶层，绝不手写 z 号。
    const setShield = (on) => {
      state._iframes.forEach((fr) => {
        const s = fr.__nebulaShield;
        if (!s) return;
        s.style.pointerEvents = on ? 'auto' : 'none';
        s.style.display = on ? 'block' : 'none';
      });
    };
    const amTop = () => {
      let topId = null, topZ = -Infinity;
      windows.forEach((w) => {
        if (w.minimized) return;
        const z = parseInt(w.el.style.zIndex || '0', 10);
        if (z >= topZ) { topZ = z; topId = w.id; }
      });
      return topId === id;
    };
    /** 按当前 z 序重新决定盾的开关（本窗口在最顶 → 撤盾） */
    const syncShield = () => {
      if (!windows.has(id)) return;
      const w = windows.get(id);
      if (!w || w.minimized) { setShield(false); return; }
      setShield(!amTop());
    };
    state._iframeSyncShield = syncShield;

    // 盾的存活由 attach() 负责：每发现一个还没有盾的 iframe 就造一个，
    //   并挂到同一个定位容器（.kk-frame-wrap 等 position:relative 的父节点）。
    const makeShield = (fr) => {
      if (fr.__nebulaShield) return fr.__nebulaShield;
      const host = fr.parentNode;
      if (!host) return null;
      const cs = getComputedStyle(host);
      if (cs.position === 'static') host.style.position = 'relative';
      const s = document.createElement('div');
      s.className = 'iframe-shield';
      s.setAttribute('data-win-id', id);   // 归属本窗口：供 elementFromPoint 判定
      s.style.cssText = [
        'position:absolute', 'inset:0', 'z-index:5',
        'background:transparent', 'cursor:default',
        // ★ 显式写出初始值：盾刚造出来、第一次 syncShield 还没跑时，
        //   必须有确定的 pointer-events，不能依赖浏览器默认值。
        'pointer-events:auto',
      ].join(';');
      // ★ 只接管 mousedown：置顶只应该在"按下"时发生一次 ★
      //   click 也接管，防止拖选等路径漏掉。
      s.addEventListener('mousedown', (e) => {
        if (!windows.has(id)) return;
        e.stopPropagation();
        e.preventDefault();      // 不抢焦点、不触发父层拖拽
        focus(id);               // 置顶
        syncShield();            // 已最顶 → 撤盾，让内容可用
      }, true);
      host.appendChild(s);
      fr.__nebulaShield = s;
      return s;
    };

    // 全局钩子：只要**任意**窗口被 focus，就重算每个 iframe 窗口该不该挂盾。
    //   挂在 module 级单例上（只注册一次），避免每个窗口一份重复监听
    //   —— 上一版每个窗口自己挂 document mousedown，重叠时会互相抢着置顶。
    if (!_shieldSyncHooks) _shieldSyncHooks = new Set();
    _shieldSyncHooks.add(syncShield);
    state._iframeShieldOnFocus = syncShield;

    // ★ 全部依赖（makeShield / syncShield / bindFrame）都就绪了，现在才跑 ★
    attach();
    // 内容可能稍后才渲染出 iframe（比如 viewer 先显示 loading 再挂 frame），
    // 所以用 MutationObserver 持续接管新出现的 iframe。
    const mo = new MutationObserver(attach);
    mo.observe(state.el, { childList: true, subtree: true });
    state._iframeMo = mo;
  }

  /** 所有 iframe 窗口重算点击盾（由 focus() 调用） */
  function _syncAllShields() {
    if (!_shieldSyncHooks) return;
    _shieldSyncHooks.forEach((fn) => { try { fn(); } catch (_) { /* 窗口已关 */ } });
  }

  function _unbindIframeFocus(state) {
    if (state._iframeMo) {
      state._iframeMo.disconnect();
      state._iframeMo = null;
    }
    if (state._iframeFocusIn) {
      document.removeEventListener('focusin', state._iframeFocusIn, true);
      state._iframeFocusIn = null;
    }
    if (state._iframeMouseDown) {
      document.removeEventListener('mousedown', state._iframeMouseDown, true);
      state._iframeMouseDown = null;
    }
    // ★ 注销点击盾：移除 sync 回调 + 删掉 DOM 上的盾 ★
    if (state._iframeShieldOnFocus && _shieldSyncHooks) {
      _shieldSyncHooks.delete(state._iframeShieldOnFocus);
      state._iframeShieldOnFocus = null;
    }
    (state._iframes || []).forEach((fr) => {
      const s = fr.__nebulaShield;
      if (s && s.parentNode) s.parentNode.removeChild(s);
      fr.__nebulaShield = null;
    });
    state._iframes = null;
  }

  /* ------------------------------------------------------------------
     控制按钮
     ------------------------------------------------------------------ */
  function _bindControls(state) {
    // ★★★ 必须只选「窗口控制键」，即带 data-act 的那三个 ★★★
    //
    //   需求（原文）：「在预览窗口，增加可以切换上一个 和下一个文件。」
    //                 点「下一个」但文件不切换。
    //
    //   根因（真实浏览器 track 出来的，别再改回去）：
    //     旧代码写的是 `querySelectorAll('.tb-btn')` —— 把所有 .tb-btn 都当成了
    //     窗口控制键。而 navBtns() 渲染的翻页按钮 class 恰好也是
    //     `tb-btn nav-btn`（见 viewer.js navBtns），于是它们也被挂上了这条
    //     监听；里面**第一行无条件** `e.stopPropagation()`，而
    //     `btn.dataset.act` 对翻页键是 undefined，所以什么也不做 ——
    //     结果就是「click 在到达 .win-toolbar 的业务监听前被掐断」，
    //     点一下毫无反应（不报错、不换文件、pos 冻结）。
    //
    //     为什么最小化/最大化/关闭是好的：它们**就是** data-act 三键，
    //     走的是同一条监听的正确分支 —— 正好与用户观察一致。
    //     为什么缩放/旋转是好的：Toolbar.btn 产出的 class 是 `.tbtn`（少个 b），
    //     从不被 .tb-btn 选中，所以它们的 click 一路冒泡到业务监听。
    //
    //   修法：收窄选择器到 `[data-act]`，只认窗口控制键。
    //     这样任何「业务按钮」无论叫 .tbtn 还是 .tb-btn 都不会被误吞。
    state.el.querySelectorAll('.tb-btn[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'min') minimize(state.id);
        else if (act === 'max') toggleMax(state.id);
        else if (act === 'close') close(state.id);
      });
    });
    // 最大化按钮的图标随状态切换（chromeless 窗口可能没有，需判空）
    const maxBtn = state.el.querySelector('.tb-btn.max');
    if (maxBtn) maxBtn.classList.toggle('disabled', false);
  }

  /* ------------------------------------------------------------------
     拖拽移动
     ------------------------------------------------------------------ */
  function _bindDrag(state) {
    // chromeless 窗口没有 titlebar，退化为内容区顶部的 [data-drag-handle]
    const bar = state.el.querySelector('[data-role="titlebar"]')
             || state.el.querySelector('[data-drag-handle]');
    if (!bar) return;
    let sx, sy, ox, oy, ow, ohh, dragging = false, pid = null;

    const move = (ev) => {
      if (!dragging) return;
      // ★ 位移严格 = 指针位移 ★
      //   起点 ox/oy 与起点指针 (sx,sy) 同帧采样，所以窗口相对指针的
      //   「抓取偏移」在整段拖动中恒定不变 —— 这正是「跟手」的定义。
      let nx = ox + (ev.clientX - sx);
      let ny = oy + (ev.clientY - sy);

      // ★ 边界钳位：只保证「标题栏/工具栏始终有一截留在屏幕内」★
      //
      //   为什么必须钳：不钳就能把窗口整个拖出屏幕外，然后用户再也
      //   抓不回来（除非会用手势/快捷键）。Windows 同样会钳住。
      //
      //   为什么旧版会被用户感知成「不跟随鼠标」：
      //     旧值 maxX = innerWidth - 80、maxY = innerHeight - 60
      //     允许窗口右/下**大部分**移出屏幕，但 left 下限只有
      //     -(offsetWidth-120)、top 下限 0。数值本身不算错，错在
      //     用户拖到边界后窗口会"停住"、指针还能继续走 —— 但这是
      //     所有桌面系统的共同行为，不是 bug。
      //     真正让它显得像 bug 的是 **A/B**（iframe 吞事件）：
      //     窗口卡死在中途、离边界还很远，用户就觉得「不跟手」。
      //
      //   这里把停留量放大到「至少留 KEEP 像素可见」这个唯一约束，
      //   语义清晰、可证明：任意方向上，窗口与视口至少重叠 KEEP 像素。
      const vw = window.innerWidth, vh = window.innerHeight;
      const KEEP = 120;                 // 至少留这么多像素在屏幕内
      // 底部可用边界要扣掉任务栏，否则窗口会被拖到任务栏底下、热区抓不到
      let tbH = 48;
      try {
        const v = parseFloat(getComputedStyle(document.documentElement)
          .getPropertyValue('--taskbar-h'));
        if (Number.isFinite(v) && v > 0) tbH = v;
      } catch (_) {}
      const vhUsable = vh - tbH;
      nx = Math.max(KEEP - ow, Math.min(vw - KEEP, nx));
      ny = Math.max(0, Math.min(vhUsable - KEEP, ny));  // 顶部不越界、底部不钻到任务栏下

      state.el.style.left = Math.round(nx) + 'px';
      state.el.style.top = Math.round(ny) + 'px';
      state.opts.onResize && state.opts.onResize(state);
    };

    const up = (ev) => {
      if (!dragging) return;
      dragging = false;
      try { if (pid != null && bar.hasPointerCapture(pid)) bar.releasePointerCapture(pid); } catch (_) {}
      pid = null;
      document.body.style.cursor = '';
      _shieldOff();
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
      bar.removeEventListener('lostpointercapture', up);
      state.opts.onResize && state.opts.onResize(state);
    };
    state._dragUp = up;   // 供 close() 兜底摘除

    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;

      // ★★★ 点这条工具栏（含「最小化/最大化/关闭」那一行）必须能前置窗口 ★★★
      //
      //   需求（原文）：「窗口点击聚焦显示所有窗口，最顶上的工具栏（最小化，
      //   最大化，关闭这一行）目前没有涵盖在内。需要增加点击这个区域也能
      //   前置显示窗口。两种窗口都要修改。」
      //
      //   根因（本行就是修复点）：
      //     窗口置顶原本只挂在 `el` 的 **mousedown** 捕获监听上
      //     （见 attach()：`el.addEventListener('mousedown', () => focus(id), true)`）。
      //     而工具栏是拖动区，本函数在 pointerdown 末尾会执行
      //     `e.preventDefault()`（第 785 行，为抑制文本选择/touch 滚动）。
      //     按 Pointer Events 规范，**在 pointerdown 上 preventDefault 会一并
      //     抑制浏览器派生的 mousedown** —— 于是这条链上根本没有 mousedown：
      //       工具栏 pointerdown → preventDefault → (mousedown 不派发) → focus 不执行
      //     表现就是：点窗口**内容区**能置顶，点**最顶上那条工具栏**不能。
      //     （同一机制在 739 行附近的注释里已经为业务按钮踩过一次，那次是
      //      反过来 —— 因为 preventDefault 让 button 的 click 也不触发。）
      //
      //   修法：置顶不再依赖 mousedown，直接在 pointerdown 里做。
      //     位置放在**按钮排除之前**，因为：
      //       · 三键（最小化/最大化/关闭）与所有业务按钮点下去时，窗口同样
      //         应该在动作之前先浮到最上层（Windows 的行为就是这样）；
      //       · 最大化状态会在这行之后的 `if (state.maximized) return;` 提前
      //         返回，而「最大化着的后台窗口点标题栏也该前置」，所以必须先调。
      //     `focus()` 内部只发新 z 号 + 同步任务栏/点击盾，无副作用，
      //     重复调用安全（拖拽过程中每次按下各调一次，与点内容区频率一致）。
      //
      //   ★ 一处修复覆盖两种窗口 ★
      //     资源管理器窗口（explorer.js）与预览窗口（WM.Toolbar.build）
      //     用的是**同一个** `.toolbar.win-toolbar[data-drag-handle]`，
      //     且都经由本函数绑定拖动，所以这里改一次两种窗口都生效。
      focus(state.id);

      // ★★★ 任何按钮/可交互控件上都必须放弃拖动 ★★★
      //
      //   需求（原文）：「文件窗口，除了最大化，最小化，关闭外，最顶上其他的
      //   按钮都失效了。」
      //
      //   根因（本行就是修复点）：
      //     旧代码只放过了 `.tb-btn`（= WM 自己的最小化/最大化/关闭三键），
      //     而文件夹窗口的业务按钮用的是 `.tbtn`（新建文件夹/上传/重命名/
      //     下载/删除/视图切换/排序/详细信息），**不匹配** `.tb-btn`。
      //     于是用户一点这些业务按钮：
      //       ① 走进本函数 → dragging = true，窗口开始被拖；
      //       ② 紧接着执行下面的 `e.preventDefault()`；
      //     而 `preventDefault()` 作用在 **pointerdown** 上时，会一并抑制
      //     浏览器默认的「由这次按下派生出 mousedown → click」链路，
      //     结果那些按钮的 click 监听**永远不触发** —— 表现为"按钮全失效"。
      //     三键因为命中 `.tb-btn` 提前 return 了，所以只有它们还能用，
      //     与用户描述完全一致。
      //
      //   修法：判据从「是不是 .tb-btn」放宽为「是不是按钮/控件」。
      //     用 closest 一次覆盖 button / [role=button] / 各类交互元素，
      //     这样将来工具栏再加新控件也不会重蹈覆辙。
      //
      //   为什么不能只靠 CSS pointer-events：工具栏是拖动区，必须能收到
      //     pointerdown 才能拖动，所以只能在**事件里**把控件挑出来排除。
      if (e.target.closest(
        'button, [role="button"], input, textarea, select, a, ' +
        '[contenteditable], [data-no-drag]')) return;

      if (state.maximized) return;      // 最大化时不拖

      dragging = true;
      pid = e.pointerId;
      sx = e.clientX; sy = e.clientY;
      // ★ 起点用真实小数几何，不用取整的 offsetLeft ★（见 _posOf 注释）
      const p = _posOf(state);
      ox = p.x; oy = p.y; ow = p.w; ohh = p.h;

      // ① 整屏遮罩：指针从此不可能落到 iframe 上
      _shieldOn('move');
      document.body.style.cursor = 'move';

      // ② 指针捕获：规范保证「被捕获元素收到全部指针事件，与位置无关」
      try { bar.setPointerCapture(pid); } catch (_) {}

      // touch/pen 需要 preventDefault 才不会触发滚动/长按菜单；
      // 鼠标上 preventDefault 同时抑制了默认的文本选择。
      if (e.cancelable) e.preventDefault();

      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
      bar.addEventListener('lostpointercapture', up);
    });
  }

  /* ------------------------------------------------------------------
     八向调整大小

     需求（原文）：「调整窗口大小应该是按住鼠标左键拖动。目前的模式操作比较麻烦。」

     原实现的问题：热区只有 5px，正好是一个很窄的边。鼠标必须精确压在那条线上
     才出现 resize 光标，实战中非常难命中（尤其触摸板 / 高分屏）。

     改法：
       - 边热区 EDGE（8px），角部 CORNER（12px）。
       - 角部**后插入**（dirs 里四角排在后面，且 appendChild 顺序即层叠顺序），
         所以在角附近按下时命中的是角手柄，可以斜向缩放 —— 符合直觉。
       - 视觉上窗口本身没变（热区是透明的），只是「更好抓」。
       - 热区**只覆盖最外圈**，内部照常点击。
       - 光标**延时显示**（RESIZE_HOVER_DELAY）：停稳了才变双箭头，
         避免鼠标擦过边缘时乱闪。详见下方 hover intent 说明。

     尺寸取舍见 §EDGE 处注释（5px 太薄 → 14/20 太宽 → 现取 8/12）。
     ------------------------------------------------------------------ */
  function _bindResize(state) {
    const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    const minW = state.opts.minWidth || 460;
    const minH = state.opts.minHeight || 320;

    // ★ 热区厚度 ★
    //
    //   历史（三次调整，方向来回，别再走错）：
    //     ① 最初 5px  —— 太薄，用户按不准，报「调整大小需要按住才能调」。
    //     ② 加到 14/20 —— 命中率上去了，但**又太宽**：
    //        用户原文（2026-09-21）：「感应范围太宽也太快。」
    //        预览/编辑窗口整块被 iframe 铺满，用户从内容区移向边栏、
    //        或只是想点窗口右上角附近的东西时，频繁误入热区 → 光标乱闪。
    //     ③ 现在收敛到 8/12 —— 折中：
    //        · 比最初的 5px 好抓（这是当初加宽的唯一原因，8px 已足够，
    //          实测下沿/侧边按下命中稳定）；
    //        · 又比 14/20 明显窄，「路过」不再频繁触发。
    //        再配合下面的 RESIZE_HOVER_DELAY 延时，双管齐下解决
    //        「太宽」（几何）与「太快」（时序）两个独立问题。
    //
    //   ★ 为什么敢比 14 窄：命中率问题的另一半已被延时解决了 ——
    //     光标不再"一碰就变"，用户不会因为光标闪而误判；
    //     真正要拖时，8px 的边在 100% 缩放下是 8 个物理像素，
    //     对准成本远低于最初的 5px。
    const EDGE = 8;       // 边热区厚度（14 → 8：用户反馈"太宽"）
    const CORNER = 12;    // 角热区边长（20 → 12：等比收敛）

    /* ★★★ 2026-09-21：热区**跨越边框**向外延伸 ★ —— 用户原文：
       「调整窗口 鼠标感应区域 以边框外边缘向左和向右偏移一定范围内都可激活。
         目前都是在窗口里面，这个要调整一下。」

       现象：热区原本用 `right:0 / left:0 / top:0 / bottom:0` 定位，
             **完全落在窗口内侧**。于是：
               · 鼠标停在边框**正上/正外**（视觉上就是那条边）时，不在热区内；
               · 用户必须"往窗口里挪一点"才激活，感觉像"感应区偏内"。
             这对**贴边摆放 / 贴着屏幕边缘**的窗口尤其难受（外侧根本没空间）。

       改法：把热区做成**跨边框**的 —— 向窗口外再延伸 OUT 像素：
               · 定位值从 `0` 改为 `-OUT`（即 left:-OUT / right:-OUT / top:-OUT / bottom:-OUT）
               · 尺寸由 `s` 改为 `s + OUT`（厚度 = 外侧 OUT + 内侧 s）
             于是边框线上、以及边框外侧 OUT 像素内**都能激活**，
             同时内侧厚度保持 EDGE/CORNER 不变，内侧手感不受影响。

       ★ 为什么外侧用 OUT=4px（而不是和内侧一样宽）★
         外侧热区会盖住窗口**外面**的区域，那里可能属于：
           · 别的窗口（抢了别人的边缘 → 那两个窗口的边缘都变得难抓）
           · 任务栏 / 桌面图标（挡住它们的点击）
         所以外侧必须**克制的窄**：4px 足够覆盖"贴着边框点"的手感，
         又不会明显侵占邻居。注意热区在 `state.el` 内，z-index:900 只是
         窗口自己的层叠上下文内层高，**不会**真的盖到别的窗口之上 ——
         别的窗口若 z 更高，它的边缘照常响应（这是对的，符合"谁在上面谁优先"）。

       ★ 与"周长零缝隙"的关系 ★
         所有热区同步外扩 OUT，边与角的**相邻关系不变**，
         所以让位规则（边让位用 CORNER）依旧成立、依旧零缝隙。
         该不变量由 _test_resize_hit.js §10/§17 守着（断言已按 OUT 同步更新）。
       ------------------------------------------------------------------ */
    const OUT = 4;        // 热区向窗口**外侧**延伸的像素数（向内仍为 EDGE/CORNER）

    /* ★★★ 2026-09-21：热区「延时显示」★ —— 用户原文：
       「调整窗口大小的这个 感应范围感觉太快了，同时是不是可以增加一下 延时显示。」

       现象：鼠标**擦过**窗口边缘（尤其预览/编辑窗口，整块被 iframe 铺满，
             指针从内容区移向边栏时必然穿过最外圈）时，光标立刻变成 ↔ 双箭头。
             用户只是路过，却以为「已经在调整大小了」，非常吵。

       根因：热区是真 DOM 元素，`cursor: X-resize` 写在 style 里，
             **鼠标一进入热区立刻生效** —— 没有停留判定，没有延时。

       改法（悬停意图判定 / hover intent）：
         1. 热区本身 `cursor: default`（CSS 里也同步声明，双保险）——
            不再「一碰就变」。
         2. 指针进入热区后**先起一个 RESIZE_HOVER_DELAY 的定时器**。
            只有停留满这么久，才把光标切成 X-resize 并在热区上标 `data-armed="1"`。
         3. 中途移出（pointerleave / pointerout）立刻清定时器 + 复位光标。
            指针在热区内**移动**不清定时器（否则手抖一下就永远等不满），
            但若移动到**另一个方向**的热区，则先撤销旧定时器再重新计时。
         4. 按下鼠标（pointerdown）时**无条件** armed ——
            延时只作用于「光标提示」，绝不能延迟用户真正的拖拽动作。
            即：急着拖的用户体感零延迟，只是不会在半路被光标闪到。

       为什么用 pointerenter/leave 而不是 mouseover/out：
         pointer 事件是同一套语义且触摸设备也支持，和本文件其它地方的
         pointerdown/move/up 保持一致；并且 pointerleave 不会像 mouseout
         那样在子元素间反复触发（本热区无子元素，但语义更干净）。
       ------------------------------------------------------------------ */
    // 用户补充（2026-09-21）：「感应范围太宽也太快。」
    //   → 几何那一半由 EDGE/CORNER 收敛解决（见上）；
    //   → 时序这一半由这个延时解决。用户说"太快"，故取 380ms
    //     （比 260ms 更"稳"，能明显滤掉鼠标路过；又短于人的耐心阈值，
    //      真正对准后不会觉得"光标怎么还不出现"）。
    const RESIZE_HOVER_DELAY = 380;   // ms：停留多久才显示 resize 光标

    /* 每个窗口一份悬停状态（含定时器 id + 当前已武装的方向） */
    const hover = { timer: 0, dir: null };

    const clearHover = () => {
      if (hover.timer) { clearTimeout(hover.timer); hover.timer = 0; }
      hover.dir = null;
    };
    /** 复位所有热区光标（DOM 可能已被 close 摘掉，故逐项判活） */
    const resetCursors = () => {
      dirs.forEach((d) => {
        const el = state.el.querySelector(`[data-resize="${d}"]`);
        if (el) { el.style.cursor = 'default'; if (el.dataset) el.dataset.armed = ''; }
      });
      document.body.style.cursor = '';
    };
    /** 立即武装某个方向（供 pointerdown 与定时器回调共用） */
    const armDir = (dir) => {
      const el = state.el.querySelector(`[data-resize="${dir}"]`);
      if (!el) return;
      el.style.cursor = `${dir}-resize`;
      if (el.dataset) el.dataset.armed = '1';
      document.body.style.cursor = `${dir}-resize`;
    };
    state._resizeHoverClear = clearHover;   // 供 close() 兜底摘除

    // ★★ 必须给右上角的「窗口三键」让位 ★★
    //
    //   需求（原文）：「不管是文件夹窗口还是预览和编辑窗口，右上角调整大小和
    //   关闭按钮有一定位置的冲突，导致关闭容易激发调整窗口大小功能。」
    //
    //   冲突成因（实测定位）：
    //     三键（— □ ×）静态排在工具栏最右，每个宽 34px、高 = --toolbar-h(29px)。
    //     而 ne 角热区是 `top:0; right:0; CORNER×CORNER`、z-index:900，
    //     e 边热区是 `right:0; top:CORNER; bottom:CORNER; width:EDGE`。
    //     于是右上角那块被 ne 热区**完全盖住**，而它正是 × 的右上部分；
    //     e 边热区又沿着右缘盖住三键右侧 EDGE 宽的一条。
    //     用户稍偏右上一点去点 ×，命中的就是 resize 手柄 → 窗口被拉大而不是关闭。
    //
    //   修法（双保险，两者配合）：
    //
    //     ① 【主】把三键层级抬到 resize 热区之上（CSS 里 .win-controls 用
    //        z-index:950 > 热区的 900）。这是**声明式**的保证：
    //        在两者重叠的右上角，命中的永远是按钮，不是热区。
    //        换句话说「关闭」从此不可能被解读成「调整大小」。
    //
    //     ② 【让位】再把 ne 角热区从三键区域**下方**开始（top = --toolbar-h），
    //        避免「用户本意想缩放却点到按钮」的反向误伤 ——
    //        顶部右角那一块现在属于按钮，缩放改从三键下沿开始。
    //
    //   为什么不干脆只做 ①：只抬层级能解决"关闭被误判为缩放"，
    //   但用户在右上角想**缩放**时仍会误触按钮（可能直接把窗口关了），
    //   所以两件事都要做。
    //
    //   为什么不干脆只做 ②：热区尺寸将来被调整时（历史上在 5 → 14/20 → 8/12
    //   之间改过几轮），层级保证仍在，不会再退化成旧 bug。
    //
    //   注意：n 边热区（top:0, height:EDGE）横跨顶部中间，那里是 tb-spacer /
    //   标题，不是按钮，故保留 —— 顶部仍然可以从中间拖高（符合 Windows 直觉）。
    //
    //   ★ 2026-09-21：不再为三键「挖空」n 条右端 ★
    //     挖了会在顶边制造一条抓不到的死区（详见下方几何注释）。
    //     改为让 n 条右端紧贴 ne 角，靠 CSS 的 z-index:950 保证三键优先命中。
    //     `windowControlsWidth()` 仍保留（诊断/将来需要时可用），
    //     但不再参与热区几何计算。

    dirs.forEach((dir) => {
      const h = document.createElement('div');
      h.dataset.resize = dir;
      const isCorner = dir.length === 2;
      const s = isCorner ? CORNER : EDGE;
      const css = {
        position: 'absolute',
        // ★ z-index 必须够高 ★
        //   预览/编辑窗口的内容是 iframe（replaced element，绘制顺序特殊）。
        //   5 虽然理论上已经高于静态兄弟，但窗口内部还可能存在
        //   sticky / absolute 的工具栏（如 .list-view thead 是 z-index:2、
        //   拖拽遮罩是 z-index:40）。为了「热区永远压在最上层」，
        //   直接给一个远高于窗口内部任何内容的数。
        //   注意：它仍在 .window 自己的层叠上下文内，不会盖住别的窗口。
        zIndex: 900,
        // ★ 2026-09-21：不再在这里写 `cursor: X-resize` ★
        //   写死会让「鼠标擦过边缘 → 光标瞬间变双箭头」，即用户说的
        //   「感应范围太快了」。改为 default，真正的 resize 光标由
        //   下面的悬停意图判定（停留 RESIZE_HOVER_DELAY 后）动态挂上。
        cursor: 'default',
      };
      // ★★★ 四条边 + 四个角必须**严丝合缝地铺满周长**，不留缝、不重复 ★★★
      //
      //   缝 = 抓不到 → 就是用户报的「调整窗口大小有 BUG」。
      //   重复 = 层叠顺序决定命中哪个方向 → 出现「想左右拉却变成上下拉」。
      //
      //   2026-09-21 实测复现（用 elementFromPoint 逐像素扫描真实窗口）：
      //     ① 顶边右侧约 110px 是死区：为给三键让位，n 条右端写了
      //        `calc(EDGE + 三键宽)`，但**让出的那块没有别的热区接住**，
      //        命中结果是 `win-body`（窗口内容）而不是 resize 手柄。
      //     ② 每条边两端各留 6px 缝：让位用的是边厚 `s`(=EDGE=14)，
      //        而角是 CORNER，CORNER>EDGE → 每条边两端 (CORNER-EDGE) 落空。
      //     ③ 左上角 x=left+1 也落空（n 从 left+14 才开始）。
      //
      //   修法：按「边厚用 EDGE、让位用 CORNER」两条独立规则拼装：
      //
      //        ┌──nw──┬──────────── n ────────────┬──ne──┐
      //        │      │   (left/right = CORNER)   │      │
      //        w      │                           │      e
      //        │      │                           │      │
      //        ├──────┴───────────────────────────┴──────┤
      //        │                  win-body                │
      //        ├──────┬───────────────────────────┬──────┤
      //        │      │                           │      │
      //        w      │                           │      e
      //        │      │                           │      │
      //        └──sw──┴──────────── s ────────────┴──se──┘
      //
      //   · n/s 横条：left/right 均为 CORNER（让开两侧的角）
      //   · e/w 竖条：top/bottom 均为 CORNER（让开上下两端的角）
      //   · 四角：一律 CORNER × CORNER，贴各自那个角
      //   于是「角 + 边 + 角」首尾相接，整条周长零缝隙。
      //
      //   右上角的特殊处理（ne）：三键（— □ ×）占了工具栏最右、高
      //   --toolbar-h。若 ne 仍贴 top:0，它会盖住 × 的右上角部分 ——
      //   用户点关闭却拉到窗口（这是本会话更早修的那个 bug）。
      //   所以 ne 纵向从 --toolbar-h 起；而 **n 条的右端紧贴 ne 角**，
      //   两者相接，顶边依然处处可抓。
      //   三键自身有 z-index:950 压在手柄的 900 之上，
      //   所以即便发生重叠，命中的也永远是按钮（CSS 双保险）。
      // ★ 跨边框定位的两个助手（详见函数顶部 OUT 的说明）★
      //   向外偏移：贴在窗口外沿**之外** OUT 像素
      const OUT_N = -OUT + 'px';
      //   跨边框尺寸：外 OUT + 内 len
      const span = (len) => (len + OUT) + 'px';

      // ---- 四条边：厚度用 EDGE（跨边框），让位用 CORNER ----
      //   以右缘为例（设窗口右沿 = win.right）：
      //     e 边是 `right: -OUT; width: span(EDGE)`
      //     → 右沿 = win.right + OUT   （外侧厚 OUT）
      //     → 左沿 = win.right + OUT - (EDGE + OUT) = win.right - EDGE（内侧厚 EDGE）
      //     ✅ 正好跨在边框线上：外侧 OUT、内侧 EDGE。
      //
      //   角同理：ne 角是 `right: -OUT; width: span(CORNER)`
      //     → 右沿 = win.right + OUT
      //     → 左沿 = win.right + OUT - (CORNER + OUT) = win.right - CORNER
      //
      //   ★★★ 关键：让位量是 CORNER，**不是** CORNER + OUT ★★★
      //     2026-09-21 实测踩过的坑（本函数刚改跨边框时引入，验算立刻抓到）：
      //       角是 "right:-OUT + 宽 CORNER+OUT"，所以它**向内只盖到**
      //       win.right - CORNER，外沿那 OUT 是往窗口**外面**去的。
      //       而 n/s 条是 `left/right: CLEAR` —— 它量的是「从窗口内沿往内让多少」，
      //       只需要让开角**在窗口内部**占的那 CORNER，不含外侧的 OUT。
      //       若写成 CORNER + OUT，n 条会再往中间缩 4px，
      //       于是角右沿(win.left+CORNER) 与 n 条左沿(win.left+CORNER+OUT)
      //       之间空出 **OUT=4px 的缝** → 那段边框抓不到
      //       （正是用户报过的"调整大小有 BUG"那类"缝"）。
      const CLEAR = CORNER + 'px';
      if (dir === 'n') {
        css.top = OUT_N; css.height = span(EDGE);
        css.left = CLEAR;
        /* ★ 右端**直达窗口右沿外 OUT**（= -OUT），2026-09-21 ★
           为什么 n 条可以不给 ne 让位：
             · ne 角纵向被下移到 toolbar-h 起（给三键让位），
               而 n 条在 y∈[-OUT, EDGE]，两者**纵向不重叠** ——
               n 条伸过去也不会压住 ne 角本身。
             · 伸过去的代价：n 条会盖住三键顶部那 12px（EDGE=8+OUT=4）。
               但三键有 z-index:950 > 手柄 900，命中的仍是按钮
               （CSS 双保险，见 app.css .win-controls 段）。
           收益（实测）：顶边 + 上外侧带**全域零缝隙**。
             若这里写 R-OUT（只到窗口右沿），顶边右上角会残留
             x∈[R-OUT, R] 的 4px 死角 —— 正是用户会去抓的那个角。
           注：左端仍用 CLEAR —— nw 角从 top:0 起，纵向**会**与 n 条重叠，
               必须让位（否则抢角部的斜向缩放）。 */
        css.right = OUT_N;
      } else if (dir === 's') {
        css.bottom = OUT_N; css.height = span(EDGE);
        css.left = CLEAR;
        css.right = CLEAR;
      } else if (dir === 'e') {
        css.right = OUT_N; css.width = span(EDGE);
        // 上端从 ne 角下沿接着开始（ne 纵向在 --toolbar-h 处，仍需外扩 OUT）
        css.top = `calc(var(--toolbar-h) + ${CLEAR})`;
        css.bottom = CLEAR;
      } else if (dir === 'w') {
        css.left = OUT_N; css.width = span(EDGE);
        css.top = CLEAR;
        css.bottom = CLEAR;
      }

      // ---- 四个角：一律 CORNER × CORNER（跨边框）----
      //   四角在 dirs 里排在四条边**之后**，appendChild 顺序 = 层叠顺序，
      //   所以角附近按下时命中的是角（可斜向缩放），符合直觉。
      if (dir === 'nw') {
        css.left = OUT_N; css.top = OUT_N;
        css.width = span(CORNER); css.height = span(CORNER);
      } else if (dir === 'ne') {
        css.right = OUT_N;
        // ★ 纵向从工具栏下沿起，给右上角三键让位（这是"关闭键不被抢"的关键）
        //   仍是"下移到工具栏下沿"，不额外外扩（外扩会盖回三键）
        css.top = 'var(--toolbar-h)';
        css.width = span(CORNER); css.height = span(CORNER);
      } else if (dir === 'sw') {
        css.left = OUT_N; css.bottom = OUT_N;
        css.width = span(CORNER); css.height = span(CORNER);
      } else if (dir === 'se') {
        css.right = OUT_N; css.bottom = OUT_N;
        css.width = span(CORNER); css.height = span(CORNER);
      }
      Object.assign(h.style, css);
      state.el.appendChild(h);

      /* ★ 悬停意图：停留满 RESIZE_HOVER_DELAY 才显示 resize 光标 ★
         详见函数顶部 hover intent 说明。
         - 进入 → 起定时器
         - 移动 → **不重置**延时（否则手抖永远等不满），但若已武装就保持不变
         - 离开 → 立刻撤销
         - 按下 → 无条件武装（延时只影响光标提示，不影响拖拽本身） */
      h.addEventListener('pointerenter', () => {
        clearHover();
        hover.dir = dir;
        hover.timer = setTimeout(() => {
          hover.timer = 0;
          // 定时器到点时热区可能已被移除 / 窗口已最大化
          if (!state.el.querySelector(`[data-resize="${dir}"]`)) return;
          if (state.maximized) return;
          armDir(dir);
        }, RESIZE_HOVER_DELAY);
      });
      h.addEventListener('pointerleave', () => {
        clearHover();
        const el = state.el.querySelector(`[data-resize="${dir}"]`);
        if (el) { el.style.cursor = 'default'; if (el.dataset) el.dataset.armed = ''; }
        if (!state._resizing) document.body.style.cursor = '';
      });

      h.addEventListener('pointerdown', (e) => {
        if (state.maximized || e.button !== 0) return;

        // ★ 缩放热区上的按下同样要前置窗口 ★
        //   与 _bindDrag 完全同一个根因：下面会 `e.preventDefault()`（还要
        //   stopPropagation 以防触发拖动），于是浏览器不再派生 mousedown，
        //   而置顶监听恰好挂在 mousedown 上 → 拉后台窗口的边框不会把它提上来。
        //   热区是 `.window` 的直接子元素、不在工具栏里，所以工具栏那处修复
        //   覆盖不到它，必须在这里单独补一次。
        focus(state.id);

        if (e.cancelable) e.preventDefault();
        e.stopPropagation();

        // ★ 真按下 → 立刻武装光标，不等延时（延时只服务"预告"，不该拖慢操作）★
        clearHover();
        armDir(dir);
        state._resizing = true;
        const pid = e.pointerId;
        const sx = e.clientX, sy = e.clientY;
        // ★ 用真实小数几何（getBoundingClientRect）而非取整的 offsetLeft ★
        //   理由同拖动：resize 会把 style.left 写成非整数，随后再用
        //   offsetLeft 当基准就会周期性吃掉不到 1px，累积后表现为
        //   「位置对不齐 / 越拖越偏」。
        const p = _posOf(state);
        const r = { x: p.x, y: p.y, w: p.w, h: p.h };

        // ★ 同 _bindDrag：遮罩 + 指针捕获，防止指针落到 iframe 上丢事件 ★
        //   resize 时指针贴在最外圈，理论上比拖动安全；但把窗口缩到很小
        //   再斜拉、或在高 DPI 下指针与边缘有半像素错位时，指针仍可能
        //   压到 iframe 上。这里统一处理，不再依赖运气。
        _shieldOn(`${dir}-resize`);
        document.body.style.cursor = `${dir}-resize`;
        try { h.setPointerCapture(pid); } catch (_) {}

        const move = (ev) => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          let { x, y, w, h: hh } = r;

          if (dir.includes('e')) w = Math.max(minW, r.w + dx);
          if (dir.includes('s')) hh = Math.max(minH, r.h + dy);
          if (dir.includes('w')) {
            w = Math.max(minW, r.w - dx);
            x = r.x + (r.w - w);
          }
          if (dir.includes('n')) {
            hh = Math.max(minH, r.h - dy);
            y = r.y + (r.h - hh);
          }

          const rw = Math.round(w), rh = Math.round(hh);
          const rx = Math.round(x),  ry = Math.round(y);
          Object.assign(state.el.style, {
            left: rx + 'px', top: ry + 'px',
            width: rw + 'px', height: rh + 'px',
          });
          state.opts.onResize && state.opts.onResize(state);
        };
        const up = () => {
          state._resizing = false;
          clearHover();
          resetCursors();
          _shieldOff();
          try { if (h.hasPointerCapture(pid)) h.releasePointerCapture(pid); } catch (_) {}
          h.removeEventListener('pointermove', move);
          h.removeEventListener('pointerup', up);
          h.removeEventListener('pointercancel', up);
          h.removeEventListener('lostpointercapture', up);
          state.opts.onResize && state.opts.onResize(state);
        };
        state._resizeUp = up;   // 供 close() 兜底摘除
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up);
        h.addEventListener('pointercancel', up);
        h.addEventListener('lostpointercapture', up);
      });
    });
  }

  /* ------------------------------------------------------------------
     状态切换
     ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------
     层级 / 激活

     ★ 需求（原文）：「切换窗口时，当前窗口被其他窗口遮挡住了。」★

     根因（原来是这么写的）：
         if (w.el.style.zIndex != zTop) w.el.style.zIndex = ++zTop;
     `zTop` 只增不减，而 `zIndex` 是**字符串**比较。一旦某个窗口的
     zIndex 恰好等于当前 zTop，就会被判定为「已经是最顶层」而**跳过提升**。
     触发场景很明确：任务栏点已是最顶的窗口 → 先 minimize（zIndex 不变），
     再点回来 → restore → focus，此时它的 zIndex 仍是 zTop，
     于是**不提升**；可它现在是 display:none 刚恢复，视觉上却排在别的
     窗口下面 —— 用户看到的就是「点了没反应 / 被挡住」。

     修法：不看旧值，**每次激活都发一个新号**（`_raise()`）。
     窗口数量是几十级别，zTop 涨到几千完全无所谓；换来的是「激活必然置顶」
     这个简单可证的语义。想省的那点样式写入不值得为它引入一个
     只在特定点击序列下才复现的 bug。
     ------------------------------------------------------------------ */
  function _raise(w) {
    w.el.style.zIndex = ++zTop;
  }

  function focus(id) {
    const w = windows.get(id);
    if (!w) return;
    _raise(w);
    windows.forEach((x) => x.el.classList.toggle('focused', x.id === id));
    w.opts.onFocus && w.opts.onFocus(w);
    _syncTaskbar();
    // ★ 置顶格局变了 → 重算 iframe 点击盾 ★
    //   刚上来的 iframe 窗口撤盾（内容可交互），
    //   被压下去的 iframe 窗口挂盾（下一次点它任意位置都能再上来）。
    _syncAllShields();
  }

  function minimize(id) {
    const w = windows.get(id);
    if (!w) return;
    w.minimized = true;
    w.el.classList.add('minimized');
    _syncTaskbar();
    // 最顶层可能换人了 → 重算盾
    _syncAllShields();
  }

  function restore(id) {
    const w = windows.get(id);
    if (!w) return;
    w.minimized = false;
    w.el.classList.remove('minimized');
    focus(id);
  }

  function toggleMax(id) {
    const w = windows.get(id);
    if (!w || w.opts.maximizable === false) return;

    if (!w.maximized) {
      // 记住当前几何
      w.restoreRect = {
        x: w.el.offsetLeft, y: w.el.offsetTop,
        w: w.el.offsetWidth, h: w.el.offsetHeight,
      };
      w.maximized = true;
      w.el.classList.add('maximized');
      Object.assign(w.el.style, {
        left: '0px', top: '0px',
        width: '100%', height: `calc(100% - var(--taskbar-h))`,
      });
      w.el.querySelector('.tb-btn.max') && (w.el.querySelector('.tb-btn.max').innerHTML = Icons.ui('restore'));
    } else {
      w.maximized = false;
      w.el.classList.remove('maximized');
      const r = w.restoreRect;
      Object.assign(w.el.style, {
        left: r.x + 'px', top: r.y + 'px',
        width: r.w + 'px', height: r.h + 'px',
      });
      w.el.querySelector('.tb-btn.max') && (w.el.querySelector('.tb-btn.max').innerHTML = Icons.ui('max'));
    }
    const mb = w.el.querySelector('.tb-btn.max');
    if (mb) mb.title = w.maximized ? '向下还原' : '最大化';
    w.opts.onResize && w.opts.onResize(w);
  }

  function close(id) {
    const w = windows.get(id);
    if (!w) return;
    // 关闭前钩子可以返回 false 阻止关闭（用于「有未保存内容」的场景）
    if (w.opts.onClose && w.opts.onClose(w) === false) return;

    // iframe 焦点监听是挂在 document / iframe.window 上的，
    // 窗口销毁时必须摘掉，否则会攒下一堆指向已关闭窗口的监听器。
    _unbindIframeFocus(w);

    // ★ 若关闭发生在拖动/缩放中途（例如快捷键关窗、或拖到一半点了 ×），
    //   必须把进行中的手势收尾：摘掉 pointer 监听、释放指针捕获、
    //   并撤掉整屏遮罩 —— 否则遮罩会永远留着，把整个桌面的点击都吃掉。
    try { w._dragUp && w._dragUp(); } catch (_) {}
    try { w._resizeUp && w._resizeUp(); } catch (_) {}
    // ★ 悬停意图定时器也要清掉：窗口可能在「鼠标停在边缘等着变光标」的
    //   那一刻被关掉，若让它自然到期，回调会去 querySelector 一个已摘除的
    //   热区（虽然已判活，但白跑一次定时器没必要），且光标状态要立刻复位。
    try { w._resizeHoverClear && w._resizeHoverClear(); } catch (_) {}
    w._resizing = false;
    try { if (_shield) { _shieldCount = 0; _shield.classList.remove('on'); } } catch (_) {}
    document.body.style.userSelect = '';
    document.body.style.cursor = '';

    w.el.classList.add('closing');
    const remove = () => {
      w.el.remove();
      windows.delete(id);
      _syncTaskbar();
      // 最顶层可能换人了 → 重算其余 iframe 窗口的盾
      _syncAllShields();
    };
    // 等动画跑完再摘 DOM，否则会有跳变
    w.el.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 260);   // 兜底：动画事件偶尔不触发
  }

  function closeAll() {
    [...windows.keys()].forEach(close);
  }

  /* ----------------------------------------------------------------------
     reopen —— 在原地重开一个窗口（换内容不换窗口）★
     ----------------------------------------------------------------------
     需求（原文）：「在预览窗口，增加可以切换上一个和下一个文件。
     这样的预览和编辑 不单独打开窗口。」

     为什么要这个原语：
       切换上一个/下一个文件时，若直接 WM.close + WM.open，
       用户会看到窗口先「关掉动画」再「弹出动画」——
       位置、大小、任务栏按钮全都重置一遍，与「翻页」的体感完全不符。
       看图片的上一张/下一张是**同一个视口里换内容**，不是新开窗口。

     语义：
       · 保留窗口的**几何**（left/top/width/height）与最大/最小化状态；
       · 保留**层叠位置**（zIndex 不动，不重新置顶也不下沉）；
       · 用新的 opts 替换旧的（title / icon / render 等），
         并按新 opts 重新渲染 body 与重新绑定事件；
       · 旧的 iframe 焦点监听、拖动/缩放回调先摘干净，避免泄漏与串扰。

     注意：这里**不走** close() 的动画与 remove()，DOM 节点原地复用，
     所以不会闪、不会丢几何。
     ---------------------------------------------------------------------- */
  function reopen(id, newOpts) {
    const w = windows.get(id);
    if (!w) return null;

    // 1) 摘掉旧的 iframe 焦点监听（它挂在 document / 旧 iframe.window 上）
    _unbindIframeFocus(w);

    // 2) 收尾进行中的手势（与 close() 同理，避免遮罩残留）
    try { w._dragUp && w._dragUp(); } catch (_) {}
    try { w._resizeUp && w._resizeUp(); } catch (_) {}
    // ★ 无条件清掉遮罩 ★
    //   _dragUp/_resizeUp 内部会调 _shieldOff()，但那只是**减一**；
    //   如果计数因为历史手势泄漏已经 >0，减一仍 >0 → 遮罩留着 →
    //   切换文件后整个桌面点不动。这里与 close() 一样强制归零。
    _shieldForceOff();

    // 3) 合并 opts：新值覆盖旧值，但保留几何相关字段
    const el = w.el;
    const merged = Object.assign({}, w.opts, newOpts || {});
    w.opts = merged;

    // 4) 重建外壳（titlebar 可能从有到无/从无到有）
    const prev = {
      left: el.style.left, top: el.style.top,
      width: el.style.width, height: el.style.height,
      zIndex: el.style.zIndex,
    };
    el.innerHTML = `
      ${merged.chromeless ? '' : `<div class="titlebar" data-role="titlebar">
        <span class="tb-icon">${merged.icon || Icons.ui('file', 16)}</span>
        <span class="tb-title">${esc(merged.title || '')}</span>
        <div class="tb-controls">
          <button class="tb-btn" data-act="min" title="最小化">${Icons.ui('min')}</button>
          <button class="tb-btn max" data-act="max" title="最大化">${Icons.ui('max')}</button>
          <button class="tb-btn close" data-act="close" title="关闭">${Icons.ui('close')}</button>
        </div>
      </div>`}
      <div class="win-body" data-role="body"></div>
    `;
    // 还原几何（innerHTML 不会动 style，但显式写回更稳妥）
    Object.assign(el.style, prev);

    const bodyEl = el.querySelector('[data-role="body"]');
    w.bodyEl = bodyEl;

    // 5) 重新渲染内容
    try {
      merged.render && merged.render(bodyEl, w);
    } catch (e) {
      console.error(`[wm] 窗口 ${id} 重渲染失败`, e);
      bodyEl.innerHTML = `<div class="state-box">
        <div class="sb-title">界面加载失败</div>
        <div class="sb-hint">${esc(String(e && e.message || e))}</div>
      </div>`;
    }

    // 6) 重新绑定事件（_bindControls / _bindResize / _bindDrag 都是幂等的：
    //    它们只往**新创建**的 DOM 节点上挂监听，旧节点已随 innerHTML 丢弃）
    _bindControls(w);
    if (merged.resizable !== false) _bindResize(w);
    _bindDrag(w);

    el.addEventListener('mousedown', () => focus(id), true);
    if (!merged.noIframeFocus) _bindIframeFocus(w);

    if (w.maximized) {
      // 最大化状态下重开：几何要维持「铺满」，只刷新按钮图标。
      // 这里**不调用 toggleMax**（连调两次既绕又容易在中间态出错），
      // 直接按最大化的定义重新写一遍几何。
      w.el.classList.add('maximized');
      Object.assign(el.style, {
        left: '0px', top: '0px',
        width: '100%', height: 'calc(100% - var(--taskbar-h))',
      });
      const mb = el.querySelector('.tb-btn.max');
      if (mb) { mb.innerHTML = Icons.ui('restore'); mb.title = '向下还原'; }
      merged.onResize && merged.onResize(w);
    }

    _syncTaskbar();
    return w;
  }

  function get(id) { return windows.get(id); }
  function list() { return [...windows.values()]; }

  function setTitle(id, title) {
    const w = windows.get(id);
    if (!w) return;
    // chromeless 窗口没有 .tb-title，标题只体现在任务栏，不能直接赋值
    const t = w.el.querySelector('.tb-title');
    if (t) t.textContent = title;
    if (w.opts) w.opts.title = title;
    _syncTaskbar();
  }

  /* ------------------------------------------------------------------
     任务栏同步
     ------------------------------------------------------------------ */
  function _syncTaskbar() {
    const bar = document.getElementById('tb-apps');
    if (!bar) return;

    const byId = new Map(list().map((w) => [w.id, w]));
    const topId = topWindowId();

    // 移除已关闭的按钮
    [...bar.querySelectorAll('.tb-app[data-win]')].forEach((b) => {
      if (!byId.has(b.dataset.win)) b.remove();
    });

    // 增改
    byId.forEach((w) => {
      let btn = bar.querySelector(`.tb-app[data-win="${w.id}"]`);
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'tb-app';
        btn.dataset.win = w.id;
        btn.innerHTML = `${w.opts.icon || Icons.app(22)}<span class="indicator"></span>`;
        btn.title = w.opts.title || '';
        btn.addEventListener('click', () => {
          const cur = windows.get(w.id);
          if (!cur) return;
          // ★★ 必须在**点击时**重新判断当前最顶层，不能用绑定时捕获的 topId ★★
          //
          //   需求（原文）：「点击窗口任务栏，可以让窗口显示到最前面。
          //   每个窗口都一样，包括预览和编辑的窗口。」
          //
          //   旧 bug：`topId` 是在 _syncTaskbar() 里算好的，而 click 回调
          //   通过闭包把它**冻住**了。之后用户点了别的窗口让层级变了，
          //   这个按钮里记的还是老的 topId → 分支判断全错，
          //   表现为「点了任务栏没反应 / 反而最小化了」。
          //
          //   另一个 bug：旧逻辑「已激活就最小化」。
          //   但用户要的是「点到最前面」——窗口被别的窗口挡住时，
          //   它并不是 minimized，却不在最前；这时必须**置顶**，
          //   只有**已经处于最前**再点，才按 Windows 习惯最小化。
          if (cur.minimized) {
            restore(cur.id);                       // 最小化中 → 还原并置顶
          } else if (cur.id === topWindowId()) {
            minimize(cur.id);                      // 已在最前 → 最小化（Windows 习惯）
          } else {
            focus(cur.id);                         // 被别的窗口挡住 → 置顶
          }
        });
        bar.appendChild(btn);
      }
      btn.classList.add('running');
      btn.classList.toggle('active', !w.minimized && w.id === topId);
      btn.title = w.opts.title || '';
    });
  }

  /** 当前可见窗口里 zIndex 最大的那个（任务栏 active 态与点击判定共用） */
  function topWindowId() {
    let id = null, z = -Infinity;
    list().forEach((w) => {
      if (w.minimized) return;
      const zz = parseInt(w.el.style.zIndex || '0', 10);
      if (zz >= z) { z = zz; id = w.id; }
    });
    return id;
  }

  return {
    open, close, closeAll, focus, minimize, restore, toggleMax,
    reopen,    // 原地换内容（预览窗口切换上一个/下一个文件用）
    get, list, setTitle,
    Toolbar,   // 统一工具栏工厂（所有窗口共用，保证布局一致）
  };
})();


/* ==========================================================================
   右键菜单
   ========================================================================== */
const ContextMenu = (() => {
  let el = null;

  function ensure() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ctx-menu';
    document.body.appendChild(el);

    // 点空白 / 滚动 / Esc 都关掉
    document.addEventListener('mousedown', (e) => {
      if (!el.classList.contains('open')) return;
      if (!el.contains(e.target)) close();
    }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return el;
  }

  /**
   * items: [{ label, icon, accel, danger, disabled, onClick } | { sep: true }]
   */
  function show(x, y, items) {
    ensure();
    el.innerHTML = items.map((it, i) => {
      if (it.sep) return '<div class="ctx-sep"></div>';
      const cls = ['ctx-item'];
      if (it.danger) cls.push('danger');
      if (it.disabled) cls.push('disabled');
      return `<div class="${cls.join(' ')}" data-i="${i}">
        <span style="width:15px;flex:0 0 15px;display:grid;place-items:center">${it.icon ? Icons.ui(it.icon, 15) : ''}</span>
        <span class="ci-label">${esc(it.label)}</span>
        ${it.accel ? `<span class="ci-accel">${esc(it.accel)}</span>` : ''}
      </div>`;
    }).join('');

    el.querySelectorAll('.ctx-item').forEach((node) => {
      const it = items[+node.dataset.i];
      if (it.disabled) return;
      node.addEventListener('click', () => {
        close();
        try { it.onClick && it.onClick(); }
        catch (e) { console.error('[ctx] 菜单动作失败', e); Toast.error(e.message || String(e)); }
      });
    });

    // 先显示再量尺寸，这样才能正确翻转
    el.style.left = '-9999px';
    el.style.top = '-9999px';
    el.classList.add('open');

    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let px = x, py = y;
    if (px + r.width > vw - 8) px = Math.max(8, vw - r.width - 8);
    if (py + r.height > vh - 8) py = Math.max(8, vh - r.height - 8);
    el.style.left = px + 'px';
    el.style.top = py + 'px';
    // 从点击点展开的方向要对
    el.style.transformOrigin = (x + r.width > vw - 8 ? 'right' : 'left') + ' top';
  }

  function close() {
    if (el) el.classList.remove('open');
  }

  return { show, close };
})();


/* ==========================================================================
   Toast 通知
   ========================================================================== */
const Toast = (() => {
  function show(title, msg, kind, ms = 3600) {
    const box = document.getElementById('toasts');
    if (!box) return;

    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.innerHTML = `<div class="t-title">${esc(title)}</div>
      ${msg ? `<div class="t-msg">${esc(msg)}</div>` : ''}`;
    box.appendChild(el);

    const kill = () => {
      el.classList.add('out');
      el.addEventListener('animationend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 400);
    };
    el.addEventListener('click', kill);
    setTimeout(kill, ms);
  }

  return {
    info:  (t, m) => show(t, m, ''),
    ok:    (t, m) => show(t, m, 'ok'),
    error: (t, m) => show(t, m, 'err', 5200),
  };
})();


/* ==========================================================================
   对话框
   ========================================================================== */
const Dialog = (() => {

  /** 通用确认框。返回 Promise<boolean> */
  function confirm(opts) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      const danger = opts.danger;

      mask.innerHTML = `
        <div class="dialog" role="dialog">
          <div class="dlg-head">${esc(opts.title || '确认')}</div>
          <div class="dlg-body">
            <div>${esc(opts.message || '')}</div>
            ${opts.html || ''}
          </div>
          <div class="dlg-foot">
            <button class="btn" data-r="0">${esc(opts.cancelText || '取消')}</button>
            <button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">
              ${esc(opts.okText || '确定')}
            </button>
          </div>
        </div>`;

      document.body.appendChild(mask);
      requestAnimationFrame(() => mask.classList.add('open'));

      const done = (v) => {
        mask.classList.remove('open');
        setTimeout(() => mask.remove(), 220);
        resolve(v);
      };
      mask.querySelector('[data-r="0"]').addEventListener('click', () => done(false));
      mask.querySelector('[data-r="1"]').addEventListener('click', () => done(true));
      mask.addEventListener('mousedown', (e) => { if (e.target === mask) done(false); });

      const onKey = (e) => {
        if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); done(false); }
        if (e.key === 'Enter') { document.removeEventListener('keydown', onKey); done(true); }
      };
      document.addEventListener('keydown', onKey);
      setTimeout(() => mask.querySelector('[data-r="1"]').focus(), 60);
    });
  }

  /** 输入框。返回 Promise<string|null> */
  function prompt(opts) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `
        <div class="dialog">
          <div class="dlg-head">${esc(opts.title || '输入')}</div>
          <div class="dlg-body">
            ${opts.message ? `<div>${esc(opts.message)}</div>` : ''}
            <div class="field">
              <input type="text" data-role="input" value="${esc(opts.value || '')}"
                     placeholder="${esc(opts.placeholder || '')}">
              ${opts.hint ? `<div class="hint">${esc(opts.hint)}</div>` : ''}
            </div>
            <div class="login-err" data-role="err"></div>
          </div>
          <div class="dlg-foot">
            <button class="btn" data-r="0">取消</button>
            <button class="btn primary" data-r="1">${esc(opts.okText || '确定')}</button>
          </div>
        </div>`;

      document.body.appendChild(mask);
      requestAnimationFrame(() => mask.classList.add('open'));

      const input = mask.querySelector('[data-role="input"]');
      setTimeout(() => {
        input.focus();
        // 改名场景：只选中主文件名，不选扩展名（Windows 习惯）
        if (opts.selectBase && input.value.includes('.')) {
          const i = input.value.lastIndexOf('.');
          input.setSelectionRange(0, i);
        } else {
          input.select();
        }
      }, 60);

      const done = (v) => {
        mask.classList.remove('open');
        setTimeout(() => mask.remove(), 220);
        resolve(v);
      };
      const commit = () => {
        const v = input.value.trim();
        if (!v) {
          const e = mask.querySelector('[data-role="err"]');
          e.textContent = '不能为空';
          e.classList.add('show');
          return;
        }
        done(v);
      };
      mask.querySelector('[data-r="0"]').addEventListener('click', () => done(null));
      mask.querySelector('[data-r="1"]').addEventListener('click', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') done(null);
      });
      mask.addEventListener('mousedown', (e) => { if (e.target === mask) done(null); });
    });
  }

  /** 自定义内容弹窗，返回 { el, close } */
  function custom(opts) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="dialog ${opts.wide ? 'wide' : ''}">
        ${opts.title ? `<div class="dlg-head">${esc(opts.title)}</div>` : ''}
        <div class="dlg-body" data-role="content"></div>
        ${opts.footer === false ? '' : `<div class="dlg-foot" data-role="foot"></div>`}
      </div>`;
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('open'));

    const close = () => {
      mask.classList.remove('open');
      setTimeout(() => mask.remove(), 220);
    };
    mask.addEventListener('mousedown', (e) => { if (e.target === mask && opts.maskClose !== false) close(); });
    return {
      el: mask.querySelector('[data-role="content"]'),
      foot: mask.querySelector('[data-role="foot"]'),
      mask, close,
    };
  }

  return { confirm, prompt, custom };
})();


/* ==========================================================================
   通用小工具
   ========================================================================== */
/** HTML 转义 —— 所有插进 innerHTML 的用户数据都必须过这一层 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 字节数格式化（Windows 习惯：KB/MB/GB，1024 进制） */
function fmtSize(n) {
  if (n == null || n === 0) return '0 KB';
  if (n < 1024) return n + ' 字节';
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  // Windows 对 KB 显示整数，往上保留一位小数
  return (i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
}

/** 时间格式化（今天/昨天用相对描述，更贴近资源管理器） */
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  if (sameDay(d, now)) return `今天 ${hm}`;
  const y = new Date(now.getTime() - 86400000);
  if (sameDay(d, y)) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear())
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hm}`;
}

/** 完整时间（属性面板用） */
function fmtTimeFull(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 依赖文件名的扩展名 → 中文类型名 */
function typeName(entry) {
  if (!entry) return '';
  if (entry.isDir) return '文件夹';
  const map = {
    doc: 'Word 文档', docx: 'Word 文档', xls: 'Excel 工作表', xlsx: 'Excel 工作表',
    ppt: 'PowerPoint 演示文稿', pptx: 'PowerPoint 演示文稿',
    pdf: 'PDF 文档', txt: '文本文档', md: 'Markdown 文档',
    png: 'PNG 图片', jpg: 'JPEG 图片', jpeg: 'JPEG 图片', gif: 'GIF 图片',
    zip: '压缩文件夹', rar: '压缩文件', '7z': '压缩文件',
    mp4: 'MP4 视频', mp3: 'MP3 音频',
  };
  const e = (entry.ext || '').toLowerCase();
  if (map[e]) return map[e];
  if (e) return `${e.toUpperCase()} 文件`;
  return '文件';
}

/** 简易防抖 */
function debounce(fn, ms) {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** 节流（拖拽、滚动场景） */
function throttle(fn, ms) {
  let last = 0, timer = null;
  return (...a) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...a); }
    else {
      clearTimeout(timer);
      timer = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (now - last));
    }
  };
}
