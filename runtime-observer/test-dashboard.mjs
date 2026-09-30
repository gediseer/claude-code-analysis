#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { buildRuntimeDashboard } from './build-runtime-dashboard.mjs'
import { exists } from './lib.mjs'

const run = path.resolve(
  'E:/repo/.claude/claude-code-runs/phoneinput-exact-observer-20260927-v2',
)

test('dashboard renders every HTTP exchange as a chronological request/response pair', async t => {
  if (!(await exists(run))) return t.skip('exact observer run not available')
  const result = await buildRuntimeDashboard(run)
  const html = await readFile(result.htmlPath, 'utf8')
  assert.doesNotMatch(html, /<script[^>]+src=/i)
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i)
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  const executable = scripts
    .filter(match => !/type=["']application\/json["']/i.test(match[0]))
    .map(match => match[1])
    .join('\n')
  assert.doesNotMatch(executable, /\bfetch\s*\(/)
  assert.match(html, /id="http-exchanges"/)
  assert.match(html, /HTTP Request \/ Response Replay/)
  assert.match(html, /完整 Request 明文/)
  assert.match(html, /完整 Response 明文/)
  assert.match(html, /Local Runtime Bridge/)
  assert.match(html, /dataset\.httpExchange/)
  assert.match(html, /data-request-plaintext/)
  assert.match(html, /data-response-plaintext/)
  assert.doesNotMatch(html, /id="api-turns"/)
  assert.doesNotMatch(html, /role="tab"/)
  assert.doesNotMatch(html, /Runtime 架构|class="controls"|#inspector/)

  assert.equal(result.pageModel.parity.status, 'LEGACY_HEADLESS_NONPARITY')
  assert.equal(result.pageModel.httpExchanges.length, 206)
  assert.equal(result.pageModel.httpExchanges.filter(item => item.kind === 'count_tokens').length, 15)
  assert.equal(result.pageModel.httpExchanges.filter(item => item.kind === 'messages').length, 191)
  assert.deepEqual(
    result.pageModel.httpExchanges.map(item => item.sequence),
    [...result.pageModel.httpExchanges.map(item => item.sequence)].sort((a, b) => a - b),
  )
  assert.ok(result.pageModel.httpExchanges.every(item => item.request.integrity.paired))
  assert.ok(result.pageModel.httpExchanges.every(item => item.response.integrity.paired))
  assert.ok(result.pageModel.httpExchanges.every(item => item.request.plaintext.available))
  assert.ok(result.pageModel.httpExchanges.every(item => item.response.plaintext.available))
  assert.ok(result.pageModel.httpExchanges.some(item => item.modelTurn?.bridge?.tools?.length))

  const htmlSize = (await stat(result.htmlPath)).size
  const textBytes = result.pageModel.httpExchanges.reduce(
    (sum, item) =>
      sum +
      Buffer.byteLength(item.request.plaintext.text || '') +
      Buffer.byteLength(item.response.plaintext.text || ''),
    0,
  )
  assert.ok(htmlSize < textBytes * 4 + 2_000_000)
})
