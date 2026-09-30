#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ensureDir, exists, observerDir, writeJson } from './lib.mjs'
import { claudeArgs, main, sanitizedChildEnv } from './run-observed-session.mjs'
import { validatePromptText } from './prompt-fidelity.mjs'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function startFakeAnthropic() {
  const server = http.createServer(async (request, response) => {
    for await (const _ of request) {}
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_fake","type":"message","role":"assistant","content":[],"model":"fake","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"fake answer"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n'))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/api/anthropic`,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  }
}

test('legacy headless runner preserves the exact Unicode prompt while remaining explicitly nonparity', async () => {
  const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-observer-fidelity-'))
  const fixture = path.join(observerDir, 'fixtures', 'read-search')
  const prompt = '  原样 Prompt 👩🏽‍💻\n第二行 é ≠ é\n尾部空格  '
  const result = await main([
    '--legacy-headless-nonparity',
    '--workspace', fixture,
    '--prompt', prompt,
    '--original-query', prompt,
    '--endpoint', 'http://127.0.0.1:33333/api/anthropic',
    '--parent-session-id', 'parent-session',
    '--parent-message-id', 'parent-message',
    '--tools', 'Read,Grep',
    '--allowed-tools', 'Read',
    '--permission-mode', 'dontAsk',
    '--model', 'test-model',
    '--max-run-ms', '1234',
    '--max-budget-usd', '0.25',
    '--runs-root', runsRoot,
    '--run-id', 'prompt-fidelity',
    '--dry-run',
  ])
  const runDir = result.runDir
  const config = JSON.parse(await readFile(path.join(runDir, '00-task', 'run-config.json'), 'utf8'))
  const provenance = JSON.parse(await readFile(path.join(runDir, '00-task', 'input-provenance.json'), 'utf8'))
  assert.equal(config.args.includes(prompt), false)
  assert.equal(config.promptTransport.type, 'stdin')
  assert.equal(config.promptTransport.terminatorAppended, false)
  assert.equal(config.routing.requestedEndpoint, 'http://127.0.0.1:33333/api/anthropic')
  assert.equal(config.environment.ANTHROPIC_BASE_URL.source, 'observer-endpoint-control')
  assert.equal(provenance.original.text, prompt)
  assert.equal(provenance.launchPrompt.text, prompt)
  assert.equal(provenance.childPrompt.text, prompt)
  assert.equal(provenance.relation.type, 'identity-intended')
  assert.equal(provenance.promptFidelity.mode, 'evidence-unavailable')
  assert.equal(provenance.promptFidelity.validForPromptBehaviorResearch, false)
  assert.equal(provenance.compiled.legacy, true)
  assert.equal(provenance.compiled.used, false)
  assert.equal(provenance.compiled.text, null)
  assert.equal(await exists(path.join(runDir, '00-task', 'compiled-task.md')), false)
  const routing = JSON.parse(await readFile(path.join(runDir, '00-task', 'routing-fidelity.json'), 'utf8'))
  assert.equal(routing.status, 'NOT_RUN_DRY_RUN')
  assert.equal(routing.validForRoutedExperiment, false)
  assert.equal(await readFile(path.join(runDir, '00-task', 'task.md'), 'utf8'), prompt)
  assert.equal(await readFile(path.join(runDir, '00-task', 'original-query.md'), 'utf8'), prompt)
  assert.doesNotMatch(await readFile(path.join(runDir, '00-task', 'command.txt'), 'utf8'), /原样 Prompt/)
  const assessment = JSON.parse(await readFile(path.join(runDir, '00-task', 'prompt-fidelity.json'), 'utf8'))
  assert.equal(assessment.mode, 'evidence-unavailable')
  assert.equal(assessment.validForPromptBehaviorResearch, false)
  assert.ok(config.args.includes('--dangerously-skip-permissions'))
  assert.equal(config.args.includes('--permission-mode'), false)
  assert.equal(config.args.includes('--tools'), false)
  assert.equal(config.args.includes('--allowedTools'), false)
  assert.equal(config.args.includes('--disallowedTools'), false)
  assert.equal(config.args.includes('--model'), false)
  assert.equal(config.args.includes('--max-budget-usd'), false)
  assert.equal(config.args.includes('--setting-sources'), false)
  assert.doesNotMatch(prompt, /test-model|dontAsk|0\.25/)
  await rm(runsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test('runner rejects rewritten provenance and legacy prompt compilation before launch', async () => {
  const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-observer-rejected-'))
  const common = [
    '--legacy-headless-nonparity',
    '--workspace', path.join(observerDir, 'fixtures', 'read-search'),
    '--prompt', '原始',
    '--runs-root', runsRoot,
  ]
  await assert.rejects(
    main([...common, '--original-query', '改写', '--run-id', 'rewritten', '--dry-run']),
    /Prompt fidelity violation.*exactly equal/,
  )
  await assert.rejects(
    main([...common, '--task-compiler', 'observer-expander', '--run-id', 'compiled', '--dry-run']),
    /task-compiler is legacy-only/,
  )
  assert.equal(await exists(path.join(runsRoot, 'rewritten.building')), false)
  assert.equal(await exists(path.join(runsRoot, 'compiled.building')), false)
  await rm(runsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test('legacy headless claudeArgs remains isolated behind the explicit nonparity path', () => {
  const prompt = '𝄞\n combining é  '
  const args = claudeArgs({
    permissionMode: 'dontAsk',
    tools: ['Read'],
    allowedTools: ['Read'],
    disallowedTools: ['Bash'],
    model: 'test-model',
    maxBudgetUsd: 0.5,
    settingSources: ['project'],
  }, 'session', 'debug.log')
  assert.equal(args.includes(prompt), false)
  assert.ok(args.includes('--dangerously-skip-permissions'))
  assert.equal(args.includes('--permission-mode'), false)
  assert.equal(args.includes('--tools'), false)
  assert.equal(args.includes('--allowedTools'), false)
  assert.equal(args.includes('--disallowedTools'), false)
  assert.equal(args.includes('--model'), false)
  assert.equal(args.includes('--max-budget-usd'), false)
  assert.equal(args.includes('--setting-sources'), false)
  assert.throws(
    () => claudeArgs({ systemPrompt: 'hidden observer instruction' }, 'session', 'debug.log'),
    /Observer-managed system prompts.*not allowed/,
  )
  assert.throws(
    () => claudeArgs({ appendSystemPrompt: 'hidden observer instruction' }, 'session', 'debug.log'),
    /appended system prompts.*not allowed/,
  )
})

test('legacy headless dry run ignores caller controls but is not the native default', async () => {
  const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-observer-unrestricted-'))
  const result = await main([
    '--legacy-headless-nonparity',
    '--workspace', path.join(observerDir, 'fixtures', 'read-search'),
    '--prompt', 'exact prompt',
    '--tools', 'Read',
    '--allowed-tools', 'Read',
    '--disallowed-tools', 'Bash',
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'project,local',
    '--runs-root', runsRoot,
    '--run-id', 'unrestricted',
    '--dry-run',
  ])
  const config = JSON.parse(await readFile(path.join(result.runDir, '00-task', 'run-config.json'), 'utf8'))
  assert.deepEqual(config.case.tools, undefined)
  assert.deepEqual(config.case.allowedTools, undefined)
  assert.deepEqual(config.case.disallowedTools, undefined)
  assert.deepEqual(config.case.permissionMode, undefined)
  assert.equal(config.workspaceMode, 'in-place')
  assert.ok(config.args.includes('--dangerously-skip-permissions'))
  assert.equal(config.args.includes('--permission-mode'), false)
  assert.equal(config.args.includes('--tools'), false)
  assert.equal(config.args.includes('--allowedTools'), false)
  assert.equal(config.args.includes('--disallowedTools'), false)
  assert.equal(config.args.includes('--setting-sources'), false)
  await rm(runsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test('runner rejects NUL and unpaired UTF-16 before launch', async () => {
  assert.throws(() => validatePromptText('valid\u0000invalid'), /NUL/)
  assert.throws(() => validatePromptText(`high ${String.fromCharCode(0xd800)}`), /unpaired high surrogate/)
  assert.throws(() => validatePromptText(`low ${String.fromCharCode(0xdc00)}`), /unpaired low surrogate/)
  assert.equal(validatePromptText('paired 𝄞'), 'paired 𝄞')

  const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-observer-invalid-prompt-'))
  const common = [
    '--legacy-headless-nonparity',
    '--workspace', path.join(observerDir, 'fixtures', 'read-search'),
    '--runs-root', runsRoot,
    '--dry-run',
  ]
  await assert.rejects(main([...common, '--prompt', 'bad\u0000prompt', '--run-id', 'nul']), /NUL/)
  await assert.rejects(main([...common, '--prompt', String.fromCharCode(0xd800), '--run-id', 'surrogate']), /unpaired high surrogate/)
  assert.equal(await exists(path.join(runsRoot, 'nul.building')), false)
  assert.equal(await exists(path.join(runsRoot, 'surrogate.building')), false)
  await rm(runsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test('runner persists separate Agent Maestro capture controls in dry-run config', async () => {
  const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-observer-agent-maestro-control-'))
  const captureRoot = path.join(runsRoot, 'agent-maestro-capture')
  const result = await main([
    '--legacy-headless-nonparity',
    '--workspace', path.join(observerDir, 'fixtures', 'read-search'),
    '--prompt', 'exact',
    '--runs-root', runsRoot,
    '--run-id', 'capture-control',
    '--agent-maestro-capture-root', captureRoot,
    '--agent-maestro-settle-timeout-ms', '9000',
    '--agent-maestro-settle-quiet-ms', '400',
    '--agent-maestro-settle-poll-ms', '75',
    '--dry-run',
  ])
  const config = JSON.parse(await readFile(path.join(result.runDir, '00-task', 'run-config.json'), 'utf8'))
  assert.equal(config.observer.version, 6)
  assert.equal(config.observer.apiCaptureMode, 'agent-maestro-direct-import')
  assert.equal(config.observer.recordingProxyExpected, false)
  assert.equal(config.observer.agentMaestroCaptureExpected, true)
  assert.equal(config.observer.agentMaestroCaptureRoot, path.resolve(captureRoot))
  assert.deepEqual(config.observer.agentMaestroSettle, { timeoutMs: 9000, quietMs: 400, pollMs: 75 })
  await assert.rejects(
    main([
      '--legacy-headless-nonparity',
      '--workspace', path.join(observerDir, 'fixtures', 'read-search'),
      '--prompt', 'exact',
      '--runs-root', runsRoot,
      '--run-id', 'capture-conflict',
      '--agent-maestro-capture-root', captureRoot,
      '--observer-upstream', 'http://127.0.0.1:45678/api/anthropic',
      '--dry-run',
    ]),
    /Capture control conflict/,
  )
  await rm(runsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test('child environment preserves behavior-affecting variables', () => {
  const env = sanitizedChildEnv({
    KEEP_ME: 'yes',
    CLAUDE_CODE_COORDINATOR_MODE: '1',
    CLAUDE_CODE_PROACTIVE: '1',
    CLAUDE_CODE_SIMPLE: '1',
    CLAUDECODE: 'parent-runtime-marker',
  }, { ADDED: 'yes' })
  assert.equal(env.KEEP_ME, 'yes')
  assert.equal(env.ADDED, 'yes')
  assert.equal(env.CLAUDE_CODE_COORDINATOR_MODE, '1')
  assert.equal(env.CLAUDE_CODE_PROACTIVE, '1')
  assert.equal(env.CLAUDE_CODE_SIMPLE, '1')
  assert.equal(Object.hasOwn(env, 'CLAUDECODE'), false)
})

test('runner imports the exact Agent Maestro session after child exit without proxying traffic', { timeout: 30000 }, async t => {
  const native = path.join(
    path.dirname(process.execPath),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  )
  if (!(await exists(native))) {
    t.skip(`Installed Claude Code native binary not found: ${native}`)
    return
  }
  const upstream = await startFakeAnthropic()
  const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-observer-agent-maestro-e2e-runs-'))
  const captureRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-observer-agent-maestro-e2e-capture-'))
  const sessionId = randomUUID()
  const fixture = path.join(observerDir, 'fixtures', 'read-search')
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const requestRaw = Buffer.concat(chunks)
    const upstreamRequest = http.request(
      new URL(request.url || '/', upstream.baseUrl),
      { method: request.method, headers: request.headers },
      upstreamResponse => {
        const responseChunks = []
        upstreamResponse.on('data', chunk => responseChunks.push(chunk))
        upstreamResponse.on('end', async () => {
          const responseRaw = Buffer.concat(responseChunks)
          const observedSessionHeader = request.headers['x-claude-code-session-id']
          const observedSessionId = Array.isArray(observedSessionHeader)
            ? observedSessionHeader[0]
            : observedSessionHeader || sessionId
          const exchangeDir = path.join(captureRoot, 'sessions', sessionId, 'exchanges', '0000000001')
          await ensureDir(exchangeDir)
          const requestHeaders = Object.fromEntries(
            Object.entries(request.headers).map(([name, value]) => [
              name,
              /authorization|api[-_]?key|token|secret|credential|cookie/i.test(name)
                ? '[FORWARDED_NOT_RECORDED]'
                : Array.isArray(value) ? value.join(', ') : String(value),
            ]),
          )
          assert.equal(observedSessionId, sessionId)
          requestHeaders['x-claude-code-session-id'] = sessionId
          const parsedRequest = requestRaw.length ? JSON.parse(requestRaw.toString('utf8')) : null
          const artifacts = [
            writeFile(path.join(exchangeDir, '01-client-request.raw'), requestRaw),
            writeJson(path.join(exchangeDir, '01-client-request.headers.redacted.json'), requestHeaders),
            writeFile(path.join(exchangeDir, '05-client-response.raw'), responseRaw),
            writeJson(path.join(exchangeDir, '05-client-response.headers.redacted.json'), { 'content-type': 'text/event-stream' }),
            writeJson(path.join(exchangeDir, 'summary.json'), {
              globalSequence: 1,
              exchangeId: '0000000001',
              classification: { kind: 'session', sessionId, evidence: 'header+body' },
              method: request.method,
              path: request.url,
              acceptedAt: '2026-09-27T00:00:00.000Z',
              requestBytes: requestRaw.length,
              requestSha256: sha256(requestRaw),
              responseStatus: upstreamResponse.statusCode,
              responseBytes: responseRaw.length,
              responseSha256: sha256(responseRaw),
              completedAt: '2026-09-27T00:00:01.000Z',
              state: 'completed',
            }),
          ]
          if (parsedRequest !== null) {
            artifacts.push(writeJson(path.join(exchangeDir, '02-client-request.parsed.json'), parsedRequest))
          }
          await Promise.all(artifacts)
          response.writeHead(upstreamResponse.statusCode || 500, upstreamResponse.headers)
          response.end(responseRaw)
        })
      },
    )
    upstreamRequest.end(requestRaw)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(33333, '127.0.0.1', resolve)
  }).catch(error => {
    if (error?.code === 'EADDRINUSE') return null
    throw error
  })
  if (!server.listening) {
    await upstream.close()
    await rm(runsRoot, { recursive: true, force: true })
    await rm(captureRoot, { recursive: true, force: true })
    t.skip('Local Agent Maestro development observer already owns port 33333')
    return
  }
  const syntheticMonitorFactory = ({ rootPid, onObservation }) => ({
    ready: Promise.resolve().then(() => onObservation({
      type: 'tcp-sample',
      processTreeComplete: true,
      tcpTableComplete: true,
      processes: [{ pid: rootPid, parentPid: process.pid, name: 'claude.exe' }],
      connections: [{ owningPid: rootPid, localAddress: '127.0.0.1', localPort: 55000, remoteAddress: '127.0.0.1', remotePort: 33333, state: 'ESTABLISHED', provider: 'synthetic-e2e-monitor' }],
    })),
    stop: async () => {},
  })
  try {
    const result = await main([
      '--legacy-headless-nonparity',
      '--workspace', fixture,
      '--endpoint', 'http://127.0.0.1:33333/api/anthropic',
      '--agent-maestro-capture-root', captureRoot,
      '--agent-maestro-settle-timeout-ms', '5000',
      '--agent-maestro-settle-quiet-ms', '25',
      '--prompt', 'Return a fake answer without tools.',
      '--tools', '',
      '--allowed-tools', '',
      '--runs-root', runsRoot,
      '--run-id', 'agent-maestro-e2e',
      '--session-id', sessionId,
    ], { networkMonitorFactory: syntheticMonitorFactory })
    assert.equal(result.processResult.code, 0)
    assert.equal(result.agentMaestroCaptureImport.status, 'imported')
    const runDir = path.join(runsRoot, 'agent-maestro-e2e')
    const runConfig = JSON.parse(await readFile(path.join(runDir, '00-task', 'run-config.json'), 'utf8'))
    assert.equal(runConfig.observer.apiCaptureMode, 'agent-maestro-direct-import')
    assert.equal(runConfig.observer.recordingProxyExpected, false)
    assert.equal(await exists(path.join(runDir, '05-api', 'request-0001', 'request.raw')), true)
    assert.equal(await exists(path.join(runDir, '05-api', 'request-0001', 'response.raw')), true)
    assert.equal(await exists(path.join(runDir, '05-api', 'request-0001', 'agent-maestro-original', 'summary.json')), true)
    const capturedRequest = JSON.parse(
      await readFile(path.join(runDir, '05-api', 'request-0001', 'request.parsed.json'), 'utf8'),
    )
    const capturedToolNames = new Set((capturedRequest.tools || []).map(tool => tool.name))
    for (const requiredTool of ['Bash', 'Edit', 'Read', 'Agent']) {
      assert.ok(capturedToolNames.has(requiredTool), `default Claude tool missing from captured request: ${requiredTool}`)
    }
    const coverage = JSON.parse(await readFile(path.join(runDir, '04-readable', '13-CAPTURE-COVERAGE.json'), 'utf8'))
    assert.equal(coverage.summary.requiredMissing, 0)
    assert.equal(coverage.summary.invariantFailures, 0)
  } finally {
    await new Promise(resolve => server.close(() => resolve()))
    await upstream.close()
    await rm(runsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    await rm(captureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('runner records a complete independent Claude process through fake upstream', { timeout: 30000 }, async t => {
  const native = path.join(
    path.dirname(process.execPath),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  )
  if (!(await exists(native))) {
    t.skip(`Installed Claude Code native binary not found: ${native}`)
    return
  }
  const upstream = await startFakeAnthropic()
  const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'cc-observer-runner-'))
  const fixture = path.join(observerDir, 'fixtures', 'read-search')
  const originalBaseUrl = upstream.baseUrl
  const syntheticMonitorFactory = ({ rootPid, onObservation }) => {
    const ready = Promise.resolve().then(() => onObservation({
      type: 'tcp-sample',
      processTreeComplete: true,
      tcpTableComplete: true,
      processes: [{ pid: rootPid, parentPid: process.pid, name: 'claude.exe' }],
      connections: [{
        owningPid: rootPid,
        localAddress: '127.0.0.1',
        localPort: 55000,
        remoteAddress: '127.0.0.1',
        remotePort: 33333,
        state: 'ESTABLISHED',
        provider: 'synthetic-e2e-monitor',
      }],
    }))
    return { ready, stop: async () => {} }
  }
  let result
  try {
    result = await main([
      '--legacy-headless-nonparity',
      '--workspace', fixture,
      '--endpoint', 'http://127.0.0.1:33333/api/anthropic',
      '--observer-upstream', originalBaseUrl,
      '--prompt', '  Return a fake answer without tools.  ',
      '--tools', '',
      '--allowed-tools', '',
      '--max-budget-usd', '0.01',
      '--runs-root', runsRoot,
      '--run-id', 'fake-e2e',
    ], { networkMonitorFactory: syntheticMonitorFactory })
  } catch (error) {
    if (error?.cause?.code === 'EADDRINUSE' || /EADDRINUSE.*33333/s.test(error.stack || String(error))) {
      t.skip('Local development observer already owns port 33333')
      return
    }
    throw error
  } finally {
    await upstream.close()
  }
  assert.equal(result.processResult.code, 0)
  const runDir = path.join(runsRoot, 'fake-e2e')
  const coverage = JSON.parse(await readFile(path.join(runDir, '04-readable', '13-CAPTURE-COVERAGE.json'), 'utf8'))
  const fidelity = JSON.parse(await readFile(path.join(runDir, '00-task', 'prompt-fidelity.json'), 'utf8'))
  const runConfig = JSON.parse(await readFile(path.join(runDir, '00-task', 'run-config.json'), 'utf8'))
  const processEvents = (await readFile(path.join(runDir, '01-live-stream', 'process-events.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
  const promptTurns = JSON.parse(await readFile(path.join(runDir, '04-readable', '15-PROMPT-TURNS.json'), 'utf8'))
  assert.equal(coverage.summary.requiredMissing, 0)
  assert.equal(coverage.summary.invariantFailures, 0)
  assert.equal(fidelity.mode, 'verbatim')
  assert.equal(fidelity.validForPromptBehaviorResearch, true)
  assert.equal(fidelity.transcriptFirstUser.text, '  Return a fake answer without tools.  ')
  assert.equal(fidelity.apiFirstUser.text, '  Return a fake answer without tools.  ')
  assert.equal(runConfig.args.includes('  Return a fake answer without tools.  '), false)
  assert.equal(runConfig.routing.requestedEndpoint, 'http://127.0.0.1:33333/api/anthropic')
  assert.equal(processEvents[0].environment.ANTHROPIC_BASE_URL, 'http://127.0.0.1:33333/api/anthropic')
  const routing = JSON.parse(await readFile(path.join(runDir, '00-task', 'routing-fidelity.json'), 'utf8'))
  assert.equal(routing.status, 'ROUTING_FIDELITY_VERIFIED')
  assert.equal(routing.validForRoutedExperiment, true)
  assert.equal(processEvents[0].stdin.sha256, runConfig.promptTransport.sha256)
  assert.ok(promptTurns.length >= 1)
  assert.equal(await exists(path.join(runDir, '04-readable', '14-TEACHING-REPLAY.md')), true)
  assert.equal(await exists(path.join(runDir, '04-readable', '17-API-TURNS.md')), true)
  const requestDirs = await (await import('node:fs/promises')).readdir(path.join(runDir, '05-api'), { withFileTypes: true })
  const fullRequestDir = requestDirs.find(entry => entry.isDirectory() && entry.name.startsWith('request-') && entry.name !== 'request-0001')?.name || 'request-0001'
  assert.equal(await exists(path.join(runDir, '05-api', fullRequestDir, 'request.raw')), true)
  assert.equal(await exists(path.join(runDir, '05-api', fullRequestDir, 'request.parsed.json')), true)
  assert.equal(await exists(path.join(runDir, '05-api', fullRequestDir, 'response.raw')), true)
  assert.equal(await exists(path.join(runDir, '04-readable', 'replay-model.json')), true)
  const replayModel = JSON.parse(await readFile(path.join(runDir, '04-readable', 'replay-model.json'), 'utf8'))
  assert.equal(replayModel.run.routingFidelity.status, 'ROUTING_FIDELITY_VERIFIED')
  assert.equal(await exists(path.join(runDir, 'runtime-replay.html')), true)
  await rm(runsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
