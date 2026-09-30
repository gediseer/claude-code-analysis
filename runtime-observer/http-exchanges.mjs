#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isAnthropicMessagesPath } from './api-paths.mjs'
import { exists } from './lib.mjs'
import { parseSse, summarizeSse } from './sse.mjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')

async function readJson(filePath, fallback = null) {
  if (!(await exists(filePath))) return fallback
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function strictUtf8(buffer) {
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
}

function decodeContent(buffer, encoding) {
  const encodings = String(encoding || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
  let decoded = Buffer.from(buffer)
  for (const item of encodings.reverse()) {
    if (item === 'identity') continue
    if (item === 'gzip' || item === 'x-gzip') decoded = gunzipSync(decoded)
    else if (item === 'deflate') decoded = inflateSync(decoded)
    else if (item === 'br') decoded = brotliDecompressSync(decoded)
    else if (item === 'zstd' && typeof zstdDecompressSync === 'function') decoded = zstdDecompressSync(decoded)
    else throw new Error(`Unsupported content encoding: ${item}`)
  }
  return { decoded, encodings }
}

function plaintext(buffer, encoding) {
  try {
    const { decoded, encodings } = decodeContent(buffer, encoding)
    return {
      available: true,
      text: strictUtf8(decoded),
      decodedBytes: decoded.length,
      transform: encodings.length ? `${encodings.join(' + ')} → UTF-8` : 'UTF-8',
      error: null,
    }
  } catch (error) {
    return {
      available: false,
      text: null,
      decodedBytes: null,
      transform: null,
      error: String(error?.message || error),
    }
  }
}

function endpointKind(method, pathname) {
  if (method === 'POST' && isAnthropicMessagesPath(pathname)) return 'messages'
  if (method === 'POST' && /\/v1\/messages\/count_tokens$/.test(pathname)) return 'count_tokens'
  if (method === 'GET' && /\/v1\/models(?:\/|$)/.test(pathname)) return 'models'
  return 'auxiliary'
}

function integrity({ raw, declaredBytes, declaredSha256, paired }) {
  const actualSha256 = sha256(raw)
  const bytesMatch = Number(declaredBytes) === raw.length
  const hashMatch = declaredSha256 === actualSha256
  return {
    status: paired && bytesMatch && hashMatch ? 'EXACT_WIRE_BYTES_VERIFIED' : 'INTEGRITY_FAILURE',
    paired,
    bytesMatch,
    hashMatch,
    bytes: raw.length,
    sha256: actualSha256,
    declaredBytes: declaredBytes ?? null,
    declaredSha256: declaredSha256 ?? null,
  }
}

export async function loadHttpExchanges(runDir) {
  const apiRoot = path.join(runDir, '05-api')
  if (!(await exists(apiRoot))) return []
  const entries = (await readdir(apiRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^request-\d+$/.test(entry.name))
  const exchanges = []
  for (const entry of entries) {
    const directory = path.join(apiRoot, entry.name)
    const [requestMetadata, responseMetadata, summary] = await Promise.all([
      readJson(path.join(directory, 'request-metadata.json'), {}),
      readJson(path.join(directory, 'response-metadata.json'), {}),
      readJson(path.join(directory, 'summary.json'), {}),
    ])
    const requestPath = path.join(directory, 'request.raw')
    const responsePath = path.join(directory, 'response.raw')
    const requestAvailable = await exists(requestPath)
    const responseAvailable = await exists(responsePath)
    const requestRaw = requestAvailable ? await readFile(requestPath) : Buffer.alloc(0)
    const responseRaw = responseAvailable ? await readFile(responsePath) : Buffer.alloc(0)
    const requestEncoding = requestMetadata.contentEncoding || requestMetadata.headers?.['content-encoding'] || ''
    const responseEncoding = responseMetadata.headers?.['content-encoding'] || ''
    const requestText = requestAvailable ? plaintext(requestRaw, requestEncoding) : { available: false, text: null, error: 'request.raw unavailable' }
    const responseText = responseAvailable ? plaintext(responseRaw, responseEncoding) : { available: false, text: null, error: 'response.raw unavailable' }
    const pathname = new URL(requestMetadata.incomingPath || summary.path || '/', 'http://observer.local').pathname
    const kind = endpointKind(requestMetadata.method || summary.method, pathname)
    const sseEvents = kind === 'messages' && responseText.available ? parseSse(responseText.text) : []
    const sse = kind === 'messages' ? summarizeSse(sseEvents) : null
    exchanges.push({
      requestId: entry.name,
      sequence: Number(summary.sourceGlobalSequence ?? requestMetadata.sourceGlobalSequence ?? requestMetadata.sequence ?? summary.sequence ?? entry.name.match(/\d+/)?.[0] ?? 0),
      captureSequence: Number(requestMetadata.sequence ?? summary.sequence ?? 0),
      acceptedAt: requestMetadata.startedAt || summary.startedAt || null,
      completedAt: summary.completedAt || null,
      method: requestMetadata.method || summary.method || '-',
      path: requestMetadata.incomingPath || summary.path || '/',
      kind,
      agentId: requestMetadata.headers?.['x-claude-code-agent-id'] || null,
      statusCode: responseMetadata.statusCode ?? summary.statusCode ?? null,
      durationMs: summary.durationMs ?? null,
      request: {
        plaintext: requestText,
        integrity: integrity({ raw: requestRaw, declaredBytes: requestMetadata.bodyBytes ?? summary.requestBytes, declaredSha256: requestMetadata.bodySha256 ?? summary.requestSha256, paired: requestAvailable && responseAvailable }),
        headers: requestMetadata.headers || {},
        rawRef: `05-api/${entry.name}/request.raw`,
      },
      response: {
        plaintext: responseText,
        integrity: integrity({ raw: responseRaw, declaredBytes: summary.responseBytes, declaredSha256: summary.responseSha256, paired: requestAvailable && responseAvailable }),
        headers: responseMetadata.headers || {},
        rawRef: `05-api/${entry.name}/response.raw`,
      },
      model: kind === 'messages'
        ? {
            messageId: sse?.messageId || null,
            stopReason: sse?.stopReason || null,
            usage: sse?.usage || null,
            visibleText: sse?.visibleText || '',
            blocks: sse?.blocks || [],
            events: sseEvents.map((event, index) => ({ index, ...event })),
          }
        : null,
      rawRefs: {
        request: `05-api/${entry.name}/request.raw`,
        response: `05-api/${entry.name}/response.raw`,
        summary: `05-api/${entry.name}/summary.json`,
      },
    })
  }
  exchanges.sort((left, right) =>
    left.sequence - right.sequence ||
    Date.parse(left.acceptedAt || '') - Date.parse(right.acceptedAt || '') ||
    left.requestId.localeCompare(right.requestId),
  )
  return exchanges
}
