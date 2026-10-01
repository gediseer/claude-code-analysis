#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { exists, parseJsonl, walkFiles } from './lib.mjs'

const runDir = path.resolve(process.argv[2] || '')
if (!runDir) throw new Error('Usage: node verify-run.mjs <run-dir>')

const failures = []
const checks = []
function check(name, condition, details = '') {
  checks.push({ name, passed: Boolean(condition), details })
  if (!condition) failures.push(name)
}

const manifestPath = path.join(runDir, 'manifest.json')
check('manifest exists', await exists(manifestPath))
if (await exists(manifestPath)) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const row of manifest) {
    if (row.relative === 'manifest.json' || row.relative === 'manifest.sha256') continue
    const filePath = path.join(runDir, row.relative)
    check(`file exists: ${row.relative}`, await exists(filePath))
    if (await exists(filePath)) {
      const actual = createHash('sha256').update(await readFile(filePath)).digest('hex')
      check(`hash matches: ${row.relative}`, actual === row.sha256)
    }
  }
}

const runConfigPath = path.join(runDir, '00-task', 'run-config.json')
const runConfig = (await exists(runConfigPath))
  ? JSON.parse(await readFile(runConfigPath, 'utf8'))
  : {}
const nativeVisible = runConfig.mode === 'vscode-native-visible'
const parityPath = path.join(runDir, '00-task', 'parity-manifest.json')
if (nativeVisible) {
  check('native parity manifest exists', await exists(parityPath))
  if (await exists(parityPath)) {
    const parity = JSON.parse(await readFile(parityPath, 'utf8'))
    check(
      'native execution parity verified',
      parity.status === 'PARITY_VERIFIED_WITH_DECLARED_ROUTING',
      `${parity.status}: ${(parity.failures || []).join('; ')}`,
    )
  }
}
const coveragePath = path.join(runDir, '04-readable', '13-CAPTURE-COVERAGE.json')
check('coverage report exists', await exists(coveragePath))
if (await exists(coveragePath)) {
  const coverage = JSON.parse(await readFile(coveragePath, 'utf8'))
  const isCompletedRun = await exists(path.join(runDir, '00-task', 'process-result.json'))
  const strictCoverage = nativeVisible || runConfig.observer?.version >= 4 || (
    runConfig.observer?.version >= 2 && runConfig.observer?.recordingProxyExpected
  )
  if (isCompletedRun) {
    check('lifecycle invariants pass', coverage.summary.invariantFailures === 0, `${coverage.summary.invariantFailures} failures`)
    if (strictCoverage) {
      check('no required observation point is missing', coverage.summary.requiredMissing === 0, `${coverage.summary.requiredMissing} required missing`)
    } else {
      check('legacy coverage gaps are reported', true, `${coverage.summary.requiredMissing} required gaps retained for pre-v2 run`)
    }
  } else {
    check('active replay coverage generated', true, `${coverage.summary.invariantFailures} expected snapshot-time invariant gaps`)
  }
}

const routingPath = path.join(runDir, '00-task', 'routing-fidelity.json')
if (nativeVisible || runConfig.observer?.version >= 4) {
  check('routing fidelity report exists', await exists(routingPath))
  if (await exists(routingPath)) {
    const routing = JSON.parse(await readFile(routingPath, 'utf8'))
    check(
      'routing fidelity is verified',
      routing.validForRoutedExperiment === true,
      `${routing.status}${routing.invalidReason ? `: ${routing.invalidReason}` : ''}`,
    )
  }
}

const apiRoot = path.join(runDir, '05-api')
if (await exists(apiRoot)) {
  const apiFiles = await walkFiles(apiRoot)
  const metadataFiles = apiFiles.filter(file => file.endsWith('request-metadata.json'))
  for (const metadataPath of metadataFiles) {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    const requestDir = path.dirname(metadataPath)
    const rawPath = path.join(requestDir, 'request.raw')
    const parsedPath = path.join(requestDir, 'request.parsed.json')
    const expectsFull = metadata.captureMode === 'full-entity-body'
    if (!expectsFull) continue
    check(`full request exists: ${path.relative(runDir, rawPath)}`, await exists(rawPath))
    if (await exists(rawPath)) {
      const raw = await readFile(rawPath)
      const hash = createHash('sha256').update(raw).digest('hex')
      check(`full request bytes match: ${metadata.requestId}`, raw.length === metadata.bodyBytes, `${raw.length}/${metadata.bodyBytes}`)
      check(`full request hash matches: ${metadata.requestId}`, hash === metadata.bodySha256, `${hash}/${metadata.bodySha256}`)
      if (metadata.inspectionStatus === 'parsed-json') {
        check(`parsed request exists: ${metadata.requestId}`, await exists(parsedPath))
        if (await exists(parsedPath)) {
          const parsed = JSON.parse(await readFile(parsedPath, 'utf8'))
          const rawParsed = JSON.parse(raw.toString('utf8'))
          check(`parsed request matches raw JSON: ${metadata.requestId}`, JSON.stringify(parsed) === JSON.stringify(rawParsed))
        }
      }
    }
  }
}

const transcript = path.join(runDir, '02-session', 'transcript.visible.jsonl')
check('visible transcript exists', await exists(transcript))
if (await exists(transcript)) {
  const parsed = await parseJsonl(transcript)
  check('visible transcript parses', parsed.badLines.length === 0, `${parsed.badLines.length} bad lines`)
  const toolUses = new Set()
  const toolResults = []
  for (const row of parsed.records) {
    const content = row.value.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use') toolUses.add(block.id)
      if (block.type === 'tool_result') toolResults.push(block.tool_use_id)
    }
  }
  const unmatched = toolResults.filter(id => !toolUses.has(id))
  check('all tool results match a tool use', unmatched.length === 0, unmatched.join(', '))
}

const finalReportPath = path.join(runDir, '04-readable', '18-FINAL-REPORT.md')
const finalReportJsonPath = path.join(runDir, '04-readable', '18-FINAL-REPORT.json')
check(
  'final report artifacts are complete when present',
  (await exists(finalReportPath)) === (await exists(finalReportJsonPath)),
  'historical runs created before final-report extraction may contain neither file',
)

for (const required of [
  '04-readable/00-INDEX.md',
  '04-readable/01-WORKFLOW.txt',
  '04-readable/02-TIMELINE.md',
  '04-readable/04-TOOL-CALLS.md',
  '04-readable/07-SESSION-GRAPH.md',
  '04-readable/08-SOURCE-WALKTHROUGH.md',
  '04-readable/13-CAPTURE-COVERAGE.md',
  '04-readable/14-TEACHING-REPLAY.md',
  '04-readable/15-PROMPT-TURNS.md',
  '04-readable/16-TOOL-LIFECYCLES.md',
  '04-readable/17-API-TURNS.md',
  '04-readable/replay-model.json',
  'legacy-run-dashboard.html',
]) {
  check(`readable view exists: ${required}`, await exists(path.join(runDir, required)))
}

process.stdout.write(`${JSON.stringify({ runDir, checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
