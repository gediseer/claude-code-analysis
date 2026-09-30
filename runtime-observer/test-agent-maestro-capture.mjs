#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  AgentMaestroCaptureImportError,
  importAgentMaestroCapture,
} from './agent-maestro-capture.mjs'
import { ensureDir, exists, manifestForTree, writeJson } from './lib.mjs'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function makeFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'cc-agent-maestro-import-'))
  return {
    parent,
    captureRoot: path.join(parent, 'capture'),
    runDir: path.join(parent, 'run.building'),
  }
}

async function writeJsonl(filePath, values) {
  await writeFile(filePath, `${values.map(value => JSON.stringify(value)).join('\n')}\n`, 'utf8')
}

async function createExchange(captureRoot, {
  sessionId = 'session-exact',
  exchangeId = '0000000001',
  headerSessionId = sessionId,
  bodySessionId = sessionId,
  pathName = '/api/anthropic/v1/messages',
  responseStatus = 200,
  responseRaw = Buffer.from('event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'),
  vscodeRequests = [{ sequence: 0, timestamp: '2026-09-27T00:00:00.010Z', request: { requestedModelId: 'claude-test' } }],
  vscodeTokenCounts = [{ sequence: 0, timestamp: '2026-09-27T00:00:00.020Z', call: { purpose: 'input', value: 'exact' } }],
  vscodeEvents = [{ sequence: 0, timestamp: '2026-09-27T00:00:00.030Z', part: { type: 'text', value: 'ok' } }],
  state = 'completed',
  captureError = false,
  mutateSummary = summary => summary,
} = {}) {
  const exchangeDir = path.join(captureRoot, 'sessions', sessionId, 'exchanges', exchangeId)
  await ensureDir(exchangeDir)
  const requestValue = {
    model: 'claude-test',
    metadata: { user_id: JSON.stringify({ session_id: bodySessionId }) },
    messages: [{ role: 'user', content: '  exact prompt  ' }],
  }
  const requestRaw = Buffer.from(`${JSON.stringify(requestValue)}  `)
  const requestHeaders = {
    'content-type': 'application/json; charset=utf-8',
    authorization: '[FORWARDED_NOT_RECORDED]',
    'x-api-key': '[FORWARDED_NOT_RECORDED]',
    'x-claude-code-session-id': headerSessionId,
    'x-visible': 'kept',
  }
  const responseHeaders = { 'content-type': 'text/event-stream' }
  await Promise.all([
    writeFile(path.join(exchangeDir, '01-client-request.raw'), requestRaw),
    writeJson(path.join(exchangeDir, '01-client-request.headers.redacted.json'), requestHeaders),
    writeJson(path.join(exchangeDir, '02-client-request.parsed.json'), requestValue),
    writeFile(path.join(exchangeDir, '05-client-response.raw'), responseRaw),
    writeJson(path.join(exchangeDir, '05-client-response.headers.redacted.json'), responseHeaders),
    writeJsonl(path.join(exchangeDir, '03-vscode-lm-requests.jsonl'), vscodeRequests),
    writeJsonl(path.join(exchangeDir, '03-vscode-lm-token-counts.jsonl'), vscodeTokenCounts),
    writeJsonl(path.join(exchangeDir, '04-vscode-lm-events.jsonl'), vscodeEvents),
  ])
  const sequence = Number(exchangeId)
  const summary = mutateSummary({
    globalSequence: sequence,
    exchangeId,
    classification: {
      kind: 'session',
      sessionId,
      evidence: headerSessionId && bodySessionId ? 'header+body' : headerSessionId ? 'header' : 'body',
    },
    method: 'POST',
    path: pathName,
    acceptedAt: '2026-09-27T00:00:00.000Z',
    requestBytes: requestRaw.length,
    requestSha256: sha256(requestRaw),
    responseStatus,
    responseBytes: responseRaw.length,
    responseSha256: sha256(responseRaw),
    vscodeLmRequestCount: vscodeRequests.length,
    vscodeLmEventCount: vscodeEvents.length,
    vscodeLmTokenCountCallCount: vscodeTokenCounts.length,
    completedAt: '2026-09-27T00:00:01.000Z',
    state,
  })
  if (captureError) {
    await writeJson(path.join(exchangeDir, 'capture-error.json'), { ...summary, state: 'capture-error', error: 'fixture failure' })
  } else if (state) {
    await writeJson(path.join(exchangeDir, 'summary.json'), summary)
  }
  return { exchangeDir, requestRaw, responseRaw, summary }
}

