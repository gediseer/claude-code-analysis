#!/usr/bin/env node
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { importAgentMaestroCapture } from './agent-maestro-capture.mjs'
import { buildApiTurns } from './api-turns.mjs'
import { buildCaseIndex } from './build-case-index.mjs'
import { buildReadableViews } from './build-readable-views.mjs'
import { buildRuntimeDashboard } from './build-runtime-dashboard.mjs'
import { compareRuns } from './compare-runs.mjs'
import { collectSessionArtifacts } from './collect-session-artifacts.mjs'
import { auditCoverage } from './coverage-auditor.mjs'
import { extractFinalReport } from './extract-final-report.mjs'
import {
  atomicReplace,
  createRunId,
  defaultRunsRoot,
  ensureDir,
  exists,
  manifestForTree,
  writeJson,
  writeText,
} from './lib.mjs'
import { sha256Text, validatePromptText, writePromptFidelityAssessment } from './prompt-fidelity.mjs'
import { buildPromptTurns } from './prompt-turns.mjs'
import { assessRoutingFidelity, createProcessTreeTcpMonitor } from './routing-fidelity.mjs'
import { buildStreamView } from './build-stream-view.mjs'
import { buildTeachingReplay } from './teaching-replay.mjs'
import { buildToolLifecycles } from './tool-lifecycles.mjs'
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
  waitForNativeSession,
  waitForNativeSessionIdle,
  waitForSessionQuiet,
} from './vscode-session-correlator.mjs'
import {
  classifyCapturedNativeRequest,
  finalizeParityManifest,
  initialParityManifest,
  readJson,
  writeParityManifest,
} from './vscode-parity.mjs'

function parseArgs(argv) {
  const output = {}
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (!current.startsWith('--')) continue
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      output[current.slice(2)] = next
      index += 1
    } else {
      output[current.slice(2)] = true
    }
  }
  return output
}

async function writeChecksums(runDir) {
  const entries = (await manifestForTree(runDir)).filter(
    row => row.relative !== 'manifest.sha256' && row.relative !== 'manifest.json',
  )
  await writeText(path.join(runDir, 'manifest.sha256'), `${entries.map(row => `${row.sha256}  ${row.relative}`).join('\n')}\n`)
  await writeJson(path.join(runDir, 'manifest.json'), entries)
}

async function firstCapturedRequest(runDir) {
  const apiRoot = path.join(runDir, '05-api')
  const entries = (await import('node:fs/promises')).readdir(apiRoot, { withFileTypes: true })
  let messageRequestCount = 0
  for (const entry of (await entries).filter(item => item.isDirectory() && item.name.startsWith('request-')).sort((a, b) => a.name.localeCompare(b.name))) {
    const parsed = path.join(apiRoot, entry.name, 'request.parsed.json')
    if (!(await exists(parsed))) continue
    const body = JSON.parse(await readFile(parsed, 'utf8'))
    if (!body?.messages) continue
    messageRequestCount += 1
    const assessment = classifyCapturedNativeRequest(body)
    if (assessment.valid) return { body, path: parsed, assessment }
  }
  throw new Error(
    `No native Claude VS Code Messages request passed parity verification among ${messageRequestCount} captured request(s).`,
  )
}

function transcriptEntrypoint(transcript) {
  const record = transcript.records.find(row => row?.type === 'user' && row?.isSidechain !== true)
  return record?.entrypoint || null
}

export function isPrimaryNativeClaudeLaunch(record) {
  const args = Array.isArray(record?.args) ? record.args : []
  return args.includes('--input-format') &&
    args.includes('stream-json') &&
    args.includes('--output-format') &&
    !args.includes('auth')
}

