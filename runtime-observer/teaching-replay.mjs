#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentBlocks, exists, parseJsonl, textFromContent, writeText } from './lib.mjs'
import { isAnthropicMessagesPath } from './api-paths.mjs'
import { assessPromptFidelityRun, promptFidelityPresentation } from './prompt-fidelity.mjs'

function parseArgs(argv) {
  const at = argv.indexOf('--run-dir')
  return { runDir: at >= 0 ? path.resolve(argv[at + 1]) : undefined }
}

async function readJson(filePath, fallback = null) {
  if (!(await exists(filePath))) return fallback
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function firstLine(value, fallback = '无可见文本') {
  if (!value) return fallback
  return value.split(/\r?\n/).find(line => line.trim())?.trim() || fallback
}

function toolSource(name) {
  if (name === 'Agent') return ['src/tools/AgentTool/AgentTool.tsx', 'src/tools/AgentTool/runAgent.ts']
  if (name === 'Bash') return ['src/tools/BashTool/BashTool.tsx', 'src/services/tools/toolExecution.ts']
  if (name === 'Edit') return ['src/tools/FileEditTool/FileEditTool.ts', 'src/services/tools/toolExecution.ts']
  if (name === 'Write') return ['src/tools/FileWriteTool/FileWriteTool.ts', 'src/services/tools/toolExecution.ts']
  if (name === 'Read') return ['src/tools/FileReadTool/FileReadTool.ts', 'src/services/tools/toolExecution.ts']
  if (name === 'Glob') return ['src/tools/GlobTool/GlobTool.ts', 'src/services/tools/toolExecution.ts']
  if (name === 'Grep') return ['src/tools/GrepTool/GrepTool.ts', 'src/services/tools/toolExecution.ts']
  return ['src/services/tools/toolExecution.ts']
}

function stringify(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function observableRequestSummary(request, index) {
  const body = request?.body || {}
  const messages = Array.isArray(body.messages) ? body.messages : []
  const tools = Array.isArray(body.tools) ? body.tools : []
  const last = messages.at(-1)
  return {
    index: index + 1,
    model: body.model || '-',
    messages: messages.length,
    tools: tools.length,
    thinking: body.thinking?.type || 'omitted/unknown',
    maxTokens: body.max_tokens ?? '-',
    lastRole: last?.role || '-',
    lastText: firstLine(textFromContent(last?.content), '无文本或为 Tool Result'),
  }
}

export async function buildTeachingReplay({ runDir }) {
  const transcriptPath = path.join(runDir, '02-session', 'transcript.visible.jsonl')
  const streamPath = path.join(runDir, '01-live-stream', 'stdout.stream.jsonl')
  const transcript = (await parseJsonl(transcriptPath)).records.map(row => row.value)
  const stream = (await parseJsonl(streamPath)).records.map(row => row.value)
  const requestDirs = []
  if (await exists(path.join(runDir, '05-api'))) {
    const entries = (await (await import('node:fs/promises')).readdir(
      path.join(runDir, '05-api'),
      { withFileTypes: true },
    ))
      .filter(entry => entry.isDirectory() && entry.name.startsWith('request-'))
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const requestDir = path.join(runDir, '05-api', entry.name)
      const metadata = JSON.parse(
        await readFile(path.join(requestDir, 'request-metadata.json'), 'utf8'),
      )
      const pathname = new URL(
        metadata.incomingPath || '/',
        'http://observer.local',
      ).pathname
      if (metadata.method === 'POST' && isAnthropicMessagesPath(pathname)) {
        requestDirs.push(requestDir)
      }
    }
  }
  const apiBodies = []
  for (const requestDir of requestDirs) {
    const value = await readJson(path.join(requestDir, 'request.observable.json'))
    if (value) apiBodies.push({ requestDir, value })
  }
  const requestSummaries = apiBodies.map((entry, index) => ({
    ...observableRequestSummary(entry.value, index),
    requestDirName: path.basename(entry.requestDir),
  }))

  const lines = [
    '# 中文教学式运行回放',
    '',
    '> 阅读方法：先看“发生了什么”，再按链接打开完整 Raw Event、API Request、Tool Result 和对应源码。',
    '',
  ]
  let step = 0
  const toolsById = new Map()
  const resultsById = new Map()
  for (const record of transcript) {
    for (const block of contentBlocks(record)) {
      if (block.type === 'tool_use') toolsById.set(block.id, { block, record })
      if (block.type === 'tool_result') {
        if (!resultsById.has(block.tool_use_id)) resultsById.set(block.tool_use_id, [])
        resultsById.get(block.tool_use_id).push({ block, record })
      }
    }
  }

  const task = await readFile(path.join(runDir, '00-task', 'task.md'), 'utf8')
  const fidelity = await assessPromptFidelityRun(runDir)
  const fidelityPresentation = promptFidelityPresentation(fidelity.mode)
  lines.push(`## 第 ${++step} 步：任务进入独立 Claude Code Session`)
  lines.push('')
  lines.push('### 发生了什么')
  lines.push('')
  lines.push('```text')
  lines.push(task)
  lines.push('```')
  lines.push('')
  lines.push(`Prompt fidelity：${fidelityPresentation.label} — ${fidelity.validForPromptBehaviorResearch ? '可用于 prompt-behavior 研究' : '不可用于 prompt-behavior 研究'}`)
  if (fidelity.invalidReason) lines.push(`Evidence status：${fidelity.invalidReason}`)
  lines.push('')
  lines.push('### 可以核验的原件')
  lines.push('')
  lines.push('- [发送给子 Session 的 Prompt](../00-task/task.md)')
  if (await exists(path.join(runDir, '00-task', 'original-query.md'))) lines.push('- [原始用户请求](../00-task/original-query.md)')
  if (await exists(path.join(runDir, '00-task', 'input-provenance.json'))) lines.push('- [Launch Prompt provenance](../00-task/input-provenance.json)')
  if (await exists(path.join(runDir, '00-task', 'prompt-fidelity.json'))) lines.push('- [Child transcript / API Prompt fidelity assessment](../00-task/prompt-fidelity.json)')
  lines.push('- [实际启动命令](../00-task/command.txt)')
  lines.push('- [生效配置](../00-task/run-config.json)')
  lines.push('')
  lines.push('### 对应源码')
  lines.push('')
  lines.push('- [CLI 入口](../../../../ClaudeCode/claude-code-analysis/src/entrypoints/cli.tsx)')
  lines.push('- [Headless Runner](../../../../ClaudeCode/claude-code-analysis/src/cli/print.ts)')
  lines.push('')

  if (requestSummaries.length) {
    for (const request of requestSummaries) {
      lines.push(`## 第 ${++step} 步：模型请求 ${request.index}`)
      lines.push('')
      lines.push('### 发送给模型的可观察结构')
      lines.push('')
      lines.push(`- Model：${request.model}`)
      lines.push(`- Messages：${request.messages}`)
      lines.push(`- Tools：${request.tools}`)
      lines.push(`- Thinking：${request.thinking}`)
      lines.push(`- Max Tokens：${request.maxTokens}`)
      lines.push(`- 最后一条消息：${request.lastRole} · ${request.lastText}`)
      lines.push('')
      lines.push('### 完整原件')
      lines.push('')
      lines.push(`- [Request Observable JSON](../05-api/${request.requestDirName}/request.observable.json)`)
      lines.push(`- [Request Metadata](../05-api/${request.requestDirName}/request-metadata.json)`)
      lines.push(`- [Raw Response](../05-api/${request.requestDirName}/response.raw)`)
      lines.push('')
      lines.push('### 对应源码')
      lines.push('')
      lines.push('- [最终 Request 参数组装](../../../../ClaudeCode/claude-code-analysis/src/services/api/claude.ts#L1538-L1728)')
      lines.push('- [API Dispatch 与 Streaming](../../../../ClaudeCode/claude-code-analysis/src/services/api/claude.ts#L1776-L2303)')
      lines.push('')
    }
  } else {
    lines.push(`## 第 ${++step} 步：模型请求层未被 Recording Proxy 捕获`)
    lines.push('')
    lines.push('该 Run 创建于 Proxy 接入前，Coverage 中会标记 API Request/Context 为 MISSING 或 PARTIAL。')
    lines.push('')
  }

  for (const [toolUseId, call] of toolsById) {
    const results = resultsById.get(toolUseId) || []
    lines.push(`## 第 ${++step} 步：调用 Tool · ${call.block.name}`)
    lines.push('')
    lines.push('### 发生了什么')
    lines.push('')
    lines.push(`模型生成 ${call.block.name} 的结构化 Tool Use；Runtime 随后执行校验、Hook、Permission 和实际调用。`)
    lines.push('')
    lines.push('### 完整 Tool Input')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(call.block.input, null, 2))
    lines.push('```')
    lines.push('')
    lines.push('### Runtime Result')
    lines.push('')
    if (!results.length) {
      lines.push('未找到配对 Tool Result；Coverage Invariant 会报告。')
    }
    for (const result of results) {
      lines.push(result.block.is_error ? '**Error Tool Result**' : '**Successful Tool Result**')
      lines.push('')
      lines.push('```text')
      lines.push(stringify(result.block.content))
      lines.push('```')
    }
    lines.push('')
    lines.push('### 为什么进入下一轮')
    lines.push('')
    lines.push('Tool Result 被包装成 user/tool_result，加入消息历史；Query Loop 根据新证据再次调用模型。')
    lines.push('')
    lines.push('### 对应源码')
    lines.push('')
    for (const source of toolSource(call.block.name)) {
      lines.push(`- [${source}](../../../../ClaudeCode/claude-code-analysis/${source})`)
    }
    lines.push('- [Result 回灌与下一轮](../../../../ClaudeCode/claude-code-analysis/src/query.ts#L1360-L1729)')
    lines.push('')
  }

  const lastVisibleAssistant = [...transcript]
    .reverse()
    .find(record => record.type === 'assistant' && textFromContent(record.message?.content))
  const final = stream.findLast(record => record.type === 'result')
  if (final) {
    lines.push(`## 第 ${++step} 步：Run 结束`)
    lines.push('')
    lines.push(`- Terminal：${final.terminal_reason || final.subtype}`)
    lines.push(`- Turns：${final.num_turns}`)
    lines.push(`- Cost：${final.total_cost_usd}`)
    lines.push(`- Duration：${final.duration_ms} ms`)
    lines.push(`- Stop Reason：${final.stop_reason}`)
    lines.push('')
    lines.push('### 最终结果')
    lines.push('')
    const terminalText = final.result || textFromContent(lastVisibleAssistant?.message?.content)
    lines.push(terminalText || (final.errors || []).join('\n'))
    if (!final.result && terminalText) {
      lines.push('')
      lines.push('> 注意：CLI terminal result 没有 result 字段；这里提升的是 Transcript 中最后一段完整可见 Assistant 报告。')
    }
    lines.push('')
    lines.push('### 原件与源码')
    lines.push('')
    lines.push('- [完整 Live Stream](10-LIVE-STREAM.md)')
    lines.push('- [Result Schema](../../../../ClaudeCode/claude-code-analysis/src/entrypoints/sdk/coreSchemas.ts#L1407-L1454)')
    lines.push('')
  }

  lines.push('## 本 Run 的观察覆盖')
  lines.push('')
  lines.push('- [Capture Coverage](13-CAPTURE-COVERAGE.md)')
  lines.push('- [Session Graph](07-SESSION-GRAPH.md)')
  lines.push('- [完整 Tool Calls](04-TOOL-CALLS.md)')
  lines.push('')
  await writeText(path.join(runDir, '04-readable', '14-TEACHING-REPLAY.md'), lines.join('\n'))
  return { steps: step, apiRequests: requestSummaries.length, tools: toolsById.size }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  buildTeachingReplay(parseArgs(process.argv.slice(2)))
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
