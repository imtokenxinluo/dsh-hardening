# DSH 会话损坏防护 —— 补丁实施手册（给 AI 修复代理）

> 读者：后续会话的 AI 代理。目标：照着本文档**独立、可靠地**在 DeepSeek Harness
> 上重新识别、应用并验证这些补丁，即使行号/版本已漂移。
>
> 审查背景与分层说明见同目录 [`PLAN.md`](./PLAN.md)；本文件只讲**怎么改、怎么验**。

---

## 0. 先读这节（30 秒总览）

问题本质：**DSH 把工具 `output.render()` 的返回值原样写入会话日志，从不校验形状；
形状契约只在加载路径强制执行，失败 = 整条会话历史不可加载**。2026-09 事故由插件
`dsh-ssh-ops` 的 `sftp_*`/`tunnel_*` 工具 render 返回裸字符串触发。

三层防护：

| 层 | 内容 | 落点 | 状态 |
|---|---|---|---|
| P0-1 | **写路径守卫（宽容规范化）**：render 返回非数组时包成 `[{type:"text",…}]` | `@deepseek-ai/dsh-tools`（内核） | 未应用（文档化，需 upstream/本地 patch） |
| P0-2 | 规范化前告警（`ctx.logger.warn`） | 随 P0-1 一起 | 未应用 |
| P0-3 | **append fail-fast（可选严格）**：写入时执行读路径同款消息校验 | `@deepseek-ai/dsh-session`（内核） | 未应用（有风险，需权衡） |
| P1 | **会话体检/修复插件**：scan + repair | 独立仓库 `dsh-session-doctor` | ✅ 已交付（本工作区） |
| P2 | 插件自身修复 + render 契约回归测试 | `dsh-ssh-ops`（第三方插件） | ⚠️ 本机已改，**升级/重装会丢** |

**给 AI 的关键提醒**：
- 本机对 `dsh-ssh-ops`（`D:\tool\dsh_data\profiles\web\node_modules\dsh-ssh-ops`）的
  src+lib 修改**不是持久的**——插件重新安装/更新后被覆盖。重新应用见 §5。
- P0 内核补丁从未应用（用户决定"仅文档化"）。是否本地应用需用户确认。
- 所有路径、行号基于 `dsh@0.1.0-rc.6`（2026-09-02 安装）。**先核对再改**。

---

## 1. P0-1 —— dsh-tools 写路径守卫（宽容规范化）

### 目标文件
`<dsh-install>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`

> 若用户以源码方式运行 DSH，同改 `packages/dsh-tools/src/…` 对应文件后重新构建；
> 此处以已安装的 `lib/index.js`（打包产物）为准。

### 锚点（先核对，行号会漂移）
在文件中搜索：
```js
rendered = tool.output.render(exec.arguments, value);
```
它位于 `createSuccessResult()` 方法内（0.1.0-rc.6 约 3404 行）。确认上下文含：
```js
const content = snapshotProjection(tool.name, "render", rendered);
```

### Before（现状）
```js
		let rendered;
		try {
			rendered = tool.output.render(exec.arguments, value);
		} catch (error) {
			throw projectionError(tool.name, "render", error);
		}
		const content = snapshotProjection(tool.name, "render", rendered);
```

### After（补丁后）
```js
		let rendered;
		try {
			rendered = tool.output.render(exec.arguments, value);
		} catch (error) {
			throw projectionError(tool.name, "render", error);
		}
		let content = snapshotProjection(tool.name, "render", rendered);
		// P0-1 write-path guard: render() must return ContentBlock[] per the tool
		// output contract. Tolerate a contract violation (bare string / scalar)
		// by wrapping it as a text block so the persisted tool/result record can
		// never poison session loading again (see assertMessageEventShape).
		if (!Array.isArray(content)) {
			this.ctx.logger.warn(
				`tool "${tool.name}" render() returned non-ContentBlock[] (${Array.isArray(content) ? "array" : typeof content}); wrapping as a text block. Fix the plugin's output.render to return ContentBlock[].`
			);
			content = [{
				type: "text",
				text: typeof content === "string" ? content : JSON.stringify(content)
			}];
		}
