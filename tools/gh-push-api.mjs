#!/usr/bin/env node
/**
 * 用 **Git Data API 整树推送** 把本地 HEAD 推到远端分支。
 *
 * ★ 为什么需要它 ★
 *   `git push` 在本机会失败，而且**两条路都堵**：
 *     · 凭据侧：GCM（git-credential-manager）在**非桌面 shell** 里会自己卡住
 *       （实测 exit 124 挂死；根因有时是系统级 `credential.helper = helper-selector`，
 *        那个**交互式**选择器先跑并耗 ~39s，把整条命令拖到超时）；
 *     · 传输侧：`github.com` 的 HTTPS **时通时断**，实测两种报错 ——
 *       `curl 56 schannel: server closed abruptly (missing close_notify)`、
 *       `schannel: failed to receive handshake, SSL/TLS connection failed`。
 *   而 **`api.github.com` 一直稳** ⇒ 绕开 git 的传输与凭据链路，直接走 REST。
 *
 * ★★ 本脚本**不调用同步族子进程** ★★
 *   `execSync` / `execFileSync` / `spawnSync` 在本机沙箱**一律 EBUSY**
 *   （`spawnSync` 还是「静默返回 null」这种最难查的形态）
 *   ⇒ 所有 git 调用一律走**异步 `spawn`**。
 *   （同源修复：tools/pack.js、tools/gh-release.mjs、tools/lib/github-cred.mjs）
 *
 * ★ 与之配套的坑（都实测过）★
 *   1. 远端那个提交可能是**上一次用 API 建的** —— 与本地同 tree 但 SHA 不同，
 *      而本地**从未 fetch 到该对象** ⇒ 不能 `git diff <remote_head> HEAD`（exit 128）。
 *      改法：在本地提交链里找一个 **tree == base_tree** 的提交当 diff 基点。
 *   2. `github.com` 不通时 `git fetch` 拿不到对象 ⇒ 本地引用改用
 *      `git update-ref refs/remotes/origin/<branch> <本地同 tree 的提交>` 对齐。
 *   3. 远端历史会被**压成一个提交**（parents 只有远端 HEAD）。内容与本地 HEAD
 *      完全一致（脚本会逐字节比对 tree 并在不一致时中止），但提交粒度会丢。
 *
 * 用法：
 *   node tools/gh-push-api.mjs [--dry-run] [--branch main]
 *
 * 退出码：0 成功（含"已是最新"）；1 失败。
 */
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readGithubToken } from "./lib/github-cred.mjs"

const API = "https://api.github.com"
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")

const argv = process.argv.slice(2)
const DRY = argv.includes("--dry-run")
const branchIdx = argv.indexOf("--branch")
const BRANCH = branchIdx >= 0 ? argv[branchIdx + 1] : "main"

/**
 * ★ 异步跑 git ★
 * 同步族（execFileSync/spawnSync/execSync）在本机沙箱一律 EBUSY，
 * 所以这里是唯一的实现方式。带 timeout，避免 fetch 之类长命令挂死。
 */
function gitRun(args, timeout = 120000) {
  return new Promise((resolve_, reject_) => {
    const p = spawn("git", args, { cwd: ROOT })
    const out = []
    const err = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { p.kill() } catch { /* 忽略 */ }
      reject_(new Error(`git ${args.join(" ")} 超时（${timeout}ms）`))
    }, timeout)
    p.stdout.on("data", (d) => out.push(d))
    p.stderr.on("data", (d) => err.push(d))
    p.on("error", (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject_(e)
    })
    p.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = Buffer.concat(out)
      if (code !== 0) {
        const stderr = Buffer.concat(err).toString("utf8")
        reject_(new Error(`git ${args.join(" ")} → 退出码 ${code}\n${stderr.slice(0, 600)}`))
        return
      }
      resolve_({ text: stdout.toString("utf8").trim(), buf: stdout })
    })
  })
}
const git = (...args) => gitRun(args)
const gitText = async (...args) => (await gitRun(args)).text
const gitBuf = async (...args) => (await gitRun(args)).buf
const tryGit = async (args, timeout) => {
  try {
    return await gitRun(args, timeout)
  } catch {
    return null
  }
}

/**
 * 读 .git/config 解析 owner/repo。
 * ★ 同样不开子进程 —— 取个 remote url 不值得冒 EBUSY 的险，也不依赖环境变量。
 */
function parseSlug() {
  const cfgPath = resolve(ROOT, ".git/config")
  let txt = ""
  try {
    txt = readFileSync(cfgPath, "utf8")
  } catch {
    throw new Error(`读不到 ${cfgPath}`)
  }
  const block = txt.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/)
  const url = block && block[1].match(/^\s*url\s*=\s*(.+)$/m)
  if (!url) {
    throw new Error(`读不到 ${cfgPath} 里的 [remote "origin"] url`)
  }
  const m = url[1].trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!m) {
    throw new Error(`无法从 remote 解析 owner/repo：${url[1].trim()}`)
  }
  return `${m[1]}/${m[2]}`
}

const TOKEN = await readGithubToken()
const SLUG = parseSlug()

