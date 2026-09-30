#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  configHome,
  copyExact,
  defaultProjectSlug,
  ensureDir,
  exists,
  parseJsonl,
  sessionPaths,
  walkFiles,
  writeJson,
  writeText,
} from './lib.mjs'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      index += 1
    } else {
      args[key] = true
    }
  }
  return args
}

async function locateTranscript(sessionId, projectSlug) {
  const preferred = sessionPaths(sessionId, projectSlug).transcript
  if (await exists(preferred)) return preferred

  const projectsRoot = path.join(configHome, 'projects')
  const candidates = (await walkFiles(projectsRoot)).filter(
    filePath => path.basename(filePath) === `${sessionId}.jsonl`,
  )
  if (candidates.length === 1) return candidates[0]
  if (candidates.length === 0) return null
  throw new Error(
    `Found more than one transcript for session ${sessionId}:\n${candidates.join('\n')}`,
  )
}

function visibleClone(value, omissions, currentKey = '') {
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (
          item &&
          typeof item === 'object' &&
          (item.type === 'thinking' || item.type === 'redacted_thinking')
        ) {
          omissions[item.type] = (omissions[item.type] || 0) + 1
          return { type: item.type, omitted_by_runtime_observer: true }
        }
        return visibleClone(item, omissions)
      })
  }
  if (!value || typeof value !== 'object') {
    if (
      typeof value === 'string' &&
      (value.includes('<system-reminder>') || value.includes('<system-reminder '))
    ) {
      omissions.system_reminder = (omissions.system_reminder || 0) + 1
      return '[SYSTEM REMINDER NOT EXPORTED]'
    }
    return value
  }

  const blockedKeys = new Set([
    'signature',
    'systemPrompt',
    'renderedSystemPrompt',
    'lastAPIRequest',
    'lastAPIRequestMessages',
  ])
  const credentialKeys = /^(?:apiKey|api_key|authorization|accessToken|access_token|refreshToken|refresh_token|sessionKey|session_key|password|secret)$/i
  const output = {}
  for (const [key, child] of Object.entries(value)) {
    if (blockedKeys.has(key)) {
      omissions[key] = (omissions[key] || 0) + 1
      output[key] = '[NOT EXPORTED]'
      continue
    }
    if (credentialKeys.test(key)) {
      omissions.credential_fields = (omissions.credential_fields || 0) + 1
      output[key] = '[NOT EXPORTED]'
      continue
    }
    output[key] = visibleClone(child, omissions, key || currentKey)
  }
  return output
}

async function exportVisibleJsonl(source, destination, omissions) {
  const { records, badLines } = await parseJsonl(source)
  await ensureDir(path.dirname(destination))
  const lines = records.map(record => JSON.stringify(visibleClone(record.value, omissions)))
  for (const badLine of badLines) lines.push(badLine.raw)
  await writeFile(destination, `${lines.join('\n')}${lines.length ? '\n' : ''}`, 'utf8')
  return { records: records.length, badLines: badLines.length }
}

async function copyWithManifest(source, destination, manifest, kind = 'exact') {
  const sourceStat = await stat(source)
  const hash = await copyExact(source, destination)
  manifest.push({
    kind,
    source,
    destination,
    bytes: sourceStat.size,
    mtime: sourceStat.mtime.toISOString(),
    sha256: hash,
  })
}

async function collectDirectory(source, destination, manifest, omissions) {
  if (!(await exists(source))) return 0
  const files = await walkFiles(source)
  for (const sourceFile of files) {
    const relative = path.relative(source, sourceFile)
    const destinationFile = path.join(destination, relative)
    if (sourceFile.endsWith('.jsonl')) {
      const details = await exportVisibleJsonl(sourceFile, destinationFile, omissions)
      const sourceStat = await stat(sourceFile)
      manifest.push({
        kind: 'visible-jsonl',
        source: sourceFile,
        destination: destinationFile,
        bytes: sourceStat.size,
        records: details.records,
        badLines: details.badLines,
      })
    } else {
      await copyWithManifest(sourceFile, destinationFile, manifest)
    }
  }
  return files.length
}

