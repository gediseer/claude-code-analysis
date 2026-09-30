export const STATUS = Object.freeze({
  CAPTURED: 'CAPTURED',
  DERIVED: 'DERIVED',
  PARTIAL: 'PARTIAL',
  MISSING: 'MISSING',
  NOT_EXPOSED: 'NOT_EXPOSED',
  NOT_TRIGGERED: 'NOT_TRIGGERED',
  NOT_TESTED: 'NOT_TESTED',
})

export const RUNTIME_LAYERS = [
  {
    id: 'BOOT',
    name: '启动与配置',
    summary: 'VS Code extension/SDK 参数、环境变量、Settings、模型、工具池、权限模式与 Feature Gates。',
    source: [
      'src/entrypoints/cli.tsx:33-80',
      'src/main.tsx:585-967',
      'src/cli/print.ts:455-974',
    ],
  },
  {
    id: 'INPUT',
    name: '任务输入',
    summary: 'User Prompt、native VS Code prefill/submit、附件、Slash Command、Hook 或 Remote 输入。',
    source: [
      'src/QueryEngine.ts:335-463',
      'src/utils/processUserInput/processUserInput.ts',
    ],
  },
  {
    id: 'CONTEXT',
    name: 'Context Compiler',
    summary: 'System Prompt、CLAUDE.md、Memory、Runtime Context、Tools 与消息历史。',
    source: [
      'src/context.ts:36-189',
      'src/constants/prompts.ts:444-577',
      'src/utils/systemPrompt.ts:28-123',
      'src/services/api/claude.ts:1017-1728',
    ],
  },
  {
    id: 'API',
    name: '模型请求与传输',
    summary: '最终 Request Body、SSE、Retry、Fallback、Usage、Stop Reason 与 API Error。',
    source: [
      'src/services/api/claude.ts:1017-1728',
      'src/services/api/claude.ts:1776-2888',
      'src/services/api/withRetry.ts:170-517',
    ],
  },
  {
    id: 'QUERY',
    name: 'Query 状态机',
    summary: '跨轮 State、Transition、Tool Executor、Stop Hooks、Recovery 与 Terminal。',
    source: ['src/query.ts:219-1729', 'src/query/stopHooks.ts:65-331'],
  },
  {
    id: 'TOOL',
    name: 'Tool Runtime',
    summary: 'Schema、Semantic Validation、Hook、Permission、Execution、Progress 与 Result。',
    source: [
      'src/Tool.ts:362-695',
      'src/services/tools/toolExecution.ts:337-1745',
      'src/services/tools/toolOrchestration.ts:19-187',
    ],
  },
  {
    id: 'PERMISSION',
    name: 'Permission 与 Sandbox',
    summary: 'Rules、Modes、Classifier、Human Approval 与 OS 执行边界。',
    source: [
      'src/utils/permissions/permissions.ts:473-1318',
      'src/hooks/useCanUseTool.tsx:27-203',
      'src/utils/sandbox/sandbox-adapter.ts',
    ],
  },
  {
    id: 'HOOK',
    name: 'Hooks',
    summary: 'Pre/Post Tool、Failure、Stop、Subagent、Compact 与 Session 生命周期扩展。',
    source: ['src/utils/hooks.ts', 'src/utils/hooks/hookEvents.ts:18-191'],
  },
  {
    id: 'TASK',
    name: 'Task 与后台执行',
    summary: 'Task Registry、Progress、Notification、Output Pointer、Stop 与 Cleanup。',
    source: ['src/Task.ts', 'src/utils/task/framework.ts', 'src/tools/TaskOutputTool/TaskOutputTool.tsx'],
  },
  {
    id: 'SUBAGENT',
    name: 'Subagent 与 Team',
    summary: 'Agent Tool、Fork、Sidechain、Task、Mailbox、Teammate 与 Handback。',
    source: [
      'src/tools/AgentTool/AgentTool.tsx',
      'src/tools/AgentTool/runAgent.ts',
      'src/utils/forkedAgent.ts',
    ],
  },
  {
    id: 'CONTEXT_MGMT',
    name: 'Compact 与 Memory',
    summary: 'Microcompact、Auto Compact、Session Memory、Memory Extraction 与 Rehydration。',
    source: [
      'src/services/compact/autoCompact.ts:32-350',
      'src/services/compact/compact.ts:387-1396',
      'src/services/SessionMemory/sessionMemory.ts:134-495',
      'src/services/extractMemories/extractMemories.ts:329-567',
    ],
  },
  {
    id: 'PERSISTENCE',
    name: '持久化、恢复与 Fork',
    summary: 'Transcript、Sidechain、File History、Plan、Resume、Fork 与 Worktree。',
    source: [
      'src/utils/sessionStorage.ts:198-1722',
      'src/utils/sessionRestore.ts:402-551',
      'src/utils/conversationRecovery.ts:154-333',
    ],
  },
  {
    id: 'SIDE_EFFECT',
    name: '外部副作用',
    summary: '文件、Shell、MCP、网络、测试、Worktree 与外部服务。',
    source: ['src/tools/', 'src/services/mcp/client.ts', 'src/utils/fileHistory.ts'],
  },
  {
    id: 'UI',
    name: 'UI 与人工交互',
    summary: 'TUI、Permission Dialog、Progress、Context View、Task Panel 与状态提示。',
    source: ['src/components/', 'src/screens/REPL.tsx', 'src/state/AppState.tsx'],
  },
  {
    id: 'OBSERVABILITY',
    name: '可观测性',
    summary: 'Stream JSON、Debug、Trace、Cost、Diagnostics、Errors 与 Analytics。',
    source: [
      'src/entrypoints/sdk/coreSchemas.ts:1256-1881',
      'src/utils/debug.ts:18-235',
      'src/utils/diagLogs.ts:5-93',
      'src/utils/telemetry/',
    ],
  },
]