async function req(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "siyuan-gh-push",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  if (detail) {
    console.error(JSON.stringify(detail, null, 2).slice(0, 1200))
  }
  process.exit(1)
}

// ── 1) 本地状态 ─────────────────────────────────────────────
const localHead = await gitText("rev-parse", "HEAD")
const localTree = await gitText("rev-parse", "HEAD^{tree}")
const subject = await gitText("log", "-1", "--pretty=%s")
console.log(`仓库     : ${SLUG}`)
console.log(`本地 HEAD: ${localHead.slice(0, 8)}  tree ${localTree.slice(0, 8)}`)
console.log(`提交信息 : ${subject}`)

// ── 2) 远端 ref ────────────────────────────────────────────
const refRes = await req("GET", `/repos/${SLUG}/git/ref/heads/${BRANCH}`)
if (refRes.status !== 200) {
  fail(`取远端 ref 失败（${refRes.status}）`, refRes.json)
}
const remoteHead = refRes.json.object.sha
console.log(`远端 HEAD: ${remoteHead.slice(0, 8)}`)

if (remoteHead === localHead) {
  console.log("\n✓ 远端已是最新，无需推送")
  process.exit(0)
}

const commitRes = await req("GET", `/repos/${SLUG}/git/commits/${remoteHead}`)
if (commitRes.status !== 200) {
  fail(`取远端 commit 失败（${commitRes.status}）`, commitRes.json)
}
const baseTree = commitRes.json.tree.sha
console.log(`base_tree: ${baseTree.slice(0, 8)}`)

// ── 3) 找本地 diff 基点（tree == base_tree）─────────────────
const localCommits = (await gitText("log", "--format=%H", "-200")).split("\n").filter(Boolean)
let baseCommit = null
for (const c of localCommits) {
  if ((await gitText("rev-parse", `${c}^{tree}`)) === baseTree) {
    baseCommit = c
    break
  }
}
if (!baseCommit) {
  fail(
    "本地找不到 tree == base_tree 的提交。\n" +
      "  ⇒ 通常是本地历史上被压平过。先 `git fetch origin` 拿到远端对象再试。",
  )
}
console.log(`diff 基点: ${baseCommit.slice(0, 8)}（本地）`)

// ── 4) 列出改动 ────────────────────────────────────────────
// ★★ 非 ASCII 路径必须**原样**拿到（2026-10-01 实锤）★★
//   `git diff --name-status` 默认 `core.quotepath=true` ⇒ 非 ASCII 路径会被
//   **加引号 + C 转义**，例如：
//       ".workbuddy/memory/\346\212\200\346\234\257\347\273\206\350\212\202.md"
//   拿这个转义串去 `ls-tree` 必然取不到 blob ⇒ 该文件被「跳过」⇒ 建出的 tree
//   与本地 tree 不一致 ⇒ 脚本按设计**中止整个推送**。
//   现象极易误判成「推送工具坏了 / 网络不通」，其实是护栏在拦一个真差异。
//   ⇒ 用 `-z`（NUL 分隔）从根上避免任何加引号/转义。
//     ⚠️ `-z` 下的格式是 `status\0path\0`（改名是 `status\0旧\0新\0`），
//        和默认的 `status\tpath\n` 不一样，别混着解析。
const diff = await gitBuf("diff", "-z", "--name-status", baseCommit, localHead)
const f = diff.toString("utf8").split("\0")
const changes = []
for (let i = 0; i < f.length;) {
  const status = f[i]
  if (!status) { i++; continue }          // 末尾空段 / 连续 NUL
  const st = status[0]
  i++
  if (st === "R" || st === "C") {
    // 改名：删旧 + 增新
    changes.push({ status: "D", path: f[i] }); i++
    changes.push({ status: "A", path: f[i] }); i++
  } else {
    changes.push({ status: st, path: f[i] }); i++
  }
}
if (!changes.length) {
  console.log("\n✓ 无文件差异（内容已一致），仅移动引用")
}
console.log(`改动 ${changes.length} 项:`)
for (const c of changes) console.log(`   ${c.status}  ${c.path}`)

if (DRY) {
  console.log("\n--dry-run：到此为止，未写远端")
  process.exit(0)
}

// ── 5) 逐文件建 blob ───────────────────────────────────────
const treeItems = []
const skipped = []
for (const c of changes) {
  if (c.status === "D") {
    treeItems.push({ path: c.path, mode: "100644", type: "blob", sha: null })
    continue
  }
  // ★ `:(literal)` 关掉 pathspec 的通配解释（文件名里带 * / ? / [ 时不被当模式）；
  //   `--` 把后面的参数明确标成路径。两者都是「只按字面取这一个文件」。
  const ls = await gitText("ls-tree", localHead, "--", `:(literal)${c.path}`)
  if (!ls) {
    skipped.push([c.path, "ls-tree 为空"])
    continue
  }
  const [meta] = ls.split("\t")
  const [mode, type, sha] = meta.split(/\s+/)
  if (type === "commit") {
    skipped.push([c.path, "子模块"])
    continue
  }
  const raw = await gitBuf("cat-file", "blob", sha)
  const blobRes = await req("POST", `/repos/${SLUG}/git/blobs`, {
    content: raw.toString("base64"),
    encoding: "base64",
  })
  if (blobRes.status !== 201 && blobRes.status !== 200) {
    fail(`建 blob 失败：${c.path}（${blobRes.status}）`, blobRes.json)
  }
  treeItems.push({ path: c.path, mode, type: "blob", sha: blobRes.json.sha })
  console.log(`   blob ${c.path} → ${blobRes.json.sha.slice(0, 8)} (${raw.length}B)`)
}
if (skipped.length) {
  console.log(`   跳过 ${skipped.length} 项:`, skipped)
}

