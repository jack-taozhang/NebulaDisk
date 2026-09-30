/**
 * GitHub 凭据读取（供 tools/gh-*.mjs 共用）。
 *
 * ★ 为什么不能只用 `git credential fill` ★
 *   实测它**不稳定**：连续三次里会有一次**超时**（凭据助手 GCM 在非桌面 shell
 *   偶发卡住 —— 和 `git push` 挂死同一个根因）。发版工具不能有这种抖动。
 *
 * 读取顺序（前者优先）：
 *   1. `GITHUB_TOKEN` / `GH_TOKEN` 环境变量
 *   2. 仓库根的 `.gh-token` 文件（**已 gitignore**，一行纯 token）
 *      —— 走这条稳定路径
 *   3. `git credential fill`（遵从用户配置的 helper，带重试）—— 仅兜底
 *
 * ★ 用 `git credential fill` 而不是直接调某个 helper 可执行文件 ★
 *   前者遵从**用户自己配置的** credential.helper（GCM / store / 其它），
 *   脚本因此不绑定任何本机绝对路径。
 *
 * ★★ 本模块**不调用同步族子进程** ★★
 *   `execSync` / `execFileSync` / `spawnSync` 在本机沙箱**一律 EBUSY**，
 *   而 `spawnSync` 最阴 —— 它**不抛异常**，只静默返回 `{status:null, error:'EBUSY'}`，
 *   表现成"凭据助手怎么都不返回" ⇒ 极难定位。
 *   ⇒ 因此本函数是 **async**，内部走异步 `spawn`。
 *   （同源修复：tools/pack.js、tools/gh-release.mjs、tools/gh-push-api.mjs）
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const TOKEN_FILE = ".gh-token"

function fromEnv() {
  const v = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  return v && v.trim() ? v.trim() : null
}

function fromFile() {
  // 从仓库根跑（npm run）时 cwd 就是根；也兼容从 tools/ 里直接跑
  for (const p of [resolve(process.cwd(), TOKEN_FILE), resolve(process.cwd(), "..", TOKEN_FILE)]) {
    if (existsSync(p)) {
      const v = readFileSync(p, "utf8").trim()
      if (v) {
        return v
      }
    }
  }
  return null
}

/** 跑一次 `git credential fill`（异步；任何异常/超时都当作"没拿到"） */
function credentialFillOnce(timeout = 20000) {
  return new Promise((resolve_) => {
    let child
    try {
      child = spawn("git", ["credential", "fill"], { stdio: ["pipe", "pipe", "ignore"] })
    } catch {
      resolve_(null)
      return
    }
    const out = []
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve_(v)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 忽略 */ }
      done(null)
    }, timeout)
    child.stdout.on("data", (d) => out.push(d))
    child.on("error", () => done(null))
    child.on("close", () => {
      const line = Buffer.concat(out)
        .toString("utf8")
        .split("\n")
        .find((l) => l.startsWith("password="))
      done(line ? line.slice("password=".length).trim() : null)
    })
    try {
      child.stdin.write("protocol=https\nhost=github.com\n\n")
      child.stdin.end()
    } catch {
      done(null)
    }
  })
}

async function fromCredentialFill(attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    const v = await credentialFillOnce()
    if (v) {
      return v
    }
    if (i < attempts) {
      console.log(`  …凭据助手第 ${i} 次未返回，重试`)
    }
  }
  return null
}

export async function readGithubToken() {
  const env = fromEnv()
  if (env) {
    return env
  }
  const file = fromFile()
  if (file) {
    return file
  }
  const filled = await fromCredentialFill()
  if (filled) {
    console.log(
      `  ⓘ 凭据来自 git credential fill（不稳定）。建议把它存到 ${TOKEN_FILE}（已 gitignore）以走稳定路径。`,
    )
    return filled
  }
  throw new Error(
    `取不到 GitHub 凭据。请任选其一：\n` +
      `  · 设环境变量 GITHUB_TOKEN\n` +
      `  · 在仓库根建 ${TOKEN_FILE}（一行纯 token；已 gitignore）\n` +
      `  · 确认 github.com 已登录过一次（凭据助手可用）`,
  )
}
