#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, parseJsonl, walkFiles, writeJson, writeText } from './lib.mjs'
import { isAnthropicMessagesPath } from './api-paths.mjs'
import { assessPromptFidelityRun } from './prompt-fidelity.mjs'
import {
  LIFECYCLE_INVARIANTS,
  OBSERVATION_POINTS,
  RUNTIME_LAYERS,
  STATUS,
} from './runtime-model.mjs'

function parseArgs(argv) {
  const at = argv.indexOf('--run-dir')
  return { runDir: at >= 0 ? path.resolve(argv[at + 1]) : undefined }
}

async function readJson(filePath, fallback = null) {
  if (!(await exists(filePath))) return fallback
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function debugText(runDir) {
  const filePath = path.join(runDir, '01-live-stream', 'debug.log')
  return (await exists(filePath)) ? readFile(filePath, 'utf8') : ''
}

function evidenceWorkspaceIsInPlace(taskConfig) {
  return taskConfig?.workspaceMode === 'in-place' || taskConfig?.workspaceMode === 'in-place-readonly'
}

async function loadEvidence(runDir) {
  const transcriptPath = path.join(runDir, '02-session', 'transcript.visible.jsonl')
  const streamPath = path.join(runDir, '01-live-stream', 'stdout.stream.jsonl')
  const apiPath = path.join(runDir, '05-api')
  const transcript = (await parseJsonl(transcriptPath)).records.map(row => row.value)
  const stream = (await parseJsonl(streamPath)).records.map(row => row.value)
  const debug = await debugText(runDir)
  const apiRequests = []
  if (await exists(path.join(apiPath, 'requests.jsonl'))) {
    apiRequests.push(...(await parseJsonl(path.join(apiPath, 'requests.jsonl'))).records.map(row => row.value))
  }
  const allApiRequestDirs = (await exists(apiPath))
    ? (await readdir(apiPath, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && entry.name.startsWith('request-'))
        .map(entry => path.join(apiPath, entry.name))
    : []
  const apiRequestDirs = []
  for (const requestDir of allApiRequestDirs) {
    const metadata = await readJson(path.join(requestDir, 'request-metadata.json'), {})
    const pathname = new URL(metadata.incomingPath || '/', 'http://observer.local').pathname
    if (metadata.method === 'POST' && isAnthropicMessagesPath(pathname)) {
      apiRequestDirs.push(requestDir)
    }
  }
  const taskConfig = await readJson(path.join(runDir, '00-task', 'run-config.json'), {})
  const processResult = await readJson(path.join(runDir, '00-task', 'process-result.json'), null)
  const routingFidelity = await readJson(path.join(runDir, '00-task', 'routing-fidelity.json'), null)
  const promptFidelity = await assessPromptFidelityRun(runDir)
  const missingArtifacts = await readJson(path.join(runDir, '02-session', 'missing-artifacts.json'), [])
  const subagentFiles = (await walkFiles(path.join(runDir, '02-session', 'session-files', 'subagents')))
  const diffPath = path.join(runDir, '03-workspace', 'changes.diff')
  const diff = (await exists(diffPath)) ? await readFile(diffPath, 'utf8') : ''

  const transcriptBlocks = transcript.flatMap(record =>
    Array.isArray(record.message?.content) ? record.message.content : [],
  )
  const streamTypes = new Set(stream.map(record => `${record.type}/${record.subtype || record.event?.type || ''}`))
  const toolUses = transcriptBlocks.filter(block => block?.type === 'tool_use')
  const toolResults = transcriptBlocks.filter(block => block?.type === 'tool_result')
  const tools = new Set(toolUses.map(block => block.name))
  const attachments = transcript.filter(record => record.type === 'attachment').map(record => record.attachment)
  const hookStream = stream.filter(record => record.type === 'system' && /hook/i.test(record.subtype || ''))
  const taskStream = stream.filter(record => record.type === 'system' && /task|background/i.test(record.subtype || ''))
  const permissionDenials = stream.filter(record => record.type === 'result').flatMap(record => record.permission_denials || [])
  const apiObservableBodies = []
  let fullApiRequestCount = 0
  for (const requestDir of apiRequestDirs) {
    const parsed = await readJson(path.join(requestDir, 'request.parsed.json'))
    const observable = await readJson(path.join(requestDir, 'request.observable.json'))
    const rawExists = await exists(path.join(requestDir, 'request.raw'))
    if (parsed && rawExists) {
      apiObservableBodies.push({ body: parsed, omissions: {} })
      fullApiRequestCount += 1
    } else if (observable) {
      apiObservableBodies.push(observable)
    }
  }
  const hasExplicitSystem = apiObservableBodies.some(value =>
    value?.body?.system && !value.body.system.hiddenDefaultSystemPrompt,
  )
  const hasDefaultSystemHash = apiObservableBodies.some(value => value?.body?.system?.hiddenDefaultSystemPrompt)
  const apiRequestStates = await Promise.all(
    apiRequestDirs.map(async requestDir => ({
      requestDir,
      hasResponse: await exists(path.join(requestDir, 'response.raw')),
      hasSummary: await exists(path.join(requestDir, 'summary.json')),
      hasError: await exists(path.join(requestDir, 'proxy-error.json')),
    })),
  )
  const hasApiResponse = apiRequestStates.some(state => state.hasResponse)
  const terminatedApiRequests = apiRequestStates.filter(
    state => (state.hasResponse && state.hasSummary) || state.hasError,
  ).length
  const hasTaskCommand = await exists(path.join(runDir, '00-task', 'command.txt'))
  const hasTaskFile = await exists(path.join(runDir, '00-task', 'task.md'))
  const hasWorkspaceBefore =
    await exists(path.join(runDir, '03-workspace', 'before')) ||
    evidenceWorkspaceIsInPlace(taskConfig)
  const hasTestOutput = await exists(path.join(runDir, '03-workspace', 'test-output.txt'))
  const hasTuiCapture = await exists(path.join(runDir, '06-tui'))
  const captureProfile = taskConfig.mode || taskConfig.observer?.captureProfile || 'legacy-headless-nonparity'

  return {
    runDir,
    transcript,
    stream,
    debug,
    apiRequests,
    apiRequestDirs,
    apiRequestStates,
    terminatedApiRequests,
    apiObservableBodies,
    fullApiRequestCount,
    taskConfig,
    processResult,
    routingFidelity,
    promptFidelity,
    missingArtifacts,
    subagentFiles,
    diff,
    streamTypes,
    toolUses,
    toolResults,
    tools,
    attachments,
    hookStream,
    taskStream,
    permissionDenials,
    hasExplicitSystem,
    hasDefaultSystemHash,
    hasApiResponse,
    hasTaskCommand,
    hasTaskFile,
    hasWorkspaceBefore,
    hasTestOutput,
    hasTuiCapture,
    captureProfile,
  }
}

function triggerState(point, evidence) {
  const trigger = point.trigger
  if (!trigger) return true
  const map = {
    'queue-events': evidence.transcript.some(record => record.type === 'queue-operation'),
    'tools-enabled': evidence.toolUses.length > 0 || (evidence.stream.find(r => r.type === 'system' && r.subtype === 'init')?.tools?.length ?? 0) > 0,
    'explicit-system-prompt': Boolean(evidence.taskConfig?.case?.systemPromptIsExperimentOwned),
    'api-retry': evidence.streamTypes.has('system/api_retry') || /retry/i.test(evidence.debug),
    fallback: /fallback/i.test(evidence.debug) || evidence.streamTypes.has('system/api_retry'),
    'tool-use': evidence.toolUses.length > 0,
    'permission-relevant-tool': evidence.toolUses.some(tool => !['Read', 'Glob', 'Grep'].includes(tool.name)),
    'bash-or-exec': evidence.tools.has('Bash') || evidence.tools.has('PowerShell'),
    'hook-configured': evidence.hookStream.length > 0 || evidence.attachments.some(a => /hook/i.test(a?.type || '')),
    'background-task': evidence.taskStream.length > 0,
    subagent: evidence.subagentFiles.some(file => file.endsWith('.jsonl')),
    compact: evidence.streamTypes.has('system/compact_boundary') || /compact.*succeed/i.test(evidence.debug),
    memory: /memory/i.test(evidence.debug) || evidence.attachments.some(a => /memory/i.test(a?.type || '')),
    'file-edit': evidence.diff.trim().length > 0,
    workspace: Boolean(evidence.taskConfig?.case?.workspace),
    'resume-or-fork': Boolean(evidence.taskConfig?.case?.resume || evidence.taskConfig?.case?.forkSession),
    'mcp-or-network': [...evidence.tools].some(name => /^mcp__|WebFetch|WebSearch/.test(name)),
    'interactive-permission': evidence.captureProfile === 'vscode-native-visible' || Boolean(evidence.taskConfig?.case?.interactive),
    'interactive-case': evidence.captureProfile === 'vscode-native-visible' || Boolean(evidence.taskConfig?.case?.interactive),
    'structured-input': Boolean(evidence.taskConfig?.case?.inputFormat === 'stream-json'),
    'api-request': evidence.apiRequestDirs.length > 0,
    'api-error': evidence.stream.some(record => record.type === 'result' && record.is_error),
    'stop-hook-or-post-turn': evidence.hookStream.some(record => /Stop/.test(record.hook_event || record.hook_name || '')) || /extractMemories|prompt suggestion|stop hook/i.test(evidence.debug),
    'large-tool-result': evidence.transcript.some(record => JSON.stringify(record).includes('<persisted-output>')),
    'remote-or-ccr': /remote|CCR|bridge/i.test(evidence.debug),
  }
  return map[trigger] ?? false
}

function evaluatePoint(point, evidence) {
  if (
    evidence.captureProfile === 'vscode-native-visible' &&
    (point.evidence || []).length > 0 &&
    (point.evidence || []).every(name => name.startsWith('stream-'))
  ) {
    return {
      status: STATUS.NOT_EXPOSED,
      evidence: [],
      reason: 'The native VS Code capture profile does not enable headless stream-json output.',
    }
  }
  if (point.exposure === STATUS.NOT_EXPOSED) {
    return { status: STATUS.NOT_EXPOSED, evidence: [], reason: point.invariant }
  }
  if (!triggerState(point, evidence)) {
    return { status: STATUS.NOT_TRIGGERED, evidence: [], reason: `Trigger not observed: ${point.trigger}` }
  }

  const detectors = {
    'task-command': () => evidence.hasTaskCommand || evidence.taskConfig?.mode === 'existing-session-replay',
    'stream-init': () => evidence.stream.some(record => record.type === 'system' && record.subtype === 'init'),
    'run-config': () => Boolean(evidence.taskConfig),
    'task-file': () => evidence.hasTaskFile,
    'prompt-fidelity-verified': () => evidence.promptFidelity.validForPromptBehaviorResearch === true,
    'transcript-user': () => evidence.transcript.some(record => record.type === 'user'),
    'transcript-queue': () => evidence.transcript.some(record => record.type === 'queue-operation'),
    'api-request-observable': () => evidence.fullApiRequestCount > 0 || evidence.apiObservableBodies.length > 0,
    'api-request-full': () => evidence.apiRequestDirs.length > 0 && evidence.fullApiRequestCount === evidence.apiRequestDirs.length,
    'api-request-explicit-system': () => evidence.hasExplicitSystem,
    'api-response-raw': () => evidence.hasApiResponse,
    'stream-events': () => evidence.stream.length > 0,
    'stream-api-retry': () => evidence.streamTypes.has('system/api_retry'),
    'debug-retry': () => /retry/i.test(evidence.debug),
    'debug-fallback': () => /fallback/i.test(evidence.debug),
    'stream-result': () => evidence.stream.some(record => record.type === 'result'),
    'api-turns': () => evidence.apiRequests.length > 0 || evidence.stream.filter(r => r.event?.type === 'message_start').length > 0,
    'transcript-chain': () => evidence.transcript.some(record => record.uuid && Object.hasOwn(record, 'parentUuid')),
    'derived-query-transitions': () => evidence.stream.some(record => record.type === 'result') || (
      evidence.toolResults.length > 0 && evidence.apiRequests.length > 1
    ),
    'stream-tool-delta': () => evidence.stream.some(record => record.event?.delta?.type === 'input_json_delta'),
    'transcript-tool-use': () => evidence.toolUses.length > 0,
    'tool-error-result': () => evidence.toolResults.some(result => result.is_error),
    'debug-tool': () => /tool_dispatch|tool use|tool=/i.test(evidence.debug),
    'debug-tool-dispatch': () => /tool_dispatch_start/i.test(evidence.debug),
    'stream-tool-progress': () => evidence.stream.some(record => record.type === 'tool_progress'),
    'transcript-tool-result': () => evidence.toolResults.length > 0,
    'stream-tool-result': () => evidence.stream.some(record => record.type === 'user' && record.message?.content?.some?.(b => b.type === 'tool_result')),
    'result-permission-denials': () => evidence.permissionDenials.length > 0,
    'stream-permission': () => evidence.stream.some(record => /permission/i.test(`${record.type}/${record.subtype || ''}`)),
    'debug-permission': () => /permission/i.test(evidence.debug),
    'debug-sandbox': () => /sandbox/i.test(evidence.debug),
    'tool-result': () => evidence.toolResults.length > 0,
    'stream-hook': () => evidence.hookStream.length > 0,
    'transcript-hook': () => evidence.attachments.some(a => /hook/i.test(a?.type || '')),
    'stream-task': () => evidence.taskStream.length > 0,
    'transcript-task': () => evidence.transcript.some(record => /task/i.test(`${record.type}/${record.subtype || ''}`)),
    'transcript-agent-tool': () => evidence.toolUses.some(tool => tool.name === 'Agent'),
    'subagent-meta': () => evidence.subagentFiles.some(file => file.endsWith('.meta.json')),
    'subagent-transcript': () => evidence.subagentFiles.some(file => file.endsWith('.jsonl')),
    'task-notification': () => evidence.taskStream.some(record => record.subtype === 'task_notification'),
    'debug-compact': () => /compact/i.test(evidence.debug),
    'stream-compact': () => evidence.stream.some(record => /compact/.test(record.subtype || '')),
    'transcript-compact': () => evidence.transcript.some(record => /compact/.test(record.subtype || record.type || '')),
    'debug-memory': () => /memory/i.test(evidence.debug),
    'transcript-memory': () => evidence.attachments.some(a => /memory/i.test(a?.type || '')),
    'workspace-memory': () => false,
    transcript: () => evidence.transcript.length > 0,
    'transcript-file-history': () => evidence.transcript.some(record => record.type === 'file-history-snapshot'),
    'file-history': () => !evidence.missingArtifacts.some(item => item.artifact === 'file-history'),
    'transcript-resume': () => evidence.transcript.some(record => /resume/.test(record.subtype || '')),
    'session-graph': () => evidence.transcript.some(record => record.uuid && Object.hasOwn(record, 'parentUuid')),
    'workspace-before-after': () => evidence.hasWorkspaceBefore,
    'test-output': () => evidence.hasTestOutput,
    'debug-mcp': () => /\[MCP\]|mcp/i.test(evidence.debug),
    'tui-capture': () => evidence.hasTuiCapture,
    'debug-log': () => evidence.debug.length > 0,
    'api-proxy-summary': () => evidence.apiRequests.length > 0,
    'debug-cache': () => /cache/i.test(evidence.debug),
    'transcript-attachments': () => evidence.attachments.length > 0,
    'stream-control': () => evidence.stream.some(record => /^control_/.test(record.type || '')),
    'debug-subagent': () => /subagent|runAgent|AgentTool/i.test(evidence.debug),
    'task-output': () => evidence.subagentFiles.some(file => /\.output$/.test(file)),
    'tool-result-storage': () => evidence.transcript.some(record => JSON.stringify(record).includes('<persisted-output>')),
    'transcript-remote': () => evidence.transcript.some(record => record.type === 'remote-ingress' || record.type === 'remote-message'),
  }

  const outcomes = []
  for (const name of point.evidence || []) {
    const detector = detectors[name]
    let present = false
    try {
      present = detector ? detector() : false
      if (present instanceof Promise) present = false
    } catch {}
    outcomes.push({ name, present: Boolean(present) })
  }
  const present = outcomes.filter(outcome => outcome.present)
  if (point.dimension === 'decision' && point.id.startsWith('QUERY_') && present.length > 0) {
    return { status: STATUS.DERIVED, evidence: outcomes, reason: point.invariant }
  }
  if (present.length === outcomes.length && outcomes.length > 0) {
    return { status: STATUS.CAPTURED, evidence: outcomes, reason: point.invariant }
  }
  if (present.length > 0) {
    return { status: STATUS.PARTIAL, evidence: outcomes, reason: point.invariant }
  }
  if (point.dimension === 'decision' && point.id.startsWith('QUERY_')) {
    return { status: STATUS.DERIVED, evidence: outcomes, reason: point.invariant }
  }
  return {
    status: point.required ? STATUS.MISSING : STATUS.PARTIAL,
    evidence: outcomes,
    reason: point.invariant,
  }
}

function renderCoverage(report) {
  const lines = [
    '# Capture Coverage',
    '',
    '> 状态：CAPTURED=真实证据完整；DERIVED=从真实事件关联推导；PARTIAL=只覆盖部分；MISSING=必需证据缺失；NOT_TRIGGERED=本 Case 未触发；NOT_EXPOSED=正式二进制不输出。',
    '',
    '| Layer | Captured | Partial | Missing | Derived | Not triggered | Not exposed |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ]
  for (const layer of report.layers) {
    const c = layer.counts
    lines.push(`| ${layer.id} ${layer.name} | ${c.CAPTURED || 0} | ${c.PARTIAL || 0} | ${c.MISSING || 0} | ${c.DERIVED || 0} | ${c.NOT_TRIGGERED || 0} | ${c.NOT_EXPOSED || 0} |`)
  }
  lines.push('', '## Observation points', '')
  for (const point of report.points) {
    lines.push(`### ${point.id} · ${point.name} · ${point.status}`)
    lines.push('')
    lines.push(`- Layer: ${point.layer}`)
    lines.push(`- Dimension: ${point.dimension}`)
    lines.push(`- Trigger: ${point.trigger || 'always'}`)
    lines.push(`- Invariant: ${point.reason}`)
    lines.push(`- Source: ${point.source.join(', ') || '-'}`)
    if (point.evidence.length) {
      lines.push(`- Evidence: ${point.evidence.map(item => `${item.name}=${item.present ? 'yes' : 'no'}`).join(', ')}`)
    }
    lines.push('')
  }
  lines.push('## Lifecycle invariants', '')
  for (const invariant of report.invariants) {
    lines.push(`- ${invariant.passed ? 'PASS' : 'FAIL'} ${invariant.id}: ${invariant.description}${invariant.details ? ` — ${invariant.details}` : ''}`)
  }
  lines.push('')
  return lines.join('\n')
}

function evaluateInvariants(evidence) {
  const toolUseIds = new Set(evidence.toolUses.map(tool => tool.id))
  const toolResultIds = new Set(evidence.toolResults.map(result => result.tool_use_id))
  const unmatchedResults = [...toolResultIds].filter(id => !toolUseIds.has(id))
  const openUses = [...toolUseIds].filter(id => !toolResultIds.has(id))
  const hasResult = evidence.stream.some(record => record.type === 'result')
  const nativeVisible = evidence.captureProfile === 'vscode-native-visible'
  const subagentJson = evidence.subagentFiles.filter(file => file.endsWith('.jsonl')).length
  const subagentMeta = evidence.subagentFiles.filter(file => file.endsWith('.meta.json')).length
  const checks = {
    PROMPT_FIDELITY_VERIFIED: {
      passed: evidence.promptFidelity.validForPromptBehaviorResearch === true,
      details: `${evidence.promptFidelity.mode}${evidence.promptFidelity.invalidReason ? `: ${evidence.promptFidelity.invalidReason}` : ''}`,
    },
    ROUTING_FIDELITY_VERIFIED: {
      passed: evidence.taskConfig.observer?.version < 4 || evidence.routingFidelity?.validForRoutedExperiment === true,
      details: evidence.routingFidelity
        ? `${evidence.routingFidelity.status}${evidence.routingFidelity.invalidReason ? `: ${evidence.routingFidelity.invalidReason}` : ''}`
        : 'routing-fidelity.json is missing',
    },
    REQUEST_TERMINATES: {
      passed:
        evidence.apiRequestDirs.length === 0 ||
        evidence.terminatedApiRequests === evidence.apiRequestDirs.length,
      details: `${evidence.terminatedApiRequests}/${evidence.apiRequestDirs.length} proxy requests terminated`,
    },
    TOOL_PAIRING: {
      passed: unmatchedResults.length === 0 && openUses.length === 0,
      details: `unmatched results=${unmatchedResults.length}, open uses=${openUses.length}`,
    },
    SUBAGENT_TERMINATES: {
      passed: subagentJson === subagentMeta,
      details: `sidechains=${subagentJson}, metadata=${subagentMeta}`,
    },
    FILE_EFFECT_TRACEABLE: {
      passed: !evidence.diff.trim() || evidence.tools.has('Edit') || evidence.tools.has('Write') || evidence.tools.has('Bash'),
      details: evidence.diff.trim() ? 'workspace changed with mutating tool evidence' : 'workspace unchanged',
    },
    COMPACT_REHYDRATES: {
      passed: !triggerState({ trigger: 'compact' }, evidence) || evidence.apiRequests.length > 1,
      details: triggerState({ trigger: 'compact' }, evidence) ? 'compact observed' : 'not triggered',
    },
    RUN_TERMINATES: {
      passed: nativeVisible
        ? evidence.transcript.length > 0 && evidence.terminatedApiRequests === evidence.apiRequestDirs.length
        : evidence.processResult
          ? evidence.processResult.code !== null && !evidence.processResult.timedOut
          : Boolean(hasResult || evidence.transcript.length),
      details: nativeVisible
        ? 'native VS Code session remains open; captured turn is transcript-backed and all HTTP exchanges terminated'
        : evidence.processResult
          ? `exit=${evidence.processResult.code}, timedOut=${Boolean(evidence.processResult.timedOut)}`
          : 'replayed existing session',
    },
  }
  return LIFECYCLE_INVARIANTS.map(invariant => ({ ...invariant, ...checks[invariant.id] }))
}

export async function auditCoverage({ runDir }) {
  const evidence = await loadEvidence(runDir)
  const points = OBSERVATION_POINTS.map(point => ({
    ...point,
    ...evaluatePoint(point, evidence),
  }))
  const layers = RUNTIME_LAYERS.map(layer => {
    const relevant = points.filter(point => point.layer === layer.id)
    const counts = {}
    for (const point of relevant) counts[point.status] = (counts[point.status] || 0) + 1
    return { ...layer, counts, points: relevant.map(point => point.id) }
  })
  const invariants = evaluateInvariants(evidence)
  const report = {
    generatedAt: new Date().toISOString(),
    runDir,
    summary: {
      points: points.length,
      captured: points.filter(point => point.status === STATUS.CAPTURED).length,
      partial: points.filter(point => point.status === STATUS.PARTIAL).length,
      missing: points.filter(point => point.status === STATUS.MISSING).length,
      derived: points.filter(point => point.status === STATUS.DERIVED).length,
      notTriggered: points.filter(point => point.status === STATUS.NOT_TRIGGERED).length,
      notExposed: points.filter(point => point.status === STATUS.NOT_EXPOSED).length,
      invariantFailures: invariants.filter(invariant => !invariant.passed).length,
      requiredMissing: points.filter(point => point.required && point.status === STATUS.MISSING).length,
      requiredPartial: points.filter(point => point.required && point.status === STATUS.PARTIAL).length,
    },
    layers,
    points,
    invariants,
  }
  await writeJson(path.join(runDir, '04-readable', '13-CAPTURE-COVERAGE.json'), report)
  await writeText(path.join(runDir, '04-readable', '13-CAPTURE-COVERAGE.md'), renderCoverage(report))
  return report
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  auditCoverage(parseArgs(process.argv.slice(2)))
    .then(report => process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
