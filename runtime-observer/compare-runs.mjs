#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultRunsRoot, exists, writeJson, writeText } from './lib.mjs'

async function readJson(filePath, fallback = null) {
  if (!(await exists(filePath))) return fallback
  return JSON.parse(await readFile(filePath, 'utf8'))
}

export async function compareRuns({ runsRoot = defaultRunsRoot }) {
  const runs = []
  for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.endsWith('.building') || entry.name.startsWith('dry-run-')) continue
    const runDir = path.join(runsRoot, entry.name)
    const stats = await readJson(path.join(runDir, '04-readable', '09-STATS.json'))
    if (!stats) continue
    const live = await readJson(path.join(runDir, '04-readable', '11-LIVE-STREAM-STATS.json'))
    const coverage = await readJson(path.join(runDir, '04-readable', '13-CAPTURE-COVERAGE.json'))
    const config = await readJson(path.join(runDir, '00-task', 'run-config.json'), {})
    const processResult = await readJson(path.join(runDir, '00-task', 'process-result.json'))
    let finalResult = null
    const streamPath = path.join(runDir, '01-live-stream', 'stdout.stream.jsonl')
    if (await exists(streamPath)) {
      const rows = (await readFile(streamPath, 'utf8')).trim().split(/\r?\n/)
      for (const row of rows) {
        try {
          const value = JSON.parse(row)
          if (value.type === 'result') finalResult = value
        } catch {}
      }
    }
    runs.push({
      name: entry.name,
      runDir,
      title: config.case?.title || config.mode || entry.name,
      stats,
      live,
      coverage,
      processResult,
      routing: await readJson(path.join(runDir, '00-task', 'routing-fidelity.json')),
      finalResult,
      apiTurns: await readJson(path.join(runDir, '04-readable', '17-API-TURNS.json'), []),
      toolLifecycles: await readJson(path.join(runDir, '04-readable', '16-TOOL-LIFECYCLES.json'), []),
    })
  }
  runs.sort((a, b) => a.name.localeCompare(b.name))

  const allLayers = new Set()
  for (const run of runs) for (const layer of run.coverage?.layers || []) allLayers.add(layer.id)
  const lines = [
    '# Runtime Case Comparison',
    '',
    '## 执行规模',
    '',
    '| Case | Transcript | Live events | API requests | Tool Use/Result | Subagents | Turns | Cost | Duration | Routing |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ]
  for (const run of runs) {
    lines.push(`| [${run.name}](${run.name}/legacy-run-dashboard.html) | ${run.stats.records} | ${run.live?.records ?? '-'} | ${run.apiTurns.length || '-'} | ${run.stats.toolUses}/${run.stats.toolResults} | ${run.stats.subagents} | ${run.finalResult?.num_turns ?? '-'} | ${run.finalResult?.total_cost_usd ?? '-'} | ${run.finalResult?.duration_ms ?? run.processResult?.duration_ms ?? '-'} | ${run.routing?.status ?? '-'} |`)
  }
  lines.push('', '## 架构层覆盖差异', '')
  lines.push(`| Layer | ${runs.map(run => run.name).join(' | ')} |`)
  lines.push(`|---|${runs.map(() => '---').join('|')}|`)
  for (const layerId of allLayers) {
    const cells = runs.map(run => {
      const layer = run.coverage?.layers?.find(item => item.id === layerId)
      if (!layer) return '-'
      const c = layer.counts
      return `C${c.CAPTURED || 0}/P${c.PARTIAL || 0}/M${c.MISSING || 0}/N${c.NOT_TRIGGERED || 0}`
    })
    lines.push(`| ${layerId} | ${cells.join(' | ')} |`)
  }
  lines.push('', '图例：C=CAPTURED，P=PARTIAL，M=MISSING，N=NOT_TRIGGERED。', '')
  lines.push('## 任务行为差异', '')
  for (const run of runs) {
    lines.push(`### ${run.name}`)
    lines.push('')
    lines.push(`- Tool Uses：${run.stats.toolUses}`)
    lines.push(`- Subagents：${run.stats.subagents}`)
    lines.push(`- API Requests：${run.apiTurns.length || 'not captured'}`)
    lines.push(`- Routing Fidelity：${run.routing?.status ?? 'not recorded'}`)
    const denied = run.toolLifecycles.filter(tool => tool.stages?.permission === 'CAPTURED_DENY').length
    const toolErrors = run.toolLifecycles.filter(tool => tool.results?.some(result => result.isError)).length
    lines.push(`- Tool Errors / Denials：${toolErrors} / ${denied}`)
    lines.push(`- Coverage Missing：${run.coverage?.summary?.missing ?? '-'}`)
    lines.push(`- Coverage Not Triggered：${run.coverage?.summary?.notTriggered ?? '-'}`)
    lines.push('')
  }
  const output = { generatedAt: new Date().toISOString(), runs }
  await writeJson(path.join(runsRoot, 'COMPARE.json'), output)
  await writeText(path.join(runsRoot, 'COMPARE.md'), lines.join('\n'))
  return output
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf('--runs-root')
  compareRuns({ runsRoot: at >= 0 ? path.resolve(process.argv[at + 1]) : defaultRunsRoot })
    .then(result => process.stdout.write(`${result.runs.length} runs compared\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
