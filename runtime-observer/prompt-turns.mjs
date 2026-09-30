#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, markdownCode, writeJson, writeText } from './lib.mjs'
import { isAnthropicMessagesPath } from './api-paths.mjs'

function parseArgs(argv) {
  const at = argv.indexOf('--run-dir')
  return { runDir: at >= 0 ? path.resolve(argv[at + 1]) : undefined }
}

function contentSummary(content) {
  if (typeof content === 'string') return { type: 'string', bytes: Buffer.byteLength(content) }
  if (!Array.isArray(content)) return { type: typeof content }
  const types = {}
  for (const block of content) types[block?.type || 'unknown'] = (types[block?.type || 'unknown'] || 0) + 1
  return { type: 'blocks', blocks: content.length, types }
}

export async function buildPromptTurns({ runDir }) {
  const apiRoot = path.join(runDir, '05-api')
  const outputMd = path.join(runDir, '04-readable', '15-PROMPT-TURNS.md')
  const outputJson = path.join(runDir, '04-readable', '15-PROMPT-TURNS.json')
  if (!(await exists(apiRoot))) {
    const noData = '# Prompt Turns\n\n该 Run 没有通过 Recording Proxy，因此没有最终 API Request Body。Coverage 将其标记为 MISSING。\n'
    await writeText(outputMd, noData)
    await writeJson(outputJson, [])
    return { turns: 0, missing: true }
  }
  const allDirs = (await readdir(apiRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('request-'))
    .sort((a, b) => a.name.localeCompare(b.name))
  const dirs = []
  for (const entry of allDirs) {
    const metadata = JSON.parse(
      await readFile(path.join(apiRoot, entry.name, 'request-metadata.json'), 'utf8'),
    )
    const pathname = new URL(metadata.incomingPath || '/', 'http://observer.local').pathname
    if (metadata.method === 'POST' && isAnthropicMessagesPath(pathname)) dirs.push(entry)
  }
  const turns = []
  const sections = ['# Prompt Turns', '', '> 新版 Recording Proxy 保存完整 request.raw，并在 JSON 可解析时保存 request.parsed.json；旧 Run 仅有 request.observable.json，隐藏正文无法恢复。认证 Header 始终不记录。', '']
  for (let index = 0; index < dirs.length; index += 1) {
    const requestDir = path.join(apiRoot, dirs[index].name)
    const observable = JSON.parse(await readFile(path.join(requestDir, 'request.observable.json'), 'utf8'))
    const parsedPath = path.join(requestDir, 'request.parsed.json')
    const fullRequestAvailable = await exists(path.join(requestDir, 'request.raw'))
    const parsedBodyAvailable = await exists(parsedPath)
    const fullBody = parsedBodyAvailable ? JSON.parse(await readFile(parsedPath, 'utf8')) : null
    const metadata = JSON.parse(await readFile(path.join(requestDir, 'request-metadata.json'), 'utf8'))
    const response = (await exists(path.join(requestDir, 'response-metadata.json')))
      ? JSON.parse(await readFile(path.join(requestDir, 'response-metadata.json'), 'utf8'))
      : null
    const body = fullBody || observable.body || {}
    const messages = Array.isArray(body.messages) ? body.messages : []
    const tools = Array.isArray(body.tools) ? body.tools : []
    const turn = {
      request: index + 1,
      dir: dirs[index].name,
      model: body.model,
      messageCount: messages.length,
      toolCount: tools.length,
      maxTokens: body.max_tokens,
      thinking: body.thinking,
      outputConfig: body.output_config,
      betas: body.betas,
      contextManagement: body.context_management,
      requestBytes: metadata.bodyBytes,
      requestSha256: metadata.bodySha256,
      fullRequestAvailable,
      parsedBodyAvailable,
      requestRawRef: fullRequestAvailable ? `05-api/${dirs[index].name}/request.raw` : null,
      responseStatus: response?.statusCode,
      messages: messages.map((message, messageIndex) => ({
        index: messageIndex,
        role: message.role,
        summary: contentSummary(message.content),
      })),
      toolNames: tools.map(tool => tool.name),
      omissions: observable.omissions,
    }
    turns.push(turn)

    sections.push(`## Request ${index + 1}`)
    sections.push('')
    sections.push(`- Model: ${body.model || '-'}`)
    sections.push(`- Messages: ${messages.length}`)
    sections.push(`- Tools: ${tools.length}`)
    sections.push(`- Max tokens: ${body.max_tokens ?? '-'}`)
    sections.push(`- Thinking: ${body.thinking?.type || 'omitted/unknown'}`)
    sections.push(`- Request bytes / SHA-256: ${metadata.bodyBytes} / ${metadata.bodySha256}`)
    sections.push(`- Full request entity captured / parsed: ${fullRequestAvailable} / ${parsedBodyAvailable}`)
    sections.push(`- Response status: ${response?.statusCode ?? 'missing'}`)
    sections.push('')
    sections.push('### System')
    sections.push('')
    sections.push(markdownCode(body.system ?? null))
    sections.push('')
    sections.push('### Messages')
    sections.push('')
    messages.forEach((message, messageIndex) => {
      sections.push(`#### Message ${messageIndex + 1} · ${message.role}`)
      sections.push('')
      sections.push(markdownCode(message))
      sections.push('')
    })
    sections.push('### Tool Schemas')
    sections.push('')
    tools.forEach((tool, toolIndex) => {
      sections.push(`#### Tool ${toolIndex + 1} · ${tool.name}`)
      sections.push('')
      sections.push(markdownCode(tool))
      sections.push('')
    })
    sections.push('### Request parameters')
    sections.push('')
    const rest = { ...body }
    delete rest.system
    delete rest.messages
    delete rest.tools
    sections.push(markdownCode(rest))
    sections.push('')
    if (fullRequestAvailable) sections.push(`- [Complete request entity body](../05-api/${dirs[index].name}/request.raw)`)
    if (parsedBodyAvailable) sections.push(`- [Complete parsed request](../05-api/${dirs[index].name}/request.parsed.json)`)
    sections.push(`- [Request metadata](../05-api/${dirs[index].name}/request-metadata.json)`)
    sections.push(`- [Raw response](../05-api/${dirs[index].name}/response.raw)`)
    sections.push('')
  }
  await writeText(outputMd, sections.join('\n'))
  await writeJson(outputJson, turns)
  return { turns: turns.length, missing: false }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  buildPromptTurns(parseArgs(process.argv.slice(2)))
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
