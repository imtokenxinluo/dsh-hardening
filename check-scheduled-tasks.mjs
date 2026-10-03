#!/usr/bin/env node
// check-scheduled-tasks.mjs — 调度层防线：任务连败，而面板仍显示"已启用"。
//
// 为什么需要（真实案例，2026-10-03）：「每日荐股」自 2026-09-13 起连续 7 次失败，
// 每次 1.2 秒就被拒（会话 id 冲突），而任务一直显示 enabled=true / state=active、
// 下次运行还排到了 10-05。产物停在 20 天前，界面上看不出任何异常。
//
// 这是四层静默失效里唯一没有防线的一层：
//   数据层 → 统计/推荐过期已加显式提示
//   代码层 → 词表漂移已加漂移检测测试
//   部署层 → 副本落后已加 check-plugin-deploy
//   调度层 → 本文件
//
// 用法：
//   node check-scheduled-tasks.mjs
//   node check-scheduled-tasks.mjs --selftest
//   node check-scheduled-tasks.mjs --state <scheduled_tasks.json> --threshold 3
//
// 退出码：0 = 无连败；1 = 有任务连败（可挂 CI/定时检查）；2 = 读取或解析失败。
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const DEFAULTS = {
  stateFile: 'D:/tool/dsh_data/storages/scheduled_tasks.json',
  threshold: 3,
}

/**
 * 对单个任务的运行记录做判定（纯函数）。
 * 「连败」= 从最近一次往前数，连续 failed 的次数；遇到任何非 failed 就停。
 */
export function analyzeRuns(runs, taskId) {
  const mine = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && r.taskId === taskId)
    .slice()
    .sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')))
  let consecutiveFailures = 0
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    if (mine[i].status === 'failed') consecutiveFailures += 1
    else break
  }
  const rev = mine.slice().reverse()
  const lastSuccess = rev.find((r) => r.status === 'completed') ?? null
  const lastFailure = rev.find((r) => r.status === 'failed') ?? null
  return {
    total: mine.length,
    failed: mine.filter((r) => r.status === 'failed').length,
    consecutiveFailures,
    lastSuccessAt: lastSuccess ? lastSuccess.startedAt ?? null : null,
    lastFailureAt: lastFailure ? lastFailure.startedAt ?? null : null,
    lastError: lastFailure ? lastFailure.error ?? null : null,
  }
}

/** 把 storage 的 tables 摊平成数组（键值对或数组两种形态都吃）。 */
export function flattenTables(tables) {
  const pick = (name) => {
    const v = tables && tables[name]
    if (!v) return []
    return Array.isArray(v) ? v : Object.keys(v).map((k) => v[k])
  }
  return { tasks: pick('tasks'), runs: pick('runs') }
}

/**
 * 判定所有定时任务。
 * @returns {{ok:boolean, error?:string, rows:object[], unhealthy:object[]}}
 */
export function checkScheduledTasks({ stateFile = DEFAULTS.stateFile, threshold = DEFAULTS.threshold } = {}) {
  let doc
  try {
    doc = JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch (error) {
    return { ok: false, error: `读不到 ${stateFile}：${error?.message ?? error}`, rows: [], unhealthy: [] }
  }
  const { tasks, runs } = flattenTables(doc.tables)
  const rows = tasks
    .map((t) => {
      const stat = analyzeRuns(runs, t.id)
      return {
        id: t.id,
        name: t.name ?? t.id,
        enabled: t.enabled !== false,
        state: t.state ?? null,
        cron: t.cron ?? null,
        ...stat,
        // 只对"启用中"的任务报警：停用的任务失败是预期内的
        unhealthy: t.enabled !== false && stat.consecutiveFailures >= threshold,
      }
    })
    .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures || String(a.name).localeCompare(String(b.name)))
  return { ok: true, stateFile, threshold, rows, unhealthy: rows.filter((r) => r.unhealthy) }
}