```

### 为什么这样改
- `createSuccessResult` 是**所有工具成功结果**的唯一收口；在这里兜底 = 保护任何插件。
- 宽容（包装而非抛错）：坏插件照常工作，但日志从此干净；`warn` 让作者/巡检能看到。
- 不改读路径语义，零回归风险；`content` 在 `materializePresentation` 时才 deepFreeze，
  此处可变。

### 验证
1. 语法：`node --check <该文件>`
2. 重启 DSH（`lib` 被进程加载，必须重启才生效）。
3. 调一个"故意返回字符串 render"的工具 → 会话日志里的 tool/result content 应为
   `[{type:"text",text:"…"}]`；随后加载该会话历史应成功。
4. 用 `dsh-session-doctor scan`（见 §4）确认 0 findings。

---

## 2. P0-3 —— dsh-session append fail-fast（可选，严格模式）

> **风险提示**：这是可选强化。它把"写入时校验"变成硬失败——一旦某插件写出违规消息，
> 工具调用会当场抛错而不是静默写坏。对已修复/守约的插件无影响，但对仍然违规的第三方
> 插件会让该调用失败。若追求兼容优先，可只做 P0-1 不做 P0-3。

### 目标文件
`<dsh-install>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`

### 锚点
在 `Session.append(type, data, ...opts)` 方法内（0.1.0-rc.6 约 1440 行），
定位这行：
```js
		this.surfaceManager.validateNext(event);
```
（在其**前**插入校验。）

### Before（现状）
```js
		const event = deepFreeze({
			type,
			seq: this.log.length,
			time: Date.now(),
			data: dataSnapshot,
			...surfaceMetadataSnapshot
		});
		this.surfaceManager.validateNext(event);
```

### After（补丁后）
```js
		const event = deepFreeze({
			type,
			seq: this.log.length,
			time: Date.now(),
			data: dataSnapshot,
			...surfaceMetadataSnapshot
		});
		// P0-3 write-path fail-fast: enforce the same message-shape invariants the
		// loader enforces at the seed boundary, so a malformed record can never be
		// durably committed (it used to fail only on the NEXT load, killing the
		// whole session history).
		switch (event.type) {
			case "user/message":
			case "assistant/message":
			case "tool/result":
				assertMessageEventShape(event, `session append at seq ${event.seq}`);
				break;
		}
		this.surfaceManager.validateNext(event);
```

### 前置条件 / 核对
- `assertMessageEventShape(event, subject)` 是同一文件内的顶层函数（0.1.0-rc.6 约
  1242 行），**模块内可直接调用**——先 grep 确认它仍存在且未改名。
- 它对 `user/message` 期望 `data` 即 message（无 `data.message` 包裹）；对
  `assistant/message`/`tool/result` 期望 `data.message`。核对与当前 `append` 各调用方
  传入的 data 形状一致（见同文件 `deriveEventMessage` / 各 producer）。
- 若某合法事件类型因此被误拒，说明该 producer 的形状与加载校验不一致——那正是此补丁
  要暴露的问题，但需逐个排查 producer。

### 验证
同 §1 的验证步骤；另可加负例：构造一个 content 为字符串的 `tool/result` append，
断言当场抛错、事件未入日志。

---

## 3. P1 —— 会话体检/修复插件 `dsh-session-doctor`

已交付（本工作区，git 仓库，3 commits）。**不依赖 DSH 运行环境**，纯 Node ≥22。

```bash
# 安装位置
D:\tool\claude_code\dsh-session-doctor

# 用法
node bin/dsh-session-doctor.js scan <sessions-root>      # 目录树扫描
node bin/dsh-session-doctor.js scan-file <session.jsonl.zstd>
node bin/dsh-session-doctor.js repair <file> [--dry-run] # 备份+无损修复

# 测试 / 真实副本验收
npm test
node scripts/verify-real.mjs
```

关键行为（re-check 用）：
- repair 前必备份（`<file>.<ts>.bak`）；产物先复验 0 失败才落盘；未损坏帧字节不变。
- 只修一种缺陷：`tool-result` 块 content 为裸字符串 → `[{type:"text",text:"…"}]`。
- 未知损坏形态：scan 报告、repair 跳过。
- v1 面向**冷会话**；与活跃 writer 并发无锁（live 场景属 watch 后续项）。

真实会话根（默认）：`D:\tool\dsh_data\sessions\--D-tool-claude_code--`

---

## 4. P2 —— dsh-ssh-ops 插件自身修复（本机已应用，需重打）

### 现状
`D:\tool\dsh_data\profiles\web\node_modules\dsh-ssh-ops`（v0.2.1）的
**src/index.js 与 lib/index.js** 已修复：所有 `output.render` 从返回裸字符串改为返回
`[{ type: "text", text: "…" }]`。

受影响工具（共 9 个，均为字符串→text 块包裹）：
- sftp_list、sftp_read、sftp_write、sftp_mkdir、sftp_delete、sftp_rename
- tunnel_start、tunnel_list、tunnel_stop

对照（本来就正确，勿动）：ssh_list / ssh_connect / ssh_exec / ssh_read / ssh_write /
ssh_disconnect。

### 重新应用的方法（升级/重装后）
该插件从 GitHub 安装（`caoyiwei850/dsh-ssh-ops`），重装会覆盖本地修改。重新应用 =
把上述 9 个工具的 `output.render` 返回值改为数组字面量。模式：

```js
// Before（错误）
render(args, value) {
  return `Wrote ${value.bytes} bytes to ${value.path}`;
}
// After（正确）
render(args, value) {
  return [{ type: "text", text: `Wrote ${value.bytes} bytes to ${value.path}` }];
}
```

用仓库内的审计脚本找"render 返回裸字符串"的残留（**不要**用内联 node -e——
PowerShell/各 shell 的引号转义会让正则失效，已实测踩坑）：

```bash
# 已修补文件 → 应输出 NO OFFENDERS（exit 0）
node D:\tool\claude_code\dsh-session-doctor\scripts\audit-render-contract.mjs \
     <dsh-ssh-ops>/src/index.js <dsh-ssh-ops>/lib/index.js

