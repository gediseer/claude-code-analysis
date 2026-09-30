#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePromptText } from './prompt-fidelity.mjs'

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

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const promptInput = typeof options['prompt-file'] === 'string'
    ? await readFile(path.resolve(options['prompt-file']), 'utf8')
    : options.prompt
  if (typeof promptInput !== 'string') throw new Error('Use --prompt-file <path> or --prompt <exact raw Prompt>.')
  const prompt = validatePromptText(promptInput)
  if (!prompt.length) throw new Error('Raw Prompt must not be empty.')
  const workspace = path.resolve(options.workspace || process.cwd())
  const requestsRoot = path.resolve(options['requests-root'] || path.join(workspace, '.claude', 'observe-claude', 'requests'))
  await mkdir(requestsRoot, { recursive: true })
  const filePath = path.join(requestsRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`)
  await writeFile(filePath, `${JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    workspace,
    prompt,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  return { requestFile: filePath }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main()
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
