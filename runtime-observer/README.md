# Claude Code Runtime Observer

这个工具把正式 Claude Code for VS Code 当作黑盒运行：Observer 打开一个独立、可见的 VS Code 原生 Claude 面板；用户亲自提交预填 Prompt，并在原生 UI 中处理所有权限、问题和计划确认。Observer 只负责隔离 33333 路由、录制、覆盖审计和源码对照。

正常入口是项目 Skill：

```text
/observe-claude <原始 Prompt>
```

用户只提供原始 Prompt；Skill 从当前会话自动取得 workspace，其他端口、profile、Session ID、capture 和 replay 参数全部由 Coordinator 管理。Prompt 逐字预填且不会自动提交。长生命周期由 `observe-claude-coordinator.mjs` 的 detached worker 持久化到 `.claude/observe-claude/jobs/`，因此不依赖调用它的 Bash 工具持续存活；同一 workspace + Prompt 的重复调用只查询或恢复已有任务。

Observer 现在由同一份源码驱动的 Reference Model 约束：

- [Runtime Architecture](RUNTIME-ARCHITECTURE.md)：完整运行架构。
- [Observation Point Registry](OBSERVATION-POINTS.md)：每个节点的触发、证据和不变量。
- [Observation Roadmap](OBSERVATION-ROADMAP.md)：哪些机制需专项 Case、哪些捕获器尚待实现。
- `runtime-model.mjs`：机器可读注册表，Coverage Auditor 与文档共用。
- 开发 Observer（以及仅用于本地 fake-upstream 测试的 Recording Proxy）：保存每轮完整 `request.raw` entity body、可解析时的完整 `request.parsed.json`、可观察对照视图和原始 SSE 响应；认证 Header 只转发不保存。
- Coverage Auditor：自动标记 CAPTURED / DERIVED / PARTIAL / MISSING / NOT_TRIGGERED / NOT_EXPOSED。
- Teaching Replay：中文逐步回放，并链接 Raw Event 与对应源码。

## 输出位置

所有真实 Run 写到仓库根目录下：

```text
E:/repo/.claude/claude-code-runs/<run-id>/
```

仓库的 `/.claude/` 已被 Git 忽略，运行材料不会进入版本控制。

运行完成后的主入口由唯一 Notebook 生成：

```text
E:/repo/agent-maestro-observer/data/sessions/<session-id>/runtime-replay.html
```

Coordinator 在原生 Session `running → idle` 且 capture quiet 后，以 `OBSERVER_SESSION_ID` 执行 `agent-maestro-observer/data/build_session_replays.ipynb` 的全部单元格。禁止再维护另一套 HTML 生成器。

直接双击即可打开，不需要服务器或网络。当前页面以**真实模型 API Turn**为唯一主线：每个 `POST /v1/messages` 都显示 Complete Request → Complete Response/SSE → Local Runtime Bridge → Next Request，直到 Final Result。hello 与 count_tokens 作为辅助请求排除，不计入 Turn。每个 Turn 内可直接展开完整 Request、System、Messages、Tool Schemas、Controls、Raw SSE、Parsed SSE、Response Blocks、Tool Input/Result 和下一 Request 回填位置。

证据标签含义：`OBSERVED` 是原始材料直接存在，`DERIVED` 是有明确规则的关联/分类，`REDACTED` 是遗留 Run 在边界收到但只保留 hash/大小，`NOT_EXPOSED` 是运行时或模型没有输出。新 Run 的请求正文完整保存在本地；认证 Header 和模型未返回的私有 chain-of-thought 仍不记录或伪造。

Markdown/JSON 继续作为底层证据与机器可读数据：

```text
<run>/04-readable/replay-model.json        Dashboard 统一数据模型
<run>/04-readable/14-TEACHING-REPLAY.md    中文顺序说明
<run>/04-readable/13-CAPTURE-COVERAGE.md   完整度与遗漏
<run>/04-readable/15-PROMPT-TURNS.md       每轮 Prompt/Messages/Tools
<run>/04-readable/16-TOOL-LIFECYCLES.md    Tool 内部生命周期
<run>/04-readable/17-API-TURNS.md          Request/Response 跨轮变化
<run>/04-readable/18-FINAL-REPORT.md        最后完整可见报告
<run>/00-task/routing-fidelity.json          路由有效性判定
<run>/01-live-stream/network-connections.jsonl 进程树 TCP 原始证据
```

所有 Run 的 HTML 入口位于 `E:/repo/.claude/claude-code-runs/INDEX.md`，跨 Case 对比位于 `COMPARE.md`。

