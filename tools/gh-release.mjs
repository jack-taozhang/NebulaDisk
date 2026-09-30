#!/usr/bin/env node
/**
 * 建 GitHub Release 并上传附件（幂等）。
 *
 * ★ 为什么不用 gh CLI / git push ★
 *   本机没有 `gh`；`git push` 会挂死（GCM 在非桌面 shell 卡住，见 gh-push-api.mjs）。
 *   Release 走 REST 完全不受影响（`api.github.com` 稳定）。
 *
 * ★ 三个必须记住的点 ★
 *   1. **附件上传的 host 不是 api.github.com，是 `uploads.github.com`**。
 *   2. `POST /releases {tag_name}` 会**自动建 tag**，并落在 `target_commitish` 上；
 *      建完务必回读 `GET /git/ref/tags/<tag>` 确认指向的提交对不对。
 *   3. **幂等**：先 `GET /releases/tags/<tag>`，200 就复用（别重复建）；
 *      同名附件先 `DELETE` 再传。
 *      ⚠️ **不要用新的 body 覆盖已存在的 Release** —— 原稿可能更好（"能改"≠"该改"）。
 *      本脚本默认**只在新建时写 body**，已存在时仅打印现有 body 供人工判断。
 *
 * 用法：
 *   node tools/gh-release.mjs --tag v0.2.24 --asset dist-package/siyuan-diskcanvas-v0.2.24.zip \
 *        [--target <sha|branch>] [--title "DiskCanvas 盘绘 v0.2.24"] \
 *        [--notes "markdown"] [--notes-file path.md] [--update-body]
 */
import { readFileSync, statSync } from "node:fs"
import { basename, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readGithubToken } from "./lib/github-cred.mjs"

const API = "https://api.github.com"
const UPLOADS = "https://uploads.github.com"
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const TAG = arg("tag")
const ASSET = arg("asset")
const TITLE = arg("title", TAG)
const TARGET = arg("target", "main")
let NOTES = arg("notes", "")
const NOTES_FILE = arg("notes-file")
const UPDATE_BODY = has("update-body")

if (!TAG || !ASSET) {
  console.error("用法: node tools/gh-release.mjs --tag <tag> --asset <zip路径> [--target sha|branch] [--title ...] [--notes ...|--notes-file ...] [--update-body]")
  process.exit(1)
}

if (NOTES_FILE) {
  NOTES = readFileSync(resolve(NOTES_FILE), "utf8")
}

// ── 凭据 / 仓库 ────────────────────────────────────────────
const TOKEN = await readGithubToken()

/**
 * ★ 不调 git 子进程：origin 直接读 `.git/config` ★
 *   本机沙箱下**同步族子进程一律 EBUSY**（execSync / execFileSync / spawnSync 全废，
 *   其中 spawnSync 还是「静默返回 null」这种最难查的形态）。取个 remote url
 *   不值得冒这个险 —— 同源修复见 tools/pack.js（网盘）与本仓库 MEMORY。
 */
function readOriginUrl() {
  const cfgPath = resolve(ROOT, ".git/config")
  try {
    const txt = readFileSync(cfgPath, "utf8")
    const block = txt.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/)
    const url = block && block[1].match(/^\s*url\s*=\s*(.+)$/m)
    if (url) {
      return url[1].trim()
    }
  } catch {
    /* 落到下面的报错 */
  }
  throw new Error(`读不到 ${cfgPath} 里的 [remote "origin"] url`)
}
const remoteUrl = readOriginUrl()
const slugMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
if (!slugMatch) throw new Error(`无法解析 owner/repo：${remoteUrl}`)
const SLUG = `${slugMatch[1]}/${slugMatch[2]}`

// ── 入参校验 ───────────────────────────────────────────────
const assetPath = resolve(ASSET)
const size = statSync(assetPath).size
console.log(`仓库 : ${SLUG}`)
console.log(`tag  : ${TAG}`)
console.log(`附件 : ${basename(assetPath)} (${size} bytes)`)
if (size < 1000) {
  console.error("✗ 附件太小，疑似不是安装包，已中止")
  process.exit(1)
}

/**
 * ★ 注意签名：payload 是**独立参数**，不要塞进 options ★
 *   曾经写成 options 形式（`{body}`）时，建 Release 那处按直觉传了裸 payload 对象 ⇒
 *   GitHub 收到的是字符串而不是对象，报 422 "is not an object"。
 *   Release 的 payload 里**本来就有 `body` 字段**，和 options 的属性同名，极易混淆。
 */
async function req(method, url, payload, { ctype = "application/json", raw = false } = {}) {
  const body = raw ? payload : payload === undefined ? undefined : JSON.stringify(payload)
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "diskcanvas-gh-release",
      "Content-Type": ctype,
    },
    body,
  })
  const text = await res.text()
  let json = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { _raw: text.slice(0, 400) }
  }
  return { status: res.status, json }
}

