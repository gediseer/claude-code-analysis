#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  analysisDir,
  contentBlocks,
  exists,
  markdownCode,
  parseJsonl,
  recordTimestamp,
  shortId,
  textFromContent,
  walkFiles,
  writeJson,
  writeText,
} from './lib.mjs'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (!current.startsWith('--')) continue
    const next = argv[index + 1]
    args[current.slice(2)] = next && !next.startsWith('--') ? next : true
    if (next && !next.startsWith('--')) index += 1
  }
  return args
}

function classify(row, index) {
  const record = row.value
  const blocks = contentBlocks(record)
  const tools = blocks
    .filter(block => block?.type === 'tool_use')
    .map(block => ({
      id: block.id,
      name: block.name,
      input: block.input,
    }))
  const results = blocks
    .filter(block => block?.type === 'tool_result')
    .map(block => ({
      id: block.tool_use_id,
      isError: Boolean(block.is_error),
      content: block.content,
    }))
  return {
    seq: index + 1,
    sourceLine: row.line,
    timestamp: recordTimestamp(record),
    type: record.type || 'unknown',
    subtype: record.subtype || record.message?.subtype || null,
    role: record.message?.role || null,
    uuid: record.uuid || null,
    parentUuid: record.parentUuid ?? null,
    agentId: record.agentId || null,
    sessionId: record.sessionId || null,
    stopReason: record.message?.stop_reason || null,
    text: textFromContent(record.message?.content),
    tools,
    results,
    raw: record,
  }
}

function eventLabel(event) {
  const parts = [event.type]
  if (event.subtype) parts.push(event.subtype)
  if (event.role) parts.push(`role=${event.role}`)
  if (event.stopReason) parts.push(`stop=${event.stopReason}`)
  if (event.tools.length) parts.push(`tools=${event.tools.map(tool => tool.name).join(',')}`)
  if (event.results.length) parts.push(`results=${event.results.length}`)
  return parts.join(' | ')
}

function buildToolIndex(events) {
  const calls = new Map()
  for (const event of events) {
    for (const tool of event.tools) {
      calls.set(tool.id, {
        toolUseId: tool.id,
        name: tool.name,
        input: tool.input,
        callEvent: event,
        results: [],
      })
    }
    for (const result of event.results) {
      const call = calls.get(result.id) || {
        toolUseId: result.id,
        name: '(unmatched)',
        input: null,
        callEvent: null,
        results: [],
      }
      call.results.push({ ...result, resultEvent: event })
      calls.set(result.id, call)
    }
  }
  return [...calls.values()]
}

function eventTable(events) {
  const rows = [
    '| # | Time | Event | UUID | Parent |',
    '|---:|---|---|---|---|',
  ]
  for (const event of events) {
    rows.push(
      `| ${event.seq} | ${event.timestamp || '-'} | ${eventLabel(event).replaceAll('|', '\\|')} | ${shortId(event.uuid)} | ${shortId(event.parentUuid)} |`,
    )
  }
  return rows.join('\n')
}

function renderConversation(events) {
  const sections = ['# Visible conversation', '']
  for (const event of events) {
    if (event.type !== 'user' && event.type !== 'assistant') continue
    if (!event.text) continue
    sections.push(`## Event ${event.seq}: ${event.role || event.type}`)
    sections.push('')
    sections.push(event.text)
    sections.push('')
  }
  return sections.join('\n')
}

function renderTestOutput(calls) {
  const sections = []
  for (const call of calls) {
    const command = typeof call.input?.command === 'string' ? call.input.command : ''
    if (call.name !== 'Bash' || !/(?:^|\s)(?:npm\s+test|node\s+--test|pytest|cargo\s+test|go\s+test|dotnet\s+test)(?:\s|$)/i.test(command)) {
      continue
    }
    sections.push(`$ ${command}`)
    for (const result of call.results) {
      sections.push(result.isError ? '[tool_result: error]' : '[tool_result: success]')
      sections.push(typeof result.content === 'string' ? result.content : JSON.stringify(result.content, null, 2))
    }
    sections.push('')
  }
  return sections.length ? sections.join('\n') : 'No test command was observed in this run.\n'
}

