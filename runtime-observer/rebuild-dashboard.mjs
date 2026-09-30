#!/usr/bin/env node
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRuntimeDashboard } from './build-runtime-dashboard.mjs'
import { defaultRunsRoot, exists } from './lib.mjs'
import { writeChecksums } from './run-observed-session.mjs'

export async function rebuildDashboards({ runDir, all = false, runsRoot = defaultRunsRoot }) {
  const targets = []
  if (all) {
    for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.endsWith('.building') || entry.name.startsWith('dry-run-')) continue
      const candidate = path.join(runsRoot, entry.name)
      if (await exists(path.join(candidate, '02-session', 'transcript.visible.jsonl'))) targets.push(candidate)
    }
  } else if (runDir) {
    targets.push(path.resolve(runDir))
  } else {
    throw new Error('Use --run-dir <path> or --all')
  }
  const results = []
  for (const target of targets.sort()) {
    const result = await buildRuntimeDashboard(target)
    await writeChecksums(target)
    results.push(result)
  }
  return results
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--run-dir')
  const rootAt = argv.indexOf('--runs-root')
  rebuildDashboards({
    runDir: at >= 0 ? argv[at + 1] : null,
    all: argv.includes('--all'),
    runsRoot: rootAt >= 0 ? path.resolve(argv[rootAt + 1]) : defaultRunsRoot,
  })
    .then(results => process.stdout.write(`${JSON.stringify(results.map(result => ({ htmlPath: result.htmlPath, events: result.model.events.length })), null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
