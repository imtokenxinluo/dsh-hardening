# DSH 会话损坏防护：审查与补丁清单

> 背景：2026-09-02 会话 `session-e55beedf` 两次因 `sftp_write` 工具结果损坏而无法加载。
> 根因是插件 `dsh-ssh-ops` 的 `output.render()` 返回裸字符串，违反 `ContentBlock[]` 契约；
> DSH 写路径从不校验消息形状，加载时才整体拒载。
> 本文档基于 `@deepseek-ai/dsh@0.1.0-rc.6`（node_modules 内）逐行审查，列出需要补的位置与插件化边界。

---

## 1. 现状：三处校验的不对称（问题核心）

### 1.1 写路径（Session.append）—— 不校验消息形状
`dsh-session/lib/index.js:1440` `Session.append()`：
- 校验：JSON 可序列化、request-header 词汇、surface 元数据（`surfaceManager.validateNext`）
- **不校验**：消息 content 形状（role/source/content 块结构）

所以 `tool/result` 消息 content 里塞裸字符串也能 append、能持久化、运行期无任何报错。

### 1.2 工具结果（dsh-tools）—— render 返回值原样落库
`dsh-tools/lib/index.js:3397` `createSuccessResult()`：
```js
rendered = tool.output.render(exec.arguments, value);   // 3404
const content = snapshotProjection(tool.name, "render", rendered); // 3408
```
- 契约要求 `render(): ContentBlock[]`（`dsh-tools/lib/types/schema.d.ts:190`）
- 但运行时**从不验证**返回值是数组；字符串被当成 content 原样快照。
- `defineTool`（index.js:836）也只包装调用，不做返回校验。

### 1.3 读路径（加载/恢复）—— 唯一有形状校验的地方，且整体拒载
`dsh-session/lib/index.js:1153` `adoptSessionEvent` → `assertMessageEventShape`（1242）：
```js
if (content.length !== 1 || ... || !Array.isArray(block["content"])) throw ...
```
`dsh-session-persistence/lib/index.js:1015` `prepareCore` 把任何校验失败包成
`SessionPersistenceCorruptionError` → **整条会话历史不可加载**（除 torn-tail 自动丢弃外无自动恢复）。

**结论**：形状契约只在读路径强制执行，且失败模式是"整会话死亡"而不是"写入时拒绝/规范化"。

---

## 2. 补丁清单（按层划分）

### P0 内核写路径守卫（治本，推荐给 upstream / 本地补丁）

| # | 位置 | 改动 | 效果 |
|---|------|------|------|
| P0-1 | `dsh-tools/lib/index.js` `defineTool()`（836）或 `createSuccessResult()`（3404-3408） | render 返回非数组时规范化：字符串 → `[{type:"text",text}]`；其它非数组 JSON 值 → JSON.stringify 包 text；数组则原样 | 任何插件（含未来第三方）都无法再写坏 content |
| P0-2 | 同上，或 `snapshotProjection` 入口 | 规范化前 `ctx.logger.warn`（工具名 + 违规形态），便于发现插件作者 | 可见性：不再是"静默写坏" |
| P0-3 | `dsh-session/lib/index.js` `Session.append()`（1440） | 对 message 类事件（user/message、assistant/message、tool/result）在 append 时执行与读路径相同的 `assertMessageEventShape` | 写入即失败（fail fast），坏事件进不了日志 |

> 取舍：P0-1 是**宽松兼容**（坏插件照常工作但不再污染）；P0-3 是**严格 fail-fast**（坏插件直接抛错）。
> 建议组合：P0-1（写路径自动规范化，保底）+ P0-3（正式契约校验，可选 strict）。两者都不破坏现有合法工具。

### P1 读路径容错/恢复（救急，插件可做）

