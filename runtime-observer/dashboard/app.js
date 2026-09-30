(function () {
  'use strict';

  const dataNode = document.getElementById('replay-data');
  const model = JSON.parse(dataNode.textContent || '{}');
  dataNode.textContent = '';
  const root = document.getElementById('http-exchanges');

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return '—';
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  function formatNumber(value) {
    return Number.isFinite(Number(value)) ? new Intl.NumberFormat('zh-CN').format(Number(value)) : '—';
  }

  function lazyDetails(title, value, attributes = {}) {
    const node = el('details', 'payload-details');
    Object.entries(attributes).forEach(([key, item]) => node.setAttribute(key, item));
    node.append(el('summary', '', title));
    let rendered = false;
    node.addEventListener('toggle', () => {
      if (!node.open || rendered) return;
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      node.append(el('pre', 'payload', text ?? ''));
      rendered = true;
    });
    return node;
  }

  function integrityLabel(side) {
    const integrity = side.integrity || {};
    const plain = side.plaintext || {};
    const labels = [integrity.status || 'INTEGRITY UNKNOWN'];
    if (plain.available) labels.push(plain.transform || 'UTF-8');
    else labels.push(`PLAINTEXT UNAVAILABLE: ${plain.error || 'decode failed'}`);
    return labels.join(' · ');
  }

  function renderTool(tool) {
    const node = el('article', 'tool-bridge');
    node.dataset.toolUseId = tool.toolUseId;
    node.append(el('strong', '', `${tool.name} · ${tool.toolUseId}`));
    node.append(el('p', 'tool-meta', `${tool.execution.status} · ${formatDuration(tool.execution.durationMs)} · permission ${tool.execution.permission?.status || 'unknown'}`));
    node.append(
      lazyDetails('Tool Input', tool.input),
      lazyDetails('Execution / Permission / Hooks', tool.execution),
      lazyDetails('Tool Results', tool.results),
      lazyDetails('Feedback in later Request', tool.feedback),
    );
    if (tool.feedbackRequestId) node.append(el('p', 'linkage', `Result → ${tool.feedbackRequestId}`));
    return node;
  }

  function renderModelEnrichment(exchange) {
    const turn = exchange.modelTurn;
    if (!turn) return null;
    const node = el('details', 'model-enrichment');
    node.dataset.modelEnrichment = '';
    node.append(el('summary', '', `Model SSE / Local Runtime Bridge · ${turn.response.sseEvents.length} events · ${turn.bridge.tools.length} tools`));
    const body = el('div', 'enrichment-body');
    body.append(
      lazyDetails('Parsed SSE Events', turn.response.sseEvents),
      lazyDetails('Assembled Response Blocks', turn.response.blocks),
    );
    if (turn.bridge.tools.length) {
      const bridge = el('section', 'bridge');
      bridge.append(el('h3', '', `Local Runtime Bridge → ${turn.bridge.nextRequestId || 'terminal'}`));
      bridge.append(el('p', 'bridge-order', `emit ${turn.bridge.emittedOrder.join(' → ') || 'none'} | complete ${turn.bridge.completionOrder.join(' → ') || 'none'} | feedback ${turn.bridge.feedbackOrder.join(' → ') || 'none'}`));
      turn.bridge.tools.forEach(tool => bridge.append(renderTool(tool)));
      bridge.append(lazyDetails('Messages added to linked Request', turn.bridge.continuationMessages));
      body.append(bridge);
    }
    node.append(body);
    return node;
  }

  function renderExchange(exchange, index) {
    const article = el('article', 'http-exchange');
    article.dataset.httpExchange = '';
    article.dataset.exchangeIndex = String(index + 1);
    article.dataset.requestId = exchange.requestId;
    article.dataset.kind = exchange.kind;

    const header = el('header', 'exchange-title');
    const heading = el('div');
    heading.append(
      el('h2', '', `Exchange ${index + 1} · ${exchange.method} ${exchange.path}`),
      el('p', 'exchange-id', `${exchange.requestId} · source sequence ${exchange.sequence} · ${exchange.acceptedAt || 'time unavailable'}`),
    );
    const status = el('div', 'status-block');
    status.append(
      el('span', `kind kind-${exchange.kind}`, exchange.kind),
      el('span', 'http-status', `HTTP ${exchange.statusCode ?? '—'}`),
      el('span', 'duration', formatDuration(exchange.durationMs)),
    );
    header.append(heading, status);
    article.append(header);

    const pair = el('div', 'exchange-pair');
    const request = el('section', 'pair-side request-side');
    request.append(
      el('h3', '', `Request ${index + 1} · ${formatNumber(exchange.request.integrity.bytes)} bytes`),
      el('p', exchange.request.integrity.status === 'EXACT_WIRE_BYTES_VERIFIED' ? 'integrity ok' : 'integrity error', integrityLabel(exchange.request)),
      lazyDetails('完整 Request 明文', exchange.request.plaintext.available ? exchange.request.plaintext.text : exchange.request.plaintext.error, { 'data-request-plaintext': '' }),
      lazyDetails('Request headers（认证信息已脱敏）', exchange.request.headers),
      lazyDetails('Request integrity / artifact', { ...exchange.request.integrity, rawRef: exchange.request.rawRef }),
    );
    const response = el('section', 'pair-side response-side');
    response.append(
      el('h3', '', `Response ${index + 1} · ${formatNumber(exchange.response.integrity.bytes)} bytes`),
      el('p', exchange.response.integrity.status === 'EXACT_WIRE_BYTES_VERIFIED' ? 'integrity ok' : 'integrity error', integrityLabel(exchange.response)),
      lazyDetails('完整 Response 明文', exchange.response.plaintext.available ? exchange.response.plaintext.text : exchange.response.plaintext.error, { 'data-response-plaintext': '' }),
      lazyDetails('Response headers（认证信息已脱敏）', exchange.response.headers),
      lazyDetails('Response integrity / artifact', { ...exchange.response.integrity, rawRef: exchange.response.rawRef }),
    );
    pair.append(request, response);
    article.append(pair);

    const enrichment = renderModelEnrichment(exchange);
    if (enrichment) article.append(enrichment);
    return article;
  }

  const exchanges = model.httpExchanges || [];
  document.title = `33333 HTTP Replay · ${model.run?.id || 'run'}`;
  document.getElementById('run-subtitle').textContent = model.run?.task || '';
  const prompt = model.promptFidelity;
  const routing = model.run?.routingFidelity;
  const parity = model.parity || { status: 'PARITY_UNVERIFIED' };
  const parityStatus = document.getElementById('parity-status');
  parityStatus.textContent = `Execution parity: ${parity.status}`;
  parityStatus.classList.toggle('invalid', parity.status !== 'PARITY_VERIFIED_WITH_DECLARED_ROUTING');
  const valid = Boolean(
    prompt?.validForPromptBehaviorResearch &&
    routing?.validForRoutedExperiment &&
    parity.status === 'PARITY_VERIFIED_WITH_DECLARED_ROUTING'
  );
  const captureStatus = document.getElementById('capture-status');
  captureStatus.textContent = `Prompt: ${prompt?.mode || 'unknown'} · Routing: ${routing?.status || 'not recorded'} · ${valid ? 'VALID' : 'INVALID'}`;
  captureStatus.classList.toggle('invalid', !valid);
  const counts = exchanges.reduce((result, exchange) => {
    result[exchange.kind] = (result[exchange.kind] || 0) + 1;
    return result;
  }, {});
  document.getElementById('exchange-count').textContent = `${exchanges.length} 个完整 HTTP Request/Response Pair · messages ${counts.messages || 0} · count_tokens ${counts.count_tokens || 0} · other ${(counts.models || 0) + (counts.auxiliary || 0)}`;
  root.replaceChildren(...exchanges.map(renderExchange));
})();