# 未修补/回归文件 → 应列出每个 OFFENDER（exit 1）
```

该脚本（`audit-render-contract.mjs`）用保守正则：`name:"tool"` → 600 字符内找
`render(...) {` → 取其后首个 `return`，若不以数组字面量开头即判 OFFENDER。已验证：
干净文件 0 offender、合成坏 fixture 精确抓出 `sftp_write_bad`。若 DSH 升级改变了
工具定义排版，先小样验证脚本再全量跑。

### 根因修复建议（长期）
把本机修复提交到 dsh-ssh-ops 的 GitHub 上游（作者仓库），并在其 CI 加一条 render
契约断言（扫描所有 `output.render` 的 return 必须以数组字面量开头）。

---

## 5. 版本漂移与重打核对清单（每次 DSH 升级后）

DSH 是 npm 安装的（`@deepseek-ai/dsh@0.1.0-rc.6`），`node_modules` 内的一切本地修改
都可能被升级覆盖。升级后按此清单重打：

```bash
# 1) 核对 dsh 版本与补丁落点是否仍在
Get-Content <dsh>/package.json | Select-String version        # 期望 0.1.0-rc.6 或确认新版本
node --check <dsh-tools>/lib/index.js                          # P0-1 语法
# grep 锚点是否还在：
#   dsh-tools:  "rendered = tool.output.render(exec.arguments, value);"
#   dsh-session: "this.surfaceManager.validateNext(event);" + "assertMessageEventShape"

# 2) 重打 dsh-ssh-ops（§4），若插件已更新则先查上游是否已带修复

# 3) 用 session-doctor 全量体检（发现历史残留损坏）
node D:\tool\claude_code\dsh-session-doctor\bin\dsh-session-doctor.js scan D:\tool\dsh_data\sessions

# 4) 如发现损坏会话 → repair（自动备份）
node ... scan-file <file>    # 查看
node ... repair <file>       # 修复

# 5) 用 render 契约审计脚本查插件回归（§4）
node D:\tool\claude_code\dsh-session-doctor\scripts\audit-render-contract.mjs \
     D:\tool\dsh_data\profiles\web\node_modules\dsh-ssh-ops\lib\index.js
```

---

## 6. 一句话决策树（给 AI）

- 用户问"会不会再坏/怎么防" → 讲 P0-1（写路径守卫）+ P2（插件上游修复）。
- 用户说"现在就把内核补丁打上" → 应用 §1（P0-1），可选 §2（P0-3，先说明风险）。
- 用户说"历史又加载不了" → 先用 §3 的 scan 定位，再用 repair 修复；不改内核。
- 用户说"升级后还要不要重弄" → §5 清单。
- **改任何内核文件前先确认用户同意**（历史决策：仅文档化，不本地改内核）。

---

## 7. 附录：本次事故与修复的完整事实链（供文档交叉引用）

- 会话 `session-e55beedf-7698-482d-bce4-23501848775e`：2026-08-16 创建，
  09-02 两次因 sftp_write 坏记录无法加载历史；已两次无损修复并复验 0 failures。
- 受影响的其它旧会话（同病，已定位未动）：`session-890ef838`@seq115441(sftp_mkdir)、
  `session-1ea23697`@seq43861(sftp_mkdir)、`session-49e6040e`@seq326814(sftp_write)。
- 会话中断的直接诱因（独立问题）：DeepSeek API 反复 `TRANSPORT` 错误 + compaction 失败。
- 校验规则出处（读路径，勿改语义）：`dsh-session/lib/index.js`
  `adoptSessionEvent` → `assertMessageEventShape`（要求 tool-result 块 content 为数组、
  toolCallId 匹配 source.callId）。
- 契约出处：`dsh-tools/lib/types/schema.d.ts` —— `render(...): ContentBlock[]`。
