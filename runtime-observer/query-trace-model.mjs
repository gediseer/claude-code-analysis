export const FIRST_TURN_SOURCE_TRACE = Object.freeze({
  original: [
    { label: 'Observer launch input provenance', file: 'runtime-observer/run-observed-session.mjs', line: 275 },
  ],
  compiled: [
    { label: 'Exact stdin prompt handoff (legacy compile labeling for old runs)', file: 'runtime-observer/run-observed-session.mjs', line: 292 },
  ],
  intake: [
    { label: 'CLI UTF-8 stdin prompt intake', file: 'src/main.tsx', line: 857 },
    { label: 'Print/headless runner', file: 'src/cli/print.ts', line: 4053 },
    { label: 'Structured input', file: 'src/cli/structuredIO.ts', line: 135 },
  ],
  input: [
    { label: 'QueryEngine submitMessage', file: 'src/QueryEngine.ts', line: 335 },
    { label: 'processUserInput', file: 'src/utils/processUserInput/processUserInput.ts', line: 281 },
    { label: 'processTextPrompt', file: 'src/utils/processUserInput/processTextPrompt.ts', line: 19 },
    { label: 'Attachments', file: 'src/utils/attachments.ts', line: 743 },
  ],
  context: [
    { label: 'Query context loading', file: 'src/utils/queryContext.ts', line: 30 },
    { label: 'User/system context', file: 'src/context.ts', line: 113 },
    { label: 'Context prepend/append', file: 'src/utils/api.ts', line: 437 },
    { label: 'Message normalization', file: 'src/utils/messages.ts', line: 1989 },
  ],
  request: [
    { label: 'Query model handoff', file: 'src/query.ts', line: 545 },
    { label: 'Tool schema compilation', file: 'src/services/api/claude.ts', line: 1064 },
    { label: 'Final request parameters', file: 'src/services/api/claude.ts', line: 1538 },
    { label: 'HTTP dispatch', file: 'src/services/api/claude.ts', line: 1776 },
  ],
  model: [
    { label: 'Provider boundary', file: 'src/services/api/claude.ts', line: 1776 },
  ],
  response: [
    { label: 'SSE block parser', file: 'src/services/api/claude.ts', line: 1940 },
    { label: 'Tool-use accumulation', file: 'src/query.ts', line: 742 },
  ],
  handoff: [
    { label: 'StreamingToolExecutor', file: 'src/services/tools/StreamingToolExecutor.ts', line: 34 },
    { label: 'Tool orchestration', file: 'src/services/tools/toolOrchestration.ts', line: 19 },
  ],
  dispatch: [
    { label: 'Tool validation/permission', file: 'src/services/tools/toolExecution.ts', line: 337 },
    { label: 'Schema/semantic validation', file: 'src/services/tools/toolExecution.ts', line: 599 },
    { label: 'Permission and hooks', file: 'src/services/tools/toolExecution.ts', line: 754 },
  ],
  executors: [
    { label: 'Glob Tool', file: 'src/tools/GlobTool/GlobTool.ts', line: 57 },
    { label: 'Grep Tool', file: 'src/tools/GrepTool/GrepTool.ts', line: 144 },
    { label: 'Read Tool', file: 'src/tools/FileReadTool/FileReadTool.ts', line: 337 },
  ],
  feedback: [
    { label: 'Tool Result construction', file: 'src/services/tools/toolExecution.ts', line: 1290 },
    { label: 'Follow-up request state', file: 'src/query.ts', line: 1360 },
  ],
})