## 先看当前会话 Case 00

```text
E:/repo/.claude/claude-code-runs/case-00-current-session/04-readable/00-INDEX.md
```

重新生成：

```bash
node ClaudeCode/claude-code-analysis/runtime-observer/run-observed-session.mjs \
  --replay-session d1d34c8a-9d10-4f56-9f88-4df1cd01240c \
  --run-id case-00-current-session
```

## 启动可见的原生 VS Code 观察 Session

先构建一次本地路由 wrapper（使用 Windows 自带 .NET Framework C# compiler；它不改变 SDK 参数，只在末尾追加一个仅含 `ANTHROPIC_BASE_URL=33333` 的 `--settings` overlay；不处理 Prompt、模型、认证或权限）：

```bash
npm --prefix ClaudeCode/claude-code-analysis/runtime-observer run build:native-wrapper
```

然后启动 Case：

```bash
node ClaudeCode/claude-code-analysis/runtime-observer/run-observed-session.mjs \
  --workspace E:/repo \
  --prompt "检查登录 Bug，先计划，再修改并测试"
```

Observer 会启动一个**独立、可见的 VS Code 进程**，并在 Claude Code 原生面板中预填 Prompt。它不会自动提交：用户检查原文后按 Enter；任何 Bash/Edit/AskUserQuestion/Plan 权限均在该面板中显示并由用户点击。普通 VS Code 窗口继续走 23333，Observer 窗口只走 33333。

默认模式不 spawn `claude -p`，不设置 tools/model/effort/budget/max-turns/System Prompt/Session ID，不自动同意权限，也不复制或沙箱化工作区。它与正常窗口共享同一 Claude 配置、skills、memory、Hooks、MCP 和认证来源；独立的是 VS Code user-data 与 endpoint-only overlay，配置正文和 Token 不复制到 Run。只有显式 `--legacy-headless-nonparity` 才允许启动旧 headless 路径，且该 Run 必须标成 `LEGACY_HEADLESS_NONPARITY`。

## Routing-fidelity guard

每个非 dry-run 必须生成：

```text
<run>/01-live-stream/network-connections.jsonl  Windows 进程树与 TCP 采样原始证据
<run>/00-task/routing-fidelity.json              最终路由判定
```

Observer 用普通用户可运行的 Windows 原生命令采样：进程树优先 `Get-CimInstance Win32_Process`（兼容回退到 `Get-Process` parent lookup），TCP 表优先 `Get-NetTCPConnection`（兼容回退到 `netstat.exe -ano -p tcp`），不要求管理员权限。Native profile 通过 wrapper 记录扩展实际启动的 bundled Claude PID，再以该 PID 为路由证据根。有效实验必须同时满足：

- 原生 Claude Code 进程树至少一次连接 loopback `33333`；
- 子进程树没有任何连接 loopback `23333`；发现一次即标为 `ROUTING_FIDELITY_FAILED`；
- 监控成功启动、持续到子进程结束，且进程树/TCP 样本完整。

未观察到 `33333` 时是 `ROUTING_FIDELITY_FAILED`；PowerShell/进程表/TCP 表不可用、监控中断或证据不完整时是 `ROUTING_EVIDENCE_UNAVAILABLE`，绝不声称成功。`verify-run.mjs` 和 Coverage lifecycle invariant 都会拒绝这两种无效状态。

Prompt 是研究变量：`--prompt` 的 Unicode 字符串只通过 Claude Code 扩展官方 `/open?prompt=...` URI 预填到可见输入框；Observer 不自动按 Enter、不附加换行、不扩写、不编译。用户提交后，用 Transcript 首个 user 和 33333 首个模型 Request 逐字验证。NUL 与无效/未配对 UTF-16 surrogate 会在启动前拒绝。可选的父消息 provenance 不改变 Prompt：

```text
--prompt "用户原话"
--original-query "用户原话"  # 可选；若提供，必须与 --prompt 完全相同
--parent-session-id <session-id>
--parent-message-id <message-uuid>
```

`--task` 仅作为 `--prompt` 的兼容别名；`--task-compiler` 仅是 legacy 参数，新 Run 会拒绝非 identity compiler。Run 完成后，`00-task/prompt-fidelity.json` 会把 launch payload 与首个 main-chain transcript user、首个模型 Request 的 user 输入逐字对照。只有全部可用证据相等才标为 `verbatim`；值不同标为 `provenance-mismatch`；新 Run 缺 transcript/API 证据标为 `evidence-unavailable`；历史证据不足标为 `legacy-unverified`；历史改写标为 `legacy-rewritten`。声明的 parent session/message ID 未解析到父 transcript 时只标为 declared-unverified。Observer 不设置模型、预算或运行时限，避免改变 Session 的自然执行路径。

