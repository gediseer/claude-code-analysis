#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureDir, exists, walkFiles, writeJson, writeText } from './lib.mjs'
import { BASELINE_KIND, REQUIRED_ENDPOINT, fileIdentity } from './vscode-parity.mjs'

export const DEFAULT_VSCODE_USER_DATA_DIR = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'Code',
)
export const DEFAULT_VSCODE_EXTENSIONS_DIR = path.join(os.homedir(), '.vscode', 'extensions')
export const OBSERVER_PROFILE_NAME = 'Claude Observer Native'

const EXTENSION_IDS = Object.freeze({
  claude: 'anthropic.claude-code',
  officialMaestro: 'joouis.agent-maestro',
  observerMaestro: 'local-observer.agent-maestro-observer',
})

const SECRET_FIELD = /(?:token|secret|password|api[-_]?key|credential|authorization|cookie)/i

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function redactSecrets(value, key = '') {
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, key))
  if (!value || typeof value !== 'object') return SECRET_FIELD.test(key) ? '[NOT_RECORDED]' : value
  return Object.fromEntries(
    Object.entries(value).map(([name, child]) => [
      name,
      SECRET_FIELD.test(name) ? '[NOT_RECORDED]' : redactSecrets(child, name),
    ]),
  )
}

export function observerPromptUri(prompt) {
  const query = new URLSearchParams({ prompt })
  return `vscode://${EXTENSION_IDS.claude}/open?${query.toString()}`
}

export function exactPromptUriRecord(prompt) {
  const uri = observerPromptUri(prompt)
  return {
    uri,
    promptSha256: sha256Text(prompt),
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    behavior: 'prefill-only-user-submits',
  }
}

export async function findInstalledExtension(extensionsDir, extensionId) {
  const registryPath = path.join(extensionsDir, 'extensions.json')
  let activeDirectory = null
  if (await exists(registryPath)) {
    const registry = JSON.parse(await readFile(registryPath, 'utf8'))
    const active = registry.filter(row => row?.identifier?.id?.toLowerCase() === extensionId.toLowerCase())
    if (active.length === 1) {
      const location = active[0]?.location
      const registryLocation = location?.fsPath || location?.path
      if (typeof registryLocation === 'string') {
        activeDirectory = path.resolve(registryLocation.replace(/^\/(\w:\/)/, '$1'))
      }
    }
  }
  const entries = await readdir(extensionsDir, { withFileTypes: true })
  const prefix = `${extensionId.toLowerCase()}-`
  const candidates = entries
    .filter(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix))
    .map(entry => path.join(extensionsDir, entry.name))
  const selected = activeDirectory || (candidates.length === 1 ? candidates[0] : null)
  if (!selected) {
    throw new Error(
      candidates.length === 0
        ? `Required VS Code extension is not installed: ${extensionId}`
        : `VS Code extension registry does not identify the active ${extensionId} directory:\n${candidates.join('\n')}`,
    )
  }
  const manifestPath = path.join(selected, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const actualId = `${manifest.publisher}.${manifest.name}`.toLowerCase()
  if (actualId !== extensionId.toLowerCase()) {
    throw new Error(`Extension identity mismatch: expected ${extensionId}, received ${actualId}`)
  }
  const mainPath = manifest.main ? path.join(selected, manifest.main) : null
  const nativeBinary = extensionId === EXTENSION_IDS.claude
    ? path.join(selected, 'resources', 'native-binary', 'claude.exe')
    : null
  return {
    id: extensionId,
    version: manifest.version,
    directory: selected,
    manifest: await fileIdentity(manifestPath),
    main: mainPath && await exists(mainPath) ? await fileIdentity(mainPath) : null,
    nativeBinary: nativeBinary && await exists(nativeBinary) ? await fileIdentity(nativeBinary) : null,
  }
}

export async function extensionParity(extensionsDir = DEFAULT_VSCODE_EXTENSIONS_DIR) {
  const rows = {}
  for (const [role, extensionId] of Object.entries(EXTENSION_IDS)) {
    rows[role] = await findInstalledExtension(extensionsDir, extensionId)
  }
  return rows
}

function nativeVsCodeSettings({ captureRoot }) {
  return {
    'claudeCode.useTerminal': false,
    'claudeCode.initialPermissionMode': 'default',
    'claudeCode.allowDangerouslySkipPermissions': false,
    'claudeCode.environmentVariables': [
      { name: 'ANTHROPIC_BASE_URL', value: REQUIRED_ENDPOINT },
    ],
    'agent-maestro-observer.proxyServerPort': 33333,
    'agent-maestro-observer.observer.enabled': true,
    'agent-maestro-observer.observer.failureMode': 'strict',
    'agent-maestro-observer.observer.maxBodyBytes': 1073741824,
    'agent-maestro-observer.observer.outputDirectory': captureRoot,
    'agent-maestro.proxyServerPort': 23333,
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'update.mode': 'none',
    'security.workspace.trust.enabled': true,
    'window.restoreWindows': 'none',
  }
}

