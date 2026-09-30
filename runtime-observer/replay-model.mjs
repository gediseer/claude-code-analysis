import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  contentBlocks,
  exists,
  parseJsonl,
  textFromContent,
  walkFiles,
} from './lib.mjs'
import { isAnthropicMessagesPath } from './api-paths.mjs'
import { parseSse, summarizeSse } from './sse.mjs'
import { loadHttpExchanges } from './http-exchanges.mjs'
import { RUNTIME_LAYERS } from './runtime-model.mjs'
import { FIRST_TURN_SOURCE_TRACE } from './query-trace-model.mjs'
import {
  classifyPromptFidelity,
  firstApiPromptEvidence,
  firstTranscriptPromptEvidence,
  promptFidelityPresentation,
  sha256Text,
} from './prompt-fidelity.mjs'

const SOURCE_LINKS = {
  boot: [
    { label: 'CLI 入口', file: 'src/entrypoints/cli.tsx', line: 33 },
    { label: 'Headless Runner', file: 'src/cli/print.ts', line: 455 },
  ],
  input: [
    { label: '输入处理', file: 'src/utils/processUserInput/processUserInput.ts', line: 85 },
    { label: 'Query Engine', file: 'src/QueryEngine.ts', line: 335 },
  ],
  api: [
    { label: 'Request 参数组装', file: 'src/services/api/claude.ts', line: 1538 },
    { label: 'Streaming Parser', file: 'src/services/api/claude.ts', line: 1940 },
    { label: 'Retry', file: 'src/services/api/withRetry.ts', line: 170 },
  ],
  query: [
    { label: 'Query 状态机', file: 'src/query.ts', line: 219 },
    { label: 'Tool 回灌', file: 'src/query.ts', line: 1360 },
  ],
  tool: [
    { label: 'Tool Contract', file: 'src/Tool.ts', line: 362 },
    { label: 'Tool Execution', file: 'src/services/tools/toolExecution.ts', line: 337 },
    { label: 'Streaming Executor', file: 'src/services/tools/StreamingToolExecutor.ts', line: 40 },
  ],
  permission: [
    { label: 'Permission Pipeline', file: 'src/utils/permissions/permissions.ts', line: 473 },
  ],
  hook: [
    { label: 'Hook Events', file: 'src/utils/hooks/hookEvents.ts', line: 18 },
    { label: 'Hook Runtime', file: 'src/utils/hooks.ts', line: 382 },
  ],
  subagent: [
    { label: 'Agent Tool', file: 'src/tools/AgentTool/AgentTool.tsx', line: 318 },
    { label: 'runAgent', file: 'src/tools/AgentTool/runAgent.ts', line: 248 },
  ],
  persistence: [
    { label: 'Transcript Storage', file: 'src/utils/sessionStorage.ts', line: 993 },
  ],
  terminal: [
    { label: 'SDK Result', file: 'src/QueryEngine.ts', line: 1082 },
  ],
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
}

function shortText(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function parseTime(value) {
  const time = Date.parse(value || '')
  return Number.isFinite(time) ? time : null
}

function textBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function evidence(level, fidelity, rawRefs = [], explanation = '', transform = null) {
  return { level, fidelity, rawRefs, explanation, transform }
}

function safeRaw(value, maxBytes = 40_000) {
  const text = JSON.stringify(value, null, 2)
  if (Buffer.byteLength(text) <= maxBytes) return value
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(text),
    preview: text.slice(0, maxBytes),
  }
}

async function readJson(filePath, fallback = null) {
  if (!(await exists(filePath))) return fallback
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function loadDebugDispatch(runDir) {
  const filePath = path.join(runDir, '01-live-stream', 'debug.log')
  if (!(await exists(filePath))) return new Map()
  const text = await readFile(filePath, 'utf8')
  const byId = new Map()
  for (const line of text.split(/\r?\n/)) {
    const timestamp = parseTime(line.slice(0, 24))
    const start = line.match(/tool_dispatch_start tool=(\S+) toolUseId=(\S+)(?: permissionDecisionMs=(\d+))?/)
    if (start) {
      const item = byId.get(start[2]) || { toolUseId: start[2], name: start[1] }
      item.startAt = timestamp
      item.permissionDecisionMs = Number(start[3] || 0)
      item.startRaw = line
      byId.set(start[2], item)
    }
    const end = line.match(/tool_dispatch_end tool=(\S+) toolUseId=(\S+) outcome=(\S+) durationMs=(\d+)/)
    if (end) {
      const item = byId.get(end[2]) || { toolUseId: end[2], name: end[1] }
      item.endAt = timestamp
      item.outcome = end[3]
      item.durationMs = Number(end[4])
      item.endRaw = line
      byId.set(end[2], item)
    }
  }
  return byId
}

function normalizeTranscript(rows) {
  return rows.map((row, index) => {
    const record = row.value
    const blocks = contentBlocks(record)
    return {
      id: `tr-${row.line}`,
      source: 'transcript',
      sourceLine: row.line,
      seq: index + 1,
      timestamp: record.timestamp || null,
      time: parseTime(record.timestamp),
      type: record.type || 'unknown',
      subtype: record.subtype || record.message?.subtype || null,
      role: record.message?.role || null,
      uuid: record.uuid || null,
      parentUuid: record.parentUuid ?? null,
      sessionId: record.sessionId || null,
      agentId: record.agentId || null,
      stopReason: record.message?.stop_reason || null,
      text: textBlocks(record.message?.content),
      contentBlocks: safeRaw(record.message?.content ?? null, 24_000),
      attachment: record.type === 'attachment'
        ? {
            attachmentType: record.attachment?.type || record.subtype || null,
            hidden: Boolean(record.attachment?.hidden),
            meta: record.attachment ? safeRaw(record.attachment, 12_000) : null,
          }
        : null,
      queue: record.type === 'queue-operation'
        ? {
            operation: record.operation || record.subtype || null,
            content: safeRaw(record.content ?? record.message ?? null, 12_000),
          }
        : null,
      toolUses: blocks.filter(block => block?.type === 'tool_use').map(block => ({
        id: block.id,
        name: block.name,
        input: block.input,
      })),
      toolResults: blocks.filter(block => block?.type === 'tool_result').map(block => ({
        id: block.tool_use_id,
        isError: Boolean(block.is_error),
        content: block.content,
      })),
      rawRef: `02-session/transcript.visible.jsonl#L${row.line}`,
      raw: safeRaw(record),
    }
  })
}

async function loadApiRequests(runDir) {
  const root = path.join(runDir, '05-api')
  if (!(await exists(root))) return { model: [], auxiliary: [] }
  const dirs = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('request-'))
  const values = []
  for (const entry of dirs) {
    const requestDir = path.join(root, entry.name)
    const metadata = await readJson(path.join(requestDir, 'request-metadata.json'), {})
    const observable = await readJson(path.join(requestDir, 'request.observable.json'), { body: {}, omissions: {} })
    const parsedBodyPath = path.join(requestDir, 'request.parsed.json')
    const rawBodyPath = path.join(requestDir, 'request.raw')
    const fullRequestAvailable = await exists(rawBodyPath)
    const parsedBodyAvailable = await exists(parsedBodyPath)
    const fullBody = parsedBodyAvailable ? await readJson(parsedBodyPath, null) : null
    const responseMetadata = await readJson(path.join(requestDir, 'response-metadata.json'), {})
    const summary = await readJson(path.join(requestDir, 'summary.json'), {})
    const responseRaw = (await exists(path.join(requestDir, 'response.raw')))
      ? await readFile(path.join(requestDir, 'response.raw'))
      : Buffer.alloc(0)
    const url = new URL(metadata.incomingPath || '/', 'http://observer.local')
    const isModel = metadata.method === 'POST' && isAnthropicMessagesPath(url.pathname)
    const sseEvents = isModel ? parseSse(responseRaw) : []
    const sse = isModel ? summarizeSse(sseEvents) : null
    values.push({
      id: entry.name,
      sequence: Number(metadata.sequence || entry.name.match(/\d+/)?.[0] || 0),
      kind: isModel ? 'model' : 'auxiliary',
      method: metadata.method || '-',
      path: metadata.incomingPath || '/',
      startedAt: metadata.startedAt || summary.startedAt || null,
      startTime: parseTime(metadata.startedAt || summary.startedAt),
      responseStartedAt: summary.responseStartedAt || responseMetadata.responseStartedAt || null,
      completedAt: summary.completedAt || null,
      endTime: parseTime(summary.completedAt),
      durationMs: summary.durationMs ?? null,
      timeToHeadersMs: summary.timeToHeadersMs ?? null,
      statusCode: responseMetadata.statusCode ?? summary.statusCode ?? null,
      requestBytes: metadata.bodyBytes ?? null,
      responseBytes: summary.responseBytes ?? responseRaw.length,
      requestSha256: metadata.bodySha256 || summary.requestSha256 || null,
      responseSha256: summary.responseSha256 || null,
      body: fullBody || observable.body || {},
      fullBody,
      observableBody: observable.body || {},
      fullRequestAvailable,
      parsedBodyAvailable,
      omissions: observable.omissions || {},
      response: sse,
      responseRawText: isModel ? responseRaw.toString('utf8') : null,
      responseSseEvents: isModel ? sseEvents.map((event, eventIndex) => ({
        index: eventIndex,
        event: event.event,
        id: event.id,
        retry: event.retry,
        data: event.data,
        json: event.json,
      })) : [],
      rawRefs: {
        request: parsedBodyAvailable
          ? `05-api/${entry.name}/request.parsed.json`
          : `05-api/${entry.name}/request.observable.json`,
        requestRaw: fullRequestAvailable ? `05-api/${entry.name}/request.raw` : null,
        requestObservable: `05-api/${entry.name}/request.observable.json`,
        requestMetadata: `05-api/${entry.name}/request-metadata.json`,
        response: `05-api/${entry.name}/response.raw`,
        responseMetadata: `05-api/${entry.name}/response-metadata.json`,
        summary: `05-api/${entry.name}/summary.json`,
      },
    })
  }
  values.sort((a, b) => a.sequence - b.sequence || (a.startTime || 0) - (b.startTime || 0))
  return {
    model: values.filter(item => item.kind === 'model'),
    auxiliary: values.filter(item => item.kind === 'auxiliary'),
  }
}

