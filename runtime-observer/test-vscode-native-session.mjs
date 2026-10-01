#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isPrimaryNativeClaudeLaunch } from './run-native-vscode-session.mjs'
import {
  codeLaunchArgs,
  codePromptArgs,
  exactPromptUriRecord,
  findInstalledExtension,
  launchNativeVsCode,
  observerPromptUri,
  prepareNativeVsCodeProfile,
} from './vscode-native-session.mjs'
import {
  candidateSessionIdsFromLedger,
  filterLedgerRowsAfter,
  sameWorkspacePath,
  waitForNativeSessionIdle,
} from './vscode-session-correlator.mjs'
import {
  PARITY_FAILED,
  PARITY_UNVERIFIED,
  classifyCapturedNativeRequest,
  finalizeParityManifest,
  initialParityManifest,
  inspectLaunchArguments,
} from './vscode-parity.mjs'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

test('official Claude VS Code URI preserves the exact Unicode prompt as a prefill', () => {
  const prompt = '  原样 👩🏽‍💻\n第二行 é ≠ é\n尾部空格  '
  const uri = observerPromptUri(prompt)
  const parsed = new URL(uri)
  assert.equal(parsed.protocol, 'vscode:')
  assert.equal(parsed.host, 'anthropic.claude-code')
  assert.equal(parsed.pathname, '/open')
  assert.equal(parsed.searchParams.get('prompt'), prompt)
  const record = exactPromptUriRecord(prompt)
  assert.equal(record.behavior, 'prefill-only-user-submits')
  assert.equal(record.promptSha256, sha256(prompt))
  assert.equal(record.promptBytes, Buffer.byteLength(prompt, 'utf8'))
})

test('native launch args use isolated visible VS Code and no Claude behavior flags', () => {
  const profile = {
    userDataDir: 'E:/observer/user-data',
    extensionsDir: 'C:/Users/test/.vscode/extensions',
    workspace: 'E:/repo',
  }
  const args = codeLaunchArgs({ profile, prompt: 'hello' })
  assert.deepEqual(args.slice(0, 4), [
    '--user-data-dir',
    profile.userDataDir,
    '--extensions-dir',
    profile.extensionsDir,
  ])
  assert.ok(args.includes('--new-window'))
  assert.equal(args.includes('--reuse-window'), false)
  assert.equal(inspectLaunchArguments(args).valid, true)
  assert.ok(args.at(-1).startsWith('vscode://anthropic.claude-code/open?'))
  const workspaceOnly = codeLaunchArgs({ profile, prompt: 'hello', includePrompt: false })
  assert.equal(workspaceOnly.at(-1), profile.workspace)
  const promptArgs = codePromptArgs({ profile, prompt: 'hello' })
  assert.ok(promptArgs.includes('--reuse-window'))
  assert.ok(promptArgs.includes('--open-url'))
  assert.ok(promptArgs.at(-1).startsWith('vscode://anthropic.claude-code/open?'))
})

test('native launcher removes inherited VS Code CLI-only environment', async () => {
  const observed = []
  const fakeChild = { pid: 42, unref() {} }
  await launchNativeVsCode({
    codeCommand: 'code.cmd',
    profile: {
      userDataDir: 'E:/observer/user-data',
      extensionsDir: 'C:/Users/test/.vscode/extensions',
      workspace: 'E:/repo',
      claudeConfigDir: 'C:/Users/test/.claude',
      endpoint: 'http://127.0.0.1:33333/api/anthropic',
      rootDir: 'E:/observer',
      captureRoot: 'E:/observer/capture',
      wrapperExecutable: null,
    },
    prompt: 'hello',
    environment: {
      ELECTRON_RUN_AS_NODE: '1',
      VSCODE_CWD: 'E:/repo',
      KEEP_ME: 'yes',
    },
    spawnImpl(command, args, options) {
      observed.push({ command, args, options })
      return fakeChild
    },
    waitForObserverReadyImpl: async () => ({ serviceId: 'agent-maestro-observer' }),
  })
  assert.equal(observed.length, 2)
  assert.equal(observed[0].options.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(observed[0].options.env.VSCODE_CWD, undefined)
  assert.equal(observed[0].options.env.KEEP_ME, 'yes')
  assert.equal(observed[0].options.env.AGENT_MAESTRO_OBSERVER_HOST, '1')
  assert.equal(observed[0].options.env.AGENT_MAESTRO_OBSERVER_CAPTURE_ROOT, 'E:/observer/capture')
  assert.equal(observed[0].args.some(arg => arg.startsWith('vscode://')), false)
  assert.equal(observed[1].args.some(arg => arg.includes('--reuse-window')), true)
  assert.equal(observed[1].args.at(-1).startsWith('vscode://anthropic.claude-code/open?'), true)
  if (process.platform === 'win32') {
    assert.equal(observed[0].command.toLowerCase(), (process.env.ComSpec || 'cmd.exe').toLowerCase())
    assert.deepEqual(observed[0].args.slice(0, 4), ['/d', '/c', 'call', 'code.cmd'])
    assert.equal(observed[0].options.shell, false)
  }
})

test('primary native Claude launch excludes auth helper processes', () => {
  assert.equal(isPrimaryNativeClaudeLaunch({ args: ['auth', 'status', '--json'] }), false)
  assert.equal(isPrimaryNativeClaudeLaunch({
    args: ['--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-mode', 'default'],
  }), true)
})

test('active extension registry accepts VS Code URI path locations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-extension-registry-'))
  const active = path.join(root, 'anthropic.claude-code-2.0.0')
  const stale = path.join(root, 'anthropic.claude-code-1.0.0')
  await Promise.all([
    mkdir(active, { recursive: true }),
    mkdir(stale, { recursive: true }),
  ])
  await Promise.all([
    writeFile(path.join(active, 'package.json'), JSON.stringify({ publisher: 'anthropic', name: 'claude-code', version: '2.0.0' })),
    writeFile(path.join(stale, 'package.json'), JSON.stringify({ publisher: 'anthropic', name: 'claude-code', version: '1.0.0' })),
    writeFile(path.join(root, 'extensions.json'), JSON.stringify([{
      identifier: { id: 'anthropic.claude-code' },
      location: { path: `/${active.replaceAll('\\', '/')}` },
    }])),
  ])
  const selected = await findInstalledExtension(root, 'anthropic.claude-code')
  assert.equal(selected.version, '2.0.0')
  assert.equal(path.resolve(selected.directory), path.resolve(active))
  await rm(root, { recursive: true, force: true })
})

