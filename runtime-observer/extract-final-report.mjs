#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, parseJsonl, textFromContent, writeJson, writeText } from './lib.mjs'

function parseArgs(argv) {
  const at = argv.indexOf('--run-dir')
  return { runDir: at >= 0 ? path.resolve(argv[at + 1]) : undefined }
}

export async function extractFinalReport({ runDir }) {
  const transcript = (
    await parseJsonl(path.join(runDir, '02-session', 'transcript.visible.jsonl'))
  ).records.map(row => row.value)
  const streamPath = path.join(runDir, '01-live-stream', 'stdout.stream.jsonl')
  const stream = (await exists(streamPath))
    ? (await parseJsonl(streamPath)).records.map(row => row.value)
    : []
  const result = stream.findLast(record => record.type === 'result') || null
  const assistant = [...transcript]
    .reverse()
    .find(record => record.type === 'assistant' && textFromContent(record.message?.content))
  const visibleText = textFromContent(assistant?.message?.content)
  const report = {
    reportAvailable: Boolean(result?.result || visibleText),
    executionSucceeded: result
      ? Boolean(!result.is_error && result.subtype === 'success')
      : Boolean(visibleText),
    source: result?.result
      ? 'stream-result'
      : visibleText
        ? 'last-visible-assistant-transcript'
        : 'none',
    terminal: result
      ? {
          subtype: result.subtype,
          terminalReason: result.terminal_reason,
          isError: result.is_error,
          errors: result.errors,
          costUsd: result.total_cost_usd,
          turns: result.num_turns,
          durationMs: result.duration_ms,
        }
      : null,
    assistantUuid: assistant?.uuid || null,
    text: result?.result || visibleText || '',
  }
  const header = [
    '# Final Visible Report',
    '',
    `- Source: ${report.source}`,
    `- Terminal subtype: ${report.terminal?.subtype || '-'}`,
    `- Terminal reason: ${report.terminal?.terminalReason || '-'}`,
    `- Cost USD: ${report.terminal?.costUsd ?? '-'}`,
    `- Turns: ${report.terminal?.turns ?? '-'}`,
    '',
  ]
  if (report.source === 'last-visible-assistant-transcript' && result?.is_error) {
    header.push(
      '> CLI 最终以错误终止，但在终止前已持久化完整可见 Assistant 报告；以下正文来自 Transcript，不是伪造的 success result。',
      '',
    )
  }
  await writeText(
    path.join(runDir, '04-readable', '18-FINAL-REPORT.md'),
    `${header.join('\n')}${report.text}\n`,
  )
  await writeJson(path.join(runDir, '04-readable', '18-FINAL-REPORT.json'), report)
  return report
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  extractFinalReport(parseArgs(process.argv.slice(2)))
    .then(report => process.stdout.write(`${JSON.stringify({ source: report.source, length: report.text.length }, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