function renderTools(calls) {
  const sections = ['# Tool calls and results', '']
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    sections.push(`## Tool ${index + 1}: ${call.name}`)
    sections.push('')
    sections.push(`- tool_use_id: ${call.toolUseId || '-'}`)
    sections.push(`- call event: ${call.callEvent?.seq ?? 'missing'}`)
    sections.push(`- result events: ${call.results.map(result => result.resultEvent.seq).join(', ') || 'missing'}`)
    sections.push('')
    sections.push('### Input')
    sections.push('')
    sections.push(markdownCode(call.input))
    sections.push('')
    for (let resultIndex = 0; resultIndex < call.results.length; resultIndex += 1) {
      const result = call.results[resultIndex]
      sections.push(`### Result ${resultIndex + 1}${result.isError ? ' (error)' : ''}`)
      sections.push('')
      sections.push(markdownCode(result.content, typeof result.content === 'string' ? 'text' : 'json'))
      sections.push('')
    }
  }
  return sections.join('\n')
}

function renderGraph(events) {
  const lines = ['# Session graph', '', '```text']
  const eventByUuid = new Map(events.filter(event => event.uuid).map(event => [event.uuid, event]))
  const children = new Map()
  for (const event of events) {
    if (!event.uuid) continue
    const parent = event.parentUuid || '(root)'
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(event)
  }
  function walk(parent, prefix, seen) {
    for (const event of children.get(parent) || []) {
      const cycle = seen.has(event.uuid)
      lines.push(`${prefix}├─ #${event.seq} ${shortId(event.uuid)} ${eventLabel(event)}${cycle ? ' [cycle]' : ''}`)
      if (!cycle) walk(event.uuid, `${prefix}│  `, new Set([...seen, event.uuid]))
    }
  }
  walk('(root)', '', new Set())
  const unattached = events.filter(event => event.uuid && event.parentUuid && !eventByUuid.has(event.parentUuid))
  if (unattached.length) {
    lines.push('')
    lines.push('Unattached/side branches:')
    for (const event of unattached) {
      lines.push(`├─ #${event.seq} parent=${shortId(event.parentUuid)} ${eventLabel(event)}`)
      walk(event.uuid, '│  ', new Set([event.uuid]))
    }
  }
  lines.push('```', '')
  return lines.join('\n')
}

function renderWorkflow(stats) {
  return `User task\n   │\n   ▼\nAssistant/API turn\n   │\n   ├─ text response\n   │\n   └─ tool_use (${stats.toolUses})\n          │\n          ▼\n      Tool validation / permission / execution\n          │\n          ▼\n      tool_result (${stats.toolResults})\n          │\n          └──────────► next Assistant/API turn\n\nSubagents: ${stats.subagents}\nAttachments: ${stats.attachments}\nTranscript records: ${stats.records}\n`
}

