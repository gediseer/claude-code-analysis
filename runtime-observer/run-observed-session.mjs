#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { appendFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main as runNativeVsCodeSession } from './run-native-vscode-session.mjs'
import { finished } from 'node:stream/promises'
import { collectSessionArtifacts } from './collect-session-artifacts.mjs'
import { buildReadableViews } from './build-readable-views.mjs'
import { buildStreamView } from './build-stream-view.mjs'
import { auditCoverage } from './coverage-auditor.mjs'
import { startRecordingProxy } from './recording-proxy.mjs'
import { importAgentMaestroCapture } from './agent-maestro-capture.mjs'
import {
  DEFAULT_OBSERVER_ENDPOINT,
  assessRoutingFidelity,
  createProcessTreeTcpMonitor,
  normalizeObserverEndpoint,
} from './routing-fidelity.mjs'
import { buildTeachingReplay } from './teaching-replay.mjs'
import { buildPromptTurns } from './prompt-turns.mjs'
import { buildToolLifecycles } from './tool-lifecycles.mjs'
import { buildApiTurns } from './api-turns.mjs'
import { buildCaseIndex } from './build-case-index.mjs'
import { compareRuns } from './compare-runs.mjs'
import { extractFinalReport } from './extract-final-report.mjs'
import { buildRuntimeDashboard } from './build-runtime-dashboard.mjs'
import {
  sha256Text,
  validatePromptText,
  writePromptFidelityAssessment,
} from './prompt-fidelity.mjs'
import {
  atomicReplace,
  createRunId,
  defaultProjectSlug,
  defaultRunsRoot,
  ensureDir,
  exists,
  manifestForTree,
  observerDir,
  shellQuote,
  writeJson,
  writeText,
} from './lib.mjs'

function parseArgs(argv) {
  const args = { passthrough: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (current === '--') {
      args.passthrough.push(...argv.slice(index + 1))
      break
    }
    if (!current.startsWith('--')) continue
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      args[current.slice(2)] = next
      index += 1
    } else {
      args[current.slice(2)] = true
    }
  }
  return args
}

async function loadCase(caseArg) {
  const candidate = caseArg.endsWith('.json')
    ? path.resolve(caseArg)
    : path.join(observerDir, 'cases', `${caseArg}.json`)
  const config = JSON.parse(await readFile(candidate, 'utf8'))
  return { config, configPath: candidate }
}

export function sanitizedChildEnv(parentEnv = process.env, envOverrides = {}) {
  const childEnv = { ...parentEnv }
  for (const key of [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_AGENT_SDK_VERSION',
  ]) {
    delete childEnv[key]
  }
  Object.assign(childEnv, envOverrides)
  // Claude Code also reads the env block from user settings and can overwrite
  // ANTHROPIC_BASE_URL after process launch. Pass an explicit per-run settings
  // overlay so the observed child cannot fall back to the normal 23333 route.
  return childEnv
}

export function claudeArgs(config, sessionId, debugFile) {
  const args = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--include-hook-events',
    '--session-id',
    sessionId,
    '--debug-file',
    debugFile,
    '--dangerously-skip-permissions',
    '--no-session-persistence',
  ]

  // Session persistence is needed for transcript/sidechain collection. Remove
  // the flag after constructing the common list so it is hard to accidentally
  // run without a session artifact.
  args.splice(args.indexOf('--no-session-persistence'), 1)

  if (config.systemPrompt || config.appendSystemPrompt) {
    throw new Error(
      'Prompt fidelity violation: Observer-managed system prompts and appended system prompts are not allowed for observed prompt-behavior runs.',
    )
  }
  if (config.settings) args.push('--settings', path.resolve(path.dirname(config.__configPath), config.settings))
  return args
}

