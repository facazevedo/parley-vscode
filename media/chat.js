// Parley chat webview script. Loaded as an external resource (with a nonce) so
// backticks and regular expressions are not double-escaped through a template literal.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const history = $('history');
  const agent = $('agent');
  const effortSel = $('effort');
  const banner = $('banner');
  const form = $('composer');
  const prompt = $('prompt');
  const stopBtn = $('stop');
  const sendBtn = $('sendBtn');
  const attachBtn = $('attach');
  const agentModeBox = $('agentMode');
  const attachmentsEl = $('attachments');
  const boxes = {
    includeSelection: $('includeSelection'),
    includeCurrentFile: $('includeCurrentFile'),
    includeOpenEditors: $('includeOpenEditors'),
    includeDiagnostics: $('includeDiagnostics'),
    includeUserSelectedFiles: $('includeUserSelectedFiles')
  };
  let streamText = null;
  let streamToolLog = null;

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inlineMd(text) {
    let h = escapeHtml(text);
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\n/g, '<br>');
    return h;
  }

  function renderMd(src) {
    const fence = /```[\w.+-]*\n([\s\S]*?)```/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = fence.exec(src))) {
      out += inlineMd(src.slice(last, m.index));
      out += '<pre><code>' + escapeHtml(m[1]) + '</code></pre>';
      last = fence.lastIndex;
    }
    out += inlineMd(src.slice(last));
    return out;
  }

  function bubble(role, html) {
    const node = document.createElement('div');
    node.className = 'message ' + role;
    const c = document.createElement('div');
    c.className = 'content';
    c.innerHTML = html;
    node.append(c);
    history.append(node);
    history.scrollTop = history.scrollHeight;
    return c;
  }

  function ensureStreamBubble() {
    if (streamText) {
      return;
    }
    const node = document.createElement('div');
    node.className = 'message assistant';
    const c = document.createElement('div');
    c.className = 'content cursor';
    streamToolLog = document.createElement('div');
    streamToolLog.className = 'toollog';
    streamText = document.createElement('div');
    c.append(streamToolLog, streamText);
    node.append(c);
    history.append(node);
    history.scrollTop = history.scrollHeight;
  }

  function sendPrompt() {
    const value = prompt.value.trim();
    if (!value) {
      return;
    }
    vscode.postMessage({ type: 'send', prompt: value });
    prompt.value = '';
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendPrompt();
  });
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refreshAgents' }));
  $('newChat').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  $('export').addEventListener('click', () => vscode.postMessage({ type: 'export' }));
  attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'attachFiles' }));
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  agent.addEventListener('change', () => vscode.postMessage({ type: 'agentChanged', agentId: agent.value }));
  effortSel.addEventListener('change', () => vscode.postMessage({ type: 'effortChanged', effort: effortSel.value }));
  agentModeBox.addEventListener('change', () =>
    vscode.postMessage({ type: 'agentModeChanged', value: agentModeBox.checked })
  );
  Object.values(boxes).forEach((box) =>
    box.addEventListener('change', () => {
      vscode.postMessage({
        type: 'contextOptionsChanged',
        contextOptions: Object.fromEntries(Object.entries(boxes).map(([k, i]) => [k, i.checked]))
      });
    })
  );

  function renderAttachments(items) {
    attachmentsEl.replaceChildren();
    (items || []).forEach((att) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = (att.kind === 'image' ? '🖼 ' : '📄 ') + att.label;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chipx';
      x.textContent = '×';
      x.addEventListener('click', () => vscode.postMessage({ type: 'removeAttachment', id: att.id }));
      chip.append(x);
      attachmentsEl.append(chip);
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'streamStart') {
      ensureStreamBubble();
      return;
    }
    if (msg.type === 'streamDelta') {
      ensureStreamBubble();
      streamText.textContent += msg.delta;
      history.scrollTop = history.scrollHeight;
      return;
    }
    if (msg.type === 'toolEvent') {
      ensureStreamBubble();
      const line = document.createElement('div');
      line.className = 'toolline';
      const args = (msg.args || '').replace(/\s+/g, ' ').slice(0, 80);
      line.textContent = '⚙ ' + msg.name + (args && args !== '{}' ? ' ' + args : '');
      streamToolLog.append(line);
      history.scrollTop = history.scrollHeight;
      return;
    }
    if (msg.type === 'streamEnd') {
      streamText = null;
      streamToolLog = null;
      return;
    }
    if (msg.type !== 'state') {
      return;
    }

    agent.replaceChildren(
      ...msg.agents.map((item) => {
        const o = document.createElement('option');
        o.value = item.id;
        o.textContent = item.label;
        o.selected = item.id === msg.selectedAgentId;
        return o;
      })
    );
    Object.entries(msg.contextOptions).forEach(([k, v]) => {
      if (boxes[k]) {
        boxes[k].checked = v;
      }
    });
    agentModeBox.checked = Boolean(msg.agentMode);
    effortSel.value = msg.selectedEffort || '';
    renderAttachments(msg.attachments);

    stopBtn.style.display = msg.busy ? '' : 'none';
    sendBtn.disabled = msg.busy;

    if (!msg.hasKey) {
      banner.className = 'banner show';
      banner.textContent = 'No API key set. ';
      const b = document.createElement('button');
      b.textContent = 'Set API Key';
      b.addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
      banner.append(b);
    } else {
      banner.className = 'banner';
      banner.textContent = '';
    }

    streamText = null;
    streamToolLog = null;
    if (!msg.history.length) {
      history.innerHTML = '<div class="empty">Ask Parley about your code.</div>';
      return;
    }
    history.replaceChildren();
    msg.history.forEach((item) => bubble(item.role, renderMd(item.content)));
  });
})();
