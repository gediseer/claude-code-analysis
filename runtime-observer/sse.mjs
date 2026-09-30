export function parseSse(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer)
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const events = []
  let event = { event: 'message', dataLines: [] }
  function flush() {
    if (!event.dataLines.length && event.event === 'message' && event.id === undefined && event.retry === undefined) {
      event = { event: 'message', dataLines: [] }
      return
    }
    const data = event.dataLines.join('\n')
    let json = null
    if (data) {
      try { json = JSON.parse(data) } catch {}
    }
    events.push({
      event: event.event || 'message',
      id: event.id,
      retry: event.retry,
      data,
      json,
    })
    event = { event: 'message', dataLines: [] }
  }
  for (const line of normalized.split('\n')) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event.event = value
    else if (field === 'data') event.dataLines.push(value)
    else if (field === 'id') event.id = value
    else if (field === 'retry') event.retry = Number(value)
  }
  flush()
  return events
}

export function aggregateSseBlocks(events) {
  const blocks = new Map()
  let messageId = null
  let model = null
  let stopReason = null
  let usage = null
  for (let seq = 0; seq < events.length; seq += 1) {
    const payload = events[seq].json
    if (!payload) continue
    if (payload.type === 'message_start') {
      messageId = payload.message?.id || messageId
      model = payload.message?.model || model
      usage = payload.message?.usage || usage
    }
    const index = Number.isInteger(payload.index) ? payload.index : null
    if (payload.type === 'content_block_start' && index !== null) {
      const block = payload.content_block || {}
      blocks.set(index, {
        index,
        type: block.type || 'unknown',
        toolUseId: block.id || null,
        toolName: block.name || null,
        fragments: [],
        firstSeq: seq,
        lastSeq: seq,
        assembled: block.type === 'text' ? block.text || '' : '',
        parsedInput: null,
        complete: false,
      })
    }
    if (payload.type === 'content_block_delta' && index !== null) {
      const block = blocks.get(index) || {
        index,
        type: payload.delta?.type || 'unknown',
        toolUseId: null,
        toolName: null,
        fragments: [],
        firstSeq: seq,
        lastSeq: seq,
        assembled: '',
        parsedInput: null,
        complete: false,
      }
      const delta = payload.delta || {}
      const fragment =
        delta.type === 'text_delta' || delta.type === 'thinking_delta'
          ? delta.text || delta.thinking || ''
          : delta.type === 'input_json_delta'
            ? delta.partial_json || ''
            : ''
      block.fragments.push({ seq, type: delta.type || 'unknown', value: fragment })
      block.assembled += fragment
      block.lastSeq = seq
      blocks.set(index, block)
    }
    if (payload.type === 'content_block_stop' && index !== null) {
      const block = blocks.get(index)
      if (block) {
        block.complete = true
        block.lastSeq = seq
        if (block.type === 'tool_use' && block.assembled) {
          try { block.parsedInput = JSON.parse(block.assembled) } catch {}
        }
      }
    }
    if (payload.type === 'message_delta') {
      stopReason = payload.delta?.stop_reason ?? stopReason
      usage = payload.usage ?? usage
    }
  }
  return {
    messageId,
    model,
    stopReason,
    usage,
    blocks: [...blocks.values()].sort((a, b) => a.index - b.index),
  }
}

export function summarizeSse(events) {
  const counts = {}
  for (const event of events) {
    const type = event.json?.type || event.event || 'unknown'
    counts[type] = (counts[type] || 0) + 1
  }
  const aggregate = aggregateSseBlocks(events)
  return {
    events: events.length,
    counts,
    messageId: aggregate.messageId,
    model: aggregate.model,
    blocks: aggregate.blocks.map(block => ({
      index: block.index,
      type: block.type,
      toolUseId: block.toolUseId,
      toolName: block.toolName,
      fragmentCount: block.fragments.length,
      firstSeq: block.firstSeq,
      lastSeq: block.lastSeq,
      assembled: block.type === 'thinking' || block.type === 'redacted_thinking'
        ? ''
        : block.assembled,
      hiddenReasoning: block.type === 'thinking' || block.type === 'redacted_thinking'
        ? { omitted: true, returnedByProvider: true, fragmentCount: block.fragments.length }
        : undefined,
      parsedInput: block.parsedInput,
      complete: block.complete,
    })),
    visibleText: aggregate.blocks
      .filter(block => block.type === 'text')
      .map(block => block.assembled)
      .join(''),
    toolInputs: aggregate.blocks
      .filter(block => block.type === 'tool_use')
      .map(block => ({
        index: block.index,
        toolUseId: block.toolUseId,
        toolName: block.toolName,
        json: block.assembled,
        input: block.parsedInput,
        complete: block.complete,
      })),
    stopReason: aggregate.stopReason,
    usage: aggregate.usage,
  }
}
