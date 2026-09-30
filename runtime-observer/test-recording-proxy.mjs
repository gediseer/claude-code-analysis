#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { startRecordingProxy } from './recording-proxy.mjs'
import { parseSse, summarizeSse } from './sse.mjs'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function startFakeUpstream(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/anthropic`,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  }
}

async function postStreaming(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const request = http.request(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
    }, response => {
      const chunks = []
      const times = []
      response.on('data', chunk => {
        chunks.push(chunk)
        times.push(Date.now())
      })
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks), times }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

test('recording proxy preserves path, auth forwarding, streaming bytes and hides secrets', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cc-observer-proxy-'))
  const authCanary = 'Bearer observer-secret-canary'
  const apiCanary = 'sk-ant-observer-secret-canary'
  let upstreamRequest = null
  const chunks = [
    Buffer.from('event: message_start\r\n'),
    Buffer.from('data: {"text":"你'),
    Buffer.from('好"}\r\n\r\n'),
    Buffer.from('event: message_stop\r\ndata: {}\r\n\r\n'),
  ]
  const upstream = await startFakeUpstream(async (request, response) => {
    const bodyChunks = []
    for await (const chunk of request) bodyChunks.push(chunk)
    upstreamRequest = {
      url: request.url,
      auth: request.headers.authorization,
      apiKey: request.headers['x-api-key'],
      body: Buffer.concat(bodyChunks),
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': 'req_fake_1',
      'set-cookie': 'secret-cookie=do-not-record',
    })
    for (const chunk of chunks) {
      response.write(chunk)
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    response.end()
  })
  const proxy = await startRecordingProxy({
    upstreamBaseUrl: upstream.baseUrl,
    outputDir: temp,
  })
  const requestBody = JSON.stringify({
    model: 'claude-opus-5',
    system: [{ type: 'text', text: 'hidden default prompt' }],
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  })
  const result = await postStreaming(
    `${proxy.localBaseUrl}/v1/messages?x=%2F`,
    requestBody,
    { authorization: authCanary, 'x-api-key': apiCanary },
  )
  await proxy.close()
  await upstream.close()

  const expectedResponse = Buffer.concat(chunks)
  assert.equal(result.status, 200)
  assert.equal(result.body.equals(expectedResponse), true)
  assert.equal(upstreamRequest.url, '/api/anthropic/v1/messages?x=%2F')
  assert.equal(upstreamRequest.auth, authCanary)
  assert.equal(upstreamRequest.apiKey, apiCanary)
  assert.equal(upstreamRequest.body.toString('utf8'), requestBody)
  assert.ok(result.times.length >= 2, 'client should receive multiple streamed chunks')

  const dirs = (await readdir(temp, { withFileTypes: true })).filter(entry => entry.isDirectory())
  assert.equal(dirs.length, 1)
  const requestDir = path.join(temp, dirs[0].name)
  const recordedResponse = await readFile(path.join(requestDir, 'response.raw'))
  assert.equal(recordedResponse.equals(expectedResponse), true)
  const recordedRequest = await readFile(path.join(requestDir, 'request.raw'))
  assert.equal(recordedRequest.toString('utf8'), requestBody)
  assert.equal(recordedRequest.equals(upstreamRequest.body), true)
  const parsedRequest = JSON.parse(await readFile(path.join(requestDir, 'request.parsed.json'), 'utf8'))
  assert.equal(parsedRequest.system[0].text, 'hidden default prompt')
  const metadata = JSON.parse(await readFile(path.join(requestDir, 'request-metadata.json'), 'utf8'))
  assert.equal(metadata.upstreamUrl, `${upstream.baseUrl}/v1/messages?x=%2F`)
  assert.equal(metadata.headers.authorization, '[FORWARDED_NOT_RECORDED]')
  assert.equal(metadata.headers['x-api-key'], '[FORWARDED_NOT_RECORDED]')
  assert.equal(metadata.bodySha256, sha256(Buffer.from(requestBody)))
  assert.equal(metadata.captureMode, 'full-entity-body')
  assert.equal(metadata.captureComplete, true)
  assert.equal(metadata.inspectionStatus, 'parsed-json')
  assert.equal(metadata.rawArtifact, 'request.raw')
  assert.equal(metadata.parsedArtifact, 'request.parsed.json')
  const observable = JSON.parse(await readFile(path.join(requestDir, 'request.observable.json'), 'utf8'))
  assert.equal(observable.body.system.hiddenDefaultSystemPrompt.omitted, true)
  assert.equal(observable.body.messages[0].content, 'hello')

  const allText = await Promise.all(
    (await readdir(requestDir)).map(async name => readFile(path.join(requestDir, name)).catch(() => Buffer.alloc(0))),
  )
  const combined = Buffer.concat(allText).toString('utf8')
  assert.equal(combined.includes(authCanary), false)
  assert.equal(combined.includes(apiCanary), false)
  assert.equal(combined.includes('hidden default prompt'), true)
  assert.equal(combined.includes('secret-cookie=do-not-record'), false)
  const parsedSse = parseSse(recordedResponse)
  const summarizedSse = summarizeSse(parsedSse)
  assert.equal(parsedSse.length, 2)
  assert.equal(parsedSse[0].event, 'message_start')
  assert.equal(parsedSse[0].json.text, '你好')
  assert.equal(summarizedSse.counts.message_start, 1)
  assert.equal(summarizedSse.counts.message_stop, 1)
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test('recording proxy strips a fixed Anthropic mount prefix before forwarding', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cc-proxy-mounted-'))
  let receivedPath = null
  const upstream = await startFakeUpstream((request, response) => {
    receivedPath = request.url
    request.resume()
    response.end('ok')
  })
  let proxy
  try {
    proxy = await startRecordingProxy({
      upstreamBaseUrl: upstream.baseUrl,
      outputDir: temp,
      listenPort: 33333,
    })
  } catch (error) {
    await upstream.close()
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    if (error?.code === 'EADDRINUSE') {
      t.skip('Local development observer already owns port 33333')
      return
    }
    throw error
  }
  assert.equal(proxy.childBaseUrl, 'http://127.0.0.1:33333/api/anthropic')
  await postStreaming(`${proxy.childBaseUrl}/v1/messages?beta=true`, Buffer.from('{}'), {
    'content-type': 'application/json',
  })
  await proxy.close()
  await upstream.close()
  assert.equal(receivedPath, '/api/anthropic/v1/messages?beta=true')
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test('recording proxy preserves binary non-json bodies exactly', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cc-observer-binary-'))
  let upstreamBody = null
  const upstream = await startFakeUpstream(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    upstreamBody = Buffer.concat(chunks)
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end('ok')
  })
  const proxy = await startRecordingProxy({ upstreamBaseUrl: upstream.baseUrl, outputDir: temp })
  const bytes = Buffer.from([0, 255, 128, 1, 2, 3, 250])
  await postStreaming(`${proxy.localBaseUrl}/upload`, bytes, { 'content-type': 'application/octet-stream' })
  await proxy.close()
  await upstream.close()
  const raw = await readFile(path.join(temp, 'request-0001', 'request.raw'))
  assert.equal(raw.equals(bytes), true)
  assert.equal(raw.equals(upstreamBody), true)
  const metadata = JSON.parse(await readFile(path.join(temp, 'request-0001', 'request-metadata.json'), 'utf8'))
  assert.equal(metadata.inspectionStatus, 'not-json')
  await assert.rejects(readFile(path.join(temp, 'request-0001', 'request.parsed.json')))
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test('only an exactly owned experimental system prompt can be recorded as text', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cc-observer-owned-system-'))
  const upstream = await startFakeUpstream(async (request, response) => {
    for await (const _ of request) {}
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  })
  const owned = 'experiment-owned-system'
  const proxy = await startRecordingProxy({
    upstreamBaseUrl: upstream.baseUrl,
    outputDir: temp,
    ownedSystemPrompt: owned,
  })
  await postStreaming(
    `${proxy.localBaseUrl}/v1/messages`,
    JSON.stringify({ model: 'test', system: owned, messages: [] }),
  )
  await postStreaming(
    `${proxy.localBaseUrl}/v1/messages`,
    JSON.stringify({ model: 'test', system: `${owned} plus runtime text`, messages: [] }),
  )
  await proxy.close()
  await upstream.close()
  const first = JSON.parse(await readFile(path.join(temp, 'request-0001', 'request.observable.json'), 'utf8'))
  const second = JSON.parse(await readFile(path.join(temp, 'request-0002', 'request.observable.json'), 'utf8'))
  assert.equal(first.body.system, owned)
  assert.equal(second.body.system.hiddenDefaultSystemPrompt.omitted, true)
  assert.equal(JSON.stringify(second).includes('plus runtime text'), false)
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test('recording proxy isolates concurrent requests', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cc-observer-concurrent-'))
  const upstream = await startFakeUpstream(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(body)
  })
  const proxy = await startRecordingProxy({ upstreamBaseUrl: upstream.baseUrl, outputDir: temp })
  const bodies = Array.from({ length: 20 }, (_, index) => JSON.stringify({ id: index, messages: [] }))
  const results = await Promise.all(bodies.map(body => postStreaming(`${proxy.localBaseUrl}/v1/messages`, body)))
  await proxy.close()
  await upstream.close()
  assert.deepEqual(results.map(result => result.body.toString('utf8')).sort(), [...bodies].sort())
  const dirs = (await readdir(temp, { withFileTypes: true })).filter(entry => entry.isDirectory())
  assert.equal(dirs.length, bodies.length)
  const recordedBodies = []
  for (const dir of dirs) {
    const metadata = JSON.parse(await readFile(path.join(temp, dir.name, 'request-metadata.json'), 'utf8'))
    recordedBodies.push(metadata.bodySha256)
    const raw = await readFile(path.join(temp, dir.name, 'request.raw'))
    assert.equal(metadata.bodySha256, sha256(raw))
    const parsed = JSON.parse(await readFile(path.join(temp, dir.name, 'request.parsed.json'), 'utf8'))
    assert.equal(sha256(Buffer.from(JSON.stringify(parsed))), metadata.bodySha256)
  }
  assert.deepEqual(recordedBodies.sort(), bodies.map(body => sha256(Buffer.from(body))).sort())
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
