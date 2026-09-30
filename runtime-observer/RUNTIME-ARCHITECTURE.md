# Claude Code Runtime Reference Model

这份 Reference Model 的作用不是概述产品功能，而是定义 Observer 必须覆盖的完整运行生命周期。每个真实 Case 都由 [runtime-model.mjs](runtime-model.mjs) 中的 Observation Point Registry 自动审计。

## 总体运行架构

```text
┌────────────────────────────────────────────────────────────┐
│ 1. BOOT 启动与配置                                         │
│ visible claude-vscode / native settings / model / tools / permission UI │
└────────────────────────────┬───────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────┐
│ 2. INPUT 任务输入                                           │
│ user prompt / attachment / slash / hook / remote / queue   │
└────────────────────────────┬───────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────┐
│ 3. CONTEXT Context Compiler                                │
│ system + CLAUDE.md + memory + tools + runtime + messages   │
└────────────────────────────┬───────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────┐
│ 4. API 最终请求与传输                                       │
│ request body / SSE / retry / fallback / usage / errors     │
└────────────────────────────┬───────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────┐
│ 5. QUERY 跨轮状态机                                         │
│ text / tool_use / transition / stop hook / terminal        │
└───────────────┬─────────────────────────────┬──────────────┘
                │                             │
          final answer                  tool_use
                │                             ▼
                │       ┌────────────────────────────────────┐
                │       │ 6. TOOL / PERMISSION / HOOK       │
                │       │ schema → semantic → pre-hook      │
                │       │ → permission → sandbox/call       │
                │       │ → progress → post/failure hook    │
                │       └───────────────────┬────────────────┘
                │                           ▼
                │                      tool_result
                │                           │
                │                           └──► 回到 CONTEXT/API/QUERY
                ▼
┌────────────────────────────────────────────────────────────┐
│ 7. TASK / SUBAGENT / TEAM                                  │
│ async task / sidechain / mailbox / handback / notification │
└────────────────────────────┬───────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────┐
│ 8. CONTEXT MANAGEMENT                                      │
│ tool-result budget / microcompact / summary / memory       │
└────────────────────────────┬───────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────┐
│ 9. PERSISTENCE / RECOVERY                                  │
│ transcript / file history / plan / resume / fork/worktree  │
└────────────────────────────┬───────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────┐
│ 10. SIDE EFFECT / UI / OBSERVABILITY                       │
│ files / shell / MCP / network / TUI / debug / trace / cost │
└────────────────────────────────────────────────────────────┘
```

## 每个节点必须回答六个问题

```text
进入节点前的状态
       │
       ▼
节点收到的输入
       │
       ▼
节点做出的决策
       │
       ▼
节点产生的输出
       │
       ▼
对外部世界的副作用
       │
       ▼
最终持久化的记录
```

只录到节点的最终输出不算完整。例如 Tool 必须尽量覆盖：参数流、Schema、Semantic Validation、Hook、Permission、Sandbox、实际执行、Progress、Result 回灌和 Transcript。

## 证据优先级

```text
CAPTURED
  正式二进制直接输出或落盘的原始数据。

DERIVED
  只使用真实 ID、时间和状态进行确定性关联得到。

PARTIAL
  生命周期的一部分有证据，另一部分正式 Debug 未输出或代理未捕获。

MISSING
  该 Case 必须存在但 Observer 没有捕获到。

NOT_TRIGGERED
  Observer 能捕获，但该 Case 没有触发该机制。

NOT_EXPOSED
  正式二进制或模型平台没有输出；不能伪造。
```

## 源码主干

- BOOT：[entrypoints/cli.tsx](../src/entrypoints/cli.tsx)、[main.tsx](../src/main.tsx)、[setup.ts](../src/setup.ts)
- INPUT：[processUserInput.ts](../src/utils/processUserInput/processUserInput.ts)、[QueryEngine.ts](../src/QueryEngine.ts)
- CONTEXT：[context.ts](../src/context.ts)、[prompts.ts](../src/constants/prompts.ts)、[queryContext.ts](../src/utils/queryContext.ts)
- API：[claude.ts](../src/services/api/claude.ts)、[withRetry.ts](../src/services/api/withRetry.ts)
- QUERY：[query.ts](../src/query.ts)
- TOOL：[toolExecution.ts](../src/services/tools/toolExecution.ts)、[toolOrchestration.ts](../src/services/tools/toolOrchestration.ts)
- PERMISSION：[permissions.ts](../src/utils/permissions/permissions.ts)
- TASK/SUBAGENT：[AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx)、[runAgent.ts](../src/tools/AgentTool/runAgent.ts)
- COMPACT/MEMORY：[services/compact/](../src/services/compact/)、[services/SessionMemory/](../src/services/SessionMemory/)
- PERSISTENCE：[sessionStorage.ts](../src/utils/sessionStorage.ts)、[sessionRestore.ts](../src/utils/sessionRestore.ts)
- OBSERVABILITY：[coreSchemas.ts](../src/entrypoints/sdk/coreSchemas.ts)、[debug.ts](../src/utils/debug.ts)

## 机器可读注册表

完整 Observation Points、触发条件、Evidence、Invariant 和源码锚点以 [runtime-model.mjs](runtime-model.mjs) 为准，目前细分为 68 个源码级观察点。每次 Run 自动输出 `13-CAPTURE-COVERAGE.md/json`，缺口不再依赖人工偶然发现。

证据还要区分强度：

```text
A  正式二进制直接输出或持久化：stream-json、API Proxy、Transcript、File History、Task Output。
B  Debug / Analytics / OTel：受启动参数、Feature Gate 和 Sink 配置影响。
C  只能推断或平台内部不可见：服务端内部表示、模型隐式推理、未输出的 Hook/内存状态。
```

Observer 通过安装版 Claude Code 扩展的官方 `/open?prompt=...` URI，把精确 Prompt 预填到独立、可见的原生 VS Code 面板；用户亲自按 Enter 提交，并在同一 UI 中处理权限。Observer 不注入 stdin、不扩写 Prompt、不代替用户操作。Prompt provenance 只有在预填字符串、首个 main-chain transcript user 与首个模型 Request user 输入逐字一致时才成立。

原生扩展继续加载正常 user/project/local settings、model、effort、Hooks、MCP、tools 和认证。透明 process wrapper 只在扩展生成的 SDK 参数末尾追加 endpoint-only `--settings` overlay，将 `ANTHROPIC_BASE_URL` 固定为 `http://127.0.0.1:33333/api/anthropic`；普通窗口仍为 23333。真实 Run 以 wrapper 记录的 bundled Claude PID 为根采样完整进程树与 TCP 表。至少一个 connection 必须指向 loopback `33333`，任何 `23333` connection 都标为 `ROUTING_FIDELITY_FAILED`。监控器不可用、中断或证据不完整则标为 `ROUTING_EVIDENCE_UNAVAILABLE`。

开发 Observer 保存 Claude Code/SDK 实际发往 `33333` 的完整 HTTP entity body 与运行时交换。Runtime Observer 自带的 Recording Proxy 仅供本地假上游测试，通过 `--observer-upstream` 仍绑定同一个 `33333` 入口并保存 `request.raw`、可解析时的 `request.parsed.json` 与 Response Body。HTTP entity body 不是 TCP 抓包：Node 已移除 transfer framing，Header 原始顺序/大小写和 trailers 不保留；也不等于模型服务端内部最终解析表示。认证 Header 只转发不保存。
