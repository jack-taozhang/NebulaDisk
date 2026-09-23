/*
 * cad-client.js —— 由 cad-viewer 服务注入到查看器页面
 *
 * 三项能力，都不需要改动查看器源码：
 *
 *   1. 深链打开：?open=<图纸地址>&name=<文件名> 时自动把该文件喂给查看器。
 *      查看器的上传入口底层是 <input type="file">，构造 File 填入并派发
 *      change 事件即可复用它原本的打开流程。
 *
 *   2. 导出写回：查看器的所有导出都走
 *      「createObjectURL → a.download → a.click()」。拦截 a.click() 就能在
 *      不改各导出插件的前提下，把结果同时 POST 到网关落盘到「保存目录」，
 *      浏览器本地下载照常保留。
 *
 *   3. 浏览器标题改为文件名，便于多标签页时快速辨认。
 *
 * 注意：曾经还有一个「← 文件库」的返回入口，
 * 已按用户要求（任务 #68）删除 —— 查看器由网盘以页签/弹窗形式打开，
 * 自带关闭按钮，那个固定在左下角的浮标是重复入口。
 *
 * 接口地址可被外部覆盖：网关可在页面里先设定
 * window.__CAD_API_BASE__ / window.__LIB_URL__，这样本镜像保持独立，
 * 不写死部署路径。
 */
