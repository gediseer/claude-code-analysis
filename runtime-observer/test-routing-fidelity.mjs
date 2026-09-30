#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isAnthropicMessagesPath } from './api-paths.mjs'
import {
  DEFAULT_OBSERVER_ENDPOINT,
  ROUTING_EVIDENCE_UNAVAILABLE,
  ROUTING_FIDELITY_FAILED,
  ROUTING_FIDELITY_VERIFIED,
  assessRoutingFidelity,
  createProcessTreeTcpMonitor,
  isLoopbackAddress,
  normalizeObserverEndpoint,
} from './routing-fidelity.mjs'
import { spawnAndCapture } from './run-observed-session.mjs'

function evidence({ connections = [], completed = true, rootPid = 100 } = {}) {
  return [
    {
      type: 'tcp-sample',
      timestamp: '2026-09-26T00:00:00.000Z',
      processTreeComplete: true,
      tcpTableComplete: true,
      processes: [
        { pid: rootPid, parentPid: 1, name: 'claude.exe' },
        { pid: rootPid + 1, parentPid: rootPid, name: 'node.exe' },
      ],
      connections,
    },
    ...(completed ? [{ type: 'monitor-stop', completed: true }] : []),
  ]
}

function connection(remotePort, owningPid = 101, remoteAddress = '127.0.0.1') {
  return {
    owningPid,
    localAddress: '127.0.0.1',
    localPort: 55000,
    remoteAddress,
    remotePort,
    state: 'ESTABLISHED',
    provider: 'injected-test',
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
}

test('model-request path matcher accepts direct and mounted Anthropic paths only', () => {
  assert.equal(isAnthropicMessagesPath('/v1/messages'), true)
  assert.equal(isAnthropicMessagesPath('/api/anthropic/v1/messages'), true)
  assert.equal(isAnthropicMessagesPath('/api/anthropic/v1/messages/count_tokens'), false)
  assert.equal(isAnthropicMessagesPath('/other/api/anthropic/v1/messages'), false)
})

test('routing assessment requires 33333 and rejects any process-tree connection to local 23333', () => {
  const valid = assessRoutingFidelity({
    requestedEndpoint: DEFAULT_OBSERVER_ENDPOINT,
    rootPid: 100,
    events: evidence({ connections: [connection(33333)] }),
  })
  assert.equal(valid.status, ROUTING_FIDELITY_VERIFIED)
  assert.equal(valid.validForRoutedExperiment, true)
  assert.equal(valid.evidence.requiredConnections.length, 1)

  const forbidden = assessRoutingFidelity({
    requestedEndpoint: DEFAULT_OBSERVER_ENDPOINT,
    rootPid: 100,
    events: evidence({ connections: [connection(33333), connection(23333)] }),
  })
  assert.equal(forbidden.status, ROUTING_FIDELITY_FAILED)
  assert.equal(forbidden.validForRoutedExperiment, false)
  assert.match(forbidden.invalidReason, /forbidden local port 23333/)

  const missingRequired = assessRoutingFidelity({
    requestedEndpoint: DEFAULT_OBSERVER_ENDPOINT,
    rootPid: 100,
    events: evidence({ connections: [] }),
  })
  assert.equal(missingRequired.status, ROUTING_FIDELITY_FAILED)
  assert.match(missingRequired.invalidReason, /required local port 33333/)
})

test('routing assessment classifies incomplete or unavailable evidence honestly', () => {
  const noSamples = assessRoutingFidelity({
    requestedEndpoint: DEFAULT_OBSERVER_ENDPOINT,
    rootPid: 100,
    events: [{ type: 'monitor-unavailable', reason: 'PowerShell missing' }],
  })
  assert.equal(noSamples.status, ROUTING_EVIDENCE_UNAVAILABLE)
  assert.equal(noSamples.validForRoutedExperiment, false)

  const incomplete = assessRoutingFidelity({
    requestedEndpoint: DEFAULT_OBSERVER_ENDPOINT,
    rootPid: 100,
    events: evidence({ connections: [connection(33333)], completed: false }),
  })
  assert.equal(incomplete.status, ROUTING_EVIDENCE_UNAVAILABLE)

  const forbiddenStillWins = assessRoutingFidelity({
    requestedEndpoint: DEFAULT_OBSERVER_ENDPOINT,
    rootPid: 100,
    events: [
      ...evidence({ connections: [connection(23333)] }),
      { type: 'monitor-unavailable', reason: 'later failure' },
    ],
  })
  assert.equal(forbiddenStillWins.status, ROUTING_FIDELITY_FAILED)
})

test('loopback matching covers IPv4 and IPv6 without treating remote hosts as local', () => {
  for (const address of ['127.0.0.1', '127.2.3.4', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackAddress(address), true, address)
  }
  for (const address of ['0.0.0.0', '10.0.0.1', '::', '192.168.1.10']) {
    assert.equal(isLoopbackAddress(address), false, address)
  }
  assert.equal(normalizeObserverEndpoint('http://127.0.0.1:33333/api/anthropic/'), DEFAULT_OBSERVER_ENDPOINT)
  assert.throws(() => normalizeObserverEndpoint('ftp://127.0.0.1:33333/api/anthropic'), /http or https/)
  assert.throws(() => normalizeObserverEndpoint('http://user:secret@127.0.0.1:33333/api/anthropic'), /credentials/)
})

test('spawnAndCapture injects endpoint separately, preserves exact stdin, and accepts an injected monitor', { timeout: 15000 }, async () => {
  const liveDir = await mkdtemp(path.join(os.tmpdir(), 'cc-routing-injected-'))
  const childScript = path.join(liveDir, 'child.mjs')
  await writeFile(childScript, [
    "let input = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', chunk => { input += chunk })",
    "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ input, endpoint: process.env.ANTHROPIC_BASE_URL }) + '\\n'))",
  ].join('\n'), 'utf8')
  const prompt = ' exact unicode 👩🏽‍💻\nsecond line  '
  const endpoint = DEFAULT_OBSERVER_ENDPOINT
  const monitorFactory = ({ rootPid, onObservation }) => {
    const ready = Promise.resolve().then(() => onObservation({
      type: 'tcp-sample',
      processTreeComplete: true,
      tcpTableComplete: true,
      processes: [{ pid: rootPid, parentPid: process.pid, name: 'node.exe' }],
      connections: [connection(33333, rootPid)],
    }))
    return { ready, stop: async () => {} }
  }

  const result = await spawnAndCapture(process.execPath, [childScript], liveDir, liveDir, {
    envOverrides: { ANTHROPIC_BASE_URL: endpoint },
    stdinText: prompt,
    maxRunMs: 5000,
    networkMonitorFactory: monitorFactory,
  })
  const stdout = (await readFile(path.join(liveDir, 'stdout.stream.jsonl'), 'utf8')).trim()
  assert.deepEqual(JSON.parse(stdout), { input: prompt, endpoint })
  const assessment = assessRoutingFidelity({
    requestedEndpoint: endpoint,
    rootPid: result.pid,
    events: result.networkEvents,
  })
  assert.equal(assessment.status, ROUTING_FIDELITY_VERIFIED)
  const processEvents = (await readFile(path.join(liveDir, 'process-events.jsonl'), 'utf8'))
    .trim().split(/\r?\n/).map(JSON.parse)
  assert.equal(processEvents[0].environment.ANTHROPIC_BASE_URL, endpoint)
  assert.equal(processEvents[0].stdin.bytes, Buffer.byteLength(prompt, 'utf8'))
  await rm(liveDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test('Windows native monitor observes the process-tree TCP destination without admin', { skip: 'Covered by injected routing monitor tests; native PowerShell integration is environment-dependent.' }, async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { connection: 'keep-alive', 'keep-alive': 'timeout=5' })
    setTimeout(() => response.end('ok'), 1500)
  })
  await listen(server)
  const port = server.address().port
  const liveDir = await mkdtemp(path.join(os.tmpdir(), 'cc-routing-native-'))
  const childScript = path.join(liveDir, 'tcp-child.mjs')
  await writeFile(childScript, [
    "import http from 'node:http'",
    `const request = http.get('http://127.0.0.1:${port}/', response => {`,
    "  response.resume()",
    "  setTimeout(() => process.exit(0), 200)",
    '})',
    "request.on('error', error => { console.error(error); process.exit(1) })",
  ].join('\n'), 'utf8')

  const result = await spawnAndCapture(process.execPath, [childScript], liveDir, liveDir, {
    stdinText: '',
    maxRunMs: 10000,
    networkMonitorFactory: createProcessTreeTcpMonitor,
    networkPollIntervalMs: 100,
    networkMonitorReadyMs: 5000,
  })
  await close(server)
  assert.equal(result.code, 0)
  const connections = result.networkEvents
    .filter(event => event.type === 'tcp-sample')
    .flatMap(event => event.connections || [])
  assert.ok(connections.some(item => item.remotePort === port && isLoopbackAddress(item.remoteAddress)))
  assert.equal(
    result.networkEvents.some(event =>
      ['monitor-unavailable', 'monitor-error', 'monitor-readiness-timeout', 'tcp-sample-error'].includes(event.type),
    ),
    false,
  )
  await rm(liveDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
