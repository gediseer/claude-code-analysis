#!/usr/bin/env node
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { exists } from './lib.mjs'
import { buildReplayModel } from './replay-model.mjs'

const focused = path.resolve(
  'E:/repo/.claude/claude-code-runs/phoneinput-transport-focused-report-complete-budget-exhausted',
)
const parallel = path.resolve(
  'E:/repo/.claude/claude-code-runs/phoneinput-transport-parallel-budget-exhausted',
)
const exactObserver = path.resolve(
  'E:/repo/.claude/claude-code-runs/phoneinput-exact-observer-20260927-v2',
)
const latest = path.resolve(
  'E:/repo/.claude/claude-code-runs/phoneinput-function-speed-observed-20260926',
)

test('focused PhoneInput replay model preserves execution failure and report availability', async t => {
  if (!(await exists(focused))) return t.skip('focused PhoneInput run not available')
  const model = await buildReplayModel(focused)
  assert.equal(model.apiRequests.length, 6)
  assert.equal(model.auxiliaryRequests.length, 3)
  assert.equal(model.tools.length, 27)
  assert.equal(model.agents.length, 0)
  assert.equal(model.coverage.summary.missing, 0)
  assert.equal(model.run.status.execution.succeeded, false)
  assert.equal(model.run.status.execution.terminalReason, 'budget_exhausted')
  assert.equal(model.run.status.deliverable.available, true)
  assert.equal(model.finalReport.reportAvailable, true)
  assert.equal(model.cost.reportedUsd, 0.808262)
  assert.equal(model.cost.budgetUsd, 0.65)
  assert.ok(model.concurrencyGroups.length >= 1)
  assert.ok(model.events.length < model.kpis.liveEvents / 20)
  for (const request of model.apiRequests) {
    assert.match(request.path, /^\/v1\/messages(?:\?|$)/)
    assert.notEqual(new URL(request.path, 'http://x').pathname, '/v1/messages/count_tokens')
  }
})

test('latest PhoneInput replay separates original, compiled, turns and result feedback', async t => {
  if (!(await exists(latest))) return t.skip('latest PhoneInput run not available')
  const model = await buildReplayModel(latest)
  assert.equal(model.schemaVersion, 3)
  assert.equal(model.input.original.available, true)
  assert.equal(model.input.original.text, '观察 Test case 总结phone input项目的功能 以及看能否有办法提升文本和图片的传输速度')
  assert.notEqual(model.input.original.text, model.input.childPrompt.text)
  assert.equal(model.input.childPrompt.text, model.run.task)
  assert.equal(model.input.compiled.legacy, true)
  assert.equal(model.input.compiled.used, true)
  assert.equal(model.input.promptFidelity.mode, 'legacy-rewritten')
  assert.equal(model.input.promptFidelity.validForPromptBehaviorResearch, false)
  assert.equal(model.turns.length, model.apiRequests.length)
  assert.ok(model.turns.some(turn => turn.visibleTextKind === 'visible-plan'))
  assert.ok(model.turns.some(turn => !turn.visibleText && turn.toolSelections.length > 0))
  for (const turn of model.turns) {
    for (const selection of turn.toolSelections) {
      const tool = model.tools.find(item => item.id === selection.id)
      assert.ok(tool, selection.id)
      assert.equal(tool.requestId, turn.requestId)
      assert.equal(selection.rationale.evidence.level, 'NOT_EXPOSED')
    }
  }
  assert.ok(model.tools.some(tool => tool.feedback.length > 0))
  assert.ok(model.relations.some(relation => relation.type === 'tool-result-fed-to-request'))
  assert.ok(model.turns.every(turn => turn.outboundRequest))
  assert.ok(model.turns.every(turn => turn.outboundRequest.fullRequestAvailable === false))
  assert.equal(model.firstTurnTrace.stages.length, 12)
  assert.equal(model.firstTurnTrace.stages[0].id, 'original')
  assert.equal(model.firstTurnTrace.stages[6].id, 'model')
  assert.equal(model.firstTurnTrace.stages[6].status, 'NOT_EXPOSED')
  assert.ok(model.firstTurnTrace.stages[6].notObservable.includes('Private chain-of-thought'))
  assert.ok(model.events.some(event => event.kind === 'model-turn'))
  assert.ok(model.events.some(event => event.title === 'Legacy rewritten child prompt (invalid for prompt research)'))
  assert.ok(!model.events.some(event => event.title === 'User input'))
})

