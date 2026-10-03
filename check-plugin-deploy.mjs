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
import {
  readFileSync, existsSync, statSync, lstatSync, realpathSync, readdirSync,
  mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
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

// ── 自测（--selftest）───────────────────────────────────────────────────────
// 这条防线自己也得是可靠的：它一旦误判，就会把人引向错误的处置
// （把 registry 包当成复制目录，或反过来）。所以用一个临时 fixture 环境
// 把四种判定逐一钉住，不依赖任何真实 profile。
export function runSelfTest() {
  let failures = 0
  const check = (name, cond, detail) => {
    if (cond) console.log('  PASS ' + name)
    else { failures++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }
  }

  // classifySpec
  check('classifySpec: link: 前缀判为 link', classifySpec('link:D:/x').kind === 'link')
  check('classifySpec: 版本号判为 version', classifySpec('^0.2.2').kind === 'version')
  check('classifySpec: 未声明判为 unknown', classifySpec(undefined).kind === 'unknown' && classifySpec('').kind === 'unknown')

  const dir = mkdtempSync(join(tmpdir(), 'deploy-selftest-'))
  try {
    const profileDir = join(dir, 'profile')
    const sourceRoot = join(dir, 'src')
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })

    /** 造一个插件：本地源码 + profile 实装副本。 */
    const make = (name, { localVersion, installedVersion, inLock, clientMtimeDeltaMs = 0, linkSpec }) => {
      const srcDir = join(sourceRoot, name)
      mkdirSync(join(srcDir, 'lib'), { recursive: true })
      writeFileSync(join(srcDir, 'package.json'), JSON.stringify({ name, version: localVersion }))
      const srcClient = join(srcDir, 'lib', 'client.js')
      writeFileSync(srcClient, '// local build')

      const instDir = join(profileDir, 'node_modules', name)
      mkdirSync(join(instDir, 'lib'), { recursive: true })
      writeFileSync(join(instDir, 'package.json'), JSON.stringify({ name, version: installedVersion }))
      const instClient = join(instDir, 'lib', 'client.js')
      writeFileSync(instClient, '// installed build')

      // 用 mtime 表达"副本更旧"：本地构建时间 = 实装 + delta
      const base = Date.now() / 1000
      if (clientMtimeDeltaMs !== 0) {
        utimesSync(instClient, base - 3600, base - 3600)
        utimesSync(srcClient, base + clientMtimeDeltaMs / 1000, base + clientMtimeDeltaMs / 1000)
      }
      if (inLock) writeFileSync(join(profileDir, 'pnpm-lock.yaml'), `  ${name}@${installedVersion}:\n    resolution: {}\n`)
      return { name, spec: linkSpec ?? `^${localVersion}` }
    }

    // 1) link 安装
    const linked = make('dsh-linked', { localVersion: '1.0.0', installedVersion: '1.0.0', inLock: false, linkSpec: 'link:D:/src/dsh-linked' })
    const r1 = compareEntry(linked.name, linked.spec, { profileDir, sourceRoot })
    check('link 安装判为 linked（改动即生效）', r1.verdict === 'linked', r1.verdict)

    // 2) registry 包 + 版本落后
    const reg = make('dsh-registry', { localVersion: '0.2.2', installedVersion: '0.2.1', inLock: true })
    const r2 = compareEntry(reg.name, reg.spec, { profileDir, sourceRoot })
    check('registry 包版本落后判为 stale-registry', r2.verdict === 'stale-registry', r2.verdict)
    check('registry 落后的处置是「发布 + 抬依赖」', /发布新版本/.test(r2.action), r2.action)

    // 3) 复制目录 + 版本相同但副本更旧（stock-picks 的真实情形）
    const copied = make('dsh-copied', { localVersion: '0.1.0', installedVersion: '0.1.0', inLock: false, clientMtimeDeltaMs: 3600_000 })
    const r3 = compareEntry(copied.name, copied.spec, { profileDir, sourceRoot })
    check('版本相同但副本更旧 → 仍判为落后（版本号不可靠）', r3.verdict === 'stale-copy', r3.verdict)
    check('复制目录落后的处置是「重新复制 / 改建 Junction」', /重新复制|Junction/.test(r3.action), r3.action)

    // 4) 完全一致
    const same = make('dsh-same', { localVersion: '1.2.3', installedVersion: '1.2.3', inLock: true })
    const r4 = compareEntry(same.name, same.spec, { profileDir, sourceRoot })
    check('版本一致且副本不旧 → ok', r4.verdict === 'ok', r4.verdict)

    // 5) 本地没有源码 → 不评价
    const r5 = compareEntry('dsh-not-ours', '^1.0.0', { profileDir, sourceRoot })
    check('本地无源码目录 → not-source（不误报）', r5.verdict === 'not-source', r5.verdict)

    // 6) checkDeploy 能发现"未写进 dependencies 却存在于 node_modules"的插件
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'fake-profile',
      dependencies: { 'dsh-registry': '^0.2.2' },
    }))
    const all = checkDeploy({ profileDir, sourceRoot })
    const names = all.entries.map((e) => e.name)
    check('扫到了 dependencies 里的插件', names.includes('dsh-registry'), names.join(','))
    check('也扫到了只在 node_modules 里的插件（stock-picks 曾因此漏报）', names.includes('dsh-copied'), names.join(','))
    check('problems 同时包含两类落后', all.problems.length >= 2, String(all.problems.length))
    check('link 安装不计入 problems', !all.problems.some((p) => p.name === 'dsh-linked'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('')
  if (failures === 0) console.log('✓ 自测通过')
  else console.log(`✗ 自测失败 ${failures} 项`)
  return failures
}

// ── 脚本入口 ────────────────────────────────────────────────────────────────
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) {
    process.exitCode = runSelfTest() > 0 ? 1 : 0
  } else {
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
}
