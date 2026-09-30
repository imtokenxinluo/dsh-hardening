// Re-apply P0-1 + P0-3 to the installed dsh kernel lib files after a DSH upgrade.
// Idempotent: detects already-applied state and skips. Run with: node reapply-p0.mjs
//
// 2026-09 hardening: two fixes over the original script:
//  1. Path resolution now probes BOTH known install layouts (flat `@deepseek-ai/<pkg>`
//     and nested `@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>`), so an npm
//     layout change no longer breaks the script with a silent ENOENT.
//  2. After apply/skip it VERIFIES structural completeness (functional call sites
//     present, not just the comment marker) and runs `node --check` on both files.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// --- install layout probing ------------------------------------------------
const PKG = '@deepseek-ai'
const CANDIDATES = [
  // nested (npm install of dsh bundles its deps inside the package)
  'D:/tool/npmPlugin/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  // flat (older installs hoisted deps to the top level)
  'D:/tool/npmPlugin/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
]

function resolveLib(pkg) {
  for (const cand of CANDIDATES) {
    if (cand.includes(pkg) && existsSync(cand)) return cand
  }
  // build a candidate for the other package from whichever layout matched.
  // Use the LAST /@deepseek-ai/ separator (the nested layout has two: the
  // top-level scope dir and the one inside dsh/node_modules).
  for (const cand of CANDIDATES) {
    const sep = cand.lastIndexOf('/@deepseek-ai/')
    if (sep < 0) continue
    const dir = cand.slice(0, sep + '/@deepseek-ai/'.length)
    const alt = dir + pkg + '/lib/index.js'
    if (existsSync(alt)) return alt
  }
  return null
}

const TOOLS = resolveLib('dsh-tools')
const SESS = resolveLib('dsh-session')
if (!TOOLS || !SESS) {
  console.error('reapply-p0: could not locate dsh-tools/dsh-session lib under any known layout.')
  console.error('Install root changed? Look for node_modules/@deepseek-ai/dsh-tools or')
  console.error('node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools.')
  process.exit(1)
}
console.log(`lib layout: tools=${TOOLS}`)
console.log(`            session=${SESS}`)

const TAB = '\t'
let changed = false

// --- P0-1: dsh-tools render normalization -----------------------------------
let t = readFileSync(TOOLS, 'utf8')
if (t.includes('P0-1 write-path guard')) {
  console.log('P0-1: marker present, skip apply')
} else {
  const oldRender = `${TAB}${TAB}const content = snapshotProjection(tool.name, "render", rendered);`
  if (!t.includes(oldRender)) { console.error('P0-1: render anchor missing — lib changed?'); process.exit(1) }
  const helperAnchor = 'function snapshotToolValue(toolName, candidate) {'
  if (!t.includes(helperAnchor)) { console.error('P0-1: helper anchor missing — lib changed?'); process.exit(1) }
  const helper = `function normalizeRenderedContent(toolName, rendered, warn) {
  if (Array.isArray(rendered)) return rendered;
  const text = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
  if (warn) warn("tool \\"" + toolName + "\\" output.render() returned non-ContentBlock[] (" + typeof rendered + "); wrapping as a text block. Fix the plugin's output.render to return ContentBlock[].");
  return [{ type: "text", text }];
}

`
  t = t.replace(helperAnchor, helper + helperAnchor)
  const newRender = `${TAB}${TAB}const projected = snapshotProjection(tool.name, "render", rendered);
${TAB}${TAB}// P0-1 write-path guard: render() is typed ContentBlock[] but nothing
${TAB}${TAB}// enforces that at runtime; a contract-violating plugin would otherwise
${TAB}${TAB}// persist a record the session loader rejects on the next load. Normalize
${TAB}${TAB}// here so a bad render can never poison the log; warn the plugin author.
${TAB}${TAB}const content = normalizeRenderedContent(tool.name, projected, (message) => {
${TAB}${TAB}${TAB}this.ctx.logger.warn(message);
${TAB}${TAB}});`
  t = t.replace(oldRender, newRender)
  writeFileSync(TOOLS, t, 'utf8')
  changed = true
  console.log('P0-1: applied')
}

// --- P0-3: dsh-session append fail-fast --------------------------------------
let s = readFileSync(SESS, 'utf8')
if (s.includes('P0-3 write-path fail-fast')) {
  console.log('P0-3: marker present, skip apply')
} else {
  const oldAppend = `${TAB}${TAB}this.surfaceManager.validateNext(event);`
  if (!s.includes(oldAppend)) { console.error('P0-3: validateNext anchor missing — lib changed?'); process.exit(1) }
  const newAppend = `${TAB}${TAB}// P0-3 write-path fail-fast: enforce the same message-shape invariants the
${TAB}${TAB}// loader enforces at the seed boundary, so a malformed message can never be
${TAB}${TAB}// durably committed. assertMessageEventShape early-returns for non-message types.
${TAB}${TAB}assertMessageEventShape(event, "session append at seq " + event.seq);
${TAB}${TAB}this.surfaceManager.validateNext(event);`
  s = s.replace(oldAppend, newAppend)
  writeFileSync(SESS, s, 'utf8')
  changed = true
  console.log('P0-3: applied')
}

// --- structural verification (not just comment markers) -----------------------
console.log('--- verify ---')
const p1Ok =
  t.includes('P0-1 write-path guard') &&
  t.includes('normalizeRenderedContent(tool.name, projected, (message) => {') &&
  t.includes('function normalizeRenderedContent(toolName, rendered, warn)') &&
  !t.includes(`${TAB}${TAB}const content = snapshotProjection(tool.name, "render", rendered);`)
const p3Ok =
  s.includes('P0-3 write-path fail-fast') &&
  s.includes('assertMessageEventShape(event, "session append at seq " + event.seq);')
console.log(`P0-1 structural: ${p1Ok ? 'OK' : 'FAIL'}`)
console.log(`P0-3 structural: ${p3Ok ? 'OK' : 'FAIL'}`)
if (!p1Ok || !p3Ok) {
  console.error('reapply-p0: structural verification FAILED — patch state inconsistent.')
  process.exit(1)
}

// --- syntax check --------------------------------------------------------------
for (const f of [TOOLS, SESS]) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(`node --check FAILED on ${f}`)
    console.error(r.stderr)
    process.exit(1)
  }
}
console.log('node --check: both files pass')

console.log(changed ? 'PATCHED (restart DSH to load the guarded libs)' : 'DONE (no change needed)')
