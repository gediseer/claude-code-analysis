#!/usr/bin/env node
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyPromptFidelity,
  firstApiPromptEvidence,
  firstTranscriptPromptEvidence,
  promptFidelityPresentation,
} from './prompt-fidelity.mjs'

const launch = '  exact\nchild prompt  '
const provenance = {
  schemaVersion: 3,
  original: { available: true, text: launch },
  launchPrompt: { text: launch },
  childPrompt: { text: launch },
}

function transcriptEvidence(text = launch) {
  return firstTranscriptPromptEvidence([{
    line: 1,
    value: {
      type: 'user',
      parentUuid: null,
      isSidechain: false,
      uuid: 'u1',
      message: { role: 'user', content: text },
    },
  }])
}

function apiEvidence(content = launch) {
  return firstApiPromptEvidence([{
    id: 'request-0001',
    body: { messages: [{ role: 'user', content }] },
    rawRef: '05-api/request-0001/request.parsed.json',
  }])
}

test('classification verifies all exact boundaries and preserves whitespace', () => {
  const result = classifyPromptFidelity({
    inputProvenance: provenance,
    task: launch,
    transcriptEvidence: transcriptEvidence(),
    apiEvidence: apiEvidence(),
  })
  assert.equal(result.mode, 'verbatim')
  assert.equal(result.validForPromptBehaviorResearch, true)
  assert.equal(result.comparisons.every(item => item.matches === true), true)
})

test('classification distinguishes unavailable evidence from mismatch', () => {
  const unavailable = classifyPromptFidelity({
    inputProvenance: provenance,
    task: launch,
    transcriptEvidence: firstTranscriptPromptEvidence([]),
    apiEvidence: firstApiPromptEvidence([]),
  })
  assert.equal(unavailable.mode, 'evidence-unavailable')
  assert.equal(unavailable.validForPromptBehaviorResearch, false)
  assert.match(unavailable.invalidReason, /unavailable/)

  const mismatch = classifyPromptFidelity({
    inputProvenance: provenance,
    task: launch,
    transcriptEvidence: transcriptEvidence(`${launch}\n`),
    apiEvidence: apiEvidence(),
  })
  assert.equal(mismatch.mode, 'provenance-mismatch')
  assert.equal(mismatch.validForPromptBehaviorResearch, false)
})

test('API extraction only removes explicit runtime reminder prefix blocks', () => {
  const prefixed = apiEvidence([
    { type: 'text', text: '<system-reminder>runtime only</system-reminder>\n\n' },
    { type: 'text', text: launch },
  ])
  assert.equal(prefixed.available, true)
  assert.equal(prefixed.text, launch)
  assert.equal(prefixed.ignoredRuntimeContextBlocks, 1)

  const ambiguous = apiEvidence([
    { type: 'text', text: 'ordinary prefix' },
    { type: 'text', text: launch },
  ])
  assert.equal(ambiguous.available, false)
  assert.match(ambiguous.reason, /ambiguous/)
})

test('legacy-unverified and provenance-mismatch labels remain distinct', () => {
  const legacy = classifyPromptFidelity({
    inputProvenance: {
      schemaVersion: 2,
      original: { available: true, text: launch },
      childPrompt: { text: launch },
      compiled: { text: null },
    },
    task: launch,
    transcriptEvidence: firstTranscriptPromptEvidence([]),
    apiEvidence: firstApiPromptEvidence([]),
  })
  assert.equal(legacy.mode, 'legacy-unverified')
  assert.equal(promptFidelityPresentation('legacy-unverified').label, 'LEGACY UNVERIFIED')
  assert.equal(promptFidelityPresentation('provenance-mismatch').label, 'PROVENANCE MISMATCH')
  assert.notEqual(
    promptFidelityPresentation('legacy-unverified').banner,
    promptFidelityPresentation('provenance-mismatch').banner,
  )
})