function renderSourceWalkthrough() {
  return `# Runtime events mapped to source\n\n## CLI and stream-json\n\n- [src/cli/print.ts:847-929](../../../../ClaudeCode/claude-code-analysis/src/cli/print.ts#L847-L929): writes stream-json events and terminal result.\n- [src/entrypoints/sdk/coreSchemas.ts:1347-1504](../../../../ClaudeCode/claude-code-analysis/src/entrypoints/sdk/coreSchemas.ts#L1347-L1504): assistant, result, init and partial stream schemas.\n\n## Model stream to tool_use\n\n- [src/services/api/claude.ts:1940-2303](../../../../ClaudeCode/claude-code-analysis/src/services/api/claude.ts#L1940-L2303): parses message/content deltas and assembles Tool input JSON.\n- [src/query.ts:742-845](../../../../ClaudeCode/claude-code-analysis/src/query.ts#L742-L845): receives assistant tool_use blocks and feeds the streaming executor.\n\n## Tool execution and result return\n\n- [src/services/tools/toolExecution.ts:337-490](../../../../ClaudeCode/claude-code-analysis/src/services/tools/toolExecution.ts#L337-L490): resolves a Tool and handles unknown/aborted calls.\n- [src/services/tools/toolExecution.ts:599-1104](../../../../ClaudeCode/claude-code-analysis/src/services/tools/toolExecution.ts#L599-L1104): schema validation, semantic validation, Hooks and Permission.\n- [src/services/tools/toolExecution.ts:1128-1745](../../../../ClaudeCode/claude-code-analysis/src/services/tools/toolExecution.ts#L1128-L1745): calls the Tool and produces success/failure result blocks.\n- [src/query.ts:1360-1729](../../../../ClaudeCode/claude-code-analysis/src/query.ts#L1360-L1729): appends tool_result and starts the next turn.\n\n## Persistence\n\n- [src/utils/sessionStorage.ts:198-303](../../../../ClaudeCode/claude-code-analysis/src/utils/sessionStorage.ts#L198-L303): transcript and subagent paths.\n- [src/utils/sessionStorage.ts:532-686](../../../../ClaudeCode/claude-code-analysis/src/utils/sessionStorage.ts#L532-L686): append-only JSONL writer.\n- [src/types/logs.ts:8-53](../../../../ClaudeCode/claude-code-analysis/src/types/logs.ts#L8-L53): serialized transcript metadata.\n`
}

async function renderSubagents(runDir) {
  const root = path.join(runDir, '02-session', 'session-files', 'subagents')
  const files = (await walkFiles(root)).filter(filePath => filePath.endsWith('.jsonl'))
  const sections = ['# Subagents', '', `Found ${files.length} subagent transcripts.`, '']
  const summary = []
  for (const filePath of files) {
    const parsed = await parseJsonl(filePath)
    const events = parsed.records.map(classify)
    const metaPath = filePath.replace(/\.jsonl$/, '.meta.json')
    let meta = null
    if (await exists(metaPath)) {
      try {
        meta = JSON.parse(await (await import('node:fs/promises')).readFile(metaPath, 'utf8'))
      } catch {}
    }
    sections.push(`## ${path.basename(filePath)}`)
    sections.push('')
    sections.push(`- path: ${path.relative(runDir, filePath).replaceAll('\\', '/')}`)
    sections.push(`- records: ${events.length}`)
    sections.push(`- metadata: ${meta ? JSON.stringify(meta) : 'none'}`)
    const finalText = [...events].reverse().find(event => event.type === 'assistant' && event.text)?.text
    if (finalText) {
      sections.push('')
      sections.push('### Final visible assistant text')
      sections.push('')
      sections.push(finalText)
    }
    sections.push('')
    summary.push({ file: filePath, meta, records: events.length })
  }
  return { markdown: sections.join('\n'), summary }
}

