#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, observerDir, writeJson } from './lib.mjs'
import { buildReplayModel } from './replay-model.mjs'

function escapeJsonForScript(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029')
}

export async function buildRuntimeDashboard(runDir) {
  runDir = path.resolve(runDir)
  const model = await buildReplayModel(runDir)
  const dashboardDir = path.join(observerDir, 'dashboard')
  const [template, styles, app] = await Promise.all([
    readFile(path.join(dashboardDir, 'template.html'), 'utf8'),
    readFile(path.join(dashboardDir, 'styles.css'), 'utf8'),
    readFile(path.join(dashboardDir, 'app.js'), 'utf8'),
  ])
  const parityPath = path.join(runDir, '00-task', 'parity-manifest.json')
  const parity = (await exists(parityPath))
    ? JSON.parse(await readFile(parityPath, 'utf8'))
    : {
        status: model.run.captureProfile?.startsWith('legacy-headless')
          ? 'LEGACY_HEADLESS_NONPARITY'
          : 'PARITY_UNVERIFIED',
        failures: [],
        declaredDifferences: [],
      }
  const pageModel = {
    run: {
      id: model.run.id,
      sessionId: model.run.sessionId,
      task: model.run.task,
      routingFidelity: model.run.routingFidelity,
      captureProfile: model.run.captureProfile,
    },
    parity,
    promptFidelity: model.input?.promptFidelity || null,
    httpExchanges: model.httpExchanges || [],
  }
  const data = escapeJsonForScript(pageModel)
  const html = template
    .replace('/*__STYLES__*/', styles)
    .replace('/*__DATA__*/', data)
    .replace('/*__APP__*/', app)
  const placeholderCounts = Object.fromEntries(['STYLES', 'DATA', 'APP'].map(name => [
    name,
    template.split(`/*__${name}__*/`).length - 1,
  ]))
  if (Object.values(placeholderCounts).some(count => count !== 1)) {
    throw new Error(`Dashboard template placeholders must each occur once: ${JSON.stringify(placeholderCounts)}`)
  }
  const modelPath = path.join(runDir, '04-readable', 'replay-model.json')
  const htmlPath = path.join(runDir, 'legacy-run-dashboard.html')
  await writeJson(modelPath, model)
  await writeFile(htmlPath, html, 'utf8')
  return {
    model,
    pageModel,
    modelPath,
    htmlPath,
    htmlBytes: Buffer.byteLength(html),
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const at = process.argv.indexOf('--run-dir')
  buildRuntimeDashboard(path.resolve(process.argv[at + 1]))
    .then(result => process.stdout.write(`${JSON.stringify({ htmlPath: result.htmlPath, modelPath: result.modelPath, htmlBytes: result.htmlBytes, events: result.model.events.length }, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