function matchApiToTranscript(apiRequests, transcript) {
  const assistants = transcript.filter(event => event.type === 'assistant')
  for (const request of apiRequests) {
    const messageId = request.response?.messageId
    if (!messageId) continue
    const candidates = assistants.filter(event => event.raw?.message?.id === messageId)
    if (!candidates.length) continue
    request.assistantUuid = candidates[0].uuid
    request.assistantEventId = candidates[0].id
    request.assistantEventIds = candidates.map(candidate => candidate.id)
    for (const candidate of candidates) candidate.requestId = request.id
  }
}

function looksLikeVisiblePlan(text) {
  const value = String(text || '').trim()
  if (!value) return false
  const numbered = value.match(/(?:^|\n)\s*(?:\d+[.)、]|[-*]\s+)/g)?.length || 0
  return numbered >= 2 || /(?:计划|步骤|先.+再|first.+then)/i.test(value)
}

function requestControls(body) {
  const controls = { ...body }
  delete controls.system
  delete controls.messages
  delete controls.tools
  return controls
}

function requestDelta(previous, current) {
  if (!previous) {
    return {
      baseline: true,
      addedMessages: current.body.messages?.length || 0,
      systemChanged: true,
      toolsChanged: true,
      controlsChanged: Object.keys(requestControls(current.body)),
    }
  }
  const previousMessages = previous.body.messages || []
  const currentMessages = current.body.messages || []
  const previousControls = requestControls(previous.body)
  const currentControls = requestControls(current.body)
  const controlKeys = new Set([...Object.keys(previousControls), ...Object.keys(currentControls)])
  return {
    baseline: false,
    previousRequestId: previous.id,
    addedMessages: Math.max(0, currentMessages.length - previousMessages.length),
    addedMessageIndexes: Array.from(
      { length: Math.max(0, currentMessages.length - previousMessages.length) },
      (_, offset) => previousMessages.length + offset,
    ),
    systemChanged: hashJson(previous.body.system ?? null) !== hashJson(current.body.system ?? null),
    toolsChanged: hashJson(previous.body.tools ?? null) !== hashJson(current.body.tools ?? null),
    controlsChanged: [...controlKeys].filter(key => hashJson(previousControls[key]) !== hashJson(currentControls[key])),
  }
}

function buildModelTurns(apiRequests, transcript) {
  const assistants = transcript.filter(event => event.type === 'assistant')
  return apiRequests.map((request, index) => {
    const messageId = request.response?.messageId || null
    const transcriptEvents = messageId
      ? assistants.filter(event => event.raw?.message?.id === messageId)
      : []
    const responseBlocks = (request.response?.blocks || []).map(block => ({
      index: block.index,
      type: block.type,
      text: block.type === 'text' ? block.assembled || '' : null,
      toolUseId: block.toolUseId || null,
      toolName: block.toolName || null,
      input: block.parsedInput ?? null,
      complete: Boolean(block.complete),
      evidence: block.type === 'thinking' || block.type === 'redacted_thinking'
        ? evidence('REDACTED', 'hash-only', [request.rawRefs.response], 'Provider returned a reasoning block; its text is intentionally excluded from the replay model.')
        : evidence('OBSERVED', 'reconstructed', [request.rawRefs.response], 'Reconstructed from ordered SSE content blocks.', 'sse-block-assembly'),
    }))
    const visibleText = responseBlocks.filter(block => block.type === 'text').map(block => block.text).join('')
    const toolSelections = responseBlocks.filter(block => block.type === 'tool_use').map(block => ({
      id: block.toolUseId,
      name: block.toolName,
      input: block.input,
      blockIndex: block.index,
      evidence: block.evidence,
      rationale: {
        available: false,
        evidence: evidence('NOT_EXPOSED', 'hash-only', [], 'The model did not expose its private tool-ranking rationale.'),
      },
    }))
    return {
      id: `turn-${index + 1}`,
      index: index + 1,
      requestId: request.id,
      messageId,
      startTime: request.startTime,
      endTime: request.endTime || request.startTime,
      model: request.body.model || request.response?.model || null,
      requestMessages: request.body.messages || [],
      requestTools: request.body.tools || [],
      requestControls: requestControls(request.body),
      outboundRequest: {
        fullRequestAvailable: request.fullRequestAvailable,
        parsedBodyAvailable: request.parsedBodyAvailable,
        system: request.body.system ?? null,
        messages: request.body.messages || [],
        tools: request.body.tools || [],
        controls: requestControls(request.body),
        delta: requestDelta(apiRequests[index - 1] || null, request),
        requestBytes: request.requestBytes,
        requestSha256: request.requestSha256,
        rawRefs: request.rawRefs,
        omissions: request.omissions,
        evidence: request.parsedBodyAvailable
          ? evidence('OBSERVED', 'exact', [request.rawRefs.request, request.rawRefs.requestRaw].filter(Boolean), 'Complete outbound request entity body captured before forwarding.')
          : request.fullRequestAvailable
            ? evidence('OBSERVED', 'exact', [request.rawRefs.requestRaw], 'Complete non-JSON request entity body captured before forwarding.')
            : evidence('REDACTED', 'hash-only', [request.rawRefs.requestObservable], 'Legacy run retained only the observable redacted request and SHA-256.'),
      },
      responseBlocks,
      visibleText,
      visibleTextKind: looksLikeVisiblePlan(visibleText) ? 'visible-plan' : visibleText ? 'visible-preamble' : null,
      visibleTextClassification: visibleText
        ? evidence('DERIVED', 'reconstructed', [request.rawRefs.response], 'Classification is derived from visible response structure; the text itself is directly observed.', 'semantic-classification')
        : null,
      toolSelections,
      transcriptEventIds: transcriptEvents.map(event => event.id),
      stopReason: request.response?.stopReason || null,
      usage: request.response?.usage || null,
      evidence: evidence('OBSERVED', 'reconstructed', Object.values(request.rawRefs), 'Request and response blocks correlated by proxy request and provider message ID.', 'correlated-by-id'),
      privateReasoning: {
        available: false,
        evidence: evidence('NOT_EXPOSED', 'hash-only', [], 'Private chain-of-thought is not exposed by the runtime or provider.'),
      },
    }
  })
}

