#!/usr/bin/env node
// verify-release.mjs — 发布后核对：npm 上是不是真的有我说的那一版。
//
// 为什么需要：发布是高风险管理动作 —— 0.2.0 那次就因为 files 白名单漏了
// cordis.patch.yml，装上后 DSH 整个插件树起不来。而"发布了"与"发对了"是两件事：
// 版本号打错、本地忘了 bump、发成了另一个包，都会安静地成功。
//
// 这个脚本只回答"npm 上现在是什么版本、与本地源码的版本差多少"。
// 它刻意不下载 tarball：解包要 tar 解析，而沙箱不允许用子进程调 npm。
// 包内容由本地 `npm pack --dry-run` 核对（脚本末尾会打印该命令）。
//
// 用法：
//   node verify-release.mjs
//   node verify-release.mjs --source-root D:/tool/claude_code
//
// 退出码：0 = 全部已发布；1 = 有包未发布（本地版本更高）；2 = 网络/读取失败。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULTS = {
  sourceRoot: 'D:/tool/claude_code',
  targets: ['dsh-tip-jar', 'dsh-session-doctor', 'dsh-contract-check'],
  registry: 'https://registry.npmjs.org',
}

export function localVersion(sourceRoot, name) {
  try {
    const j = JSON.parse(readFileSync(join(sourceRoot, name, 'package.json'), 'utf8'))
    return typeof j.version === 'string' ? j.version : null
  } catch {
    return null
  }
}

/** 比较 x.y.z（只用于"本地是否比 npm 新"的判断）。 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1
  }
  return 0
}

/**
 * 判定一个包的发布状态（纯函数，便于自测）。
 * @returns {'published'|'behind'|'ahead-unpublished'|'unknown'}
 */
export function releaseVerdict(local, remote) {
  if (!local) return 'unknown'
  if (!remote) return 'ahead-unpublished'
  const c = compareVersions(local, remote)
  if (c === 0) return 'published'
  return c > 0 ? 'behind' : 'ahead-unpublished' // 本地更高 = npm 落后
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

export async function checkReleases({ sourceRoot = DEFAULTS.sourceRoot, targets = DEFAULTS.targets, registry = DEFAULTS.registry } = {}) {
  const rows = []
  for (const name of targets) {
    const local = localVersion(sourceRoot, name)
    let remote = null
    let publishedAt = null
    let error = null
    try {
      const meta = await fetchJson(`${registry}/${encodeURIComponent(name)}`)
      remote = meta?.['dist-tags']?.latest ?? null
      publishedAt = remote && meta?.time?.[remote] ? meta.time[remote] : null
    } catch (e) {
      error = String(e?.message ?? e)
    }
    rows.push({ name, local, remote, publishedAt, error, verdict: error ? 'unknown' : releaseVerdict(local, remote) })
  }
  const pending = rows.filter((r) => r.verdict === 'behind' || r.verdict === 'ahead-unpublished')
  return { sourceRoot, registry, rows, pending }
}

const ICON = { published: '✅', behind: '⏳', 'ahead-unpublished': '⏳', unknown: '?' }

// ── 脚本入口 ────────────────────────────────────────────────────────────────
const invokedDirectly = Boolean(process.argv[1]) && (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const opt = (flag, fallback) => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
  }
  const extra = argv.filter((a) => !a.startsWith('--') && !DEFAULTS.targets.includes(a))
  const r = await checkReleases({
    sourceRoot: opt('--source-root', DEFAULTS.sourceRoot),
    targets: extra.length > 0 ? extra : DEFAULTS.targets,
  })
  console.log(`发布核对（本地源码 ←→ npm 上实际发布的版本）\n`)
  const width = Math.max(...r.rows.map((x) => x.name.length), 12)
  for (const x of r.rows) {
    if (x.error) {
      console.log(`${ICON.unknown} ${x.name.padEnd(width)}  查询失败：${x.error}`)
      continue
    }
    const gap = x.verdict === 'published'
      ? `本地 ${x.local} = npm ${x.remote}`
      : `本地 ${x.local ?? '?'} / npm ${x.remote ?? '（从未发布）'}${x.publishedAt ? `（${String(x.publishedAt).slice(0, 10)}）` : ''}`
    console.log(`${ICON[x.verdict] ?? '?'} ${x.name.padEnd(width)}  ${gap}`)
  }
  console.log('')
  if (r.pending.length === 0) {
    console.log('✓ 本地版本都已发布')
  } else {
    console.log(`⏳ ${r.pending.length} 个包尚未发布到 npm：${r.pending.map((x) => x.name).join('、')}`)
    console.log('   发布后重跑本脚本确认版本到位；包内容用本地核对：')
    console.log('   cd <包目录> && npm pack --dry-run')
  }
  process.exitCode = r.rows.some((x) => x.error) ? 2 : (r.pending.length > 0 ? 1 : 0)
}
