/* ==========================================================================
   NebulaDisk —— 应用入口
   --------------------------------------------------------------------------
   职责：
     1. 登录页 → 拉取用户信息 → 进入桌面
     2. 渲染桌面图标、任务栏、开始菜单、时钟
     3. 桌面右键菜单、壁纸、主题
     4. 全局快捷键
     5. 会话过期统一回登录页
   ========================================================================== */

const App = {
  me: null,          // /api/me 的结果
  booted: false,
};

/**
 * 产品版本号（「关于本机」显示用）。
 * ★ 与 nebula/web 一起发布，因此改版本时改这里即可 ★
 * 之所以不写成从后端拉取：版本是**前端资源**的属性，后端没有这个概念，
 * 硬编一个常量比让后端多返回一个字段更简单也更准。
 */
const APP_VERSION = '1.0.0';

/* ==========================================================================
   启动
   ========================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  applyStoredTheme();
  ViewerBoot.startClock();

  // 会话过期 → 弹回登录页（不刷新页面，保留用户输入）
  API.setUnauthorizedHandler(() => {
    if (!App.booted) return;           // 登录页本身的 401 不算
    App.booted = false;
    showLogin();
    Toast.info('会话已过期', '请重新登录');
  });

  // 先探一次会话：已登录就直接进桌面，避免闪一下登录页
  try {
    const me = await API.me();
    enterDesktop(me);
  } catch {
    showLogin();
  }

  document.getElementById('boot').classList.add('hide');
  setTimeout(() => {
    const b = document.getElementById('boot');
    if (b) b.remove();
  }, 400);
});


/* ==========================================================================
   登录
   ========================================================================== */