function locateToolFeedback(tools, apiRequests) {
  for (const tool of tools) {
    tool.feedback = []
    for (const request of apiRequests) {
      if (tool.requestId && request.sequence <= (apiRequests.find(item => item.id === tool.requestId)?.sequence ?? -Infinity)) continue
      const messages = Array.isArray(request.body.messages) ? request.body.messages : []
      messages.forEach((message, messageIndex) => {
        const blocks = Array.isArray(message?.content) ? message.content : []
        blocks.forEach((block, blockIndex) => {
          if (tool.feedback.length || block?.type !== 'tool_result' || block.tool_use_id !== tool.id) return
          tool.feedback.push({
            requestId: request.id,
            messageIndex,
            blockIndex,
            isError: Boolean(block.is_error),
            content: safeRaw(block.content, 24_000),
            rawRef: `${request.rawRefs.request}#/body/messages/${messageIndex}/content/${blockIndex}`,
            evidence: evidence('OBSERVED', 'exact', [request.rawRefs.request], 'Exact tool_result block in the next model request.'),
          })
        })
      })
    }
  }
}

function buildFirstTurnTrace({ input, turns, tools, transcript, runConfig }) {
  const firstTurn = turns[0] || null
  if (!firstTurn) return null
  const legacyRewritten = input.promptFidelity.mode === 'legacy-rewritten'
  const fidelityPresentation = promptFidelityPresentation(input.promptFidelity.mode)
  const firstTools = firstTurn.toolSelections
    .map(selection => tools.find(tool => tool.id === selection.id))
    .filter(Boolean)
  const firstRequest = firstTurn.outboundRequest
  const resultCompletionOrder = firstTools
    .flatMap(tool => (tool.resultEvents || []).map(result => ({ tool, result })))
    .sort((a, b) => (a.result.time || 0) - (b.result.time || 0))
  const nextFeedbackRequestId = resultCompletionOrder
    .map(({ tool }) => tool.feedback?.[0]?.requestId)
    .find(Boolean) || null
  const nextTurn = turns.find(turn => turn.requestId === nextFeedbackRequestId) || turns[1] || null
  const queueEvents = transcript.filter(event => event.type === 'queue-operation')
  const accepted = input.accepted?.[0] || null
  const systemBlocks = Array.isArray(firstRequest?.system)
    ? firstRequest.system
    : firstRequest?.system == null ? [] : [firstRequest.system]
  const returnedThinkingBlocks = firstTurn.responseBlocks.filter(block => block.type === 'thinking' || block.type === 'redacted_thinking')
  const returnedTextBlocks = firstTurn.responseBlocks.filter(block => block.type === 'text')
  const stages = [
    {
      id: 'original', title: 'Original Request', lane: 'human', status: input.original.available ? 'OBSERVED' : 'NOT_EXPOSED',
      summary: input.original.available ? input.original.text : input.original.reason,
      input: null, output: input.original, evidence: input.original.evidence, sourceTrace: FIRST_TURN_SOURCE_TRACE.original,
      notObservable: [],
    },
    {
      id: 'compiled',
      title: legacyRewritten ? 'Legacy Observer Compile (invalid for prompt research)' : 'Exact Prompt Launch',
      lane: 'human',
      status: input.promptFidelity.validForPromptBehaviorResearch ? 'OBSERVED' : fidelityPresentation.label.replaceAll(' ', '_'),
      summary: input.promptFidelity.validForPromptBehaviorResearch
        ? 'Observer launch payload, child transcript first-user input, and API first-user input match exactly.'
        : fidelityPresentation.description,
      input: input.original,
      output: legacyRewritten ? input.compiled : input.childPrompt,
      evidence: (legacyRewritten ? input.compiled : input.childPrompt).evidence,
      sourceTrace: FIRST_TURN_SOURCE_TRACE.compiled,
      notObservable: [],
    },
    {
      id: 'intake', title: 'CLI Intake & Queue', lane: 'runtime', status: 'OBSERVED',
      summary: `${queueEvents.length} queue event(s) · child user ${accepted?.uuid || '—'} · unrestricted tools and permissions`,
      input: input.childPrompt,
      output: { command: runConfig.command, args: runConfig.args, promptTransport: runConfig.promptTransport, cwd: runConfig.workDir, sessionId: runConfig.sessionId, queueEvents, accepted },
      evidence: evidence('OBSERVED', 'exact', ['00-task/command.txt', '01-live-stream/process-events.jsonl', ...(accepted ? [accepted.rawRef] : [])], 'CLI controls, exact stdin payload hash, queue, and child transcript are persisted.'),
      sourceTrace: FIRST_TURN_SOURCE_TRACE.intake, notObservable: [],
    },
    {
      id: 'input', title: 'Input Handling', lane: 'runtime', status: 'PARTIAL',
      summary: '普通文本路径；image/slash/hook/agent 分支在本 Case 未触发。输入输出端点可见，内部逐分支 trace 未插桩。',
      input: input.childPrompt, output: { accepted: input.accepted, attachments: input.attachments, triggered: ['text prompt'], notTriggered: ['image', 'slash command', 'UserPromptSubmit hook', 'Agent'] },
      evidence: input.normalization.evidence, sourceTrace: FIRST_TURN_SOURCE_TRACE.input,
      notObservable: ['逐个 normalization 分支的运行时局部变量未输出。'],
    },
    {
      id: 'context', title: 'Context Assembly', lane: 'runtime', status: firstRequest?.parsedBodyAvailable ? 'OBSERVED' : 'PARTIAL',
      summary: `${systemBlocks.length} system blocks · ${firstRequest?.messages?.length || 0} messages · ${firstRequest?.tools?.length || 0} tool schemas`,
      input: input.accepted,
      output: { system: firstRequest?.system, messages: firstRequest?.messages, tools: firstRequest?.tools, controls: firstRequest?.controls },
      evidence: firstRequest?.evidence, sourceTrace: FIRST_TURN_SOURCE_TRACE.context,
      notObservable: [],
    },
    {
      id: 'request', title: 'Complete First API Request', lane: 'runtime', status: firstRequest?.parsedBodyAvailable ? 'OBSERVED' : 'PARTIAL',
      summary: `${firstRequest?.requestBytes || '—'} bytes · ${firstTurn.requestId} · ${firstTurn.model}`,
      input: { system: firstRequest?.system, messages: firstRequest?.messages, tools: firstRequest?.tools },
      output: { endpoint: '/v1/messages', requestId: firstTurn.requestId, sha256: firstRequest?.requestSha256, controls: firstRequest?.controls },
      evidence: firstRequest?.evidence, sourceTrace: FIRST_TURN_SOURCE_TRACE.request,
      notObservable: [],
    },
    {
      id: 'model', title: 'Model Internal Interpretation', lane: 'model', status: 'NOT_EXPOSED',
      summary: `adaptive thinking requested · returned thinking ${returnedThinkingBlocks.length} · returned text ${returnedTextBlocks.length}`,
      input: firstRequest,
      output: { thinkingRequested: firstRequest?.controls?.thinking || null, effort: firstRequest?.controls?.output_config?.effort || null, thinkingBlocksReturned: returnedThinkingBlocks.length, textBlocksReturned: returnedTextBlocks.length },
      evidence: evidence('NOT_EXPOSED', 'hash-only', [], '模型内部的语义表示、候选计划和 Tool 排名没有通过 API 输出。'),
      sourceTrace: FIRST_TURN_SOURCE_TRACE.model,
      notObservable: ['Intent representation', 'Candidate plans', 'Tool ranking rationale', 'Attention/confidence', 'Private chain-of-thought'],
    },
    {
      id: 'response', title: 'First SSE Output', lane: 'model', status: 'OBSERVED',
      summary: `${returnedTextBlocks.length} text · ${returnedThinkingBlocks.length} thinking · ${firstTurn.toolSelections.length} tool_use · stop ${firstTurn.stopReason}`,
      input: { messageId: firstTurn.messageId },
      output: { responseBlocks: firstTurn.responseBlocks, stopReason: firstTurn.stopReason, usage: firstTurn.usage },
      evidence: firstTurn.evidence, sourceTrace: FIRST_TURN_SOURCE_TRACE.response,
      notObservable: firstTurn.toolSelections.length ? ['Tool selection rationale'] : [],
    },
    {
      id: 'handoff', title: 'Query Loop Handoff', lane: 'query', status: 'SOURCE_DERIVED',
      summary: `${firstTurn.toolSelections.length} Tool Use 被收集；needsFollowUp=true；交给 StreamingToolExecutor。`,
      input: firstTurn.toolSelections,
      output: { toolUseIds: firstTurn.toolSelections.map(selection => selection.id), needsFollowUp: firstTurn.toolSelections.length > 0, executor: 'StreamingToolExecutor' },
      evidence: evidence('DERIVED', 'reconstructed', firstTurn.evidence.rawRefs, '根据已捕获 Tool Use 与 query.ts 控制流确定。', 'source-control-flow'),
      sourceTrace: FIRST_TURN_SOURCE_TRACE.handoff, notObservable: [],
    },
    {
      id: 'dispatch', title: 'Validation / Permission / Dispatch', lane: 'query', status: 'PARTIAL',
      summary: firstTools.map(tool => `${tool.name}: ${tool.permission?.status || 'unknown'} · ${tool.durationMs ?? '—'} ms`).join(' | '),
      input: firstTurn.toolSelections,
      output: firstTools.map(tool => ({ id: tool.id, name: tool.name, permission: tool.permission, hooks: tool.hooks, dispatch: tool.dispatch, status: tool.status })),
      evidence: evidence('OBSERVED', 'reconstructed', firstTools.flatMap(tool => tool.rawRefs), 'Dispatch/permission outcome captured by Tool Use ID; successful schema/semantic branches are not individually logged.'),
      sourceTrace: FIRST_TURN_SOURCE_TRACE.dispatch,
      notObservable: ['成功路径每个 validation branch 的局部判定'],
    },
    {
      id: 'executors', title: 'Tool Executors', lane: 'tool', status: 'OBSERVED',
      summary: firstTools.map(tool => `${tool.name} ${tool.durationMs ?? '—'} ms`).join(' · '),
      input: firstTurn.toolSelections,
      output: firstTools.map(tool => ({ id: tool.id, name: tool.name, input: tool.input, startTime: tool.startTime, endTime: tool.endTime, durationMs: tool.durationMs, status: tool.status })),
      evidence: evidence('OBSERVED', 'reconstructed', firstTools.flatMap(tool => tool.rawRefs), 'Concrete Tool calls and dispatch spans matched by tool_use_id.'),
      sourceTrace: FIRST_TURN_SOURCE_TRACE.executors, notObservable: [],
    },
    {
      id: 'feedback', title: 'Tool Results → Next Request', lane: 'feedback', status: 'OBSERVED',
      summary: `${resultCompletionOrder.length} results · completion ${resultCompletionOrder.map(({ tool }) => tool.name).join(' → ')} · next ${nextFeedbackRequestId || '—'}`,
      input: resultCompletionOrder.map(({ tool, result }) => ({ toolUseId: tool.id, name: tool.name, result })),
      output: { completionOrder: resultCompletionOrder.map(({ tool }) => tool.id), feedback: firstTools.map(tool => tool.feedback), nextRequestId: nextFeedbackRequestId, nextRequest: nextTurn?.outboundRequest || null },
      evidence: evidence('OBSERVED', 'exact', [...firstTools.flatMap(tool => tool.rawRefs), ...(nextTurn?.evidence?.rawRefs || [])], 'Tool Results and their exact blocks in the next complete API request are captured.'),
      sourceTrace: FIRST_TURN_SOURCE_TRACE.feedback, notObservable: [],
    },
  ]
  return {
    requestId: firstTurn.requestId,
    messageId: firstTurn.messageId,
    nextRequestId: nextFeedbackRequestId,
    stages: stages.map((stage, index) => ({ ...stage, index: index + 1, nextStageId: stages[index + 1]?.id || null })),
  }
}

