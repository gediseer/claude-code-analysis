#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDir, exists } from './lib.mjs'
import {
  firstApiPromptEvidence,
  validatePromptText,
} from './prompt-fidelity.mjs'
import { assessRoutingFidelity } from './routing-fidelity.mjs'
import {
  DEFAULT_VSCODE_EXTENSIONS_DIR,
  DEFAULT_VSCODE_USER_DATA_DIR,
  exactPromptUriRecord,
  launchNativeVsCode,
  prepareNativeVsCodeProfile,
  writeObserverBanner,
} from './vscode-native-session.mjs'
import {
  captureLedgerOffset,
  locateTranscript,
  waitForNativeSession,
  waitForNativeSessionIdle,
  waitForSessionQuiet,
} from './vscode-session-correlator.mjs'
import {
  startProcessTreeMonitor,
  waitForPrimaryNativeClaudeChild,
} from './run-native-vscode-session.mjs'
import { classifyCapturedNativeRequest } from './vscode-parity.mjs'

const CURRENT_VERSION = 1
const TERMINAL_PHASES = new Set(['completed', 'failed'])
const stateQueues = new Map()

const PHASE_ORDER = [
  'created',
  'preflight',
  'launched',
  'awaiting-submit',
  'session-discovered',
  'running',
  'idle',
  'replay-building',
  'completed',
  'failed',
]
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DEFAULT_OBSERVER_REPO = path.join(DEFAULT_REPO_ROOT, 'agent-maestro-observer')
const DEFAULT_JOBS_ROOT = path.join(DEFAULT_REPO_ROOT, '.claude', 'observe-claude', 'jobs')
const DEFAULT_PROFILE_ROOT = path.join(DEFAULT_OBSERVER_REPO, '.observer-native')
const DEFAULT_CAPTURE_ROOT = path.join(DEFAULT_OBSERVER_REPO, 'data')
const DEFAULT_NOTEBOOK = path.join(DEFAULT_CAPTURE_ROOT, 'build_session_replays.ipynb')
const DEFAULT_PYTHON_CANDIDATES = process.platform === 'win32'
  ? [
      process.env.OBSERVER_PYTHON,
      path.join(os.homedir(), '.conda', 'envs', 'trading', 'python.exe'),
      'python.exe',
      'py.exe',
    ]
  : [process.env.OBSERVER_PYTHON, 'python3', 'python']
const DEFAULT_CODE = process.platform === 'win32' ? 'code.cmd' : 'code'