export async function prepareNativeVsCodeProfile({
  rootDir,
  workspace,
  captureRoot,
  wrapperExecutable,
  baselineUserDataDir = DEFAULT_VSCODE_USER_DATA_DIR,
  baselineClaudeConfigDir = path.join(os.homedir(), '.claude'),
  extensionsDir = DEFAULT_VSCODE_EXTENSIONS_DIR,
} = {}) {
  if (!rootDir || !workspace || !captureRoot) throw new Error('rootDir, workspace, and captureRoot are required')
  const userDataDir = path.join(rootDir, 'user-data')
  const claudeConfigDir = baselineClaudeConfigDir
  const profileSettingsPath = path.join(userDataDir, 'User', 'settings.json')
  const baselineVsCodeSettingsPath = path.join(baselineUserDataDir, 'User', 'settings.json')
  const baselineClaudeSettingsPath = path.join(baselineClaudeConfigDir, 'settings.json')

  const extensions = await extensionParity(extensionsDir)
  const baselineVsCodeSettings = await exists(baselineVsCodeSettingsPath)
    ? JSON.parse(await readFile(baselineVsCodeSettingsPath, 'utf8'))
    : {}
  if (!(await exists(baselineClaudeSettingsPath))) {
    throw new Error(`Baseline Claude settings are unavailable: ${baselineClaudeSettingsPath}`)
  }
  const baselineClaudeSettings = JSON.parse(await readFile(baselineClaudeSettingsPath, 'utf8'))

  const observerVsCodeSettings = {
    ...baselineVsCodeSettings,
    ...nativeVsCodeSettings({ captureRoot: path.resolve(captureRoot) }),
  }
  // Environment variables are a launch boundary, not ordinary editor behavior.
  // Never copy the baseline list because it may contain credentials or 23333.
  observerVsCodeSettings['claudeCode.environmentVariables'] = nativeVsCodeSettings({
    captureRoot: path.resolve(captureRoot),
  })['claudeCode.environmentVariables']
  if (wrapperExecutable) {
    if (!path.isAbsolute(wrapperExecutable) || !(await exists(wrapperExecutable))) {
      throw new Error(`Claude observer process wrapper is unavailable: ${wrapperExecutable}`)
    }
    observerVsCodeSettings['claudeCode.claudeProcessWrapper'] = path.resolve(wrapperExecutable)
  } else {
    delete observerVsCodeSettings['claudeCode.claudeProcessWrapper']
  }

  const observerClaudeSettings = baselineClaudeSettings
  const projectClaudeSettingsPath = path.join(path.resolve(workspace), '.claude', 'settings.json')
  const projectClaudeSettings = await exists(projectClaudeSettingsPath)
    ? JSON.parse(await readFile(projectClaudeSettingsPath, 'utf8'))
    : null
  const projectEndpoint = projectClaudeSettings?.env?.ANTHROPIC_BASE_URL
  if (projectEndpoint && projectEndpoint !== REQUIRED_ENDPOINT) {
    // The transparent wrapper appends an endpoint-only flag-settings source,
    // which has higher precedence than project/local settings without changing
    // their models, auth, tools, hooks, MCP, or permission rules.
  }
  await ensureDir(path.dirname(profileSettingsPath))
  await writeJson(profileSettingsPath, observerVsCodeSettings)
  const profile = {
    schemaVersion: 1,
    baselineKind: BASELINE_KIND,
    rootDir: path.resolve(rootDir),
    userDataDir: path.resolve(userDataDir),
    claudeConfigDir: path.resolve(claudeConfigDir),
    extensionsDir: path.resolve(extensionsDir),
    workspace: path.resolve(workspace),
    captureRoot: path.resolve(captureRoot),
    profileName: OBSERVER_PROFILE_NAME,
    permissionMode: 'default',
    endpoint: REQUIRED_ENDPOINT,
    routingSettingsPath: path.join(rootDir, 'routing-settings.json'),
    wrapperExecutable: wrapperExecutable ? await fileIdentity(wrapperExecutable) : null,
    realClaudeExecutable: extensions.claude.nativeBinary,
    extensions,
    sharedClaudeConfig: true,
    routingGuard: {
      endpointOnlyFlagSettings: true,
      projectEndpointObserved: projectEndpoint || null,
      projectEndpointSuppressed: Boolean(projectEndpoint && projectEndpoint !== REQUIRED_ENDPOINT),
    },
    settings: {
      vscode: redactSecrets({
        ...observerVsCodeSettings,
        'claudeCode.environmentVariables': (observerVsCodeSettings['claudeCode.environmentVariables'] || []).map(item => ({
          name: item.name,
          value: SECRET_FIELD.test(item.name) ? '[NOT_RECORDED]' : item.value,
        })),
      }),
      claude: {
        source: path.resolve(baselineClaudeSettingsPath),
        sharedWithBaseline: true,
        sourceSha256: await fileIdentity(baselineClaudeSettingsPath).then(identity => identity.sha256),
        snapshotPersisted: false,
      },
      behaviorOverrides: {
        'claudeCode.useTerminal': false,
        'claudeCode.initialPermissionMode': 'default',
        'claudeCode.allowDangerouslySkipPermissions': false,
        'claudeCode.environmentVariables.ANTHROPIC_BASE_URL': REQUIRED_ENDPOINT,
      },
    },
  }
  await writeJson(profile.routingSettingsPath, { env: { ANTHROPIC_BASE_URL: REQUIRED_ENDPOINT } })
  await writeJson(path.join(rootDir, 'profile-manifest.json'), profile)
  return profile
}

