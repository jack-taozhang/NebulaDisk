/* =============================================================================
 * links.js —— 「链接管理」面板：直链（/f/）与分享（/s/）统一在一个界面里管理
 *
 * 用户需求（原文）：
 *   「分享链接管理 需要一个更强大，更丰富，更直观的一些的功能，帮我实现他。」
 *   「在开始菜单增加一个按钮，专用于分享管理。」
 *   「链接管理图标按钮 放到用户管理 按钮边上。」
 *   「可用批量处理。」
 *   「勾选完增加一个全选，更友好。」
 * ⇒ 入口落在开始菜单**页脚**的 #btn-links（紧挨「用户管理」左边，见 index.html），
 *   以及文件/空白处右键菜单里的「管理我的链接…」。
 *   批量处理做在工具条的主控「全选」+ 批量条（复制/导出/续期/反选/撤销）上。
 *
 * 后端已经把它们并成一张 links 表（kind=file|share），管理面只有一组接口：
 *   GET  /api/links            统一列表（含 url / 计数 / 状态 / 备注 / 最近访问）
 *   POST /api/links/revoke     撤销（两类都能撤）
 *   POST /api/links/rotate     换一条地址（旧地址立即失效，参数与目标不变）
 *   POST /api/links/update     改备注 / 有效期 / 次数上限 / 提取码
 *   POST /api/links/revoke-dead 清理已失效的分享
 * ⇒ 所以这里做的事是：把这一组能力**做成一个真能用的界面**，而不是一个只读列表。
 *
 * ---------------------------------------------------------------------------
 * 设计上的几个决定（都有理由，别随手改回去）
 *
 * ★ 1. 只重渲染「列表容器」，工具条只建一次 ★
 *   搜索框在工具条里。若每次筛选都整体 innerHTML，输入框会被重建
 *   ⇒ 焦点丢失、光标跳到开头，边打字边跳是没法用的。
 *   所以：外壳（统计 + 工具条 + 批量条 + 列表容器）建一次，
 *   `renderList()` 只换列表容器里的内容；焦点天然保留。
 *
 * ★ 2. 选中态存在 state 里，不在 DOM 上 ★
 *   否则一排序/一筛选，勾选就全没了。集合的 key 是 token（稳定标识）。
 *
 * ★ 3. 「更多」用 ContextMenu，不用一排 6 个按钮 ★
 *   每行的高频动作只有「复制」；其余（编辑/换地址/定位/撤销）收进 ⋯ 菜单。
 *   一排按钮会把窄屏挤爆，而且主次不分。
 *
 * ★ 4. 二维码在**本地**画（web/js/qr.js）★
 *   绝不能用在线二维码接口 —— 链接是「免登录、链接即凭证」，
 *   把 token 发给第三方 = 把文件对外公开。QR 的正确性由
 *   tools/qr_crosscheck.py 与参考实现逐模块比对保证。
 *
 * ★ 5. 危险动作一律二次确认，且把「会发生什么」写清楚 ★
 *   「换地址」是**主动**让旧地址失效（不是撤销），文案必须点明，
 *   否则用户以为只是"再复制一条"。
 * ========================================================================== */
