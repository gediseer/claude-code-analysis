import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { exists, parseJsonl, writeJson } from './lib.mjs'
import { isAnthropicMessagesPath } from './api-paths.mjs'

export function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function validatePromptText(prompt) {
  if (typeof prompt !== 'string') {
    throw new Error('Observed prompt must be a string supplied by --prompt/--task or the case config.')
  }
  if (prompt.includes('\u0000')) {
    throw new Error('Prompt fidelity violation: prompts containing NUL (U+0000) cannot be launched.')
  }
  for (let index = 0; index < prompt.length; index += 1) {
    const codeUnit = prompt.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = prompt.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`Prompt fidelity violation: unpaired high surrogate at UTF-16 code-unit index ${index}.`)
      }
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(`Prompt fidelity violation: unpaired low surrogate at UTF-16 code-unit index ${index}.`)
    }
  }
  return prompt
}

const PRESENTATION = Object.freeze({
  verbatim: {
    label: 'VERBATIM',
    banner: null,
    description: 'Observer launch, child transcript, and first model-request user input match exactly.',
  },
  'provenance-mismatch': {
    label: 'PROVENANCE MISMATCH',
    banner: 'PROVENANCE MISMATCH — INVALID FOR PROMPT RESEARCH',
    description: 'At least one captured prompt boundary differs from the exact launch prompt.',
  },
  'evidence-unavailable': {
    label: 'EVIDENCE UNAVAILABLE',
    banner: 'EVIDENCE UNAVAILABLE — NOT VERIFIED FOR PROMPT RESEARCH',
    description: 'The exact launch prompt is recorded, but required child transcript or API evidence is unavailable.',
  },
  'legacy-rewritten': {
    label: 'LEGACY REWRITTEN',
    banner: 'LEGACY REWRITTEN — INVALID FOR PROMPT RESEARCH',
    description: 'A legacy Observer run rewrote or compiled the request before child-session delivery.',
  },
  'legacy-unverified': {
    label: 'LEGACY UNVERIFIED',
    banner: 'LEGACY UNVERIFIED — INVALID FOR PROMPT RESEARCH',
    description: 'A legacy run lacks enough exact provenance evidence to verify prompt fidelity.',
  },
})

export function promptFidelityPresentation(mode) {
  return PRESENTATION[mode] || {
    label: String(mode || 'UNKNOWN').toUpperCase(),
    banner: `${String(mode || 'UNKNOWN').toUpperCase()} — NOT VERIFIED FOR PROMPT RESEARCH`,
    description: 'Prompt-fidelity state is unknown.',
  }
}

function contentEvidence(content, rawRef, { stripRuntimePrefix = false } = {}) {
  if (typeof content === 'string') {
    return {
      available: true,
      text: content,
      sha256: sha256Text(content),
      rawRef,
      extraction: 'string-content',
      ignoredRuntimeContextBlocks: 0,
    }
  }
  if (!Array.isArray(content)) {
    return {
      available: false,
      text: null,
      sha256: null,
      rawRef,
      reason: 'First-user content is neither a string nor a content-block array.',
      extraction: 'unsupported-content',
      ignoredRuntimeContextBlocks: 0,
    }
  }
  let textBlocks = content
    .map((block, blockIndex) => ({ block, blockIndex }))
    .filter(({ block }) => block?.type === 'text' && typeof block.text === 'string')
  let ignoredRuntimeContextBlocks = 0
  if (stripRuntimePrefix && textBlocks.length > 1) {
    while (
      textBlocks.length > 1 &&
      /^\s*<system-reminder(?:\s|>)[\s\S]*<\/system-reminder>\r?\n\r?\n$/.test(textBlocks[0].block.text)
    ) {
      textBlocks = textBlocks.slice(1)
      ignoredRuntimeContextBlocks += 1
    }
  }
  if (textBlocks.length !== 1) {
    return {
      available: false,
      text: null,
      sha256: null,
      rawRef,
      reason: textBlocks.length === 0
        ? 'First-user content has no text block.'
        : 'First-user content has multiple non-runtime text blocks, so exact prompt extraction is ambiguous.',
      extraction: 'ambiguous-content-blocks',
      textBlockCount: textBlocks.length,
      ignoredRuntimeContextBlocks,
    }
  }
  const [{ block, blockIndex }] = textBlocks
  return {
    available: true,
    text: block.text,
    sha256: sha256Text(block.text),
    rawRef,
    extraction: 'single-text-block',
    blockIndex,
    ignoredRuntimeContextBlocks,
  }
}

function transcriptRecord(event) {
  if (event?.value && typeof event.value === 'object') return event.value
  if (event?.raw && typeof event.raw === 'object') return event.raw
  return event
}

