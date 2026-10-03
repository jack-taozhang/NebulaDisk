#!/bin/sh
# =============================================================================
#  oo-tmpclean.sh —— 自动清理 onlyoffice 容器的 /tmp（2GB tmpfs）
#
#  【为什么需要它】2026-10-04 事故
#    OO 的 converter 会把**下载下来的源文档**写进 /tmp/ASC_CONVERT*/source。
#    容器的 /tmp 是我们自己在 compose 里挂的 2GB tmpfs
#    （`tmpfs: - /tmp:rw,exec,size=2G,mode=1777`，见 deploy/docker-compose.yml）。
#    它一旦被占满，**每一次**转换都失败 ⇒ 编辑器弹
#    「打开文件时发生错误」，docservice/out.log 里是：
#        receiveTask Error: ENOSPC: no space left on device, write
#          at Object.writeSync (node:fs:933:3)
#          at downloadFile (.../FileConverter/sources/converter.js)
#    ⚠️ 注意此时**宿主磁盘 df 看着还有 7TB** —— 不要去查磁盘，要查容器内的 /tmp：
#        docker exec onlyoffice df -h /tmp
#
#    实测两个来源（都很常见）：
#      ① 手工「清 OO 缓存」时把 App_Data/cache 改名挪进 /tmp 当备份，之后忘了清（1.3G）
#         ★ tmpfs 是内存，往里面放"备份"= 白烧 RAM + 迟早撑满自己
#      ② 转换失败路径上没回收的 ASC_CONVERT*（实测两个残留各带 316M / 439M）
#
#  【策略】保守：只碰「OO 自己的临时物」，绝不误伤用户放在 /tmp 的文件
#    · 只删 /tmp **顶层**、名字匹配 OO 临时特征、且**闲置 ≥ IDLE_MIN 分钟**的条目
#      （一次转换最长也就几分钟，60 分钟足够避开"正在写"的东西）
#    · 名字不匹配的一律不碰（.cache / *.py / *.xlsx 之类）
#    · 用量 > HARD_PCT 时再来一遍「放宽到 HARD_MIN 分钟」的攻击性清理
#    · 若两轮之后仍然 > 95%，只**记录**一份 du top5 便于定位，不删未知文件
#    · 每次跑都往日志追加一行（含 before/after 百分比），日志自带 500 行截断
#
#  【安装】由 root 的 cron 每小时跑一次（NAS 上 cron 是 active 的）：
#      sudo cp deploy/oo-tmpclean.sh /vol1/1000/NebulaDisk/onlyoffice/oo-tmpclean.sh
#      sudo chmod +x /vol1/1000/NebulaDisk/onlyoffice/oo-tmpclean.sh
#      (crontab -l; echo '17 * * * * /vol1/1000/NebulaDisk/onlyoffice/oo-tmpclean.sh') | crontab -
#      # 卸装：crontab -l | grep -v oo-tmpclean | crontab -
#    手工跑一次看效果：sudo /vol1/1000/NebulaDisk/onlyoffice/oo-tmpclean.sh
#    看日志：tail -20 /vol1/1000/NebulaDisk/onlyoffice/tmpclean.log
#
#  【为什么不干脆把 tmpfs 调大】调 size 要 `docker rm` + `up` 重建容器，
#    而 OO 的 /etc/onlyoffice/documentserver/local.json **不在挂载卷上**
#    （compose 里明确注释了为什么不挂：bind mount 会让 entrypoint 的
#      「写临时文件再 rename」报 EBUSY ⇒ 配置注入失败）。
#    ⇒ 重建容器会**丢掉** JWT 密钥、allowPrivateIPAddress、大文件上限这些设置
#      （宿主备份在 ./onlyoffice/local.json，要手工重打）。
#    所以优先做「自动清理」；确实要改 size 时，按上面流程重打一遍 local.json。
# =============================================================================
set -u

# ★ cron 的环境极简（PATH 往往只有 /usr/bin:/bin），显式给全，免得 `docker` 找不到 ★
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

CONTAINER=onlyoffice
LOG=/vol1/1000/NebulaDisk/onlyoffice/tmpclean.log
IDLE_MIN=60        # 常规：闲置超过 60 分钟才删
HARD_MIN=10        # 兜底：用量过高时放宽到 10 分钟
HARD_PCT=85        # 超过这个百分比就做兜底那一轮
WARN_PCT=95        # 两轮后还超这个数：只记证据、不删未知文件

# 容器不在（重启中/被停）就安静退出 —— cron 不该因此发告警邮件
docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER" || exit 0

# /tmp 使用率（0-100 的整数）；取不到就退出
pct() {
    docker exec "$CONTAINER" df --output=pcent /tmp 2>/dev/null \
        | tail -1 | tr -dc '0-9'
}

# $1 = 闲置分钟数。只匹配 OO 临时物的命名特征 + 顶层。
clean() {
    docker exec "$CONTAINER" sh -c "find /tmp -maxdepth 1 -mmin +$1 \
        \\( -name 'ASC_*' -o -name 'old-cache*' -o -name '*-cache-*' \
           -o -name 'onlyoffice-tmp*' \\) -exec rm -rf {} +" >/dev/null 2>&1
    return 0
}

before=$(pct)
[ -n "$before" ] || exit 0

clean "$IDLE_MIN"
after=$(pct)

extra=""
if [ "${after:-0}" -gt "$HARD_PCT" ]; then
    clean "$HARD_MIN"
    after=$(pct)
    extra="  (兜底轮:>=${HARD_MIN}min)"
fi

# 两轮都没压下去：把「谁占的」记下来，方便下次定位（只记录，不删）
if [ "${after:-0}" -gt "$WARN_PCT" ]; then
    extra="$extra  ⚠️ 仍 >${WARN_PCT}%: $(docker exec "$CONTAINER" \
        sh -c 'du -sh /tmp/* 2>/dev/null | sort -h | tail -5' | tr '\n' ';')"
fi

printf '%s  oo-tmp-clean  %s%% -> %s%%%s\n' \
    "$(date '+%F %T')" "$before" "$after" "$extra" >> "$LOG"

# 日志截断（只留最近 500 行）
if [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 500 ]; then
    tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

exit 0
