#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { main as requestMain } from './observe-claude-request.mjs'
import { main as skillMain } from './observe-claude-skill.mjs'
import { canonicalWorkspace, keyFor, parseArgs } from './observe-claude-coordinator.mjs'
import { sha256Text } from './prompt-fidelity.mjs'

test('coordinator CLI preserves option values without parsing raw Prompt', () => {
  assert.deepEqual(parseArgs(['start', '--request-file', 'E:/job/request.json']), {
    command: 'start',
    options: { 'request-file': 'E:/job/request.json' },
  })
})

test('job key is stable for Windows workspace case and exact Prompt hash', () => {
  const promptHash = sha256Text('  原样 👩🏽‍💻\n$ ` " 尾部  ')
  if (process.platform === 'win32') {
    assert.equal(keyFor('E:/Repo/PhoneInput', promptHash), keyFor('e:/repo/PhoneInput', promptHash))
  }
  assert.notEqual(keyFor('E:/repo/PhoneInput', promptHash), keyFor('E:/repo/PhoneInput', sha256Text('different')))
  assert.equal(canonicalWorkspace('E:/repo/PhoneInput'), canonicalWorkspace(path.resolve('E:/repo/PhoneInput')))
})

test('request envelope stores arbitrary raw Prompt exactly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'observe-claude-request-'))
  const prompt = '  原样 👩🏽‍💻\n$ARGUMENTS `ticks` "quotes"\n尾部空格  '
  const result = await requestMain([
    '--workspace', root,
    '--requests-root', root,
    '--prompt', prompt,
  ])
  const request = JSON.parse(await readFile(result.requestFile, 'utf8'))
  assert.equal(request.workspace, path.resolve(root))
  assert.equal(request.prompt, prompt)
  await rm(root, { recursive: true, force: true })
})

test('request envelope rejects empty raw Prompt', async () => {
  await assert.rejects(
    requestMain(['--prompt', '']),
    /must not be empty/,
  )
})

test('skill launcher requires a prompt file instead of shell interpolation', async () => {
  await assert.rejects(
    skillMain([]),
    /prompt-file/,
  )
})