function exactRequestDiff(previous, current) {
  if (!previous) {
    return {
      commonPrefixLength: 0,
      removedMessages: [],
      addedMessages: current.body.messages || [],
      replacedTail: false,
      systemChanged: true,
      toolsChanged: true,
      controlsChanged: Object.keys(requestControls(current.body)),
    }
  }
  const before = previous.body.messages || []
  const after = current.body.messages || []
  let commonPrefixLength = 0
  while (
    commonPrefixLength < before.length &&
    commonPrefixLength < after.length &&
    hashJson(before[commonPrefixLength]) === hashJson(after[commonPrefixLength])
  ) commonPrefixLength += 1
  const beforeControls = requestControls(previous.body)
  const afterControls = requestControls(current.body)
  const keys = new Set([...Object.keys(beforeControls), ...Object.keys(afterControls)])
  return {
    commonPrefixLength,
    removedMessages: before.slice(commonPrefixLength),
    addedMessages: after.slice(commonPrefixLength),
    replacedTail: commonPrefixLength < before.length,
    systemChanged: hashJson(previous.body.system ?? null) !== hashJson(current.body.system ?? null),
    toolsChanged: hashJson(previous.body.tools ?? null) !== hashJson(current.body.tools ?? null),
    controlsChanged: [...keys].filter(key => hashJson(beforeControls[key]) !== hashJson(afterControls[key])),
  }
}

function buildApiTurnBundles({ apiRequests, turns, tools, finalReport, status }) {
  return turns.map((turn, turnIndex) => {
    const request = apiRequests[turnIndex]
    const nextRequest = apiRequests[turnIndex + 1] || null
    const turnTools = turn.toolSelections
      .map(selection => tools.find(tool => tool.id === selection.id))
      .filter(Boolean)
    const emittedOrder = turn.toolSelections.map(selection => selection.id)
    const dispatchOrder = [...turnTools]
      .filter(tool => Number.isFinite(tool.startTime))
      .sort((a, b) => a.startTime - b.startTime)
      .map(tool => tool.id)
    const completionOrder = [...turnTools]
      .filter(tool => Number.isFinite(tool.endTime))
      .sort((a, b) => a.endTime - b.endTime)
      .map(tool => tool.id)
    const feedbackEntries = turnTools
      .flatMap(tool => (tool.feedback || []).map(feedback => ({ tool, feedback })))
      .filter(({ feedback }) => !nextRequest || feedback.requestId === nextRequest.id)
      .sort((a, b) => a.feedback.messageIndex - b.feedback.messageIndex || a.feedback.blockIndex - b.feedback.blockIndex)
    const feedbackOrder = feedbackEntries.map(({ tool }) => tool.id)
    const planTools = turnTools.filter(tool => tool.name === 'EnterPlanMode' || tool.name === 'ExitPlanMode')
    const bridgeTools = turnTools.map(tool => ({
      toolUseId: tool.id,
      name: tool.name,
      input: tool.input,
      responseOrder: emittedOrder.indexOf(tool.id),
      execution: {
        status: tool.status,
        startTime: tool.startTime,
        endTime: tool.endTime,
        durationMs: tool.durationMs,
        permission: tool.permission,
        hooks: tool.hooks,
        dispatch: tool.dispatch,
      },
      results: tool.resultEvents,
      feedback: tool.feedback,
      feedbackRequestId: tool.feedback?.[0]?.requestId || null,
      planTransition: tool.name === 'EnterPlanMode' ? 'enter' : tool.name === 'ExitPlanMode' ? 'exit' : null,
    }))
    return {
      index: turnIndex + 1,
      id: `api-turn-${String(turnIndex + 1).padStart(4, '0')}`,
      requestId: turn.requestId,
      sequence: request.sequence,
      providerMessageId: turn.messageId,
      request: {
        fullRequestAvailable: request.fullRequestAvailable,
        parsedBodyAvailable: request.parsedBodyAvailable,
        body: request.body,
        rawText: request.parsedBodyAvailable ? JSON.stringify(request.body) : null,
        bytes: request.requestBytes,
        sha256: request.requestSha256,
        startedAt: request.startedAt,
        rawRefs: request.rawRefs,
        delta: exactRequestDiff(apiRequests[turnIndex - 1] || null, request),
      },
      response: {
        statusCode: request.statusCode,
        rawSse: request.responseRawText,
        sseEvents: request.responseSseEvents,
        blocks: turn.responseBlocks,
        visibleText: turn.visibleText,
        stopReason: turn.stopReason,
        usage: turn.usage,
        bytes: request.responseBytes,
        sha256: request.responseSha256,
        startedAt: request.responseStartedAt,
        completedAt: request.completedAt,
        durationMs: request.durationMs,
        timeToHeadersMs: request.timeToHeadersMs,
        rawRefs: request.rawRefs,
      },
      bridge: {
        type: bridgeTools.length ? 'tool-loop' : turn.stopReason === 'end_turn' ? 'terminal' : 'direct-continuation',
        tools: bridgeTools,
        emittedOrder,
        dispatchOrder,
        completionOrder,
        feedbackOrder,
        continuationMessages: nextRequest ? exactRequestDiff(request, nextRequest).addedMessages : [],
        nextRequestId: nextRequest?.id || null,
        planTransitions: planTools.map(tool => ({ toolUseId: tool.id, transition: tool.name === 'EnterPlanMode' ? 'enter' : 'exit' })),
      },
      finalResult: turnIndex === turns.length - 1
        ? {
            report: finalReport,
            execution: status.execution,
            deliverable: status.deliverable,
          }
        : null,
    }
  })
}

