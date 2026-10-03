# ===========================================================================
#  OO 上游的公共代理设置 —— 被 nebula-front.conf 里两个 location `include`
#
#  ⚠️ 文件名必须**不是** .conf 结尾：
#     nginx 默认 `include /etc/nginx/conf.d/*.conf;` 会把它当**顶层**配置读，
#     而这些 proxy_set_header 指令在 http 上下文里是非法的 ⇒ nginx 起不来。
#     所以用 .inc，只由我们自己显式 include。
# ===========================================================================

proxy_http_version 1.1;

# ★★ 铁律 1：必须透传浏览器看到的 Host ★★
#   不转发的话，nginx 会把 Host 设成上游名（onlyoffice），
#   OO 就按这个 Host 拼**绝对 URL**（文档二进制 /cache/files/.../Editor.bin、
#   静态资源…）⇒ 浏览器去解析 http://onlyoffice/ 必然失败 ⇒ 编辑器弹「下载失败」。
#   （同一个坑我们在 Python 反代里踩过，见技能 onlyoffice-embed-troubleshooting。）
#   ✅ 2026-10-03 起改用 `$fwd_host`（定义在 nebula-front.conf 的 map 里）：
#      它优先取 **Referer 还原出的「浏览器真正在用的主机」**，没有 Referer 才退回 $http_host。
#      原因：飞牛 App 的 webview 代理会**改写 Host**（把 office.app.5ddd.com:35359
#      换成 nebuladisk-main.alumaple.fnos.net），导致 OO 按错的主机生成文档下载地址
#      ⇒ 手机端请求发不出去 ⇒ 编辑器报「下载失败」。详见 nebula-front.conf 里的长注释。
proxy_set_header Host $fwd_host;
proxy_set_header X-Forwarded-Host $fwd_host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
# ★ 同上：协议也用 $fwd_proto（同样优先跟随 Referer 的 scheme）。
#   不能写 $scheme —— 那会把 https 访问算成 http（混合内容被拦）。
proxy_set_header X-Forwarded-Proto $fwd_proto;

# ★★ 铁律 2：原样转发 Accept-Encoding ★★
#   OO 的资源是 gzip 的：sdk-all.js 压缩后 4.7MB、未压缩 28.8MB（差 6 倍）。
#   这里必须透传，**绝对不要**在 OO 的 location 上加 `gzip on`
#   （那会变成对已压缩内容再压一次，白烧 CPU 还可能出错）。
#   客户端没发该头时这里会置空 ⇒ nginx 直接不发该头 ⇒ OO 返回未压缩，语义正确。
proxy_set_header Accept-Encoding $http_accept_encoding;

# WebSocket：/doc/<key>/c/ 是 OO 编辑器的协作通道，没有它编辑器起不来。
# 注意 `$connection_upgrade` 这个 map 定义在 nebula-front.conf 里。
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;

# ⚠️ 这里**故意不设 proxy_buffering** —— 由各个 location 自己决定：
#    · 走缓存的静态资源（①a）→ 必须 `on`，否则缓存写不进去（见 _oo-cache.inc）
#    · 文档二进制 / WebSocket（①b、②）→ 保持 `off`，边收边发
#    曾经在这里统一写死 off，结果把服务端缓存整个废掉了（实测 cache 目录
#    0 个文件、X-OO-Cache 永远 MISS），排查了半天。
#    公共片段不该替调用者做这种决定。

# 编辑器会话可以挂很久，别让默认 60s 读超时把连接掐掉
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;

# ★★ 铁律 3：**错误响应绝不许长缓存**（2026-10-04）★★
#
#   上游 OO 的 nginx 对**所有**状态码都发
#       `Cache-Control: public, max-age=31536000, immutable`
#   ——**404 也不例外**。实测同一路径连请求 3 次：
#       第 1 次 MISS → 第 2、3 次 `cf-cache-status: HIT`
#   ⇒ 一次上游抖动产生的 404 会被 **CF 边缘 + 浏览器** 同时缓存**一年**，
#     编辑器从此打不开，且只有用户手动清缓存才恢复。
#
#   `$oo_cc_safe` 定义在 nebula-front.conf 的 map 里：
#       2xx/3xx → 原样透传上游的 Cache-Control（它才是权威）
#       4xx/5xx → `no-store`
#
#   ⚠️ 必须配 `proxy_hide_header`：不摘掉上游那个头，
#      `add_header` 会**再发一个**同名头，客户端看到两个 Cache-Control
#      时行为未定义（浏览器通常取第一个 ⇒ 修改等于没生效）。
#   ⚠️ `always` 必须有：不加它，add_header 只对 2xx/3xx 生效，
#      4xx 反而拿不到我们写的 no-store。
#   ⚠️ 放在 _oo-proxy.inc（而不是各 location）是因为**五个 OO location
#      全都 include 它** ⇒ 一处覆盖全部，不会再出现"漏改一个 location"。
proxy_hide_header Cache-Control;
add_header Cache-Control $oo_cc_safe always;
