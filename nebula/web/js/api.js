/* ==========================================================================
   NebulaDisk —— API 客户端
   --------------------------------------------------------------------------
   所有与后端的交互都收敛在这里，好处：
     - 统一处理 401（会话过期 → 弹回登录页）
     - 统一把后端 {"error": "..."} 翻成异常，UI 层只需 try/catch
     - 表单类请求统一走 _form()，不用每处手写 FormData
   ========================================================================== */

const API = (() => {

  /** 后端返回的错误对象 */
  class ApiError extends Error {
    constructor(msg, status) {
      super(msg);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  // 会话过期的回调，由 app.js 注册（避免这里直接依赖 UI）
  let onUnauthorized = null;
  const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

  async function _parse(resp) {
    let data = null;
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { data = await resp.json(); } catch { data = null; }
    } else {
      try { data = await resp.text(); } catch { data = null; }
    }

    if (!resp.ok) {
      if (resp.status === 401 && onUnauthorized) onUnauthorized();
      const msg = (data && (data.error || data.detail || data.message))
        || (typeof data === 'string' && data.trim() ? data.trim().slice(0, 200) : '')
        || `请求失败 (HTTP ${resp.status})`;
      throw new ApiError(msg, resp.status);
    }
    return data;
  }

  /** GET */
  async function get(path, params) {
    let url = path;
    if (params) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) q.append(k, v);
      }
      const s = q.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    const resp = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' },
    });
    return _parse(resp);
  }

  function _form(fields) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) fd.append(k, v);
    }
    return fd;
  }

  /** POST（FormData） */
  async function post(path, fields) {
    const resp = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      body: fields instanceof FormData ? fields : _form(fields || {}),
    });
    return _parse(resp);
  }

  /** 带进度的上传（XHR 才能拿到 upload 事件） */
  function upload(fields, file, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = _form(fields);
      fd.append('file', file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload', true);
      xhr.withCredentials = true;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(e.loaded / e.total, e.loaded, e.total);
        }
      };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* 非 JSON 响应 */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          if (xhr.status === 401 && onUnauthorized) onUnauthorized();
          const msg = (data && (data.error || data.detail)) || `上传失败 (HTTP ${xhr.status})`;
          reject(new ApiError(msg, xhr.status));
        }
      };
      xhr.onerror = () => reject(new ApiError('网络错误，上传中断', 0));
      xhr.onabort = () => reject(new ApiError('上传已取消', 0));
      xhr.send(fd);
    });
  }

  return {
    ApiError,
    setUnauthorizedHandler,

    // ---- 会话 ----
    login:   (u, p) => post('/api/login', { username: u, password: p }),
    logout:  () => post('/api/logout', {}),
    me:      () => get('/api/me'),
    setPassword: (oldPw, newPw) => post('/api/password', { old: oldPw, new: newPw }),

    // ---- 浏览 ----
    list: (mount, path) => get('/api/list', { mount, path }),
    stat: (mount, path) => get('/api/stat', { mount, path }),

    // ---- 搜索 ----
    //   ★ 后端本来就是「递归 + 支持后缀名」的 ★
    //     需求（原文）：「网盘文件夹窗口上面的搜索功能 不支持后缀名和子文件夹
    //     的搜索」。后端 `/api/search` 从 task24 起就已经是
    //       · 递归（os.walk 到 _SEARCH_MAX_DEPTH 层，超出报 depthCapped）
    //       · 后缀名（`_search_terms` 会把 `.pdf` / `*.pdf` 都归一成 `pdf`，
    //         且 `_hit_rank` 里扩展名精确命中排第 3 档）
    //     真正缺的只是**前端从来没调过它** —— 搜索框一直在做本地
    //     `name.includes()`，所以既搜不了子目录也认不出后缀名。
    //   返回 { ok, terms, hits[], total, reachable, hasMore, scanned, depthCapped }
    //   每条 hit 自带 `path`（相对**挂载根**），据此才能显示/打开子目录里的命中项。
    search: (mount, q, path = '', limit = 500, offset = 0) =>
      get('/api/search', { mount, q, path, limit, offset }),


    // ---- 操作 ----
    mkdir:  (mount, path, name) => post('/api/mkdir', { mount, path, name }),
    createFile: (mount, path, name) => post('/api/create-file', { mount, path, name }),
    rename: (mount, path, name) => post('/api/rename', { mount, path, name }),
    remove: (mount, path) => post('/api/delete', { mount, path }),
    move:   (mount, path, target, isMove = true) =>
      post('/api/move', { mount, path, target, move: isMove }),
    upload,

    // 解压：dest 为空 → 解到同目录的「压缩包主名」文件夹
    extract: (mount, path, dest = '', overwrite = false) =>
      post('/api/extract', { mount, path, dest, overwrite }),

    // ---- 用户管理（仅管理员，后端 require_admin 兜底）----
    users:       () => get('/api/users'),
    userCreate:  (username, password, display = '', isAdmin = false) =>
      post('/api/users/create',
           { username, password, display, is_admin: String(!!isAdmin) }),
    userUpdate:  (username, { display, isAdmin } = {}) => {
      const f = { username };
      if (display !== undefined) f.display = display;
      if (isAdmin !== undefined) f.is_admin = String(!!isAdmin);
      return post('/api/users/update', f);
    },
    userPassword: (username, password) =>
      post('/api/users/password', { username, password }),
    userRename:   (username, newUsername) =>
      post('/api/users/rename', { username, new_username: newUsername }),
    userDelete:   (username) => post('/api/users/delete', { username }),
    userAudit:    (limit = 200) => get('/api/users/audit', { limit }),

    // ---- 管理员设置 ----
    getSettings:  () => get('/api/admin/settings'),
    saveSettings: (data) => post('/api/admin/settings', data),
    // 容器内真实存在的挂载点，供「新建映射」下拉选择（列表项含 writable / inUse）
    availableMounts: () => get('/api/admin/mounts/available'),

    // ---- 预览 ----
    previewUrl: (mount, path) => get('/api/preview', { mount, path }),
    cadUrl:     (mount, path) => get('/api/cad/preview', { mount, path }),
    ooConfig:   (mount, path) => post('/api/oo/config', { mount, path }),
    ooHealth:   () => get('/api/oo/health'),
    kkHealth:   () => get('/api/kk/health'),
    cadHealth:  () => get('/api/cad/health'),

    // ---- 分享 ----
    //   ttlDays=0 → 永久；maxVisits=0 → 不限次数；password='' → 无提取码
    shares:       () => get('/api/shares'),
    shareCreate:  (mount, path, { ttlDays = 7, maxVisits = 0, password = '', note = '' } = {}) =>
      post('/api/shares', { mount, path, ttl_days: ttlDays, max_visits: maxVisits, password, note }),
    shareRevoke:  (token) => post('/api/shares/revoke', { token }),
    shareUpdate:  (token, { note, ttlDays, maxVisits } = {}) => {
      const f = { token };
      if (note !== undefined) f.note = note;
      if (ttlDays !== undefined) f.ttl_days = ttlDays;
      if (maxVisits !== undefined) f.max_visits = maxVisits;
      return post('/api/shares/update', f);
    },

    // ---- 统一「链接」（直链 /f/ + 分享 /s/ 同一张表、同一套管理接口）----
    //   ★ 为什么是「统一」★
    //     用户报障原话：「网盘里面自带的分享也纳入一起，采用短链的方式分享。
    //     管理纳入一起。」⇒ 后端把两者并成一张 links 表（kind=file|share），
    //     管理面只留 /api/links 这一组。下面 shares() 那几个入口**仍然可用**
    //     （后端保留成兼容壳），但新代码一律走这一组。
    links:        (all = false) => get('/api/links', all ? { all: 1 } : {}),
    linkRevoke:   (token) => post('/api/links/revoke', { token }),
    linkRevokeDead: () => post('/api/links/revoke-dead'),
    //   换一条地址：撤销旧的并立刻签一条新的（目标与参数不变）——「旧地址立刻失效」
    linkRotate:   (token) => post('/api/links/rotate', { token }),
    linkUpdate:   (token, { note, ttlDays, maxVisits, password } = {}) => {
      const f = { token };
      if (note !== undefined) f.note = note;
      if (ttlDays !== undefined) f.ttl_days = ttlDays;
      if (maxVisits !== undefined) f.max_visits = maxVisits;
      if (password !== undefined) f.password = password;
      return post('/api/links/update', f);
    },
    //   直链签发：同一文件幂等复用同一个 12 字符 token，返回 { token, url, name }
    shortlink:    (mount, path, name = '') => post('/api/shortlink', { mount, path, name }),

    // ---- 下载（用 <a download> 触发，浏览器自己带 cookie） ----
    downloadUrl: (mount, path, inline = false) => {
      const q = new URLSearchParams({ mount, path });
      if (inline) q.append('inline', 'true');
      return '/api/download?' + q.toString();
    },
  };
})();