export function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2)
    const next = rest[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next
      index += 1
    } else {
      options[key] = true
    }
  }
  return { command, options }
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function canonicalWorkspace(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function keyFor(workspace, promptSha256) {
  return sha256Text(`${canonicalWorkspace(workspace)}\0${promptSha256}`)
}

function statePath(jobDir) {
  return path.join(jobDir, 'job.json')
}

function eventsPath(jobDir) {
  return path.join(jobDir, 'events.jsonl')
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await ensureDir(path.dirname(filePath))
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await rename(temporary, filePath)
}

async function appendEvent(jobDir, type, detail = {}) {
  await appendFile(eventsPath(jobDir), `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type,
    ...detail,
  })}\n`, 'utf8')
}

async function updateState(jobDir, patch, eventType = 'state') {
  const previous = stateQueues.get(jobDir) || Promise.resolve()
  let result
  const nextWrite = previous.catch(() => undefined).then(async () => {
    const current = await readJson(statePath(jobDir))
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
    if (patch.phase && current.phase !== patch.phase) {
      const currentIndex = PHASE_ORDER.indexOf(current.phase)
      const nextIndex = PHASE_ORDER.indexOf(patch.phase)
      if (nextIndex < 0 || (patch.phase !== 'failed' && nextIndex < currentIndex)) {
        throw new Error(`Invalid phase transition: ${current.phase} -> ${patch.phase}`)
      }
    }
    await atomicJson(statePath(jobDir), next)
    await appendEvent(jobDir, eventType, { phase: next.phase, patch })
    result = next
  })
  stateQueues.set(jobDir, nextWrite)
  await nextWrite
  return result
}

function heartbeatFresh(job, maxAgeMs = 20_000) {
  const timestamp = Date.parse(job?.heartbeatAt || '')
  return Number.isFinite(timestamp) && Date.now() - timestamp <= maxAgeMs
}

async function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

async function acquireLock(jobDir) {
  const lockPath = path.join(jobDir, 'worker.lock')
  if (await exists(lockPath)) {
    let stale = false
    try {
      const existing = await readJson(lockPath)
      stale = !(await processAlive(existing.pid))
    } catch {
      stale = true
    }
    if (!stale) throw new Error(`Observe-claude worker lock is already held: ${lockPath}`)
    await rm(lockPath, { force: true })
  }
  const handle = await open(lockPath, 'wx')
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`)
  return async () => {
    await handle.close().catch(() => undefined)
    await rm(lockPath, { force: true })
  }
}

async function listJobs(jobsRoot) {
  if (!(await exists(jobsRoot))) return []
  const entries = await readdir(jobsRoot, { withFileTypes: true })
  const jobs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const filePath = statePath(path.join(jobsRoot, entry.name))
    if (!(await exists(filePath))) continue
    jobs.push(await readJson(filePath))
  }
  return jobs
}

async function findJob(options) {
  const jobsRoot = path.resolve(options['jobs-root'] || DEFAULT_JOBS_ROOT)
  if (options['job-id']) {
    const jobDir = path.join(jobsRoot, options['job-id'])
    if (!(await exists(statePath(jobDir)))) throw new Error(`Unknown observe-claude job: ${options['job-id']}`)
    return { jobsRoot, jobDir, job: await readJson(statePath(jobDir)) }
  }
  if (options['request-file']) {
    const request = await readJson(path.resolve(options['request-file']))
    const prompt = validatePromptText(request.prompt)
    if (!prompt.length) throw new Error('Raw Prompt must not be empty.')
    const workspace = path.resolve(request.workspace)
    const promptSha256 = sha256Text(prompt)
    const jobKey = keyFor(workspace, promptSha256)
    const matches = (await listJobs(jobsRoot)).filter(job => job.jobKey === jobKey)
    if (matches.length > 1) throw new Error(`More than one job exists for workspace and Prompt hash ${promptSha256}.`)
    if (matches.length === 1) {
      const job = matches[0]
      return { jobsRoot, jobDir: path.join(jobsRoot, job.jobId), job }
    }
  }
  throw new Error('Use --job-id or --request-file.')
}

function workerArgv(jobDir) {
  return [fileURLToPath(import.meta.url), 'worker', '--job-dir', jobDir]
}

async function spawnWorker(jobDir) {
  const stdout = await open(path.join(jobDir, 'worker.stdout.log'), 'a')
  const stderr = await open(path.join(jobDir, 'worker.stderr.log'), 'a')
  let child
  try {
    child = spawn(process.execPath, workerArgv(jobDir), {
      cwd: DEFAULT_REPO_ROOT,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', stdout.fd, stderr.fd],
    })
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.unref()
  } finally {
    await Promise.all([stdout.close(), stderr.close()])
  }
  await updateState(jobDir, { workerPid: child.pid, heartbeatAt: new Date().toISOString() }, 'worker-spawned')
  return child.pid
}

async function ensureWrapper(job) {
  const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native-vscode-wrapper', 'Program.cs')
  const buildPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native-vscode-wrapper', 'build-wrapper.cmd')
  const executableAvailable = await exists(job.wrapperExecutable)
  const needsBuild = !executableAvailable ||
    (await stat(sourcePath)).mtimeMs > (await stat(job.wrapperExecutable)).mtimeMs
  if (!needsBuild) return
  const buildCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : buildPath
  const buildArgs = process.platform === 'win32' ? ['/d', '/c', 'call', buildPath] : []
  const child = spawn(buildCommand, buildArgs, {
    cwd: path.dirname(buildPath),
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (code !== 0 || !(await exists(job.wrapperExecutable))) {
    throw new Error(`Observer wrapper build failed with code ${code}: ${stderr}`)
  }
}

async function resolvePython(candidate) {
  const candidates = [candidate, ...DEFAULT_PYTHON_CANDIDATES].filter(Boolean)
  for (const value of [...new Set(candidates)]) {
    if (path.isAbsolute(value) && !(await exists(value))) continue
    const child = spawn(value, ['-c', 'import nbclient, nbformat'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    })
    const code = await new Promise(resolve => {
      child.once('error', () => resolve(-1))
      child.once('close', resolve)
    })
    if (code === 0) return value
  }
  throw new Error('No Python executable with nbclient and nbformat is available; set OBSERVER_PYTHON.')
}

async function preflight(job, jobDir) {
  if (!(await exists(job.workspace))) throw new Error(`Workspace is unavailable: ${job.workspace}`)
  await ensureWrapper(job)
  if (!(await exists(job.wrapperExecutable))) throw new Error(`Observer wrapper is unavailable: ${job.wrapperExecutable}`)
  if (path.resolve(job.notebookPath) !== path.resolve(DEFAULT_NOTEBOOK)) {
    throw new Error(`Replay Notebook must be the canonical generator: ${DEFAULT_NOTEBOOK}`)
  }
  if (!(await exists(DEFAULT_NOTEBOOK))) throw new Error(`Replay Notebook is unavailable: ${DEFAULT_NOTEBOOK}`)
  const pythonExecutable = await resolvePython(job.pythonExecutable)
  if (pythonExecutable !== job.pythonExecutable) {
    await updateState(jobDir, { pythonExecutable }, 'python-resolved')
    job.pythonExecutable = pythonExecutable
  }
  if (process.platform === 'win32' && path.isAbsolute(job.codeCommand) && !(await exists(job.codeCommand))) {
    throw new Error(`VS Code launcher is unavailable: ${job.codeCommand}`)
  }
  const listenerCheck = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '$a=@(Get-NetTCPConnection -LocalPort 23333 -State Listen -ErrorAction SilentlyContinue);' +
    '$b=@(Get-NetTCPConnection -LocalPort 33333 -State Listen -ErrorAction SilentlyContinue);' +
    'Write-Output ($a.Count.ToString()+","+$b.Count.ToString())',
  ], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  listenerCheck.stdout.setEncoding('utf8')
  listenerCheck.stdout.on('data', chunk => { output += chunk })
  const code = await new Promise((resolve, reject) => {
    listenerCheck.once('error', reject)
    listenerCheck.once('close', resolve)
  })
  if (code !== 0) throw new Error('Unable to inspect ports 23333 and 33333.')
  const [normalCount, observerCount] = output.trim().split(',').map(Number)
  if (normalCount < 1) throw new Error('Normal Agent Maestro port 23333 is not listening.')
  if (observerCount !== 0) throw new Error('Observer port 33333 is already occupied before launch.')
  await appendEvent(jobDir, 'preflight-complete', { normalCount, observerCount })
}

async function validateCapturedSession(captureRoot, sessionId) {
  const exchangesRoot = path.join(captureRoot, 'sessions', sessionId, 'exchanges')
  if (!(await exists(exchangesRoot))) throw new Error(`Captured Session is unavailable: ${sessionId}`)
  const entries = (await readdir(exchangesRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
  if (!entries.length) throw new Error(`Captured Session has no exchanges: ${sessionId}`)
  for (const entry of entries) {
    const exchangeDir = path.join(exchangesRoot, entry.name)
    const summary = await readJson(path.join(exchangeDir, 'summary.json'))
    if (summary.state !== 'completed') {
      throw new Error(`Exchange ${entry.name} is ${summary.state}, not completed.`)
    }
    if (!Number.isInteger(summary.responseStatus) || summary.responseStatus < 200 || summary.responseStatus >= 300) {
      throw new Error(`Exchange ${entry.name} returned unsuccessful HTTP ${summary.responseStatus}.`)
    }
    for (const [fileName, bytesKey, hashKey] of [
      ['01-client-request.raw', 'requestBytes', 'requestSha256'],
      ['05-client-response.raw', 'responseBytes', 'responseSha256'],
    ]) {
      const bytes = await readFile(path.join(exchangeDir, fileName))
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (bytes.length !== summary[bytesKey] || digest !== summary[hashKey]) {
        throw new Error(`Exchange ${entry.name} failed ${fileName} byte/hash verification.`)
      }
    }
  }
  return entries.length
}

async function runNotebook(job, sessionId) {
  const script = [
    'import os',
    'from pathlib import Path',
    'import nbformat',
    'from nbclient import NotebookClient',
    `path = Path(${JSON.stringify(job.notebookPath)})`,
    'notebook = nbformat.read(path, as_version=4)',
    "NotebookClient(notebook, timeout=600, kernel_name='python3').execute(cwd=str(path.parent))",
  ].join('\n')
  const env = {
    ...process.env,
    OBSERVER_SESSION_ID: sessionId,
    OBSERVER_DATA_ROOT: job.captureRoot,
    OBSERVER_REPO_ROOT: job.observerRepo,
  }
  const child = spawn(job.pythonExecutable, ['-c', script], {
    cwd: path.dirname(job.notebookPath),
    env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (code !== 0) throw new Error(`Replay Notebook failed with code ${code}: ${stderr || stdout}`)
}

async function firstNativeApiEvidence(captureRoot, sessionId) {
  const exchangesRoot = path.join(captureRoot, 'sessions', sessionId, 'exchanges')
  const entries = (await readdir(exchangesRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const exchangeDir = path.join(exchangesRoot, entry.name)
    const summaryPath = path.join(exchangeDir, 'summary.json')
    if (!(await exists(summaryPath))) continue
    const summary = await readJson(summaryPath)
    const normalizedPath = String(summary.path || '').split('?', 1)[0].replace(/\/+$/, '')
    if (summary.method !== 'POST' || !normalizedPath.endsWith('/v1/messages')) continue
    if (summary.state !== 'completed' || summary.responseStatus < 200 || summary.responseStatus >= 300) continue
    const parsedPath = path.join(exchangeDir, '02-client-request.parsed.json')
    if (!(await exists(parsedPath))) continue
    const body = await readJson(parsedPath)
    if (!body?.messages || !classifyCapturedNativeRequest(body).valid) continue
    return firstApiPromptEvidence([{
      id: entry.name,
      body,
      rawRef: `sessions/${sessionId}/exchanges/${entry.name}/02-client-request.parsed.json`,
    }])
  }
  throw new Error('No captured native VS Code model request passed identity and tool-surface verification.')
}

async function writeSessionEvidence(job, sessionId, correlation, routingFidelity, networkPath) {
  const sessionDir = path.join(job.captureRoot, 'sessions', sessionId)
  const prompt = await readFile(job.promptPath, 'utf8')
  const firstUser = correlation.transcript.firstUser
  const transcriptContent = firstUser?.message?.content
  const transcriptPrompt = typeof transcriptContent === 'string'
    ? transcriptContent
    : Array.isArray(transcriptContent)
      ? transcriptContent.filter(block => block?.type === 'text').map(block => block.text).join('')
      : null
  if (transcriptPrompt !== prompt) throw new Error('Transcript first user Prompt does not exactly match the raw Prompt.')
  if (!['default', 'manual'].includes(correlation.transcript.permissionMode)) {
    throw new Error(`Observed Session started in ${correlation.transcript.permissionMode || 'unknown'} permission mode, not Manual/default.`)
  }
  const apiPrompt = await firstNativeApiEvidence(job.captureRoot, sessionId)
  if (!apiPrompt.available || apiPrompt.text !== prompt) {
    throw new Error('First native model-request Prompt does not exactly match the raw Prompt.')
  }
  const evidence = {
    schemaVersion: 1,
    sessionId,
    status: routingFidelity.validForRoutedExperiment
      ? 'PARITY_VERIFIED_WITH_DECLARED_ROUTING'
      : 'PARITY_FAILED',
    generatedAt: new Date().toISOString(),
    workspace: job.workspace,
    rawPromptSha256: job.promptSha256,
    transcriptPromptSha256: sha256Text(transcriptPrompt),
    apiPromptSha256: apiPrompt.sha256,
    apiPromptRawRef: apiPrompt.rawRef,
    transcriptEntrypoint: correlation.transcript.entrypoint,
    permissionMode: correlation.transcript.permissionMode,
    routingFidelity,
    routingEvidencePath: networkPath,
    declaredDifferences: [
      'Observed native VS Code traffic is routed to port 33333 instead of normal port 23333.',
      'The observed Session runs in a separate visible VS Code process with isolated VS Code user data.',
      'The raw Prompt is prefilled through the official Claude Code URI and submitted by the user.',
    ],
  }
  if (evidence.status !== 'PARITY_VERIFIED_WITH_DECLARED_ROUTING') {
    throw new Error(`Routing parity failed: ${routingFidelity.status}`)
  }
  await atomicJson(path.join(sessionDir, 'parity-manifest.json'), evidence)
  return evidence
}

async function worker(jobDir) {
  const release = await acquireLock(jobDir)
  const leaseRoot = path.dirname(jobDir)
  const leasePath = path.join(leaseRoot, 'observer-runtime.lock')
  let leaseHandle
  let networkMonitor = null
  let heartbeat = null
  try {
    leaseHandle = await open(leasePath, 'wx').catch(error => {
      if (error.code === 'EEXIST') {
        throw new Error('Another observe-claude job owns the shared profile/33333 runtime lease.')
      }
      throw error
    })
    await leaseHandle.writeFile(`${JSON.stringify({ jobDir, pid: process.pid, createdAt: new Date().toISOString() })}\n`)
    let job = await readJson(statePath(jobDir))
    heartbeat = setInterval(() => {
      updateState(jobDir, { heartbeatAt: new Date().toISOString(), workerPid: process.pid }, 'heartbeat')
        .catch(() => undefined)
    }, 5000)

    if (['created', 'preflight'].includes(job.phase)) {
      await updateState(jobDir, { phase: 'preflight', workerPid: process.pid }, 'phase')
      job = await readJson(statePath(jobDir))
      const priorLaunchExists = await exists(path.join(jobDir, 'native-launch.json'))
      if (priorLaunchExists) {
        throw new Error('A preflight-phase job already has launch evidence; automatic relaunch is ambiguous and was refused.')
      }
      await preflight(job, jobDir)
      const profile = await prepareNativeVsCodeProfile({
        rootDir: job.profileRoot,
        workspace: job.workspace,
        captureRoot: job.captureRoot,
        wrapperExecutable: job.wrapperExecutable,
        baselineUserDataDir: DEFAULT_VSCODE_USER_DATA_DIR,
        baselineClaudeConfigDir: job.configDir,
        extensionsDir: DEFAULT_VSCODE_EXTENSIONS_DIR,
      })
      const ledgerCheckpoint = await captureLedgerOffset(job.captureRoot)
      await atomicJson(path.join(jobDir, 'ledger-checkpoint.json'), ledgerCheckpoint)
      const marker = await writeObserverBanner(profile, job.jobId)
      const launchedAt = new Date().toISOString()
      await updateState(jobDir, {
        phase: 'launched',
        launchedAt,
        profile,
        launchIntent: true,
      }, 'launch-intent')
      const launch = await launchNativeVsCode({
        codeCommand: job.codeCommand,
        profile,
        prompt: await readFile(job.promptPath, 'utf8'),
        auditDirectory: path.join(jobDir, 'wrapper-audit'),
      })
      await atomicJson(path.join(jobDir, 'native-launch.json'), { ...launch, launchedAt, marker })
      await updateState(jobDir, {
        phase: 'launched',
        launchedAt,
        vscodePid: launch.pid,
        profile,
        launchIntent: false,
      }, 'phase')
      await updateState(jobDir, { phase: 'awaiting-submit' }, 'phase')
      job = await readJson(statePath(jobDir))
    }

    if (['launched', 'awaiting-submit'].includes(job.phase)) {
      if (job.launchIntent && !(await exists(path.join(jobDir, 'native-launch.json')))) {
        throw new Error('Native launch was interrupted after durable intent; automatic relaunch is refused to prevent a duplicate window.')
      }
      const auditDirectory = path.join(jobDir, 'wrapper-audit')
      const primaryProcessPath = path.join(jobDir, 'primary-process.json')
      let primaryProcess
      if (await exists(primaryProcessPath)) {
        primaryProcess = await readJson(primaryProcessPath)
      } else {
        primaryProcess = await waitForPrimaryNativeClaudeChild({
          auditDirectory,
          timeoutMs: 120_000,
          pollMs: 100,
        })
        await atomicJson(primaryProcessPath, primaryProcess)
        const archivedAuditDirectory = path.join(jobDir, `wrapper-audit-${Date.now()}`)
        await rename(auditDirectory, archivedAuditDirectory)
        await ensureDir(auditDirectory)
        await updateState(jobDir, { childPid: primaryProcess.child.childPid }, 'primary-process-discovered')
      }
      const networkPath = path.join(jobDir, 'network-connections.jsonl')
      if (await exists(networkPath)) {
        throw new Error('Routing monitor evidence already exists before Session discovery; an interrupted epoch cannot be verified continuously.')
      }
      networkMonitor = startProcessTreeMonitor(primaryProcess.child.childPid, networkPath)
      await networkMonitor.ready
      const ledgerCheckpoint = await readJson(path.join(jobDir, 'ledger-checkpoint.json'))
      const correlation = await waitForNativeSession({
        captureRoot: job.captureRoot,
        ledgerCheckpoint,
        configDir: job.configDir,
        workspace: job.workspace,
        expectedPromptSha256: job.promptSha256,
        promptAssessment: async ({ expectedPromptSha256, transcript, sessionId, captureRoot }) => {
          const firstUser = transcript?.firstUser?.message?.content
          const transcriptText = typeof firstUser === 'string'
            ? firstUser
            : Array.isArray(firstUser)
              ? firstUser.filter(block => block?.type === 'text').map(block => block.text).join('')
              : null
          if (sha256Text(transcriptText || '') !== expectedPromptSha256) {
            return { valid: false, reason: 'transcript Prompt hash mismatch' }
          }
          try {
            const apiPrompt = await firstNativeApiEvidence(captureRoot, sessionId)
            return {
              valid: apiPrompt.available && apiPrompt.sha256 === expectedPromptSha256,
              reason: apiPrompt.available ? 'API Prompt hash mismatch' : 'API Prompt unavailable',
            }
          } catch (error) {
            return { valid: false, reason: error.message }
          }
        },
        notBefore: job.launchedAt,
        timeoutMs: 24 * 60 * 60 * 1000,
        pollMs: 500,
      })
      await updateState(jobDir, {
        phase: 'session-discovered',
        sessionId: correlation.sessionId,
        transcriptPath: correlation.transcript.filePath,
        childPid: primaryProcess.child.childPid,
      }, 'phase')
      await updateState(jobDir, { phase: 'running' }, 'phase')
      job = await readJson(statePath(jobDir))
    }

    if (['session-discovered', 'running'].includes(job.phase)) {
      if (!job.sessionId || !job.childPid) throw new Error('Running job lacks Session ID or Claude child PID.')
      const networkPath = path.join(jobDir, 'network-connections.jsonl')
      if (!networkMonitor) {
        throw new Error('Routing monitor continuity was interrupted; routing evidence is unavailable for this job.')
      }
      await waitForNativeSessionIdle({
        userDataDir: job.profile.userDataDir,
        configDir: job.profile.claudeConfigDir,
        sessionId: job.sessionId,
        runningEvidence: true,
        timeoutMs: 24 * 60 * 60 * 1000,
        pollMs: 250,
      })
      await waitForSessionQuiet({
        captureRoot: job.captureRoot,
        sessionId: job.sessionId,
        quietMs: 5000,
        timeoutMs: 60_000,
        pollMs: 250,
      })
      await networkMonitor.stop()
      networkMonitor = null
      const networkRows = (await readFile(networkPath, 'utf8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line))
      const routingFidelity = assessRoutingFidelity({
        requestedEndpoint: job.profile.endpoint,
        rootPid: job.childPid,
        events: networkRows,
      })
      const transcript = await locateTranscript({
        configDir: job.configDir,
        sessionId: job.sessionId,
        workspace: job.workspace,
      })
      const correlation = { sessionId: job.sessionId, transcript }
      const parity = await writeSessionEvidence(job, job.sessionId, correlation, routingFidelity, networkPath)
      await updateState(jobDir, {
        phase: 'idle',
        routingStatus: routingFidelity.status,
        parityStatus: parity.status,
        parityWrittenAt: new Date().toISOString(),
      }, 'phase')
      await updateState(jobDir, { phase: 'replay-building' }, 'phase')
      job = await readJson(statePath(jobDir))
    }

    if (['idle', 'replay-building'].includes(job.phase)) {
      if (!job.sessionId) throw new Error('Replay job lacks Session ID.')
      const parityPath = path.join(job.captureRoot, 'sessions', job.sessionId, 'parity-manifest.json')
      if (!(await exists(parityPath))) throw new Error('Verified parity manifest is missing before replay generation.')
      const parityManifest = await readJson(parityPath)
      if (parityManifest.status !== 'PARITY_VERIFIED_WITH_DECLARED_ROUTING') {
        throw new Error(`Replay requires verified parity, received ${parityManifest.status || 'unknown'}.`)
      }
      await updateState(jobDir, { phase: 'replay-building', parityStatus: parityManifest.status }, 'phase')
      const exchangeCount = await validateCapturedSession(job.captureRoot, job.sessionId)
      const replayPath = path.join(job.captureRoot, 'sessions', job.sessionId, 'runtime-replay.html')
      const previousMtime = (await exists(replayPath)) ? (await stat(replayPath)).mtimeMs : 0
      const replayStartedAt = Date.now()
      await runNotebook(job, job.sessionId)
      if (!(await exists(replayPath))) throw new Error(`Replay HTML was not generated: ${replayPath}`)
      const replayStat = await stat(replayPath)
      if (replayStat.mtimeMs <= previousMtime || replayStat.mtimeMs < replayStartedAt - 1000) {
        throw new Error('Replay HTML was not regenerated by this Notebook invocation.')
      }
      const replayText = await readFile(replayPath, 'utf8')
      const renderedExchangeCount = (replayText.match(/<article class="exchange"/g) || []).length
      if (renderedExchangeCount !== exchangeCount) {
        throw new Error(`Replay rendered ${renderedExchangeCount} of ${exchangeCount} exchanges.`)
      }
      if (replayText.includes('INTEGRITY FAILED')) throw new Error('Replay reports an integrity failure.')
      const parityMatches = replayText.match(/PARITY_VERIFIED_WITH_DECLARED_ROUTING/g) || []
      if (parityMatches.length !== 1) throw new Error('Replay does not contain exactly one verified parity banner.')
      if (!replayText.includes(`Session ${job.sessionId}`)) throw new Error('Replay Session ID does not match the observed Session.')
      await updateState(jobDir, {
        phase: 'completed',
        replayPath,
        replayBytes: replayStat.size,
        exchangeCount,
        completedAt: new Date().toISOString(),
      }, 'phase')
    }
  } catch (error) {
    if (networkMonitor) await networkMonitor.stop().catch(() => undefined)
    await updateState(jobDir, {
      phase: 'failed',
      error: error.stack || String(error),
      failedAt: new Date().toISOString(),
    }, 'failed').catch(() => undefined)
    throw error
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    if (leaseHandle) await leaseHandle.close().catch(() => undefined)
    await rm(leasePath, { force: true }).catch(() => undefined)
    await release()
  }
}

async function start(options) {
  if (!options['request-file']) throw new Error('start requires --request-file <json>.')
  const requestPath = path.resolve(options['request-file'])
  const request = await readJson(requestPath)
  const prompt = validatePromptText(request.prompt)
  if (!prompt.length) throw new Error('Raw Prompt must not be empty.')
  if (typeof request.workspace !== 'string' || !request.workspace.trim()) {
    throw new Error('Request workspace must be the invoking Claude Code cwd.')
  }
  const workspace = path.resolve(request.workspace)
  const jobsRoot = path.resolve(options['jobs-root'] || DEFAULT_JOBS_ROOT)
  const promptSha256 = sha256Text(prompt)
  const jobKey = keyFor(workspace, promptSha256)
  const matchingJobs = (await listJobs(jobsRoot)).filter(job => job.jobKey === jobKey)
  if (matchingJobs.length > 1) throw new Error(`Duplicate jobs exist for Prompt hash ${promptSha256}.`)
  if (matchingJobs.length === 1) {
    const existing = matchingJobs[0]
    if (existing.phase === 'completed') return { resumed: false, job: existing }
    if (existing.phase === 'failed') {
      throw new Error(`Existing job ${existing.jobId} failed; use an explicit retry workflow rather than duplicating the same Prompt key.`)
    }
    if (await processAlive(existing.workerPid) && heartbeatFresh(existing)) return { resumed: true, job: existing }
    const lockPath = path.join(jobsRoot, existing.jobId, 'worker.lock')
    if (await exists(lockPath)) await rm(lockPath, { force: true })
    await spawnWorker(path.join(jobsRoot, existing.jobId))
    return { resumed: true, job: await readJson(statePath(path.join(jobsRoot, existing.jobId))) }
  }

  const jobId = jobKey
  const jobDir = path.join(jobsRoot, jobId)
  await ensureDir(jobsRoot)
  await mkdir(jobDir, { recursive: false }).catch(error => {
    if (error.code === 'EEXIST') {
      throw new Error(`Observe-claude job key was created concurrently: ${jobKey}`)
    }
    throw error
  })
  const promptPath = path.join(jobDir, 'prompt.txt')
  await writeFile(promptPath, prompt, { encoding: 'utf8', flag: 'wx' })
  const job = {
    schemaVersion: CURRENT_VERSION,
    jobId,
    jobKey,
    phase: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requestSource: requestPath,
    workspace,
    promptPath,
    promptSha256,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    promptTransport: exactPromptUriRecord(prompt),
    observerRepo: path.resolve(request.observerRepo || DEFAULT_OBSERVER_REPO),
    profileRoot: path.resolve(request.profileRoot || DEFAULT_PROFILE_ROOT),
    captureRoot: path.resolve(request.captureRoot || DEFAULT_CAPTURE_ROOT),
    notebookPath: path.resolve(DEFAULT_NOTEBOOK),
    pythonExecutable: request.pythonExecutable || process.env.OBSERVER_PYTHON || null,
    wrapperExecutable: path.resolve(
      request.wrapperExecutable || path.join(request.profileRoot || DEFAULT_PROFILE_ROOT, 'bin', 'claude-observer-wrapper.exe'),
    ),
    configDir: path.resolve(request.configDir || path.join(os.homedir(), '.claude')),
    codeCommand: request.codeCommand || DEFAULT_CODE,
  }
  await atomicJson(statePath(jobDir), job)
  await appendEvent(jobDir, 'created', { promptSha256, workspace })
  await spawnWorker(jobDir)
  return { resumed: false, job: await readJson(statePath(jobDir)) }
}

async function resume(options) {
  const selected = await findJob(options)
  if (selected.job.phase === 'completed') return { resumed: false, job: selected.job }
  const lockPath = path.join(selected.jobDir, 'worker.lock')
  if (await exists(lockPath)) {
    const lock = await readJson(lockPath).catch(() => null)
    if (lock && await processAlive(lock.pid) && heartbeatFresh(selected.job)) {
      throw new Error(`Job ${selected.job.jobId} already has a live worker.`)
    }
    await rm(lockPath, { force: true })
  }
  if (selected.job.phase === 'failed') {
    throw new Error(`Job ${selected.job.jobId} failed and requires an explicit new raw-Prompt invocation.`)
  }
  await spawnWorker(selected.jobDir)
  return { resumed: true, job: await readJson(statePath(selected.jobDir)) }
}

async function status(options) {
  const selected = await findJob(options)
  return selected.job
}

async function result(options) {
  const selected = await findJob(options)
  const job = selected.job
  if (job.phase !== 'completed') throw new Error(`Job ${job.jobId} is ${job.phase}, not completed.`)
  return {
    jobId: job.jobId,
    sessionId: job.sessionId,
    exchangeCount: job.exchangeCount,
    parityStatus: job.parityStatus,
    replayPath: job.replayPath,
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv)
  if (command === 'start') return start(options)
  if (command === 'resume') return resume(options)
  if (command === 'status') return status(options)
  if (command === 'result') return result(options)
  if (command === 'worker') return worker(path.resolve(options['job-dir']))
  throw new Error('Use start, status, resume, result, or worker.')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main()
    .then(value => {
      if (value !== undefined) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    })
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
