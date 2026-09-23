#!/usr/bin/env bash
# 逐点扫描窗口：证实「只有点中间才能前置」
set -uo pipefail
export PATH="/c/Users/HP/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/HP/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin:/c/Users/HP/.workbuddy/binaries/node/versions/24.21.0:/c/Windows/System32:/c/Windows:/usr/bin:$PATH"
S="grid$(date +%s)"; BASE="http://127.0.0.1:8089"; AB="agent-browser --session $S"
HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
OUT="$HERE/_grid_scan.out"; : > "$OUT"
log() { echo "$*" >> "$OUT"; echo "$*"; }
CJ="$HERE/_ck.txt"

curl -s -X POST "$BASE/api/login" -d "username=admin&password=${NEBULA_TEST_PASSWORD:-dev-pass-not-real}" -c "$CJ" -o /dev/null
TOK=$(awk '/nebula_session/{print $7}' "$CJ" 2>/dev/null | tr -d '\r\n')
$AB open "$BASE/" >/dev/null 2>&1
$AB cookies set nebula_session "$TOK" --url "$BASE/" --path / --httpOnly >/dev/null 2>&1
$AB open "$BASE/" >/dev/null 2>&1
sleep 3
runjs() { $AB eval "$(cat "$HERE/$1")" 2>/dev/null | tail -1; }

READY=0
for i in $(seq 1 20); do
  R=$(runjs _grid_ready.js)
  if grep -qE 'ready.*true' <<<"$R"; then READY=1; break; fi
  sleep 2
done
[ "$READY" = "1" ] || { log "❌ 页面未就绪: $R"; exit 1; }
log "就绪： $R"

V=$(runjs _raise_reset.js); log "清理： $V"; sleep 1
V=$(runjs _grid_open.js);   log "开窗： $V"; sleep 2
V=$(runjs _grid_scan.js);   log ""
log "═════════ 逐点命中 ═════════"
log "$V"
log ""
log "结果写入 $OUT"