export async function waitForPrimaryNativeClaudeChild({
  auditDirectory,
  timeoutMs = 60_000,
  pollMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs
  let lastDetail = 'wrapper audit directory is unavailable'
  while (Date.now() <= deadline) {
    if (await exists(auditDirectory)) {
      const names = await (await import('node:fs/promises')).readdir(auditDirectory)
      const launches = []
      for (const name of names.filter(item => item.startsWith('launch-') && item.endsWith('.json'))) {
        const record = JSON.parse(await readFile(path.join(auditDirectory, name), 'utf8'))
        if (isPrimaryNativeClaudeLaunch(record)) launches.push({ name, record })
      }
      if (launches.length > 1) {
        throw new Error(`Expected one primary native Claude launch, found ${launches.length}.`)
      }
      if (launches.length === 1) {
        const wrapperPid = launches[0].record.wrapperPid
        const childPath = path.join(auditDirectory, `child-${wrapperPid}.json`)
        if (await exists(childPath)) {
          return {
            launch: launches[0].record,
            child: JSON.parse(await readFile(childPath, 'utf8')),
          }
        }
        lastDetail = `primary wrapper ${wrapperPid} has not recorded its child process yet`
      } else {
        lastDetail = `no primary launch among ${names.length} wrapper audit file(s)`
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  throw new Error(`Timed out waiting for the primary native Claude child: ${lastDetail}`)
}

export function startProcessTreeMonitor(rootPid, outputPath, monitorFactory = createProcessTreeTcpMonitor) {
  const events = []
  let writes = Promise.resolve()
  const monitor = monitorFactory({
    rootPid,
    pollIntervalMs: 250,
    onObservation(event) {
      const row = { timestamp: new Date().toISOString(), ...event }
      events.push(row)
      writes = writes.then(() => import('node:fs/promises').then(({ appendFile }) => appendFile(outputPath, `${JSON.stringify(row)}\n`)))
      return writes
    },
  })
  return {
    events,
    ready: monitor.ready,
    async stop() {
      await monitor.stop?.()
      const stop = { timestamp: new Date().toISOString(), type: 'monitor-stop', completed: true }
      events.push(stop)
      writes = writes.then(() => import('node:fs/promises').then(({ appendFile }) => appendFile(outputPath, `${JSON.stringify(stop)}\n`)))
      await writes
    },
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv)
  if (!options.workspace || options.prompt === undefined) {
    throw new Error('Use --workspace <path> --prompt <exact-user-prompt>.')
  }
  const workspace = path.resolve(options.workspace)
  const prompt = validatePromptText(options.prompt)
  const promptSha256 = sha256Text(prompt)
  const runId = options['run-id'] || createRunId('vscode-native')
  const runsRoot = path.resolve(options['runs-root'] || defaultRunsRoot)
  const finalRunDir = path.join(runsRoot, runId)
  const tempRunDir = `${finalRunDir}.building`
  if (await exists(finalRunDir) || await exists(tempRunDir)) throw new Error(`Run already exists: ${runId}`)

  const observerRepo = path.resolve(
    options['observer-repo'] || path.join(path.resolve(workspace).split(`${path.sep}ClaudeCode${path.sep}`)[0], 'agent-maestro-observer'),
  )
  const profileRoot = path.resolve(options['profile-root'] || path.join(observerRepo, '.observer-native'))
  const captureRoot = path.resolve(options['capture-root'] || path.join(observerRepo, 'data'))
  const wrapperExecutableCandidate = options['wrapper-executable']
    ? path.resolve(options['wrapper-executable'])
    : path.join(profileRoot, 'bin', 'claude-observer-wrapper.exe')
  const preparingOnly = Boolean(options['prepare-only'] || options['dry-run'])
  const wrapperExecutable = await exists(wrapperExecutableCandidate)
    ? wrapperExecutableCandidate
    : preparingOnly
      ? undefined
      : wrapperExecutableCandidate
  const baselineClaudeConfigDir = path.resolve(options['baseline-claude-config-dir'] || path.join(process.env.USERPROFILE || '', '.claude'))
  const codeCommand = options['code-bin']
    ? path.resolve(options['code-bin'])
    : process.platform === 'win32'
      ? 'code.cmd'
      : 'code'
  const baselineUserDataDir = path.resolve(options['baseline-vscode-user-data-dir'] || DEFAULT_VSCODE_USER_DATA_DIR)
  const extensionsDir = path.resolve(options['extensions-dir'] || DEFAULT_VSCODE_EXTENSIONS_DIR)
  const taskDir = path.join(tempRunDir, '00-task')
  const liveDir = path.join(tempRunDir, '01-live-stream')
  const workspaceDir = path.join(tempRunDir, '03-workspace')
  await Promise.all([ensureDir(taskDir), ensureDir(liveDir), ensureDir(workspaceDir)])

  const profile = await prepareNativeVsCodeProfile({
    rootDir: profileRoot,
    workspace,
    captureRoot,
    wrapperExecutable,
    baselineUserDataDir,
    baselineClaudeConfigDir,
    extensionsDir,
  })
  const promptUri = exactPromptUriRecord(prompt)
  const inputProvenance = {
    schemaVersion: 3,
    promptFidelity: {
      mode: 'evidence-unavailable',
      validForPromptBehaviorResearch: false,
      invalidReason: 'The prompt is prefilled in a visible native VS Code panel and has not yet been submitted by the user.',
      observerPromptTransform: 'none',
      exactUnicodeString: null,
    },
    original: {
      available: true,
      text: prompt,
      sha256: promptSha256,
      source: 'observer-prompt',
      parentSessionId: options['parent-session-id'] || null,
      parentMessageId: options['parent-message-id'] || null,
      parentEvidence: { status: 'declared-unverified' },
    },
    launchPrompt: {
      text: prompt,
      sha256: promptSha256,
      bytes: Buffer.byteLength(prompt, 'utf8'),
      source: 'vscode-native-uri-prefill',
      transport: 'official-vscode-uri-prefill',
      terminatorAppended: false,
      submittedBy: 'user',
    },
    childPrompt: {
      text: prompt,
      sha256: promptSha256,
      source: 'vscode-native-uri-prefill',
      status: 'prefill-awaiting-user-submit',
    },
    compiled: { legacy: false, used: false, text: null, sha256: null, compiler: null },
    relation: { type: 'identity-intended', evidence: 'prefill-recorded-child-evidence-pending' },
  }
  const manifest = initialParityManifest({
    runId,
    workspace,
    promptSha256,
    vscode: { command: codeCommand, visible: true },
    extensions: profile.extensions,
    profile: {
      rootDir: profile.rootDir,
      userDataDir: profile.userDataDir,
      claudeConfigDir: profile.claudeConfigDir,
      permissionMode: profile.permissionMode,
      wrapper: profile.wrapperExecutable,
    },
    launchArgs: [],
    environmentDiff: {
      changed: {
        ANTHROPIC_BASE_URL: { from: 'normal 23333 route', to: 'observer 33333 route' },
        endpointSettingsOverlay: { from: 'none', to: profile.routingSettingsPath },
        CLAUDE_CONFIG_DIR: { from: profile.claudeConfigDir, to: profile.claudeConfigDir },
      },
      behaviorOverrides: ['claudeCode.initialPermissionMode=default'],
    },
  })
  await Promise.all([
    writeText(path.join(taskDir, 'task.md'), prompt),
    writeText(path.join(taskDir, 'original-query.md'), prompt),
    writeJson(path.join(taskDir, 'input-provenance.json'), inputProvenance),
    writeParityManifest(tempRunDir, manifest),
    writeJson(path.join(taskDir, 'run-config.json'), {
      runId,
      mode: 'vscode-native-visible',
      sessionId: null,
      workspace,
      profile,
      promptTransport: promptUri,
      routing: { requiredPort: 33333, forbiddenPort: 23333 },
      userActionRequired: true,
      createdAt: new Date().toISOString(),
    }),
    writeText(path.join(workspaceDir, 'README.md'), `Workspace mode: in-place\nObserved path: ${workspace}\nVisible native VS Code UI controls the Session.\n`),
    writeText(path.join(workspaceDir, 'changes.diff'), ''),
  ])

  if (options['prepare-only'] || options['dry-run']) {
    await writeText(path.join(tempRunDir, 'WAITING-FOR-USER.txt'), 'The visible VS Code launch was prepared but not started.\n')
    await writeChecksums(tempRunDir)
    await atomicReplace(tempRunDir, finalRunDir)
    return { runId, runDir: finalRunDir, prepared: true, profile, promptUri }
  }

  const ledgerCheckpoint = await captureLedgerOffset(captureRoot)
  const marker = await writeObserverBanner(profile, runId)
  const launchedAt = new Date().toISOString()
  const launch = await launchNativeVsCode({
    codeCommand: codeCommand,
    profile,
    prompt,
    auditDirectory: path.join(liveDir, 'wrapper-audit'),
    spawnImpl: dependencies.spawnImpl,
  })
  await writeJson(path.join(taskDir, 'native-launch.json'), { ...launch, launchedAt, marker })
  await writeText(
    path.join(tempRunDir, 'WAITING-FOR-USER.txt'),
    'A visible Claude Code for VS Code panel is open. Review the prefilled prompt and press Enter. Resolve permissions in that UI.\n',
  )

  const wrapperAudit = path.join(liveDir, 'wrapper-audit')
  const primaryProcess = await waitForPrimaryNativeClaudeChild({
    auditDirectory: wrapperAudit,
    timeoutMs: Number(options['process-wait-ms'] || 60_000),
    pollMs: Number(options['process-poll-ms'] || 100),
  })
  const childRecord = primaryProcess.child
  const networkPath = path.join(liveDir, 'network-connections.jsonl')
  const networkMonitor = startProcessTreeMonitor(childRecord.childPid, networkPath, dependencies.networkMonitorFactory)
  await networkMonitor.ready

  const correlation = await waitForNativeSession({
    captureRoot,
    ledgerCheckpoint,
    configDir: profile.claudeConfigDir,
    workspace,
    expectedPromptSha256: promptSha256,
    notBefore: launchedAt,
    timeoutMs: Number(options['wait-ms'] || 24 * 60 * 60 * 1000),
    pollMs: Number(options['poll-ms'] || 500),
  })
  const sessionId = correlation.sessionId

  // A native VS Code session stays available after a turn. The extension log
  // provides the exact running → idle boundary while permission prompts remain pending.
  await waitForNativeSessionIdle({
    userDataDir: profile.userDataDir,
    configDir: profile.claudeConfigDir,
    sessionId,
    runningEvidence: correlation.ledgerRows.length > 0,
    timeoutMs: Number(options['settle-timeout-ms'] || 24 * 60 * 60 * 1000),
    pollMs: Number(options['settle-poll-ms'] || 250),
  })
  await waitForSessionQuiet({
    captureRoot,
    sessionId,
    quietMs: Number(options['settle-quiet-ms'] || 5000),
    timeoutMs: Number(options['settle-timeout-ms'] || 24 * 60 * 60 * 1000),
    pollMs: Number(options['settle-poll-ms'] || 250),
  })
  const captureImport = await importAgentMaestroCapture({
    captureRoot,
    sessionId,
    runDir: tempRunDir,
    settleTimeoutMs: Number(options['settle-timeout-ms'] || 24 * 60 * 60 * 1000),
    settleQuietMs: Number(options['import-quiet-ms'] || 500),
    settlePollMs: Number(options['settle-poll-ms'] || 250),
  })
  await networkMonitor.stop()
  const routingFidelity = assessRoutingFidelity({
    requestedEndpoint: profile.endpoint,
    rootPid: childRecord.childPid,
    events: networkMonitor.events,
  })
  await Promise.all([
    writeJson(path.join(taskDir, 'routing-fidelity.json'), routingFidelity),
    writeJson(path.join(taskDir, 'process-result.json'), {
      code: 0,
      signal: null,
      timedOut: false,
      pid: childRecord.childPid,
      lifecycle: 'native-vscode-session-remains-open',
      launchedAt,
      capturedAt: new Date().toISOString(),
    }),
  ])

  await collectSessionArtifacts({
    sessionId,
    runDir: tempRunDir,
    transcriptPath: correlation.transcript.filePath,
    configDir: profile.claudeConfigDir,
  })
  const promptFidelity = await writePromptFidelityAssessment(tempRunDir)
  const request = await firstCapturedRequest(tempRunDir)
  const requestAssessment = request.assessment || classifyCapturedNativeRequest(request.body)
  const runConfigPath = path.join(taskDir, 'run-config.json')
  const finalizedRunConfig = JSON.parse(await readFile(runConfigPath, 'utf8'))
  finalizedRunConfig.sessionId = sessionId
  finalizedRunConfig.profile.permissionMode = correlation.transcript.permissionMode
  await writeJson(runConfigPath, finalizedRunConfig)
  const finalizedParity = finalizeParityManifest(manifest, {
    sessionId,
    transcriptEntrypoint: transcriptEntrypoint(correlation.transcript),
    requestAssessment,
    routingFidelity,
    promptFidelity,
    naturalSessionId: true,
    permissionMode: correlation.transcript.permissionMode,
    nativeUiVisible: true,
    extensionVersionsMatch: true,
  })
  await writeParityManifest(tempRunDir, finalizedParity)
  await rm(path.join(tempRunDir, 'WAITING-FOR-USER.txt'), { force: true })

  let collectionError = null
  try {
    await buildReadableViews({ runDir: tempRunDir })
    await buildStreamView({ runDir: tempRunDir })
    await auditCoverage({ runDir: tempRunDir })
    await buildPromptTurns({ runDir: tempRunDir })
    await buildApiTurns({ runDir: tempRunDir })
    await buildToolLifecycles({ runDir: tempRunDir })
    await buildTeachingReplay({ runDir: tempRunDir })
    await extractFinalReport({ runDir: tempRunDir })
    await buildRuntimeDashboard(tempRunDir)
  } catch (error) {
    collectionError = error.stack || String(error)
    await writeText(path.join(tempRunDir, 'COLLECTION-ERROR.txt'), `${collectionError}\n`)
  }
  await writeChecksums(tempRunDir)
  await atomicReplace(tempRunDir, finalRunDir)
  await buildCaseIndex(runsRoot)
  await compareRuns({ runsRoot })
  const result = {
    runId,
    sessionId,
    runDir: finalRunDir,
    parity: finalizedParity.status,
    routingFidelity,
    promptFidelity,
    captureImport,
    collectionError,
  }
  if (finalizedParity.status !== 'PARITY_VERIFIED_WITH_DECLARED_ROUTING' || collectionError) {
    const error = new Error(`Native VS Code observation did not pass parity verification; artifacts preserved at ${finalRunDir}`)
    error.observedRun = result
    throw error
  }
  return result
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main()
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