export const OBSERVATION_POINTS = [
  {
    id: 'BOOT_COMMAND', layer: 'BOOT', name: '实际启动命令',
    dimension: 'input', evidence: ['task-command'], required: true,
    source: ['src/entrypoints/cli.tsx:33-80'], invariant: '每个新 Run 恰有一个 spawn 事件和 command.txt。',
  },
  {
    id: 'BOOT_EFFECTIVE_INIT', layer: 'BOOT', name: '生效后的初始化快照',
    dimension: 'output', evidence: ['stream-init'], required: true,
    source: ['src/entrypoints/sdk/coreSchemas.ts:1457-1494'], invariant: '每个新 Run 必须有 system/init。',
  },
  {
    id: 'BOOT_ENVIRONMENT', layer: 'BOOT', name: '子进程环境变量名称与配置来源',
    dimension: 'input', evidence: ['run-config'], required: true,
    source: ['src/main.tsx:585-967'], invariant: '记录 allowlisted 环境变量名、是否存在和上游 Base URL，不记录认证值。',
  },
  {
    id: 'INPUT_TASK', layer: 'INPUT', name: '原始请求与逐字传递',
    dimension: 'input', evidence: ['task-file', 'transcript-user', 'prompt-fidelity-verified'], required: true,
    source: ['src/main.tsx:857-883', 'src/QueryEngine.ts:335-463'], invariant: '新 Run 的原始请求、无附加换行的 UTF-8 stdin payload、首个 main-chain transcript user 和首个 API user 输入必须是完全相同的 Unicode 字符串；证据缺失必须显式标为 unavailable。',
  },
  {
    id: 'INPUT_QUEUE', layer: 'INPUT', name: '消息队列入队/出队',
    dimension: 'decision', evidence: ['transcript-queue'], trigger: 'queue-events',
    source: ['src/types/logs.ts', 'src/utils/sessionStorage.ts'], invariant: 'enqueue/dequeue 可配对或说明中断。',
  },
  {
    id: 'CONTEXT_SOURCES', layer: 'CONTEXT', name: 'Context 原材料',
    dimension: 'input', evidence: ['api-request-observable', 'transcript-attachments'], required: true,
    source: ['src/context.ts:36-189', 'src/constants/prompts.ts:444-577'],
    invariant: '每轮 Request 可见 messages、tools、可公开 runtime context；隐藏 system 段只记录 hash/bytes。',
  },
  {
    id: 'CONTEXT_FINAL_MESSAGES', layer: 'CONTEXT', name: '最终 Messages',
    dimension: 'output', evidence: ['api-request-full'], required: true,
    source: ['src/services/api/claude.ts:1231-1369'], invariant: '每个模型请求均保存完整 entity body、可解析 JSON 与最终 messages；legacy observable-only Run 为 PARTIAL。',
  },
  {
    id: 'CONTEXT_TOOL_SCHEMAS', layer: 'CONTEXT', name: '实际 Tool Schemas',
    dimension: 'output', evidence: ['api-request-observable'], trigger: 'tools-enabled',
    source: ['src/services/api/claude.ts:1231-1369'], invariant: 'init 暴露的工具与 Request 中 schemas 可对照。',
  },
  {
    id: 'CONTEXT_SYSTEM_DEFAULT', layer: 'CONTEXT', name: '内置默认 System Prompt 正文',
    dimension: 'output', evidence: [], exposure: 'NOT_EXPOSED',
    source: ['src/constants/prompts.ts:444-577'], invariant: '仅记录 hash、bytes、block count，不导出隐藏指令正文。',
  },
  {
    id: 'CONTEXT_SYSTEM_EXPLICIT', layer: 'CONTEXT', name: 'Observer System Prompt 注入',
    dimension: 'output', evidence: ['api-request-explicit-system'], trigger: 'explicit-system-prompt',
    source: ['src/utils/systemPrompt.ts:28-123'], invariant: 'Prompt-fidelity Run 禁止 Observer 注入或追加 System Prompt；历史 Case 仍可作为 legacy 证据显示。',
  },
  {
    id: 'API_REQUEST', layer: 'API', name: '最终模型 Request',
    dimension: 'input', evidence: ['api-request-full'], required: true,
    source: ['src/services/api/claude.ts:1017-1728'], invariant: '每个 API Response/stream message_start 前存在完整 Request entity body，bytes/hash 与实际转发内容一致。',
  },
  {
    id: 'API_RESPONSE_STREAM', layer: 'API', name: '原始 SSE/HTTP Response 字节流',
    dimension: 'output', evidence: ['api-response-raw', 'stream-events'], required: true,
    source: ['src/services/api/claude.ts:1776-2299'], invariant: '每个 Request 有 response.raw 或 proxy-error。',
  },
  {
    id: 'API_RETRY', layer: 'API', name: 'Retry / Backoff',
    dimension: 'decision', evidence: ['stream-api-retry', 'debug-retry', 'api-request-observable'], trigger: 'api-retry',
    source: ['src/services/api/withRetry.ts:170-517'], invariant: '发生 retry 时每次尝试有独立 Request ID。',
  },
  {
    id: 'API_FALLBACK', layer: 'API', name: '模型/流式 Fallback',
    dimension: 'decision', evidence: ['debug-fallback', 'stream-api-retry', 'api-request-observable'], trigger: 'fallback',
    source: ['src/query.ts:650-951', 'src/services/api/claude.ts:2404-2688'], invariant: 'Fallback 前后 Request 可区分 model、attempt 与 tombstone。',
  },
  {
    id: 'API_USAGE_RESULT', layer: 'API', name: 'Usage、Cost、Stop Reason',
    dimension: 'output', evidence: ['stream-result'], required: true,
    source: ['src/entrypoints/sdk/coreSchemas.ts:1407-1454'], invariant: '成功或失败 Run 必须有 terminal result 或明确 process error。',
  },
  {
    id: 'QUERY_TURN', layer: 'QUERY', name: '跨轮 Query 状态',
    dimension: 'decision', evidence: ['api-turns', 'transcript-chain'], required: true,
    source: ['src/query.ts:201-320'], invariant: 'Request 顺序、assistant、tool_result 与下一轮可关联。',
  },
  {
    id: 'QUERY_TRANSITION', layer: 'QUERY', name: 'Continue/Terminal/Recovery Transition',
    dimension: 'decision', evidence: ['derived-query-transitions'], required: true,
    source: ['src/query.ts:1062-1729'], invariant: '每轮标记继续原因或 terminal reason。',
  },
  {
    id: 'TOOL_USE', layer: 'TOOL', name: 'Tool Use 与流式参数',
    dimension: 'input', evidence: ['stream-tool-delta', 'transcript-tool-use'], trigger: 'tool-use',
    source: ['src/services/api/claude.ts:1940-2299'], invariant: '最终 input 与 input_json_delta 累积值一致。',
  },
  {
    id: 'TOOL_SCHEMA_VALIDATION', layer: 'TOOL', name: 'Schema Validation',
    dimension: 'decision', evidence: ['tool-error-result', 'debug-tool'], trigger: 'tool-use',
    source: ['src/services/tools/toolExecution.ts:599-733'], invariant: '失败必须产生 is_error tool_result；成功路径可能仅能从继续执行推导。',
  },
  {
    id: 'TOOL_SEMANTIC_VALIDATION', layer: 'TOOL', name: 'Semantic Validation',
    dimension: 'decision', evidence: ['tool-error-result', 'debug-tool'], trigger: 'tool-use',
    source: ['src/services/tools/toolExecution.ts:599-733'], invariant: 'Semantic 拒绝不得产生副作用。',
  },
  {
    id: 'TOOL_DISPATCH', layer: 'TOOL', name: 'Tool 调度、并发与 Progress',
    dimension: 'decision', evidence: ['debug-tool-dispatch', 'stream-tool-progress'], trigger: 'tool-use',
    source: ['src/services/tools/toolOrchestration.ts:19-187', 'src/services/tools/StreamingToolExecutor.ts'],
    invariant: '每个执行的 tool_use 有 dispatch start/end 或明确取消。',
  },
  {
    id: 'TOOL_RESULT', layer: 'TOOL', name: 'Tool Result 回灌',
    dimension: 'output', evidence: ['transcript-tool-result', 'stream-tool-result'], trigger: 'tool-use',
    source: ['src/query.ts:1360-1729'], invariant: '每个已开始 tool_use 有 tool_result、synthetic cancellation 或 terminal interruption。',
  },
  {
    id: 'PERMISSION_DECISION', layer: 'PERMISSION', name: '最终 Permission Decision',
    dimension: 'decision', evidence: ['result-permission-denials', 'stream-permission', 'debug-permission'], trigger: 'permission-relevant-tool',
    source: ['src/utils/permissions/permissions.ts:473-1318'], invariant: '执行副作用前必须有 allow，拒绝必须可定位。',
  },
  {
    id: 'PERMISSION_RULE_TRACE', layer: 'PERMISSION', name: '规则/模式/Classifier 逐级判定',
    dimension: 'decision', evidence: ['debug-permission'], trigger: 'permission-relevant-tool',
    source: ['src/utils/permissions/permissions.ts:1158-1318'], invariant: '正式 Debug 未暴露的中间分支标 PARTIAL，不能伪造。',
  },
  {
    id: 'SANDBOX_EXECUTION', layer: 'PERMISSION', name: 'Sandbox 是否启用与违规',
    dimension: 'side-effect', evidence: ['debug-sandbox', 'tool-result'], trigger: 'bash-or-exec',
    source: ['src/utils/sandbox/sandbox-adapter.ts', 'src/tools/BashTool/shouldUseSandbox.ts'],
    invariant: 'Bash Case 标明 sandboxed/unsandboxed/unknown。',
  },
  {
    id: 'HOOK_LIFECYCLE', layer: 'HOOK', name: 'Hook Started/Progress/Response',
    dimension: 'decision', evidence: ['stream-hook', 'transcript-hook'], trigger: 'hook-configured',
    source: ['src/utils/hooks/hookEvents.ts:18-191'], invariant: 'hook_started 对应 hook_response 或取消。',
  },
  {
    id: 'TASK_LIFECYCLE', layer: 'TASK', name: 'Task Started/Progress/Updated/Notification',
    dimension: 'persistence', evidence: ['stream-task', 'transcript-task'], trigger: 'background-task',
    source: ['src/Task.ts', 'src/utils/task/framework.ts'], invariant: '每个 task_started 到达 terminal 状态或明确中断。',
  },
  {
    id: 'SUBAGENT_SPAWN', layer: 'SUBAGENT', name: 'Subagent Spawn 与父调用',
    dimension: 'decision', evidence: ['transcript-agent-tool', 'subagent-meta'], trigger: 'subagent',
    source: ['src/tools/AgentTool/AgentTool.tsx'], invariant: '每个 Subagent metadata 的 toolUseId 可回链父 Agent Tool。',
  },
  {
    id: 'SUBAGENT_SIDECHAIN', layer: 'SUBAGENT', name: 'Subagent Sidechain 与 Handback',
    dimension: 'persistence', evidence: ['subagent-transcript', 'task-notification'], trigger: 'subagent',
    source: ['src/tools/AgentTool/runAgent.ts', 'src/utils/sessionStorage.ts:247-303'],
    invariant: 'Spawn 对应 sidechain、terminal state 与 handback。',
  },
  {
    id: 'COMPACT_TRIGGER', layer: 'CONTEXT_MGMT', name: 'Compact 阈值与触发',
    dimension: 'decision', evidence: ['debug-compact', 'stream-compact', 'transcript-compact'], trigger: 'compact',
    source: ['src/services/compact/autoCompact.ts:32-350'], invariant: '触发原因、pre_tokens 和 strategy 可见。',
  },
  {
    id: 'COMPACT_BOUNDARY', layer: 'CONTEXT_MGMT', name: '压缩前后边界与 Rehydration',
    dimension: 'output', evidence: ['stream-compact', 'transcript-compact', 'api-request-observable'], trigger: 'compact',
    source: ['src/services/compact/compact.ts:387-1396'], invariant: '压缩后下一 Request 可与 boundary/summary 对照。',
  },
  {
    id: 'MEMORY_LIFECYCLE', layer: 'CONTEXT_MGMT', name: 'Memory Recall/Extraction/Session Memory',
    dimension: 'persistence', evidence: ['debug-memory', 'transcript-memory', 'workspace-memory'], trigger: 'memory',
    source: ['src/services/SessionMemory/sessionMemory.ts:134-495', 'src/services/extractMemories/extractMemories.ts:329-567'],
    invariant: 'Memory Writer、cursor、目标文件和主任务关系可定位。',
  },
  {
    id: 'TRANSCRIPT_PERSISTENCE', layer: 'PERSISTENCE', name: '主 Transcript',
    dimension: 'persistence', evidence: ['transcript'], required: true,
    source: ['src/utils/sessionStorage.ts:993-1459'], invariant: '新 Run 有可解析 transcript，UUID 去重。',
  },
  {
    id: 'FILE_HISTORY', layer: 'PERSISTENCE', name: 'File History Snapshot',
    dimension: 'persistence', evidence: ['transcript-file-history', 'file-history'], trigger: 'file-edit',
    source: ['src/utils/fileHistory.ts'], invariant: '文件修改 Case 有 before/after/diff；内部 file-history 缺失时标 PARTIAL。',
  },
  {
    id: 'RESUME_FORK', layer: 'PERSISTENCE', name: 'Resume / Fork / Recovery',
    dimension: 'decision', evidence: ['transcript-resume', 'session-graph'], trigger: 'resume-or-fork',
    source: ['src/utils/sessionRestore.ts:402-551', 'src/utils/conversationRecovery.ts:154-333'],
    invariant: '恢复 Case 标明原 session、新 session、repair 和 continuation。',
  },
  {
    id: 'WORKSPACE_EFFECTS', layer: 'SIDE_EFFECT', name: 'Workspace Before/After/Diff',
    dimension: 'side-effect', evidence: ['workspace-before-after'], trigger: 'workspace',
    source: ['src/tools/FileEditTool/', 'src/tools/FileWriteTool/', 'src/tools/BashTool/'],
    invariant: '修改型 Case 使用 before/after/diff；只读 in-place Case 记录观察路径且无修改工具。',
  },
  {
    id: 'PROCESS_EFFECTS', layer: 'SIDE_EFFECT', name: 'Bash/测试 stdout/stderr/exit',
    dimension: 'side-effect', evidence: ['tool-result', 'test-output'], trigger: 'bash-or-exec',
    source: ['src/tools/BashTool/BashTool.tsx'], invariant: 'Bash 退出状态与 Tool Result 一致。',
  },
  {
    id: 'MCP_NETWORK', layer: 'SIDE_EFFECT', name: 'MCP/外部网络请求',
    dimension: 'side-effect', evidence: ['debug-mcp', 'tool-result'], trigger: 'mcp-or-network',
    source: ['src/services/mcp/client.ts'], invariant: '外部请求的目标、时序、状态可见；认证值不落盘。',
  },
  {
    id: 'UI_PERMISSION_DIALOG', layer: 'UI', name: 'Permission Dialog 与人工输入',
    dimension: 'output', evidence: ['stream-permission', 'tui-capture'], trigger: 'interactive-permission',
    source: ['src/components/permissions/', 'src/hooks/toolPermission/handlers/interactiveHandler.ts'],
    invariant: 'Native VS Code Case 必须使用可见原生权限卡片并保留 Extension state/log 证据；Legacy headless 标 NOT_TRIGGERED。',
  },
  {
    id: 'TUI_FRAMES', layer: 'UI', name: 'TUI 屏幕帧',
    dimension: 'output', evidence: ['tui-capture'], trigger: 'interactive-case',
    source: ['anthropic.claude-code webview', 'src/components/', 'src/screens/REPL.tsx'], invariant: 'Native VS Code 使用原生 Webview UI；不伪造 CLI TUI frame。',
  },
  {
    id: 'STREAM_JSON', layer: 'OBSERVABILITY', name: '公开事件流',
    dimension: 'output', evidence: ['stream-events'], required: true,
    source: ['src/entrypoints/sdk/coreSchemas.ts:1256-1881', 'src/cli/print.ts:847-929'],
    invariant: '新 Run 有 system/init、partial events 和 terminal result。',
  },
  {
    id: 'DEBUG_LOG', layer: 'OBSERVABILITY', name: '内部 Debug',
    dimension: 'output', evidence: ['debug-log'], required: true,
    source: ['src/utils/debug.ts:18-235'], invariant: '新 Run 有非空 debug.log。',
  },
  {
    id: 'COST_AND_TIMING', layer: 'OBSERVABILITY', name: '成本与延迟',
    dimension: 'output', evidence: ['stream-result', 'api-proxy-summary', 'debug-log'], required: true,
    source: ['src/entrypoints/sdk/coreSchemas.ts:1407-1454'], invariant: 'Run 记录 duration、TTFT、turns、usage 和 cost。',
  },
  {
    id: 'PRIVATE_CHAIN_OF_THOUGHT', layer: 'OBSERVABILITY', name: '私有 Chain-of-thought',
    dimension: 'output', evidence: [], exposure: 'NOT_EXPOSED',
    source: [], invariant: '平台未输出，Observer 不尝试提取。',
  },
  {
    id: 'BOOT_INIT_SETUP', layer: 'BOOT', name: 'init/setup、cwd、worktree、trust 与 telemetry sinks',
    dimension: 'decision', evidence: ['debug-log', 'stream-init'], required: true,
    source: ['src/entrypoints/init.ts:57-214', 'src/setup.ts:56-477', 'src/main.tsx:1880-2089'],
    invariant: '启动 Debug 与 init 事件应能说明 cwd、模式、工具和主要初始化阶段。',
  },
  {
    id: 'INPUT_STRUCTURED_IO', layer: 'INPUT', name: 'Structured stdin / control request-response',
    dimension: 'input', evidence: ['stream-control', 'stream-events'], trigger: 'structured-input',
    source: ['src/cli/structuredIO.ts:135-773'], invariant: 'NDJSON 输入和 control response 必须保持 FIFO 并可关联 request id。',
  },
  {
    id: 'INPUT_NORMALIZATION', layer: 'INPUT', name: 'Prompt、图片、附件、Slash 与 UserPromptSubmit Hook',
    dimension: 'decision', evidence: ['transcript-attachments', 'stream-hook'], required: true,
    source: ['src/utils/processUserInput/processUserInput.ts:85-588'],
    invariant: '可见输入、附件和 Hook additional context 能在 Transcript/API Request 中找到。',
  },
  {
    id: 'CONTEXT_MESSAGE_NORMALIZATION', layer: 'CONTEXT', name: 'Messages normalize / Tool Pair repair / media cleanup',
    dimension: 'decision', evidence: ['api-request-observable', 'transcript-chain'], required: true,
    source: ['src/utils/messages.ts:1989-2370', 'src/utils/messages.ts:5133-5454'],
    invariant: 'Request Messages 满足 user-first、tool_use/result 配对及合法 thinking/media 约束。',
  },
  {
    id: 'CONTEXT_TOOL_SCHEMA_BUILD', layer: 'CONTEXT', name: 'Zod→API Tool Schema、Strict 与 eager input streaming',
    dimension: 'output', evidence: ['api-request-observable'], trigger: 'tools-enabled',
    source: ['src/utils/api.ts:119-220'], invariant: 'Request Tool Schemas 与 init 暴露工具、模型能力和 provider 一致。',
  },
  {
    id: 'CONTEXT_PROMPT_CACHE', layer: 'CONTEXT', name: 'Prompt Cache breakpoint 与 cache-break diagnosis',
    dimension: 'decision', evidence: ['debug-cache', 'api-request-observable', 'stream-result'], trigger: 'api-request',
    source: ['src/services/api/promptCacheBreakDetection.ts:247-705'],
    invariant: 'Request prefix 与 usage cache_read/cache_creation 可对照；cache break 有原因或标 PARTIAL。',
  },
  {
    id: 'API_ERROR_MAPPING', layer: 'API', name: 'API Error→Synthetic Assistant/Retry Category',
    dimension: 'output', evidence: ['stream-api-retry', 'stream-result', 'debug-retry'], trigger: 'api-error',
    source: ['src/services/api/errors.ts:425-684', 'src/services/api/errors.ts:1163-1207'],
    invariant: '错误被映射为 retry、fallback、synthetic error 或 terminal，不能静默丢失。',
  },
  {
    id: 'QUERY_STOP_HOOK', layer: 'QUERY', name: 'Stop Hook、preventContinuation 与后台 post-turn 工作',
    dimension: 'decision', evidence: ['stream-hook', 'transcript-hook', 'debug-memory'], trigger: 'stop-hook-or-post-turn',
    source: ['src/query/stopHooks.ts:65-331'],
    invariant: 'Hook block/stop 或 background memory/suggestion 必须有公开事件、Debug 或 Transcript 证据。',
  },
  {
    id: 'QUERY_TOKEN_BUDGET', layer: 'QUERY', name: 'Max Turns / USD / Task Budget / Max Output Recovery',
    dimension: 'decision', evidence: ['stream-result', 'api-request-observable', 'transcript-attachments'], required: true,
    source: ['src/query.ts:282-291', 'src/QueryEngine.ts:841-873', 'src/QueryEngine.ts:982-1045'],
    invariant: 'Result、Budget Attachment 与 Request output_config/max_tokens 一致。',
  },
  {
    id: 'TOOL_INPUT_NORMALIZATION', layer: 'TOOL', name: 'API input、observable input 与 call input 的规范化',
    dimension: 'decision', evidence: ['api-request-observable', 'transcript-tool-use', 'stream-hook'], trigger: 'tool-use',
    source: ['src/utils/api.ts:566-718', 'src/services/tools/toolExecution.ts:754-861'],
    invariant: '模型原始 input、Hook/Permission 看到的 input 和 Tool call input 的差异可说明或标 PARTIAL。',
  },
  {
    id: 'TOOL_STREAMING_EXECUTOR', layer: 'TOOL', name: '并发门、Sibling Abort、Synthetic Tool Result 与顺序',
    dimension: 'decision', evidence: ['debug-tool-dispatch', 'stream-tool-progress', 'transcript-tool-result'], trigger: 'tool-use',
    source: ['src/services/tools/StreamingToolExecutor.ts:40-529'],
    invariant: '非并发 Tool 独占；Bash sibling error/用户 abort/fallback 产生合法终止结果。',
  },
  {
    id: 'TOOL_LARGE_RESULT_STORAGE', layer: 'TOOL', name: '大型 Tool Result 落盘与 Preview',
    dimension: 'persistence', evidence: ['tool-result-storage', 'transcript-tool-result'], trigger: 'large-tool-result',
    source: ['src/utils/toolResultStorage.ts:137-330'],
    invariant: 'Persisted-output 路径可打开完整文件，Transcript Preview 与 hash/size 可对照。',
  },
  {
    id: 'PERMISSION_CONTROL_BRIDGE', layer: 'PERMISSION', name: 'Headless control_request / Permission Prompt Tool',
    dimension: 'decision', evidence: ['stream-control', 'stream-permission'], trigger: 'interactive-permission',
    source: ['src/cli/print.ts:4149-4334', 'src/cli/structuredIO.ts:533-659'],
    invariant: 'Legacy headless 必须获得 control response；Native VS Code 必须由原生 canUseTool UI 获得明确用户决定。',
  },
  {
    id: 'HOOK_OUTPUT_PROTOCOL', layer: 'HOOK', name: 'Hook stdout JSON / exit code / async protocol',
    dimension: 'output', evidence: ['stream-hook', 'transcript-hook'], trigger: 'hook-configured',
    source: ['src/utils/hooks.ts:382-737', 'src/utils/hooks.ts:740-1338'],
    invariant: 'Hook 输出可验证 schema、exit、stdout/stderr、timeout 和最终 decision。',
  },
  {
    id: 'TASK_OUTPUT_DISK', layer: 'TASK', name: 'Task 输出文件、Symlink 与通知指针',
    dimension: 'persistence', evidence: ['task-output', 'stream-task'], trigger: 'background-task',
    source: ['src/tasks/LocalAgentTask/LocalAgentTask.tsx:162-657', 'src/tasks/diskOutput.ts:97-451'],
    invariant: 'Task notification 指向可读输出文件，terminal/notified 状态一致。',
  },
  {
    id: 'SUBAGENT_CONTEXT_ISOLATION', layer: 'SUBAGENT', name: 'Subagent Context clone/share 边界',
    dimension: 'decision', evidence: ['subagent-meta', 'subagent-transcript', 'debug-subagent'], trigger: 'subagent',
    source: ['src/utils/forkedAgent.ts:131-140', 'src/utils/forkedAgent.ts:345-625'],
    invariant: 'Agent identity、abort、read state、permission prompt 和 transcript 与父 Agent 隔离。',
  },
  {
    id: 'SUBAGENT_SYNC_BACKGROUND_RACE', layer: 'SUBAGENT', name: '同步 Agent 转后台、Task 完成与 Cleanup 顺序',
    dimension: 'decision', evidence: ['stream-task', 'subagent-transcript', 'debug-subagent'], trigger: 'subagent',
    source: ['src/tools/AgentTool/AgentTool.tsx:765-1261'],
    invariant: 'Completed 状态先于耗时 cleanup/handback，后台重启不重复执行已消费结果。',
  },
  {
    id: 'COMPACT_STRATEGY', layer: 'CONTEXT_MGMT', name: 'Session Memory vs Legacy Summary vs Circuit Breaker',
    dimension: 'decision', evidence: ['debug-compact', 'stream-compact', 'transcript-compact'], trigger: 'compact',
    source: ['src/services/compact/autoCompact.ts:241-350', 'src/services/compact/sessionMemoryCompact.ts:514-630'],
    invariant: '实际选择策略、连续失败次数和 fallback 路径可见。',
  },
  {
    id: 'COMPACT_SUMMARY_REQUEST', layer: 'CONTEXT_MGMT', name: 'Compact Fork API、PTL Retry 与 Cache Sharing',
    dimension: 'decision', evidence: ['api-request-observable', 'debug-compact', 'stream-compact'], trigger: 'compact',
    source: ['src/services/compact/compact.ts:387-763', 'src/services/compact/compact.ts:1136-1396'],
    invariant: 'Compact Request 与主 Request 可按 query source/模型/历史关联，PTL retry 不丢边界。',
  },
  {
    id: 'MEMORY_EXTRACTION_CURSOR', layer: 'CONTEXT_MGMT', name: 'Memory Extraction Cursor、等待与写权限',
    dimension: 'persistence', evidence: ['debug-memory', 'workspace-memory'], trigger: 'memory',
    source: ['src/services/SessionMemory/sessionMemory.ts:134-495', 'src/services/extractMemories/extractMemories.ts:154-221', 'src/services/extractMemories/extractMemories.ts:329-567'],
    invariant: 'Cursor 仅成功后推进；in-flight/stale 与 writer 目录/tool allowlist 可说明。',
  },
  {
    id: 'PERSISTENCE_CHAIN_REBUILD', layer: 'PERSISTENCE', name: 'JSONL parentUuid 裁剪、Leaf、Compact Relink 与 Cycle',
    dimension: 'decision', evidence: ['transcript-chain', 'session-graph'], required: true,
    source: ['src/utils/sessionStorage.ts:2949-3813', 'src/utils/sessionStorage.ts:3869-3939'],
    invariant: 'Session Graph 从有效 leaf 反向重建，dead branch/legacy progress/snip 有确定处理。',
  },
  {
    id: 'PERSISTENCE_REMOTE_CCR', layer: 'PERSISTENCE', name: 'Remote Ingress / CCR Internal Events / Hydration',
    dimension: 'persistence', evidence: ['stream-control', 'transcript-remote'], trigger: 'remote-or-ccr',
    source: ['src/utils/sessionStorage.ts:1302-1361', 'src/utils/sessionStorage.ts:1587-1722', 'src/cli/remoteIO.ts:35-254'],
    invariant: '远端事件与本地 Transcript 顺序、session id 和 hydration 来源可说明。',
  },
  {
    id: 'OBS_PROMPT_DUMP_NEAR_WIRE', layer: 'OBSERVABILITY', name: 'Fetch override / Recording Proxy 近 wire Request',
    dimension: 'output', evidence: ['api-request-observable', 'api-response-raw'], required: true,
    source: ['src/services/api/dumpPrompts.ts:13-225', 'runtime-observer/recording-proxy.mjs'],
    invariant: '明确这是 Proxy 所见 HTTP body（SDK/proxy 仍可能改写），不是服务端内部最终表示。',
  },
  {
    id: 'OBS_OTEL_ANALYTICS', layer: 'OBSERVABILITY', name: 'API Metrics、OTel Spans、Cache/Retry Events',
    dimension: 'output', evidence: ['debug-log', 'stream-result'], required: true,
    source: ['src/services/api/logging.ts:235-700', 'src/utils/telemetry/sessionTracing.ts:274-419'],
    invariant: '未配置 exporter 时 span 细节标 PARTIAL；Usage/TTFT/Retry 仍由 Debug/Result 证明。',
  },
]

