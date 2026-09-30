// 工作区备份：把 git 仓库打成 bundle、把非仓库目录打包、复制会话冷备份到异盘。
//
// 为什么用 git bundle 而不是"拷贝文件夹"：bundle 是**单文件、含完整历史**
// （所有分支/tag/提交），恢复用 `git clone <file>.bundle` 即可，且可用
// `git bundle verify` 校验完整性 —— 不依赖任何远端账号。
//
// 用法：
//   node backup-workspace.mjs                 # 备份到 E:\dsh-backups\<今天>
//   node backup-workspace.mjs --target E:\other --date 2026-09-13
//
// 只读源数据：本脚本不修改任何被备份的仓库（不 commit、不 push）。

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const getArg = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const WORKSPACE = 'D:/tool/claude_code'
const DATE = getArg('--date') ?? new Date().toISOString().slice(0, 10)
const TARGET = join(getArg('--target') ?? 'E:/dsh-backups', DATE)
const REPO_DIR = join(TARGET, 'repos')
const TREE_DIR = join(TARGET, 'worktrees')
const MISC_DIR = join(TARGET, 'misc')

for (const d of [REPO_DIR, TREE_DIR, MISC_DIR]) mkdirSync(d, { recursive: true })

function git(dir, argv, opts = {}) {
  return execFileSync('git', ['-C', dir, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts })
}
function tryGit(dir, argv) {
  try { return git(dir, argv).trim() } catch { return '' }
}
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}
function sizeOf(p) {
  try { return statSync(p).size } catch { return 0 }
}
function tarGz(srcDir, outFile, excludes = []) {
  const argv = ['-czf', outFile]
  for (const e of excludes) argv.push('--exclude', e)
  argv.push('-C', dirname(srcDir), basename(srcDir))
  execFileSync('tar', argv, { stdio: ['ignore', 'pipe', 'ignore'] })
}

const manifest = { date: DATE, createdAt: new Date().toISOString(), target: TARGET, repos: [], trees: [], misc: [], failures: [] }
const log = (m) => console.log(m)

// ---------- 1. 收集仓库 ----------
const repoDirs = []
for (const e of readdirSync(WORKSPACE, { withFileTypes: true })) {
  if (e.isDirectory() && existsSync(join(WORKSPACE, e.name, '.git'))) repoDirs.push({ path: join(WORKSPACE, e.name), name: e.name })
}
const proj = join(WORKSPACE, 'project')
if (existsSync(proj)) {
  for (const e of readdirSync(proj, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(join(proj, e.name, '.git'))) repoDirs.push({ path: join(proj, e.name), name: `project__${e.name}` })
  }
}

log(`=== 备份 ${repoDirs.length} 个 git 仓库 ===`)
for (const { path: dir, name } of repoDirs) {
  const bundle = join(REPO_DIR, `${name}.bundle`)
  try {
    git(dir, ['bundle', 'create', bundle, '--all'])
    // 校验：bundle 自身完整性 + 可枚举 ref
    git(dir, ['bundle', 'verify', bundle])
    const refs = git(dir, ['ls-remote', bundle]).split('\n').filter(Boolean).length
    const head = tryGit(dir, ['rev-parse', 'HEAD'])
    const status = tryGit(dir, ['status', '--porcelain'])
    manifest.repos.push({
      name,
      source: dir,
      bundle: bundle.replace(/\\/g, '/'),
      bytes: sizeOf(bundle),
      sha256: sha256(bundle),
      head,
      refs,
      dirtyFiles: status ? status.split('\n').length : 0
    })
    log(`  ✓ ${name.padEnd(30)} ${(sizeOf(bundle) / 1048576).toFixed(1).padStart(6)} MB  refs=${refs}${status ? `  (未提交 ${status.split('\n').length} 项)` : ''}`)

    // 未提交内容单独存（bundle 只含已提交状态）
    if (status) {
      const patch = join(TREE_DIR, `${name}.uncommitted.patch`)
      try {
        writeFileSync(patch, git(dir, ['diff', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] }), 'utf8')
      } catch { writeFileSync(patch, '', 'utf8') }
      const untracked = tryGit(dir, ['ls-files', '--others', '--exclude-standard'])
      writeFileSync(join(TREE_DIR, `${name}.status.txt`), `${status}\n\n--- untracked ---\n${untracked}\n`, 'utf8')
      manifest.trees.push({ name, patch: patch.replace(/\\/g, '/'), untrackedFiles: untracked ? untracked.split('\n').length : 0 })
    }
  } catch (error) {
    manifest.failures.push({ name, step: 'bundle', error: String(error?.message ?? error).slice(0, 200) })
    log(`  ✗ ${name}: ${String(error?.message ?? error).slice(0, 120)}`)
  }
}

