# claude-code-analysis Milestone 日志

本文件以 append-only 方式记录对 Claude Code 架构学习与面试化理解过程中，无法仅靠源码静态阅读顺手还原的学习目标、讲解顺序和已锁定的理解框架。

---

## Milestone @ 2026-08-26 — 教学顺序从“类级导览”改为“主流程优先、例子驱动、面试可复述”

### 用户的核心需求

用户要的不是零散源码导览，而是能真正“学透 Claude Code / 本地 Agent Runtime 并支撑面试”的学习路径。用户明确指出，按类或按文件逐个解释很难抓住重点；必须先从宏观整体流程出发，再抽丝剥茧地下钻微观实现，而且每一课都需要一个具体例子，不能让用户抽象猜流程。

用户还明确要求：讲到关键实现时必须给出可以直接点击跳转的源码位置，最好带行号，方便立刻对照真实 Prompt、真实入口和真实状态流。

### 关键决定

- **学习顺序锁定为“流程优先，再模块下钻”**：否决按组件/类/文件逐个罗列作用的讲法，改成按真实运行流水线组织课程：启动 -> 输入进入系统 -> 上下文组装 -> 模型 streaming -> tool_use/tool_result -> 权限/沙箱 -> memory 提取 -> history/resume -> plan mode / subagent 等扩展链路。
- **每一课都必须有贯穿例子**：不再只讲抽象概念。固定使用类似“读 README.md 并总结”“复杂需求进入 Plan Mode”“用户表达长期偏好写入 memory”这类例子，从用户输入一路追到 runtime 行为和源码位置。
- **源码引用格式锁定为可点击的 `path#Lx-Ly` 链接**：否决 `vscode-file://` 这类用户点不开的格式。以后凡是讲关键入口、Prompt、状态切换、fork 逻辑，都必须附带类似 `ClaudeCode/claude-code-analysis/src/...#Lx-Ly` 的链接，方便用户直接核对。
- **把 Claude Code 定义为“本地 Agent Runtime”，而不是 CLI 聊天工具**：后续所有课程都围绕这一前提展开，重点讲主循环、上下文、工具权限、memory 与 plan mode，而不是把注意力放在表面命令行交互上。

### 核心实现思路

课程结构围绕一条主链展开：

CLI / 启动分流 -> REPL/TUI -> PromptInput -> QueryEngine / query -> Claude streaming -> tool_use -> permission / sandbox -> tool execution -> tool_result 回流 -> transcript / memory / plan mode 扩展。

每节课固定输出：一个例子、一张流程图、几段关键源码、主要设计取舍和一段可直接用于面试复述的答案。讲 memory、plan mode、attachment、forked subagent 这类容易混的主题时，强制区分“主 agent 正在做的事”和“后台/扩展链路在做的事”，避免用户把多个机制混为一谈。

### Baseline / TODO（可选，没有就省略）

- 已经用这个新教学框架讲清了几条关键链路：主启动与多运行形态、PromptInput 到 `processUserInput`、上下文组装、tool_result 回流、memory extraction subagent、Plan Mode 与 plan file / attachment / approval 流程。
- 后续继续讲时，必须保持“少讲枝节、多讲主线”的节奏；尤其当用户问某个局部机制时，要先说明它处在整体链路的哪一环，再解释它本身。