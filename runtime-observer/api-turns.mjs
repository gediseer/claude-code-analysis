#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, writeJson, writeText } from './lib.mjs'
import { isAnthropicMessagesPath } from './api-paths.mjs'
import { parseSse, summarizeSse } from './sse.mjs'

function parseArgs(argv) {
  const at = argv.indexOf('--run-dir')
  return { runDir: at >= 0 ? path.resolve(argv[at + 1]) : undefined }
}

async function readJson(filePath, fallback = null) {
  if (!(await exists(filePath))) return fallback
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function messageSummary(message) {
  const content = message?.content
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: typeof content === 'string' ? content : '' }]
  const types = blocks.reduce((map, block) => {
    map[block.type || 'unknown'] = (map[block.type || 'unknown'] || 0) + 1
    return map
  }, {})
  const text = blocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  return { role: message?.role, blocks: blocks.length, types, firstLine: text.split(/\r?\n/).find(Boolean) || '' }
}

export async function buildApiTurns({ runDir }) {
  const apiRoot = path.join(runDir, '05-api')
  const outputMd = path.join(runDir, '04-readable', '17-API-TURNS.md')
  const outputJson = path.join(runDir, '04-readable', '17-API-TURNS.json')
  if (!(await exists(apiRoot))) {
    await writeText(outputMd, '# API Turns\n\n该 Run 没有经过 Recording Proxy。\n')
    await writeJson(outputJson, [])
    return { turns: 0, missing: true }
  }
  const allDirs = (await readdir(apiRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('request-'))
    .sort((a, b) => a.name.localeCompare(b.name))
  const dirs = []
  const auxiliary = []
  for (const entry of allDirs) {
    const metadata = await readJson(path.join(apiRoot, entry.name, 'request-metadata.json'), {})
    const pathname = new URL(metadata.incomingPath || '/', 'http://observer.local').pathname
    if (metadata.method === 'POST' && isAnthropicMessagesPath(pathname)) dirs.push(entry)
    else auxiliary.push({ requestId: entry.name, method: metadata.method, path: metadata.incomingPath })
  }
  const turns = []
  const lines = ['# API Turns', '', '> 每一节对应一次实际 HTTP API Request/Response。Request Body 为 Proxy 所见的可观察结构；Response 是解 HTTP chunk 后的原始 SSE body。', '']
  for (let index = 0; index < dirs.length; index += 1) {
    const dir = path.join(apiRoot, dirs[index].name)
    const request = await readJson(path.join(dir, 'request.observable.json'), { body: {} })
    const metadata = await readJson(path.join(dir, 'request-metadata.json'), {})
    const responseMetadata = await readJson(path.join(dir, 'response-metadata.json'), {})
    const summary = await readJson(path.join(dir, 'summary.json'), {})
    const responseRaw = (await exists(path.join(dir, 'response.raw')))
      ? await readFile(path.join(dir, 'response.raw'))
      : Buffer.alloc(0)
    const sseEvents = parseSse(responseRaw)
    const sse = summarizeSse(sseEvents)
    const body = request.body || {}
    const turn = {
      turn: index + 1,
      requestId: dirs[index].name,
      model: body.model,
      messages: (body.messages || []).map(messageSummary),
      toolNames: (body.tools || []).map(tool => tool.name),
      maxTokens: body.max_tokens,
      thinking: body.thinking,
      requestBytes: metadata.bodyBytes,
      statusCode: responseMetadata.statusCode,
      timeToHeadersMs: summary.timeToHeadersMs,
      durationMs: summary.durationMs,
      sse,
      omissions: request.omissions,
    }
    turns.push(turn)
    lines.push(`## Turn ${index + 1} · ${body.model || '-'}`)
    lines.push('')
    lines.push(`- Request：${metadata.bodyBytes ?? '-'} bytes`)
    lines.push(`- Messages：${turn.messages.length}`)
    lines.push(`- Tools：${turn.toolNames.length} (${turn.toolNames.join(', ') || 'none'})`)
    lines.push(`- Response：HTTP ${responseMetadata.statusCode ?? '-'}，${sse.events} SSE events`)
    lines.push(`- Time to headers / duration：${summary.timeToHeadersMs ?? '-'} / ${summary.durationMs ?? '-'} ms`)
    lines.push(`- Stop reason：${sse.stopReason ?? '-'}`)
    lines.push('')
    lines.push('### Context 增量')
    lines.push('')
    const previousCount = turns[index - 1]?.messages?.length || 0
    const newMessages = turn.messages.slice(previousCount)
    if (index === 0) lines.push(`首次请求包含 ${turn.messages.length} 条 Messages。`)
    else if (newMessages.length) lines.push(`相比上一轮新增 ${newMessages.length} 条 Messages：${newMessages.map(m => `${m.role}[${Object.keys(m.types).join(',')}]`).join(' → ')}`)
    else lines.push('Messages 数量未增加；可能为 Retry/Fallback 或 Context Rewrite。')
    lines.push('')
    lines.push('### Visible response summary')
    lines.push('')
    lines.push(sse.visibleText || '(no visible text delta)')
    lines.push('')
    lines.push('### Raw files')
    lines.push('')
    lines.push(`- [Request Observable](../05-api/${dirs[index].name}/request.observable.json)`)
    lines.push(`- [Request Metadata](../05-api/${dirs[index].name}/request-metadata.json)`)
    lines.push(`- [Raw SSE Response](../05-api/${dirs[index].name}/response.raw)`)
    lines.push(`- [Summary](../05-api/${dirs[index].name}/summary.json)`)
    lines.push('')
  }
  if (auxiliary.length) {
    lines.push('## Auxiliary API calls', '')
    for (const call of auxiliary) lines.push(`- ${call.requestId}: ${call.method} ${call.path}`)
    lines.push('')
  }
  await writeJson(outputJson, turns)
  await writeJson(path.join(runDir, '04-readable', '17-AUXILIARY-API-CALLS.json'), auxiliary)
  await writeText(outputMd, lines.join('\n'))
  return { turns: turns.length, auxiliary: auxiliary.length, missing: false }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  buildApiTurns(parseArgs(process.argv.slice(2)))
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