function buildTools(transcript, dispatch, streamRows) {
  const tools = new Map()
  for (const event of transcript) {
    for (const block of event.toolUses) {
      if (tools.has(block.id)) {
        tools.get(block.id).duplicateUse = true
        continue
      }
      tools.set(block.id, {
        id: block.id,
        name: block.name,
        input: block.input,
        assistantUuid: event.uuid,
        assistantEventId: event.id,
        requestId: event.requestId || null,
        messageId: event.raw?.message?.id || null,
        callTime: event.time,
        resultEvents: [],
        rawRefs: [event.rawRef],
      })
    }
    for (const result of event.toolResults) {
      const item = tools.get(result.id) || {
        id: result.id,
        name: '(unmatched)',
        input: null,
        assistantUuid: null,
        assistantEventId: null,
        requestId: null,
        messageId: null,
        callTime: null,
        resultEvents: [],
        rawRefs: [],
      }
      item.resultEvents.push({
        eventId: event.id,
        uuid: event.uuid,
        timestamp: event.timestamp,
        time: event.time,
        isError: result.isError,
        content: safeRaw(result.content, 24_000),
        preview: shortText(typeof result.content === 'string' ? result.content : JSON.stringify(result.content)),
        rawRef: event.rawRef,
      })
      item.rawRefs.push(event.rawRef)
      tools.set(result.id, item)
    }
  }
  const denials = streamRows
    .filter(event => event.value.type === 'result')
    .flatMap(event => event.value.permission_denials || [])
  const hookEvents = streamRows
    .filter(event => event.value.type === 'system' && /hook/.test(event.value.subtype || ''))
    .map(event => ({ ...event.value, sourceLine: event.line }))
  for (const item of tools.values()) {
    const debug = dispatch.get(item.id) || null
    const denial = denials.find(value => value.tool_use_id === item.id) || null
    const hooks = hookEvents.filter(value => JSON.stringify(value).includes(item.id))
    item.startTime = debug?.startAt ?? item.callTime
    item.endTime = debug?.endAt ?? item.resultEvents.at(-1)?.time ?? item.startTime
    item.durationMs = debug?.durationMs ?? (
      item.startTime && item.endTime ? Math.max(0, item.endTime - item.startTime) : null
    )
    item.permission = denial
      ? { status: 'denied', evidence: 'result.permission_denials', value: denial }
      : debug
        ? { status: 'allowed', evidence: 'debug.dispatch', decisionMs: debug.permissionDecisionMs }
        : { status: 'partial', evidence: 'not exposed' }
    item.dispatch = debug
    item.hooks = hooks.map(value => ({
      type: value.subtype,
      hookName: value.hook_name,
      hookEvent: value.hook_event,
      outcome: value.outcome,
      rawRef: `01-live-stream/stdout.stream.jsonl#L${value.sourceLine}`,
    }))
    item.status = denial
      ? 'denied'
      : item.resultEvents.some(value => value.isError)
        ? 'error'
        : item.resultEvents.length
          ? 'success'
          : 'incomplete'
    item.sourceLinks = SOURCE_LINKS.tool
  }
  return [...tools.values()]
}

function buildConcurrencyGroups(tools) {
  const groups = []
  const byAssistant = new Map()
  for (const tool of tools) {
    const emissionKey = tool.messageId || tool.assistantUuid
    if (!emissionKey) continue
    if (!byAssistant.has(emissionKey)) byAssistant.set(emissionKey, [])
    byAssistant.get(emissionKey).push(tool)
  }
  for (const [assistantUuid, members] of byAssistant) {
    if (members.length > 1) {
      groups.push({
        id: `emit-${assistantUuid}`,
        type: 'emission',
        assistantUuid,
        members: members.map(item => item.id),
        startTime: Math.min(...members.map(item => item.startTime || item.callTime || 0)),
        endTime: Math.max(...members.map(item => item.endTime || item.startTime || 0)),
      })
    }
  }
  const spans = tools
    .filter(item => Number.isFinite(item.startTime) && Number.isFinite(item.endTime))
    .sort((a, b) => a.startTime - b.startTime)
  let component = []
  let end = -Infinity
  function flush() {
    if (component.length > 1) {
      groups.push({
        id: `overlap-${groups.length + 1}`,
        type: 'dispatch-overlap',
        members: component.map(item => item.id),
        startTime: Math.min(...component.map(item => item.startTime)),
        endTime: Math.max(...component.map(item => item.endTime)),
      })
    }
    component = []
    end = -Infinity
  }
  for (const item of spans) {
    if (component.length && item.startTime >= end) flush()
    component.push(item)
    end = Math.max(end, item.endTime)
  }
  flush()
  return groups
}

async function loadSubagents(runDir) {
  const root = path.join(runDir, '02-session', 'session-files', 'subagents')
  const files = (await walkFiles(root)).filter(file => file.endsWith('.jsonl'))
  const agents = []
  for (const file of files) {
    const meta = await readJson(file.replace(/\.jsonl$/, '.meta.json'), {})
    const parsed = await parseJsonl(file)
    const records = parsed.records.map(row => row.value)
    const texts = records
      .filter(record => record.type === 'assistant')
      .map(record => textFromContent(record.message?.content))
      .filter(Boolean)
    const timestamps = records.map(record => parseTime(record.timestamp)).filter(Number.isFinite)
    const agentId = path.basename(file, '.jsonl').replace(/^agent-/, '')
    agents.push({
      id: agentId,
      type: meta.agentType || 'unknown',
      description: meta.description || '',
      parentToolUseId: meta.toolUseId || null,
      spawnDepth: meta.spawnDepth ?? null,
      stoppedByUser: Boolean(meta.stoppedByUser),
      status: meta.stoppedByUser ? 'interrupted' : texts.length ? 'completed' : 'incomplete',
      startTime: timestamps.length ? Math.min(...timestamps) : null,
      endTime: timestamps.length ? Math.max(...timestamps) : null,
      records: records.length,
      finalText: texts.at(-1) || '',
      rawRef: path.relative(runDir, file).replaceAll('\\', '/'),
      metadataRef: path.relative(runDir, file.replace(/\.jsonl$/, '.meta.json')).replaceAll('\\', '/'),
      sourceLinks: SOURCE_LINKS.subagent,
    })
  }
  return agents
}

function buildStreamLifecycle(rows) {
  return rows
    .filter(row => row.value.type === 'system' && /hook|task|permission|background|compact|api_retry/.test(row.value.subtype || ''))
    .map(row => {
      const value = row.value
      const isTask = /task|background/.test(value.subtype || '')
      const isHook = /hook/.test(value.subtype || '')
      const isRetry = /api_retry/.test(value.subtype || '')
      return {
        id: `stream-${row.line}`,
        kind: isTask ? 'task' : isHook ? 'hook' : isRetry ? 'retry' : 'system',
        subtype: value.subtype,
        lane: isTask ? 'agent' : isHook ? 'permission' : 'api',
        architectureLayer: isTask ? 'SUBAGENT' : isHook ? 'HOOK' : 'API',
        title: value.hook_name || value.subtype,
        status: value.outcome || 'info',
        time: parseTime(value.timestamp),
        requestId: value.request_id || null,
        toolUseId: value.tool_use_id || value.toolUseId || null,
        taskId: value.task_id || null,
        agentId: value.agent_id || null,
        summary: shortText(value.output || value.message || value.subtype),
        raw: safeRaw(value),
        rawRefs: [`01-live-stream/stdout.stream.jsonl#L${row.line}`],
        sourceLinks: isHook ? SOURCE_LINKS.hook : isTask ? SOURCE_LINKS.subagent : SOURCE_LINKS.api,
      }
    })
}