export function codeLaunchArgs({ profile, prompt, newWindow = true, includePrompt = true } = {}) {
  if (!profile || typeof prompt !== 'string') throw new Error('profile and prompt are required')
  const args = [
    '--user-data-dir', profile.userDataDir,
    '--extensions-dir', profile.extensionsDir,
  ]
  if (newWindow) args.push('--new-window')
  args.push(profile.workspace)
  if (includePrompt) args.push(observerPromptUri(prompt))
  return args
}

export function codePromptArgs({ profile, prompt } = {}) {
  if (!profile || typeof prompt !== 'string') throw new Error('profile and prompt are required')
  return [
    '--user-data-dir', profile.userDataDir,
    '--extensions-dir', profile.extensionsDir,
    '--reuse-window',
    '--open-url',
    observerPromptUri(prompt),
  ]
}

function spawnVsCodeCommand(spawnImpl, codeCommand, args, options) {
  const isWindowsCommandScript = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(codeCommand)
  const spawnCommand = isWindowsCommandScript ? (process.env.ComSpec || 'cmd.exe') : codeCommand
  const spawnArgs = isWindowsCommandScript ? ['/d', '/c', 'call', codeCommand, ...args] : args
  return spawnImpl(spawnCommand, spawnArgs, options)
}

export async function launchNativeVsCode({
  codeCommand = 'code',
  profile,
  prompt,
  auditDirectory,
  environment = process.env,
  spawnImpl = spawn,
  launchUriImpl,
} = {}) {
  const args = codeLaunchArgs({ profile, prompt, includePrompt: false })
  const env = {
    ...environment,
    CLAUDE_CONFIG_DIR: profile.claudeConfigDir,
    ANTHROPIC_BASE_URL: REQUIRED_ENDPOINT,
    AGENT_MAESTRO_OBSERVER_HOST: '1',
    AGENT_MAESTRO_OBSERVER_PROXY_PORT: '33333',
  }
  if (profile.wrapperExecutable) {
    env.CLAUDE_OBSERVER_AUDIT_DIR = path.resolve(auditDirectory || path.join(profile.rootDir, 'wrapper-audit'))
    env.CLAUDE_OBSERVER_ROUTING_SETTINGS = profile.routingSettingsPath
  }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_CHILD_SESSION
  // VS Code's shell launcher sets this only for its own CLI process. Claude Code
  // inherits it because this observer itself runs inside VS Code; forwarding it
  // makes the new Code.exe run as Node instead of opening a visible window.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.VSCODE_CWD
  const spawnOptions = {
    cwd: profile.workspace,
    env,
    detached: true,
    windowsHide: false,
    shell: false,
    stdio: 'ignore',
  }
  const child = spawnVsCodeCommand(spawnImpl, codeCommand, args, spawnOptions)
  child.unref()
  await new Promise(resolve => setTimeout(resolve, 2500))
  const promptArgs = codePromptArgs({ profile, prompt })
  if (launchUriImpl) {
    await launchUriImpl(observerPromptUri(prompt))
  } else {
    const promptChild = spawnVsCodeCommand(spawnImpl, codeCommand, promptArgs, spawnOptions)
    promptChild.unref()
  }
  return {
    pid: child.pid,
    command: codeCommand,
    args,
    promptArgs,
    prompt: exactPromptUriRecord(prompt),
    userActionRequired: 'Review the visible native Claude panel and press Enter to submit. Resolve every permission request in that UI.',
  }
}

export async function writeObserverBanner(profile, runId) {
  const marker = {
    runId,
    baseline: BASELINE_KIND,
    endpoint: REQUIRED_ENDPOINT,
    permissionMode: 'default',
    message: 'VISIBLE OBSERVER WINDOW — 33333 — USER CONTROLS SUBMIT AND PERMISSIONS',
  }
  await writeJson(path.join(profile.rootDir, 'ACTIVE-EXPERIMENT.json'), marker)
  await writeText(
    path.join(profile.rootDir, 'README.txt'),
    [
      marker.message,
      '',
      'This VS Code process is the visible Observer experiment host.',
      'The prompt is prefilled only. Press Enter yourself to start.',
      'Permission prompts must be accepted or denied in the Claude Code UI.',
      'The normal VS Code process remains on port 23333.',
      '',
    ].join('\n'),
  )
  return marker
}

export async function resetEphemeralProfileState(rootDir) {
  for (const relative of ['ACTIVE-EXPERIMENT.json']) {
    await rm(path.join(rootDir, relative), { force: true })
  }
}
