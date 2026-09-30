# 本地内核补丁记录 (Path B)

## 补丁状态

作用于安装版 DSH (**0.1.0-rc.6**)：

| 补丁 | 文件 | 内容 | 状态 |
|---|---|---|---|
| P0-1 | `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js` | 写路径守卫 `normalizeRenderedContent`（L2458 helper / L3420 调用点） | ✅ 已应用 |
| P0-3 | `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js` | append fail-fast `assertMessageEventShape`（L1460-1463） | ✅ 已应用 |

安装根：`D:\tool\npmPlugin\`（上述相对路径从安装根起算）。

## 备份

同目录 `index.js.bak-p0`（原始未打补丁版本）：
- `...\dsh-tools\lib\index.js.bak-p0`
- `...\dsh-session\lib\index.js.bak-p0`

## 重打方法

```
node D:\tool\claude_code\dsh-hardening\reapply-p0.mjs
```
幂等：已应用则跳过并输出 `already applied`。检测依据是补丁写入的注释标记
（`P0-1 write-path guard` / `P0-3 write-path fail-fast`），不依赖文件时间戳。

DSH 升级会覆盖 lib → 重装后重跑本脚本即可恢复。

## 变更记录

- 2026-09-06：P0-1 + P0-3 首次应用（当时 lib 位于扁平布局 `node_modules/@deepseek-ai/dsh-{tools,session}/lib/`）。
- 2026-09-06：npm 重新安装后布局变为 **dsh 包内嵌 node_modules**
  （`@deepseek-ai/dsh/node_modules/@deepseek-ai/...`），补丁随文件保留；备份文件同步迁移。
- 2026-09-06：发现 `reapply-p0.mjs` 幂等检测与补丁实际文本不一致
  （检测 `normalizeRenderedContent(tool.name, projected)` 少了第三参数，
  实际写入为 `(tool.name, projected, (message) => {...})`）→ 即使补丁完好也会误报
  `render anchor missing` 并 exit 1。已改为检测注释标记 `P0-1 write-path guard`，修复后验证通过。
- 2026-09-06：`reapply-p0.mjs` 加固——
  ① 路径自动探测两种安装布局（扁平 / dsh 包内嵌），npm 布局漂移不再 ENOENT；
  ② 应用/跳过后再做**结构验证**（功能调用点存在、旧锚点已消失）+ 对两个 lib 跑 `node --check`，
     任一项失败 exit 1，杜绝"注释在但功能缺失"的半应用状态。
- 待办：若补丁文件路径再次漂移（下次升级布局变化），先 `node --check` 两个 index.js
  再跑 reapply-p0.mjs；锚点缺失时脚本会明确报 `anchor missing` 而非静默跳过。

## 说明

详细补丁内容见 [PATCHES.md](./PATCHES.md)；背景与分层见 [PLAN.md](./PLAN.md)。