// ── 自测 ────────────────────────────────────────────────────────────────────
export function runSelfTest() {
  let failures = 0
  const check = (name, cond, detail) => {
    if (cond) console.log('  PASS ' + name)
    else { failures++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }
  }
  const run = (taskId, statuses) => statuses.map((s, i) => ({ taskId, status: s, startedAt: `2026-10-0${i + 1}T00:00:00Z`, error: s === 'failed' ? 'boom' : null }))

  // 连败计数
  const a = analyzeRuns(run('t1', ['completed', 'failed', 'failed', 'failed']), 't1')
  check('连败：尾部 3 次 failed → 3', a.consecutiveFailures === 3, String(a.consecutiveFailures))
  const b = analyzeRuns(run('t1', ['failed', 'failed', 'completed']), 't1')
  check('连败：最近一次成功即归零', b.consecutiveFailures === 0, String(b.consecutiveFailures))
  const c = analyzeRuns(run('t1', ['failed', 'completed', 'failed']), 't1')
  check('连败只数尾部连续段（中间成功过就不算长连败）', c.consecutiveFailures === 1, String(c.consecutiveFailures))

  // 最近成功 / 最近失败 / 错误
  const d = analyzeRuns(run('t1', ['completed', 'failed', 'failed']), 't1')
  check('最近成功时间取 completed 里最新的', d.lastSuccessAt === '2026-10-01T00:00:00Z', String(d.lastSuccessAt))
  check('最近失败时间取 failed 里最新的', d.lastFailureAt === '2026-10-03T00:00:00Z', String(d.lastFailureAt))
  check('带出最近一次失败的错误文本', d.lastError === 'boom', String(d.lastError))

  // 隔离：只算本任务的记录
  const mixed = [...run('t1', ['failed']), ...run('t2', ['completed', 'completed'])]
  check('只统计指定任务（不串台）', analyzeRuns(mixed, 't2').consecutiveFailures === 0 && analyzeRuns(mixed, 't1').consecutiveFailures === 1)

  // 空/脏输入
  check('无记录 → 全零，不炸', analyzeRuns([], 't1').consecutiveFailures === 0)
  check('null 输入 → 全零', analyzeRuns(null, 't1').total === 0)
  check('缺 startedAt 的记录也能处理', analyzeRuns([{ taskId: 't1', status: 'failed' }], 't1').consecutiveFailures === 1)

  // tables 摊平（数组 / 键值对两种形态）
  check('tables.tasks 是数组', flattenTables({ tasks: [{ id: 'x' }] }).tasks.length === 1)
  check('tables.tasks 是键值对', flattenTables({ tasks: { 'task-1': { id: 'task-1' } } }).tasks.length === 1)
  check('缺表 → 空数组', flattenTables({}).tasks.length === 0 && flattenTables(null).runs.length === 0)

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
    const r = checkScheduledTasks({
      stateFile: opt('--state', DEFAULTS.stateFile),
      threshold: Number(opt('--threshold', DEFAULTS.threshold)) || DEFAULTS.threshold,
    })
    if (!r.ok) {
      console.error('✗ ' + r.error)
      process.exit(2)
    }
    console.log(`调度任务健康（${r.stateFile}）\n`)
    const width = Math.max(...r.rows.map((x) => String(x.name).length), 12)
    for (const x of r.rows) {
      const icon = x.unhealthy ? '❌' : (x.enabled ? '✅' : '·')
      const tail = x.unhealthy
        ? `连败 ${x.consecutiveFailures} 次（阈值 ${r.threshold}）`
        : (x.total === 0 ? '无运行记录' : `连败 ${x.consecutiveFailures} 次 / 共 ${x.total} 次`)
      console.log(`${icon} ${String(x.name).padEnd(width)}  ${x.cron ?? ''}  ${tail}`)
      if (x.unhealthy) {
        console.log(`   └─ 最近成功 ${x.lastSuccessAt ?? '（从未成功）'} ｜ 最近失败 ${x.lastFailureAt ?? '—'}`)
        if (x.lastError) console.log(`   └─ 错误：${String(x.lastError).slice(0, 200)}`)
      }
    }
    console.log('')
    if (r.unhealthy.length === 0) {
      console.log('✓ 没有任务处于连败状态')
    } else {
      console.log(`✗ ${r.unhealthy.length} 个任务连败中：${r.unhealthy.map((x) => x.name).join('、')}`)
      console.log('   连败意味着任务在按时触发，但每次都没真正跑起来 —— 面板仍会显示"已启用"。')
    }
    process.exitCode = r.unhealthy.length > 0 ? 1 : 0
  }
}
