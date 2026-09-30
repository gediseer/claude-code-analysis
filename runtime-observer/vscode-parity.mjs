#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { exists, writeJson } from './lib.mjs'

export const PARITY_VERIFIED = 'PARITY_VERIFIED_WITH_DECLARED_ROUTING'
export const PARITY_UNVERIFIED = 'PARITY_UNVERIFIED'
export const PARITY_FAILED = 'PARITY_FAILED'
export const LEGACY_HEADLESS_NONPARITY = 'LEGACY_HEADLESS_NONPARITY'

export const BASELINE_KIND = 'vscode-native-visible'
export const REQUIRED_ENTRYPOINT = 'claude-vscode'
export const REQUIRED_SYSTEM_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
export const REQUIRED_ENDPOINT = 'http://127.0.0.1:33333/api/anthropic'

const FORBIDDEN_LAUNCH_CONTROLS = Object.freeze([
  '-p',
  '--print',
  '--tools',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--model',
  '--effort',
  '--max-budget-usd',
  '--max-turns',
  '--task-budget',
  '--system-prompt',
  '--append-system-prompt',
  '--session-id',
  '--debug-file',
  '--setting-sources',
])

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

export async function fileIdentity(filePath) {
  const bytes = await readFile(filePath)
  return {
    path: path.resolve(filePath),
    bytes: bytes.length,
    sha256: sha256Bytes(bytes),
  }
}

export function inspectLaunchArguments(args = []) {
  const forbidden = []
  for (const argument of args) {
    const text = String(argument)
    const control = FORBIDDEN_LAUNCH_CONTROLS.find(
      candidate => text === candidate || text.startsWith(`${candidate}=`),
    )
    if (control && !forbidden.includes(control)) forbidden.push(control)
  }
  return { valid: forbidden.length === 0, forbidden }
}

export function systemText(requestBody) {
  const system = requestBody?.system
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

export function requestToolNames(requestBody) {
  return (Array.isArray(requestBody?.tools) ? requestBody.tools : [])
    .map(tool => tool?.name)
    .filter(name => typeof name === 'string')
}

export function classifyCapturedNativeRequest(requestBody) {
  const text = systemText(requestBody)
  const entrypointPrefix = text.includes(REQUIRED_SYSTEM_PREFIX)
  const headlessPrefix = text.includes('You are a Claude agent, built on Anthropic')
  const toolNames = requestToolNames(requestBody)
  const requiredTools = ['Bash', 'Edit', 'Read', 'Agent']
  const missingTools = requiredTools.filter(name => !toolNames.includes(name))
  return {
    entrypointPrefix,
    headlessPrefix,
    toolNames,
    missingTools,
    valid:
      entrypointPrefix &&
      !headlessPrefix &&
      missingTools.length === 0,
  }
}

export function initialParityManifest({
  runId,
  workspace,
  promptSha256,
  endpoint = REQUIRED_ENDPOINT,
  vscode,
  extensions,
  profile,
  launchArgs = [],
  environmentDiff,
} = {}) {
  const launchInspection = inspectLaunchArguments(launchArgs)
  const failures = []
  if (!launchInspection.valid) {
    failures.push(`Behavior-changing launch controls: ${launchInspection.forbidden.join(', ')}`)
  }
  if (endpoint !== REQUIRED_ENDPOINT) failures.push(`Unexpected observer endpoint: ${endpoint}`)
  return {
    schemaVersion: 1,
    baseline: {
      kind: BASELINE_KIND,
      description: 'Visible Claude Code for VS Code native conversation in the same workspace.',
    },
    runId,
    createdAt: new Date().toISOString(),
    status: failures.length ? PARITY_FAILED : PARITY_UNVERIFIED,
    failures,
    declaredDifferences: [
      'Anthropic-compatible HTTP traffic is routed to local Observer port 33333 instead of normal port 23333.',
      'The experiment runs in a separate visible VS Code process with isolated VS Code user data.',
      'New observed conversations start in Manual/default permission mode so the user can see and decide every approval.',
      'The initial prompt is prefilled through the official Claude Code VS Code URI and submitted by the user.',
      'Observer process and TCP sampling may add measurement overhead.',
      'An endpoint-only --settings overlay is appended by the transparent process wrapper after the native extension arguments.',
    ],
    invariants: {
      visibleNativeUi: true,
      userSubmitsPrompt: true,
      userResolvesPermissions: true,
      observerAutoApprovesPermissions: false,
      manualPermissionModeIsDeclaredDifference: true,
      naturalSessionId: true,
      endpoint,
      requiredEntrypoint: REQUIRED_ENTRYPOINT,
      requiredSystemPrefix: REQUIRED_SYSTEM_PREFIX,
      forbiddenLaunchControls: FORBIDDEN_LAUNCH_CONTROLS,
      launchInspection,
    },
    workspace: path.resolve(workspace),
    prompt: { sha256: promptSha256 },
    vscode,
    extensions,
    profile,
    environmentDiff,
    evidence: {},
  }
}

export function finalizeParityManifest(manifest, {
  sessionId,
  transcriptEntrypoint,
  requestAssessment,
  routingFidelity,
  promptFidelity,
  naturalSessionId = true,
  permissionMode,
  nativeUiVisible = true,
  extensionVersionsMatch = true,
} = {}) {
  const failures = [...(manifest.failures || [])]
  const unverifiable = []
  if (!nativeUiVisible) failures.push('The native Claude Code VS Code UI was not visible.')
  if (!naturalSessionId) failures.push('The Session ID was supplied instead of naturally generated.')
  if (transcriptEntrypoint !== REQUIRED_ENTRYPOINT) {
    failures.push(`Transcript entrypoint is ${transcriptEntrypoint || 'unavailable'}, not ${REQUIRED_ENTRYPOINT}.`)
  }
  if (!requestAssessment?.valid) {
    failures.push('The first model request does not have the native VS Code system identity and default tool surface.')
  }
  if (!routingFidelity?.validForRoutedExperiment) {
    failures.push(`Routing fidelity failed: ${routingFidelity?.status || 'unavailable'}.`)
  }
  if (!promptFidelity?.validForPromptBehaviorResearch) {
    failures.push(`Prompt fidelity failed: ${promptFidelity?.mode || 'unavailable'}.`)
  }
  if (!extensionVersionsMatch) failures.push('Observer and baseline extension versions do not match.')
  if (!permissionMode) unverifiable.push('The effective initial permission mode was not captured.')
  else if (!['default', 'manual'].includes(permissionMode)) {
    failures.push(`Initial permission mode is ${permissionMode}, not Manual/default.`)
  }

  return {
    ...manifest,
    finalizedAt: new Date().toISOString(),
    status: failures.length
      ? PARITY_FAILED
      : unverifiable.length
        ? PARITY_UNVERIFIED
        : PARITY_VERIFIED,
    failures,
    unverifiable,
    evidence: {
      ...manifest.evidence,
      sessionId,
      transcriptEntrypoint,
      requestAssessment,
      routingFidelityStatus: routingFidelity?.status || null,
      promptFidelityMode: promptFidelity?.mode || null,
      permissionMode: permissionMode || null,
      naturalSessionId,
      nativeUiVisible,
      extensionVersionsMatch,
    },
  }
}

export async function readJson(filePath, fallback = null) {
  if (!(await exists(filePath))) return fallback
  return JSON.parse(await readFile(filePath, 'utf8'))
}

export async function writeParityManifest(runDir, manifest) {
  await writeJson(path.join(runDir, '00-task', 'parity-manifest.json'), manifest)
  return manifest
}
