#!/bin/bash
# 诊断 kkfileview 基础镜像里的 apt 源为什么装不上包
echo "=== /etc/resolv.conf ==="
cat /etc/resolv.conf
echo
echo "=== sources.list.d 内容 ==="
ls -la /etc/apt/sources.list.d/ 2>/dev/null
echo "--- ubuntu.sources ---"
cat /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null
echo "--- sources.list ---"
cat /etc/apt/sources.list 2>/dev/null
echo
echo "=== OS 版本 ==="
cat /etc/os-release 2>/dev/null | head -4
echo
echo "=== apt-get update ==="
apt-get update 2>&1 | tail -25
echo
echo "=== apt policy python3 ==="
apt-cache policy python3 2>&1 | head -10