// ---------- 2. 未提交目录打包（工作树快照）----------
log('\n=== 未提交目录 / 交付目录打包 ===')
const dirsToTar = [
  { dir: join(WORKSPACE, 'dsh-contract-check'), name: 'dsh-contract-check' },
  { dir: join(WORKSPACE, 'dsh-plugin-guide'), name: 'dsh-plugin-guide' },
  { dir: join(WORKSPACE, 'dsh-hardening'), name: 'dsh-hardening' },
  { dir: join(WORKSPACE, 'project', 'commodity-trader'), name: 'project__commodity-trader' },
  { dir: join(WORKSPACE, '.claude'), name: 'claude-memory' }
]
for (const { dir, name } of dirsToTar) {
  if (!existsSync(dir)) continue
  const out = join(MISC_DIR, `${name}.tar.gz`)
  try {
    tarGz(dir, out, ['node_modules', '.git', '*.tgz'])
    manifest.misc.push({ name, source: dir, archive: out.replace(/\\/g, '/'), bytes: sizeOf(out), sha256: sha256(out) })
    log(`  ✓ ${name.padEnd(30)} ${(sizeOf(out) / 1024).toFixed(0).padStart(6)} KB`)
  } catch (error) {
    manifest.failures.push({ name, step: 'tar', error: String(error?.message ?? error).slice(0, 200) })
    log(`  ✗ ${name}: ${String(error?.message ?? error).slice(0, 120)}`)
  }
}

// ---------- 3. DSH 配置 + 会话冷备份 ----------
log('\n=== DSH 配置与会话备份 ===')
const dshData = 'D:/tool/dsh_data'
for (const f of ['AGENTS.md']) {
  const src = join(dshData, f)
  if (!existsSync(src)) continue
  const out = join(MISC_DIR, `dsh_data__${f}`)
  copyFileSync(src, out)
  manifest.misc.push({ name: `dsh_data/${f}`, source: src, archive: out.replace(/\\/g, '/'), bytes: sizeOf(out), sha256: sha256(out) })
  log(`  ✓ dsh_data/${f}`)
}
// profile 配置（不含 node_modules，也不含任何凭据）
const prof = join(dshData, 'profiles', 'web')
if (existsSync(prof)) {
  const out = join(MISC_DIR, 'profile-web-config.tar.gz')
  try {
    execFileSync('tar', ['-czf', out, '--exclude', 'node_modules', '--exclude', '*.bak*', '-C', dirname(prof), basename(prof)], { stdio: ['ignore', 'pipe', 'ignore'] })
    manifest.misc.push({ name: 'profile-web-config', archive: out.replace(/\\/g, '/'), bytes: sizeOf(out), sha256: sha256(out) })
    log(`  ✓ profile-web-config（含 patches / cordis 配置，含 node_modules 已排除）`)
  } catch (error) {
    manifest.failures.push({ name: 'profile-web-config', step: 'tar', error: String(error?.message ?? error).slice(0, 200) })
    log(`  ✗ profile-web-config: ${String(error?.message ?? error).slice(0, 120)}`)
  }
}
// 已有的会话冷备份复制到异盘
const sessionBackup = 'D:/tool/dsh-backups/sessions'
if (existsSync(sessionBackup)) {
  const out = join(MISC_DIR, 'dsh-sessions-backup.tar.gz')
  try {
    execFileSync('tar', ['-czf', out, '-C', dirname(sessionBackup), basename(sessionBackup)], { stdio: ['ignore', 'pipe', 'ignore'] })
    manifest.misc.push({ name: 'dsh-sessions-backup', archive: out.replace(/\\/g, '/'), bytes: sizeOf(out), sha256: sha256(out) })
    log(`  ✓ dsh-sessions-backup（${(sizeOf(out) / 1048576).toFixed(1)} MB）`)
  } catch (error) {
    manifest.failures.push({ name: 'dsh-sessions-backup', step: 'tar', error: String(error?.message ?? error).slice(0, 200) })
    log(`  ✗ dsh-sessions-backup: ${String(error?.message ?? error).slice(0, 120)}`)
  }
}

// ---------- 4. 写清单 ----------
const manifestPath = join(TARGET, 'manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

const totalBytes = [...manifest.repos.map((r) => r.bytes), ...manifest.misc.map((m) => m.bytes)].reduce((a, b) => a + b, 0)
log(`\n=== 完成 ===`)
log(`仓库 bundle: ${manifest.repos.length} 个`)
log(`其它归档:   ${manifest.misc.length} 个`)
log(`工作树补丁: ${manifest.trees.length} 个（未提交内容）`)
log(`合计:       ${(totalBytes / 1048576).toFixed(1)} MB`)
log(`清单:       ${manifestPath}`)
if (manifest.failures.length) {
  log(`\n⚠️ 失败 ${manifest.failures.length} 项：`)
  for (const f of manifest.failures) log(`   ${f.name} (${f.step}): ${f.error}`)
  process.exitCode = 1
} else {
  log('\n✓ 全部成功，无失败项')
}