export async function buildReadableViews({ runDir }) {
  const transcript = path.join(runDir, '02-session', 'transcript.visible.jsonl')
  if (!(await exists(transcript))) throw new Error(`Missing transcript: ${transcript}`)
  const parsed = await parseJsonl(transcript)
  const events = parsed.records.map(classify)
  const calls = buildToolIndex(events)
  const subagentView = await renderSubagents(runDir)
  const counts = {}
  for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1
  const stats = {
    records: events.length,
    badLines: parsed.badLines.length,
    recordTypes: counts,
    toolUses: events.reduce((sum, event) => sum + event.tools.length, 0),
    toolResults: events.reduce((sum, event) => sum + event.results.length, 0),
    unmatchedToolCalls: calls.filter(call => !call.results.length).length,
    unmatchedToolResults: calls.filter(call => !call.callEvent).length,
    attachments: counts.attachment || 0,
    subagents: subagentView.summary.length,
  }
  const readable = path.join(runDir, '04-readable')
  const runConfigPath = path.join(runDir, '00-task', 'run-config.json')
  const runConfig = (await exists(runConfigPath))
    ? JSON.parse(await (await import('node:fs/promises')).readFile(runConfigPath, 'utf8'))
    : {}
  const liveStreamNote = runConfig.mode === 'vscode-native-visible'
    ? 'Native VS Code profile: there is no Observer-created headless stdout stream.'
    : 'Live stream is available when captured from process start.'

  const index = `# Runtime observation run\n\nCapture profile: ${runConfig.mode || 'legacy-headless'}\n\n${liveStreamNote}\n\n## Read in this order\n\n1. [Workflow](01-WORKFLOW.txt)\n2. [Timeline](02-TIMELINE.md)\n3. [Visible conversation](03-CONVERSATION.md)\n4. [Tool calls and complete results](04-TOOL-CALLS.md)\n5. [Subagents](05-SUBAGENTS.md)\n6. [Tasks, hooks and permissions](06-TASKS-HOOKS-PERMISSIONS.md)\n7. [Session graph](07-SESSION-GRAPH.md)\n8. [Source walkthrough](08-SOURCE-WALKTHROUGH.md)\n9. [Statistics](09-STATS.json)\n10. [Live stream](10-LIVE-STREAM.md), when captured from process start\n11. [Capture coverage](13-CAPTURE-COVERAGE.md)\n12. [中文教学回放](14-TEACHING-REPLAY.md)\n13. [每轮 Prompt / Messages / Tool Schemas](15-PROMPT-TURNS.md)\n14. [逐 Tool 生命周期](16-TOOL-LIFECYCLES.md)\n15. [逐轮 API Request / SSE Response](17-API-TURNS.md)\n16. [最终可见报告](18-FINAL-REPORT.md)\n\n## Raw material\n\n- [Visible main transcript](../02-session/transcript.visible.jsonl)\n- [Original locations](../02-session/RAW-LOCATIONS.md)\n- [Collection manifest](../02-session/collection-manifest.json)\n- [Live stream](../01-live-stream/stdout.stream.jsonl) when the run was launched by the Observer.\n\nThe readable views do not replace the raw files. They provide ordering and links.\n`

  const eventDetails = events
    .filter(event => ['attachment', 'system', 'queue-operation'].includes(event.type) || /hook|task|permission/i.test(`${event.type} ${event.subtype || ''}`))
    .map(event => `## Event ${event.seq}: ${eventLabel(event)}\n\n${markdownCode(event.raw)}\n`)
    .join('\n')

  await Promise.all([
    writeText(path.join(readable, '00-INDEX.md'), index),
    writeText(path.join(readable, '01-WORKFLOW.txt'), renderWorkflow(stats)),
    writeText(path.join(readable, '02-TIMELINE.md'), `# Complete event timeline\n\n${eventTable(events)}\n`),
    writeText(path.join(readable, '03-CONVERSATION.md'), renderConversation(events)),
    writeText(path.join(readable, '04-TOOL-CALLS.md'), renderTools(calls)),
    writeText(path.join(readable, '05-SUBAGENTS.md'), subagentView.markdown),
    writeText(path.join(readable, '06-TASKS-HOOKS-PERMISSIONS.md'), `# Tasks, hooks, permissions and attachments\n\n${eventDetails || 'No matching persisted events.\n'}`),
    writeText(path.join(readable, '07-SESSION-GRAPH.md'), renderGraph(events)),
    writeText(path.join(readable, '08-SOURCE-WALKTHROUGH.md'), renderSourceWalkthrough()),
    writeJson(path.join(readable, '09-STATS.json'), stats),
    writeText(path.join(runDir, '03-workspace', 'test-output.txt'), renderTestOutput(calls)),
    writeText(path.join(runDir, 'LIMITS.md'), `# Observation limits\n\n- Hidden system instructions and private chain-of-thought are not exported.\n- A run only contains partial SSE, Hook and Debug events if those channels were enabled before launch.\n- Missing artifacts are listed in 02-session/missing-artifacts.json; nothing is reconstructed or fabricated.\n`),
    writeText(
      path.join(runDir, 'timeline.jsonl'),
      `${events.map(({ raw, ...event }) => JSON.stringify(event)).join('\n')}\n`,
    ),
  ])

  return { stats, events: events.length, tools: calls.length }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  buildReadableViews({ runDir: args['run-dir'] })
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