function showLogin() {
  const scr = document.getElementById('login-screen');
  scr.classList.remove('hide');

  const form = document.getElementById('login-form');
  // 避免重复绑定（会话过期会二次进入）
  form.onsubmit = async (e) => {
    e.preventDefault();
    const u = form.querySelector('[name="username"]').value.trim();
    const p = form.querySelector('[name="password"]').value;
    const errEl = document.getElementById('login-err');
    const btn = form.querySelector('button[type=submit]');

    errEl.classList.remove('show');
    if (!u || !p) {
      errEl.textContent = '请输入用户名和密码';
      errEl.classList.add('show');
      return;
    }

    btn.disabled = true;
    btn.textContent = '正在登录…';
    try {
      await API.login(u, p);
    } catch (err) {
      // 只有「认证失败」才提示用户名/密码问题
      errEl.textContent = err.message || '登录失败';
      errEl.classList.add('show');
      form.querySelector('[name="password"]').select();
      btn.disabled = false;
      btn.textContent = '登录';
      return;
    }

    // ★ 登录成功后再拉用户信息、进桌面。这两步与认证无关，
    //   必须放在**认证的 try/catch 之外**：否则 enterDesktop() 里任何
    //   UI 异常（例如某个已被移除的 DOM 节点）都会被当成「登录失败」，
    //   把「服务端已登录成功」的事实盖掉，前端卡在登录页，极难排查。
    try {
      const me = await API.me();
      enterDesktop(me);
      form.reset();
    } catch (err) {
      console.error('[nebula] 登录后初始化桌面失败:', err);
      errEl.textContent = '登录成功，但桌面初始化失败，请刷新页面重试';
      errEl.classList.add('show');
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  };

  setTimeout(() => {
    const inp = form.querySelector('[name="username"]');
    if (inp && !inp.value) inp.focus();
  }, 120);
}


/* ==========================================================================
   进入桌面
   ========================================================================== */
function enterDesktop(me) {
  App.me = me;
  App.booted = true;

  document.getElementById('login-screen').classList.add('hide');
  document.getElementById('desktop').style.display = '';

  document.title = me.title || 'NebulaDisk';
  document.querySelectorAll('[data-role="brand"]').forEach((n) => {
    n.textContent = me.title || 'NebulaDisk';
  });

  renderDesktopIcons(me);
  renderStartUser(me);
  ViewerBoot.setWallpaper();

  // ★ 初始界面不自动打开任何文件夹 ★
  //   用户明确要求：进入桌面后停留在桌面本身，由用户双击「此电脑」或
  //   某个映射目录再打开窗口。之前这里会在 180ms 后自动 open(mounts[0])，
  //   导致一进来就弹出一个资源管理器窗口、把桌面盖住，体验上像「被劫持」。
  // ★ 任务③深链：带 ?mount=&path= 进来时直接打开那个目录 ★
  //   注意：下面这行必须放在 enterDesktop() 的**收尾大括号之前**。
  //   本函数的收尾大括号由下面 reproduce 的 anchor 提供（anchor 里含 `}`）。
  applyDeepLink(me);
}

/** 读取 URL 上的 ?mount=&path= 并打开对应目录（任务③）
 *
 *  设计要点：
 *    · 只认 mount/path 两个键，其它参数忽略
 *    · mount 必须在当前用户可见的映射里，否则静默忽略（防注入）
 *    · path 归一化：反斜杠转正斜杠、补前导 /
 *    · 处理完立即 replaceState 清 query，刷新不会重复跳转
 */
function applyDeepLink(me) {
  let sp;
  try {
    sp = new URLSearchParams(location.search);
  } catch (e) {
    return;
  }

  const rawMount = (sp.get('mount') || '').trim();
  const rawPath = (sp.get('path') || '').trim();
  if (!rawMount && !rawPath) return;

  // 清 URL：只留 origin+pathname，避免刷新重跳 / 误分享
  try {
    history.replaceState(null, '', location.pathname);
  } catch (e) { /* 某些沙箱禁写 history，忽略 */ }

  if (!rawMount) return;

  // ★ 映射白名单校验 ★
  //   mounts 是 /api/me 返回的数组，元素形如 { label, writable }。
  //   用户可能带着一个已失效/手改过的盘名进来，直接放行会让
  //   Explorer.open() 拿到一个空窗口并抛错。
  const mounts = (me && me.mounts) || [];
  const hit = mounts.find(function (m) { return m && m.label === rawMount; });
  if (!hit) {
    console.warn('[nebula] 深链：未知映射「' + rawMount + '」，忽略');
    return;
  }

  // 归一化目录路径
  let p = rawPath.replace(/\\/g, '/');
  if (!p) p = '/';
  if (p.charAt(0) !== '/') p = '/' + p;
  p = p.replace(/\/{2,}/g, '/');

  // 等本帧渲染完再开窗（见文件头说明）
  setTimeout(function () {
    try {
      Explorer.open(rawMount, p);
    } catch (e) {
      console.warn('[nebula] 深链：打开目录失败', e);
    }
  }, 0);
}



/* ==========================================================================
   桌面图标
   ========================================================================== */
function renderDesktopIcons(me) {
  const box = document.getElementById('desktop-icons');

  // ★ 桌面只放映射目录，不放「此电脑」★
  //   用户要求：桌面上删除「此电脑」图标。
  //   「此电脑」窗口本身**没有删**，只是少了桌面入口 —— 仍可从
  //   开始菜单右键「系统信息」/ 桌面右键菜单走到（见 desktopContextMenu），
  //   所以磁盘与三个引擎的健康状态依然可达。
  const items = (me.mounts || []).map((m) => ({
    label: m.label,
    icon: Icons.file(null, true),
    onOpen: () => Explorer.open(m.label, '/'),
  }));

  box.innerHTML = items.map((x, i) => `
    <div class="desk-icon" data-i="${i}">
      <span class="di-img">${x.icon}</span>
      <span class="di-label" title="${esc(x.label)}">${esc(x.label)}</span>
    </div>`).join('');

  box.querySelectorAll('.desk-icon').forEach((el) => {
    const it = items[+el.dataset.i];
    el.addEventListener('dblclick', it.onOpen);
    // 单击选中（Win11 桌面行为）
    el.addEventListener('mousedown', (e) => {
      box.querySelectorAll('.desk-icon').forEach((z) => z.classList.remove('selected'));
      el.classList.add('selected');
      e.stopPropagation();
    });
  });

  // 点桌面空白处取消选中
  document.getElementById('desktop').addEventListener('mousedown', (e) => {
    if (e.target.id === 'desktop' || e.target.id === 'desktop-icons') {
      box.querySelectorAll('.desk-icon').forEach((z) => z.classList.remove('selected'));
    }
  });

  // 桌面右键
  document.getElementById('desktop').addEventListener('contextmenu', (e) => {
    if (e.target.closest('#taskbar') || e.target.closest('#start-menu')) return;
    if (e.target.closest('.window')) return;   // 窗口内的右键归窗口自己处理
    e.preventDefault();
    desktopContextMenu(e.clientX, e.clientY);
  });
}

function desktopContextMenu(x, y) {
  ContextMenu.show(x, y, [
    { label: '刷新', icon: 'refresh', onClick: () => { ViewerBoot.setWallpaper(); Explorer.refreshAll(); } },
    { sep: true },
    {
      // 用户要求：原来叫「新建文件夹窗口」，改成「文件夹窗口」。
      // 行为不变 —— 仍然是打开第一个映射目录的资源管理器窗口。
      label: '文件夹窗口', icon: 'folder',
      disabled: !(App.me && App.me.mounts.length),
      onClick: () => {
        const m = App.me.mounts[0];
        if (m) Explorer.open(m.label, '/');
      },
    },
    {
      // 桌面图标里的「此电脑」已按用户要求移除。
      // 磁盘映射 + 三个预览引擎的健康状态仍需要入口，于是挂到桌面右键里，
      // 功能不丢、桌面更干净。
      // 用户要求：文案改叫「我的电脑」。
      label: '我的电脑', icon: 'desktop',
      onClick: () => showDriveWindow(App.me),
    },
    { sep: true },
    {
      // 用户要求：不再提示「切换到深色/浅色主题」，统一叫「切换主题」。
      // 行为不变 —— 仍然是明暗一键切换。
      label: '切换主题',
      icon: 'settings',
      onClick: toggleTheme,
    },
    {
      label: '更换壁纸', icon: 'image',
      onClick: ViewerBoot.cycleWallpaper,
    },
    { sep: true },
    {
      // 用户要求：文案简化为「下载客户端」（原来带「文件（当前账户）」后缀太长）
      label: '下载客户端', icon: 'download', disabled: true,
    },
    {
      // 用户要求：文案改为「关于」。与开始菜单页脚的「关于本机」是同一功能。
      label: '关于', icon: 'info',
      onClick: showAbout,
    },
  ]);
}

/** 「我的电脑」窗口：列出所有映射磁盘 */
function showDriveWindow(me) {
  const id = 'this-pc';
  WM.open({
    id, title: '我的电脑', icon: Icons.ui('desktop', 16),
    width: 860, height: 560,
    chromeless: true,
    render: (body) => {
      const draw = () => {
        // 统一工具栏：刷新按钮靠左，标题信息靠右，窗口三键由 Toolbar 贴最右
        const bar = WM.Toolbar.build({
          title: '我的电脑',
          left: [WM.Toolbar.btn('refresh', 'refresh', '刷新')],
          right: [`<span class="wt-num">设备和驱动器</span>`],
        });
        body.innerHTML = `
          <div class="win-col">
            ${bar}
            <div class="files-wrap" style="padding:14px;flex:1;min-height:0;overflow:auto">
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px">
                ${(me.mounts || []).map((m, i) => `
                  <div data-drive="${esc(m.label)}"
                       style="display:flex;align-items:center;gap:12px;padding:14px;
                              border:1px solid var(--border);border-radius:6px;
                              background:var(--bg-card);cursor:default;
                              box-shadow:var(--shadow-card)">
                    <span style="width:34px;height:34px;display:grid;place-items:center">
                      ${Icons.ui('hdd', 30)}
                    </span>
                    <div style="min-width:0;flex:1">
                      <div style="font-size:13.5px;font-weight:600;overflow:hidden;
                                  text-overflow:ellipsis;white-space:nowrap"
                           title="${esc(m.label)}">${esc(m.label)}</div>
                      <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">
                        ${m.writable ? '可用' : '不可写'}
                      </div>
                    </div>
                  </div>`).join('') || `
                  <div style="color:var(--text-3);font-size:13px;padding:20px">
                    没有配置任何映射目录。请设置 <code>NEBULA_MOUNTS</code> 后重启容器。
                  </div>`}
              </div>

              <div style="margin-top:24px">
                <div style="font-size:13px;font-weight:600;margin-bottom:10px">服务</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px">
                  <div style="display:flex;align-items:center;gap:12px;padding:12px;
                              border:1px solid var(--border);border-radius:6px;
                              background:var(--bg-card)">
                    <span style="width:30px;height:30px;display:grid;place-items:center">
                      ${Icons.ui('cloud', 26)}</span>
                    <div style="flex:1;min-width:0">
                      <div style="font-size:13px">OnlyOffice</div>
                      <div style="font-size:11.5px;color:var(--text-3)" data-role="oo-status">
                        检测中…</div>
                    </div>
                  </div>
                  <div style="display:flex;align-items:center;gap:12px;padding:12px;
                              border:1px solid var(--border);border-radius:6px;
                              background:var(--bg-card)">
                    <span style="width:30px;height:30px;display:grid;place-items:center">
                      ${Icons.ui('eye', 26)}</span>
                    <div style="flex:1;min-width:0">
                      <div style="font-size:13px">kkFileView</div>
                      <div style="font-size:11.5px;color:var(--text-3)" data-role="kk-login-hint">检测中…</div>
                    </div>
                  </div>
                  <div style="display:flex;align-items:center;gap:12px;padding:12px;
                              border:1px solid var(--border);border-radius:6px;
                              background:var(--bg-card)">
                    <span style="width:30px;height:30px;display:grid;place-items:center">
                      ${Icons.ui('ruler', 26)}</span>
                    <div style="flex:1;min-width:0">
                      <div style="font-size:13px">CAD 查看器</div>
                      <div style="font-size:11.5px;color:var(--text-3)" data-role="cad-status">
                        检测中…</div>
                      <div style="font-size:11px;color:var(--text-3);margin-top:2px"
                           data-role="cad-formats">DWG / DXF 图纸</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="statusbar">
              <span>${(me.mounts || []).length} 个映射目录 · 用户 ${esc(me.username)}</span>
              <span class="sb-right"><span data-role="disk"></span></span>
            </div>
          </div>`;

        body.querySelectorAll('[data-drive]').forEach((el) => {
          el.addEventListener('mouseenter', () => el.style.background = 'var(--bg-hover)');
          el.addEventListener('mouseleave', () => el.style.background = 'var(--bg-card)');
          el.addEventListener('dblclick', () => Explorer.open(el.dataset.drive, '/'));
        });

        // 工具栏按钮：刷新（新统一工具栏的点击口）
        body.querySelector('.win-toolbar').addEventListener('click', (e) => {
          const b = e.target.closest('[data-a]');
          if (!b) return;
          const a = b.dataset.a;
          if (a === 'refresh') draw();
          else if (a === 'min' || a === 'max' || a === 'close') {
            WM[a === 'min' ? 'minimize' : a === 'max' ? 'toggleMax' : 'close'](id);
          }
        });

        // 磁盘空间
        if (me.disk && me.disk.total) {
          const d = body.querySelector('[data-role="disk"]');
          if (d) d.textContent = `可用空间 ${fmtSize(me.disk.free)} / ${fmtSize(me.disk.total)}`;
        }
        // OnlyOffice 状态
        API.ooHealth().then((h) => {
          const n = body.querySelector('[data-role="oo-status"]');
          if (n) {
            n.textContent = h.ok ? '在线' : ('离线' + (h.reason ? `（${h.reason}）` : ''));
            n.style.color = h.ok ? 'var(--ok)' : 'var(--danger)';
          }
        }).catch(() => {
          const n = body.querySelector('[data-role="oo-status"]');
          if (n) { n.textContent = '不可达'; n.style.color = 'var(--danger)'; }
        });
        // kkFileView 状态（同样实时探测）
        API.kkHealth().then((h) => {
          const n = body.querySelector('[data-role="kk-login-hint"]');
          if (n) {
            n.textContent = h.ok ? '在线' : ('离线' + (h.reason ? `（${h.reason}）` : ''));
            n.style.color = h.ok ? 'var(--ok)' : 'var(--danger)';
          }
        }).catch(() => {
          const n = body.querySelector('[data-role="kk-login-hint"]');
          if (n) { n.textContent = '不可达'; n.style.color = 'var(--danger)'; }
        });
        // CAD 查看器状态
        // ★ 这个卡片要能回答「为什么我的图纸打不开」★
        //   所以除了 在线/离线，还把**支持的格式**与内核版本写出来。
        //   常见误判：拿 3D 模型（step/stl/3dm）当 CAD 图纸来开 —— 本服务只认
        //   dwg/dxf，这类文件应该走 kkFileView，格式行会直接写明。
        API.cadHealth().then((h) => {
          const n = body.querySelector('[data-role="cad-status"]');
          const f = body.querySelector('[data-role="cad-formats"]');
          if (n) {
            n.textContent = h.ok
              ? ('在线' + (h.version ? `（v${h.version}）` : ''))
              : ('未启用' + (h.reason ? `（${h.reason}）` : ''));
            n.style.color = h.ok ? 'var(--ok)' : 'var(--text-3)';
          }
          if (f) {
            f.textContent = h.ok
              ? `支持 ${(h.formats || ['dwg', 'dxf']).join(' / ').toUpperCase()} · 独立服务`
              : '未接入独立服务';
          }
        }).catch(() => {
          const n = body.querySelector('[data-role="cad-status"]');
          const f = body.querySelector('[data-role="cad-formats"]');
          if (n) { n.textContent = '不可达'; n.style.color = 'var(--danger)'; }
          if (f) f.textContent = '独立服务未响应';
        });
      };
      draw();
    },
  });
}


/* ==========================================================================
   开始菜单
   ========================================================================== */
function renderStartUser(me) {
  const nameEl = document.querySelector('[data-role="start-username"]');
  if (nameEl) nameEl.textContent = me.username;

  const av = document.querySelector('[data-role="start-avatar"]');
  if (av) av.textContent = (me.username || '?').slice(0, 1).toUpperCase();

  // 页脚「用户管理」按钮：只有管理员可见（普通用户看不到入口）。
  // 后端 require_admin 还会再挡一次，前端隐藏只是不给无效入口。
  const usersBtn = document.getElementById('btn-users');
  if (usersBtn) usersBtn.style.display = me.isAdmin ? '' : 'none';

  // 固定应用
  const grid = document.getElementById('start-grid');
  if (!grid) return;

  // ★ 「推荐的项目」只列真实内容（映射目录 / 用户管理）★
  //   这里原本还有个 data-app="explorer" 的 NebulaDisk 磁贴，但它点击后
  //   就是 Explorer.open(mounts[0])，与紧挨着的第一个映射目录磁贴
  //   **完全同功能**。用户要求去掉这个冗余入口。
  //   （「打开资源管理器」这件事仍可从桌面/任务栏/快捷键走到，功能没丢。）
  //   「关于本机」也已移出网格 —— 见 index.html 的 .start-foot，改放在退出
  //   按钮左边、只显示图标。
  renderStartGrid(grid, me);
}

/* --------------------------------------------------------------------------
   「固定到开始菜单 / 取消固定」

   需求（原文）：「开始菜单推荐的项目 取消固定和固定到开始菜单没有这个功能」。
   原先网格里的磁贴是纯静态的，右键没有任何菜单，所以两个动作都无从触发。
   这里补上：
     - 固定集合持久化在 localStorage（按 key 记，不记索引，避免目录增减错位）
     - 网格分成「已固定 / 推荐的项目」两段，段标题跟随内容显示/隐藏
     - 右键磁贴 → 固定 或 取消固定
   key 约定：
     映射目录  → `mount:<label>`
     内置应用  → `app:admin`
   -------------------------------------------------------------------------- */
const START_PIN_KEY = 'nebula.startPins';

function readPins() {
  try {
    const raw = JSON.parse(localStorage.getItem(START_PIN_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}
function writePins(set) {
  localStorage.setItem(START_PIN_KEY, JSON.stringify([...set]));
}

/** 拼一个磁贴的 HTML。key 是稳定标识，label 用于显示。 */
function startTileHTML(t, pinned) {
  const inner = t.mount
    ? `${Icons.file(null, true)}<span class="sa-name" title="${esc(t.name)}">${esc(t.name)}</span>`
    : `${Icons.ui(t.icon, 34)}<span class="sa-name">${esc(t.name)}</span>`;
  const attr = t.mount ? `data-mount="${esc(t.mount)}"` : `data-app="${esc(t.app)}"`;
  return `<div class="start-app${pinned ? ' pinned' : ''}" ${attr} data-key="${esc(t.key)}">
    ${inner}
    ${pinned ? `<span class="sa-pin" title="已固定">${Icons.ui('pin', 11)}</span>` : ''}
  </div>`;
}

function renderStartGrid(grid, me) {
  const pins = readPins();

  // 1) 候选集合（顺序即展示顺序）
  //
  //   ★ 只放映射目录（文件夹）★
  //     需求（原文）：「开始菜单：文件夹后面的 用户管理 这个按钮去掉」
  //     原先这里还会 push 一个 { app:'admin' } 磁贴「用户管理」，它排在
  //     所有文件夹磁贴之后，正是用户要删掉的那一个。用户管理入口由
  //     开始菜单**页脚**的 #btn-users 承担（见 index.html），无需磁贴重复。
  //     注意：下面的 grid.onclick / 右键固定逻辑仍保留 data-app 分支，
  //     以便将来重新加回其它应用磁贴，不做破坏性删减。
  const all = [];
  (me.mounts || []).slice(0, 8).forEach((m) => all.push({
    key: `mount:${m.label}`, name: m.label, mount: m.label,
  }));

  const pinned = all.filter((t) => pins.has(t.key));
  const rest = all.filter((t) => !pins.has(t.key));

  // 2) 两段渲染；段为空则不渲染标题
  const seg = (title, list) => list.length
    ? `<div class="start-sect">${esc(title)}</div>
       <div class="start-grid-inner">${list.map((t) => startTileHTML(t, pins.has(t.key))).join('')}</div>`
    : '';

  grid.innerHTML = seg('已固定', pinned) + seg('推荐的项目', rest)
    || `<div class="start-empty">暂无内容</div>`;

  // 3) 左键：打开
  //
  //   ★ 这里**不再**有 showUserAdmin 分支 ★
  //     用户管理磁贴已被移除（见上面第 1 节的说明），留在代码里就是死分支。
  //     将来若加回应用磁贴，按 data-app 的值在此处补 case 即可 ——
  //     下面的 `if (app)` 骨架已为此保留。
  grid.onclick = (e) => {
    const app = e.target.closest('[data-app]');
    const mount = e.target.closest('[data-mount]');
    if (app) {
      // 目前网格里不存在 data-app 磁贴；用户管理入口在开始菜单页脚 #btn-users。
    } else if (mount) {
      Explorer.open(mount.dataset.mount, '/');
    }
    closeStart();
  };

  // 4) 右键：固定 / 取消固定
  grid.oncontextmenu = (e) => {
    const tile = e.target.closest('[data-key]');
    if (!tile) return;
    e.preventDefault();
    e.stopPropagation();
    const key = tile.dataset.key;
    const isPinned = readPins().has(key);

    ContextMenu.show(e.clientX, e.clientY, [
      isPinned
        ? {
            label: '从「开始」菜单取消固定', icon: 'close',
            onClick: () => {
              const s = readPins(); s.delete(key); writePins(s);
              renderStartGrid(grid, me);
              Toast.info('已取消固定', '已从开始菜单移出');
            },
          }
        : {
            label: '固定到「开始」菜单', icon: 'pin',
            onClick: () => {
              const s = readPins(); s.add(key); writePins(s);
              renderStartGrid(grid, me);
              Toast.ok('已固定', '已添加到开始菜单');
            },
          },
    ]);
  };
}

function toggleStart() {
  const m = document.getElementById('start-menu');
  if (m.classList.contains('open')) closeStart();
  else openStart();
}
function openStart() {
  document.getElementById('start-menu').classList.add('open');
  const q = document.getElementById('start-search-input');
  if (q) setTimeout(() => q.focus(), 80);
}
function closeStart() {
  document.getElementById('start-menu').classList.remove('open');
}


/* ==========================================================================
   管理员：用户管理

   需求（原文）：「用户管理设置 放到 关于本机 按钮前面」＋「可以设置」。

   旧实现是**只读**的：界面只有一段「请在容器环境变量里配」的提示，
   因为后端当时根本没有 /api/users*。现在后端补齐了 CRUD（main.py 里
   那一组路由 + users.py 的 update/count_admins），这里做成真正能用的管理页：

     - 列表：用户名 / 显示名 / 角色 / 上次登录 / 创建时间
     - 新建用户（可勾选管理员）
     - 编辑：改显示名、切换管理员
     - 重置密码（管理员给他人重置，不需要原密码）
     - 删除（后端挡住「内置管理员」「最后一个管理员」「当前登录账户」）
     - 审计日志（最近操作）

   ★ 为什么用「选中后点工具栏按钮」而不是每行一个按钮 ★
     与资源管理器的交互保持一致（选中 + 工具栏/右键），用户不用学第二套；
     行内按钮在窄窗口下还会把用户名挤没。
   ========================================================================== */
function showUserAdmin() {
  const id = 'user-admin';
  WM.open({
    id, title: '用户管理', icon: Icons.ui('users', 16),
    width: 880, height: 560,
    chromeless: true,
    render: (body) => {
      let users = [];
      let selected = null;      // 当前选中的用户名
      let tab = 'users';        // 'users' | 'audit'

      const bar = WM.Toolbar.build({
        title: '用户管理',
        left: [
          WM.Toolbar.btn('add', 'plus', '新建用户', 'primary'),
          WM.Toolbar.sep(),
          WM.Toolbar.btn('edit', 'rename', '编辑'),
          WM.Toolbar.btn('pw', 'key', '重置密码'),
          WM.Toolbar.btn('del', 'trash', '删除'),
        ],
        right: [
          WM.Toolbar.btn('tab-users', 'users', '用户'),
          WM.Toolbar.btn('tab-audit', 'list', '审计日志'),
          WM.Toolbar.sep(),
          WM.Toolbar.btn('refresh', 'refresh', '刷新'),
        ],
      });

      body.innerHTML = `
        <div class="win-col">
          ${bar}
          <div class="files-wrap" data-role="list"
               style="padding:0;flex:1;min-height:0;overflow:auto"></div>
          <div class="statusbar">
            <span data-role="st">加载中…</span>
          </div>
        </div>`;

      const listEl = body.querySelector('[data-role="list"]');
      const st = body.querySelector('[data-role="st"]');

      /* ---------------- 渲染 ---------------- */
      function render() {
        if (tab === 'audit') return renderAudit();
        if (!users.length) {
          listEl.innerHTML = `<div class="state-box">
            ${Icons.ui('users', 52)}
            <div class="sb-title">暂无用户</div>
            <div class="sb-hint">点左上角「新建用户」添加第一个账户。</div>
          </div>`;
          return;
        }
        listEl.innerHTML = `
          <table class="utable">
            <thead><tr>
              <th style="width:34%">用户名</th>
              <th style="width:22%">显示名</th>
              <th style="width:14%">角色</th>
              <th style="width:30%">上次登录</th>
            </tr></thead>
            <tbody>${users.map((u) => `
              <tr data-u="${esc(u.username)}" class="${u.username === selected ? 'sel' : ''}">
                <td>
                  <span class="u-avatar">${esc((u.username || '?').slice(0, 1).toUpperCase())}</span>
                  <span class="u-name">${esc(u.username)}</span>
                  ${u.builtin ? '<span class="u-tag builtin">内置</span>' : ''}
                  ${u.username === App.me.username ? '<span class="u-tag me">当前</span>' : ''}
                </td>
                <td>${esc(u.display || u.username)}</td>
                <td>${u.isAdmin
                  ? '<span class="u-tag admin">管理员</span>'
                  : '<span class="u-tag">普通用户</span>'}</td>
                <td class="u-dim">${u.lastLogin ? fmtTime(u.lastLogin) : '从未登录'}</td>
              </tr>`).join('')}
            </tbody>
          </table>`;
        listEl.querySelectorAll('tr[data-u]').forEach((tr) => {
          tr.addEventListener('click', () => { selected = tr.dataset.u; render(); });
          tr.addEventListener('dblclick', () => { selected = tr.dataset.u; editUser(); });
        });
      }

      async function renderAudit() {
        listEl.innerHTML = `<div class="state-box"><div class="sb-title">加载中…</div></div>`;
        try {
          const r = await API.userAudit(200);
          const items = r.items || [];
          if (!items.length) {
            listEl.innerHTML = `<div class="state-box">
              <div class="sb-title">暂无记录</div>
              <div class="sb-hint">用户的增删改与文件关键操作会记录在这里。</div>
            </div>`;
            return;
          }
          listEl.innerHTML = `
            <table class="utable">
              <thead><tr>
                <th style="width:22%">时间</th>
                <th style="width:16%">账户</th>
                <th style="width:18%">操作</th>
                <th style="width:44%">对象</th>
              </tr></thead>
              <tbody>${items.map((it) => `
                <tr>
                  <td class="u-dim">${fmtTimeFull(it.ts)}</td>
                  <td>${esc(it.username || '-')}</td>
                  <td><span class="u-tag">${esc(it.action || '')}</span></td>
                  <td class="u-dim" title="${esc(it.target || '')}">${
                    esc([it.target, it.detail].filter(Boolean).join(' ')).slice(0, 90)}</td>
                </tr>`).join('')}
              </tbody>
            </table>`;
        } catch (e) {
          listEl.innerHTML = `<div class="state-box">
            <div class="sb-title">读取失败</div>
            <div class="sb-hint">${esc(e.message)}</div>
          </div>`;
        }
      }

      function setStatus() {
        const admins = users.filter((u) => u.isAdmin).length;
        st.textContent = `共 ${users.length} 个用户 · ${admins} 个管理员`
          + `　|　当前登录：${App.me.username}`
          + (selected ? `　|　已选中：${selected}` : '');
      }

      /* ---------------- 数据 ---------------- */
      async function refresh() {
        try {
          const r = await API.users();
          users = r.users || [];
          if (selected && !users.some((u) => u.username === selected)) selected = null;
          render();
          setStatus();
        } catch (e) {
          listEl.innerHTML = `<div class="state-box">
            ${Icons.ui('warn', 48)}
            <div class="sb-title">无法读取用户列表</div>
            <div class="sb-hint">${esc(e.message)}</div>
          </div>`;
          st.textContent = '读取失败';
        }
      }

      const cur = () => users.find((u) => u.username === selected) || null;

      /* ---------------- 动作 ---------------- */
      async function addUser() {
        const dlg = Dialog.custom({ title: '新建用户' });
        dlg.el.innerHTML = `
          <div class="field">
            <label>用户名</label>
            <input type="text" data-role="u" placeholder="登录名，最多 32 字符">
          </div>
          <div class="field">
            <label>显示名（可选）</label>
            <input type="text" data-role="d" placeholder="留空则与用户名相同">
          </div>
          <div class="field">
            <label>初始密码</label>
            <input type="password" data-role="p" placeholder="至少 6 位">
          </div>
          <label class="ckline">
            <input type="checkbox" data-role="adm"> 设为管理员
          </label>
          <div class="login-err" data-role="err"></div>`;
        dlg.foot.innerHTML = `
          <button class="btn" data-r="0">取消</button>
          <button class="btn primary" data-r="1">创建</button>`;
        const err = dlg.el.querySelector('[data-role="err"]');
        dlg.foot.querySelector('[data-r="0"]').onclick = dlg.close;
        dlg.foot.querySelector('[data-r="1"]').onclick = async () => {
          const u = dlg.el.querySelector('[data-role="u"]').value.trim();
          const d = dlg.el.querySelector('[data-role="d"]').value.trim();
          const p = dlg.el.querySelector('[data-role="p"]').value;
          const adm = dlg.el.querySelector('[data-role="adm"]').checked;
          if (!u) { err.textContent = '用户名不能为空'; err.classList.add('show'); return; }
          if (p.length < 6) { err.textContent = '密码至少 6 位'; err.classList.add('show'); return; }
          try {
            await API.userCreate(u, p, d, adm);
            dlg.close();
            Toast.ok('已创建', u);
            selected = u;
            await refresh();
          } catch (e) { err.textContent = e.message; err.classList.add('show'); }
        };
      }

      async function editUser() {
        const u = cur();
        if (!u) return Toast.info('请先选中', '先点一行选中要编辑的用户');
        const dlg = Dialog.custom({ title: `编辑「${u.username}」` });
        dlg.el.innerHTML = `
          <div class="field">
            <label>用户名（登录名）</label>
            <input type="text" data-role="u" value="${esc(u.username)}"
                   ${u.builtin ? 'disabled' : ''}>
          </div>
          <div class="field">
            <label>显示名</label>
            <input type="text" data-role="d" value="${esc(u.display || u.username)}">
          </div>
          <label class="ckline">
            <input type="checkbox" data-role="adm" ${u.isAdmin ? 'checked' : ''}>
            设为管理员
          </label>
          ${u.builtin ? `<div class="alert">${Icons.ui('warn', 16)}
            <span>内置管理员不能改名，也不能被降级，此处改动无效。</span></div>` : ''}
          <div class="login-err" data-role="err"></div>`;
        dlg.foot.innerHTML = `
          <button class="btn" data-r="0">取消</button>
          <button class="btn primary" data-r="1">保存</button>`;
        const err = dlg.el.querySelector('[data-role="err"]');
        const showErr = (m) => { err.textContent = m; err.classList.add('show'); };
        dlg.foot.querySelector('[data-r="0"]').onclick = dlg.close;
        dlg.foot.querySelector('[data-r="1"]').onclick = async () => {
          const newU = u.builtin ? u.username
            : dlg.el.querySelector('[data-role="u"]').value.trim();
          const d = dlg.el.querySelector('[data-role="d"]').value.trim();
          const adm = dlg.el.querySelector('[data-role="adm"]').checked;
          if (!newU) return showErr('用户名不能为空');
          try {
            let finalName = u.username;
            // 先改名（若改了）—— 后续 display/角色 一律用新名，否则会写到旧行上
            if (newU !== u.username) {
              const r = await API.userRename(u.username, newU);
              finalName = r.username || newU;
            }
            await API.userUpdate(finalName, { display: d, isAdmin: adm });
            dlg.close();
            Toast.ok('已保存', finalName);
            selected = finalName;
            await refresh();
          } catch (e) { showErr(e.message); }
        };
      }

      async function resetPw() {
        const u = cur();
        if (!u) return Toast.info('请先选中', '先点一行选中要重置密码的用户');
        const dlg = Dialog.custom({ title: `重置「${u.username}」的密码` });
        dlg.el.innerHTML = `
          <div class="field">
            <label>新密码</label>
            <input type="password" data-role="p" placeholder="至少 6 位">
          </div>
          <div class="field">
            <label>确认新密码</label>
            <input type="password" data-role="p2">
          </div>
          <div class="login-err" data-role="err"></div>`;
        dlg.foot.innerHTML = `
          <button class="btn" data-r="0">取消</button>
          <button class="btn primary" data-r="1">重置</button>`;
        const err = dlg.el.querySelector('[data-role="err"]');
        dlg.foot.querySelector('[data-r="0"]').onclick = dlg.close;
        dlg.foot.querySelector('[data-r="1"]').onclick = async () => {
          const p = dlg.el.querySelector('[data-role="p"]').value;
          const p2 = dlg.el.querySelector('[data-role="p2"]').value;
          if (p.length < 6) { err.textContent = '密码至少 6 位'; err.classList.add('show'); return; }
          if (p !== p2) { err.textContent = '两次输入不一致'; err.classList.add('show'); return; }
          try {
            await API.userPassword(u.username, p);
            dlg.close();
            Toast.ok('密码已重置', u.username);
          } catch (e) { err.textContent = e.message; err.classList.add('show'); }
        };
      }

      async function delUser() {
        const u = cur();
        if (!u) return Toast.info('请先选中', '先点一行选中要删除的用户');
        const ok = await Dialog.confirm({
          title: '删除用户',
          message: `确定要删除「${u.username}」吗？该账户将立即无法登录。`,
          okText: '删除',
          danger: true,
        });
        if (!ok) return;
        try {
          await API.userDelete(u.username);
          Toast.ok('已删除', u.username);
          selected = null;
          await refresh();
        } catch (e) { Toast.error('删除失败', e.message); }
      }

      /* ---------------- 绑定 ---------------- */
      body.querySelector('.win-toolbar').addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (!b) return;
        const a = b.dataset.a;
        if (a === 'min' || a === 'max' || a === 'close') {
          return WM[a === 'min' ? 'minimize' : a === 'max' ? 'toggleMax' : 'close'](id);
        }
        if (a === 'add') addUser();
        else if (a === 'edit') editUser();
        else if (a === 'pw') resetPw();
        else if (a === 'del') delUser();
        else if (a === 'refresh') { if (tab === 'audit') renderAudit(); else refresh(); }
        else if (a === 'tab-users') { tab = 'users'; render(); setStatus(); }
        else if (a === 'tab-audit') { tab = 'audit'; renderAudit(); st.textContent = '审计日志（最近 200 条）'; }
      });

      refresh();
    },
  });
}


/* ==========================================================================
   关于本机

   需求（原文）：「关于本机里面的内容需要更新一下。」
   旧版本的问题：
     1. 只列了 OnlyOffice / kkFileView —— 缺 CAD 查看器（现在是三引擎之一）
     2. 没有可达性之外的信息（版本、格式、空间明细）
     3. 文案把「Office 由 OnlyOffice、其他由 kkFileView」讲成二选一，
        实际上现在是**按扩展名路由到三个引擎**，说明要跟着改
   新版结构：产品头 → 账户 → 系统（空间明细）→ 预览引擎（三行）→ 说明
   ========================================================================== */
function showAbout() {
  const me = App.me || {};
  const dlg = Dialog.custom({ title: '关于 NebulaDisk', wide: true });

  const disk = me.disk || {};
  const pct = disk.total ? Math.round((disk.used / disk.total) * 100) : 0;

  dlg.el.innerHTML = `
    <div style="display:flex;gap:16px;align-items:center;margin-bottom:16px">
      ${Icons.app(52)}
      <div style="min-width:0">
        <div style="font-size:17px;font-weight:600">${esc(me.title || 'NebulaDisk')}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px">
          私有云盘 · 仿 Windows 桌面 · 与 kkFileView 合并镜像
        </div>
        <div style="font-size:11.5px;color:var(--text-3);margin-top:3px">
          版本 ${esc(APP_VERSION)}
        </div>
      </div>
    </div>

    <div class="about-sect">账户</div>
    <div class="ip-row"><span class="k">登录用户</span>
      <span class="v">${esc(me.username || '-')}</span></div>
    <div class="ip-row"><span class="k">权限</span>
      <span class="v">${me.isAdmin ? '管理员' : '普通用户'}</span></div>
    <!-- 用户要求：映射目录只显示「N 个」，去掉后面的（目录名、目录名…）括号 -->
    <div class="ip-row"><span class="k">映射目录</span>
      <span class="v">${(me.mounts || []).length} 个</span></div>

    <div class="about-sect">存储</div>
    <div class="ip-row"><span class="k">总容量</span>
      <span class="v">${disk.total ? fmtSize(disk.total) : '-'}</span></div>
    <div class="ip-row"><span class="k">已使用</span>
      <span class="v">${disk.total ? fmtSize(disk.used) : '-'}</span></div>
    <div class="ip-row"><span class="k">可用空间</span>
      <span class="v">${disk.total ? fmtSize(disk.free) : '-'}</span></div>
    ${disk.total ? `
    <div class="disk-bar" title="已使用 ${pct}%">
      <i style="width:${Math.min(100, pct)}%"></i>
    </div>` : ''}

    <div class="about-sect">预览与编辑引擎</div>
    <div class="ip-row"><span class="k">OnlyOffice</span>
      <span class="v" data-role="oo">检测中…</span></div>
    <div class="ip-row"><span class="k">kkFileView</span>
      <span class="v" data-role="kk">检测中…</span></div>
    <div class="ip-row"><span class="k">CAD 查看器</span>
      <span class="v" data-role="cad">检测中…</span>
      <span class="v-sub" data-role="cad-fmt"></span></div>

    <div class="alert info" style="margin-top:14px">
      ${Icons.ui('info', 16)}
      <span>文件按扩展名自动路由：<b>Office 文档</b>用 OnlyOffice 在线编辑并写回原目录；
            <b>DWG / DXF 图纸</b>走独立的 CAD 查看器；
            其余格式由 kkFileView 只读预览。</span>
    </div>`;

  dlg.foot.innerHTML = `<button class="btn primary" data-role="ok">确定</button>`;
  dlg.foot.querySelector('[data-role="ok"]').addEventListener('click', dlg.close);

  const set = (role, text, ok) => {
    const n = dlg.el.querySelector(`[data-role="${role}"]`);
    if (!n) return;
    n.textContent = text;
    n.style.color = ok === undefined ? '' : (ok ? 'var(--ok)' : 'var(--danger)');
  };

  API.ooHealth()
    .then((h) => set('oo', h.ok ? '在线' : '离线', !!h.ok))
    .catch(() => set('kk', '不可达', false) || set('oo', '不可达', false));

  API.kkHealth()
    .then((h) => set('kk', h.ok ? '在线' : '离线', !!h.ok))
    .catch(() => set('kk', '不可达', false));

  API.cadHealth()
    .then((h) => {
      // 用户要求：CAD 查看器只显示「在线」/「未启用」，去掉后面的（已运行 …）括号
      set('cad', h.ok ? '在线' : '未启用', !!h.ok);
      const f = dlg.el.querySelector('[data-role="cad-fmt"]');
      if (f) f.textContent = h.ok
        ? `支持 ${(h.formats || ['dwg', 'dxf']).join(' / ').toUpperCase()}`
        : '';
    })
    .catch(() => set('cad', '不可达', false));
}

/** 秒 → "3 天 2 小时" 这种可读时长（关于本机里显示 CAD 服务已运行多久） */
function fmtUptime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}


/* ==========================================================================
   主题 / 壁纸 / 时钟
   ========================================================================== */
function applyStoredTheme() {
  const t = localStorage.getItem('nebula.theme') || 'light';
  document.documentElement.dataset.theme = t;
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('nebula.theme', next);
  Toast.info('已切换主题', next === 'dark' ? '深色模式' : '浅色模式');
}

const ViewerBoot = {
  WALLPAPERS: [
    // 用 CSS 渐变而不是外链图片 —— 离线 NAS 环境不能依赖外网
    'linear-gradient(135deg, #1b4b7a 0%, #2d7ab8 42%, #6cc3e8 100%)',
    'linear-gradient(135deg, #3b2d5c 0%, #6b4b8a 50%, #b98ac9 100%)',
    'linear-gradient(135deg, #1d3b2a 0%, #2f6b47 50%, #7ab98a 100%)',
    'linear-gradient(135deg, #5c2d2d 0%, #a04b3b 50%, #d99a6c 100%)',
    'linear-gradient(135deg, #2c2c34 0%, #4a4a58 50%, #8a8a9c 100%)',
    'linear-gradient(135deg, #0f3057 0%, #00587a 50%, #008891 100%)',
  ],

  setWallpaper(force = false) {
    let idx = parseInt(localStorage.getItem('nebula.wallpaper') || '0', 10);
    if (isNaN(idx) || idx < 0 || idx >= this.WALLPAPERS.length) idx = 0;
    if (force) idx = (idx + 1) % this.WALLPAPERS.length;
    localStorage.setItem('nebula.wallpaper', String(idx));

    const bg = this.WALLPAPERS[idx];
    const desk = document.getElementById('desktop');
    if (desk) desk.style.background = bg;
    const ls = document.getElementById('login-screen');
    if (ls) ls.style.background = bg;
    // ★ #boot 是启动遮罩，DOMContentLoaded 后会被 remove()。
    //   这里必须判空：用户「先进登录页、再登录」时 boot 已经不存在，
    //   无保护地取 .style 会抛 TypeError，而该异常会冒泡到登录的
    //   try/catch 里，被误报成「登录失败」——服务端其实已经登录成功了，
    //   用户却永远进不去桌面。这是最隐蔽的一类 bug。
    const boot = document.getElementById('boot');
    if (boot) boot.style.background = bg;
  },

  cycleWallpaper() {
    this.setWallpaper(true);
    Toast.info('已更换壁纸', '桌面背景已更新');
  },

  startClock() {
    const tick = () => {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const now = document.querySelector('[data-role="clock-time"]');
      const date = document.querySelector('[data-role="clock-date"]');
      if (now) now.textContent = `${hh}:${mm}`;
      if (date) {
        date.textContent = `${d.getMonth() + 1}/${d.getDate()} 周${'日一二三四五六'[d.getDay()]}`;
      }
    };
    tick();
    setInterval(tick, 15000);
  },
};


/* ==========================================================================
   任务栏交互 + 全局快捷键
   ========================================================================== */
function bindTaskbar() {
  document.getElementById('btn-start').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStart();
  });

  // 点空白关开始菜单
  document.addEventListener('mousedown', (e) => {
    const menu = document.getElementById('start-menu');
    if (!menu.classList.contains('open')) return;
    if (menu.contains(e.target)) return;
    if (e.target.closest('#btn-start')) return;
    closeStart();
  });

  // 开始菜单里的搜索框：回车就打开第一个映射
  const ss = document.getElementById('start-search-input');
  if (ss) {
    ss.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const m = App.me && App.me.mounts[0];
        if (m) Explorer.open(m.label, '/');
        closeStart();
      }
      if (e.key === 'Escape') closeStart();
    });
  }

  // 托盘：主题
  const themeBtn = document.getElementById('btn-theme');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  // 开始菜单页脚：关于本机（在退出按钮左边，只显示图标）
  const aboutBtn = document.getElementById('btn-about');
  if (aboutBtn) {
    aboutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeStart();
      showAbout();
    });
  }

  // 开始菜单页脚：用户管理（在「关于本机」左边）
  //
  // ★ 需求（原文）：「用户管理设置 放到 关于本机 按钮前面。」★
  //   按钮固定在 HTML 里（顺序：用户管理 → 关于本机 → 退出），
  //   这里只负责绑事件与**按权限显隐**：
  //   普通用户不显示（后端也有 require_admin 兜底，两层都不放行）。
  const usersBtn = document.getElementById('btn-users');
  if (usersBtn) {
    usersBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeStart();
      showUserAdmin();
    });
  }

  // 托盘：关机/退出
  const powerBtn = document.getElementById('btn-power');
  if (powerBtn) {
    powerBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeStart();
      const ok = await Dialog.confirm({
        title: '退出登录',
        message: '确定要退出当前账户吗？未保存的编辑内容会丢失。',
        okText: '退出登录',
      });
      if (!ok) return;
      try { await API.logout(); } catch { /* 忽略：本地登出即可 */ }
      App.booted = false;
      WM.closeAll();
      showLogin();
    });
  }

  // 左上角：显示桌面（Win+D 的等效按钮）
  const deskBtn = document.getElementById('btn-showdesk');
  if (deskBtn) {
    deskBtn.addEventListener('click', () => {
      const ws = WM.list();
      const anyVisible = ws.some((w) => !w.minimized);
      ws.forEach((w) => anyVisible ? WM.minimize(w.id) : WM.restore(w.id));
    });
  }
}

