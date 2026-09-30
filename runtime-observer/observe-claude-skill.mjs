#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const coordinatorPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'observe-claude-coordinator.mjs')

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) continue
    const next = argv[index + 1]
    if (next === undefined) throw new Error(`Missing value for ${value}`)
    options[value.slice(2)] = next
    index += 1
  }
  return options
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export async function runNode(args) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (code !== 0) throw new Error(stderr.trim() || `Command failed with code ${code}`)
  return JSON.parse(stdout)
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (!options['prompt-file']) throw new Error('Use --prompt-file <exact raw Prompt file>.')
  const workspace = path.resolve(options.workspace || process.cwd())
  const promptPath = path.resolve(options['prompt-file'])
  const prompt = await readFile(promptPath, 'utf8')
  if (!prompt.length) throw new Error('Raw Prompt must not be empty.')
  const requestRoot = path.join(workspace, '.claude', 'observe-claude', 'requests')
  await mkdir(requestRoot, { recursive: true })
  const requestFile = path.join(requestRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`)
  await writeFile(requestFile, `${JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    workspace,
    prompt,
    promptSha256: sha256(prompt),
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  try {
    return await runNode([coordinatorPath, 'start', '--request-file', requestFile])
  } finally {
    await rm(promptPath, { force: true })
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main()
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
