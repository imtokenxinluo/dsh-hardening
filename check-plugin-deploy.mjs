#!/usr/bin/env node
// check-plugin-deploy.mjs — 对比「profile 里的实装副本」与「本地源码」，找出"改了不生效"的插件。
//
// 为什么需要它（2026-10-03 核验得出）：四个插件里三个的改进当时完全没生效 ——
// 两个是 registry 包（版本落后于本地），一个是复制安装的目录（副本停在近一个月前）。
// 而界面上没有任何提示：旧副本照常渲染，看起来和改好的一模一样。
//
// 这是"静默失效"的第三层（前两层都已加防线）：
//   数据层 —— 统计/推荐过期 → 已加显式提示
//   代码层 —— 词表漂移     → 已加漂移检测测试（内核升级即变红）
//   部署层 —— 本文件       → 副本落后即报，并按安装形态给出该做什么
//
// 用法：
//   node check-plugin-deploy.mjs
//   node check-plugin-deploy.mjs --profile <dir> --source <dir>
//
// 退出码：0 = 全部一致；1 = 有插件落后；2 = 读不到 profile。
import { readFileSync, existsSync, statSync, lstatSync, realpathSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULTS = {
  profileDir: 'D:/tool/dsh_data/profiles/web',
  sourceRoot: 'D:/tool/claude_code',
}

/** 目录是不是链接（符号链接或 Windows junction）；是则返回其真实目标。 */
export function linkTargetOf(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) return realpathSync(path)
  } catch { return null }
  // Windows 的 junction 在 lstat 里仍报告为目录，只能靠 realpath 与自身不同来判断
  try {
    const real = realpathSync(path)
    if (real && resolve(real).toLowerCase() !== resolve(path).toLowerCase()) return real
  } catch { /* ignore */ }
  return null
}

export function readVersion(pkgFile) {
  try {
    const j = JSON.parse(readFileSync(pkgFile, 'utf8'))
    return typeof j.version === 'string' ? j.version : null
  } catch {
    return null
  }
}

/** 把依赖声明归类：link / registry 版本 / 未声明。 */
export function classifySpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0) return { kind: 'unknown', raw: spec ?? null }
  if (spec.startsWith('link:') || spec.startsWith('file:')) {
    return { kind: 'link', path: spec.replace(/^(link:|file:)/, ''), raw: spec }
  }
  return { kind: 'version', range: spec, raw: spec }
}

/**
 * 这个包是不是由包管理器装进来的（而不是手工复制进 node_modules 的）。
 *
 * 不能用 node_modules/.pnpm 判断：这个 profile 用 pnpm 但 node-linker=hoisted，
 * 根本没有 .pnpm 实体目录（实测 2026-10-03）。可靠依据是 lock 文件里有没有它。
 * @returns {string|null} 命中的 lock 文件名，或 null（= 多半是手工复制）
 */
export function isManagedInstall(profileDir, name) {
  for (const lock of ['pnpm-lock.yaml', 'package-lock.json']) {
    try {
      if (readFileSync(join(profileDir, lock), 'utf8').includes(name)) return lock
    } catch { /* 试下一个 */ }
  }
  return null
}

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

