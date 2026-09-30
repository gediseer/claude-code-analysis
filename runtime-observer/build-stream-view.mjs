#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, markdownCode, parseJsonl, writeJson, writeText } from './lib.mjs'

function parseArgs(argv) {
  const index = argv.indexOf('--run-dir')
  return { runDir: index >= 0 ? argv[index + 1] : undefined }
}

function describe(record) {
  const type = record.type || 'unknown'
  if (type === 'system') return `${type}/${record.subtype || 'unknown'}`
  if (type === 'assistant') {
    const content = Array.isArray(record.message?.content) ? record.message.content : []
    const tools = content.filter(block => block.type === 'tool_use').map(block => block.name)
    return tools.length ? `assistant tool_use: ${tools.join(', ')}` : 'assistant message'
  }
  if (type === 'user') {
    const content = Array.isArray(record.message?.content) ? record.message.content : []
    const count = content.filter(block => block.type === 'tool_result').length
    return count ? `user tool_result × ${count}` : 'user message'
  }
  if (type === 'stream_event') return `stream_event/${record.event?.type || 'unknown'}`
  if (type === 'result') return `result/${record.subtype || 'unknown'}`
  return `${type}${record.subtype ? `/${record.subtype}` : ''}`
}

export async function buildStreamView({ runDir }) {
  const source = path.join(runDir, '01-live-stream', 'stdout.stream.jsonl')
  if (!(await exists(source))) return { records: 0, missing: true }
  const parsed = await parseJsonl(source)
  const counts = {}
  const lines = ['# Live stream events', '']
  const lifecycle = ['# Live-only Hook, Permission, Task and System events', '']
  for (let index = 0; index < parsed.records.length; index += 1) {
    const record = parsed.records[index].value
    const label = describe(record)
    counts[label] = (counts[label] || 0) + 1
    lines.push(`## Stream event ${index + 1}: ${label}`)
    lines.push('')
    lines.push(markdownCode(record))
    lines.push('')
    if (
      record.type === 'system' &&
      /hook|task|permission|background|session_state|api_retry|compact/i.test(record.subtype || '')
    ) {
      lifecycle.push(`## Stream event ${index + 1}: ${label}`)
      lifecycle.push('')
      lifecycle.push(markdownCode(record))
      lifecycle.push('')
    }
  }
  await writeText(path.join(runDir, '04-readable', '10-LIVE-STREAM.md'), lines.join('\n'))
  await writeText(
    path.join(runDir, '04-readable', '12-LIVE-LIFECYCLE-EVENTS.md'),
    lifecycle.length > 2 ? lifecycle.join('\n') : `${lifecycle.join('\n')}No matching live-only events.\n`,
  )
  await writeJson(path.join(runDir, '04-readable', '11-LIVE-STREAM-STATS.json'), {
    records: parsed.records.length,
    badLines: parsed.badLines.length,
    eventTypes: counts,
  })
  return { records: parsed.records.length, badLines: parsed.badLines.length, eventTypes: counts }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  buildStreamView(parseArgs(process.argv.slice(2)))
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
