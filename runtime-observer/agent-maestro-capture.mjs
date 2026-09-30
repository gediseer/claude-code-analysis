#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import {
  copyExact,
  ensureDir,
  exists,
  writeJson,
} from './lib.mjs'

const DEFAULT_SETTLE_TIMEOUT_MS = 5_000
const DEFAULT_SETTLE_QUIET_MS = 250
const DEFAULT_SETTLE_POLL_MS = 50

const REQUEST_RAW = '01-client-request.raw'
const REQUEST_HEADERS = '01-client-request.headers.redacted.json'
const REQUEST_PARSED = '02-client-request.parsed.json'
const VSCODE_LM_REQUESTS = '03-vscode-lm-requests.jsonl'
const VSCODE_LM_TOKEN_COUNTS = '03-vscode-lm-token-counts.jsonl'
const VSCODE_LM_EVENTS = '04-vscode-lm-events.jsonl'
const RESPONSE_RAW = '05-client-response.raw'
const RESPONSE_HEADERS = '05-client-response.headers.redacted.json'
const SOURCE_SUMMARY = 'summary.json'
const CAPTURE_ERROR = 'capture-error.json'

const REQUIRED_SOURCE_FILES = Object.freeze([
  REQUEST_RAW,
  REQUEST_HEADERS,
  RESPONSE_RAW,
  RESPONSE_HEADERS,
  SOURCE_SUMMARY,
])

const OPTIONAL_SOURCE_FILES = Object.freeze([
  REQUEST_PARSED,
  VSCODE_LM_REQUESTS,
  VSCODE_LM_TOKEN_COUNTS,
  VSCODE_LM_EVENTS,
])

const SENSITIVE_HEADER_NAMES = new Set([
  'anthropic-api-key',
  'authentication-info',
  'authorization',
  'cookie',
  'grpc-metadata-authorization',
  'openai-api-key',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'www-authenticate',
  'x-api-key',
  'x-amz-credential',
  'x-amz-security-token',
  'x-auth-token',
  'x-goog-api-client-certificate',
  'x-goog-api-key',
])
const SENSITIVE_HEADER_SUFFIX = /(?:^|[-_])(?:api[-_]?key|token|secret|credential|session)$/i

export class AgentMaestroCaptureImportError extends Error {
  constructor(message, report) {
    super(message)
    this.name = 'AgentMaestroCaptureImportError'
    this.report = report
  }
}

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeNonNegativeInteger(value, name) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative integer; received ${JSON.stringify(value)}`)
  }
  return number
}

function normalizePositiveInteger(value, name) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer; received ${JSON.stringify(value)}`)
  }
  return number
}

function normalizeDuration(value, fallback, name) {
  if (value === undefined) return fallback
  return normalizeNonNegativeInteger(value, name)
}

function validExactSessionSegment(sessionId) {
  return (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    sessionId.length <= 160 &&
    sessionId !== '.' &&
    sessionId !== '..' &&
    path.basename(sessionId) === sessionId &&
    !/[\\/\0]/.test(sessionId)
  )
}

function isSensitiveHeader(name) {
  const normalized = name.toLowerCase()
  if (normalized === 'x-claude-code-session-id') return false
  return SENSITIVE_HEADER_NAMES.has(normalized) || SENSITIVE_HEADER_SUFFIX.test(normalized)
}

