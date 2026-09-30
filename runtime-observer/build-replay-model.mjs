#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeJson } from './lib.mjs'
import { buildReplayModel } from './replay-model.mjs'

export async function writeReplayModel(runDir) {
  const model = await buildReplayModel(runDir)
  const output = path.join(runDir, '04-readable', 'replay-model.json')
  await writeJson(output, model)
  return { model, output }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const at = process.argv.indexOf('--run-dir')
  writeReplayModel(path.resolve(process.argv[at + 1]))
    .then(({ model, output }) => process.stdout.write(`${JSON.stringify({ output, events: model.events.length, tools: model.tools.length, apiRequests: model.apiRequests.length }, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