test('native request assessment rejects Agent SDK identity and missing default tools', () => {
  const valid = {
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." }],
    tools: ['Bash', 'Edit', 'Read', 'Agent'].map(name => ({ name })),
  }
  assert.equal(classifyCapturedNativeRequest(valid).valid, true)
  const invalid = {
    system: [{ type: 'text', text: 'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.' }],
    tools: [{ name: 'Read' }],
  }
  const assessment = classifyCapturedNativeRequest(invalid)
  assert.equal(assessment.valid, false)
  assert.equal(assessment.headlessPrefix, true)
  assert.deepEqual(assessment.missingTools, ['Bash', 'Edit', 'Agent'])
})

test('workspace comparison is case-insensitive on Windows only', () => {
  assert.equal(sameWorkspacePath('E:\\repo\\PhoneInput', 'e:\\repo\\PhoneInput', 'win32'), true)
  assert.equal(sameWorkspacePath('/Repo/PhoneInput', '/repo/PhoneInput', 'linux'), false)
})

test('native idle detection uses the live session registry on current Claude Code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-native-idle-'))
  const configDir = path.join(root, 'claude')
  const userDataDir = path.join(root, 'code')
  const sessionId = '1c1f99ff-d40c-41d1-a4db-bfb0f49b94c2'
  await mkdir(path.join(configDir, 'sessions'), { recursive: true })
  await writeFile(path.join(configDir, 'sessions', '123.json'), JSON.stringify({
    sessionId,
    status: 'idle',
    statusUpdatedAt: Date.now(),
  }))
  const result = await waitForNativeSessionIdle({
    userDataDir,
    configDir,
    sessionId,
    runningEvidence: true,
    timeoutMs: 500,
    pollMs: 10,
  })
  assert.deepEqual(result.states.map(row => row.state), ['running', 'idle'])
  await rm(root, { recursive: true, force: true })
})

test('ledger correlation handles accepted and terminal summary rows after the launch boundary', () => {
  const sessionId = '1c1f99ff-d40c-41d1-a4db-bfb0f49b94c2'
  const rows = [
    { event: 'accepted', acceptedAt: '2026-09-30T01:00:00.000Z', classification: { kind: 'session', sessionId } },
    { event: 'terminal', summary: { acceptedAt: '2026-09-30T01:00:00.000Z', classification: { kind: 'session', sessionId } } },
  ]
  assert.deepEqual(candidateSessionIdsFromLedger(rows), [sessionId])
  assert.equal(filterLedgerRowsAfter(rows, '2026-09-30T01:00:00.001Z').length, 0)
})