async function importFixture(fixture, overrides = {}) {
  await ensureDir(fixture.runDir)
  return importAgentMaestroCapture({
    captureRoot: fixture.captureRoot,
    sessionId: 'session-exact',
    runDir: fixture.runDir,
    settleTimeoutMs: 0,
    settleQuietMs: 0,
    settlePollMs: 1,
    ...overrides,
  })
}

async function assertRejected(promise, pattern) {
  let caught
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof AgentMaestroCaptureImportError)
  assert.match(caught.message + JSON.stringify(caught.report), pattern)
  return caught
}

test('imports only the exact child session into canonical 05-api folders without changing source evidence', async () => {
  const fixture = await makeFixture()
  try {
    const later = await createExchange(fixture.captureRoot, { exchangeId: '0000000007' })
    const earlier = await createExchange(fixture.captureRoot, {
      exchangeId: '0000000002',
      pathName: '/api/anthropic/v1/messages/count_tokens',
      responseRaw: Buffer.from('{"input_tokens":42}\n'),
    })
    await createExchange(fixture.captureRoot, { sessionId: 'another-session', exchangeId: '0000000003' })
    await ensureDir(path.join(fixture.captureRoot, '_unknown', 'conflict', 'exchanges', '0000000004'))
    const sourceBefore = await manifestForTree(fixture.captureRoot)

    const report = await importFixture(fixture)

    assert.equal(report.status, 'imported')
    assert.equal(report.validForApiEvidence, true)
    assert.equal(report.exchanges, 2)
    assert.deepEqual(report.mappings.map(value => value.sourceExchangeId), ['0000000002', '0000000007'])
    assert.equal(await exists(path.join(fixture.runDir, '05-api', 'request-0003')), false)

    const first = path.join(fixture.runDir, '05-api', 'request-0001')
    const second = path.join(fixture.runDir, '05-api', 'request-0002')
    assert.deepEqual(await readFile(path.join(first, 'request.raw')), earlier.requestRaw)
    assert.deepEqual(await readFile(path.join(first, 'response.raw')), earlier.responseRaw)
    assert.deepEqual(await readFile(path.join(second, 'request.raw')), later.requestRaw)
    assert.deepEqual(
      await readFile(path.join(second, 'request.parsed.json')),
      await readFile(path.join(later.exchangeDir, '02-client-request.parsed.json')),
    )
    assert.deepEqual(
      await readFile(path.join(second, 'agent-maestro-original', 'summary.json')),
      await readFile(path.join(later.exchangeDir, 'summary.json')),
    )
    assert.deepEqual(
      await readFile(path.join(second, 'vscode-lm-requests.jsonl')),
      await readFile(path.join(later.exchangeDir, '03-vscode-lm-requests.jsonl')),
    )
    assert.deepEqual(
      await readFile(path.join(second, 'vscode-lm-events.jsonl')),
      await readFile(path.join(later.exchangeDir, '04-vscode-lm-events.jsonl')),
    )
    assert.deepEqual(
      await readFile(path.join(second, 'vscode-lm-token-counts.jsonl')),
      await readFile(path.join(later.exchangeDir, '03-vscode-lm-token-counts.jsonl')),
    )

    const metadata = JSON.parse(await readFile(path.join(second, 'request-metadata.json'), 'utf8'))
    const summary = JSON.parse(await readFile(path.join(second, 'summary.json'), 'utf8'))
    const provenance = JSON.parse(await readFile(path.join(second, 'capture-provenance.json'), 'utf8'))
    assert.equal(metadata.captureSource, 'agent-maestro-direct')
    assert.equal(metadata.bodySha256, sha256(later.requestRaw))
    assert.equal(metadata.headers.authorization, '[FORWARDED_NOT_RECORDED]')
    assert.equal(summary.requestSha256, sha256(later.requestRaw))
    assert.equal(summary.responseSha256, sha256(later.responseRaw))
    assert.equal(summary.vscodeLmRequestCount, 1)
    assert.equal(summary.vscodeLmEventCount, 1)
    assert.equal(summary.vscodeLmTokenCountCallCount, 1)
    assert.equal(provenance.source, 'sessions/session-exact/exchanges/0000000007')

    const index = (await readFile(path.join(fixture.runDir, '05-api', 'requests.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map(JSON.parse)
    assert.deepEqual(index.map(value => value.requestId), ['request-0001', 'request-0002'])
    assert.deepEqual(await manifestForTree(fixture.captureRoot), sourceBefore)
  } finally {
    await rm(fixture.parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('classifies a missing exact-session capture as unavailable without guessing another session', async () => {
  const fixture = await makeFixture()
  try {
    await createExchange(fixture.captureRoot, { sessionId: 'similar-session', exchangeId: '0000000001' })
    const report = await importFixture(fixture)
    assert.equal(report.status, 'unavailable')
    assert.equal(report.validForApiEvidence, false)
    assert.equal(report.reason, 'exact-session-exchanges-directory-not-found')
    assert.deepEqual(report.inferenceFallbacks, [])
    assert.equal(await exists(path.join(fixture.runDir, '05-api')), false)
  } finally {
    await rm(fixture.parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('rejects destination conflicts before importing any capture', async () => {
  const fixture = await makeFixture()
  try {
    await createExchange(fixture.captureRoot)
    await ensureDir(path.join(fixture.runDir, '05-api'))
    const error = await assertRejected(importFixture(fixture), /destination already exists/)
    assert.equal(error.report.validForApiEvidence, false)
    assert.deepEqual(await readdir(path.join(fixture.runDir, '05-api')), [])
  } finally {
    await rm(fixture.parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('rejects incomplete and capture-error exchanges after the recorder settle gate', async t => {
  await t.test('incomplete exchange', async () => {
    const fixture = await makeFixture()
    try {
      const created = await createExchange(fixture.captureRoot, { state: null })
      await rm(path.join(created.exchangeDir, 'summary.json'), { force: true })
      await assertRejected(importFixture(fixture), /did not reach a terminal recorder state/)
      assert.equal(await exists(path.join(fixture.runDir, '05-api')), false)
    } finally {
      await rm(fixture.parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })

  await t.test('capture-error exchange', async () => {
    const fixture = await makeFixture()
    try {
      await createExchange(fixture.captureRoot, { state: null, captureError: true })
      await assertRejected(importFixture(fixture), /capture-error\.json/)
      assert.equal(await exists(path.join(fixture.runDir, '05-api')), false)
    } finally {
      await rm(fixture.parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })
})

test('rejects session conflicts, hash mismatches, parsed mismatches, and duplicate converted IDs', async t => {
  const cases = [
    {
      name: 'session conflict',
      pattern: /conflicting exact session IDs/,
      arrange: fixture => createExchange(fixture.captureRoot, { bodySessionId: 'different-session' }),
    },
    {
      name: 'request hash mismatch',
      pattern: /request SHA-256 mismatch/,
      arrange: fixture => createExchange(fixture.captureRoot, {
        mutateSummary: summary => ({ ...summary, requestSha256: '0'.repeat(64) }),
      }),
    },
    {
      name: 'parsed request mismatch',
      pattern: /parsed request does not match/,
      arrange: async fixture => {
        const created = await createExchange(fixture.captureRoot)
        await writeJson(path.join(created.exchangeDir, '02-client-request.parsed.json'), { different: true })
      },
    },
    {
      name: 'duplicate converted event ID',
      pattern: /duplicate sequence ID 0/,
      arrange: fixture => createExchange(fixture.captureRoot, {
        vscodeEvents: [
          { sequence: 0, part: { type: 'text', value: 'one' } },
          { sequence: 0, part: { type: 'text', value: 'two' } },
        ],
      }),
    },
    {
      name: 'converted count mismatch',
      pattern: /count mismatch/,
      arrange: fixture => createExchange(fixture.captureRoot, {
        mutateSummary: summary => ({ ...summary, vscodeLmRequestCount: summary.vscodeLmRequestCount + 1 }),
      }),
    },
  ]
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fixture = await makeFixture()
      try {
        await item.arrange(fixture)
        await assertRejected(importFixture(fixture), item.pattern)
        assert.equal(await exists(path.join(fixture.runDir, '05-api')), false)
      } finally {
        await rm(fixture.parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
    })
  }
})

test('rejects unredacted sensitive headers and unsafe non-exact session paths', async () => {
  const fixture = await makeFixture()
  try {
    const created = await createExchange(fixture.captureRoot)
    await writeJson(path.join(created.exchangeDir, '01-client-request.headers.redacted.json'), {
      authorization: 'Bearer secret',
      'x-claude-code-session-id': 'session-exact',
    })
    await assertRejected(importFixture(fixture), /unredacted sensitive header/)
    await assert.rejects(
      importFixture(fixture, { sessionId: '../session-exact' }),
      /safe literal directory segment/,
    )
  } finally {
    await rm(fixture.parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