export const LIFECYCLE_INVARIANTS = [
  {
    id: 'PROMPT_FIDELITY_VERIFIED',
    description: 'Prompt launch payload、child transcript first-user 与 API first-user 必须逐字一致；缺失证据不得标为 verified。',
  },
  {
    id: 'ROUTING_FIDELITY_VERIFIED',
    description: 'Observed child process tree 必须有到本地 33333 的 TCP 证据，且不得连接本地 23333；证据不可用时不得标为有效实验。',
  },
  {
    id: 'REQUEST_TERMINATES',
    description: '每个 Recording Proxy Request 必须有 response summary 或 proxy-error。',
  },
  {
    id: 'TOOL_PAIRING',
    description: '每个 tool_result 必须匹配 tool_use；每个已开始 tool_use 必须终止或明确中断。',
  },
  {
    id: 'SUBAGENT_TERMINATES',
    description: '每个 Subagent Spawn 必须有 Sidechain 和终态/Handback。',
  },
  {
    id: 'FILE_EFFECT_TRACEABLE',
    description: '每个 Workspace 文件差异应能关联到 Edit/Write/Bash Tool。',
  },
  {
    id: 'COMPACT_REHYDRATES',
    description: 'Compact 后必须存在 Boundary/Summary 和后续 Request Context。',
  },
  {
    id: 'RUN_TERMINATES',
    description: '子进程必须退出，并有 stream result 或明确错误。',
  },
]

export function layerById(id) {
  return RUNTIME_LAYERS.find(layer => layer.id === id)
}