const LinkManager = (() => {
  'use strict';

  const KIND_LABEL = { file: '直链', share: '分享' };
  // 「不修改」哨兵：编辑框里用它区分"没动"和"清空"
  const KEEP = '__keep__';

  const state = {
    items: [],
    q: '',
    kind: 'all',      // all | file | share
    status: 'all',    // all | alive | dead
    sort: 'created',  // created | accessed | count | name
    desc: true,
    sel: new Set(),
    loading: false,
    err: '',
  };

  /* ---------------------------------------------------------------------
     小工具
     ------------------------------------------------------------------ */
  const accessCount = (s) => (s.kind === 'file' ? (s.hits || 0) : (s.visits || 0));

  function copyText(text, label) {
    return navigator.clipboard.writeText(text)
      .then(() => Toast.ok('已复制', label || text))
      .catch(() => Toast.info('请手动复制', text));
  }

  function fullUrl(s) {
    return s.url
      || `${location.origin}${s.kind === 'file' ? '/f/' : '/s/'}${s.token}`;
  }

  /** 剩余秒数（可能为负） */
  function secondsLeft(s) {
    return (Number(s.expiresAt) || 0) - Math.floor(Date.now() / 1000);
  }

  /** 有效期文案 —— ★ 用户要求：「如果是多少天，那就显示 有效天数。」★
   *
   *   永久（直链，或 expiresAt=0 的分享） → 「永久有效」
   *   限时且未过期                     → 「剩余 N 天」
   *
   * ★ 为什么不足一天要给小时 ★
   *   直接 Math.round 会得到「剩余 0 天」——用户读不懂这是"马上过期"还是"算错了"。
   *   所以 < 1 天切到小时，< 1 小时再说"不足 1 小时"。
   */
  function validityText(s) {
    if (s.expired) return '已过期';
    if (!s.expiresAt) return '永久有效';
    const left = secondsLeft(s);
    const days = Math.ceil(left / 86400);
    if (days >= 1) return `剩余 ${days} 天`;
    if (left >= 3600) return `剩余 ${Math.ceil(left / 3600)} 小时`;
    return '不足 1 小时';
  }

  /** 精确到期时间（放 tooltip / 子弹窗，不占列表的横向空间） */
  function validityTip(s) {
    if (!s.expiresAt) return '永久有效';
    const total = s.createdAt
      ? Math.max(1, Math.round((s.expiresAt - s.createdAt) / 86400))
      : 0;
    return `有效期至 ${fmtTimeFull(s.expiresAt)}` + (total ? `（共 ${total} 天）` : '');
  }

  /** 是否「永久有效」。
   *
   * ★ 直链与分享现在是**同规格**的：`expiresAt === 0` 才是永久 ★
   *   用户要求（原话）：「直链 默认 也按7天来。」
   *   ⇒ 新签发的直链默认 7 天（后端 `DEFAULT_TTL_SECONDS`）。
   *   ⚠️ 库里**历史遗留**的直链 `expires_at` 仍是 0（永久），
   *      它们照样显示「永久有效」—— 因为事实就是这样。
   */
  function isPermanent(s) {
    return !s.expiresAt;
  }

  /** 状态一句话（给副标题用） */
  function stateText(s) {
    if (s.exhausted) return '次数用尽';
    return validityText(s);
  }

  function stateTip(s) {
    const bits = [validityTip(s)];
    if (s.kind === 'file') {
      bits.push('直链：免登录、指向文件的当前内容');
      bits.push('文件被删除 / 改名 / 移动时自动失效');
    } else {
      if (s.maxVisits) bits.push(`最多 ${s.maxVisits} 次访问（已用 ${s.visits || 0}）`);
      else bits.push('不限次数');
      if (s.hasPassword) bits.push('需要提取码');
    }
    return bits.join(' · ');
  }

  /** 「永久」小徽章：让"永久有效"一眼可见（用户要求显式标出来） */
  function permChip(s) {
    if (!isPermanent(s) || !s.alive) return '';
    return `<span class="lm-perm" title="${esc(stateTip(s))}">永久</span>`;
  }

  /* ---------------------------------------------------------------------
     过滤 / 排序
     ------------------------------------------------------------------ */
  function visibleItems() {
    const q = state.q.trim().toLowerCase();
    let list = state.items.filter((s) => {
      if (state.kind !== 'all' && s.kind !== state.kind) return false;
      if (state.status === 'alive' && !s.alive) return false;
      if (state.status === 'dead' && s.alive) return false;
      if (!q) return true;
      // ★ 把「映射:路径」这个**界面上看得见的形式**也纳入搜索 ★
      //   否则用户复制副标题里的 "D盘:/旧/old.zip" 粘进来搜不到 —— 很难解释。
      return [s.name, s.path, s.mount, s.note, s.token, KIND_LABEL[s.kind],
        `${s.mount}:${s.path}`]
        .some((v) => String(v || '').toLowerCase().includes(q));
    });

    const dir = state.desc ? -1 : 1;
    const key = {
      created: (s) => s.createdAt || 0,
      accessed: (s) => s.lastAccessAt || 0,
      count: (s) => accessCount(s),
      name: (s) => String(s.name || s.path || '').toLowerCase(),
    }[state.sort];
    list = list.slice().sort((a, b) => {
      const ka = key(a), kb = key(b);
      if (ka === kb) return (b.createdAt || 0) - (a.createdAt || 0);
      return ka > kb ? dir : -dir;
    });
    return list;
  }

  /* ---------------------------------------------------------------------
     子对话框
     ------------------------------------------------------------------ */

  /** 给自建对话框挂 Esc 关闭。
   *
   * ★ 为什么需要这个 ★
   *   `Dialog.custom` **本身不绑 Esc**（只有 `Dialog.confirm` 绑）。
   *   而本面板的逃生路径是「Esc 关最上面那层」—— 子对话框不接，
   *   Esc 就会卡在子对话框上、面板也关不掉（用户会以为卡死）。
   *
   * ★ 为什么判断"我是最上面那层" ★
   *   面板自己也有一个 capture 阶段的总 Esc 监听（且比子框先注册）。
   *   不做判断的话，一次 Esc 会把**子框 + 面板一起关掉**。
   *   这里用 `:last-child` 语义（最后一个 .modal-mask.open）来判定。
   */
  function escClose(dlg) {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const open = document.querySelectorAll('.modal-mask.open');
      if (open.length && open[open.length - 1] !== dlg.mask) return;
      document.removeEventListener('keydown', onKey, true);
      dlg.close();
    };
    document.addEventListener('keydown', onKey, true);
  }

  /** 二维码：本地生成，可复制可下载 */
  function showQR(s) {
    const url = fullUrl(s);
    const dlg = Dialog.custom({ title: `二维码 · ${s.name || s.path}`, maskClose: false });
    escClose(dlg);
    let svg = '';
    try {
      svg = QR.svg(url, { size: 260, margin: 3 });
    } catch (e) {
      svg = '';
    }
    // ★ 布局：二维码**居中**、文字放**下面**（用户要求）★
    //   原来是「左图右文」两栏 —— 在窄弹窗里右边那栏被挤成一条细缝，
    //   而二维码本身才是主角。竖排后：图形居中、说明在下，手机扫码时看着也顺。
    dlg.el.innerHTML = `
      <div class="lm-qr">
        ${svg ? `<div class="lm-qr-img">${svg}</div>`
              : `<div class="lm-empty">内容过长，无法生成二维码</div>`}
        <div class="lm-qr-kind">
          <span class="share-kind ${s.kind === 'file' ? 'kind-file' : 'kind-share'}">
            ${KIND_LABEL[s.kind]}</span>
          <span class="lm-qr-name">${esc(s.name || s.path || '(未命名)')}</span>
        </div>
        <div class="lm-qr-url"><code>${esc(url)}</code></div>
        <div class="share-hint lm-qr-hint">
          手机相机 / 微信扫一扫即可打开。<br>
          ${isPermanent(s)
            ? `免登录、<b>永久有效</b>。${s.kind === 'file' ? '谁拿到都能看，别贴到公开的地方。' : '请只发给信任的人。'}`
            : `免登录、<b>${validityText(s)}</b>（至 ${fmtTimeFull(s.expiresAt)}）。`
              + `${s.kind === 'file' ? '谁拿到都能看，' : ''}请只发给信任的人。`}
          ${s.kind === 'file' ? '' : (s.hasPassword ? '（需要提取码）' : '')}
        </div>
      </div>`;
    dlg.foot.innerHTML = `
      <button class="btn" data-role="copy">复制地址</button>
      <button class="btn" data-role="dl">下载 SVG</button>
      <button class="btn primary" data-role="close">关闭</button>`;
    dlg.foot.querySelector('[data-role="close"]').onclick = () => dlg.close();
    dlg.foot.querySelector('[data-role="copy"]').onclick = () => copyText(url);
    const dl = dlg.foot.querySelector('[data-role="dl"]');
    if (!svg) dl.disabled = true;
    dl.onclick = () => {
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `qr-${(s.name || s.token).replace(/[\\/:*?"<>|]/g, '_')}.svg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
  }

  /** 编辑分享参数。直链只能改备注（后端也只接受改备注）。 */
  function showEdit(s, onDone) {
    const isFile = s.kind === 'file';
    const dlg = Dialog.custom({ title: `编辑 · ${s.name || s.path}`, maskClose: false });
    dlg.el.innerHTML = `
      <div class="field">
        <label>备注（只有自己看得到）</label>
        <input type="text" data-role="note" maxlength="80"
               value="${esc(s.note || '')}" placeholder="例如：发给张工的方案">
      </div>
      <div class="field">
        <label>有效期</label>
        <select data-role="ttl">
          <option value="${KEEP}">不修改（当前：${s.expiresAt
            ? `${validityText(s)}，至 ${fmtTimeFull(s.expiresAt)}` : '永久有效'}）</option>
          <option value="1">改为 1 天后到期</option>
          <option value="7">改为 7 天后到期</option>
          <option value="30">改为 30 天后到期</option>
          <option value="0">改为永久有效</option>
        </select>
      </div>
      ${isFile ? `
        <div class="share-hint">
          直链现在<b>默认 7 天有效</b>（与分享同规格）；续期就是改这里。
          它指向文件的<b>当前内容</b> —— 文件被删除 / 改名 / 移动时也会自动失效。<br>
          直链没有提取码 / 次数上限；需要这些请用右键菜单里的「分享」另建一条。
        </div>` : `
      <div class="field">
        <label>访问次数上限</label>
        <select data-role="visits">
          <option value="${KEEP}">不修改（当前：${s.maxVisits ? `限 ${s.maxVisits} 次` : '不限次数'}）</option>
          <option value="0">不限次数</option>
          <option value="1">仅 1 次</option>
          <option value="5">5 次</option>
          <option value="20">20 次</option>
          <option value="100">100 次</option>
        </select>
      </div>
      <div class="field">
        <label class="lm-inline">
          <input type="checkbox" data-role="pwchg">
          <span>修改提取码（当前：${s.hasPassword ? '需要提取码' : '无' }）</span>
        </label>
        <input type="text" data-role="pw" maxlength="32" disabled
               placeholder="留空 = 取消提取码">
      </div>`}`;
    dlg.foot.innerHTML = `
      <button class="btn" data-role="cancel">取消</button>
      <button class="btn primary" data-role="save">保存</button>`;
    dlg.foot.querySelector('[data-role="cancel"]').onclick = () => dlg.close();

    const q = (r) => dlg.el.querySelector(`[data-role="${r}"]`);
    if (!isFile && q('pwchg')) {
      q('pwchg').onchange = (e) => {
        q('pw').disabled = !e.target.checked;
        if (e.target.checked) q('pw').focus();
      };
    }
    dlg.foot.querySelector('[data-role="save"]').onclick = async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      const patch = { note: q('note').value.trim() };
      // 有效期两类都能改（直链默认 7 天）
      if (q('ttl').value !== KEEP) patch.ttlDays = Number(q('ttl').value);
      if (!isFile) {
        if (q('visits').value !== KEEP) patch.maxVisits = Number(q('visits').value);
        if (q('pwchg').checked) patch.password = q('pw').value.trim();
      }
      try {
        await API.linkUpdate(s.token, patch);
        Toast.ok('已保存', '设置已更新');
        dlg.close();
        if (onDone) await onDone();
      } catch (e) {
        btn.disabled = false;
        Toast.error('保存失败', e.message);
      }
    };
  }

  /* ---------------------------------------------------------------------
     主面板
     ------------------------------------------------------------------ */
  function open() {
    const dlg = Dialog.custom({ title: '链接管理', wide: true, maskClose: false });
    // .dialog.wide 只有 760px，放不下"类型 + 状态 + 排序 + 操作组"
    const box = dlg.mask.querySelector('.dialog');
    if (box) box.classList.add('links');
    // 筛选条件刻意**保留**（用户下次打开还在同一种视图）；勾选态则清空 ——
    // 隔一次打开还留着"已选 3 条"，下次点批量撤销就是误伤。
    state.sel.clear();

    dlg.el.innerHTML = `
      <div class="lm">
        <div class="lm-stats" data-role="stats"></div>
        <div class="lm-bar">
          <label class="lm-all" title="全选当前筛选结果（不是全部数据）">
            <input type="checkbox" data-role="all">
            <span>全选<b class="lm-all-n" data-role="allcount"></b></span>
          </label>
          <div class="lm-search">
            <span class="lm-search-icon">${Icons.ui('search', 14)}</span>
            <input type="text" data-role="q" placeholder="搜索名称 / 路径 / 备注 / 地址">
            <button class="lm-clear" data-role="qclear" title="清空" hidden>&times;</button>
          </div>
          <select data-role="kind" title="类型">
            <option value="all">全部类型</option>
            <option value="file">直链 /f/</option>
            <option value="share">分享 /s/</option>
          </select>
          <select data-role="status" title="状态">
            <option value="all">全部状态</option>
            <option value="alive">仅有效</option>
            <option value="dead">仅已失效</option>
          </select>
          <select data-role="sort" title="排序">
            <option value="created">按创建时间</option>
            <option value="accessed">按最近访问</option>
            <option value="count">按访问次数</option>
            <option value="name">按名称</option>
          </select>
          <button class="btn small" data-role="dir" title="升降序">↓</button>
          <button class="btn small" data-role="refresh" title="刷新">刷新</button>
        </div>
        <div class="lm-bulk" data-role="bulk" hidden></div>
        <div class="lm-list" data-role="list"></div>
      </div>`;

    dlg.foot.innerHTML = `
      <button class="btn" data-role="sweep" style="margin-right:auto">清理失效链接</button>
      <button class="btn" data-role="csv">导出 CSV</button>
      <button class="btn primary" data-role="close">关闭</button>`;

    const root = dlg.el;
    const el = (r) => root.querySelector(`[data-role="${r}"]`);
    const listBox = el('list');
    const bulkBox = el('bulk');
    const statsBox = el('stats');

    /* ---- 统计 ---- */
    function renderStats() {
      const n = state.items.length;
      const nf = state.items.filter((s) => s.kind === 'file').length;
      const ns = n - nf;
      const dead = state.items.filter((s) => !s.alive).length;
      const visits = state.items.reduce((a, s) => a + accessCount(s), 0);
      const last = state.items.reduce((a, s) => Math.max(a, s.lastAccessAt || 0), 0);
      const perm = state.items.filter((s) => s.alive && isPermanent(s)).length;
      const cell = (v, k, cls) =>
        `<div class="lm-stat ${cls || ''}"><b>${v}</b><span>${k}</span></div>`;
      statsBox.innerHTML =
        cell(n, '条链接') + cell(nf, '直链') + cell(ns, '分享')
        + cell(perm, '永久有效')
        + cell(dead, '已失效', dead ? 'warn' : '')
        + cell(visits, '累计访问')
        + `<div class="lm-stat"><b class="lm-stat-time">${last ? fmtTime(last) : '—'}</b>
             <span>最近访问</span></div>`;
    }

    /* ---- 选中态：主控勾选框 + 批量条 + 行内勾选框 ---- */
    //
    // ★ 三个状态永远一起更新，别只改一个 ★
    //   主控框（全选 / 半选 indeterminate）、批量条（数字与按钮）、
    //   每一行的 checked —— 任何一处漏了，界面就会自相矛盾
    //   （例如"已选 3 条"但看不到哪三行被勾）。
    function syncSelection() {
      const vis = visibleItems();
      const selVis = vis.filter((s) => state.sel.has(s.token)).length;

      const master = el('all');
      if (master) {
        master.checked = vis.length > 0 && selVis === vis.length;
        // 半选：选了但没选全。HTML 里 indeterminate 只能由 JS 设，不能写属性
        master.indeterminate = selVis > 0 && selVis < vis.length;
      }
      const cnt = el('allcount');
      if (cnt) cnt.textContent = vis.length ? String(vis.length) : '';

      listBox.querySelectorAll('.lm-item').forEach((rowEl) => {
        const cb = rowEl.querySelector('[data-role="sel"]');
        if (cb) cb.checked = state.sel.has(rowEl.dataset.token);
      });

      renderBulk();
    }

    /** 批量条：把"能对一批链接做的事"一次给全 */
    function renderBulk() {
      const k = state.sel.size;
      if (!k) { bulkBox.hidden = true; bulkBox.innerHTML = ''; return; }
      bulkBox.hidden = false;
      const hasShare = state.items.some((s) => state.sel.has(s.token) && s.kind === 'share');
      bulkBox.innerHTML = `
        <span class="lm-bulk-n">已选 <b>${k}</b> 条</span>
        <button class="btn small" data-b="copy">复制地址</button>
        <button class="btn small" data-b="csv">导出所选</button>
        <select data-b="renew" class="lm-bulk-sel" title="批量修改有效性（只对分享有效）">
          <option value="">批量操作…</option>
          <option value="7">延长 7 天</option>
          <option value="30">延长 30 天</option>
          <option value="0">改为永久有效</option>
          <option value="novisit">解除次数限制</option>
        </select>
        ${hasShare ? '' : '<span class="lm-bulk-warn">（"解除次数限制"只对分享生效）</span>'}
        <button class="btn small ghost" data-b="invert">反选</button>
        <button class="btn small ghost" data-b="none">取消选择</button>
        <button class="btn small danger" data-b="kill">批量撤销</button>`;
    }

    /* ---- 列表 ---- */
    function renderList() {
      if (state.loading) {
        listBox.innerHTML = '<div class="lm-empty">正在载入…</div>';
        return;
      }
      if (state.err) {
        listBox.innerHTML = `<div class="lm-empty err">载入失败：${esc(state.err)}</div>`;
        return;
      }
      if (!state.items.length) {
        listBox.innerHTML = `<div class="lm-empty">
          还没有任何链接。<br>
          <span class="share-hint">在文件上右键「分享」即可一次拿到分享链接与直链。</span>
        </div>`;
        return;
      }
      const rows = visibleItems();
      if (!rows.length) {
        listBox.innerHTML = `<div class="lm-empty">
          没有匹配的链接。<br>
          <span class="share-hint">试试清空搜索词，或把「类型 / 状态」改回「全部」。</span>
        </div>`;
        return;
      }

      listBox.innerHTML = rows.map((s) => {
        const isFile = s.kind === 'file';
        const checked = state.sel.has(s.token) ? ' checked' : '';
        const sub = [
          `${s.mount}${s.path && s.path !== s.name ? ':' + s.path : ''}`,
          stateText(s),
          `${accessCount(s)} 次${isFile ? '打开' : '访问'}`,
          s.lastAccessAt ? `最近 ${fmtTime(s.lastAccessAt)}` : '从未被访问',
          s.hasPassword ? '有提取码' : '',
        ].filter(Boolean).join(' · ');

        return `
        <div class="lm-item${s.alive ? '' : ' dead'}" data-token="${esc(s.token)}">
          <label class="lm-check" title="选择">
            <input type="checkbox" data-role="sel"${checked}>
          </label>
          <div class="lm-main">
            <div class="lm-name">
              <span class="share-kind ${isFile ? 'kind-file' : 'kind-share'}">${KIND_LABEL[s.kind]}</span>
              <span class="lm-title" title="${esc(stateTip(s))}">${esc(s.name || s.path || '(未命名)')}</span>
              ${permChip(s)}
              ${s.note ? `<span class="lm-note" title="${esc(s.note)}">${esc(s.note)}</span>` : ''}
              ${s.alive ? '' : '<span class="lm-dead">已失效</span>'}
            </div>
            <div class="lm-sub" title="${esc(sub)}">${esc(sub)}</div>
            <div class="lm-url" title="${esc(fullUrl(s))}"><code>${esc(fullUrl(s))}</code></div>
          </div>
          <div class="lm-acts">
            <button class="btn small" data-act="copy">复制</button>
            <button class="btn small" data-act="open">打开</button>
            <button class="btn small" data-act="qr">二维码</button>
            <button class="btn small ghost" data-act="more" title="更多操作">⋯</button>
          </div>
        </div>`;
      }).join('');
    }

    function renderAll() {
      renderStats();
      renderList();      // ★ 先渲染行，syncSelection 才能把勾选框设对 ★
      syncSelection();
    }

    /* ---- 拉数据 ---- */
    async function refresh() {
      state.loading = true;
      state.err = '';
      renderList();
      try {
        const r = await API.links();
        state.items = r.items || [];
        // 清掉已经不存在的选中项（例如在别处被撤销了）
        const alive = new Set(state.items.map((s) => s.token));
        [...state.sel].forEach((t) => { if (!alive.has(t)) state.sel.delete(t); });
      } catch (e) {
        state.err = e.message || String(e);
        state.items = [];
      } finally {
        state.loading = false;
        renderAll();
      }
    }

    /* ---- 单条动作 ---- */
    async function doRotate(s) {
      const ok = await Dialog.confirm({
        title: '换一条地址',
        message: `会为「${s.name || s.path}」生成一条新的${KIND_LABEL[s.kind]}地址，`
          + '旧地址立刻失效（已经发出去的那条就打不开了）。'
          + '有效期、提取码、次数上限都保持不变。',
        okText: '换地址', danger: true,
      });
      if (!ok) return;
      try {
        const r = await API.linkRotate(s.token);
        const link = r.link || {};
        Toast.ok('已换地址', link.url || '');
        await refresh();
        if (link.url) copyText(link.url, link.url);
      } catch (e) {
        Toast.error('换地址失败', e.message);
      }
    }

    async function doRevoke(tokens) {
      if (!tokens.length) return;
      const names = tokens.length === 1
        ? `「${(state.items.find((x) => x.token === tokens[0]) || {}).name || '该链接'}」`
        : `选中的 ${tokens.length} 条链接`;
      const ok = await Dialog.confirm({
        title: '撤销链接',
        message: `撤销${names}？撤销后这些地址立即失效，且不可恢复。`,
        okText: '撤销', danger: true,
      });
      if (!ok) return;
      let done = 0;
      const failed = [];
      for (const t of tokens) {
        try { await API.linkRevoke(t); done++; state.sel.delete(t); }
        catch (e) { failed.push(t); }
      }
      if (done) Toast.ok(`已撤销 ${done} 条`);
      if (failed.length) Toast.error(`${failed.length} 条撤销失败`, '可能已被删除');
      await refresh();
    }

    async function doMore(s, btn) {
      const r = btn.getBoundingClientRect();
      const items = [
        {
          label: '编辑备注 / 参数…', icon: 'edit',
          onClick: () => showEdit(s, refresh),
        },
        {
          label: '换一条地址（旧地址失效）', icon: 'refresh',
          onClick: () => doRotate(s),
        },
      ];
      // 定位：打开该文件所在目录（后端保证 mount+path 是 owner 可见的）
      if (s.path) {
        items.push({
          label: '在网盘中定位', icon: 'folder',
          onClick: () => {
            Explorer.reveal(s.mount, s.path);
            closeAll();
          },
        });
      }
      items.push({ sep: true });
      items.push({
        label: '撤销这条链接', icon: 'trash', danger: true,
        onClick: () => doRevoke([s.token]),
      });
      ContextMenu.show(r.left, r.bottom + 4, items);
    }

    /* ---- 事件：列表（委托，避免每次重渲染都重绑）---- */
    listBox.addEventListener('click', (e) => {
      const row = e.target.closest('.lm-item');
      if (!row) return;
      const s = state.items.find((x) => x.token === row.dataset.token);
      if (!s) return;

      // 勾选框
      if (e.target.matches('[data-role="sel"]')) {
        if (e.target.checked) state.sel.add(s.token); else state.sel.delete(s.token);
        syncSelection();
        return;
      }
      // 行的空白/文字区 → 切换选中（像文件列表那样）
      const act = e.target.closest('[data-act]');
      if (!act) {
        if (e.target.closest('.lm-url') || e.target.closest('.lm-check')) return;
        if (state.sel.has(s.token)) state.sel.delete(s.token); else state.sel.add(s.token);
        syncSelection();
        return;
      }

      const a = act.dataset.act;
      if (a === 'copy') return copyText(fullUrl(s));
      if (a === 'open') {
        window.open(fullUrl(s), '_blank');
        return;
      }
      if (a === 'qr') return showQR(s);
      if (a === 'more') return doMore(s, act);
    });

    // 双击行 → 打开
    listBox.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.lm-item');
      if (!row || e.target.closest('[data-act]') || e.target.closest('[data-role="sel"]')) return;
      const s = state.items.find((x) => x.token === row.dataset.token);
      if (s) window.open(fullUrl(s), '_blank');
    });

    /* ---- 事件：批量条 ---- */
    bulkBox.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-b]');
      if (!b || b.tagName === 'SELECT') return;
      const action = b.dataset.b;
      const tokens = [...state.sel];
      const sel = state.items.filter((s) => state.sel.has(s.token));

      if (action === 'none') {
        state.sel.clear();
        syncSelection();
        return;
      }
      if (action === 'invert') {
        // 反选只作用于**当前筛选结果**（与"全选"同一口径，否则会误伤看不见的行）
        visibleItems().forEach((s) => {
          if (state.sel.has(s.token)) state.sel.delete(s.token);
          else state.sel.add(s.token);
        });
        syncSelection();
        return;
      }
      if (action === 'copy') {
        const urls = sel.map(fullUrl);
        return copyText(urls.join('\n'), `已复制 ${urls.length} 条地址`);
      }
      if (action === 'csv') return exportCSV(sel, '链接清单-所选');
      if (action === 'kill') return doRevoke(tokens);
    });

    // 批量续期 / 解除次数限制（只对分享有意义；直链没有这些维度）
    bulkBox.addEventListener('change', async (e) => {
      const s = e.target.closest('[data-b="renew"]');
      if (!s || !s.value) return;
      const mode = s.value;
      s.value = '';
      const sel = state.items.filter((x) => state.sel.has(x.token));
      // 「解除次数限制」只对分享有意义；「延长 / 永久」两类都有有效期，都能改
      const targets = sel.filter((x) => mode !== 'novisit' || x.kind === 'share');
      if (!targets.length) {
        return Toast.info('所选里没有分享',
          '直链没有次数上限，所以"解除次数限制"对它没用（改有效期请选上面几项）');
      }
      const patch = mode === 'novisit'
        ? { maxVisits: 0 }
        : { ttlDays: Number(mode) };
      const label = mode === 'novisit' ? '解除次数限制'
        : (Number(mode) === 0 ? '改为永久有效' : `延长 ${mode} 天`);

      let done = 0, failed = 0;
      for (const x of targets) {
        try { await API.linkUpdate(x.token, patch); done++; }
        catch (err) { failed++; }
      }
      if (done) Toast.ok('批量处理完成', `${label}：成功 ${done} 条${failed ? `，失败 ${failed} 条` : ''}`);
      if (failed && !done) Toast.error('批量处理失败', `${failed} 条都没成功`);
      await refresh();
    });

    /* ---- 导出 CSV（页脚=当前筛选结果；批量条=所选项）---- */
    function exportCSV(list, namePrefix) {
      const rows = list.filter(Boolean);
      if (!rows.length) return Toast.info('没有可导出的链接');
      const head = ['类型', '名称', '映射', '路径', '地址', '状态', '访问次数',
        '最近访问', '创建时间', '提取码', '备注'];
      const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
      const lines = [head.map(cell).join(',')];
      rows.forEach((s) => {
        lines.push([
          KIND_LABEL[s.kind], s.name, s.mount, s.path, fullUrl(s), stateText(s),
          accessCount(s),
          s.lastAccessAt ? fmtTimeFull(s.lastAccessAt) : '',
          s.createdAt ? fmtTimeFull(s.createdAt) : '',
          s.hasPassword ? '有' : '无', s.note || '',
        ].map(cell).join(','));
      });
      // ★ 加 BOM：否则 Excel 打开中文是乱码 ★
      const blob = new Blob(['\ufeff' + lines.join('\r\n')],
        { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${namePrefix}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      Toast.ok('已导出', `${rows.length} 条`);
    }

    /* ---- 事件：工具条 ---- */
    const qInput = el('q');
    const qClear = el('qclear');
    const bindFilter = (role, key) => {
      el(role).onchange = (e) => {
        state[key] = e.target.value;
        renderList();
        syncSelection();
      };
    };

    /* ★ 主控「全选」★
       口径是「当前**筛选结果**」而不是全部数据 —— 搜索/筛选之后点全选，
       用户期待的是"把我看得见的这些全选上"。所以标签里带上数量，
       并且用 indeterminate 表达"选了一部分"。 */
    el('all').onchange = (e) => {
      const vis = visibleItems();
      if (e.target.checked) vis.forEach((s) => state.sel.add(s.token));
      else vis.forEach((s) => state.sel.delete(s.token));
      syncSelection();
    };

    qInput.oninput = debounce(() => {
      state.q = qInput.value;
      qClear.hidden = !state.q;
      renderList();
      syncSelection();
    }, 120);
    qClear.onclick = () => {
      qInput.value = '';
      state.q = '';
      qClear.hidden = true;
      qInput.focus();
      renderList();
      syncSelection();
    };
    bindFilter('kind', 'kind');
    bindFilter('status', 'status');
    bindFilter('sort', 'sort');
    el('dir').onclick = (e) => {
      state.desc = !state.desc;
      e.currentTarget.textContent = state.desc ? '↓' : '↑';
      renderList();
      syncSelection();
    };
    el('refresh').onclick = () => refresh();

    /* ---- 事件：页脚 ---- */
    // 统一走 close()：它顺带摘掉 Esc 监听，否则关窗后 Esc 还会再去关一次
    // ★ Esc 只关**最上面那一层** ★
    //   面板里还会再开二维码 / 编辑子弹窗，若不判断层数，
    //   一次 Esc 会把两层一起关掉（用户会觉得"手滑丢了编辑内容"）。
    const closeAll = () => {
      document.removeEventListener('keydown', onKey, true);
      dlg.close();
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (document.querySelectorAll('.modal-mask.open').length > 1) return;
      closeAll();
    };
    document.addEventListener('keydown', onKey, true);

    dlg.foot.querySelector('[data-role="close"]').onclick = () => closeAll();

    dlg.foot.querySelector('[data-role="sweep"]').onclick = async () => {
      try {
        const r = await API.linkRevokeDead();
        Toast.ok('已清理', `删除了 ${r.revoked || 0} 条失效链接`);
        await refresh();
      } catch (e) { Toast.error('清理失败', e.message); }
    };

    dlg.foot.querySelector('[data-role="csv"]').onclick = () => exportCSV(visibleItems(), '链接清单');

    renderAll();
    refresh();
  }

  return { open, _state: state };
})();
