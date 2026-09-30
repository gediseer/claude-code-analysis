#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { auditCoverage } from './coverage-auditor.mjs'
import { ensureDir, writeJson, writeText } from './lib.mjs'

async function makeRun() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-coverage-'))
  await Promise.all([
    ensureDir(path.join(root, '00-task')),
    ensureDir(path.join(root, '01-live-stream')),
    ensureDir(path.join(root, '02-session')),
    ensureDir(path.join(root, '03-workspace', 'before')),
    ensureDir(path.join(root, '04-readable')),
    ensureDir(path.join(root, '05-api', 'request-0001')),
  ])
  await writeText(path.join(root, '00-task', 'command.txt'), 'claude ...\n')
  await writeText(path.join(root, '00-task', 'task.md'), 'read')
  await writeText(path.join(root, '00-task', 'original-query.md'), 'read')
  await writeJson(path.join(root, '00-task', 'input-provenance.json'), {
    schemaVersion: 3,
    original: { available: true, text: 'read' },
    launchPrompt: { text: 'read', source: 'observer-stdin-utf8', transport: 'stdin' },
    childPrompt: { text: 'read' },
    compiled: { legacy: true, used: false, text: null },
  })
  await writeJson(path.join(root, '00-task', 'run-config.json'), {
    command: 'claude',
    observer: { version: 4, recordingProxyExpected: true },
    case: { workspace: 'fixture', tools: ['Read'] },
  })
  await writeJson(path.join(root, '00-task', 'routing-fidelity.json'), {
    status: 'ROUTING_FIDELITY_VERIFIED',
    validForRoutedExperiment: true,
  })
  await writeJson(path.join(root, '00-task', 'process-result.json'), { code: 0, timedOut: false })
  await writeText(path.join(root, '01-live-stream', 'debug.log'), 'tool_dispatch_start tool=Read toolUseId=call_1 permissionDecisionMs=1\ntool_dispatch_end tool=Read toolUseId=call_1 outcome=ok durationMs=2\n')
  const stream = [
    { type: 'system', subtype: 'init', tools: ['Read'] },
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] } },
    { type: 'result', subtype: 'success', stop_reason: 'end_turn', permission_denials: [] },
  ]
  await writeText(path.join(root, '01-live-stream', 'stdout.stream.jsonl'), `${stream.map(JSON.stringify).join('\n')}\n`)
  const transcript = [
    { type: 'queue-operation', operation: 'enqueue' },
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'read' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'x' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] } },
  ]
  await writeText(path.join(root, '02-session', 'transcript.visible.jsonl'), `${transcript.map(JSON.stringify).join('\n')}\n`)
  await writeJson(path.join(root, '02-session', 'missing-artifacts.json'), [])
  await writeText(path.join(root, '03-workspace', 'test-output.txt'), 'none\n')
  await writeText(path.join(root, '03-workspace', 'changes.diff'), '')
  await writeJson(path.join(root, '05-api', 'request-0001', 'request-metadata.json'), {
    method: 'POST',
    incomingPath: '/api/anthropic/v1/messages',
  })
  const fullRequest = { model: 'test', system: [{ type: 'text', text: 'system' }], messages: [{ role: 'user', content: 'read' }], tools: [{ name: 'Read' }] }
  const fullRequestText = JSON.stringify(fullRequest)
  await writeText(path.join(root, '05-api', 'request-0001', 'request.raw'), fullRequestText)
  await writeJson(path.join(root, '05-api', 'request-0001', 'request.parsed.json'), fullRequest)
  await writeJson(path.join(root, '05-api', 'request-0001', 'request.observable.json'), {
    body: { model: 'test', system: { hiddenDefaultSystemPrompt: { omitted: true } }, messages: [{ role: 'user', content: 'read' }], tools: [{ name: 'Read' }] },
  })
  await writeText(path.join(root, '05-api', 'request-0001', 'response.raw'), 'data: {}\n\n')
  await writeJson(path.join(root, '05-api', 'request-0001', 'summary.json'), { requestId: 'request-0001' })
  await writeText(path.join(root, '05-api', 'requests.jsonl'), `${JSON.stringify({ requestId: 'request-0001' })}\n`)
  return root
}

test('coverage auditor marks core observed path captured and unused features not triggered', async () => {
  const runDir = await makeRun()
  const report = await auditCoverage({ runDir })
  const byId = Object.fromEntries(report.points.map(point => [point.id, point]))
  assert.equal(byId.INPUT_TASK.status, 'CAPTURED')
  assert.equal(byId.API_REQUEST.status, 'CAPTURED')
  assert.equal(byId.API_RESPONSE_STREAM.status, 'CAPTURED')
  assert.equal(byId.TOOL_USE.status, 'CAPTURED')
  assert.equal(byId.TOOL_RESULT.status, 'CAPTURED')
  assert.equal(byId.SUBAGENT_SPAWN.status, 'NOT_TRIGGERED')
  assert.equal(byId.COMPACT_TRIGGER.status, 'NOT_TRIGGERED')
  assert.equal(byId.PRIVATE_CHAIN_OF_THOUGHT.status, 'NOT_EXPOSED')
  assert.equal(byId.QUERY_TURN.status, 'DERIVED')
  assert.equal(byId.QUERY_TRANSITION.status, 'DERIVED')
  assert.equal(report.summary.invariantFailures, 0)
  const routingInvariant = report.invariants.find(invariant => invariant.id === 'ROUTING_FIDELITY_VERIFIED')
  assert.equal(routingInvariant.passed, true)
  await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test('coverage auditor fails routing invariant when port 23333 invalidates the experiment', async () => {
  const runDir = await makeRun()
  await writeJson(path.join(runDir, '00-task', 'routing-fidelity.json'), {
    status: 'ROUTING_FIDELITY_FAILED',
    validForRoutedExperiment: false,
    invalidReason: 'Observed the Claude Code process tree connecting to forbidden local port 23333.',
  })
  const report = await auditCoverage({ runDir })
  const routingInvariant = report.invariants.find(invariant => invariant.id === 'ROUTING_FIDELITY_VERIFIED')
  assert.equal(routingInvariant.passed, false)
  assert.match(routingInvariant.details, /23333/)
  assert.equal(report.summary.invariantFailures, 1)
  await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