export async function spawnAndCapture(command, args, cwd, liveDir, {
  envOverrides = {},
  maxRunMs = null,
  stdinText = '',
  networkMonitorFactory = createProcessTreeTcpMonitor,
  networkPollIntervalMs = 250,
  networkMonitorReadyMs = 5000,
} = {}) {
  const stdoutPath = path.join(liveDir, 'stdout.stream.jsonl')
  const stderrPath = path.join(liveDir, 'stderr.log')
  const eventsPath = path.join(liveDir, 'process-events.jsonl')
  const networkPath = path.join(liveDir, 'network-connections.jsonl')
  await ensureDir(liveDir)
  const stdout = createWriteStream(stdoutPath, { flags: 'wx' })
  const stderr = createWriteStream(stderrPath, { flags: 'wx' })
  const networkEvents = []
  let networkWrites = Promise.resolve()
  const recordNetworkEvent = event => {
    const normalized = { timestamp: new Date().toISOString(), ...event }
    networkEvents.push(normalized)
    networkWrites = networkWrites.then(() => appendFile(networkPath, `${JSON.stringify(normalized)}\n`))
    return networkWrites
  }

  const startedAt = new Date().toISOString()
  const childEnv = sanitizedChildEnv(process.env, envOverrides)
  let child
  try {
    child = spawn(command, args, {
      cwd,
      env: childEnv,
      windowsHide: true,
      shell: false,
    })
  } catch (error) {
    stdout.end()
    stderr.end()
    await Promise.all([finished(stdout), finished(stderr)])
    throw error
  }
  const childSpawnError = new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(null))
    child.once('error', reject)
  })
  try {
    await childSpawnError
  } catch (error) {
    await appendFile(
      eventsPath,
      `${JSON.stringify({ type: 'spawn-error', timestamp: new Date().toISOString(), error: String(error) })}\n`,
    )
    stdout.end()
    stderr.end()
    await Promise.all([finished(stdout), finished(stderr)])
    throw error
  }
  const stdinBytes = Buffer.byteLength(stdinText, 'utf8')
  const stdinSha256 = sha256Text(stdinText)
  await appendFile(
    eventsPath,
    `${JSON.stringify({
      type: 'spawn',
      timestamp: startedAt,
      pid: child.pid,
      command,
      args,
      cwd,
      environment: {
        ANTHROPIC_BASE_URL: childEnv.ANTHROPIC_BASE_URL || null,
      },
      stdin: { transport: 'utf8', bytes: stdinBytes, sha256: stdinSha256 },
    })}\n`,
  )
  child.stdout.pipe(stdout)
  child.stderr.pipe(stderr)

  let networkMonitor = null
  try {
    networkMonitor = networkMonitorFactory({
      rootPid: child.pid,
      onObservation: recordNetworkEvent,
      pollIntervalMs: networkPollIntervalMs,
    })
  } catch (error) {
    await recordNetworkEvent({ type: 'monitor-unavailable', reason: String(error) })
  }

  if (networkMonitor?.ready) {
    const readiness = await Promise.race([
      Promise.resolve(networkMonitor.ready).then(
        () => ({ status: 'ready' }),
        error => ({ status: 'error', error }),
      ),
      new Promise(resolve => setTimeout(
        () => resolve({ status: 'timeout' }),
        Math.max(0, Number(networkMonitorReadyMs) || 0),
      )),
    ])
    if (readiness.status === 'error') {
      await recordNetworkEvent({ type: 'monitor-unavailable', reason: String(readiness.error) })
    } else if (readiness.status === 'timeout') {
      await recordNetworkEvent({
        type: 'monitor-readiness-timeout',
        reason: `No initial TCP evidence sample arrived within ${networkMonitorReadyMs} ms.`,
      })
    }
  }

  // Print mode reads non-TTY stdin as its prompt input. End with the exact
  // string: no Observer-added newline and no positional prompt to concatenate.
  child.stdin.end(stdinText, 'utf8')

  let result
  try {
    result = await new Promise((resolve, reject) => {
      let timeoutRequested = false
      const timeout = Number.isFinite(maxRunMs) && maxRunMs > 0
        ? setTimeout(() => {
            timeoutRequested = true
            child.kill()
            // Explicit test-only timeout: production observation never terminates
            // the child and therefore cannot change its natural completion path.
            setTimeout(() => {
              if (process.platform === 'win32' && child.pid) {
                const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                  windowsHide: true,
                  shell: false,
                })
                killer.unref()
              } else {
                child.kill('SIGKILL')
              }
            }, 5000).unref()
          }, maxRunMs)
        : null
      child.once('error', error => {
        if (timeout) clearTimeout(timeout)
        reject(error)
      })
      child.once('close', (code, signal) => {
        if (timeout) clearTimeout(timeout)
        resolve({
          code,
          signal: timeoutRequested ? 'OBSERVER_TIMEOUT' : signal,
          timedOut: timeoutRequested,
        })
      })
    })
  } finally {
    if (networkMonitor?.stop) {
      try {
        await networkMonitor.stop()
      } catch (error) {
        await recordNetworkEvent({ type: 'monitor-error', error: String(error) })
      }
    }
    await recordNetworkEvent({ type: 'monitor-stop', completed: true })
    await networkWrites
    stdout.end()
    stderr.end()
    await Promise.all([finished(stdout), finished(stderr)])
  }
  await appendFile(
    eventsPath,
    `${JSON.stringify({ type: 'exit', timestamp: new Date().toISOString(), ...result })}\n`,
  )
  return {
    ...result,
    pid: child.pid,
    startedAt,
    endedAt: new Date().toISOString(),
    networkEvents,
  }
}