export function firstTranscriptPromptEvidence(transcript) {
  const candidates = transcript.filter(event => {
    const record = transcriptRecord(event)
    const blocks = Array.isArray(record?.message?.content) ? record.message.content : []
    return record?.type === 'user' &&
      record?.message?.role === 'user' &&
      record?.isSidechain !== true &&
      !blocks.some(block => block?.type === 'tool_result')
  })
  const event = candidates.find(candidate => transcriptRecord(candidate).parentUuid == null) || candidates[0]
  if (!event) {
    return {
      available: false,
      text: null,
      sha256: null,
      rawRef: null,
      reason: 'No main-chain child transcript first-user record was captured.',
      extraction: 'missing-transcript-user',
    }
  }
  const record = transcriptRecord(event)
  const rawRef = event.rawRef || (event.line ? `02-session/transcript.visible.jsonl#L${event.line}` : '02-session/transcript.visible.jsonl')
  return {
    ...contentEvidence(record.message?.content, rawRef),
    uuid: record.uuid || event.uuid || null,
    timestamp: record.timestamp || event.timestamp || null,
  }
}

export function firstApiPromptEvidence(apiRequests) {
  const request = apiRequests[0]
  if (!request) {
    return {
      available: false,
      text: null,
      sha256: null,
      rawRef: null,
      reason: 'No captured POST /v1/messages request is available.',
      extraction: 'missing-api-request',
    }
  }
  const body = request.body || request.fullBody || request
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const messageIndex = messages.findIndex(message => message?.role === 'user')
  if (messageIndex < 0) {
    return {
      available: false,
      text: null,
      sha256: null,
      rawRef: request.rawRefs?.request || request.rawRef || null,
      reason: 'The first captured model request has no user message.',
      extraction: 'missing-api-user',
    }
  }
  const baseRef = request.rawRefs?.request || request.rawRef || null
  const rawRef = baseRef ? `${baseRef}#/messages/${messageIndex}` : null
  return {
    ...contentEvidence(messages[messageIndex].content, rawRef, { stripRuntimePrefix: true }),
    requestId: request.id || null,
    messageIndex,
  }
}

function comparison(name, expected, observed, required = true) {
  if (!observed?.available) {
    return {
      name,
      required,
      available: false,
      matches: null,
      expectedSha256: sha256Text(expected),
      observedSha256: null,
      rawRef: observed?.rawRef || null,
      reason: observed?.reason || `${name} evidence is unavailable.`,
      extraction: observed?.extraction || null,
    }
  }
  return {
    name,
    required,
    available: true,
    matches: observed.text === expected,
    expectedSha256: sha256Text(expected),
    observedSha256: observed.sha256 || sha256Text(observed.text),
    rawRef: observed.rawRef || null,
    extraction: observed.extraction || null,
    ignoredRuntimeContextBlocks: observed.ignoredRuntimeContextBlocks || 0,
  }
}