;(function () {
  'use strict'

  // 接口地址可由外部覆盖。
  // 因为本镜像是独立容器，页面通常由自己的端口提供，而文件读写由网关负责，
  // 两者不同源；同时网关也无法向本页面注入变量（跨源），
  // 所以这里优先从 URL 参数读取（由双击脚本带上），其次用同源默认值。
  var qs = new URLSearchParams(location.search)
  var API = qs.get('api') ||
    ((typeof window.__CAD_API_BASE__ === 'string' && window.__CAD_API_BASE__)
      ? window.__CAD_API_BASE__.replace(/\/+$/, '')
      : '/api')
  API = API.replace(/\/+$/, '')
  var LIB_URL = qs.get('lib') ||
    ((typeof window.__LIB_URL__ === 'string' && window.__LIB_URL__)
      ? window.__LIB_URL__
      : '/')

  var TOAST_ID = '__cad_toast__'
  var BASE_TITLE = 'DWG/DXF Viewer'

  function ensureToastHost () {
    var host = document.getElementById(TOAST_ID)
    if (host) return host
    host = document.createElement('div')
    host.id = TOAST_ID
    host.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'display:flex', 'flex-direction:column', 'gap:8px', 'pointer-events:none',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,' +
        '"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif'
    ].join(';')
    document.body.appendChild(host)
    return host
  }

  function notify (message, kind) {
    try {
      var host = ensureToastHost()
      var el = document.createElement('div')
      var accent = kind === 'err' ? '#e5484d' : kind === 'warn' ? '#e8a33d' : '#30a46c'
      el.style.cssText = [
        'pointer-events:auto', 'max-width:360px', 'padding:10px 14px',
        'border-radius:8px', 'border-left:4px solid ' + accent,
        'background:rgba(28,28,32,.94)', 'color:#f2f2f4', 'font-size:13px',
        'line-height:1.5', 'box-shadow:0 6px 22px rgba(0,0,0,.35)',
        'opacity:0', 'transform:translateY(8px)',
        'transition:opacity .18s ease,transform .18s ease'
      ].join(';')
      el.textContent = message
      host.appendChild(el)
      requestAnimationFrame(function () {
        el.style.opacity = '1'
        el.style.transform = 'translateY(0)'
      })
      setTimeout(function () {
        el.style.opacity = '0'
        el.style.transform = 'translateY(8px)'
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el) }, 220)
      }, kind === 'err' ? 6000 : 3200)
    } catch (e) { /* 提示失败不影响主流程 */ }
  }

  function formatSize (bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1048576).toFixed(2) + ' MB'
  }

  // ------------------------------------------------------------------
  // 标题：优先显示文件名，方便多标签页辨认
  // ------------------------------------------------------------------
  var linkedName = ''
  try {
    var m = location.search.match(/[?&]name=([^&]*)/)
    if (m) linkedName = decodeURIComponent(m[1])
  } catch (e) { /* 忽略 */ }

  function applyTitle () {
    try {
      document.title = linkedName ? (linkedName + ' - ' + BASE_TITLE) : BASE_TITLE
    } catch (e) { /* 忽略 */ }
  }

  /** 查看器自身可能会改标题，这里把它固定回文件名 */
  function pinTitle () {
    applyTitle()
    try {
      var desc = Object.getOwnPropertyDescriptor(Document.prototype, 'title')
      if (!desc || !desc.set) return
      Object.defineProperty(document, 'title', {
        configurable: true,
        get: function () { return desc.get.call(document) },
        set: function (v) {
          if (linkedName) desc.set.call(document, linkedName + ' - ' + BASE_TITLE)
          else desc.set.call(document, v)
        }
      })
    } catch (e) { /* 忽略 */ }
    // 兜底：有些实现直接改 <title> 元素
    setInterval(applyTitle, 2000)
  }

  // ------------------------------------------------------------------
  // 1. 导出写回
  // ------------------------------------------------------------------
  var POSTED = new WeakSet()

  function postToServer (blobUrl, fileName) {
    return fetch(blobUrl)
      .then(function (r) {
        if (!r.ok) throw new Error('读取导出内容失败')
        return r.blob()
      })
      .then(function (blob) {
        return fetch(API + '/save?name=' + encodeURIComponent(fileName), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: blob
        })
      })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status } })
      })
      .then(function (info) {
        if (info && info.ok) notify('已保存到保存目录：' + info.name, 'ok')
        else notify('写回保存目录失败：' + ((info && info.error) || '未知错误'), 'err')
      })
      .catch(function (err) {
        notify('写回保存目录失败：' + (err && err.message ? err.message : err), 'err')
      })
  }

  var origClick = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () {
    try {
      var isDownload = this.hasAttribute && this.hasAttribute('download')
      var href = this.getAttribute ? (this.getAttribute('href') || '') : ''
      if (isDownload && href.indexOf('blob:') === 0 && !POSTED.has(this)) {
        POSTED.add(this)
        postToServer(href, this.getAttribute('download') || 'export.bin')
      }
    } catch (e) { /* 拦截失败退化为普通下载 */ }
    return origClick.apply(this, arguments)
  }

  var origDispatch = EventTarget.prototype.dispatchEvent
  EventTarget.prototype.dispatchEvent = function (evt) {
    try {
      if (evt && evt.type === 'click' && this instanceof HTMLAnchorElement &&
          this.hasAttribute('download') && !POSTED.has(this)) {
        var href = this.getAttribute('href') || ''
        if (href.indexOf('blob:') === 0) {
          POSTED.add(this)
          postToServer(href, this.getAttribute('download') || 'export.bin')
        }
      }
    } catch (e) { /* 忽略 */ }
    return origDispatch.apply(this, arguments)
  }

  // ------------------------------------------------------------------
  // 2. 深链打开
  // ------------------------------------------------------------------
  function fileNameFromUrl (raw) {
    try {
      var clean = String(raw).split('?')[0].split('#')[0]
      var seg = clean.split('/').filter(Boolean).pop() || 'drawing.dwg'
      return decodeURIComponent(seg)
    } catch (e) {
      return 'drawing.dwg'
    }
  }

  function openFromQuery () {
    var params = new URLSearchParams(location.search)
    var src = params.get('open')
    if (!src) return

    var name = params.get('name') || fileNameFromUrl(src)
    if (!linkedName) {
      linkedName = name
      applyTitle()
    }

    var attempts = 0
    var timer = setInterval(function () {
      attempts++
      var input = document.querySelector('input[type="file"]')
      if (!input) {
        if (attempts > 150) {
          clearInterval(timer)
          notify('未找到文件入口，打开失败', 'err')
        }
        return
      }
      clearInterval(timer)
      notify('正在读取 ' + name + ' …', 'ok')
      fetch(src, { credentials: 'same-origin' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status)
          return r.blob()
        })
        .then(function (blob) {
          if (blob.size === 0) throw new Error('文件为空')
          var ext = (name.split('.').pop() || '').toLowerCase()
          var type = ext === 'dxf' ? 'application/dxf' : 'application/octet-stream'
          var file = new File([blob], name, { type: type })
          var dt = new DataTransfer()
          dt.items.add(file)
          input.files = dt.files
          input.dispatchEvent(new Event('change', { bubbles: true }))
          notify('已打开 ' + name + '（' + formatSize(blob.size) + '）', 'ok')
        })
        .catch(function (err) {
          notify('打开失败：' + (err && err.message ? err.message : err), 'err')
        })
    }, 100)
  }


  function boot () {
    pinTitle()
    openFromQuery()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
