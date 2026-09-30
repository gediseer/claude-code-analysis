#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentBlocks, exists, parseJsonl, writeJson, writeText } from './lib.mjs'

function parseArgs(argv) {
  const at = argv.indexOf('--run-dir')
  return { runDir: at >= 0 ? path.resolve(argv[at + 1]) : undefined }
}

function debugEvents(text) {
  const events = []
  for (const line of text.split(/\r?\n/)) {
    const start = line.match(/tool_dispatch_start tool=(\S+) toolUseId=(\S+)(?: permissionDecisionMs=(\d+))?/)
    if (start) {
      events.push({ type: 'dispatch_start', tool: start[1], toolUseId: start[2], permissionDecisionMs: Number(start[3] || 0), raw: line })
    }
    const end = line.match(/tool_dispatch_end tool=(\S+) toolUseId=(\S+) outcome=(\S+) durationMs=(\d+)/)
    if (end) {
      events.push({ type: 'dispatch_end', tool: end[1], toolUseId: end[2], outcome: end[3], durationMs: Number(end[4]), raw: line })
    }
  }
  return events
}

export async function buildToolLifecycles({ runDir }) {
  const transcript = (await parseJsonl(path.join(runDir, '02-session', 'transcript.visible.jsonl'))).records.map(row => row.value)
  const stream = (await parseJsonl(path.join(runDir, '01-live-stream', 'stdout.stream.jsonl'))).records.map(row => row.value)
  const debugPath = path.join(runDir, '01-live-stream', 'debug.log')
  const debug = (await exists(debugPath)) ? await readFile(debugPath, 'utf8') : ''
  const debugByTool = new Map()
  for (const event of debugEvents(debug)) {
    if (!debugByTool.has(event.toolUseId)) debugByTool.set(event.toolUseId, [])
    debugByTool.get(event.toolUseId).push(event)
  }
  const calls = new Map()
  for (const record of transcript) {
    for (const block of contentBlocks(record)) {
      if (block.type === 'tool_use') {
        calls.set(block.id, {
          toolUseId: block.id,
          name: block.name,
          input: block.input,
          callUuid: record.uuid,
          callTimestamp: record.timestamp,
          results: [],
        })
      }
      if (block.type === 'tool_result') {
        const call = calls.get(block.tool_use_id) || {
          toolUseId: block.tool_use_id,
          name: '(unmatched)',
          input: null,
          results: [],
        }
        call.results.push({
          isError: Boolean(block.is_error),
          content: block.content,
          uuid: record.uuid,
          timestamp: record.timestamp,
        })
        calls.set(block.tool_use_id, call)
      }
    }
  }
  const denials = stream.filter(record => record.type === 'result').flatMap(record => record.permission_denials || [])
  const hookEvents = stream.filter(record => record.type === 'system' && /hook/.test(record.subtype || ''))
  const lifecycles = [...calls.values()].map(call => {
    const debugStages = debugByTool.get(call.toolUseId) || []
    const hooks = hookEvents.filter(record =>
      record.tool_use_id === call.toolUseId ||
      record.toolUseId === call.toolUseId ||
      JSON.stringify(record).includes(call.toolUseId),
    )
    const denied = denials.find(denial => denial.tool_use_id === call.toolUseId)
    const dispatchStart = debugStages.find(event => event.type === 'dispatch_start')
    const dispatchEnd = debugStages.find(event => event.type === 'dispatch_end')
    return {
      ...call,
      stages: {
        modelToolUse: 'CAPTURED',
        schemaValidation: call.results.some(result => result.isError) ? 'PARTIAL' : 'DERIVED',
        semanticValidation: call.results.some(result => result.isError) ? 'PARTIAL' : 'DERIVED',
        preToolHook: hooks.some(event => /PreToolUse/.test(event.hook_event || event.hook_name || '')) ? 'CAPTURED' : 'NOT_TRIGGERED',
        permission: denied ? 'CAPTURED_DENY' : dispatchStart ? 'CAPTURED_ALLOW' : 'PARTIAL',
        dispatch: dispatchStart ? 'CAPTURED' : 'MISSING',
        execution: dispatchEnd ? 'CAPTURED' : call.results.length ? 'DERIVED' : 'MISSING',
        postToolHook: hooks.some(event => /PostToolUse/.test(event.hook_event || event.hook_name || '')) ? 'CAPTURED' : 'NOT_TRIGGERED',
        toolResult: call.results.length ? 'CAPTURED' : 'MISSING',
      },
      permissionDenial: denied || null,
      debug: debugStages,
      hooks,
      dispatch: dispatchStart && dispatchEnd
        ? {
            permissionDecisionMs: dispatchStart.permissionDecisionMs,
            durationMs: dispatchEnd.durationMs,
            outcome: dispatchEnd.outcome,
          }
        : null,
    }
  })

  const lines = ['# Tool Lifecycles', '', '> 每个 Tool 按 Runtime 生命周期展开。CAPTURED 表示直接证据，DERIVED 表示由真实前后事件确定，PARTIAL 表示正式 Debug 没有暴露完整中间判断。', '']
  for (let index = 0; index < lifecycles.length; index += 1) {
    const item = lifecycles[index]
    lines.push(`## ${index + 1}. ${item.name} · ${item.toolUseId}`)
    lines.push('')
    lines.push('```text')
    lines.push(`model tool_use      ${item.stages.modelToolUse}`)
    lines.push(`schema validation   ${item.stages.schemaValidation}`)
    lines.push(`semantic validation ${item.stages.semanticValidation}`)
    lines.push(`PreToolUse Hook     ${item.stages.preToolHook}`)
    lines.push(`permission          ${item.stages.permission}`)
    lines.push(`dispatch            ${item.stages.dispatch}`)
    lines.push(`execution           ${item.stages.execution}`)
    lines.push(`PostToolUse Hook    ${item.stages.postToolHook}`)
    lines.push(`tool_result         ${item.stages.toolResult}`)
    lines.push('```')
    lines.push('')
    if (item.dispatch) {
      lines.push(`- Permission decision: ${item.dispatch.permissionDecisionMs} ms`)
      lines.push(`- Execution: ${item.dispatch.durationMs} ms, ${item.dispatch.outcome}`)
    }
    if (item.permissionDenial) lines.push(`- Permission denial: ${JSON.stringify(item.permissionDenial)}`)
    lines.push(`- Results: ${item.results.length}`)
    lines.push('')
    lines.push('### Input')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(item.input, null, 2))
    lines.push('```')
    lines.push('')
  }
  await writeJson(path.join(runDir, '04-readable', '16-TOOL-LIFECYCLES.json'), lifecycles)
  await writeText(path.join(runDir, '04-readable', '16-TOOL-LIFECYCLES.md'), lines.join('\n'))
  return { tools: lifecycles.length }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  buildToolLifecycles(parseArgs(process.argv.slice(2)))
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