export async function writeChecksums(runDir) {
  const entries = (await manifestForTree(runDir)).filter(
    row => row.relative !== 'manifest.sha256' && row.relative !== 'manifest.json',
  )
  await writeText(
    path.join(runDir, 'manifest.sha256'),
    `${entries.map(row => `${row.sha256}  ${row.relative}`).join('\n')}\n`,
  )
  await writeJson(path.join(runDir, 'manifest.json'), entries)
}

async function createObservedRun(config, configPath, options, dependencies = {}) {
  config.__configPath = configPath
  const runId = options['run-id'] || createRunId(config.id)
  const sessionId = options['session-id'] || randomUUID()
  const finalRunDir = path.join(options['runs-root'] || defaultRunsRoot, runId)
  const tempRunDir = `${finalRunDir}.building`
  const prompt = options.prompt ?? options.task ?? config.prompt ?? config.task
  validatePromptText(prompt)
  const declaredOriginalQuery = options['original-query'] ?? config.input?.original?.text
  if (declaredOriginalQuery !== undefined && declaredOriginalQuery !== prompt) {
    throw new Error(
      'Prompt fidelity violation: --original-query must exactly equal the prompt sent to the child. Observer prompt compilation is no longer supported.',
    )
  }
  const legacyCompiler = options['task-compiler'] ?? config.input?.compiler
  if (legacyCompiler && legacyCompiler !== 'identity') {
    throw new Error(
      'Prompt fidelity violation: --task-compiler is legacy-only. Send the exact user prompt and use separate CLI controls for endpoint, workspace, permissions, model, timeout, and budgets.',
    )
  }
  const promptSha256 = sha256Text(prompt)
  const requestedEndpoint = normalizeObserverEndpoint(
    options.endpoint ?? config.endpoint ?? DEFAULT_OBSERVER_ENDPOINT,
  )
  const observerUpstreamControl = options['observer-upstream'] ?? config.observerUpstream ?? null
  const agentMaestroCaptureRootControl =
    options['agent-maestro-capture-root'] ?? config.agentMaestroCaptureRoot ?? null
  if (observerUpstreamControl && agentMaestroCaptureRootControl) {
    throw new Error(
      'Capture control conflict: use either --observer-upstream for the local fake-upstream proxy or --agent-maestro-capture-root for direct Agent Maestro evidence, never both.',
    )
  }
  const agentMaestroSettleTimeoutMs = Number(
    options['agent-maestro-settle-timeout-ms'] ?? config.agentMaestroSettleTimeoutMs ?? 5000,
  )
  const agentMaestroSettleQuietMs = Number(
    options['agent-maestro-settle-quiet-ms'] ?? config.agentMaestroSettleQuietMs ?? 250,
  )
  const agentMaestroSettlePollMs = Number(
    options['agent-maestro-settle-poll-ms'] ?? config.agentMaestroSettlePollMs ?? 50,
  )
  const parentSessionId = options['parent-session-id'] ?? config.input?.original?.parentSessionId ?? null
  const parentMessageId = options['parent-message-id'] ?? config.input?.original?.parentMessageId ?? null
  const inputProvenance = {
    schemaVersion: 3,
    promptFidelity: {
      mode: 'evidence-unavailable',
      validForPromptBehaviorResearch: false,
      invalidReason: 'Child transcript and first model-request evidence are not available until after launch.',
      observerPromptTransform: 'none',
      exactUnicodeString: null,
    },
    original: {
      available: true,
      text: prompt,
      sha256: promptSha256,
      source: declaredOriginalQuery === undefined ? 'observer-prompt' : 'observer-cli-original-query',
      parentSessionId,
      parentMessageId,
      parentEvidence: parentSessionId || parentMessageId
        ? {
            status: 'declared-unverified',
            reason: 'Parent identifiers were supplied, but this run did not capture and resolve the parent transcript message.',
          }
        : { status: 'not-supplied' },
    },
    launchPrompt: {
      text: prompt,
      sha256: promptSha256,
      bytes: Buffer.byteLength(prompt, 'utf8'),
      source: 'observer-stdin-utf8',
      transport: 'stdin',
      terminatorAppended: false,
    },
    childPrompt: {
      text: prompt,
      sha256: promptSha256,
      source: 'observer-stdin-utf8',
      status: 'launch-input-only',
    },
    compiled: {
      legacy: true,
      used: false,
      text: null,
      sha256: null,
      compiler: null,
      note: 'Legacy field retained for schema compatibility; new runs do not compile or rewrite prompts.',
    },
    relation: {
      type: 'identity-intended',
      evidence: 'launch-input-recorded-child-evidence-pending',
    },
  }
  if (await exists(finalRunDir)) {
    throw new Error(`Run directory already exists; choose a new --run-id: ${finalRunDir}`)
  }
  if (await exists(tempRunDir)) {
    throw new Error(`Run build directory already exists; inspect or remove it: ${tempRunDir}`)
  }
  const taskDir = path.join(tempRunDir, '00-task')
  const liveDir = path.join(tempRunDir, '01-live-stream')
  const workspaceDir = path.join(tempRunDir, '03-workspace')
  const fixtureDir = path.isAbsolute(config.workspace)
    ? config.workspace
    : path.resolve(path.dirname(configPath), config.workspace)
  // Observation must not change the child's workspace or tool behavior. Run in
  // the requested workspace and let Claude Code expose its normal tool surface.
  if (config.workspaceMode && config.workspaceMode !== 'in-place') {
    throw new Error('Observer workspace isolation is not supported because it changes the observed execution path.')
  }
  const workspaceMode = 'in-place'
  const workDir = fixtureDir
  await Promise.all([
    ensureDir(taskDir),
    ensureDir(liveDir),
    ensureDir(workspaceDir),
  ])
  const debugFile = path.join(liveDir, 'debug.log')
  const installedNativeBinary = path.join(
    path.dirname(process.execPath),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  )
  const command =
    options['claude-bin'] ||
    process.env.CLAUDE_BIN ||
    ((await exists(installedNativeBinary)) ? installedNativeBinary : 'claude')
  const endpointSettingsPath = path.join(taskDir, 'observer-endpoint-settings.json')
  await writeJson(endpointSettingsPath, {
    env: {
      ANTHROPIC_BASE_URL: requestedEndpoint,
    },
  })
  const runConfig = {
    ...config,
    settings: endpointSettingsPath,
  }
  const args = claudeArgs(runConfig, sessionId, debugFile)
  await Promise.all([
    writeText(path.join(taskDir, 'task.md'), prompt),
    writeText(path.join(taskDir, 'original-query.md'), prompt),
    writeJson(path.join(taskDir, 'input-provenance.json'), inputProvenance),
    writeText(path.join(taskDir, 'command.txt'), `${command} ${args.map(shellQuote).join(' ')}\n`),
    writeJson(path.join(taskDir, 'run-config.json'), {
      runId,
      sessionId,
      case: config,
      fixtureDir,
      workDir,
      workspaceMode,
      command,
      args,
      input: inputProvenance,
      observer: {
        version: 6,
        captureProfile: config.observer?.captureProfile || 'legacy-headless-nonparity',
        apiCaptureMode: observerUpstreamControl
          ? 'runtime-observer-fake-upstream-proxy'
          : agentMaestroCaptureRootControl
            ? 'agent-maestro-direct-import'
            : 'unavailable',
        recordingProxyExpected: Boolean(observerUpstreamControl),
        agentMaestroCaptureExpected: Boolean(agentMaestroCaptureRootControl),
        agentMaestroCaptureRoot: agentMaestroCaptureRootControl
          ? path.resolve(agentMaestroCaptureRootControl)
          : null,
        agentMaestroSettle: agentMaestroCaptureRootControl
          ? {
              timeoutMs: agentMaestroSettleTimeoutMs,
              quietMs: agentMaestroSettleQuietMs,
              pollMs: agentMaestroSettlePollMs,
            }
          : null,
        runtimeModel: 'runtime-observer/runtime-model.mjs',
      },
      routing: {
        requestedEndpoint,
        childEndpointMode: 'direct',
        requiredLocalPort: 33333,
        forbiddenLocalPort: 23333,
        evidenceArtifact: '01-live-stream/network-connections.jsonl',
      },
      environment: {
        ANTHROPIC_BASE_URL: {
          source: 'observer-endpoint-control',
          value: requestedEndpoint,
        },
        ANTHROPIC_API_KEY: { present: Boolean(process.env.ANTHROPIC_API_KEY) },
        ANTHROPIC_AUTH_TOKEN: { present: Boolean(process.env.ANTHROPIC_AUTH_TOKEN) },
        CLAUDE_CONFIG_DIR: { present: Boolean(process.env.CLAUDE_CONFIG_DIR), value: process.env.CLAUDE_CONFIG_DIR || null },
      },
      promptTransport: {
        type: 'stdin',
        encoding: 'utf8',
        bytes: Buffer.byteLength(prompt, 'utf8'),
        sha256: promptSha256,
        terminatorAppended: false,
      },
      createdAt: new Date().toISOString(),
    }),
  ])

  if (options['dry-run']) {
    await writeText(path.join(tempRunDir, 'DRY-RUN.txt'), 'Claude Code was not launched.\n')
    await writeJson(
      path.join(taskDir, 'routing-fidelity.json'),
      assessRoutingFidelity({ requestedEndpoint, dryRun: true }),
    )
    await writePromptFidelityAssessment(tempRunDir)
    await writeChecksums(tempRunDir)
    await atomicReplace(tempRunDir, finalRunDir)
    return { runId, sessionId, runDir: finalRunDir, dryRun: true }
  }

  const requestedEndpointUrl = new URL(requestedEndpoint)
  const endpointPort = Number(requestedEndpointUrl.port || (requestedEndpointUrl.protocol === 'https:' ? 443 : 80))
  if (
    requestedEndpointUrl.protocol !== 'http:' ||
    requestedEndpointUrl.hostname !== '127.0.0.1' ||
    endpointPort !== 33333 ||
    requestedEndpointUrl.pathname !== '/api/anthropic'
  ) {
    throw new Error(
      `Routing-fidelity endpoint must be http://127.0.0.1:33333/api/anthropic; received ${requestedEndpoint}`,
    )
  }
  let recordingProxy = null
  let processResult
  let spawnError = null
  try {
    if (observerUpstreamControl) {
      recordingProxy = await startRecordingProxy({
        upstreamBaseUrl: observerUpstreamControl,
        outputDir: path.join(tempRunDir, '05-api'),
        ownedSystemPrompt: null,
        listenPort: 33333,
      })
    }
    processResult = await spawnAndCapture(command, args, workDir, liveDir, {
      envOverrides: {
        ANTHROPIC_BASE_URL: requestedEndpoint,
      },
      stdinText: prompt,
      networkMonitorFactory: dependencies.networkMonitorFactory || createProcessTreeTcpMonitor,
      networkPollIntervalMs: Number(options['network-poll-ms'] || 250),
      networkMonitorReadyMs: Number(options['network-ready-ms'] || 5000),
    })
  } catch (error) {
    spawnError = error
    processResult = {
      code: null,
      signal: 'SPAWN_ERROR',
      timedOut: false,
      pid: null,
      startedAt: null,
      endedAt: new Date().toISOString(),
      networkEvents: [{
        type: 'monitor-unavailable',
        timestamp: new Date().toISOString(),
        reason: `Child launch or capture failed before complete network evidence: ${error}`,
      }],
      spawnError: error.stack || String(error),
    }
  } finally {
    await recordingProxy?.close()
  }

  let agentMaestroCaptureImport = null
  let apiCaptureError = null
  if (agentMaestroCaptureRootControl && processResult.pid !== null) {
    try {
      agentMaestroCaptureImport = await importAgentMaestroCapture({
        captureRoot: agentMaestroCaptureRootControl,
        sessionId,
        runDir: tempRunDir,
        settleTimeoutMs: agentMaestroSettleTimeoutMs,
        settleQuietMs: agentMaestroSettleQuietMs,
        settlePollMs: agentMaestroSettlePollMs,
      })
      if (agentMaestroCaptureImport.status !== 'imported') {
        apiCaptureError =
          `Agent Maestro capture evidence is unavailable: ${agentMaestroCaptureImport.reason}`
      }
    } catch (error) {
      apiCaptureError = error.stack || String(error)
    }
  }
  await writeText(
    path.join(workspaceDir, 'README.md'),
    `Workspace mode: in-place\nObserved path: ${workDir}\nObserver did not copy, sandbox, or constrain the workspace.\n`,
  )
  await writeText(path.join(workspaceDir, 'changes.diff'), '')

  const routingFidelity = assessRoutingFidelity({
    requestedEndpoint,
    rootPid: processResult.pid,
    events: processResult.networkEvents,
  })
  // Network events are kept in their dedicated JSONL artifact; avoid duplicating
  // the full sampling history into process-result.json.
  const { networkEvents: _networkEvents, ...persistedProcessResult } = processResult

  // Persist the actual process outcome before Coverage/Replay derivation. The
  // auditors must never infer a successful run merely from transcript presence.
  await Promise.all([
    writeJson(path.join(taskDir, 'process-result.json'), persistedProcessResult),
    writeJson(path.join(taskDir, 'routing-fidelity.json'), routingFidelity),
  ])

  let collectionError = apiCaptureError
  try {
    await collectSessionArtifacts({ sessionId, runDir: tempRunDir, projectSlug: defaultProjectSlug })
    await writePromptFidelityAssessment(tempRunDir)
    await buildReadableViews({ runDir: tempRunDir })
    await buildStreamView({ runDir: tempRunDir })
    const coverage = await auditCoverage({ runDir: tempRunDir })
    if (coverage.summary.requiredMissing > 0 || coverage.summary.invariantFailures > 0) {
      throw new Error(
        `Observer coverage failed: ${coverage.summary.requiredMissing} required point(s) missing, ${coverage.summary.invariantFailures} lifecycle invariant(s) failed. See 04-readable/13-CAPTURE-COVERAGE.md`,
      )
    }
    if (apiCaptureError) throw new Error(apiCaptureError)
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
  if (await exists(finalRunDir)) {
    throw new Error(`Run directory already exists; refusing to overwrite: ${finalRunDir}`)
  }
  await atomicReplace(tempRunDir, finalRunDir)
  const runsRoot = options['runs-root'] || defaultRunsRoot
  await buildCaseIndex(runsRoot)
  await compareRuns({ runsRoot })
  const result = {
    runId,
    sessionId,
    runDir: finalRunDir,
    processResult: persistedProcessResult,
    routingFidelity,
    agentMaestroCaptureImport,
    collectionError,
  }
  if (
    collectionError ||
    spawnError ||
    processResult.timedOut ||
    processResult.code !== 0 ||
    !routingFidelity.validForRoutedExperiment
  ) {
    const routingSuffix = routingFidelity.validForRoutedExperiment
      ? ''
      : ` (${routingFidelity.status}: ${routingFidelity.invalidReason})`
    const error = new Error(
      `Observed Run is incomplete, failed, or routing-invalid${routingSuffix}; artifacts were preserved at ${finalRunDir}`,
    )
    error.observedRun = result
    throw error
  }
  return result
}

async function replayExisting(options) {
  const sessionId = options['replay-session']
  const runId = options['run-id'] || `case-00-current-session-${sessionId.slice(0, 8)}`
  const finalRunDir = path.join(options['runs-root'] || defaultRunsRoot, runId)
  const tempRunDir = `${finalRunDir}.building`
  await rm(tempRunDir, { recursive: true, force: true })
  await ensureDir(path.join(tempRunDir, '00-task'))
  await writeText(
    path.join(tempRunDir, '00-task', 'task.md'),
    `Replay existing Claude Code session ${sessionId}.\n`,
  )
  await writeJson(path.join(tempRunDir, '00-task', 'run-config.json'), {
    runId,
    sessionId,
    mode: 'existing-session-replay',
    createdAt: new Date().toISOString(),
  })
  await collectSessionArtifacts({ sessionId, runDir: tempRunDir, projectSlug: options['project-slug'] || defaultProjectSlug })
  await buildReadableViews({ runDir: tempRunDir })
  await buildStreamView({ runDir: tempRunDir })
  await auditCoverage({ runDir: tempRunDir })
  await buildPromptTurns({ runDir: tempRunDir })
  await buildApiTurns({ runDir: tempRunDir })
  await buildToolLifecycles({ runDir: tempRunDir })
  await buildTeachingReplay({ runDir: tempRunDir })
  await extractFinalReport({ runDir: tempRunDir })
  await buildRuntimeDashboard(tempRunDir)
  await writeChecksums(tempRunDir)
  await rm(finalRunDir, { recursive: true, force: true })
  await atomicReplace(tempRunDir, finalRunDir)
  const runsRoot = options['runs-root'] || defaultRunsRoot
  await buildCaseIndex(runsRoot)
  await compareRuns({ runsRoot })
  return { runId, sessionId, runDir: finalRunDir, replay: true }
}

function adHocCase(options) {
  const prompt = options.prompt ?? options.task
  if (!options.workspace || prompt === undefined) return null
  return {
    configPath: path.join(observerDir, 'cases', 'ad-hoc.json'),
    config: {
      id: options.id || 'ad-hoc',
      title: options.title || 'Ad-hoc observed Claude Code case',
      workspace: path.resolve(options.workspace),
      prompt,
      input: options['original-query'] === undefined
        ? undefined
        : {
            original: {
              text: options['original-query'],
              parentSessionId: options['parent-session-id'] || null,
              parentMessageId: options['parent-message-id'] || null,
            },
          },
      endpoint: options.endpoint,
      interactive: false,
    },
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv)
  if (options['replay-session']) return replayExisting(options)
  if ((options['dry-run'] || options['prepare-only']) && !options['legacy-headless-nonparity']) {
    return runNativeVsCodeSession(argv, dependencies)
  }
  if (options['legacy-headless-nonparity']) {
    const selected = options.case ? await loadCase(options.case) : adHocCase(options)
    if (!selected) {
      throw new Error('Legacy headless mode requires --case or --workspace/--prompt.')
    }
    selected.config.observer = {
      ...(selected.config.observer || {}),
      captureProfile: 'legacy-headless-nonparity',
    }
    return createObservedRun(selected.config, selected.configPath, options, dependencies)
  }
  if (options.case) {
    const selected = await loadCase(options.case)
    const prompt = selected.config.prompt ?? selected.config.task
    const workspace = path.isAbsolute(selected.config.workspace)
      ? selected.config.workspace
      : path.resolve(path.dirname(selected.configPath), selected.config.workspace)
    const nativeArgv = [...argv.filter((value, index) => {
      if (value === '--case') return false
      if (index > 0 && argv[index - 1] === '--case') return false
      return true
    }), '--workspace', workspace, '--prompt', prompt]
    return runNativeVsCodeSession(nativeArgv, dependencies)
  }
  return runNativeVsCodeSession(argv, dependencies)
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main()
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