只重建已有 Run 的 Dashboard（不会调用模型）：

```bash
node ClaudeCode/claude-code-analysis/runtime-observer/rebuild-dashboard.mjs --all
```

Native Run 不允许 Observer 设置 System Prompt、工具、模型、effort、预算、超时、Session ID 或权限答案。原生扩展自然提供 `claude-vscode` System Prompt、IDE Context、Hooks、MCP 与默认工具。独立 profile 唯一行为控制是 33333 路由和 Manual/default 权限模式；后者只确保 UI 显示授权，不代表 Observer 作出决定。

新版 Proxy 会在 `request.raw`/`request.parsed.json` 中保存实际转发的完整 System Prompt、System Reminder、Operator Message、历史 Messages、Tool Schemas 与请求参数；`request.observable.json` 仍保留 hash/省略版本用于对照。该变化无法补回历史 Run 已经丢弃的正文。

## 启动预定义实验

只读主循环：

```bash
node ClaudeCode/claude-code-analysis/runtime-observer/run-observed-session.mjs \
  --case case-01-read-search
```

Bug 修复：

```bash
node ClaudeCode/claude-code-analysis/runtime-observer/run-observed-session.mjs \
  --case case-02-bug-fix
```

Subagent：

```bash
node ClaudeCode/claude-code-analysis/runtime-observer/run-observed-session.mjs \
  --case case-03-subagent
```

Hook：

```bash
node ClaudeCode/claude-code-analysis/runtime-observer/run-observed-session.mjs \
  --case case-04-hooks
```

这些命令会调用真实模型并产生 API/订阅用量。Observer 将每次运行放到新的 Run ID 下，不覆盖历史实验。

## 每个 Run 的阅读顺序

```text
04-readable/00-INDEX.md
   │
   ├─ 01-WORKFLOW.txt             总体循环
   ├─ 02-TIMELINE.md              全部持久化事件
   ├─ 03-CONVERSATION.md          可见对话
   ├─ 04-TOOL-CALLS.md            Tool 输入与完整返回
   ├─ 05-SUBAGENTS.md             子 Agent sidechain
   ├─ 06-TASKS-HOOKS-PERMISSIONS.md
   ├─ 07-SESSION-GRAPH.md         UUID / parentUuid
   ├─ 08-SOURCE-WALKTHROUGH.md    事件对应源码
   ├─ 09-STATS.json
   ├─ 10-LIVE-STREAM.md           从启动时录制的 stream-json
   ├─ 13-CAPTURE-COVERAGE.md      架构节点覆盖与生命周期不变量
   ├─ 14-TEACHING-REPLAY.md       中文逐步回放
   ├─ 15-PROMPT-TURNS.md          每轮 Messages / Tools / 请求参数
   ├─ 16-TOOL-LIFECYCLES.md       校验→Hook→Permission→执行→Result
   └─ 17-API-TURNS.md              API Request / SSE Response 跨轮变化

05-api/
   ├─ requests.jsonl
   └─ request-0001/
      ├─ request-metadata.json
      ├─ request.raw                  实际转发的完整 HTTP entity body
      ├─ request.parsed.json          完整 JSON（可解析时）
      ├─ request.observable.json      省略/Hash 对照视图
      ├─ response-metadata.json
      ├─ response.raw
      └─ summary.json
```

Raw 文件位于 `01-live-stream/`、`02-session/` 和 `03-workspace/`。`manifest.sha256` 校验 Run 中每个文件。

## 观测边界

Coverage 文件才是“录到什么程度”的权威答案：只有直接证据完整才标 CAPTURED；只覆盖部分生命周期标 PARTIAL；本 Case 未触发标 NOT_TRIGGERED；正式二进制/模型平台没有输出标 NOT_EXPOSED。

Observer 记录正式 CLI 实际公开或持久化的内容，包括可见文本、Tool 输入/结果、绝对路径、文件快照、Debug，以及开发 Observer（本地测试时为 Recording Proxy）实际转发的完整 Request entity body 和收到的 Response body。`request.raw` 是 Node HTTP 层解 transfer framing 后的 entity body，不是 TCP 抓包；Header 原始顺序/大小写和 chunk framing 不在其中。认证 Header 永不落盘；模型没有返回的私有 chain-of-thought 不存在可录内容，也不会伪造。