test('full-prompt PhoneInput first-turn trace matches captured Query pipeline', async t => {
  const full = path.resolve('E:/repo/.claude/claude-code-runs/phoneinput-full-prompt-capture-20260926')
  if (!(await exists(full))) return t.skip('full-prompt PhoneInput run not available')
  const model = await buildReplayModel(full)
  assert.deepEqual(model.apiTurns.map(turn => turn.requestId), ['request-0002', 'request-0003', 'request-0006', 'request-0007'])
  assert.equal(model.apiTurns.length, 4)
  assert.equal(model.auxiliaryRequests.length, 3)
  assert.equal(model.apiTurns[0].bridge.nextRequestId, 'request-0003')
  assert.equal(model.apiTurns.at(-1).bridge.type, 'terminal')
  assert.ok(model.apiTurns.at(-1).finalResult)
  assert.equal(model.apiTurns.slice(0, -1).every(turn => turn.finalResult === null), true)
  const trace = model.firstTurnTrace
  assert.equal(trace.requestId, 'request-0002')
  assert.equal(trace.messageId, 'msg_1790399020870')
  assert.equal(trace.nextRequestId, 'request-0003')
  assert.equal(trace.stages.length, 12)
  const request = trace.stages.find(stage => stage.id === 'request')
  assert.equal(request.output.sha256, '85d9205b5ddd92f62e7c6e63d83b53e222d1366ac00f18e9dd7caa707e5d6144')
  assert.equal(request.summary.includes('12690 bytes'), true)
  const modelBoundary = trace.stages.find(stage => stage.id === 'model')
  assert.equal(modelBoundary.status, 'NOT_EXPOSED')
  assert.equal(modelBoundary.output.thinkingBlocksReturned, 0)
  assert.equal(modelBoundary.output.textBlocksReturned, 0)
  const response = trace.stages.find(stage => stage.id === 'response')
  assert.deepEqual(response.output.responseBlocks.map(block => block.toolName), ['Glob', 'Glob', 'Grep'])
  const executors = trace.stages.find(stage => stage.id === 'executors')
  assert.deepEqual(executors.output.map(tool => tool.durationMs), [273, 175, 95])
  assert.deepEqual(model.apiTurns[0].bridge.emittedOrder, [
    'call_OrEeO1rfIL2CfAHRlBd5mA0U',
    'call_8j0nig3AvqMc3zpzI14o9CaU',
    'call_WomOKuQtS87diq2W1aiKPExo',
  ])
  assert.deepEqual(model.apiTurns[0].bridge.completionOrder, [
    'call_WomOKuQtS87diq2W1aiKPExo',
    'call_8j0nig3AvqMc3zpzI14o9CaU',
    'call_OrEeO1rfIL2CfAHRlBd5mA0U',
  ])
  assert.deepEqual(model.apiTurns[0].bridge.feedbackOrder, model.apiTurns[0].bridge.completionOrder)
  const feedback = trace.stages.find(stage => stage.id === 'feedback')
  assert.deepEqual(feedback.output.completionOrder, [
    'call_WomOKuQtS87diq2W1aiKPExo',
    'call_8j0nig3AvqMc3zpzI14o9CaU',
    'call_OrEeO1rfIL2CfAHRlBd5mA0U',
  ])
})

test('exact observer replay keeps all 33333 exchanges paired and ordered', async t => {
  if (!(await exists(exactObserver))) return t.skip('exact observer run not available')
  const model = await buildReplayModel(exactObserver)
  assert.equal(model.httpExchanges.length, 206)
  assert.equal(model.httpExchanges.filter(item => item.kind === 'messages').length, 191)
  assert.equal(model.httpExchanges.filter(item => item.kind === 'count_tokens').length, 15)
  assert.ok(model.httpExchanges.every(item => item.request.integrity.status === 'EXACT_WIRE_BYTES_VERIFIED'))
  assert.ok(model.httpExchanges.every(item => item.response.integrity.status === 'EXACT_WIRE_BYTES_VERIFIED'))
  assert.ok(model.httpExchanges.every(item => item.request.plaintext.available))
  assert.ok(model.httpExchanges.every(item => item.response.plaintext.available))
  assert.deepEqual(
    model.httpExchanges.map(item => item.sequence),
    [...model.httpExchanges.map(item => item.sequence)].sort((a, b) => a - b),
  )
  assert.ok(model.httpExchanges.some(item => item.modelTurn?.bridge?.tools?.length))
})

test('parallel PhoneInput replay model links two subagents to parent Agent tools', async t => {
  if (!(await exists(parallel))) return t.skip('parallel PhoneInput run not available')
  const model = await buildReplayModel(parallel)
  assert.equal(model.agents.length, 2)
  const agentTools = new Set(model.tools.filter(tool => tool.name === 'Agent').map(tool => tool.id))
  for (const agent of model.agents) {
    assert.ok(agent.parentToolUseId)
    assert.ok(agentTools.has(agent.parentToolUseId))
  }
  assert.ok(model.concurrencyGroups.some(group =>
    group.members.filter(member => agentTools.has(member)).length === 2,
  ))
  assert.equal(model.run.status.execution.succeeded, false)
  assert.equal(model.run.status.execution.terminalReason, 'budget_exhausted')
})