const shortTime = (ms) => (ms === null ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '))

/**
 * 判定一个依赖的部署状态。
 * @returns {{ name, decl, installed, local, managedBy, verdict, detail, action }}
 *   verdict: 'linked' | 'ok' | 'stale-registry' | 'stale-copy' | 'not-source'
 */
export function compareEntry(name, spec, { profileDir, sourceRoot }) {
  const c = classifySpec(spec)
  const instDir = join(profileDir, 'node_modules', name)
  const srcDir = join(sourceRoot, name)
  const installed = readVersion(join(instDir, 'package.json'))
  const local = readVersion(join(srcDir, 'package.json'))

  // link 安装：实装就是源码本身，改动立即生效
  if (c.kind === 'link') {
    return {
      name, decl: c.raw, installed, local, managedBy: 'link', verdict: 'linked',
      detail: 'link 安装：实装即本地源码',
      action: '改动保存即生效（宿主侧代码需重启 DSH 加载）',
    }
  }

  // 本地没有对应源码目录 -> 不是我们在维护的插件，不评价
  if (!existsSync(join(srcDir, 'package.json'))) {
    return { name, decl: c.raw, installed, local: null, managedBy: null, verdict: 'not-source', detail: '本地没有对应源码目录', action: '—' }
  }

  const link = linkTargetOf(instDir)
  const managedBy = isManagedInstall(profileDir, name)
  const isCopy = existsSync(join(instDir, 'package.json')) && !link && !managedBy

  // 「落后」的判定与安装方式无关：要么版本不同，要么版本相同但实装产物更旧。
  // 后者真实存在：stock-picks 的版本号一直是 0.1.0，而副本停在 09-06。
  const versionBehind = installed !== null && local !== null && installed !== local
  const instClient = mtimeOf(join(instDir, 'lib', 'client.js'))
  const srcClient = mtimeOf(join(srcDir, 'lib', 'client.js'))
  const mtimeBehind = !versionBehind && instClient !== null && srcClient !== null && srcClient - instClient > 60000

  const action = isCopy
    ? '复制安装的副本落后：重新复制 lib/ 与 src/，或改建 Junction 指向源码（推荐，之后改完即生效）'
    : 'registry 包落后：发布新版本 → 抬 profile 依赖版本 → pnpm install → 重启 DSH'

  if (versionBehind) {
    return { name, decl: c.raw, installed, local, managedBy, verdict: isCopy ? 'stale-copy' : 'stale-registry', detail: `实装 ${installed} / 本地 ${local}`, action }
  }
  if (mtimeBehind) {
    return {
      name, decl: c.raw, installed, local, managedBy,
      verdict: isCopy ? 'stale-copy' : 'stale-registry',
      detail: `版本号相同（${installed ?? '?'}），但实装副本更旧：${shortTime(instClient)} < ${shortTime(srcClient)}`,
      action,
    }
  }

  return { name, decl: c.raw, installed, local, managedBy, verdict: 'ok', detail: `实装 ${installed ?? '?'} = 本地 ${local ?? '?'}`, action: '—' }
}

const ICON = {
  linked: '✅',
  ok: '✅',
  'stale-registry': '⏳',
  'stale-copy': '❌',
  'not-source': '·',
}

export function checkDeploy({ profileDir = DEFAULTS.profileDir, sourceRoot = DEFAULTS.sourceRoot } = {}) {
  const pkgFile = join(profileDir, 'package.json')
  let deps
  try {
    deps = JSON.parse(readFileSync(pkgFile, 'utf8')).dependencies ?? {}
  } catch (error) {
    return { ok: false, error: `读不到 ${pkgFile}：${error?.message ?? error}`, entries: [], problems: [] }
  }

  const entries = Object.keys(deps)
    .filter((n) => n.startsWith('dsh-') || n.includes('dsh-'))
    .sort()
    .map((n) => compareEntry(n, deps[n], { profileDir, sourceRoot }))

  // 还要扫 node_modules 里实际存在的 dsh-* —— 有些插件是复制进来的、根本没写进 dependencies，
  // 而它们恰恰最容易"改了不生效"（实装 stock-picks 就因此被漏掉过一次）。
  const known = new Set(entries.map((e) => e.name))
  try {
    for (const n of readdirSync(join(profileDir, 'node_modules')).filter((x) => x.startsWith('dsh-')).sort()) {
      if (known.has(n)) continue
      const entry = compareEntry(n, undefined, { profileDir, sourceRoot })
      if (entry.verdict !== 'not-source') entries.push(entry)
    }
  } catch { /* 目录读不到就算了 */ }
  entries.sort((a, b) => a.name.localeCompare(b.name))

  const problems = entries.filter((e) => e.verdict === 'stale-registry' || e.verdict === 'stale-copy')
  return { ok: true, profileDir, sourceRoot, entries, problems }
}

// ── 脚本入口 ────────────────────────────────────────────────────────────────
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const opt = (flag, fallback) => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
  }
  const r = checkDeploy({
    profileDir: opt('--profile', DEFAULTS.profileDir),
    sourceRoot: opt('--source', DEFAULTS.sourceRoot),
  })
  if (!r.ok) {
    console.error('✗ ' + r.error)
    process.exit(2)
  }
  console.log(`插件部署一致性（profile: ${r.profileDir}）\n`)
  const width = Math.max(...r.entries.map((e) => e.name.length), 12)
  for (const e of r.entries) {
    console.log(`${ICON[e.verdict] ?? '?'} ${e.name.padEnd(width)}  ${e.detail}`)
    if (e.verdict === 'stale-registry' || e.verdict === 'stale-copy') console.log(`   └─ 要做：${e.action}`)
  }
  console.log('')
  if (r.problems.length === 0) {
    console.log('✓ 所有插件的实装副本都与本地源码一致')
  } else {
    console.log(`✗ ${r.problems.length} 个插件的本地改动尚未生效：${r.problems.map((p) => p.name).join('、')}`)
    process.exitCode = 1
  }
}
