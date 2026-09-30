// 恢复验证：从 bundle 真的克隆回来，证明「对象一个不少」。
//
// 关键点（第一次验证就踩到的坑）：
//   `git clone <bundle>` **不会**把 bundle 里的 `refs/remotes/*` 原样重建，
//   所以拿「克隆后 rev-list --all --count」跟源仓库比会少一个 —— 那是**命名差异，不是数据丢失**。
//   正确判据是：bundle 记录的每个 head，其对象在恢复出来的仓库里**存在**。
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const TARGET = process.argv[2] ?? 'E:/dsh-backups/2026-09-19/repos'

const CASES = [
  { name: 'dsh-session-doctor', src: 'D:/tool/claude_code/dsh-session-doctor', why: '有 2 个提交无法推送，只存在于本地' },
  { name: 'project__polymarket-profit', src: 'D:/tool/claude_code/project/polymarket-profit', why: '有 27 项未提交改动 + 远端跟踪分支' },
  { name: 'dsh-stock-picks', src: 'D:/tool/claude_code/dsh-stock-picks', why: '推荐跟踪功能未提交' },
  { name: 'project__ai-trading-arena', src: 'D:/tool/claude_code/project/ai-trading-arena', why: '最大的仓库（40 MB bundle）' }
]

function git(dir, argv, opts = {}) {
  return execFileSync('git', ['-C', dir, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
}
function tryGit(dir, argv) {
  try { return git(dir, argv) } catch { return null }
}

let allOk = true
for (const c of CASES) {
  const bundle = join(TARGET, `${c.name}.bundle`)
  if (!existsSync(bundle)) { console.log(`✗ ${c.name}: bundle 不存在`); allOk = false; continue }

  const tmp = mkdtempSync(join(tmpdir(), 'restore-check-'))
  const dest = join(tmp, 'restored')
  try {
    // 1) bundle 自身完整性
    const verifyOut = execFileSync('git', ['-C', c.src, 'bundle', 'verify', bundle], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

    // 2) bundle 记录了哪些 head
    const heads = git(c.src, ['bundle', 'list-heads', bundle]).split('\n').filter(Boolean)
      .map((l) => l.split(/\s+/)).map(([sha, ref]) => ({ sha, ref }))

    // 3) 克隆回来
    execFileSync('git', ['clone', '--quiet', bundle, dest], { stdio: ['ignore', 'pipe', 'pipe'] })

    // 4) 每个 head 的对象都必须存在（这才是"没丢数据"）
    const missing = []
    for (const h of heads) {
      const ok = tryGit(dest, ['cat-file', '-e', `${h.sha}^{commit}`]) !== null
      if (!ok) missing.push(`${h.ref} (${h.sha.slice(0, 8)})`)
    }

    // 5) 名称层面的对照（信息性）：克隆后哪些 ref 名字变了
    const srcHeads = git(c.src, ['rev-parse', 'HEAD'])
    const dstHeads = git(dest, ['rev-parse', 'HEAD'])
    const srcTree = git(c.src, ['rev-parse', 'HEAD^{tree}'])
    const dstTree = git(dest, ['rev-parse', 'HEAD^{tree}'])
    const srcTags = git(c.src, ['tag']).split('\n').filter(Boolean).sort().join(',')
    const dstTags = git(dest, ['tag']).split('\n').filter(Boolean).sort().join(',')

    const ok = missing.length === 0 && srcHeads === dstHeads && srcTree === dstTree && srcTags === dstTags
    allOk = allOk && ok

    console.log(`${ok ? '✓' : '✗'} ${c.name}（${c.why}）`)
    console.log(`    bundle verify: ${/ok/.test(verifyOut) ? '通过' : verifyOut.split('\n')[0]}`)
    console.log(`    对象完整性: ${heads.length} 个 head 全部存在${missing.length ? ` —— 缺 ${missing.join(', ')} ✗` : ' ✓'}`)
    console.log(`    HEAD: ${srcHeads.slice(0, 8)} → ${dstHeads.slice(0, 8)} ${srcHeads === dstHeads ? '✓' : '✗'}`)
    console.log(`    tree: ${srcTree.slice(0, 12)} ${srcTree === dstTree ? '✓ 完全一致' : '✗ 不一致'}`)
    console.log(`    tag:  ${srcTags || '(无)'} ${srcTags === dstTags ? '✓' : `✗ → ${dstTags}`}`)
    const extra = heads.filter((h) => h.ref.startsWith('refs/remotes/')).length
    if (extra > 0) console.log(`    注：${extra} 个远端跟踪 ref 的对象已在包内，但 plain clone 不重建该命名空间——恢复它们用：\n        git -C <repo> fetch <bundle> '+refs/*:refs/bundle/*'`)
  } catch (error) {
    allOk = false
    console.log(`✗ ${c.name}: ${String(error?.message ?? error).slice(0, 200)}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log(allOk ? '\n✓ 恢复验证通过：每一个 ref 的对象都能从 bundle 还原' : '\n✗ 恢复验证失败')
if (!allOk) process.exitCode = 1