export function classifyPromptFidelity({ inputProvenance, task, transcriptEvidence, apiEvidence }) {
  const schemaVersion = Number(inputProvenance?.schemaVersion || 0)
  const originalText = inputProvenance?.original?.available && typeof inputProvenance.original.text === 'string'
    ? inputProvenance.original.text
    : null
  const launchText = typeof inputProvenance?.launchPrompt?.text === 'string'
    ? inputProvenance.launchPrompt.text
    : typeof inputProvenance?.childPrompt?.text === 'string'
      ? inputProvenance.childPrompt.text
      : typeof inputProvenance?.compiled?.text === 'string'
        ? inputProvenance.compiled.text
        : typeof task === 'string'
          ? task
          : null
  const legacyCompiledText = typeof inputProvenance?.compiled?.text === 'string'
    ? inputProvenance.compiled.text
    : null

  if (
    schemaVersion < 3 &&
    originalText !== null &&
    ((legacyCompiledText !== null && originalText !== legacyCompiledText) ||
      (launchText !== null && originalText !== launchText))
  ) {
    const mode = 'legacy-rewritten'
    return {
      mode,
      validForPromptBehaviorResearch: false,
      invalidReason: 'Legacy Observer run rewrote or compiled the user prompt before child-session delivery.',
      observerPromptTransform: 'legacy-compile-or-rewrite',
      exactUnicodeString: false,
      originalEqualsChildPrompt: false,
      comparisons: [],
      presentation: promptFidelityPresentation(mode),
    }
  }

  if (launchText === null || originalText === null || typeof task !== 'string') {
    const mode = schemaVersion < 3 ? 'legacy-unverified' : 'evidence-unavailable'
    return {
      mode,
      validForPromptBehaviorResearch: false,
      invalidReason: 'Exact original, launch, or persisted prompt provenance is unavailable.',
      observerPromptTransform: schemaVersion < 3 ? 'unknown' : 'none',
      exactUnicodeString: null,
      originalEqualsChildPrompt: originalText === null || launchText === null ? null : originalText === launchText,
      comparisons: [],
      presentation: promptFidelityPresentation(mode),
    }
  }

  const comparisons = [
    comparison('original-to-launch', launchText, {
      available: true,
      text: originalText,
      sha256: sha256Text(originalText),
      rawRef: '00-task/input-provenance.json#/original',
      extraction: 'launch-provenance',
    }),
    comparison('task-artifact', launchText, {
      available: true,
      text: task,
      sha256: sha256Text(task),
      rawRef: '00-task/task.md',
      extraction: 'exact-file-content',
    }),
    comparison('child-transcript-first-user', launchText, transcriptEvidence),
    comparison('api-first-user-input', launchText, apiEvidence),
  ]
  const mismatch = comparisons.find(item => item.available && item.matches === false)
  if (mismatch) {
    const mode = 'provenance-mismatch'
    return {
      mode,
      validForPromptBehaviorResearch: false,
      invalidReason: `${mismatch.name} does not exactly match the launch prompt.`,
      observerPromptTransform: 'none',
      exactUnicodeString: false,
      originalEqualsChildPrompt: originalText === launchText,
      comparisons,
      presentation: promptFidelityPresentation(mode),
    }
  }
  const unavailable = comparisons.filter(item => item.required && !item.available)
  if (unavailable.length) {
    const mode = schemaVersion < 3 ? 'legacy-unverified' : 'evidence-unavailable'
    return {
      mode,
      validForPromptBehaviorResearch: false,
      invalidReason: `Required prompt evidence unavailable: ${unavailable.map(item => item.name).join(', ')}.`,
      observerPromptTransform: schemaVersion < 3 ? 'unknown' : 'none',
      exactUnicodeString: null,
      originalEqualsChildPrompt: originalText === launchText,
      comparisons,
      presentation: promptFidelityPresentation(mode),
    }
  }
  const mode = 'verbatim'
  return {
    mode,
    validForPromptBehaviorResearch: true,
    invalidReason: null,
    observerPromptTransform: 'none',
    exactUnicodeString: true,
    originalEqualsChildPrompt: true,
    comparisons,
    presentation: promptFidelityPresentation(mode),
  }
}

async function readJson(filePath, fallback = null) {
  if (!(await exists(filePath))) return fallback
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function loadApiRequests(runDir) {
  const apiDir = path.join(runDir, '05-api')
  if (!(await exists(apiDir))) return []
  const entries = (await readdir(apiDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('request-'))
    .sort((a, b) => a.name.localeCompare(b.name))
  const requests = []
  for (const entry of entries) {
    const requestDir = path.join(apiDir, entry.name)
    const metadata = await readJson(path.join(requestDir, 'request-metadata.json'), {})
    const pathname = new URL(metadata.incomingPath || '/', 'http://observer.local').pathname
    if (metadata.method !== 'POST' || !isAnthropicMessagesPath(pathname)) continue
    const parsedPath = path.join(requestDir, 'request.parsed.json')
    if (!(await exists(parsedPath))) continue
    requests.push({
      id: entry.name,
      body: await readJson(parsedPath, null),
      rawRef: `05-api/${entry.name}/request.parsed.json`,
    })
  }
  return requests
}

export async function assessPromptFidelityRun(runDir) {
  const provenance = await readJson(path.join(runDir, '00-task', 'input-provenance.json'), null)
  const taskPath = path.join(runDir, '00-task', 'task.md')
  const taskRaw = (await exists(taskPath)) ? await readFile(taskPath, 'utf8') : null
  // Schema v1/v2 writers appended exactly one storage newline. Remove only that
  // known artifact; schema v3 stores the authoritative prompt bytes unchanged.
  const task = typeof taskRaw === 'string' && Number(provenance?.schemaVersion || 0) < 3
    ? taskRaw.replace(/\r?\n$/, '')
    : taskRaw
  const transcriptRows = await parseJsonl(path.join(runDir, '02-session', 'transcript.visible.jsonl'))
  const transcriptEvidence = firstTranscriptPromptEvidence(transcriptRows.records)
  const apiEvidence = firstApiPromptEvidence(await loadApiRequests(runDir))
  const assessment = classifyPromptFidelity({
    inputProvenance: provenance,
    task,
    transcriptEvidence,
    apiEvidence,
  })
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ...assessment,
    launchPromptSha256: provenance?.launchPrompt?.sha256 || provenance?.childPrompt?.sha256 || (typeof task === 'string' ? sha256Text(task) : null),
    transcriptFirstUser: transcriptEvidence,
    apiFirstUser: apiEvidence,
  }
}

export async function writePromptFidelityAssessment(runDir) {
  const assessment = await assessPromptFidelityRun(runDir)
  await writeJson(path.join(runDir, '00-task', 'prompt-fidelity.json'), assessment)
  return assessment
}
