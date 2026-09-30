#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultRunsRoot, exists, writeText } from './lib.mjs'

export async function buildCaseIndex(runsRoot = defaultRunsRoot) {
  runsRoot = path.resolve(runsRoot)
  const rows = []
for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.endsWith('.building') || entry.name.startsWith('dry-run-')) continue
  const runDir = path.join(runsRoot, entry.name)
  const statsPath = path.join(runDir, '04-readable', '09-STATS.json')
  if (!(await exists(statsPath))) continue
  const stats = JSON.parse(await readFile(statsPath, 'utf8'))
  const liveStatsPath = path.join(runDir, '04-readable', '11-LIVE-STREAM-STATS.json')
  const live = (await exists(liveStatsPath))
    ? JSON.parse(await readFile(liveStatsPath, 'utf8'))
    : null
  const processResultPath = path.join(runDir, '00-task', 'process-result.json')
  const processResult = (await exists(processResultPath))
    ? JSON.parse(await readFile(processResultPath, 'utf8'))
    : null
  const coveragePath = path.join(runDir, '04-readable', '13-CAPTURE-COVERAGE.json')
  const coverage = (await exists(coveragePath))
    ? JSON.parse(await readFile(coveragePath, 'utf8'))
    : null
  const routingPath = path.join(runDir, '00-task', 'routing-fidelity.json')
  const routing = (await exists(routingPath))
    ? JSON.parse(await readFile(routingPath, 'utf8'))
    : null
  const apiTurnsPath = path.join(runDir, '04-readable', '17-API-TURNS.json')
  const apiTurns = (await exists(apiTurnsPath))
    ? JSON.parse(await readFile(apiTurnsPath, 'utf8'))
    : []
  rows.push({ name: entry.name, stats, live, processResult, coverage, routing, apiTurns })
}
rows.sort((a, b) => a.name.localeCompare(b.name))

const lines = [
  '# Claude Code Runtime Runs',
  '',
  '| Run | Transcript | Live | API turns | Tool use/result | Subagents | Captured/Partial/Missing | Routing | Exit |',
  '|---|---:|---:|---:|---:|---:|---:|---|---:|',
]
for (const row of rows) {
  lines.push(
    `| [${row.name}](${row.name}/runtime-replay.html) | ${row.stats.records} | ${row.live?.records ?? '-'} | ${row.apiTurns.length || '-'} | ${row.stats.toolUses}/${row.stats.toolResults} | ${row.stats.subagents} | ${row.coverage ? `${row.coverage.summary.captured}/${row.coverage.summary.partial}/${row.coverage.summary.missing}` : '-'} | ${row.routing?.status ?? '-'} | ${row.processResult?.code ?? '-'} |`,
  )
}
lines.push('', '- [Cross-case comparison](COMPARE.md)', '', 'Each Run contains raw process streams, API requests/responses when proxied, session artifacts, workspace snapshots, coverage, teaching replay and SHA-256 manifests.', '')
  await writeText(path.join(runsRoot, 'INDEX.md'), lines.join('\n'))
  return { runsRoot, rows, indexPath: path.join(runsRoot, 'INDEX.md') }
}

if (process.argv[1]) {
  const invoked = path.resolve(process.argv[1])
  const current = path.resolve(fileURLToPath(import.meta.url))
  if (invoked === current) {
    buildCaseIndex(process.argv[2] || defaultRunsRoot)
      .then(result => process.stdout.write(`${result.indexPath}\n`))
      .catch(error => {
        process.stderr.write(`${error.stack || error}\n`)
        process.exitCode = 1
      })
  }
}