export async function collectSessionArtifacts({
  sessionId,
  runDir,
  projectSlug = defaultProjectSlug,
  transcriptPath,
  configDir = configHome,
}) {
  if (!sessionId) throw new Error('sessionId is required')
  if (!runDir) throw new Error('runDir is required')

  const transcript = transcriptPath
    ? path.resolve(transcriptPath)
    : await locateTranscript(sessionId, projectSlug)
  if (!transcript || !(await exists(transcript))) {
    throw new Error(`Transcript not found for session ${sessionId}`)
  }
  const projectDir = path.dirname(transcript)
  const configuredPaths = sessionPaths(sessionId, projectSlug)
  const paths = {
    ...configuredPaths,
    projectDir,
    transcript,
    sessionDir: path.join(projectDir, sessionId),
    fileHistory: path.join(configDir, 'file-history', sessionId),
    sessionEnv: path.join(configDir, 'session-env', sessionId),
    debug: path.join(configDir, 'debug', `${sessionId}.txt`),
    sessionRegistry: path.join(configDir, 'sessions', `${sessionId}.json`),
    sessionKey: path.join(configDir, 'sessions', `${sessionId}.key`),
    plans: path.join(configDir, 'plans'),
  }

  const sessionOutput = path.join(runDir, '02-session')
  const manifest = []
  const omissions = {}
  const missing = []
  await ensureDir(sessionOutput)

  const transcriptParsed = await parseJsonl(transcript)
  const transcriptSessionIds = new Set(
    transcriptParsed.records.map(row => row.value?.sessionId || row.value?.session_id).filter(Boolean),
  )
  if (transcriptSessionIds.size !== 1 || !transcriptSessionIds.has(sessionId)) {
    throw new Error(`Transcript identity does not exactly match Session ${sessionId}.`)
  }
  const mainDestination = path.join(sessionOutput, 'transcript.visible.jsonl')
  const mainDetails = await exportVisibleJsonl(transcript, mainDestination, omissions)
  manifest.push({
    kind: 'visible-jsonl',
    source: transcript,
    destination: mainDestination,
    records: mainDetails.records,
    badLines: mainDetails.badLines,
    sourceSha256: createHash('sha256').update(await readFile(transcript)).digest('hex'),
  })

  if (await exists(paths.sessionDir)) {
    await collectDirectory(paths.sessionDir, path.join(sessionOutput, 'session-files'), manifest, omissions)
  } else {
    missing.push({ artifact: 'session-directory', path: paths.sessionDir, reason: 'not-created' })
  }

  if (await exists(paths.fileHistory)) {
    await collectDirectory(paths.fileHistory, path.join(sessionOutput, 'file-history'), manifest, omissions)
  } else {
    missing.push({ artifact: 'file-history', path: paths.fileHistory, reason: 'not-created' })
  }

  const capturedDebug = path.join(runDir, '01-live-stream', 'debug.log')
  if (await exists(capturedDebug)) {
    const capturedStat = await stat(capturedDebug)
    manifest.push({
      kind: 'captured-at-launch',
      source: capturedDebug,
      destination: capturedDebug,
      bytes: capturedStat.size,
      mtime: capturedStat.mtime.toISOString(),
      sha256: await (await import('./lib.mjs')).sha256(capturedDebug),
    })
  } else if (await exists(paths.debug)) {
    await copyWithManifest(paths.debug, capturedDebug, manifest)
  } else {
    missing.push({ artifact: 'debug-log', path: paths.debug, reason: 'session-was-not-started-with-debug' })
  }

  if (await exists(paths.sessionRegistry)) {
    await copyWithManifest(paths.sessionRegistry, path.join(sessionOutput, 'session-registry.json'), manifest)
  } else {
    missing.push({ artifact: 'session-registry', path: paths.sessionRegistry, reason: 'not-created-or-expired' })
  }

  if (await exists(paths.sessionKey)) {
    missing.push({ artifact: 'session-key', path: paths.sessionKey, reason: 'credential-not-exported' })
  } else {
    missing.push({ artifact: 'session-key', path: paths.sessionKey, reason: 'not-created-or-expired' })
  }

  const records = transcriptParsed.records
  const slugs = new Set(records.map(row => row.value.slug).filter(Boolean))
  for (const slug of slugs) {
    const planFiles = (await walkFiles(paths.plans)).filter(filePath => {
      const name = path.basename(filePath)
      return name === `${slug}.md` || name.startsWith(`${slug}-agent-`)
    })
    for (const planFile of planFiles) {
      await copyWithManifest(
        planFile,
        path.join(sessionOutput, 'plan', path.basename(planFile)),
        manifest,
      )
    }
  }
  if (slugs.size === 0) {
    missing.push({ artifact: 'plan', path: paths.plans, reason: 'no-plan-slug-in-transcript' })
  }

  const rawLocations = [
    '# Original artifact locations',
    '',
    'These files remain at their original locations. The observer does not duplicate hidden model reasoning or credential files.',
    '',
    `- Main transcript: ${transcript}`,
    `- Session directory: ${paths.sessionDir}`,
    `- File history: ${paths.fileHistory}`,
    `- Debug log: ${paths.debug}`,
    `- Plans directory: ${paths.plans}`,
    '',
  ].join('\n')

  const portableManifest = manifest.map(row => ({
    ...row,
    destination: path.relative(runDir, row.destination).replaceAll('\\', '/'),
  }))
  await writeText(path.join(sessionOutput, 'RAW-LOCATIONS.md'), rawLocations)
  await writeJson(path.join(sessionOutput, 'collection-manifest.json'), {
    sessionId,
    collectedAt: new Date().toISOString(),
    originalTranscript: transcript,
    files: portableManifest,
    omissions,
    missing,
  })
  await writeJson(path.join(sessionOutput, 'missing-artifacts.json'), missing)
  await writeJson(path.join(sessionOutput, 'observer-omissions.json'), omissions)

  return {
    transcript: mainDestination,
    originalTranscript: transcript,
    manifest,
    omissions,
    missing,
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  collectSessionArtifacts({
    sessionId: args['session-id'],
    runDir: args['run-dir'],
    projectSlug: args['project-slug'] || defaultProjectSlug,
  })
    .then(result => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    })
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`)
      process.exitCode = 1
    })
}