// ── 6) 建 tree ─────────────────────────────────────────────
const treeRes = await req("POST", `/repos/${SLUG}/git/trees`, {
  base_tree: baseTree,
  tree: treeItems,
})
if (treeRes.status !== 201 && treeRes.status !== 200) {
  fail(`建 tree 失败（${treeRes.status}）`, treeRes.json)
}
const newTree = treeRes.json.sha
console.log(`\nnew_tree : ${newTree.slice(0, 8)}`)
console.log(`本地 tree: ${localTree.slice(0, 8)}`)
if (newTree !== localTree) {
  fail("★ 建出的 tree 与本地不一致 —— 说明有未覆盖的差异，已中止（远端未改）")
}
console.log("✓ tree 与本地完全一致")

// ── 7) 建 commit ───────────────────────────────────────────
const msg = await gitText("log", "-1", "--pretty=%B")
const commitCreate = await req("POST", `/repos/${SLUG}/git/commits`, {
  message: msg,
  tree: newTree,
  parents: [remoteHead],
})
if (commitCreate.status !== 201 && commitCreate.status !== 200) {
  fail(`建 commit 失败（${commitCreate.status}）`, commitCreate.json)
}
const newCommit = commitCreate.json.sha
console.log(`new_commit: ${newCommit.slice(0, 8)}`)

// ── 8) 移动 ref ────────────────────────────────────────────
const patch = await req("PATCH", `/repos/${SLUG}/git/refs/heads/${BRANCH}`, {
  sha: newCommit,
  force: false,
})
if (patch.status !== 200) {
  fail(`移动 ref 失败（${patch.status}）`, patch.json)
}
console.log(`ref → ${patch.json.object.sha.slice(0, 8)}`)

// ── 9) 回读校验 ────────────────────────────────────────────
const verify = await req("GET", `/repos/${SLUG}/git/ref/heads/${BRANCH}`)
const finalSha = verify.json?.object?.sha
if (finalSha !== newCommit) {
  fail(`回读不一致：远端 ${finalSha?.slice(0, 8)} ≠ 刚推的 ${newCommit.slice(0, 8)}`)
}
console.log(`✓ 回读确认远端 ${BRANCH} = ${finalSha.slice(0, 8)}`)

// ── 10) 对齐本地引用 ───────────────────────────────────────
// ★ 为什么必须做这件事 ★
//   API 推送的提交是**建在远端 parent 之上**的，而本地提交建在本地 parent 之上
//   ⇒ 两边 tree 相同但历史**分叉**（status 显示 ahead N / behind N）。
//   不处理的话，下次 `git push` 会因非快进被拒，且历史越来越乱。
//
//   能不能 fetch 到取决于 `github.com` 是否恰好可达（它时通时断）。
let synced = false
const fetched = await tryGit(["fetch", "origin", BRANCH], 30000)
if (fetched) {
  // ★ 比 FETCH_HEAD 而不是 origin/<branch>：`git fetch <remote> <ref>` 是否
  //   顺带更新 refs/remotes/origin/<ref> 取决于 refspec 配置，FETCH_HEAD 一定最新。
  const stat = await gitText("diff", "--stat", "HEAD", "FETCH_HEAD")
  if (stat) {
    console.log(`⚠️ fetch 成功，但 HEAD 与 FETCH_HEAD 仍有差异（请复核）:\n${stat}`)
  } else {
    /**
     * tree 相同 ⇒ hard reset **不可能**丢东西。
     * 但工作区若有未提交改动，仍只动引用（不碰工作区），把决定权留给用户。
     */
    const dirty = await gitText("status", "--porcelain")
    if (dirty) {
      await tryGit(["update-ref", `refs/remotes/origin/${BRANCH}`, "FETCH_HEAD"])
      console.log(`✓ 已更新 origin/${BRANCH}（工作区有未提交改动，未改本地分支）`)
    } else {
      await tryGit(["reset", "--hard", "FETCH_HEAD"])
      console.log(`✓ 本地 ${BRANCH} 已对齐远端（tree 相同，工作区无任何变化）`)
      synced = true
    }
  }
}
if (!synced) {
  // 降级：把远端跟踪分支指到本地同 tree 的提交，让 status 显示同步
  await tryGit(["update-ref", `refs/remotes/origin/${BRANCH}`, localHead])
  console.log(
    `✓ github.com 不可达，已把 origin/${BRANCH} 指到本地同 tree 的提交（status 显示同步）`,
  )
}

console.log("\nPUSH_OK")