function normalizeHeaders(value, artifact) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${artifact} must contain a JSON object`)
  }
  const headers = {}
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase()
    if (typeof rawValue !== 'string') {
      throw new Error(`${artifact} header ${rawName} must be a string`)
    }
    if (isSensitiveHeader(name) && rawValue !== '[FORWARDED_NOT_RECORDED]') {
      throw new Error(`${artifact} contains an unredacted sensitive header: ${rawName}`)
    }
    if (Object.hasOwn(headers, name)) {
      throw new Error(`${artifact} contains duplicate case-insensitive header names: ${rawName}`)
    }
    headers[name] = rawValue
  }
  return headers
}

function parseBodySessionId(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const metadata = body.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const userId = metadata.user_id
  let parsed = userId
  if (typeof userId === 'string') {
    try {
      parsed = JSON.parse(userId)
    } catch {
      return undefined
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return typeof parsed.session_id === 'string' && parsed.session_id ? parsed.session_id : undefined
}

function classifySession(headerSessionId, bodySessionId) {
  if (headerSessionId && bodySessionId && headerSessionId !== bodySessionId) {
    return { kind: 'unknown', reason: 'conflict', headerSessionId, bodySessionId }
  }
  const sessionId = headerSessionId || bodySessionId
  if (!sessionId) return { kind: 'unknown', reason: 'no-session-id' }
  return {
    kind: 'session',
    sessionId,
    evidence: headerSessionId && bodySessionId ? 'header+body' : headerSessionId ? 'header' : 'body',
  }
}

async function readJsonStrict(filePath, artifact = filePath) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    throw new Error(`Cannot read ${artifact}: ${error.message || error}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid JSON in ${artifact}: ${error.message || error}`)
  }
}

async function readJsonlStrict(filePath, artifact) {
  if (!(await exists(filePath))) return []
  const text = await readFile(filePath, 'utf8')
  const values = []
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue
    try {
      values.push(JSON.parse(raw))
    } catch (error) {
      throw new Error(`Invalid JSONL in ${artifact} line ${index + 1}: ${error.message || error}`)
    }
  }
  return values
}

function validateSequence(values, artifact) {
  const seen = new Set()
  values.forEach((value, index) => {
    if (!value || typeof value !== 'object' || !Number.isInteger(value.sequence)) {
      throw new Error(`${artifact} record ${index + 1} has no integer sequence`)
    }
    if (seen.has(value.sequence)) {
      throw new Error(`${artifact} contains duplicate sequence ID ${value.sequence}`)
    }
    seen.add(value.sequence)
    if (value.sequence !== index) {
      throw new Error(`${artifact} sequence must be contiguous from 0; record ${index + 1} has ${value.sequence}`)
    }
  })
}

function validateCount(summary, field, actual, artifact) {
  const declared = summary[field]
  if (declared === undefined) {
    if (actual !== 0) {
      throw new Error(`${artifact} has ${actual} record(s), but summary.${field} is missing`)
    }
    return
  }
  const normalized = normalizeNonNegativeInteger(declared, `summary.${field}`)
  if (normalized !== actual) {
    throw new Error(`${artifact} count mismatch: ${actual} actual vs ${normalized} declared`)
  }
}

async function listFlatRegularFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const names = []
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error(`Agent Maestro exchange contains a non-regular entry: ${path.join(directory, entry.name)}`)
    }
    const info = await lstat(path.join(directory, entry.name))
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Agent Maestro exchange contains a non-regular file: ${path.join(directory, entry.name)}`)
    }
    names.push(entry.name)
  }
  names.sort((left, right) => left.localeCompare(right))
  return names
}