test('parity manifest fails behavior-changing controls and remains unverified before runtime evidence', () => {
  const invalid = initialParityManifest({
    runId: 'test',
    workspace: 'E:/repo',
    promptSha256: 'abc',
    endpoint: 'http://127.0.0.1:33333/api/anthropic',
    launchArgs: ['--dangerously-skip-permissions'],
  })
  assert.equal(invalid.status, PARITY_FAILED)
  const pending = initialParityManifest({
    runId: 'test',
    workspace: 'E:/repo',
    promptSha256: 'abc',
    endpoint: 'http://127.0.0.1:33333/api/anthropic',
    launchArgs: [],
  })
  assert.equal(pending.status, PARITY_UNVERIFIED)
  const failed = finalizeParityManifest(pending, {
    sessionId: '1c1f99ff-d40c-41d1-a4db-bfb0f49b94c2',
    transcriptEntrypoint: 'sdk-cli',
    requestAssessment: { valid: false },
    routingFidelity: { status: 'ROUTING_FIDELITY_FAILED', validForRoutedExperiment: false },
    promptFidelity: { mode: 'verbatim', validForPromptBehaviorResearch: true },
    permissionMode: 'default',
  })
  assert.equal(failed.status, PARITY_FAILED)
  const autoFailed = finalizeParityManifest(pending, {
    sessionId: '1c1f99ff-d40c-41d1-a4db-bfb0f49b94c2',
    transcriptEntrypoint: 'claude-vscode',
    requestAssessment: { valid: true },
    routingFidelity: { status: 'ROUTING_FIDELITY_VERIFIED', validForRoutedExperiment: true },
    promptFidelity: { mode: 'verbatim', validForPromptBehaviorResearch: true },
    permissionMode: 'auto',
  })
  assert.equal(autoFailed.status, PARITY_FAILED)
})

test('profile preparation shares baseline Claude behavior without copying credentials and pins Manual UI', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-native-profile-'))
  const baselineUserData = path.join(root, 'baseline-code')
  const baselineClaude = path.join(root, 'baseline-claude')
  const extensions = path.join(root, 'extensions')
  const captureRoot = path.join(root, 'capture')
  const observerRoot = path.join(root, 'observer')
  await Promise.all([
    mkdir(path.join(baselineUserData, 'User'), { recursive: true }),
    mkdir(baselineClaude, { recursive: true }),
  ])
  await writeFile(`${baselineClaude}.json`, JSON.stringify({ trusted: true }))
  await Promise.all([
    writeFile(path.join(baselineUserData, 'User', 'settings.json'), JSON.stringify({
      'editor.minimap.enabled': false,
      'claudeCode.environmentVariables': [{ name: 'SECRET_TOKEN', value: 'do-not-copy' }],
      'claudeCode.claudeProcessWrapper': 'C:/wrong.exe',
    })),
    writeFile(path.join(baselineClaude, 'settings.json'), JSON.stringify({
      permissions: { defaultMode: 'bypassPermissions', allow: ['Read'] },
      hooks: { Stop: [] },
      env: { ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_MODEL: 'same-model' },
    })),
  ])
  for (const [directoryName, publisher, name] of [
    ['anthropic.claude-code-1.0.0', 'anthropic', 'claude-code'],
    ['joouis.agent-maestro-1.0.0', 'joouis', 'agent-maestro'],
    ['local-observer.agent-maestro-observer-1.0.0', 'local-observer', 'agent-maestro-observer'],
  ]) {
    const directory = path.join(extensions, directoryName)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ publisher, name, version: '1.0.0', main: './extension.js' }))
    await writeFile(path.join(directory, 'extension.js'), 'module.exports = {}')
    if (name === 'claude-code') {
      await mkdir(path.join(directory, 'resources', 'native-binary'), { recursive: true })
      await writeFile(path.join(directory, 'resources', 'native-binary', 'claude.exe'), 'fake')
    }
  }
  const profile = await prepareNativeVsCodeProfile({
    rootDir: observerRoot,
    workspace: root,
    captureRoot,
    baselineUserDataDir: baselineUserData,
    baselineClaudeConfigDir: baselineClaude,
    extensionsDir: extensions,
  })
  const vscodeSettings = JSON.parse(await readFile(path.join(profile.userDataDir, 'User', 'settings.json'), 'utf8'))
  const claudeSettings = JSON.parse(await readFile(path.join(baselineClaude, 'settings.json'), 'utf8'))
  assert.equal(vscodeSettings['claudeCode.initialPermissionMode'], 'default')
  assert.equal(vscodeSettings['claudeCode.allowDangerouslySkipPermissions'], false)
  assert.equal(vscodeSettings['claudeCode.claudeProcessWrapper'], undefined)
  assert.equal(vscodeSettings['claudeCode.environmentVariables'].some(item => item.name === 'SECRET_TOKEN'), false)
  assert.equal(vscodeSettings['claudeCode.environmentVariables'].some(item => item.name === 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'), false)
  assert.deepEqual(JSON.parse(await readFile(profile.routingSettingsPath, 'utf8')), {
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:33333/api/anthropic' },
  })
  assert.deepEqual(claudeSettings.env, { ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_MODEL: 'same-model' })
  assert.equal(claudeSettings.permissions.defaultMode, 'bypassPermissions')
  assert.deepEqual(claudeSettings.permissions.allow, ['Read'])
  assert.deepEqual(claudeSettings.hooks, { Stop: [] })
  assert.equal(profile.claudeConfigDir, baselineClaude)
  assert.equal(profile.sharedClaudeConfig, true)
  assert.deepEqual(JSON.parse(await readFile(`${profile.claudeConfigDir}.json`, 'utf8')), { trusted: true })
  await rm(root, { recursive: true, force: true })
})
