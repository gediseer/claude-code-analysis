# Observation Point Registry

该表由 `runtime-model.mjs` 生成。Coverage Auditor 以同一注册表检查每个真实 Run。

| ID | Layer | Name | Dimension | Trigger | Evidence |
|---|---|---|---|---|---|
| BOOT_COMMAND | BOOT | 实际启动命令 | input | always | task-command |
| BOOT_EFFECTIVE_INIT | BOOT | 生效后的初始化快照 | output | always | stream-init |
| BOOT_ENVIRONMENT | BOOT | 子进程环境变量名称与配置来源 | input | always | run-config |
| INPUT_TASK | INPUT | 原始请求与逐字传递 | input | always | task-file, transcript-user, prompt-fidelity-verified |
| INPUT_QUEUE | INPUT | 消息队列入队/出队 | decision | queue-events | transcript-queue |
| CONTEXT_SOURCES | CONTEXT | Context 原材料 | input | always | api-request-observable, transcript-attachments |
| CONTEXT_FINAL_MESSAGES | CONTEXT | 最终 Messages | output | always | api-request-full |
| CONTEXT_TOOL_SCHEMAS | CONTEXT | 实际 Tool Schemas | output | tools-enabled | api-request-observable |
| CONTEXT_SYSTEM_DEFAULT | CONTEXT | 内置默认 System Prompt 正文 | output | always | NOT_EXPOSED |
| CONTEXT_SYSTEM_EXPLICIT | CONTEXT | Observer System Prompt 注入 | output | explicit-system-prompt | api-request-explicit-system |
| API_REQUEST | API | 最终模型 Request | input | always | api-request-full |
| API_RESPONSE_STREAM | API | 原始 SSE/HTTP Response 字节流 | output | always | api-response-raw, stream-events |
| API_RETRY | API | Retry / Backoff | decision | api-retry | stream-api-retry, debug-retry, api-request-observable |
| API_FALLBACK | API | 模型/流式 Fallback | decision | fallback | debug-fallback, stream-api-retry, api-request-observable |
| API_USAGE_RESULT | API | Usage、Cost、Stop Reason | output | always | stream-result |
| QUERY_TURN | QUERY | 跨轮 Query 状态 | decision | always | api-turns, transcript-chain |
| QUERY_TRANSITION | QUERY | Continue/Terminal/Recovery Transition | decision | always | derived-query-transitions |
| TOOL_USE | TOOL | Tool Use 与流式参数 | input | tool-use | stream-tool-delta, transcript-tool-use |
| TOOL_SCHEMA_VALIDATION | TOOL | Schema Validation | decision | tool-use | tool-error-result, debug-tool |
| TOOL_SEMANTIC_VALIDATION | TOOL | Semantic Validation | decision | tool-use | tool-error-result, debug-tool |
| TOOL_DISPATCH | TOOL | Tool 调度、并发与 Progress | decision | tool-use | debug-tool-dispatch, stream-tool-progress |
| TOOL_RESULT | TOOL | Tool Result 回灌 | output | tool-use | transcript-tool-result, stream-tool-result |
| PERMISSION_DECISION | PERMISSION | 最终 Permission Decision | decision | permission-relevant-tool | result-permission-denials, stream-permission, debug-permission |
| PERMISSION_RULE_TRACE | PERMISSION | 规则/模式/Classifier 逐级判定 | decision | permission-relevant-tool | debug-permission |
| SANDBOX_EXECUTION | PERMISSION | Sandbox 是否启用与违规 | side-effect | bash-or-exec | debug-sandbox, tool-result |
| HOOK_LIFECYCLE | HOOK | Hook Started/Progress/Response | decision | hook-configured | stream-hook, transcript-hook |
| TASK_LIFECYCLE | TASK | Task Started/Progress/Updated/Notification | persistence | background-task | stream-task, transcript-task |
| SUBAGENT_SPAWN | SUBAGENT | Subagent Spawn 与父调用 | decision | subagent | transcript-agent-tool, subagent-meta |
| SUBAGENT_SIDECHAIN | SUBAGENT | Subagent Sidechain 与 Handback | persistence | subagent | subagent-transcript, task-notification |
| COMPACT_TRIGGER | CONTEXT_MGMT | Compact 阈值与触发 | decision | compact | debug-compact, stream-compact, transcript-compact |
| COMPACT_BOUNDARY | CONTEXT_MGMT | 压缩前后边界与 Rehydration | output | compact | stream-compact, transcript-compact, api-request-observable |
| MEMORY_LIFECYCLE | CONTEXT_MGMT | Memory Recall/Extraction/Session Memory | persistence | memory | debug-memory, transcript-memory, workspace-memory |
| TRANSCRIPT_PERSISTENCE | PERSISTENCE | 主 Transcript | persistence | always | transcript |
| FILE_HISTORY | PERSISTENCE | File History Snapshot | persistence | file-edit | transcript-file-history, file-history |
| RESUME_FORK | PERSISTENCE | Resume / Fork / Recovery | decision | resume-or-fork | transcript-resume, session-graph |
| WORKSPACE_EFFECTS | SIDE_EFFECT | Workspace Before/After/Diff | side-effect | workspace | workspace-before-after |
| PROCESS_EFFECTS | SIDE_EFFECT | Bash/测试 stdout/stderr/exit | side-effect | bash-or-exec | tool-result, test-output |
| MCP_NETWORK | SIDE_EFFECT | MCP/外部网络请求 | side-effect | mcp-or-network | debug-mcp, tool-result |
| UI_PERMISSION_DIALOG | UI | Permission Dialog 与人工输入 | output | interactive-permission | stream-permission, tui-capture |
| TUI_FRAMES | UI | TUI 屏幕帧 | output | interactive-case | tui-capture |
| STREAM_JSON | OBSERVABILITY | 公开事件流 | output | always | stream-events |
| DEBUG_LOG | OBSERVABILITY | 内部 Debug | output | always | debug-log |
| COST_AND_TIMING | OBSERVABILITY | 成本与延迟 | output | always | stream-result, api-proxy-summary, debug-log |
| PRIVATE_CHAIN_OF_THOUGHT | OBSERVABILITY | 私有 Chain-of-thought | output | always | NOT_EXPOSED |
| BOOT_INIT_SETUP | BOOT | init/setup、cwd、worktree、trust 与 telemetry sinks | decision | always | debug-log, stream-init |
| INPUT_STRUCTURED_IO | INPUT | Structured stdin / control request-response | input | structured-input | stream-control, stream-events |
| INPUT_NORMALIZATION | INPUT | Prompt、图片、附件、Slash 与 UserPromptSubmit Hook | decision | always | transcript-attachments, stream-hook |
| CONTEXT_MESSAGE_NORMALIZATION | CONTEXT | Messages normalize / Tool Pair repair / media cleanup | decision | always | api-request-observable, transcript-chain |
| CONTEXT_TOOL_SCHEMA_BUILD | CONTEXT | Zod→API Tool Schema、Strict 与 eager input streaming | output | tools-enabled | api-request-observable |
| CONTEXT_PROMPT_CACHE | CONTEXT | Prompt Cache breakpoint 与 cache-break diagnosis | decision | api-request | debug-cache, api-request-observable, stream-result |
| API_ERROR_MAPPING | API | API Error→Synthetic Assistant/Retry Category | output | api-error | stream-api-retry, stream-result, debug-retry |
| QUERY_STOP_HOOK | QUERY | Stop Hook、preventContinuation 与后台 post-turn 工作 | decision | stop-hook-or-post-turn | stream-hook, transcript-hook, debug-memory |
| QUERY_TOKEN_BUDGET | QUERY | Max Turns / USD / Task Budget / Max Output Recovery | decision | always | stream-result, api-request-observable, transcript-attachments |
| TOOL_INPUT_NORMALIZATION | TOOL | API input、observable input 与 call input 的规范化 | decision | tool-use | api-request-observable, transcript-tool-use, stream-hook |
| TOOL_STREAMING_EXECUTOR | TOOL | 并发门、Sibling Abort、Synthetic Tool Result 与顺序 | decision | tool-use | debug-tool-dispatch, stream-tool-progress, transcript-tool-result |
| TOOL_LARGE_RESULT_STORAGE | TOOL | 大型 Tool Result 落盘与 Preview | persistence | large-tool-result | tool-result-storage, transcript-tool-result |
| PERMISSION_CONTROL_BRIDGE | PERMISSION | Headless control_request / Permission Prompt Tool | decision | interactive-permission | stream-control, stream-permission |
| HOOK_OUTPUT_PROTOCOL | HOOK | Hook stdout JSON / exit code / async protocol | output | hook-configured | stream-hook, transcript-hook |
| TASK_OUTPUT_DISK | TASK | Task 输出文件、Symlink 与通知指针 | persistence | background-task | task-output, stream-task |
| SUBAGENT_CONTEXT_ISOLATION | SUBAGENT | Subagent Context clone/share 边界 | decision | subagent | subagent-meta, subagent-transcript, debug-subagent |
| SUBAGENT_SYNC_BACKGROUND_RACE | SUBAGENT | 同步 Agent 转后台、Task 完成与 Cleanup 顺序 | decision | subagent | stream-task, subagent-transcript, debug-subagent |
| COMPACT_STRATEGY | CONTEXT_MGMT | Session Memory vs Legacy Summary vs Circuit Breaker | decision | compact | debug-compact, stream-compact, transcript-compact |
| COMPACT_SUMMARY_REQUEST | CONTEXT_MGMT | Compact Fork API、PTL Retry 与 Cache Sharing | decision | compact | api-request-observable, debug-compact, stream-compact |
| MEMORY_EXTRACTION_CURSOR | CONTEXT_MGMT | Memory Extraction Cursor、等待与写权限 | persistence | memory | debug-memory, workspace-memory |
| PERSISTENCE_CHAIN_REBUILD | PERSISTENCE | JSONL parentUuid 裁剪、Leaf、Compact Relink 与 Cycle | decision | always | transcript-chain, session-graph |
| PERSISTENCE_REMOTE_CCR | PERSISTENCE | Remote Ingress / CCR Internal Events / Hydration | persistence | remote-or-ccr | stream-control, transcript-remote |
| OBS_PROMPT_DUMP_NEAR_WIRE | OBSERVABILITY | Fetch override / Recording Proxy 近 wire Request | output | always | api-request-observable, api-response-raw |
| OBS_OTEL_ANALYTICS | OBSERVABILITY | API Metrics、OTel Spans、Cache/Retry Events | output | always | debug-log, stream-result |

## Lifecycle Invariants

- **PROMPT_FIDELITY_VERIFIED**：Prompt launch payload、child transcript first-user 与 API first-user 必须逐字一致；缺失证据不得标为 verified。
- **ROUTING_FIDELITY_VERIFIED**：Observed child process tree 必须有到本地 33333 的 TCP 证据，且不得连接本地 23333；证据不可用时不得标为有效实验。
- **REQUEST_TERMINATES**：每个 Recording Proxy Request 必须有 response summary 或 proxy-error。
- **TOOL_PAIRING**：每个 tool_result 必须匹配 tool_use；每个已开始 tool_use 必须终止或明确中断。
- **SUBAGENT_TERMINATES**：每个 Subagent Spawn 必须有 Sidechain 和终态/Handback。
- **FILE_EFFECT_TRACEABLE**：每个 Workspace 文件差异应能关联到 Edit/Write/Bash Tool。
- **COMPACT_REHYDRATES**：Compact 后必须存在 Boundary/Summary 和后续 Request Context。
- **RUN_TERMINATES**：子进程必须退出，并有 stream result 或明确错误。
