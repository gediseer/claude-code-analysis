import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const observerDir = path.dirname(fileURLToPath(import.meta.url))
export const analysisDir = path.dirname(observerDir)
export const repoRoot = path.resolve(analysisDir, '..', '..')
export const configHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
export const defaultProjectSlug = 'e--repo'
export const defaultRunsRoot = path.join(repoRoot, '.claude', 'claude-code-runs')

export async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true })
}

export async function writeText(filePath, content) {
  await ensureDir(path.dirname(filePath))
  await writeFile(filePath, content, 'utf8')
}

export async function writeJson(filePath, value) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export async function sha256(filePath) {
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

export async function walkFiles(root) {
  if (!(await exists(root))) return []
  const rootStat = await stat(root)
  if (rootStat.isFile()) return [root]
  const output = []
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(fullPath)
      else if (entry.isFile()) output.push(fullPath)
    }
  }
  await walk(root)
  return output
}

export async function copyExact(source, destination) {
  await ensureDir(path.dirname(destination))
  await copyFile(source, destination)
  const [sourceHash, destinationHash] = await Promise.all([
    sha256(source),
    sha256(destination),
  ])
  if (sourceHash !== destinationHash) {
    throw new Error(`SHA-256 mismatch while copying ${source}`)
  }
  return destinationHash
}

export async function copyTreeExact(source, destination) {
  if (!(await exists(source))) return []
  const files = await walkFiles(source)
  const copied = []
  for (const sourceFile of files) {
    const relative = path.relative(source, sourceFile)
    const destinationFile = path.join(destination, relative)
    const hash = await copyExact(sourceFile, destinationFile)
    const sourceStat = await stat(sourceFile)
    copied.push({
      source: sourceFile,
      destination: destinationFile,
      relative,
      bytes: sourceStat.size,
      sha256: hash,
      mtime: sourceStat.mtime.toISOString(),
    })
  }
  return copied
}

export async function snapshotTree(source, destination, ignores = new Set(['.git'])) {
  if (!(await exists(source))) return []
  await cp(source, destination, {
    recursive: true,
    filter: candidate => {
      const relative = path.relative(source, candidate)
      if (!relative) return true
      return !relative.split(path.sep).some(part => ignores.has(part))
    },
  })
  return walkFiles(destination)
}

export function sessionPaths(sessionId, projectSlug = defaultProjectSlug) {
  const projectDir = path.join(configHome, 'projects', projectSlug)
  return {
    projectDir,
    transcript: path.join(projectDir, `${sessionId}.jsonl`),
    sessionDir: path.join(projectDir, sessionId),
    subagents: path.join(projectDir, sessionId, 'subagents'),
    toolResults: path.join(projectDir, sessionId, 'tool-results'),
    fileHistory: path.join(configHome, 'file-history', sessionId),
    sessionEnv: path.join(configHome, 'session-env', sessionId),
    debug: path.join(configHome, 'debug', `${sessionId}.txt`),
    sessionRegistry: path.join(configHome, 'sessions', `${sessionId}.json`),
    sessionKey: path.join(configHome, 'sessions', `${sessionId}.key`),
    plans: path.join(configHome, 'plans'),
  }
}

export async function parseJsonl(filePath) {
  if (!(await exists(filePath))) return { records: [], badLines: [] }
  const text = await readFile(filePath, 'utf8')
  const records = []
  const badLines = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    if (!raw.trim()) continue
    try {
      records.push({ line: index + 1, raw, value: JSON.parse(raw) })
    } catch (error) {
      badLines.push({ line: index + 1, raw, error: String(error) })
    }
  }
  return { records, badLines }
}

export function contentBlocks(record) {
  const content = record?.message?.content
  return Array.isArray(content) ? content : []
}

export function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      block =>
        block && block.type === 'text' && typeof block.text === 'string',
    )
    .map(block => block.text)
    .join('\n')
}

export function recordTimestamp(record) {
  return record.timestamp || record.message?.timestamp || ''
}

export function shortId(value) {
  if (!value) return '-'
  return String(value).length > 18 ? `${String(value).slice(0, 12)}…` : String(value)
}

export function markdownCode(value, language = 'json') {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const longest = Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1))
  const fence = '`'.repeat(longest)
  return `${fence}${language}\n${text}\n${fence}`
}

export function shellQuote(value) {
  if (process.platform === 'win32') {
    return `"${String(value).replaceAll('"', '\\"')}"`
  }
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

export function createRunId(caseId = 'run') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `${stamp}_${caseId}_${randomUUID().slice(0, 8)}`
}

export async function atomicReplace(source, destination) {
  await rm(destination, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  await ensureDir(path.dirname(destination))
  let lastError
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      lastError = error
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
  throw lastError
}

export async function manifestForTree(root) {
  const files = await walkFiles(root)
  const rows = []
  for (const filePath of files) {
    const fileStat = await stat(filePath)
    rows.push({
      relative: path.relative(root, filePath).replaceAll('\\', '/'),
      bytes: fileStat.size,
      mtime: fileStat.mtime.toISOString(),
      sha256: await sha256(filePath),
    })
  }
  return rows
}
