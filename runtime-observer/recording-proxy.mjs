#!/usr/bin/env node
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { appendFile, rm, writeFile } from 'node:fs/promises'
import { brotliDecompress, gunzip, inflate, zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { ensureDir, writeJson } from './lib.mjs'

const gunzipAsync = promisify(gunzip)
const inflateAsync = promisify(inflate)
const brotliDecompressAsync = promisify(brotliDecompress)
const zstdDecompressAsync = typeof zstdDecompress === 'function' ? promisify(zstdDecompress) : null

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
])

function isSensitiveHeader(name) {
  return (
    SENSITIVE_HEADERS.has(name.toLowerCase()) ||
    /(?:auth|api[-_]?key|token|secret|cookie|credential)/i.test(name)
  )
}

function headerSnapshot(headers) {
  const output = {}
  for (const [name, value] of Object.entries(headers)) {
    output[name] = isSensitiveHeader(name)
      ? '[FORWARDED_NOT_RECORDED]'
      : value
  }
  return output
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function summarizeHidden(value) {
  const serialized = JSON.stringify(value)
  return {
    omitted: true,
    bytes: Buffer.byteLength(serialized),
    sha256: sha256Buffer(Buffer.from(serialized)),
    blocks: Array.isArray(value) ? value.length : undefined,
  }
}

function containsSystemReminder(value) {
  return typeof value === 'string' && /<system-reminder(?:\s|>)/i.test(value)
}

function observableContent(value, counters) {
  if (Array.isArray(value)) return value.map(item => observableContent(item, counters))
  if (!value || typeof value !== 'object') {
    if (containsSystemReminder(value)) {
      counters.systemReminders += 1
      return { hiddenSystemReminder: summarizeHidden(value) }
    }
    return value
  }
  if (value.type === 'thinking' || value.type === 'redacted_thinking') {
    counters.thinkingBlocks += 1
    return { type: value.type, hiddenReasoning: summarizeHidden(value) }
  }
  const output = {}
  for (const [key, child] of Object.entries(value)) {
    if (/signature/i.test(key)) {
      counters.signatures += 1
      output[key] = '[SIGNATURE_NOT_RECORDED]'
    } else {
      output[key] = observableContent(child, counters)
    }
  }
  return output
}

function systemText(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null
  if (!value.every(block => block?.type === 'text' && typeof block.text === 'string')) return null
  return value.map(block => block.text).join('\n')
}

function observableRequestBody(body, { ownedSystemPrompt = null } = {}) {
  if (!body || typeof body !== 'object') return body
  const counters = { systemReminders: 0, thinkingBlocks: 0, signatures: 0 }
  const output = observableContent(body, counters)

  if (Object.hasOwn(body, 'system')) {
    const observedText = systemText(body.system)
    output.system = ownedSystemPrompt !== null && observedText === ownedSystemPrompt
      ? observableContent(body.system, counters)
      : { hiddenDefaultSystemPrompt: summarizeHidden(body.system) }
  }
  if (Array.isArray(output.messages)) {
    output.messages = output.messages.map(message => {
      if (message?.role === 'system') {
        return {
          role: 'system',
          hiddenOperatorMessage: summarizeHidden(message.content),
        }
      }
      return message
    })
  }
  return { body: output, omissions: counters }
}

function joinUpstreamPath(basePath, incomingPath, incomingBasePath = '') {
  const left = basePath === '/' ? '' : basePath.replace(/\/$/, '')
  let normalizedIncoming = incomingPath
  if (
    incomingBasePath &&
    (normalizedIncoming === incomingBasePath || normalizedIncoming.startsWith(`${incomingBasePath}/`))
  ) {
    normalizedIncoming = normalizedIncoming.slice(incomingBasePath.length) || '/'
  }
  const right = normalizedIncoming.startsWith('/') ? normalizedIncoming : `/${normalizedIncoming}`
  return `${left}${right}` || '/'
}

async function readBody(request, maxBytes) {
  const declaredLength = Number(request.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Request Content-Length exceeded observer limit (${declaredLength} > ${maxBytes} bytes)`)
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > maxBytes) {
      throw new Error(`Request body exceeded observer limit (${maxBytes} bytes)`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function jsonContentType(value) {
  const mediaType = String(value || '').split(';', 1)[0].trim().toLowerCase()
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

async function decodeContent(buffer, encodingHeader, maxDecodedBytes) {
  const encodings = String(encodingHeader || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(value => value && value !== 'identity')
  let decoded = buffer
  for (const encoding of encodings.reverse()) {
    if (encoding === 'gzip' || encoding === 'x-gzip') decoded = await gunzipAsync(decoded)
    else if (encoding === 'deflate') decoded = await inflateAsync(decoded)
    else if (encoding === 'br') decoded = await brotliDecompressAsync(decoded)
    else if (encoding === 'zstd' && zstdDecompressAsync) decoded = await zstdDecompressAsync(decoded)
    else throw new Error(`Unsupported Content-Encoding: ${encoding}`)
    if (decoded.length > maxDecodedBytes) {
      throw new Error(`Decoded request exceeded observer inspection limit (${maxDecodedBytes} bytes)`)
    }
  }
  return decoded
}

async function inspectRequestBody(bodyBuffer, headers, maxDecodedBytes) {
  const contentType = headers['content-type'] || ''
  const contentEncoding = headers['content-encoding'] || ''
  if (!bodyBuffer.length) {
    return { status: 'empty', parsedBody: null, decodedBytes: 0, contentType, contentEncoding }
  }
  if (!jsonContentType(contentType)) {
    return { status: 'not-json', parsedBody: null, decodedBytes: null, contentType, contentEncoding }
  }
  try {
    const decoded = await decodeContent(bodyBuffer, contentEncoding, maxDecodedBytes)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(decoded)
    return {
      status: 'parsed-json',
      parsedBody: JSON.parse(text),
      decodedBytes: decoded.length,
      contentType,
      contentEncoding,
    }
  } catch (error) {
    return {
      status: 'parse-error',
      parsedBody: null,
      decodedBytes: null,
      contentType,
      contentEncoding,
      error: String(error),
    }
  }
}

function requestModule(url) {
  if (url.protocol === 'http:') return http
  if (url.protocol === 'https:') return https
  throw new Error(`Unsupported upstream protocol: ${url.protocol}`)
}

export async function startRecordingProxy({
  upstreamBaseUrl,
  outputDir,
  ownedSystemPrompt = null,
  maxRequestBytes = 128 * 1024 * 1024,
  maxDecodedBytes = 256 * 1024 * 1024,
  listenPort = 0,
}) {
  if (!upstreamBaseUrl) throw new Error('upstreamBaseUrl is required')
  const upstreamBase = new URL(upstreamBaseUrl)
  const normalizedListenPort = Number(listenPort)
  if (!Number.isInteger(normalizedListenPort) || normalizedListenPort < 0 || normalizedListenPort > 65535) {
    throw new Error(`Invalid recording proxy listenPort: ${listenPort}`)
  }
  const incomingBasePath = normalizedListenPort === 33333 ? '/api/anthropic' : ''
  await ensureDir(outputDir)

  let sequence = 0
  let indexWrites = Promise.resolve()
  const active = new Set()

  async function appendIndex(entry) {
    indexWrites = indexWrites.then(() =>
      appendFile(path.join(outputDir, 'requests.jsonl'), `${JSON.stringify(entry)}\n`),
    )
    await indexWrites
  }

  const server = http.createServer((clientRequest, clientResponse) => {
    const work = (async () => {
      const requestNumber = ++sequence
      const requestId = `request-${String(requestNumber).padStart(4, '0')}`
      const requestDir = path.join(outputDir, requestId)
      await ensureDir(requestDir)
      const startedAt = new Date()
      const incomingUrl = new URL(clientRequest.url || '/', 'http://observer.local')
      const upstreamUrl = new URL(upstreamBase)
      upstreamUrl.pathname = joinUpstreamPath(
        upstreamBase.pathname,
        incomingUrl.pathname,
        incomingBasePath,
      )
      upstreamUrl.search = incomingUrl.search

      let bodyBuffer
      try {
        bodyBuffer = await readBody(clientRequest, maxRequestBytes)
      } catch (error) {
        clientResponse.writeHead(413, { 'content-type': 'application/json' })
        clientResponse.end(JSON.stringify({ error: String(error) }))
        await rm(path.join(requestDir, 'request.raw'), { force: true }).catch(() => {})
        await writeJson(path.join(requestDir, 'proxy-error.json'), {
          phase: 'read-request',
          error: String(error),
          captureComplete: false,
        })
        return
      }

      const inspection = await inspectRequestBody(bodyBuffer, clientRequest.headers, maxDecodedBytes)
      const parsedBody = inspection.parsedBody
      const observable = parsedBody
        ? observableRequestBody(parsedBody, { ownedSystemPrompt })
        : { body: null, omissions: {} }
      const requestRawPath = path.join(requestDir, 'request.raw')
      const parsedPath = path.join(requestDir, 'request.parsed.json')

      await Promise.all([
        writeFile(requestRawPath, bodyBuffer, { flag: 'wx', mode: 0o600 }),
        parsedBody ? writeJson(parsedPath, parsedBody) : Promise.resolve(),
        writeJson(path.join(requestDir, 'request-metadata.json'), {
          requestId,
          sequence: requestNumber,
          startedAt: startedAt.toISOString(),
          method: clientRequest.method,
          incomingPath: clientRequest.url,
          upstreamUrl: upstreamUrl.toString(),
          headers: headerSnapshot(clientRequest.headers),
          bodyBytes: bodyBuffer.length,
          bodySha256: sha256Buffer(bodyBuffer),
          captureMode: 'full-entity-body',
          captureComplete: true,
          rawArtifact: 'request.raw',
          parsedArtifact: parsedBody ? 'request.parsed.json' : null,
          inspectionStatus: inspection.status,
          decodedBytes: inspection.decodedBytes,
          contentType: inspection.contentType,
          contentEncoding: inspection.contentEncoding,
          parseError: inspection.error || null,
          ownedSystemPromptMatched:
            parsedBody?.system !== undefined && systemText(parsedBody.system) === ownedSystemPrompt,
        }),
        writeJson(path.join(requestDir, 'request.observable.json'), observable),
      ])

      const headers = { ...clientRequest.headers }
      delete headers.host
      delete headers.connection
      delete headers['proxy-connection']
      headers.host = upstreamUrl.host

      await new Promise(resolveRequest => {
        let settled = false
        const settle = () => {
          if (settled) return
          settled = true
          resolveRequest()
        }
        const upstreamRequest = requestModule(upstreamUrl).request(
          upstreamUrl,
          {
            method: clientRequest.method,
            headers,
          },
          async upstreamResponse => {
            const responseStartedAt = new Date()
            const responseHeaders = headerSnapshot(upstreamResponse.headers)
            await writeJson(path.join(requestDir, 'response-metadata.json'), {
              requestId,
              responseStartedAt: responseStartedAt.toISOString(),
              statusCode: upstreamResponse.statusCode,
              statusMessage: upstreamResponse.statusMessage,
              headers: responseHeaders,
            })

            const responseHeadersForClient = { ...upstreamResponse.headers }
            delete responseHeadersForClient.connection
            clientResponse.writeHead(
              upstreamResponse.statusCode || 502,
              upstreamResponse.statusMessage,
              responseHeadersForClient,
            )
            clientResponse.flushHeaders?.()

            const responsePath = path.join(requestDir, 'response.raw')
            const responseFile = (await import('node:fs')).createWriteStream(responsePath, {
              flags: 'wx',
            })
            const responseHash = createHash('sha256')
            let responseBytes = 0
            upstreamResponse.on('data', chunk => {
              responseBytes += chunk.length
              responseHash.update(chunk)
            })
            upstreamResponse.pipe(responseFile)
            upstreamResponse.pipe(clientResponse)

            try {
              await Promise.all([finished(responseFile), finished(clientResponse)])
              const completedAt = new Date()
              const summary = {
                requestId,
                sequence: requestNumber,
                method: clientRequest.method,
                path: incomingUrl.pathname,
                statusCode: upstreamResponse.statusCode,
                startedAt: startedAt.toISOString(),
                responseStartedAt: responseStartedAt.toISOString(),
                completedAt: completedAt.toISOString(),
                requestBytes: bodyBuffer.length,
                responseBytes,
                requestSha256: sha256Buffer(bodyBuffer),
                responseSha256: responseHash.digest('hex'),
                durationMs: completedAt.getTime() - startedAt.getTime(),
                timeToHeadersMs: responseStartedAt.getTime() - startedAt.getTime(),
                requestDir: requestId,
              }
              await writeJson(path.join(requestDir, 'summary.json'), summary)
              await appendIndex(summary)
            } catch (error) {
              await writeJson(path.join(requestDir, 'proxy-error.json'), {
                phase: 'stream-response',
                error: String(error),
              })
            } finally {
              settle()
            }
          },
        )

        upstreamRequest.on('error', async error => {
          if (!clientResponse.headersSent) {
            clientResponse.writeHead(502, { 'content-type': 'application/json' })
          }
          clientResponse.end(JSON.stringify({ error: 'Observer upstream request failed' }))
          await writeJson(path.join(requestDir, 'proxy-error.json'), {
            phase: 'upstream-request',
            error: String(error),
          })
          settle()
        })
        clientRequest.on('aborted', () => upstreamRequest.destroy())
        upstreamRequest.end(bodyBuffer)
      })
    })()
    active.add(work)
    work.finally(() => active.delete(work)).catch(() => {})
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(normalizedListenPort, '127.0.0.1', resolve)
  })
  const address = server.address()
  const localBaseUrl = `http://127.0.0.1:${address.port}`
  const childBaseUrl = incomingBasePath ? `${localBaseUrl}${incomingBasePath}` : localBaseUrl
  await writeJson(path.join(outputDir, 'proxy.json'), {
    localBaseUrl,
    childBaseUrl,
    upstreamBaseUrl: upstreamBase.toString(),
    ownedSystemPromptConfigured: ownedSystemPrompt !== null,
    requestCapture: 'full-entity-body',
    maxRequestBytes,
    maxDecodedBytes,
    listenPort: address.port,
    incomingBasePath: incomingBasePath || null,
    startedAt: new Date().toISOString(),
  })

  return {
    localBaseUrl,
    childBaseUrl,
    upstreamBaseUrl: upstreamBase.toString(),
    async close() {
      await new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
      })
      await Promise.allSettled([...active])
      await indexWrites
    },
  }
}
