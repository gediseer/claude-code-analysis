#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildApiTurns } from './api-turns.mjs'
import { auditCoverage } from './coverage-auditor.mjs'
import { ensureDir, writeJson, writeText } from './lib.mjs'
import { buildPromptTurns } from './prompt-turns.mjs'
import { buildReplayModel } from './replay-model.mjs'
import { buildTeachingReplay } from './teaching-replay.mjs'
import { buildToolLifecycles } from './tool-lifecycles.mjs'
import { extractFinalReport } from './extract-final-report.mjs'

async function makeRun({ prompt = 'Read README', transcriptPrompt = prompt, apiPrompt = prompt, schemaVersion = 3 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-derived-'))
  for (const dir of ['00-task', '01-live-stream', '02-session', '03-workspace/before', '04-readable', '05-api/request-0001']) {
    await ensureDir(path.join(root, dir))
  }
  await writeText(path.join(root, '00-task/task.md'), prompt)
  await writeText(path.join(root, '00-task/original-query.md'), prompt)
  await writeJson(path.join(root, '00-task/input-provenance.json'), {
    schemaVersion,
    promptFidelity: { mode: 'evidence-unavailable', validForPromptBehaviorResearch: false, observerPromptTransform: 'none', exactUnicodeString: null },
    original: { available: true, text: prompt },
    launchPrompt: { text: prompt, source: 'observer-stdin-utf8', transport: 'stdin' },
    childPrompt: { text: prompt },
    compiled: { legacy: true, used: false, text: null },
    relation: { type: 'identity', evidence: 'observer-enforced' },
  })
  await writeText(path.join(root, '00-task/command.txt'), 'claude ...\n')
  await writeJson(path.join(root, '00-task/run-config.json'), { command: 'claude', case: { workspace: 'x', tools: ['Read'] } })
  await writeJson(path.join(root, '00-task/process-result.json'), { code: 0, timedOut: false })
  await writeText(path.join(root, '01-live-stream/debug.log'), 'tool_dispatch_start tool=Read toolUseId=call_1 permissionDecisionMs=2\ntool_dispatch_end tool=Read toolUseId=call_1 outcome=ok durationMs=3\n')
  const result = { type: 'result', subtype: 'success', terminal_reason: 'completed', num_turns: 2, total_cost_usd: 0.01, duration_ms: 10, stop_reason: 'end_turn', result: 'done', permission_denials: [] }
  await writeText(path.join(root, '01-live-stream/stdout.stream.jsonl'), [
    { type: 'system', subtype: 'init', tools: ['Read'] },
    { type: 'stream_event', event: { type: 'message_start' } },
    result,
  ].map(JSON.stringify).join('\n') + '\n')
  const transcript = [
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: transcriptPrompt } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'README.md' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '# README' }] } },
  ]
  await writeText(path.join(root, '02-session/transcript.visible.jsonl'), transcript.map(JSON.stringify).join('\n') + '\n')
  await writeJson(path.join(root, '02-session/missing-artifacts.json'), [])
  await writeText(path.join(root, '03-workspace/changes.diff'), '')
  await writeText(path.join(root, '03-workspace/test-output.txt'), 'none\n')
  const request = {
    body: {
      model: 'claude-opus-5',
      system: { hiddenDefaultSystemPrompt: { omitted: true, bytes: 10, sha256: 'x' } },
      messages: [{ role: 'user', content: apiPrompt }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      max_tokens: 1000,
      thinking: { type: 'adaptive' },
    },
    omissions: {},
  }
  const fullRequest = {
    model: 'claude-opus-5',
    system: [{ type: 'text', text: 'full system prompt' }],
    messages: [{ role: 'user', content: apiPrompt }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    max_tokens: 1000,
    thinking: { type: 'adaptive' },
  }
  await writeText(path.join(root, '05-api/request-0001/request.raw'), JSON.stringify(fullRequest))
  await writeJson(path.join(root, '05-api/request-0001/request.parsed.json'), fullRequest)
  await writeJson(path.join(root, '05-api/request-0001/request.observable.json'), request)
  await writeJson(path.join(root, '05-api/request-0001/request-metadata.json'), {
    method: 'POST',
    incomingPath: '/v1/messages',
    bodyBytes: 100,
    bodySha256: 'abc',
  })
  await writeJson(path.join(root, '05-api/request-0001/response-metadata.json'), { statusCode: 200 })
  await writeJson(path.join(root, '05-api/request-0001/summary.json'), { timeToHeadersMs: 1, durationMs: 4 })
  await writeText(path.join(root, '05-api/request-0001/response.raw'), 'event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n')
  await writeText(path.join(root, '05-api/requests.jsonl'), JSON.stringify({ requestId: 'request-0001' }) + '\n')
  return root
}

test('derived views consume proxy, transcript and debug evidence end-to-end', async () => {
  const runDir = await makeRun()
  const prompt = await buildPromptTurns({ runDir })
  const api = await buildApiTurns({ runDir })
  const tools = await buildToolLifecycles({ runDir })
  const coverage = await auditCoverage({ runDir })
  const teaching = await buildTeachingReplay({ runDir })
  const finalReport = await extractFinalReport({ runDir })
  const replay = await buildReplayModel(runDir)
  assert.equal(prompt.turns, 1)
  assert.equal(api.turns, 1)
  assert.equal(tools.tools, 1)
  assert.equal(teaching.apiRequests, 1)
  assert.equal(finalReport.source, 'stream-result')
  assert.equal(replay.schemaVersion, 3)
  assert.equal(replay.run.routingFidelity, null)
  assert.equal(replay.input.original.text, 'Read README')
  assert.equal(replay.input.childPrompt.text, 'Read README')
  assert.equal(replay.input.promptFidelity.mode, 'verbatim')
  assert.equal(replay.input.promptFidelity.validForPromptBehaviorResearch, true)
  assert.equal(replay.input.compiled.used, false)
  assert.equal(coverage.points.find(point => point.id === 'API_REQUEST').status, 'CAPTURED')
  const teachingText = await readFile(path.join(runDir, '04-readable/14-TEACHING-REPLAY.md'), 'utf8')
  assert.match(teachingText, /模型请求 1/)
  assert.match(teachingText, /Prompt fidelity：VERBATIM — 可用于 prompt-behavior 研究/)
  assert.match(await readFile(path.join(runDir, '04-readable/15-PROMPT-TURNS.md'), 'utf8'), /Tool Schemas/)
  assert.match(await readFile(path.join(runDir, '04-readable/16-TOOL-LIFECYCLES.md'), 'utf8'), /CAPTURED_ALLOW/)
  assert.match(await readFile(path.join(runDir, '04-readable/17-API-TURNS.md'), 'utf8'), /Visible response summary/)
  await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test('prompt fidelity preserves boundary whitespace and accepts runtime reminder prefix separately', async () => {
  const exact = '  Exact prompt\nwith trailing whitespace  \n'
  const runDir = await makeRun({ prompt: exact, transcriptPrompt: exact, apiPrompt: [
    { type: 'text', text: '<system-reminder>runtime context</system-reminder>\n\n' },
    { type: 'text', text: exact },
  ] })
  const replay = await buildReplayModel(runDir)
  assert.equal(replay.run.task, exact)
  assert.equal(replay.input.childPrompt.text, exact)
  assert.equal(replay.input.provenanceEvidence.transcriptFirstUser.text, exact)
  assert.equal(replay.input.provenanceEvidence.apiFirstUser.text, exact)
  assert.equal(replay.input.provenanceEvidence.apiFirstUser.ignoredRuntimeContextBlocks, 1)
  assert.equal(replay.input.promptFidelity.mode, 'verbatim')
  assert.equal(replay.input.promptFidelity.validForPromptBehaviorResearch, true)
  await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

test('prompt fidelity reports provenance mismatch distinctly', async () => {
  const runDir = await makeRun({ transcriptPrompt: 'Read a different file' })
  const replay = await buildReplayModel(runDir)
  assert.equal(replay.input.promptFidelity.mode, 'provenance-mismatch')
  assert.equal(replay.input.promptFidelity.validForPromptBehaviorResearch, false)
  assert.match(replay.input.promptFidelity.invalidReason, /child-transcript-first-user/)
  assert.ok(replay.events.some(event => event.title === 'PROVENANCE MISMATCH child prompt'))
  const teaching = await buildTeachingReplay({ runDir })
  assert.equal(teaching.apiRequests, 1)
  const text = await readFile(path.join(runDir, '04-readable/14-TEACHING-REPLAY.md'), 'utf8')
  assert.match(text, /Prompt fidelity：PROVENANCE MISMATCH/)
  assert.doesNotMatch(text, /LEGACY REWRITTEN/)
  await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