function bindHotkeys() {
  document.addEventListener('keydown', (e) => {
    // 输入框里不劫持按键
    const typing = e.target.matches('input, textarea, [contenteditable]');

    // Windows 键 / Ctrl+Esc → 开始菜单
    if (e.key === 'Meta' || (e.ctrlKey && e.key === 'Escape')) {
      e.preventDefault();
      toggleStart();
      return;
    }
    if (e.key === 'Escape') {
      closeStart();
      ContextMenu.close();
      return;
    }
    if (typing) return;

    // F5 刷新当前资源管理器
    if (e.key === 'F5') {
      e.preventDefault();
      const w = activeExplorer();
      if (w && w.opts.nav) w.opts.nav.refresh();
      return;
    }
    // F2 重命名
    if (e.key === 'F2') {
      const w = activeExplorer();
      if (w && w.opts.onF2) { e.preventDefault(); w.opts.onF2(); }
      return;
    }
    // Del 删除
    if (e.key === 'Delete') {
      const w = activeExplorer();
      if (w && w.opts.onDelete) { e.preventDefault(); w.opts.onDelete(); }
      return;
    }
    // Ctrl+A 全选（资源管理器内）
    if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
      const w = activeExplorer();
      if (w && w.opts.onSelectAll) { e.preventDefault(); w.opts.onSelectAll(); }
      return;
    }
    // Alt+Left / Alt+Right 前进后退
    if (e.altKey && e.key === 'ArrowLeft') {
      const b = document.querySelector('.window[data-win-id^="explorer:"] .addrbar [data-act="back"]');
      if (b && !b.disabled) b.click();
      return;
    }
    if (e.altKey && e.key === 'ArrowRight') {
      const b = document.querySelector('.window[data-win-id^="explorer:"] .addrbar [data-act="forward"]');
      if (b && !b.disabled) b.click();
      return;
    }
    // Ctrl+L 聚焦地址栏（用开始菜单搜索近似替代）
    if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      openStart();
    }
  });
}

/** 当前最上层的资源管理器窗口 */
function activeExplorer() {
  const exps = WM.list().filter((w) => w.id.startsWith('explorer:') && !w.minimized);
  if (!exps.length) return null;
  return exps.reduce((a, b) => (+a.el.style.zIndex > +b.el.style.zIndex ? a : b));
}


/* ==========================================================================
   启动时绑定
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  bindTaskbar();
  bindHotkeys();

  // 「关闭所有窗口」按钮
  const cw = document.getElementById('btn-closeall');
  if (cw) cw.addEventListener('click', () => WM.closeAll());

  // 防止把文件拖进页面被浏览器直接打开（会替换掉整个应用）
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    // ★ 拖到资源管理器窗口上的场景已由窗口自己的 bindDropUpload 处理 ★
    //   它会在 drop 时 stopPropagation 并打 __nebulaHandled 标记，所以
    //   正常情况下走不到这里。兜底只针对「拖到了窗口上但落在 .content
    //   之外的边角」，此时仍按当前激活的资源管理器目录上传，避免用户
    //   拖了半天却没反应。
    if (e.__nebulaHandled) return;
    const w = activeExplorer();
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length && w && w.opts.onDropFiles) {
      w.opts.onDropFiles([...files]);
    }
  });
});