async function snapshotSession(exchangesRoot) {
  if (!(await exists(exchangesRoot))) {
    return {
      available: false,
      exchangeNames: [],
      allTerminal: false,
      fingerprint: 'missing',
    }
  }
  const rootInfo = await lstat(exchangesRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Exact Agent Maestro exchanges path is not a directory: ${exchangesRoot}`)
  }
  const entries = await readdir(exchangesRoot, { withFileTypes: true })
  const exchangeNames = []
  const fingerprintRows = []
  let allTerminal = entries.length > 0
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      throw new Error(`Unexpected non-directory in Agent Maestro exchanges path: ${entry.name}`)
    }
    const exchangeDir = path.join(exchangesRoot, entry.name)
    const exchangeInfo = await lstat(exchangeDir)
    if (!exchangeInfo.isDirectory() || exchangeInfo.isSymbolicLink()) {
      throw new Error(`Agent Maestro exchange is not a regular directory: ${exchangeDir}`)
    }
    exchangeNames.push(entry.name)
    const files = await readdir(exchangeDir, { withFileTypes: true })
    let terminal = false
    for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(exchangeDir, file.name)
      const info = await lstat(filePath)
      fingerprintRows.push([entry.name, file.name, info.size, info.mtimeMs, info.isFile(), info.isDirectory(), info.isSymbolicLink()])
      if (file.isFile() && (file.name === SOURCE_SUMMARY || file.name === CAPTURE_ERROR)) terminal = true
    }
    if (!terminal) allTerminal = false
  }
  return {
    available: true,
    exchangeNames,
    allTerminal: exchangeNames.length > 0 && allTerminal,
    fingerprint: sha256Buffer(Buffer.from(JSON.stringify(fingerprintRows))),
  }
}

async function waitForSettledSession(exchangesRoot, {
  settleTimeoutMs,
  settleQuietMs,
  settlePollMs,
}) {
  const started = Date.now()
  let lastFingerprint = null
  let stableSince = null
  let latest = await snapshotSession(exchangesRoot)
  while (true) {
    const now = Date.now()
    if (latest.allTerminal) {
      if (latest.fingerprint !== lastFingerprint) {
        lastFingerprint = latest.fingerprint
        stableSince = now
      }
      if (stableSince !== null && now - stableSince >= settleQuietMs) {
        return { ...latest, timedOut: false, waitedMs: now - started }
      }
    } else {
      lastFingerprint = latest.fingerprint
      stableSince = null
    }
    if (now - started >= settleTimeoutMs) {
      return { ...latest, timedOut: true, waitedMs: now - started }
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(settlePollMs, Math.max(1, settleTimeoutMs - (now - started)))))
    latest = await snapshotSession(exchangesRoot)
  }
}

async function validateExchange(exchangeDir, exchangeDirectoryName, sessionId) {
  const sourceFiles = await listFlatRegularFiles(exchangeDir)
  const sourceSet = new Set(sourceFiles)
  if (sourceSet.has(CAPTURE_ERROR)) {
    throw new Error(`Exchange ${exchangeDirectoryName} has ${CAPTURE_ERROR}`)
  }
  for (const required of REQUIRED_SOURCE_FILES) {
    if (!sourceSet.has(required)) {
      throw new Error(`Exchange ${exchangeDirectoryName} is incomplete: missing ${required}`)
    }
  }

  const summary = await readJsonStrict(path.join(exchangeDir, SOURCE_SUMMARY), `${exchangeDirectoryName}/${SOURCE_SUMMARY}`)
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    throw new Error(`Exchange ${exchangeDirectoryName} summary must be a JSON object`)
  }
  if (summary.state !== 'completed' || summary.error !== undefined) {
    throw new Error(`Exchange ${exchangeDirectoryName} is not complete: state=${JSON.stringify(summary.state)}`)
  }
  if (summary.exchangeId !== exchangeDirectoryName) {
    throw new Error(`Exchange directory/summary ID mismatch: ${exchangeDirectoryName} vs ${JSON.stringify(summary.exchangeId)}`)
  }
  if (!/^\d{10}$/.test(exchangeDirectoryName)) {
    throw new Error(`Exchange ID is not the expected ten-digit Agent Maestro ID: ${exchangeDirectoryName}`)
  }
  const globalSequence = normalizePositiveInteger(summary.globalSequence, `${exchangeDirectoryName}.globalSequence`)
  if (String(globalSequence).padStart(10, '0') !== exchangeDirectoryName) {
    throw new Error(`Exchange ${exchangeDirectoryName} does not match global sequence ${globalSequence}`)
  }

  const requestRaw = await readFile(path.join(exchangeDir, REQUEST_RAW))
  const responseRaw = await readFile(path.join(exchangeDir, RESPONSE_RAW))
  const requestBytes = normalizeNonNegativeInteger(summary.requestBytes, `${exchangeDirectoryName}.requestBytes`)
  const responseBytes = normalizeNonNegativeInteger(summary.responseBytes, `${exchangeDirectoryName}.responseBytes`)
  const requestSha256 = sha256Buffer(requestRaw)
  const responseSha256 = sha256Buffer(responseRaw)
  if (requestRaw.length !== requestBytes) {
    throw new Error(`Exchange ${exchangeDirectoryName} request byte mismatch: ${requestRaw.length} actual vs ${requestBytes} declared`)
  }
  if (responseRaw.length !== responseBytes) {
    throw new Error(`Exchange ${exchangeDirectoryName} response byte mismatch: ${responseRaw.length} actual vs ${responseBytes} declared`)
  }
  if (summary.requestSha256 !== requestSha256) {
    throw new Error(`Exchange ${exchangeDirectoryName} request SHA-256 mismatch`)
  }
  if (summary.responseSha256 !== responseSha256) {
    throw new Error(`Exchange ${exchangeDirectoryName} response SHA-256 mismatch`)
  }

  const requestHeaders = normalizeHeaders(
    await readJsonStrict(path.join(exchangeDir, REQUEST_HEADERS), `${exchangeDirectoryName}/${REQUEST_HEADERS}`),
    `${exchangeDirectoryName}/${REQUEST_HEADERS}`,
  )
  const responseHeaders = normalizeHeaders(
    await readJsonStrict(path.join(exchangeDir, RESPONSE_HEADERS), `${exchangeDirectoryName}/${RESPONSE_HEADERS}`),
    `${exchangeDirectoryName}/${RESPONSE_HEADERS}`,
  )

  let parsedRequest = null
  let parsedBodyAvailable = false
  let rawParsed = null
  let rawParseError = null
  try {
    rawParsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(requestRaw))
  } catch (error) {
    rawParseError = String(error)
  }
  if (sourceSet.has(REQUEST_PARSED)) {
    parsedRequest = await readJsonStrict(path.join(exchangeDir, REQUEST_PARSED), `${exchangeDirectoryName}/${REQUEST_PARSED}`)
    parsedBodyAvailable = true
    if (rawParseError || !isDeepStrictEqual(parsedRequest, rawParsed)) {
      throw new Error(`Exchange ${exchangeDirectoryName} parsed request does not match authoritative request bytes`)
    }
  } else if (!rawParseError) {
    throw new Error(`Exchange ${exchangeDirectoryName} has valid JSON request bytes but is missing ${REQUEST_PARSED}`)
  }

  const headerSessionId = requestHeaders['x-claude-code-session-id'] || undefined
  const bodySessionId = parsedBodyAvailable ? parseBodySessionId(parsedRequest) : undefined
  const recomputedClassification = classifySession(headerSessionId, bodySessionId)
  if (recomputedClassification.kind === 'unknown' && recomputedClassification.reason === 'conflict') {
    throw new Error(
      `Exchange ${exchangeDirectoryName} has conflicting exact session IDs: header=${recomputedClassification.headerSessionId}, body=${recomputedClassification.bodySessionId}`,
    )
  }
  if (
    recomputedClassification.kind !== 'session' ||
    recomputedClassification.sessionId !== sessionId ||
    recomputedClassification.evidence !== summary.classification?.evidence ||
    summary.classification?.kind !== 'session' ||
    summary.classification?.sessionId !== sessionId
  ) {
    throw new Error(
      `Exchange ${exchangeDirectoryName} session classification mismatch for exact child session ${sessionId}`,
    )
  }

  const vscodeLmRequests = await readJsonlStrict(
    path.join(exchangeDir, VSCODE_LM_REQUESTS),
    `${exchangeDirectoryName}/${VSCODE_LM_REQUESTS}`,
  )
  const vscodeLmTokenCounts = await readJsonlStrict(
    path.join(exchangeDir, VSCODE_LM_TOKEN_COUNTS),
    `${exchangeDirectoryName}/${VSCODE_LM_TOKEN_COUNTS}`,
  )
  const vscodeLmEvents = await readJsonlStrict(
    path.join(exchangeDir, VSCODE_LM_EVENTS),
    `${exchangeDirectoryName}/${VSCODE_LM_EVENTS}`,
  )
  validateSequence(vscodeLmRequests, `${exchangeDirectoryName}/${VSCODE_LM_REQUESTS}`)
  validateSequence(vscodeLmTokenCounts, `${exchangeDirectoryName}/${VSCODE_LM_TOKEN_COUNTS}`)
  validateSequence(vscodeLmEvents, `${exchangeDirectoryName}/${VSCODE_LM_EVENTS}`)
  validateCount(summary, 'vscodeLmRequestCount', vscodeLmRequests.length, `${exchangeDirectoryName}/${VSCODE_LM_REQUESTS}`)
  validateCount(summary, 'vscodeLmTokenCountCallCount', vscodeLmTokenCounts.length, `${exchangeDirectoryName}/${VSCODE_LM_TOKEN_COUNTS}`)
  validateCount(summary, 'vscodeLmEventCount', vscodeLmEvents.length, `${exchangeDirectoryName}/${VSCODE_LM_EVENTS}`)

  if (typeof summary.method !== 'string' || !summary.method) {
    throw new Error(`Exchange ${exchangeDirectoryName} has no method`)
  }
  if (typeof summary.path !== 'string' || !summary.path.startsWith('/')) {
    throw new Error(`Exchange ${exchangeDirectoryName} has invalid path ${JSON.stringify(summary.path)}`)
  }
  const acceptedAtMs = Date.parse(summary.acceptedAt)
  const completedAtMs = Date.parse(summary.completedAt)
  if (!Number.isFinite(acceptedAtMs) || !Number.isFinite(completedAtMs) || completedAtMs < acceptedAtMs) {
    throw new Error(`Exchange ${exchangeDirectoryName} has invalid accepted/completed timestamps`)
  }
  const responseStatus = normalizeNonNegativeInteger(summary.responseStatus, `${exchangeDirectoryName}.responseStatus`)
  if (responseStatus < 100 || responseStatus > 599) {
    throw new Error(`Exchange ${exchangeDirectoryName} has invalid HTTP response status ${responseStatus}`)
  }

  return {
    exchangeDir,
    exchangeId: exchangeDirectoryName,
    globalSequence,
    sourceFiles,
    summary,
    requestRaw,
    responseRaw,
    requestHeaders,
    responseHeaders,
    parsedRequest,
    parsedBodyAvailable,
    rawParseError,
    requestSha256,
    responseSha256,
    acceptedAtMs,
    completedAtMs,
  }
}

async function writeImportReport(runDir, report) {
  await writeJson(path.join(runDir, '00-task', 'agent-maestro-capture-import.json'), report)
}

function sourceRelativePath(sessionId, exchangeId) {
  return ['sessions', sessionId, 'exchanges', exchangeId].join('/')
}

async function copyExchangeSource(exchange, destination) {
  await ensureDir(destination)
  for (const fileName of exchange.sourceFiles) {
    await copyExact(path.join(exchange.exchangeDir, fileName), path.join(destination, fileName))
  }
}

async function copyIfPresent(source, destination) {
  if (!(await exists(source))) return false
  await copyExact(source, destination)
  return true
}

async function rejectImport(runDir, baseReport, reason, details = null) {
  const report = {
    ...baseReport,
    status: 'rejected',
    validForApiEvidence: false,
    reason,
    details,
    finishedAt: new Date().toISOString(),
  }
  await writeImportReport(runDir, report)
  throw new AgentMaestroCaptureImportError(`Agent Maestro capture import rejected: ${reason}`, report)
}

export async function importAgentMaestroCapture({
  captureRoot,
  sessionId,
  runDir,
  settleTimeoutMs = DEFAULT_SETTLE_TIMEOUT_MS,
  settleQuietMs = DEFAULT_SETTLE_QUIET_MS,
  settlePollMs = DEFAULT_SETTLE_POLL_MS,
} = {}) {
  if (typeof captureRoot !== 'string' || !captureRoot.trim()) {
    throw new Error('captureRoot is required for Agent Maestro capture import')
  }
  if (!validExactSessionSegment(sessionId)) {
    throw new Error(`Exact child session ID is not a safe literal directory segment: ${JSON.stringify(sessionId)}`)
  }
  if (typeof runDir !== 'string' || !runDir) throw new Error('runDir is required for Agent Maestro capture import')

  const normalizedRoot = path.resolve(captureRoot)
  const normalizedRunDir = path.resolve(runDir)
  const timeout = normalizeDuration(settleTimeoutMs, DEFAULT_SETTLE_TIMEOUT_MS, 'settleTimeoutMs')
  const quiet = normalizeDuration(settleQuietMs, DEFAULT_SETTLE_QUIET_MS, 'settleQuietMs')
  const poll = Math.max(1, normalizeDuration(settlePollMs, DEFAULT_SETTLE_POLL_MS, 'settlePollMs'))
  const sessionRelative = path.join('sessions', sessionId, 'exchanges')
  const exchangesRoot = path.join(normalizedRoot, sessionRelative)
  const apiRoot = path.join(normalizedRunDir, '05-api')
  const relativeRootToRun = path.relative(normalizedRoot, normalizedRunDir)
  const runInsideCaptureRoot = relativeRootToRun === '' || (!relativeRootToRun.startsWith('..') && !path.isAbsolute(relativeRootToRun))
  const relativeRunToRoot = path.relative(normalizedRunDir, normalizedRoot)
  const captureInsideRun = relativeRunToRoot === '' || (!relativeRunToRoot.startsWith('..') && !path.isAbsolute(relativeRunToRoot))
  const baseReport = {
    schemaVersion: 1,
    source: 'agent-maestro-anthropic-recorder',
    captureRoot: normalizedRoot,
    sessionId,
    exactSessionPath: sessionRelative.replaceAll('\\', '/'),
    selection: 'exact-session-id-only',
    inferenceFallbacks: [],
    startedAt: new Date().toISOString(),
    settle: { timeoutMs: timeout, quietMs: quiet, pollMs: poll },
  }

  await ensureDir(path.join(normalizedRunDir, '00-task'))
  if (runInsideCaptureRoot || captureInsideRun) {
    return rejectImport(normalizedRunDir, baseReport, 'capture root and run directory must be disjoint')
  }
  if (await exists(apiRoot)) {
    return rejectImport(normalizedRunDir, baseReport, 'run 05-api destination already exists')
  }

  let settled
  try {
    settled = await waitForSettledSession(exchangesRoot, {
      settleTimeoutMs: timeout,
      settleQuietMs: quiet,
      settlePollMs: poll,
    })
  } catch (error) {
    return rejectImport(normalizedRunDir, baseReport, 'capture session could not be inspected', String(error.stack || error))
  }

  if (!settled.available || settled.exchangeNames.length === 0) {
    const report = {
      ...baseReport,
      status: 'unavailable',
      validForApiEvidence: false,
      reason: !settled.available
        ? 'exact-session-exchanges-directory-not-found'
        : 'exact-session-has-no-exchanges',
      waitedMs: settled.waitedMs,
      finishedAt: new Date().toISOString(),
    }
    await writeImportReport(normalizedRunDir, report)
    return report
  }
  if (!settled.allTerminal) {
    return rejectImport(
      normalizedRunDir,
      baseReport,
      'exact-session capture did not reach a terminal recorder state before settle timeout',
      { exchangeIds: settled.exchangeNames, waitedMs: settled.waitedMs },
    )
  }

  let exchanges
  try {
    exchanges = await Promise.all(
      settled.exchangeNames.map(exchangeId =>
        validateExchange(path.join(exchangesRoot, exchangeId), exchangeId, sessionId),
      ),
    )
  } catch (error) {
    return rejectImport(normalizedRunDir, baseReport, 'source exchange validation failed', String(error.stack || error))
  }

  const exchangeIds = new Set()
  const globalSequences = new Set()
  for (const exchange of exchanges) {
    if (exchangeIds.has(exchange.exchangeId)) {
      return rejectImport(normalizedRunDir, baseReport, `duplicate exchange ID ${exchange.exchangeId}`)
    }
    if (globalSequences.has(exchange.globalSequence)) {
      return rejectImport(normalizedRunDir, baseReport, `duplicate global sequence ${exchange.globalSequence}`)
    }
    exchangeIds.add(exchange.exchangeId)
    globalSequences.add(exchange.globalSequence)
  }
  exchanges.sort((left, right) => left.globalSequence - right.globalSequence)

  const stagingRoot = `${apiRoot}.agent-maestro-importing-${process.pid}-${randomUUID()}`
  const mappings = []
  const requestIndex = []
  try {
    await ensureDir(stagingRoot)
    for (let index = 0; index < exchanges.length; index += 1) {
      const exchange = exchanges[index]
      const requestId = `request-${String(index + 1).padStart(4, '0')}`
      const requestDir = path.join(stagingRoot, requestId)
      const originalDir = path.join(requestDir, 'agent-maestro-original')
      await ensureDir(requestDir)
      await copyExchangeSource(exchange, originalDir)

      await copyExact(path.join(exchange.exchangeDir, REQUEST_RAW), path.join(requestDir, 'request.raw'))
      if (exchange.parsedBodyAvailable) {
        await copyExact(path.join(exchange.exchangeDir, REQUEST_PARSED), path.join(requestDir, 'request.parsed.json'))
      }
      await copyExact(path.join(exchange.exchangeDir, RESPONSE_RAW), path.join(requestDir, 'response.raw'))
      await copyExact(path.join(exchange.exchangeDir, REQUEST_HEADERS), path.join(requestDir, 'request.headers.redacted.json'))
      await copyExact(path.join(exchange.exchangeDir, RESPONSE_HEADERS), path.join(requestDir, 'response.headers.redacted.json'))
      await copyIfPresent(path.join(exchange.exchangeDir, VSCODE_LM_REQUESTS), path.join(requestDir, 'vscode-lm-requests.jsonl'))
      await copyIfPresent(path.join(exchange.exchangeDir, VSCODE_LM_TOKEN_COUNTS), path.join(requestDir, 'vscode-lm-token-counts.jsonl'))
      await copyIfPresent(path.join(exchange.exchangeDir, VSCODE_LM_EVENTS), path.join(requestDir, 'vscode-lm-events.jsonl'))

      const requestMetadata = {
        requestId,
        sequence: index + 1,
        startedAt: exchange.summary.acceptedAt,
        method: exchange.summary.method,
        incomingPath: exchange.summary.path,
        upstreamUrl: null,
        headers: exchange.requestHeaders,
        bodyBytes: exchange.summary.requestBytes,
        bodySha256: exchange.summary.requestSha256,
        captureMode: 'full-entity-body',
        captureComplete: true,
        rawArtifact: 'request.raw',
        parsedArtifact: exchange.parsedBodyAvailable ? 'request.parsed.json' : null,
        inspectionStatus: exchange.parsedBodyAvailable ? 'parsed-json' : 'parse-error',
        decodedBytes: exchange.parsedBodyAvailable ? exchange.summary.requestBytes : null,
        contentType: exchange.requestHeaders['content-type'] || '',
        contentEncoding: exchange.requestHeaders['content-encoding'] || '',
        parseError: exchange.rawParseError,
        captureSource: 'agent-maestro-direct',
        sourceExchangeId: exchange.exchangeId,
        sourceGlobalSequence: exchange.globalSequence,
        sourceClassification: exchange.summary.classification,
      }
      const responseMetadata = {
        requestId,
        responseStartedAt: null,
        statusCode: exchange.summary.responseStatus,
        statusMessage: null,
        headers: exchange.responseHeaders,
        captureSource: 'agent-maestro-direct',
        sourceExchangeId: exchange.exchangeId,
      }
      const normalizedSummary = {
        requestId,
        sequence: index + 1,
        method: exchange.summary.method,
        path: new URL(exchange.summary.path, 'http://agent-maestro.local').pathname,
        statusCode: exchange.summary.responseStatus,
        startedAt: exchange.summary.acceptedAt,
        responseStartedAt: null,
        completedAt: exchange.summary.completedAt,
        requestBytes: exchange.summary.requestBytes,
        responseBytes: exchange.summary.responseBytes,
        requestSha256: exchange.summary.requestSha256,
        responseSha256: exchange.summary.responseSha256,
        durationMs: exchange.completedAtMs - exchange.acceptedAtMs,
        timeToHeadersMs: null,
        requestDir: requestId,
        captureComplete: true,
        captureSource: 'agent-maestro-direct',
        sourceExchangeId: exchange.exchangeId,
        sourceGlobalSequence: exchange.globalSequence,
        classification: exchange.summary.classification,
        vscodeLmRequestCount: exchange.summary.vscodeLmRequestCount ?? 0,
        vscodeLmEventCount: exchange.summary.vscodeLmEventCount ?? 0,
        vscodeLmTokenCountCallCount: exchange.summary.vscodeLmTokenCountCallCount ?? 0,
        originalSummaryArtifact: 'agent-maestro-original/summary.json',
      }
      const observable = exchange.parsedBodyAvailable
        ? {
            body: exchange.parsedRequest,
            omissions: {},
            source: {
              type: 'agent-maestro-direct-import',
              authoritativeArtifact: 'request.raw',
              parsedArtifact: 'request.parsed.json',
            },
          }
        : {
            body: null,
            omissions: {},
            unavailable: {
              reason: 'authoritative-request-bytes-were-not-valid-json',
              authoritativeArtifact: 'request.raw',
            },
          }
      const mapping = {
        requestId,
        source: sourceRelativePath(sessionId, exchange.exchangeId),
        sourceExchangeId: exchange.exchangeId,
        sourceGlobalSequence: exchange.globalSequence,
        requestBytes: exchange.summary.requestBytes,
        requestSha256: exchange.summary.requestSha256,
        responseBytes: exchange.summary.responseBytes,
        responseSha256: exchange.summary.responseSha256,
        originalEvidenceDirectory: `${requestId}/agent-maestro-original`,
      }
      await Promise.all([
        writeJson(path.join(requestDir, 'request-metadata.json'), requestMetadata),
        writeJson(path.join(requestDir, 'request.observable.json'), observable),
        writeJson(path.join(requestDir, 'response-metadata.json'), responseMetadata),
        writeJson(path.join(requestDir, 'summary.json'), normalizedSummary),
        writeJson(path.join(requestDir, 'capture-provenance.json'), mapping),
      ])
      mappings.push(mapping)
      requestIndex.push(normalizedSummary)
    }

    await writeFile(
      path.join(stagingRoot, 'requests.jsonl'),
      `${requestIndex.map(value => JSON.stringify(value)).join('\n')}\n`,
      { encoding: 'utf8', flag: 'wx' },
    )
    const postCopySnapshot = await snapshotSession(exchangesRoot)
    if (
      postCopySnapshot.fingerprint !== settled.fingerprint ||
      postCopySnapshot.exchangeNames.join('\0') !== settled.exchangeNames.join('\0')
    ) {
      throw new Error('Exact session capture changed while it was being imported')
    }

    const report = {
      ...baseReport,
      status: 'imported',
      validForApiEvidence: true,
      waitedMs: settled.waitedMs,
      exchanges: mappings.length,
      mappings,
      canonicalArtifacts: [
        'request.raw',
        'request.parsed.json (when recorder produced valid JSON)',
        'request-metadata.json',
        'request.observable.json',
        'response.raw',
        'response-metadata.json',
        'summary.json',
      ],
      originalEvidenceDirectory: 'request-N/agent-maestro-original',
      finishedAt: new Date().toISOString(),
    }
    await writeJson(path.join(stagingRoot, 'agent-maestro-import.json'), report)
    await rename(stagingRoot, apiRoot)
    await writeImportReport(normalizedRunDir, report)
    return report
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    if (error instanceof AgentMaestroCaptureImportError) throw error
    return rejectImport(normalizedRunDir, baseReport, 'capture copy or commit failed', String(error.stack || error))
  }
}
