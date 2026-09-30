#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { exists, parseJsonl, walkFiles } from './lib.mjs'

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

export function sameWorkspacePath(left, right, platform = process.platform) {
  const normalizedLeft = path.resolve(left || '')
  const normalizedRight = path.resolve(right || '')
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

export async function captureLedgerOffset(captureRoot) {
  const ledger = path.join(captureRoot, 'ledger.jsonl')
  if (!(await exists(ledger))) return { ledger, bytes: 0, maxGlobalSequence: 0 }
  const bytes = (await stat(ledger)).size
  const rows = await readLedgerAfter({ ledger, bytes: 0 })
  const maxGlobalSequence = rows.reduce(
    (maximum, row) => Math.max(maximum, Number(row?.globalSequence || row?.summary?.globalSequence || 0)),
    0,
  )
  return { ledger, bytes, maxGlobalSequence }
}

export async function readLedgerAfter({ ledger, bytes = 0 }) {
  if (!(await exists(ledger))) return []
  const contents = await readFile(ledger)
  if (bytes > contents.length) throw new Error('Capture ledger became shorter during the observation window.')
  const tail = contents.subarray(bytes).toString('utf8')
  const rows = []
  for (const raw of tail.split(/\r?\n/)) {
    if (!raw.trim()) continue
    rows.push(JSON.parse(raw))
  }
  return rows
}

function ledgerSessionId(row) {
  const classification = row?.classification || row?.summary?.classification
  if (classification?.kind === 'session' && isSessionId(classification.sessionId)) {
    return classification.sessionId
  }
  if (isSessionId(row?.sessionId)) return row.sessionId
  if (isSessionId(row?.summary?.sessionId)) return row.summary.sessionId
  return null
}

export function candidateSessionIdsFromLedger(rows) {
  return [...new Set(rows.map(ledgerSessionId).filter(Boolean))]
}

export function filterLedgerRowsAfter(rows, notBefore) {
  if (!notBefore) return rows
  const threshold = Date.parse(notBefore)
  if (!Number.isFinite(threshold)) throw new Error(`Invalid notBefore timestamp: ${notBefore}`)
  return rows.filter(row => {
    const timestamp = row?.acceptedAt || row?.summary?.acceptedAt || row?.summary?.completedAt
    const parsed = Date.parse(timestamp || '')
    return Number.isFinite(parsed) && parsed >= threshold
  })
}

async function transcriptEvidence(filePath) {
  const parsed = await parseJsonl(filePath)
  const records = parsed.records.map(row => row.value)
  const firstUser = records.find(record => record?.type === 'user' && record?.isSidechain !== true)
  const sessionId = firstUser?.sessionId || firstUser?.session_id || path.basename(filePath, '.jsonl')
  return {
    filePath,
    sessionId,
    entrypoint: firstUser?.entrypoint || null,
    cwd: firstUser?.cwd || null,
    permissionMode: firstUser?.permissionMode || null,
    firstUser,
    records,
  }
}

export async function sessionRegistryEvidence(configDir, sessionId) {
  const sessionsDir = path.join(configDir, 'sessions')
  if (!(await exists(sessionsDir))) return null
  const files = (await readdir(sessionsDir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
  const matches = []
  for (const entry of files) {
    const filePath = path.join(sessionsDir, entry.name)
    const record = JSON.parse(await readFile(filePath, 'utf8'))
    if (record.sessionId === sessionId) matches.push({ filePath, record })
  }
  if (matches.length > 1) throw new Error(`Multiple live registry records found for Session ${sessionId}.`)
  return matches[0] || null
}

export async function locateTranscript({ configDir, sessionId, workspace }) {
  if (!isSessionId(sessionId)) throw new Error(`Invalid Session ID: ${sessionId}`)
  const projectRoot = path.join(configDir, 'projects')
  const candidates = (await walkFiles(projectRoot)).filter(
    filePath => path.basename(filePath) === `${sessionId}.jsonl`,
  )
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length === 0
        ? `No transcript found for Session ${sessionId}`
        : `Multiple transcripts found for Session ${sessionId}:\n${candidates.join('\n')}`,
    )
  }
  const evidence = await transcriptEvidence(candidates[0])
  if (evidence.entrypoint !== 'claude-vscode') {
    throw new Error(`Session ${sessionId} is not a native VS Code session: ${evidence.entrypoint || 'entrypoint unavailable'}`)
  }
  if (workspace && !sameWorkspacePath(evidence.cwd, workspace)) {
    throw new Error(`Session ${sessionId} cwd does not match the observed workspace.`)
  }
  return evidence
}

export async function latestTerminalTimestamp(captureRoot, sessionId) {
  const exchangesRoot = path.join(captureRoot, 'sessions', sessionId, 'exchanges')
  if (!(await exists(exchangesRoot))) return null
  const entries = await readdir(exchangesRoot, { withFileTypes: true })
  let latest = null
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const summaryPath = path.join(exchangesRoot, entry.name, 'summary.json')
    if (!(await exists(summaryPath))) continue
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'))
    const timestamp = Date.parse(summary.completedAt || summary.acceptedAt || '')
    if (Number.isFinite(timestamp) && (latest === null || timestamp > latest)) latest = timestamp
  }
  return latest === null ? null : new Date(latest).toISOString()
}