function fail(msg, detail) {
  console.error(`\n✗ ${msg}`)
  if (detail) console.error(JSON.stringify(detail, null, 2).slice(0, 1200))
  process.exit(1)
}

// ── 解析 target 提交 ───────────────────────────────────────
let targetSha = TARGET
if (!/^[0-9a-f]{40}$/i.test(TARGET)) {
  const r = await req("GET", `${API}/repos/${SLUG}/git/ref/heads/${TARGET}`)
  if (r.status !== 200) fail(`取分支 ${TARGET} 的 HEAD 失败（${r.status}）`, r.json)
  targetSha = r.json.object.sha
}
console.log(`target: ${targetSha.slice(0, 8)}`)

// ── tag / Release 现状 ─────────────────────────────────────
const tagRes = await req("GET", `${API}/repos/${SLUG}/git/ref/tags/${TAG}`)
console.log(`\ntag 检查  : ${tagRes.status} ${tagRes.status === 200 ? "(已存在)" : "(不存在，将由建 Release 自动创建)"}`)

const relRes = await req("GET", `${API}/repos/${SLUG}/releases/tags/${TAG}`)
let release
if (relRes.status === 200) {
  release = relRes.json
  console.log(`Release   : 已存在 id=${release.id}`)
  if (release.target_commitish !== targetSha) {
    console.log(`  ⚠️ 已存在 Release 的 target_commitish=${release.target_commitish?.slice(0, 8)}（与本次 target 不同）`)
  }
  if (UPDATE_BODY) {
    const up = await req("PATCH", `${API}/repos/${SLUG}/releases/${release.id}`, {
      body: NOTES,
      name: TITLE,
    })
    console.log(`  已按要求更新 body/name（${up.status}）`)
  } else if (NOTES) {
    console.log("  ⓘ 已存在：**未覆盖** body（原稿可能更好）。确需覆盖请加 --update-body")
  }
} else {
  const created = await req("POST", `${API}/repos/${SLUG}/releases`, {
    tag_name: TAG,
    target_commitish: targetSha,
    name: TITLE,
    body: NOTES,
    draft: false,
    prerelease: false,
  })
  if (created.status !== 201 && created.status !== 200) fail(`建 Release 失败（${created.status}）`, created.json)
  release = created.json
  console.log(`Release   : 新建 id=${release.id}`)
}

// ── 上传附件（同名先删）────────────────────────────────────
const assetsRes = await req("GET", `${API}/repos/${SLUG}/releases/${release.id}/assets`)
if (assetsRes.status === 200 && Array.isArray(assetsRes.json)) {
  for (const a of assetsRes.json) {
    if (a.name === basename(assetPath)) {
      const del = await req("DELETE", `${API}/repos/${SLUG}/releases/assets/${a.id}`)
      console.log(`  删除同名旧附件 ${a.name}（id=${a.id}）→ ${del.status}`)
    }
  }
}

const blob = readFileSync(assetPath)
const up = await req(
  "POST",
  `${UPLOADS}/repos/${SLUG}/releases/${release.id}/assets?name=${encodeURIComponent(basename(assetPath))}`,
  blob,
  { ctype: "application/zip", raw: true },
)
if (up.status !== 201 && up.status !== 200) fail(`上传附件失败（${up.status}）`, up.json)
console.log(`附件上传  : ${up.json.name} ${up.json.size} bytes`)

// ── 回读校验 ───────────────────────────────────────────────
const tagVerify = await req("GET", `${API}/repos/${SLUG}/git/ref/tags/${TAG}`)
const obj = tagVerify.json?.object
console.log(`\ntag ${TAG} → type=${obj?.type} sha=${obj?.sha?.slice(0, 8)}`)
const tagOk = obj?.sha === targetSha
console.log(`  期望 target=${targetSha.slice(0, 8)} 匹配: ${tagOk ? "✓" : "✗"}`)

const finalRes = await req("GET", `${API}/repos/${SLUG}/releases/tags/${TAG}`)
const finalAssets = finalRes.json?.assets || []
console.log(`回读 Release: ${finalRes.json?.html_url}`)
for (const a of finalAssets) {
  console.log(`   asset ${a.name}  ${a.size} bytes`)
}
const assetOk = finalAssets.some((a) => a.name === basename(assetPath) && a.size === size)
console.log(`  附件大小匹配: ${assetOk ? "✓" : "✗"}`)

if (!tagOk || !assetOk) fail("回读校验未通过")

console.log("\nRELEASE_OK", finalRes.json?.html_url)