function architectureModel(coverage) {
  const groups = [
    { id: 'BOOT', name: '启动与配置', layers: ['BOOT'] },
    { id: 'INPUT', name: '任务输入', layers: ['INPUT'] },
    { id: 'CONTEXT', name: 'Context Compiler', layers: ['CONTEXT'] },
    { id: 'API', name: '模型请求与传输', layers: ['API'] },
    { id: 'QUERY', name: 'Query 状态机', layers: ['QUERY'] },
    { id: 'TOOL_RUNTIME', name: 'Tool / Permission / Hook', layers: ['TOOL', 'PERMISSION', 'HOOK'] },
    { id: 'AGENTS', name: 'Task / Subagent / Team', layers: ['TASK', 'SUBAGENT'] },
    { id: 'CONTEXT_MGMT', name: 'Context Management', layers: ['CONTEXT_MGMT'] },
    { id: 'PERSISTENCE', name: 'Persistence / Recovery', layers: ['PERSISTENCE'] },
    { id: 'EFFECTS_OBS', name: 'Side Effect / UI / Observability', layers: ['SIDE_EFFECT', 'UI', 'OBSERVABILITY'] },
  ]
  return groups.map(group => {
    const original = (coverage?.layers || []).filter(layer => group.layers.includes(layer.id))
    const counts = {}
    for (const layer of original) {
      for (const [status, count] of Object.entries(layer.counts || {})) {
        counts[status] = (counts[status] || 0) + count
      }
    }
    return {
      ...group,
      counts,
      points: (coverage?.points || []).filter(point => group.layers.includes(point.layer)),
    }
  })
}

function normalizedEvents({ transcript, api, turns, tools, agents, lifecycle, processEvents, finalReport, input }) {
  const events = []
  if (input.original.available) {
    events.push({
      id: 'evt-original-input',
      kind: 'original-input',
      lane: 'user',
      architectureLayer: 'INPUT',
      title: 'Original user request',
      summary: shortText(input.original.text),
      outcome: 'accepted',
      status: 'info',
      evidence: input.original.evidence,
      startTime: (parseTime(processEvents.find(event => event.type === 'spawn')?.timestamp) ?? Date.now()) - 1,
      endTime: (parseTime(processEvents.find(event => event.type === 'spawn')?.timestamp) ?? Date.now()) - 1,
      rawRefs: input.original.evidence.rawRefs,
      sourceLinks: SOURCE_LINKS.input,
    })
  }
  const fidelityPresentation = promptFidelityPresentation(input.promptFidelity.mode)
  for (const event of transcript) {
    if (event.type === 'user' && event.role === 'user' && !event.toolResults.length) {
      events.push({
        id: `evt-${event.id}`,
        kind: 'user',
        lane: 'user',
        architectureLayer: 'INPUT',
        title: input.promptFidelity.mode === 'legacy-rewritten'
          ? 'Legacy rewritten child prompt (invalid for prompt research)'
          : input.promptFidelity.validForPromptBehaviorResearch
            ? 'Verified verbatim child prompt'
            : `${fidelityPresentation.label} child prompt`,
        summary: shortText(event.text),
        outcome: 'accepted',
        status: 'info',
        evidence: evidence('OBSERVED', 'exact', [event.rawRef], 'Prompt accepted by the observed child Claude Code session.'),
        startTime: event.time,
        endTime: event.time,
        uuid: event.uuid,
        parentUuid: event.parentUuid,
        rawRefs: [event.rawRef],
        sourceLinks: SOURCE_LINKS.input,
      })
    }
  }
  for (const turn of turns) {
    events.push({
      id: `evt-${turn.id}`,
      kind: 'model-turn',
      lane: 'query',
      architectureLayer: 'QUERY',
      title: turn.visibleTextKind === 'visible-plan'
        ? `Model turn ${turn.index} · Visible plan`
        : turn.visibleText
          ? `Model turn ${turn.index} · Visible text`
          : `Model turn ${turn.index} · Tool selection`,
      summary: turn.visibleText
        ? shortText(turn.visibleText)
        : `${turn.toolSelections.length} tool selection(s) · ${turn.stopReason || '-'}`,
      outcome: turn.stopReason || (turn.toolSelections.length ? 'tool_use' : 'info'),
      status: turn.stopReason || (turn.toolSelections.length ? 'tool_use' : 'info'),
      evidence: turn.evidence,
      startTime: turn.startTime,
      endTime: turn.endTime,
      requestId: turn.requestId,
      messageId: turn.messageId,
      rawRefs: turn.evidence.rawRefs,
      sourceLinks: SOURCE_LINKS.query,
    })
  }
  for (const request of api.model) {
    events.push({
      id: `evt-api-${request.id}`,
      kind: 'api',
      lane: 'api',
      architectureLayer: 'API',
      title: `Model request · ${request.body.model || 'unknown'}`,
      summary: `${request.body.messages?.length || 0} messages · ${request.body.tools?.length || 0} tools · ${request.statusCode || '-'} · ${request.response?.stopReason || '-'}`,
      outcome: request.statusCode && request.statusCode < 400 ? 'success' : 'error',
      status: request.statusCode && request.statusCode < 400 ? 'success' : 'error',
      evidence: evidence('OBSERVED', 'reconstructed', Object.values(request.rawRefs), 'Captured request envelope and raw response correlated by proxy request ID.'),
      startTime: request.startTime,
      endTime: request.endTime || request.startTime,
      requestId: request.id,
      messageId: request.response?.messageId || null,
      rawRefs: Object.values(request.rawRefs),
      sourceLinks: SOURCE_LINKS.api,
    })
  }
  for (const request of api.auxiliary) {
    events.push({
      id: `evt-aux-${request.id}`,
      kind: 'auxiliary-api',
      lane: 'api',
      architectureLayer: 'OBSERVABILITY',
      title: `Auxiliary API · ${request.method} ${request.path}`,
      summary: `HTTP ${request.statusCode ?? '-'} · ${request.durationMs ?? '-'} ms`,
      status: request.statusCode && request.statusCode < 400 ? 'info' : 'error',
      startTime: request.startTime,
      endTime: request.endTime || request.startTime,
      requestId: request.id,
      rawRefs: Object.values(request.rawRefs),
      sourceLinks: SOURCE_LINKS.api,
    })
  }
  for (const tool of tools) {
    events.push({
      id: `evt-tool-${tool.id}`,
      kind: 'tool',
      lane: 'tool',
      architectureLayer: 'TOOL',
      title: `${tool.name} · ${tool.status}`,
      summary: `${tool.durationMs ?? '-'} ms · ${tool.resultEvents.length} result(s)`,
      outcome: tool.status,
      status: tool.status,
      evidence: evidence('OBSERVED', 'reconstructed', [...new Set(tool.rawRefs)], 'Tool use, dispatch and result correlated by tool_use_id.', 'correlated-by-id'),
      startTime: tool.startTime,
      endTime: tool.endTime || tool.startTime,
      toolUseId: tool.id,
      uuid: tool.assistantUuid,
      requestId: tool.requestId,
      rawRefs: [...new Set(tool.rawRefs)],
      sourceLinks: tool.sourceLinks,
    })
  }
  for (const agent of agents) {
    events.push({
      id: `evt-agent-${agent.id}`,
      kind: 'subagent',
      lane: 'agent',
      architectureLayer: 'SUBAGENT',
      title: `${agent.type} · ${agent.description || agent.id}`,
      summary: `${agent.records} records · ${agent.status}`,
      status: agent.status,
      startTime: agent.startTime,
      endTime: agent.endTime || agent.startTime,
      toolUseId: agent.parentToolUseId,
      agentId: agent.id,
      rawRefs: [agent.rawRef, agent.metadataRef],
      sourceLinks: agent.sourceLinks,
    })
  }
  events.push(...lifecycle)
  const spawn = processEvents.find(event => event.type === 'spawn')
  const exit = processEvents.find(event => event.type === 'exit')
  if (spawn) {
    events.push({
      id: 'evt-process',
      kind: 'process',
      lane: 'persistence',
      architectureLayer: 'BOOT',
      title: 'Claude Code process',
      summary: `PID ${spawn.pid} → exit ${exit?.code ?? '?'}`,
      outcome: exit?.code === 0 ? 'success' : 'error',
      status: exit?.code === 0 ? 'success' : 'error',
      evidence: evidence('OBSERVED', 'exact', ['01-live-stream/process-events.jsonl'], 'OS process spawn and exit events.'),
      startTime: parseTime(spawn.timestamp),
      endTime: parseTime(exit?.timestamp) || parseTime(spawn.timestamp),
      rawRefs: ['01-live-stream/process-events.jsonl'],
      sourceLinks: SOURCE_LINKS.boot,
    })
  }
  if (finalReport?.reportAvailable || finalReport?.text) {
    events.push({
      id: 'evt-final-report',
      kind: 'report',
      lane: 'query',
      architectureLayer: 'QUERY',
      title: 'Visible report available',
      summary: shortText(finalReport.text),
      outcome: finalReport.executionSucceeded ? 'success' : 'available-after-failure',
      status: finalReport.executionSucceeded ? 'success' : 'warning',
      evidence: evidence('OBSERVED', 'exact', ['04-readable/18-FINAL-REPORT.json'], 'Visible assistant text selected as the final deliverable.'),
      startTime: null,
      endTime: null,
      uuid: finalReport.assistantUuid,
      rawRefs: ['04-readable/18-FINAL-REPORT.json'],
      sourceLinks: SOURCE_LINKS.terminal,
    })
  }
  return events.sort((a, b) => {
    const order = new Map([
      ['evt-original-input', 0],
      ['evt-process', 1],
      ['evt-final-report', 4],
    ])
    const aOrder = order.get(a.id) ?? 2
    const bOrder = order.get(b.id) ?? 2
    if (aOrder !== bOrder) return aOrder - bOrder
    if (a.startTime === null && b.startTime === null) return a.id.localeCompare(b.id)
    if (a.startTime === null) return 1
    if (b.startTime === null) return -1
    return a.startTime - b.startTime || a.id.localeCompare(b.id)
  })
}