| # | 位置 | 改动 | 效果 |
|---|------|------|------|
| P1-1 | 新维护插件（本仓库交付） | `scan`：遍历全部 stored sessions，逐条跑读路径同款校验 → 报告损坏会话/seq/工具名 | 主动发现，不再等 GUI 报错 |
| P1-2 | 同上 | `repair`：对损坏日志做无损修复（备份 → 字符串 content 包 text 块 → 重写 zstd 帧） | 一条命令恢复历史 |
| P1-3 | 同上（✅ v1.1 已交付 2026-09-02） | `watch`：订阅 `session/event` / `session/flush`，对新 tool/result 做形状校验 → 实时告警 | 写入即发现，会话活着时就能修 |

> P1-1/2/3 全部可以做成纯插件（不碰内核）：只需要 `ctx.sessionPersistence` / `ctx.sessions` 的只读+管理能力，已确认这些服务对插件可见。
> P1-3 watch 边界（如实）：`session/event` 在 append **之后**触发，watch **不阻止写入**
> （事前拦截属 P0 内核守卫）；live 会话由 writer 占用，watch 只告警、不改文件
> （修复交给冷会话的 repair）。

### P2 插件生态契约（防止再犯）

| # | 位置 | 改动 | 效果 |
|---|------|------|------|
| P2-1 | `dsh-ssh-ops`（插件自身） | 把本次修复（src+lib 15 处 render 返回数组）提交到其 GitHub 上游 | 官方版本不再带病 |
| P2-2 | `dsh-ssh-ops` 或共享包 | 静态审计脚本（检查 render 返回 `ContentBlock[]`）加进其 CI/测试 | 防回归 |
| P2-3 | 新维护插件 | `audit-tools`：遍历 `ctx.tools` 已注册工具，逐一定义做 render 契约冒烟检查 | 部署期体检所有插件 |

---

## 3. 插件化边界（哪些必须动内核、哪些插件可做）

已确认的事实（源码证据）：

1. **写路径守卫必须动内核**：`Session.append` 与 `dsh-tools.createSuccessResult` 都在
   `@deepseek-ai/dsh` 内部，第三方插件无法在 append 前拦截。
   - 插件能做到的最近替代：订阅 `session/event`（store 用 `ctx` dispatch，插件可收），
     在事件进 log 后**立即校验并告警**——阻止不了，但让用户当场知道。
2. **扫描/修复/审计完全可插件化**：
   - `SessionStore.list()`（index.js:1823）、`ctx.sessionPersistence` 的
     `load`/`inspect`/`listSnapshots`/`readFrom` 都是公开服务 API；
   - zstd 帧解码/重写逻辑无内部依赖（本次脚本已验证）。
3. **load 时自动修复有风险**：DSH 有意让 committed corruption 整体拒载（防静默吞数据），
   改读路径语义需要 upstream 决策；插件提供显式 `repair` 工具是安全折中。

---

## 4. 建议的最终形态

- **内核（上游/本地 patch，2 个小改动）**：P0-1 写路径规范化 + P0-3 append 契约校验。
- **开源维护插件（本仓库）**：P1 scan/repair/watch + P2-3 audit-tools。
  - 命名建议：`dsh-session-doctor`
  - 依赖：`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-session-persistence`（仅类型/服务引用）
  - 结构参照工作区已有插件：`dsh-tip-jar`（src/lib/package.json/cordis.patch.yml + tgz 发布）
- **社区**：`dsh-ssh-ops` 的 15 处 render 修复提交上游（P2-1/P2-2）。

---

## 5. 附录：本次事故时间线（供文档引用）

- 会话创建 08-16，最后写入 09-02 22:47（TRANSPORT 错误 + compaction 失败终止）
- 09-02 23:21 首次修复 3 条坏事件（seq 996465/467/469）
- 会话被继续运行到 23:26，又产生 2 条坏事件（seq 998919/998921，sftp_write）
- 扫描确认 4 个会话受影响（e55beedf + 3 个旧会话），全部为 sftp_*/tunnel_* 工具
- 根因 = dsh-ssh-ops `render()` 返回裸字符串；已修补 src+lib 15 处
