#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { observerDir, writeJson, writeText } from './lib.mjs'
import { LIFECYCLE_INVARIANTS, OBSERVATION_POINTS, RUNTIME_LAYERS } from './runtime-model.mjs'

const registry = {
  generatedAt: new Date().toISOString(),
  layers: RUNTIME_LAYERS,
  observationPoints: OBSERVATION_POINTS,
  lifecycleInvariants: LIFECYCLE_INVARIANTS,
}
await writeJson(path.join(observerDir, 'OBSERVATION-POINTS.json'), registry)

const lines = [
  '# Observation Point Registry',
  '',
  '该表由 `runtime-model.mjs` 生成。Coverage Auditor 以同一注册表检查每个真实 Run。',
  '',
  '| ID | Layer | Name | Dimension | Trigger | Evidence |',
  '|---|---|---|---|---|---|',
]
for (const point of OBSERVATION_POINTS) {
  lines.push(`| ${point.id} | ${point.layer} | ${point.name} | ${point.dimension} | ${point.trigger || 'always'} | ${(point.evidence || []).join(', ') || 'NOT_EXPOSED'} |`)
}
lines.push('', '## Lifecycle Invariants', '')
for (const invariant of LIFECYCLE_INVARIANTS) {
  lines.push(`- **${invariant.id}**：${invariant.description}`)
}
lines.push('')
await writeText(path.join(observerDir, 'OBSERVATION-POINTS.md'), lines.join('\n'))
process.stdout.write(`${OBSERVATION_POINTS.length} observation points generated\n`)
