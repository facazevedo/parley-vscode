// Parley chat webview script. Source for the bundled dist/webview.js (esbuild pulls
// in markdown-it + highlight.js), loaded by the webview with a nonce.
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';

(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const history = $('history');
  const agent = $('agent');
  const banner = $('banner');
  const form = $('composer');
  const prompt = $('prompt');
  const stopBtn = $('stop');
  const sendBtn = $('sendBtn');
  const attachBtn = $('attach');
  const modeBtn = $('modeBtn');
  const modePanel = $('modePanel');
  const attachmentsEl = $('attachments');
  const mentionsEl = $('mentions');
  const slashMenuEl = $('slashMenu');
  const ctxEl = $('ctx');
  const statusEl = $('status');
  const sessionTokEl = $('sessionTok');
  const jumpBtn = $('jump');

  // ---------- Scroll lock ----------
  // Autoscroll only while the user is pinned to the bottom; scrolling up to read
  // pauses it and shows a "jump to latest" pill instead of yanking the view down.
  let pinned = true;
  function updateJump() {
    jumpBtn.classList.toggle('show', !pinned);
  }
  function maybeScroll(force) {
    if (force) {
      pinned = true;
    }
    if (pinned) {
      history.scrollTop = history.scrollHeight;
    }
    updateJump();
  }
  history.addEventListener('scroll', () => {
    pinned = history.scrollHeight - history.scrollTop - history.clientHeight < 48;
    updateJump();
  });
  jumpBtn.addEventListener('click', () => maybeScroll(true));

  let sessionCostUsd = 0;
  let contextPct = null;
  function fmtUsd(a) {
    if (!isFinite(a) || a <= 0) {
      return '$0.00';
    }
    return a < 0.01 ? '<$0.01' : '$' + a.toFixed(2);
  }
  function renderSessionTokens(n) {
    const parts = [];
    if (n > 0) {
      parts.push(Number(n).toLocaleString() + ' tok');
    }
    if (sessionCostUsd > 0) {
      parts.push('~' + fmtUsd(sessionCostUsd));
    }
    sessionTokEl.textContent = parts.length ? '· ' + parts.join(' · ') : '';
  }
  // Circular context-window usage gauge.
  function renderContextMeter() {
    // Always visible. `contextPct == null` means the model's window is unknown — show a
    // neutral 0% ring rather than hiding it.
    const known = contextPct != null && contextPct >= 0;
    const pct = known ? contextPct : 0;
    const color =
      pct >= 85
        ? 'var(--vscode-errorForeground)'
        : pct >= 60
          ? '#d9a400'
          : 'var(--vscode-progressBar-background, var(--vscode-focusBorder))';
    const ring = ctxEl.querySelector('.ctxring');
    const num = ctxEl.querySelector('.ctxnum');
    ring.style.background = 'conic-gradient(' + color + ' ' + pct + '%, rgba(127,127,127,0.25) 0)';
    num.textContent = known ? pct + '%' : '–';
    ctxEl.title = known
      ? 'Context window used: ' + pct + '% (auto-compacts when it fills up)'
      : 'Context usage (window size unknown for this model)';
    ctxEl.style.display = 'inline-flex';
  }
  let statusBase = '';
  let exactTokens = 0; // exact tokens reported by the API so far this turn
  let liveChars = 0; // chars streamed in the current round (for a live estimate)
  let turnStart = 0; // timestamp the current turn began
  let ticker = null; // interval that refreshes the elapsed time
  function elapsedText() {
    if (!turnStart) {
      return '';
    }
    const s = Math.floor((Date.now() - turnStart) / 1000);
    return ' (' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ')';
  }
  function renderStatus() {
    if (!statusBase) {
      statusEl.style.display = 'none';
      statusEl.textContent = '';
      return;
    }
    const total = exactTokens + Math.round(liveChars / 4);
    statusEl.textContent = statusBase + elapsedText() + (total > 0 ? ' · ' + total.toLocaleString() + ' tokens' : '');
    statusEl.style.display = 'block';
  }
  function setStatus(base) {
    statusBase = base;
    renderStatus();
  }
  function startTicker() {
    if (!ticker) {
      ticker = setInterval(renderStatus, 1000);
    }
  }
  function stopTicker() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }
  const MODE_LABELS = {
    chat: 'Chat',
    ask: 'Ask before edits',
    edit: 'Edit auto',
    plan: 'Plan',
    auto: 'Auto',
    full: 'Full ⚠'
  };
  const boxes = {
    includeSelection: $('includeSelection'),
    includeCurrentFile: $('includeCurrentFile'),
    includeOpenEditors: $('includeOpenEditors'),
    includeDiagnostics: $('includeDiagnostics'),
    includeUserSelectedFiles: $('includeUserSelectedFiles')
  };
  let streamNode = null;
  let streamContent = null;
  let currentSeg = null;
  let thinkingDet = null;
  let thinkingBody = null;
  let planEl = null;

  function activityLabel(name, argsStr) {
    let a = {};
    try {
      a = JSON.parse(argsStr || '{}');
    } catch (e) {
      a = {};
    }
    switch (name) {
      case 'read_file':
        return 'Reading ' + (a.path || '');
      case 'list_directory':
        return 'Listing ' + (a.path || '.');
      case 'find_files':
        return 'Finding ' + (a.glob || '');
      case 'search_text':
        return 'Searching "' + (a.query || '') + '"';
      case 'grep':
        return 'Grepping /' + (a.pattern || '') + '/';
      case 'find_symbol':
        return 'Finding symbol "' + (a.query || '') + '"';
      case 'document_symbols':
        return 'Outlining ' + (a.path || '');
      case 'find_references':
        return 'Finding references to ' + (a.symbol || '');
      case 'write_file':
        return 'Editing ' + (a.path || '');
      case 'run_command':
        return 'Running: ' + (a.command || '');
      case 'fetch_url':
        return 'Fetching ' + (a.url || '');
      default:
        return name + ' ' + (argsStr || '').slice(0, 60);
    }
  }

  // ---------- Markdown (markdown-it + highlight.js) ----------
  const md = new MarkdownIt({
    html: false, // never render raw HTML from the model
    linkify: true,
    breaks: true, // single newlines are line breaks, matching the streamed plain-text look
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch (e) {
          // Fall through to markdown-it's own escaping.
        }
      }
      return '';
    }
  });
  function renderMd(src) {
    return md.render(String(src || ''));
  }
  function enhanceContent(contentEl) {
    // Copy button on each fenced block.
    contentEl.querySelectorAll('pre').forEach((pre) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => {
        const code = pre.querySelector('code');
        vscode.postMessage({ type: 'copyText', text: code ? code.textContent : pre.textContent });
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1200);
      });
      pre.appendChild(btn);
    });
    // Route links through the extension (vscode.env.openExternal) instead of navigating the webview.
    contentEl.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href') || '';
      a.classList.add('lnk');
      a.dataset.href = href;
      a.removeAttribute('href');
    });
  }

  // ---------- steering queue + edit-and-resend state ----------
  const queuedEl = $('queued');
  const editingEl = $('editing');
  let busy = false;
  let editingOrdinal = null;
  function renderQueued(items) {
    queuedEl.replaceChildren();
    (items || []).forEach((text, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip queuedchip';
      chip.title = 'Queued — the agent sees this at its next step';
      chip.textContent = '⏩ ' + (text.length > 60 ? text.slice(0, 60) + '…' : text);
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chipx';
      x.textContent = '×';
      x.addEventListener('click', () => vscode.postMessage({ type: 'unqueue', index: i }));
      chip.append(x);
      queuedEl.append(chip);
    });
  }
  function setEditing(ordinal) {
    editingOrdinal = ordinal;
    editingEl.replaceChildren();
    if (ordinal === null) {
      editingEl.style.display = 'none';
      return;
    }
    const span = document.createElement('span');
    span.textContent =
      '✏️ Editing an earlier message — sending rewinds the conversation to that point (files keep their changes).';
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chipx';
    x.textContent = '×';
    x.title = 'Cancel editing';
    x.addEventListener('click', () => setEditing(null));
    editingEl.append(span, x);
    editingEl.style.display = 'flex';
  }
  function addEditButton(messageNode, text, ordinal) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msgedit';
    btn.title = 'Edit & resend (forks the conversation at this message)';
    btn.setAttribute('aria-label', 'Edit and resend');
    btn.textContent = '✏️';
    btn.addEventListener('click', () => {
      if (busy) {
        return; // can't rewind while the agent is running
      }
      prompt.value = text;
      setEditing(ordinal);
      prompt.focus();
    });
    messageNode.appendChild(btn);
    const rw = document.createElement('button');
    rw.type = 'button';
    rw.className = 'msgrewind';
    rw.title = 'Rewind to here (fork conversation / restore files / both)';
    rw.setAttribute('aria-label', 'Rewind to this message');
    rw.textContent = '⏪';
    rw.addEventListener('click', () => {
      if (busy) {
        return;
      }
      vscode.postMessage({ type: 'rewind', ordinal });
    });
    messageNode.appendChild(rw);
  }

  // Copy (two overlapping squares) icon used on user prompts.
  const COPY_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">' +
    '<rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5"/>' +
    '<path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1"/></svg>';
  function addCopyButton(messageNode, text) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msgcopy';
    btn.title = 'Copy prompt';
    btn.setAttribute('aria-label', 'Copy prompt');
    btn.innerHTML = COPY_SVG;
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'copyText', text });
      btn.classList.add('copied');
      btn.innerHTML = '✓';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = COPY_SVG;
      }, 1200);
    });
    messageNode.appendChild(btn);
  }

  // ---------- Bubbles ----------
  function bubble(role, html) {
    const node = document.createElement('div');
    node.className = 'message ' + role;
    const c = document.createElement('div');
    c.className = 'content';
    c.innerHTML = html;
    enhanceContent(c);
    node.append(c);
    history.append(node);
    maybeScroll();
    return c;
  }
  function ensureStreamBubble() {
    if (streamContent) {
      return;
    }
    streamNode = document.createElement('div');
    streamNode.className = 'message assistant';
    streamContent = document.createElement('div');
    streamContent.className = 'content cursor';
    currentSeg = document.createElement('div');
    currentSeg.className = 'seg';
    streamContent.append(currentSeg);
    streamNode.append(streamContent);
    history.append(streamNode);
    maybeScroll();
  }
  // Collapsible "Thinking" panel shown above the answer while reasoning streams in.
  function ensureThinkingBlock() {
    ensureStreamBubble();
    if (thinkingBody) {
      return;
    }
    thinkingDet = document.createElement('details');
    thinkingDet.className = 'thinking';
    thinkingDet.open = true;
    const sum = document.createElement('summary');
    sum.textContent = '💭 Thinking…';
    thinkingBody = document.createElement('div');
    thinkingBody.className = 'think-body';
    thinkingDet.append(sum, thinkingBody);
    streamNode.insertBefore(thinkingDet, streamContent);
  }
  function finishThinkingBlock() {
    if (thinkingDet) {
      thinkingDet.open = false;
      const sum = thinkingDet.querySelector('summary');
      if (sum) {
        sum.textContent = '💭 Thought';
      }
    }
    thinkingDet = null;
    thinkingBody = null;
  }
  function streamActionLine(text) {
    ensureStreamBubble();
    const line = document.createElement('div');
    line.className = 'toolline';
    line.textContent = text;
    streamContent.append(line);
    // Start a fresh text segment so subsequent narration appears below the action.
    currentSeg = document.createElement('div');
    currentSeg.className = 'seg';
    streamContent.append(currentSeg);
    maybeScroll();
  }
  // Claude-style "⎿ result" line shown under the preceding "⏺ action".
  function streamResultLine(text) {
    ensureStreamBubble();
    const line = document.createElement('div');
    line.className = 'toolresult';
    line.textContent = '⎿ ' + text;
    streamContent.append(line);
    currentSeg = document.createElement('div');
    currentSeg.className = 'seg';
    streamContent.append(currentSeg);
    maybeScroll();
  }
  // Live task checklist (update_plan). One card per turn, updated in place.
  function renderPlan(steps) {
    ensureStreamBubble();
    if (!planEl) {
      planEl = document.createElement('div');
      planEl.className = 'plancard';
      streamNode.insertBefore(planEl, streamContent);
    }
    const done = steps.filter((s) => s.status === 'done').length;
    const head = document.createElement('div');
    head.className = 'planhead';
    head.textContent = 'Plan · ' + done + '/' + steps.length;
    const list = document.createElement('div');
    steps.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'planrow ' + (s.status || 'pending');
      const icon = s.status === 'done' ? '☑' : s.status === 'in_progress' ? '▸' : '☐';
      const ic = document.createElement('span');
      ic.className = 'planicon';
      ic.textContent = icon;
      const tx = document.createElement('span');
      tx.className = 'plantext';
      tx.textContent = s.step;
      row.append(ic, tx);
      list.append(row);
    });
    planEl.replaceChildren(head, list);
    maybeScroll();
  }
  // Claude-Code-style inline diff card for an applied file edit.
  function renderFileEdit(msg) {
    ensureStreamBubble();
    const card = document.createElement('div');
    card.className = 'diffcard';

    const head = document.createElement('div');
    head.className = 'diffhead';
    const verb = document.createElement('span');
    verb.className = 'diffverb';
    verb.textContent = 'Edit';
    const pathEl = document.createElement('span');
    pathEl.className = 'diffpath';
    pathEl.textContent = msg.path;
    const counts = document.createElement('span');
    counts.className = 'diffcounts';
    const parts = [];
    if (msg.added) parts.push('+' + msg.added);
    if (msg.removed) parts.push('−' + msg.removed);
    counts.textContent = parts.join('  ');
    head.append(verb, pathEl, counts);

    const body = document.createElement('div');
    body.className = 'diffbody';
    for (const row of msg.rows || []) {
      const r = document.createElement('div');
      r.className = 'drow ' + row.kind;
      const gutter = document.createElement('span');
      gutter.className = 'dgutter';
      gutter.textContent =
        row.kind === 'gap' ? '' : row.kind === 'del' ? String(row.oldNo || '') : String(row.newNo || '');
      const sign = document.createElement('span');
      sign.className = 'dsign';
      sign.textContent = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : '';
      const text = document.createElement('span');
      text.className = 'dtext';
      text.textContent = row.kind === 'gap' ? '⋯' : row.text;
      r.append(gutter, sign, text);
      body.append(r);
    }
    if (msg.truncated) {
      const more = document.createElement('div');
      more.className = 'drow gap';
      more.textContent = '⋯ (diff truncated)';
      body.append(more);
    }

    card.append(head, body);
    streamContent.append(card);
    currentSeg = document.createElement('div');
    currentSeg.className = 'seg';
    streamContent.append(currentSeg);
    maybeScroll();
  }

  // ---------- inline "Apply" cards for chat-mode proposed changes ----------
  const proposedCards = {};
  function buildDiffRows(msg) {
    const body = document.createElement('div');
    body.className = 'diffbody';
    for (const row of msg.rows || []) {
      const r = document.createElement('div');
      r.className = 'drow ' + row.kind;
      const gutter = document.createElement('span');
      gutter.className = 'dgutter';
      gutter.textContent =
        row.kind === 'gap' ? '' : row.kind === 'del' ? String(row.oldNo || '') : String(row.newNo || '');
      const sign = document.createElement('span');
      sign.className = 'dsign';
      sign.textContent = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : '';
      const text = document.createElement('span');
      text.className = 'dtext';
      text.textContent = row.kind === 'gap' ? '⋯' : row.text;
      r.append(gutter, sign, text);
      body.append(r);
    }
    if (msg.truncated) {
      const more = document.createElement('div');
      more.className = 'drow gap';
      more.textContent = '⋯ (diff truncated)';
      body.append(more);
    }
    return body;
  }
  function renderProposedChange(msg) {
    const card = document.createElement('div');
    card.className = 'diffcard proposed';

    const head = document.createElement('div');
    head.className = 'diffhead';
    const verb = document.createElement('span');
    verb.className = 'diffverb';
    verb.textContent = msg.isNew ? 'New file' : 'Proposed';
    const pathEl = document.createElement('span');
    pathEl.className = 'diffpath';
    pathEl.textContent = msg.path;
    const counts = document.createElement('span');
    counts.className = 'diffcounts';
    const parts = [];
    if (msg.added) parts.push('+' + msg.added);
    if (msg.removed) parts.push('−' + msg.removed);
    counts.textContent = parts.join('  ');
    head.append(verb, pathEl, counts);

    card.append(head, buildDiffRows(msg), buildCardActions(msg.id, msg.isNew, card));
    history.append(card);
    maybeScroll();
  }
  // Buttons for a proposed change. The first click disables ALL buttons (the
  // extension resolves the card via changeResolved), so clicks can't race.
  // Agent-approval cards (ids starting "apr") get Apply / Choose hunks… / Reject;
  // chat-mode suggestion cards keep Apply / Dismiss.
  function buildCardActions(id, isNew, card) {
    const approval = /^apr/.test(String(id));
    const actions = document.createElement('div');
    actions.className = 'diffactions';
    const buttons = [];
    const act = (type) => {
      buttons.forEach((b) => (b.disabled = true));
      vscode.postMessage({ type, id });
    };
    const applyBtn = document.createElement('button');
    applyBtn.className = 'applybtn';
    applyBtn.textContent = isNew ? 'Create file' : 'Apply';
    applyBtn.addEventListener('click', () => act('applyChange'));
    buttons.push(applyBtn);
    if (approval) {
      const reviewBtn = document.createElement('button');
      reviewBtn.className = 'dismissbtn';
      reviewBtn.textContent = 'Choose hunks…';
      reviewBtn.title = 'Pick which hunks to apply in a dialog';
      reviewBtn.addEventListener('click', () => act('reviewChange'));
      buttons.push(reviewBtn);
    }
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'dismissbtn';
    dismissBtn.textContent = approval ? 'Reject' : 'Dismiss';
    dismissBtn.addEventListener('click', () => act('dismissChange'));
    buttons.push(dismissBtn);
    actions.append(...buttons);
    proposedCards[id] = { card, actions };
    return actions;
  }
  function resolveProposedChange(id, status) {
    const entry = proposedCards[id];
    if (!entry) {
      return;
    }
    const label = document.createElement('div');
    label.className = 'diffstatus ' + status;
    label.textContent = status === 'applied' ? '✓ Applied' : status === 'error' ? '⚠ Failed to apply' : 'Dismissed';
    entry.actions.replaceWith(label);
    entry.card.classList.add('resolved');
    delete proposedCards[id];
  }

  // ---------- full-transcript render (postState / past conversations) ----------
  // Renders everything that was shown — messages, tool activity, diffs, plans, notes —
  // so re-renders and reopened conversations are complete (not just the message text).
  function fileEditLabel(status, isNew) {
    if (status === 'applied') return isNew ? 'Created' : 'Applied';
    if (status === 'proposed') return isNew ? 'New file' : 'Proposed';
    if (status === 'dismissed') return 'Dismissed';
    if (status === 'error') return 'Failed';
    return status;
  }
  function renderStaticDiffCard(e, pendingIds) {
    const interactive = e.status === 'proposed' && e.id && pendingIds.indexOf(e.id) !== -1;
    const card = document.createElement('div');
    card.className = 'diffcard' + (e.status === 'proposed' ? ' proposed' : '') + (interactive ? '' : ' resolved');
    const head = document.createElement('div');
    head.className = 'diffhead';
    const verb = document.createElement('span');
    verb.className = 'diffverb';
    verb.textContent = fileEditLabel(e.status, e.isNew);
    const pathEl = document.createElement('span');
    pathEl.className = 'diffpath';
    pathEl.textContent = e.path;
    const counts = document.createElement('span');
    counts.className = 'diffcounts';
    const parts = [];
    if (e.added) parts.push('+' + e.added);
    if (e.removed) parts.push('−' + e.removed);
    counts.textContent = parts.join('  ');
    head.append(verb, pathEl, counts);
    card.append(head, buildDiffRows(e));
    if (interactive) {
      card.append(buildCardActions(e.id, e.isNew, card));
    }
    history.append(card);
  }
  function renderStaticPlan(steps) {
    const card = document.createElement('div');
    card.className = 'plancard';
    const done = steps.filter((s) => s.status === 'done').length;
    const head = document.createElement('div');
    head.className = 'planhead';
    head.textContent = 'Plan · ' + done + '/' + steps.length;
    const list = document.createElement('div');
    steps.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'planrow ' + (s.status || 'pending');
      const ic = document.createElement('span');
      ic.className = 'planicon';
      ic.textContent = s.status === 'done' ? '☑' : s.status === 'in_progress' ? '▸' : '☐';
      const tx = document.createElement('span');
      tx.className = 'plantext';
      tx.textContent = s.text;
      row.append(ic, tx);
      list.append(row);
    });
    card.append(head, list);
    history.append(card);
  }
  function renderTranscript(entries, pendingIds) {
    history.replaceChildren();
    pendingIds = pendingIds || [];
    let userOrdinal = 0;
    for (const e of entries) {
      if (e.kind === 'user') {
        const c = bubble('user', renderMd(e.text));
        if (e.images && e.images.length) {
          const wrap = document.createElement('div');
          wrap.className = 'msgimgs';
          e.images.forEach((src) => {
            const img = document.createElement('img');
            img.className = 'msgimg';
            img.src = src;
            wrap.append(img);
          });
          c.append(wrap);
        }
        addCopyButton(c.parentNode, e.text);
        addEditButton(c.parentNode, e.text, userOrdinal);
        userOrdinal += 1;
      } else if (e.kind === 'assistant') {
        const c = bubble('assistant', renderMd(e.text));
        if (e.thinking) {
          const det = document.createElement('details');
          det.className = 'thinking';
          const sum = document.createElement('summary');
          sum.textContent = '💭 Thought';
          const body = document.createElement('div');
          body.className = 'think-body';
          body.textContent = e.thinking;
          det.append(sum, body);
          c.parentNode.insertBefore(det, c);
        }
        if (e.model || e.tokens) {
          const meta = document.createElement('div');
          meta.className = 'meta';
          const parts = [];
          if (e.model) parts.push(e.model);
          if (e.tokens) parts.push(e.tokens + ' tokens');
          meta.textContent = parts.join(' · ');
          c.parentNode.append(meta);
        }
      } else if (e.kind === 'tool') {
        const wrap = document.createElement('div');
        wrap.className = 'message assistant';
        const c = document.createElement('div');
        c.className = 'content';
        const a = document.createElement('div');
        a.className = 'toolline';
        a.textContent = '⏺ ' + e.action;
        c.append(a);
        if (e.result) {
          const r = document.createElement('div');
          r.className = 'toolresult';
          r.textContent = '⎿ ' + e.result;
          c.append(r);
        }
        wrap.append(c);
        history.append(wrap);
      } else if (e.kind === 'fileEdit') {
        renderStaticDiffCard(e, pendingIds);
      } else if (e.kind === 'plan') {
        renderStaticPlan(e.steps || []);
      } else if (e.kind === 'note') {
        const c = bubble('assistant', renderMd(e.text));
        c.parentNode.classList.add('note');
      }
    }
    maybeScroll();
  }

  // ---------- @-mention autocomplete ----------
  let mentionItems = [];
  let mentionIndex = -1;
  let mentionStart = -1;
  function currentMention() {
    const pos = prompt.selectionStart;
    const m = prompt.value.slice(0, pos).match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) {
      return null;
    }
    return { start: pos - m[1].length - 1, query: m[1] };
  }
  function hideMentions() {
    mentionsEl.style.display = 'none';
    mentionsEl.replaceChildren();
    mentionItems = [];
    mentionIndex = -1;
    mentionStart = -1;
  }
  function renderMentions() {
    mentionsEl.replaceChildren(
      ...mentionItems.map((item, i) => {
        const row = document.createElement('div');
        row.className = 'mention-item' + (i === mentionIndex ? ' active' : '');
        row.textContent = item;
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectMention(item);
        });
        return row;
      })
    );
    mentionsEl.style.display = mentionItems.length ? 'block' : 'none';
  }
  function selectMention(item) {
    if (mentionStart < 0) {
      return;
    }
    const pos = prompt.selectionStart;
    const before = prompt.value.slice(0, mentionStart);
    const after = prompt.value.slice(pos);
    const insert = '@' + item + ' ';
    prompt.value = before + insert + after;
    const caret = before.length + insert.length;
    prompt.setSelectionRange(caret, caret);
    hideMentions();
    prompt.focus();
  }

  // ---------- /slash command menu ----------
  const SLASH_COMMANDS = [
    { cmd: '/clear', desc: 'Start a new conversation' },
    { cmd: '/compact', desc: 'Summarize to free up context' },
    { cmd: '/cost', desc: "Show this conversation's token/cost usage" },
    { cmd: '/model', desc: 'Switch the model' },
    { cmd: '/init', desc: 'Create a project rules file (AGENTS.md)' },
    { cmd: '/json', desc: 'Make the next reply a JSON object' },
    { cmd: '/help', desc: 'List slash commands' }
  ];
  let slashItems = [];
  let slashIndex = -1;
  let customCommands = []; // user-defined /commands from the workspace
  function slashOpen() {
    return slashMenuEl.style.display !== 'none' && slashItems.length > 0;
  }
  function hideSlash() {
    slashMenuEl.style.display = 'none';
    slashMenuEl.replaceChildren();
    slashItems = [];
    slashIndex = -1;
  }
  function renderSlash() {
    slashMenuEl.replaceChildren(
      ...slashItems.map((item, i) => {
        const row = document.createElement('div');
        row.className = 'mention-item slash-item' + (i === slashIndex ? ' active' : '');
        const name = document.createElement('span');
        name.className = 'slash-cmd';
        name.textContent = item.cmd;
        const desc = document.createElement('span');
        desc.className = 'slash-desc';
        desc.textContent = item.desc;
        row.append(name, desc);
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectSlash(item);
        });
        return row;
      })
    );
    slashMenuEl.style.display = slashItems.length ? 'block' : 'none';
  }
  function updateSlash() {
    const m = prompt.value.match(/^\/([\w-]*)$/);
    if (!m) {
      hideSlash();
      return;
    }
    const q = m[1].toLowerCase();
    const all = SLASH_COMMANDS.concat(customCommands.map((n) => ({ cmd: '/' + n, desc: 'custom command' })));
    slashItems = all.filter((c) => c.cmd.slice(1).toLowerCase().startsWith(q));
    slashIndex = 0;
    renderSlash();
  }
  function selectSlash(item) {
    hideSlash();
    prompt.value = item.cmd;
    sendPrompt(); // slash commands are parameterless — run immediately
  }

  // ---------- Composer ----------
  function sendPrompt() {
    const value = prompt.value.trim();
    if (!value) {
      return;
    }
    const msg = { type: 'send', prompt: value };
    if (editingOrdinal !== null && !busy) {
      msg.editOrdinal = editingOrdinal;
    }
    vscode.postMessage(msg);
    setEditing(null);
    prompt.value = '';
    hideMentions();
    hideSlash();
    maybeScroll(true); // sending re-pins the view to the bottom
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendPrompt();
  });
  prompt.addEventListener('input', () => {
    updateSlash();
    if (slashOpen()) {
      hideMentions();
      return;
    }
    const cm = currentMention();
    if (cm) {
      mentionStart = cm.start;
      vscode.postMessage({ type: 'mentionQuery', query: cm.query });
    } else {
      hideMentions();
    }
  });
  prompt.addEventListener('blur', () =>
    setTimeout(() => {
      hideMentions();
      hideSlash();
    }, 150)
  );
  prompt.addEventListener('keydown', (e) => {
    if (slashOpen()) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashIndex = (slashIndex + 1) % slashItems.length;
        renderSlash();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashIndex = (slashIndex - 1 + slashItems.length) % slashItems.length;
        renderSlash();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectSlash(slashItems[Math.max(0, slashIndex)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideSlash();
        return;
      }
    }
    if (mentionsEl.style.display !== 'none' && mentionItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionIndex = (mentionIndex + 1) % mentionItems.length;
        renderMentions();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionIndex = (mentionIndex - 1 + mentionItems.length) % mentionItems.length;
        renderMentions();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectMention(mentionItems[Math.max(0, mentionIndex)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideMentions();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refreshAgents' }));
  $('newChat').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  $('historyBtn').addEventListener('click', () => vscode.postMessage({ type: 'openHistory' }));
  $('export').addEventListener('click', () => vscode.postMessage({ type: 'export' }));
  $('compact').addEventListener('click', () => vscode.postMessage({ type: 'compact' }));
  attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'attachFiles' }));

  // Paste or drag-and-drop images (e.g. a screenshot) or PDFs straight into the composer.
  function isAttachable(type) {
    return !!type && (type.indexOf('image/') === 0 || type.indexOf('audio/') === 0 || type === 'application/pdf');
  }
  function sendFiles(files) {
    let found = false;
    for (const file of files || []) {
      if (file && isAttachable(file.type)) {
        found = true;
        const reader = new FileReader();
        reader.onload = () => vscode.postMessage({ type: 'pasteFile', dataUri: reader.result, name: file.name || '' });
        reader.readAsDataURL(file);
      }
    }
    return found;
  }
  prompt.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) {
          files.push(f);
        }
      }
    }
    if (sendFiles(files)) {
      e.preventDefault(); // keep the raw blob out of the text box
    }
  });
  const inputbox = document.querySelector('.inputbox');
  if (inputbox) {
    ['dragenter', 'dragover'].forEach((ev) =>
      inputbox.addEventListener(ev, (e) => {
        if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types || [], (t) => t === 'Files')) {
          e.preventDefault();
          inputbox.classList.add('dragover');
        }
      })
    );
    ['dragleave', 'drop'].forEach((ev) => inputbox.addEventListener(ev, () => inputbox.classList.remove('dragover')));
    inputbox.addEventListener('drop', (e) => {
      const files = (e.dataTransfer && e.dataTransfer.files) || [];
      if (files.length && sendFiles(files)) {
        e.preventDefault();
      }
    });
  }
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  agent.addEventListener('change', () => vscode.postMessage({ type: 'agentChanged', agentId: agent.value }));

  // Mode & effort popover
  function toggleModePanel(show) {
    modePanel.style.display =
      show === undefined ? (modePanel.style.display === 'none' ? 'block' : 'none') : show ? 'block' : 'none';
  }
  modeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModePanel();
  });
  modePanel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => toggleModePanel(false));
  modePanel.querySelectorAll('.mp-item').forEach((item) => {
    item.addEventListener('click', () => {
      vscode.postMessage({ type: 'modeChanged', mode: item.dataset.mode });
      toggleModePanel(false);
    });
  });
  modePanel.querySelectorAll('.mp-thinking button').forEach((b) => {
    b.addEventListener('click', () => vscode.postMessage({ type: 'thinkingChanged', thinking: b.dataset.thinking }));
  });
  modePanel.querySelectorAll('.mp-speed button').forEach((b) => {
    b.addEventListener('click', () => vscode.postMessage({ type: 'speedChanged', speed: b.dataset.speed }));
  });
  Object.values(boxes).forEach((box) =>
    box.addEventListener('change', () => {
      vscode.postMessage({
        type: 'contextOptionsChanged',
        contextOptions: Object.fromEntries(Object.entries(boxes).map(([k, i]) => [k, i.checked]))
      });
    })
  );

  // Open links from rendered Markdown externally.
  history.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a.lnk');
    if (a && a.dataset.href) {
      e.preventDefault();
      vscode.postMessage({ type: 'openLink', url: a.dataset.href });
    }
  });

  function renderAttachments(items) {
    attachmentsEl.replaceChildren();
    (items || []).forEach((att) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const icon = att.kind === 'image' ? '🖼 ' : att.kind === 'audio' ? '🎵 ' : '📄 ';
      chip.textContent = icon + att.label;
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
    if (msg.type === 'mentionResults') {
      if (mentionStart < 0) {
        return;
      }
      mentionItems = msg.items || [];
      mentionIndex = 0;
      renderMentions();
      return;
    }
    if (msg.type === 'tokens') {
      if ((msg.total || 0) === 0) {
        turnStart = Date.now(); // new turn
        startTicker();
      }
      exactTokens = msg.total || 0;
      liveChars = 0;
      if (msg.sessionCostUsd !== undefined) {
        sessionCostUsd = msg.sessionCostUsd;
      }
      if (msg.session !== undefined) {
        renderSessionTokens(msg.session);
      }
      renderStatus();
      return;
    }
    if (msg.type === 'streamStart') {
      ensureStreamBubble();
      liveChars = 0;
      setStatus('Parley is working…');
      return;
    }
    if (msg.type === 'retry' || msg.type === 'status') {
      // Transient notices from the extension (retry countdowns, waiting-for-review).
      setStatus(msg.text || '');
      return;
    }
    if (msg.type === 'queued') {
      renderQueued(msg.items || []);
      return;
    }
    if (msg.type === 'steerInjected') {
      // A queued steering message just joined the conversation: close the current
      // assistant bubble so the reply to it starts fresh underneath.
      if (streamContent) {
        streamContent.classList.remove('cursor');
      }
      finishThinkingBlock();
      streamNode = null;
      streamContent = null;
      currentSeg = null;
      planEl = null;
      const c = bubble('user', renderMd(msg.text || ''));
      addCopyButton(c.parentNode, msg.text || '');
      return;
    }
    if (msg.type === 'thinkingDelta') {
      ensureThinkingBlock();
      thinkingBody.textContent += msg.delta;
      if (!liveChars) {
        setStatus('Parley is thinking…');
      }
      maybeScroll();
      return;
    }
    if (msg.type === 'streamDelta') {
      ensureStreamBubble();
      currentSeg.textContent += msg.delta;
      liveChars += msg.delta.length;
      if (!statusBase) {
        statusBase = 'Parley is working…';
      }
      renderStatus();
      maybeScroll();
      return;
    }
    if (msg.type === 'toolEvent') {
      streamActionLine('⏺ ' + activityLabel(msg.name, msg.args));
      setStatus(activityLabel(msg.name, msg.args) + '…');
      return;
    }
    if (msg.type === 'toolResult') {
      streamResultLine(msg.text);
      return;
    }
    if (msg.type === 'fileEdit') {
      renderFileEdit(msg);
      return;
    }
    if (msg.type === 'proposedChange') {
      renderProposedChange(msg);
      return;
    }
    if (msg.type === 'changeResolved') {
      resolveProposedChange(msg.id, msg.status);
      return;
    }
    if (msg.type === 'plan') {
      renderPlan(msg.steps || []);
      return;
    }
    if (msg.type === 'streamEnd') {
      if (streamContent) {
        streamContent.classList.remove('cursor');
      }
      finishThinkingBlock();
      streamNode = null;
      streamContent = null;
      currentSeg = null;
      planEl = null;
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
    const mode = msg.mode || 'chat';
    modeBtn.textContent = (MODE_LABELS[mode] || 'Chat') + ' ▾';
    modeBtn.classList.toggle('caution', mode === 'full');
    sessionCostUsd = msg.sessionCostUsd || 0;
    contextPct = msg.contextPct != null ? msg.contextPct : null;
    renderSessionTokens(msg.sessionTokens || 0);
    renderContextMeter();
    modePanel.querySelectorAll('.mp-item').forEach((it) => it.classList.toggle('active', it.dataset.mode === mode));
    const think = msg.selectedThinking || 'off';
    modePanel
      .querySelectorAll('.mp-thinking button')
      .forEach((b) => b.classList.toggle('active', b.dataset.thinking === think));
    const speed = msg.selectedSpeed || 'standard';
    modePanel
      .querySelectorAll('.mp-speed button')
      .forEach((b) => b.classList.toggle('active', b.dataset.speed === speed));
    customCommands = msg.customCommands || [];
    renderAttachments(msg.attachments);

    stopBtn.style.display = msg.busy ? '' : 'none';
    // Send stays enabled while busy — messages typed now are queued as steering.
    // Model/mode switches would only apply from the NEXT turn, so lock them during a run.
    busy = !!msg.busy;
    agent.disabled = busy;
    modeBtn.disabled = busy;
    modeBtn.title = busy ? 'Locked while the agent is running (applies from the next turn)' : 'Mode & thinking';
    prompt.placeholder = busy
      ? 'Type to steer the agent — sent at its next step…'
      : 'Ask Parley…  (@file to attach · paste or drop an image/PDF/audio · Enter to send · Shift+Enter for newline)';
    if (!msg.busy) {
      stopTicker();
      turnStart = 0;
      exactTokens = 0;
      liveChars = 0;
      setStatus('');
    } else {
      startTicker();
      if (!statusBase) {
        setStatus('Parley is working…');
      }
    }

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

    streamNode = null;
    streamContent = null;
    currentSeg = null;
    thinkingDet = null;
    thinkingBody = null;
    planEl = null;
    const entries = msg.transcript && msg.transcript.length ? msg.transcript : null;
    if (!entries && !(msg.history && msg.history.length)) {
      history.innerHTML = '<div class="empty">Ask Parley about your code.</div>';
      return;
    }
    if (entries) {
      renderTranscript(entries, msg.pendingChangeIds || []);
    } else {
      // Fallback for older saved sessions with no transcript: render plain messages.
      history.replaceChildren();
      let userOrdinal = 0;
      msg.history.forEach((item) => {
        const content = bubble(item.role, renderMd(item.content));
        if (item.role === 'user') {
          addCopyButton(content.parentNode, item.content);
          addEditButton(content.parentNode, item.content, userOrdinal);
          userOrdinal += 1;
        }
        if (item.role === 'assistant' && item.thinking) {
          const det = document.createElement('details');
          det.className = 'thinking';
          const sum = document.createElement('summary');
          sum.textContent = '💭 Thought';
          const body = document.createElement('div');
          body.className = 'think-body';
          body.textContent = item.thinking;
          det.append(sum, body);
          content.parentNode.insertBefore(det, content);
        }
      });
    }
  });
})();