export async function waitForNativeSessionIdle({
  userDataDir,
  configDir,
  sessionId,
  runningEvidence = false,
  timeoutMs = 24 * 60 * 60 * 1000,
  pollMs = 500,
} = {}) {
  const deadline = Date.now() + timeoutMs
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const statePattern = new RegExp(`update_session_state.*"sessionId":"${escaped}".*"state":"(running|idle)"`)
  const states = runningEvidence
    ? [{ state: 'running', source: 'observer-capture-ledger', timestamp: new Date().toISOString() }]
    : []
  let previousRegistryState = null
  while (Date.now() <= deadline) {
    if (configDir) {
      const registry = await sessionRegistryEvidence(configDir, sessionId)
      const registryState = registry?.record?.status === 'busy'
        ? 'running'
        : registry?.record?.status === 'idle'
          ? 'idle'
          : null
      if (registryState && registryState !== previousRegistryState) {
        states.push({
          state: registryState,
          source: 'live-session-registry',
          timestamp: registry.record.statusUpdatedAt || registry.record.updatedAt || new Date().toISOString(),
          file: registry.filePath,
        })
        previousRegistryState = registryState
      }
    }
    const logsRoot = path.join(userDataDir, 'logs')
    const files = (await walkFiles(logsRoot)).filter(file => path.basename(file) === 'Claude VSCode.log')
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (const line of text.split(/\r?\n/)) {
        const match = statePattern.exec(line)
        if (match && !states.some(item => item.file === file && item.line === line)) {
          states.push({ state: match[1], source: 'vscode-log', file, line })
        }
      }
    }
    if (states.some(item => item.state === 'running') && states.at(-1)?.state === 'idle') {
      return { states, terminal: states.at(-1) }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  throw new Error(`Timed out waiting for native VS Code Session ${sessionId} to transition running → idle.`)
}

export async function waitForSessionQuiet({
  captureRoot,
  sessionId,
  quietMs = 5000,
  timeoutMs = 24 * 60 * 60 * 1000,
  pollMs = 500,
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const timestamp = await latestTerminalTimestamp(captureRoot, sessionId)
    if (timestamp && Date.now() - Date.parse(timestamp) >= quietMs) return timestamp
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  throw new Error(`Timed out waiting for Session ${sessionId} to become quiet.`)
}

export async function observerSessionDirectories(captureRoot) {
  const sessionsRoot = path.join(captureRoot, 'sessions')
  if (!(await exists(sessionsRoot))) return []
  const entries = await readdir(sessionsRoot, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory() && isSessionId(entry.name)).map(entry => entry.name)
}

export async function waitForNativeSession({
  timeoutMs = 24 * 60 * 60 * 1000,
  pollMs = 500,
  ...options
} = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() <= deadline) {
    try {
      return await correlateNativeSession(options)
    } catch (error) {
      lastError = error
      if (/More than one Session|does not match|not a native VS Code session|Prompt fidelity failed/.test(String(error?.message))) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
  }
  throw new Error(`Timed out waiting for the native VS Code Session: ${lastError?.message || lastError || 'no evidence'}`)
}

export async function correlateNativeSession({
  captureRoot,
  ledgerCheckpoint,
  configDir,
  workspace,
  expectedPromptSha256,
  promptAssessment,
  notBefore,
} = {}) {
  const rows = filterLedgerRowsAfter(await readLedgerAfter(ledgerCheckpoint), notBefore).filter(
    row => Number(row?.globalSequence || row?.summary?.globalSequence || 0) > Number(ledgerCheckpoint?.maxGlobalSequence || 0),
  )
  const ids = candidateSessionIdsFromLedger(rows)
  if (ids.length !== 1) {
    throw new Error(
      ids.length === 0
        ? 'No exact Session ID appeared in the Observer capture ledger after prompt submission.'
        : `More than one Session appeared after prompt submission: ${ids.join(', ')}`,
    )
  }
  const sessionId = ids[0]
  const registry = await sessionRegistryEvidence(configDir, sessionId)
  if (!registry) throw new Error(`Live Session registry evidence is unavailable for ${sessionId}.`)
  if (registry.record.entrypoint !== 'claude-vscode' || registry.record.kind !== 'interactive') {
    throw new Error(`Session registry does not identify a native interactive VS Code Session: ${sessionId}.`)
  }
  if (workspace && !sameWorkspacePath(registry.record.cwd, workspace)) {
    throw new Error(`Session registry cwd does not match the observed workspace: ${sessionId}.`)
  }
  const transcript = await locateTranscript({ configDir, sessionId, workspace })
  if (promptAssessment) {
    const assessment = await promptAssessment({
      expectedPromptSha256,
      transcript,
      sessionId,
      captureRoot,
    })
    if (!assessment.valid) throw new Error(`Prompt fidelity failed while correlating Session ${sessionId}: ${assessment.reason}`)
  }
  return {
    sessionId,
    transcript,
    registry,
    ledgerRows: rows.filter(row => ledgerSessionId(row) === sessionId),
    correlation: 'exact-ledger-session-id+transcript',
  }
}
