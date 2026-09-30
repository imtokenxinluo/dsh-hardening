# DSH 内置模式（Agent Presets）速查

> 来源：`D:\tool\npmPlugin\node_modules\@deepseek-ai\dsh\config\agent-presets\<id>\`
> 每个 preset = `agent.cordis.yml`（插件组装）+ `preset.yml`（名称/简介/排序）。
> 记录时间：2026-09 本机 `0.1.0-rc.6`。升级后请复核（目录与行数可能变化）。

## 一图流：4 个内置模式

| 模式 | preset id | order | 定位（preset.yml 自述） |
|---|---|---|---|
| **标准模式** | `standard` | 1 | 功能完整的编码 Agent：文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流 |
| **PTC 模式** | `code` | 2 | 具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作 |
| **极简模式** | `minimal` | 3 | 仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent |
| **创造模式** | `cordis` | 4 | 用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导 |

用户自定义 preset 目录：`${DSH_HOME}/.agent-presets/<id>/`（本机 `D:\tool\dsh_data\.agent-presets\`，
2026-09 时为空——多角色预设已按用户决定删除）。

## 插件行构成（顶层行数，剔除 persona/agent-instructions）

| preset | 行数 | = 什么 + 什么 |
|---|---|---|
| standard | 27 | 公共基础（全量） |
| code | 28 | standard + `tool-presentation` |
| cordis | 28 | standard + `tool-cordis` + `editing-cordis-compositions` skill + 专属 persona |
| minimal | 7 | 独立瘦身骨架：filesystem / fs-local / persistent-bash / persistent-shell / pty / terminal-bash / str-replace-editor |

> code 与 cordis 的插件行差异 = 各自独有 1 行，其余 27 行完全一致。
> minimal 不是"standard 减配"，而是另一套只含持久 shell + 文件编辑的最小组合。

## 三个全量模式各自多出的那 1 样东西

### code = standard + `tool-presentation`（Code Mode 呈现层）
- 行：`- id: tool-presentation / name: '@deepseek-ai/dsh-agent-tool-presentation' / mode: code`
- 文件自述：*"the standard coding agent, presented as Code Mode … the model writes a
  TypeScript program against a generated SDK and `run_code` executes it, so a
  sequence that would be five round trips becomes one."*
- 本质：**呈现层优化，不加能力**——把"一次动作 = 一个工具调用"换成"写一段 TS 程序一次跑完"，省模型往返。

### cordis = standard + `tool-cordis`（自指工具集）+ skill + persona
- 行：`- id: tool-cordis / name: '@deepseek-ai/dsh-tool-cordis'`（section: self-modification）
- skill：`editing-cordis-compositions`（随 preset 自带 `skills/` 目录，教 agent 如何写/改 composition）
- persona 额外指令：
  - 区分 **HOST 平面**（注册表、跨会话共享：persistence、sandbox/approval、model route、subagent registry）
    与 **AGENT PRESET 平面**（单会话贡献：tools、persona、prompt sections）；
  - 自建 preset 写到 `${DSH_HOME}/.agent-presets/<id>/`；
  - **NEVER 编辑/删除安装目录里的 shipped preset**（升级会覆盖，且毁掉 cordis preset = 毁掉本模式本身）；
  - 改 composition 前先加载 `editing-cordis-compositions` skill。
- 文件自述：*"It exists so a person can ask an agent to author another agent."*
- ⚠️ TRUST：`cordis_mount` 会对**实时运行时**执行模型写的 JavaScript；该 preset 写出的
  composition 会成为**其他会话要挂载的 preset**。文件头警告：
  *"Treat a session on this preset as shell access."* —— 即创造模式的信任等级 ≈ shell 权限。

### minimal（7 行）
- 持久 shell（persistent-bash / persistent-shell / pty / terminal-bash）+ 文件编辑
  （filesystem / fs-local / str-replace-editor）。无检索、无 skills 装载、无子代理等。

## 实践结论（对本工作区）

1. **给 DSH 写外部插件**（独立仓库：`dsh-session-doctor`、`dsh-session-backup`）——
   标准模式完全够；插件本体是普通 Node 包，不需要"能改运行时"的能力。
2. **创造模式真正适合的场景** = 让 agent 现场创作/实验另一个 preset 或动态插件并立即挂载
   （原型验证），因其信任等级高，不适合日常干活。
3. 若想长期用某套定制行为：copy shipped preset 到 `~/.dsh/.agent-presets/<id>/` 再编辑副本，
   **不要动安装目录原文件**。
4. 升级 DSH 后此文件可能失真，复核命令：
   `config/agent-presets/<id>/preset.yml` 看 name/order；插件行用 grep `^- id:` 计数对比。