export async function buildReplayModel(runDir) {
  runDir = path.resolve(runDir)
  const runConfig = await readJson(path.join(runDir, '00-task', 'run-config.json'), {})
  const processResult = await readJson(path.join(runDir, '00-task', 'process-result.json'), null)
  const routingFidelity = await readJson(path.join(runDir, '00-task', 'routing-fidelity.json'), null)
  const taskPath = path.join(runDir, '00-task', 'task.md')
  const taskRaw = (await exists(taskPath)) ? await readFile(taskPath, 'utf8') : ''
  const processRows = await parseJsonl(path.join(runDir, '01-live-stream', 'process-events.jsonl'))
  const processEvents = processRows.records.map(row => row.value)
  const streamRows = await parseJsonl(path.join(runDir, '01-live-stream', 'stdout.stream.jsonl'))
  const transcriptRows = await parseJsonl(path.join(runDir, '02-session', 'transcript.visible.jsonl'))
  const transcript = normalizeTranscript(transcriptRows.records)
  const [api, httpExchanges] = await Promise.all([
    loadApiRequests(runDir),
    loadHttpExchanges(runDir),
  ])
  matchApiToTranscript(api.model, transcript)
  const turns = buildModelTurns(api.model, transcript)
  const dispatch = await loadDebugDispatch(runDir)
  const tools = buildTools(transcript, dispatch, streamRows.records)
  locateToolFeedback(tools, api.model)
  const concurrencyGroups = buildConcurrencyGroups(tools)
  for (const group of concurrencyGroups) {
    for (const id of group.members) {
      const tool = tools.find(item => item.id === id)
      if (tool) {
        if (!tool.concurrencyGroups) tool.concurrencyGroups = []
        tool.concurrencyGroups.push(group.id)
      }
    }
  }
  const agents = await loadSubagents(runDir)
  const lifecycle = buildStreamLifecycle(streamRows.records)
  const coverage = await readJson(path.join(runDir, '04-readable', '13-CAPTURE-COVERAGE.json'), null)
  const finalReport = await readJson(path.join(runDir, '04-readable', '18-FINAL-REPORT.json'), null)
  const terminal = streamRows.records.map(row => row.value).findLast(value => value.type === 'result') || null
  const spawn = processEvents.find(event => event.type === 'spawn')
  const exit = processEvents.find(event => event.type === 'exit')
  const startTime = parseTime(spawn?.timestamp) ?? Math.min(...transcript.map(event => event.time).filter(Number.isFinite))
  const endTime = parseTime(exit?.timestamp) ?? Math.max(...transcript.map(event => event.time).filter(Number.isFinite))
  const models = [...new Set(api.model.map(request => request.body.model).filter(Boolean))]
  const budget = Number(runConfig.case?.maxBudgetUsd ?? terminal?.max_budget_usd ?? 0)
  const nativeVisible = runConfig.mode === 'vscode-native-visible'
  const executionSucceeded = nativeVisible
    ? Boolean(finalReport?.executionSucceeded)
    : Boolean(processResult?.code === 0 && terminal && !terminal.is_error && terminal.subtype === 'success')
  const inputProvenance = await readJson(path.join(runDir, '00-task', 'input-provenance.json'), runConfig.input || null)
  const task = inputProvenance?.schemaVersion >= 3
    ? taskRaw
    : taskRaw.replace(/\r?\n$/, '')
  const originalAvailable = Boolean(inputProvenance?.original?.available && typeof inputProvenance.original.text === 'string')
  const transcriptPromptEvidence = firstTranscriptPromptEvidence(transcript)
  const apiPromptEvidence = firstApiPromptEvidence(api.model)
  const promptFidelity = classifyPromptFidelity({
    inputProvenance,
    task,
    transcriptEvidence: transcriptPromptEvidence,
    apiEvidence: apiPromptEvidence,
  })
  const childPromptText = typeof inputProvenance?.launchPrompt?.text === 'string'
    ? inputProvenance.launchPrompt.text
    : typeof inputProvenance?.childPrompt?.text === 'string'
      ? inputProvenance.childPrompt.text
      : typeof inputProvenance?.compiled?.text === 'string'
        ? inputProvenance.compiled.text
        : task
  const acceptedUsers = transcript.filter(event => event.type === 'user' && event.role === 'user' && !event.toolResults.length)
  const accepted = acceptedUsers.map(event => ({
    text: event.text,
    uuid: event.uuid,
    timestamp: event.timestamp,
    rawRef: event.rawRef,
    evidence: evidence('OBSERVED', 'exact', [event.rawRef], 'User-role input persisted by the observed child session.'),
  }))
  const firstRequest = api.model[0] || null
  const modelVisibleMessages = Array.isArray(firstRequest?.body?.messages) ? firstRequest.body.messages : []
  const input = {
    original: originalAvailable
      ? {
          available: true,
          text: inputProvenance.original.text,
          sha256: inputProvenance.original.sha256 || sha256Text(inputProvenance.original.text),
          source: inputProvenance.original.source || 'input-provenance',
          parentSessionId: inputProvenance.original.parentSessionId || null,
          parentMessageId: inputProvenance.original.parentMessageId || null,
          evidence: evidence('OBSERVED', 'exact', ['00-task/original-query.md', '00-task/input-provenance.json'], 'Verbatim outer request supplied to the Observer.'),
        }
      : {
          available: false,
          text: null,
          reason: inputProvenance?.original?.reason || 'Original request provenance was not recorded for this run.',
          evidence: evidence('NOT_EXPOSED', 'hash-only', [], 'Historical run lacks original-query provenance; the child prompt is not relabeled as user-authored input.'),
        },
    childPrompt: {
      text: childPromptText,
      sha256: inputProvenance?.launchPrompt?.sha256 || inputProvenance?.childPrompt?.sha256 || inputProvenance?.compiled?.sha256 || sha256Text(childPromptText),
      source: inputProvenance?.launchPrompt?.source || inputProvenance?.childPrompt?.source || (inputProvenance?.compiled ? 'legacy-compiled-task' : 'task-file'),
      transport: inputProvenance?.launchPrompt?.transport || (inputProvenance?.schemaVersion >= 3 ? 'stdin' : 'positional-argv'),
      evidence: evidence('OBSERVED', 'exact', [
        (await exists(path.join(runDir, '00-task', 'compiled-task.md'))) ? '00-task/compiled-task.md' : '00-task/task.md',
        '00-task/input-provenance.json',
        '01-live-stream/process-events.jsonl',
      ], 'Exact launch prompt payload recorded by the Observer; child acceptance is classified separately from transcript and API evidence.'),
    },
    compiled: {
      legacy: true,
      used: promptFidelity.mode === 'legacy-rewritten',
      text: inputProvenance?.compiled?.text ?? null,
      sha256: inputProvenance?.compiled?.sha256 ?? null,
      compiler: inputProvenance?.compiled?.compiler ?? null,
      evidence: evidence(
        inputProvenance?.compiled?.text ? 'OBSERVED' : 'NOT_EXPOSED',
        inputProvenance?.compiled?.text ? 'exact' : 'hash-only',
        inputProvenance?.compiled?.text
          ? [(await exists(path.join(runDir, '00-task', 'compiled-task.md'))) ? '00-task/compiled-task.md' : '00-task/input-provenance.json']
          : ['00-task/input-provenance.json'],
        inputProvenance?.compiled?.text
          ? 'Legacy compiled task. This run may be invalid for prompt-behavior research.'
          : 'Legacy compatibility field; no prompt compilation was used.',
      ),
    },
    promptFidelity,
    provenanceEvidence: {
      transcriptFirstUser: transcriptPromptEvidence,
      apiFirstUser: apiPromptEvidence,
    },
    accepted,
    attachments: transcript.filter(event => event.attachment).map(event => ({
      ...event.attachment,
      rawRef: event.rawRef,
      evidence: evidence('OBSERVED', 'exact', [event.rawRef], 'Typed attachment persisted in the child transcript.'),
    })),
    modelVisible: firstRequest
      ? {
          requestId: firstRequest.id,
          messages: modelVisibleMessages,
          tools: firstRequest.body.tools || [],
          omissions: firstRequest.omissions,
          rawRef: firstRequest.rawRefs.request,
          evidence: evidence('OBSERVED', 'reconstructed', [firstRequest.rawRefs.request], 'Observable near-wire request. Redacted blocks retain hash/size metadata.', 'message-normalization-output'),
        }
      : null,
    normalization: {
      status: 'PARTIAL',
      evidence: evidence('DERIVED', 'reconstructed', [
        ...accepted.map(item => item.rawRef),
        ...(firstRequest ? [firstRequest.rawRefs.request] : []),
      ], 'Input and output endpoints are observed; internal branch-by-branch normalization was not instrumented.', 'endpoint-comparison'),
    },
    relation: inputProvenance?.relation || null,
  }
  const status = {
    execution: {
      succeeded: executionSucceeded,
      processExitCode: nativeVisible ? null : processResult?.code ?? exit?.code ?? null,
      timedOut: Boolean(processResult?.timedOut || exit?.timedOut),
      terminalSubtype: terminal?.subtype || null,
      terminalReason: terminal?.terminal_reason || terminal?.stop_reason || null,
      errors: terminal?.errors || [],
      label: executionSucceeded
        ? nativeVisible ? 'Captured native VS Code turn completed' : 'Completed'
        : terminal?.terminal_reason === 'budget_exhausted'
          ? 'Budget exhausted'
          : 'Failed / incomplete',
    },
    deliverable: {
      available: Boolean(finalReport?.reportAvailable || finalReport?.text),
      source: finalReport?.source || 'none',
      assistantUuid: finalReport?.assistantUuid || null,
      label: finalReport?.reportAvailable || finalReport?.text ? 'Report available' : 'No final report',
    },
  }
  const events = normalizedEvents({
    transcript,
    api,
    turns,
    tools,
    agents,
    lifecycle,
    processEvents,
    finalReport,
    input,
  })
  const byId = Object.fromEntries(events.map(event => [event.id, event]))
  const relations = []
  for (const event of transcript) {
    if (event.uuid && event.parentUuid) {
      relations.push({
        type: 'parent',
        from: event.parentUuid,
        to: event.uuid,
        confidence: 'exact',
        key: 'parentUuid',
      })
    }
  }
  for (const tool of tools) {
    if (tool.assistantUuid) {
      relations.push({ type: 'tool-emitted-by', from: tool.assistantUuid, to: tool.id, confidence: 'exact', key: 'assistantUuid/toolUseId' })
    }
    if (tool.requestId) {
      relations.push({ type: 'tool-selected-in-turn', from: tool.requestId, to: tool.id, confidence: 'exact', key: 'requestId/toolUseId' })
    }
    for (const result of tool.resultEvents) {
      relations.push({ type: 'tool-result', from: tool.id, to: result.uuid, confidence: 'exact', key: 'toolUseId' })
    }
    for (const feedback of tool.feedback || []) {
      relations.push({
        type: 'tool-result-fed-to-request',
        from: tool.id,
        to: feedback.requestId,
        confidence: 'exact',
        key: `toolUseId/messages/${feedback.messageIndex}/content/${feedback.blockIndex}`,
      })
    }
  }
  for (const agent of agents) {
    if (agent.parentToolUseId) {
      relations.push({ type: 'subagent-spawn', from: agent.parentToolUseId, to: agent.id, confidence: 'exact', key: 'metadata.toolUseId' })
    }
  }
  const firstTurnTrace = buildFirstTurnTrace({ input, turns, tools, transcript, runConfig })
  const apiTurns = buildApiTurnBundles({ apiRequests: api.model, turns, tools, finalReport, status })
  const apiTurnByRequestId = new Map(apiTurns.map(turn => [turn.requestId, turn]))
  for (const exchange of httpExchanges) {
    const apiTurn = apiTurnByRequestId.get(exchange.requestId)
    exchange.modelTurn = exchange.kind === 'messages' && apiTurn
      ? {
          providerMessageId: apiTurn.providerMessageId,
          response: {
            sseEvents: apiTurn.response.sseEvents,
            blocks: apiTurn.response.blocks,
            stopReason: apiTurn.response.stopReason,
            usage: apiTurn.response.usage,
          },
          bridge: apiTurn.bridge,
        }
      : null
  }
  const cost = {
    budgetUsd: budget || null,
    reportedUsd: terminal?.total_cost_usd ?? null,
    exceeded: Boolean(budget && terminal?.total_cost_usd > budget),
    byModel: terminal?.modelUsage || {},
    inputTokens: terminal?.usage?.input_tokens ?? null,
    outputTokens: terminal?.usage?.output_tokens ?? null,
    cacheReadTokens: terminal?.usage?.cache_read_input_tokens ?? null,
  }
  const model = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    run: {
      id: runConfig.runId || path.basename(runDir),
      sessionId: runConfig.sessionId || terminal?.session_id || finalReport?.sessionId || null,
      title: runConfig.case?.title || runConfig.case?.id || path.basename(runDir),
      task,
      workspace: runConfig.workspace || runConfig.fixtureDir || runConfig.case?.workspace || null,
      workspaceMode: runConfig.workspaceMode || (nativeVisible ? 'in-place' : null),
      captureProfile: runConfig.mode || runConfig.observer?.captureProfile || 'legacy-headless-nonparity',
      command: runConfig.command || null,
      models,
      startTime,
      endTime,
      durationMs: startTime && endTime ? endTime - startTime : terminal?.duration_ms ?? null,
      status,
      routingFidelity,
    },
    input,
    turns,
    apiTurns,
    httpExchanges,
    firstTurnTrace,
    kpis: {
      modelRequests: api.model.length,
      auxiliaryRequests: api.auxiliary.length,
      toolCalls: tools.length,
      toolErrors: tools.filter(tool => tool.status === 'error' || tool.status === 'denied').length,
      subagents: agents.length,
      transcriptRecords: transcript.length,
      liveEvents: streamRows.records.length,
      coverageCaptured: coverage?.summary?.captured ?? 0,
      coverageMissing: coverage?.summary?.missing ?? 0,
    },
    architecture: architectureModel(coverage),
    coverage,
    cost,
    apiRequests: api.model,
    auxiliaryRequests: api.auxiliary,
    transcript,
    tools,
    concurrencyGroups,
    agents,
    lifecycle,
    events,
    relations,
    finalReport: finalReport
      ? {
          reportAvailable: Boolean(finalReport.reportAvailable || finalReport.text),
          executionSucceeded: Boolean(finalReport.executionSucceeded),
          source: finalReport.source,
          assistantUuid: finalReport.assistantUuid,
          text: finalReport.text,
          terminal: finalReport.terminal,
        }
      : null,
    sourceLinks: SOURCE_LINKS,
    integrity: {
      modelHash: null,
      sourceManifest: 'manifest.json',
      omissions: await readJson(path.join(runDir, '02-session', 'observer-omissions.json'), {}),
    },
  }
  model.integrity.modelHash = hashJson({ ...model, integrity: { ...model.integrity, modelHash: null } })
  return model
}
