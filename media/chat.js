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
      parts.push(Number(n).toLocaleString() + ' tokens');
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
    ctxEl.title =
      (known
        ? 'Context window used: ' + pct + '% (auto-compacts when it fills up)'
        : 'Context usage (window size unknown for this model)') + ' — click to compact now';
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
      case 'find_definition':
        return 'Finding definition of ' + (a.symbol || '');
      case 'find_references':
        return 'Finding references to ' + (a.symbol || '');
      case 'write_file':
        return 'Editing ' + (a.path || '');
      case 'multi_edit':
        return 'Editing ' + (a.path || '') + ' (' + (Array.isArray(a.edits) ? a.edits.length : 0) + ' edits)';
      case 'run_command':
        return 'Running: ' + (a.command || '');
      case 'fetch_url':
        return 'Fetching ' + (a.url || '');
      case 'browser_navigate':
        return 'Browsing ' + (a.url || '');
      case 'browser_read':
        return 'Reading page';
      case 'browser_console':
        return 'Reading console';
      case 'browser_click':
        return 'Clicking ' + (a.selector || '');
      case 'browser_type':
        return 'Typing into ' + (a.selector || '');
      case 'browser_screenshot':
        return 'Screenshotting page';
      case 'run_subagent':
        return 'Subagent: ' + (a.task || '').slice(0, 70);
      case 'subagent_step':
        return '↳ ' + (a.action || '');
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
  // Memoized: full re-renders (postState) re-feed every prior message through
  // markdown-it, which is O(n) jank in long sessions — cache by source string.
  const mdCache = new Map();
  function renderMd(src) {
    const k = String(src || '');
    let html = mdCache.get(k);
    if (html === undefined) {
      if (mdCache.size > 2000) {
        mdCache.clear(); // crude cap so the cache can't grow unbounded
      }
      html = md.render(k);
      mdCache.set(k, html);
    }
    return html;
  }
  // Fence languages where "apply to editor" makes no sense (prose, terminal output, diffs).
  const SKIP_APPLY_LANGS = new Set(['diff', 'text', 'plaintext', 'txt', 'console', 'output', 'markdown', 'md']);
  function enhanceContent(contentEl) {
    // Copy (and Apply) buttons on each fenced block. The buttons live outside the
    // scrollable <pre> so they stay pinned while long code lines are scrolled horizontally.
    contentEl.querySelectorAll('pre').forEach((pre) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'codeblock';
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);

      const codeEl = pre.querySelector('code');
      const codeText = codeEl ? codeEl.textContent : pre.textContent;
      const lang = ((/language-([\w#+-]+)/.exec(codeEl ? codeEl.className : '') || [])[1] || '').toLowerCase();
      if (codeText.trim() && !SKIP_APPLY_LANGS.has(lang)) {
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'applycode';
        apply.title = 'Apply to editor (replaces the selection, or inserts at the cursor)';
        apply.setAttribute('aria-label', 'Apply code to editor');
        apply.textContent = 'Apply';
        apply.addEventListener('click', () => {
          vscode.postMessage({ type: 'applyCodeBlock', text: codeText, lang });
        });
        wrapper.appendChild(apply);
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy';
      btn.title = 'Copy code';
      btn.setAttribute('aria-label', 'Copy code');
      btn.innerHTML = COPY_SVG;
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'copyText', text: codeText });
        btn.classList.add('copied');
        btn.innerHTML = '✓';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = COPY_SVG;
        }, 1200);
      });
      wrapper.appendChild(btn);
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
  }
  function addRewindButton(messageNode, tindex) {
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
      openRewindMenu(tindex);
    });
    messageNode.appendChild(rw);
  }

  // Copy (two overlapping squares) icon used on user prompts.
  const COPY_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">' +
    '<rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5"/>' +
    '<path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1"/></svg>';
  // ---------- Voice output (built-in speechSynthesis TTS) ----------
  let speakingBtn = null; // the 🔊 button currently playing (toggles stop)
  let voicePrefs = { autoRead: false, chime: false }; // from the host state message
  function speechText(md) {
    return (md || '')
      .replace(/```[\s\S]*?```/g, ' (code omitted) ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' image ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[*_>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function stopSpeaking() {
    try {
      window.speechSynthesis.cancel();
    } catch (e) {
      /* unsupported */
    }
    if (speakingBtn) {
      speakingBtn.classList.remove('speaking');
      speakingBtn = null;
    }
  }
  function speak(md, btn) {
    stopSpeaking();
    if (!window.speechSynthesis) {
      return;
    }
    const text = speechText(md).slice(0, 4000);
    if (!text) {
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.onend = () => stopSpeaking();
    u.onerror = () => stopSpeaking();
    window.speechSynthesis.speak(u);
    if (btn) {
      speakingBtn = btn;
      btn.classList.add('speaking');
    }
  }
  function addSpeakButton(messageNode, text) {
    if (!window.speechSynthesis) {
      return null;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msgspeak';
    btn.title = 'Read aloud (click again to stop)';
    btn.setAttribute('aria-label', 'Read aloud');
    btn.textContent = '🔊';
    btn.addEventListener('click', () => {
      if (speakingBtn === btn) {
        stopSpeaking();
      } else {
        speak(text, btn);
      }
    });
    messageNode.appendChild(btn);
    return btn;
  }
  // Soft two-tone chime for turns that finish while the window is unfocused.
  function playChime() {
    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.gain.value = 0.06;
      gain.connect(ctx.destination);
      [660, 880].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(ctx.currentTime + i * 0.16);
        osc.stop(ctx.currentTime + i * 0.16 + 0.14);
      });
      setTimeout(() => ctx.close(), 800);
    } catch (e) {
      /* audio unavailable */
    }
  }

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
  // End-of-turn "N files changed +X −Y" summary card with a Review action.
  function renderChangesCard(entry) {
    const files = entry.files || [];
    const card = document.createElement('div');
    card.className = 'changescard';

    const head = document.createElement('div');
    head.className = 'changeshead';
    const label = document.createElement('span');
    label.className = 'changeslabel';
    label.textContent = files.length + ' file' + (files.length === 1 ? '' : 's') + ' changed';
    const counts = document.createElement('span');
    counts.className = 'changescounts';
    const add = document.createElement('span');
    add.className = 'diffadd';
    add.textContent = '+' + (entry.added || 0);
    const del = document.createElement('span');
    del.className = 'diffdel';
    del.textContent = '−' + (entry.removed || 0);
    counts.append(add, document.createTextNode(' '), del);
    const grow = document.createElement('span');
    grow.className = 'grow';
    const review = document.createElement('button');
    review.type = 'button';
    review.className = 'reviewbtn';
    review.textContent = 'Review';
    review.title = 'Open each changed file as a before/after diff';
    review.addEventListener('click', () =>
      vscode.postMessage({ type: 'reviewChanges', paths: files.map((f) => f.path) })
    );
    head.append(label, counts, grow, review);

    const list = document.createElement('div');
    list.className = 'changeslist';
    files.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'changesrow';
      const p = document.createElement('span');
      p.className = 'changespath';
      p.textContent = f.path;
      const c = document.createElement('span');
      c.className = 'changesrowcounts';
      c.innerHTML = '';
      const a = document.createElement('span');
      a.className = 'diffadd';
      a.textContent = '+' + f.added;
      const d = document.createElement('span');
      d.className = 'diffdel';
      d.textContent = '−' + f.removed;
      c.append(a, document.createTextNode(' '), d);
      row.append(p, c);
      list.append(row);
    });

    card.append(head, list);
    history.append(card);
  }
  // ⚖ /compare — two model replies side by side, each adoptable into the conversation.
  function renderCompareCard(e) {
    const card = document.createElement('div');
    card.className = 'comparecard';
    const head = document.createElement('div');
    head.className = 'comparehead';
    head.textContent = '⚖ Compare — ' + (e.prompt || '').slice(0, 120);
    const cols = document.createElement('div');
    cols.className = 'comparecols';
    const buttons = [];
    [
      ['a', e.a],
      ['b', e.b]
    ].forEach(([key, col]) => {
      if (!col) {
        return;
      }
      const colEl = document.createElement('div');
      colEl.className = 'comparecol' + (e.chosen === key ? ' chosen' : '');
      const model = document.createElement('div');
      model.className = 'comparemodel';
      model.textContent = col.model + (e.chosen === key ? ' ✓ adopted' : '');
      const body = document.createElement('div');
      body.className = 'comparebody content' + (col.error ? ' error' : '');
      if (col.error) {
        body.textContent = '⚠ ' + col.text;
      } else {
        body.innerHTML = renderMd(col.text || '');
        enhanceContent(body);
      }
      colEl.append(model, body);
      if (!e.chosen && !col.error) {
        const use = document.createElement('button');
        use.type = 'button';
        use.className = 'applybtn';
        use.textContent = 'Use this reply';
        use.title = 'Adopt this reply into the conversation';
        use.addEventListener('click', () => {
          buttons.forEach((b) => (b.disabled = true));
          vscode.postMessage({ type: 'comparePick', id: e.id, which: key });
        });
        buttons.push(use);
        colEl.append(use);
      }
      cols.append(colEl);
    });
    card.append(head, cols);
    history.append(card);
  }
  function renderTranscript(entries, pendingIds) {
    history.replaceChildren();
    pendingIds = pendingIds || [];
    let userOrdinal = 0;
    let tindex = -1;
    for (const e of entries) {
      tindex += 1;
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
        addRewindButton(c.parentNode, tindex);
        userOrdinal += 1;
      } else if (e.kind === 'assistant') {
        const c = bubble('assistant', renderMd(e.text));
        addRewindButton(c.parentNode, tindex);
        addSpeakButton(c.parentNode, e.text);
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
      } else if (e.kind === 'changes') {
        renderChangesCard(e);
      } else if (e.kind === 'compare') {
        renderCompareCard(e);
      } else if (e.kind === 'note') {
        const c = bubble('assistant', renderMd(e.text));
        c.parentNode.classList.add('note');
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
      }
    }
    maybeScroll();
  }

  // ---------- @-mention autocomplete ----------
  let mentionItems = []; // strings (file paths) or {path, hint} objects (special mentions)
  let mentionIndex = -1;
  let mentionStart = -1;
  let mentionSeq = 0; // echoed by the extension so stale results can be dropped
  function mentionPath(item) {
    return typeof item === 'string' ? item : item.path;
  }
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
        const hint = typeof item === 'string' ? '' : item.hint || '';
        if (hint) {
          row.classList.add('slash-item');
          const name = document.createElement('span');
          name.className = 'slash-cmd';
          name.textContent = '@' + mentionPath(item);
          const desc = document.createElement('span');
          desc.className = 'slash-desc';
          desc.textContent = hint;
          row.append(name, desc);
        } else {
          row.textContent = mentionPath(item);
        }
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
    const p = mentionPath(item);
    // A prefix like "sym:" isn't a finished mention — keep the caret right after it
    // (no trailing space) so the user types the symbol name and the dropdown continues.
    const isPrefix = p.endsWith(':');
    const insert = '@' + p + (isPrefix ? '' : ' ');
    prompt.value = before + insert + after;
    const caret = before.length + insert.length;
    prompt.setSelectionRange(caret, caret);
    if (isPrefix) {
      prompt.focus();
      // Re-open the dropdown for the prefix so the next keystroke queries immediately.
      const cm = currentMention();
      if (cm) {
        mentionStart = cm.start;
        vscode.postMessage({ type: 'mentionQuery', query: cm.query, seq: ++mentionSeq });
      }
      return;
    }
    hideMentions();
    prompt.focus();
  }

  // ---------- /slash command menu ----------
  const SLASH_COMMANDS = [
    { cmd: '/clear', desc: 'Start a new conversation' },
    { cmd: '/compact', desc: 'Summarize to free up context' },
    { cmd: '/cost', desc: "Show this conversation's token/cost usage" },
    { cmd: '/model', desc: 'Switch the model' },
    { cmd: '/compare', desc: 'Run your last prompt on a second model, side by side' },
    { cmd: '/verify', desc: 'Run the project tests and fix failures until green' },
    { cmd: '/computer', desc: 'Control your mouse & keyboard to do a desktop task (Windows)' },
    { cmd: '/init', desc: 'Analyze the repo and write AGENTS.md project rules' },
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
    // Custom entries arrive as {name, description} (older hosts sent plain strings).
    const all = SLASH_COMMANDS.concat(
      customCommands.map((c) =>
        typeof c === 'string'
          ? { cmd: '/' + c, desc: 'custom command' }
          : { cmd: '/' + c.name, desc: c.description || 'custom command' }
      )
    );
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
  // Terminal-style prompt recall: ArrowUp/Down in the (empty) composer cycles
  // previously sent prompts. Fed from the host's persisted list via the state
  // message, plus an optimistic local append on send.
  let sentPrompts = []; // newest last
  let recallIndex = -1; // -1 = not navigating; 0 = newest
  let recallDraft = ''; // in-progress text stashed when recall starts
  function sendPrompt() {
    const value = prompt.value.trim();
    if (!value) {
      return;
    }
    if (sentPrompts[sentPrompts.length - 1] !== value) {
      sentPrompts.push(value);
    }
    recallIndex = -1;
    recallDraft = '';
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
    recallIndex = -1; // typing exits history recall (keeps the text)
    updateSlash();
    if (slashOpen()) {
      hideMentions();
      return;
    }
    const cm = currentMention();
    // Once a '#line-range' is being typed the mention is already chosen — keep the
    // dropdown closed so Enter sends instead of re-selecting (and nuking the range).
    if (cm && cm.query.indexOf('#') === -1) {
      mentionStart = cm.start;
      vscode.postMessage({ type: 'mentionQuery', query: cm.query, seq: ++mentionSeq });
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
    // Prompt-history recall (menus are closed past this point — their branches returned).
    if (e.key === 'ArrowUp' && sentPrompts.length) {
      const onFirstLine = prompt.value.slice(0, prompt.selectionStart).indexOf('\n') === -1;
      if (onFirstLine && (recallIndex >= 0 || prompt.value === '')) {
        e.preventDefault();
        if (recallIndex === -1) {
          recallDraft = prompt.value;
        }
        recallIndex = Math.min(recallIndex + 1, sentPrompts.length - 1);
        prompt.value = sentPrompts[sentPrompts.length - 1 - recallIndex];
        prompt.setSelectionRange(prompt.value.length, prompt.value.length);
        return;
      }
    }
    if (e.key === 'ArrowDown' && recallIndex >= 0) {
      const onLastLine = prompt.value.indexOf('\n', prompt.selectionEnd) === -1;
      if (onLastLine) {
        e.preventDefault();
        recallIndex -= 1;
        prompt.value = recallIndex === -1 ? recallDraft : sentPrompts[sentPrompts.length - 1 - recallIndex];
        prompt.setSelectionRange(prompt.value.length, prompt.value.length);
        return;
      }
    }
    if (e.key === 'Escape' && recallIndex >= 0) {
      e.preventDefault();
      prompt.value = recallDraft;
      recallIndex = -1;
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  // ---------- Generic in-panel menu popover ----------
  // All icon-triggered choices (compact, export, rewind, usage) render here — a
  // concise dropdown anchored to the chat area, styled like the history panel,
  // instead of VS Code's screen-centered QuickPick.
  const menuPanel = $('menuPanel');
  let menuKind = ''; // which menu is showing ('compact' | 'export' | 'usage' | 'rewind')
  let menuRows = [];
  let menuItems = [];
  let menuActive = -1;

  function menuIsOpen() {
    return menuPanel && menuPanel.style.display !== 'none';
  }
  function closeMenu() {
    if (menuPanel) {
      menuPanel.style.display = 'none';
      menuPanel.replaceChildren();
      menuKind = '';
      menuRows = [];
      menuItems = [];
      menuActive = -1;
    }
  }
  function setMenuActive(i) {
    menuActive = i;
    menuRows.forEach((r, j) => r.classList.toggle('active', j === menuActive));
  }
  function pickMenuItem(i) {
    const it = menuItems[i];
    if (!it) {
      return;
    }
    closeMenu();
    it.onPick();
  }
  /**
   * opts: { kind, title, note?, lines?: string[], items?: [{label, detail?, onPick}],
   *         input?: {placeholder?, value?, onSubmit(value)} }
   */
  function openMenu(opts) {
    if (!menuPanel) {
      return;
    }
    closeHistory();
    menuPanel.replaceChildren();
    menuKind = opts.kind || '';
    menuItems = (opts.items || []).slice();
    menuRows = [];
    menuActive = menuItems.length ? 0 : -1;

    const head = document.createElement('div');
    head.className = 'hp-head';
    const title = document.createElement('div');
    title.className = 'mn-title';
    title.textContent = opts.title || '';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'hp-close';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';
    close.addEventListener('click', () => closeMenu());
    head.append(title, close);
    menuPanel.append(head);

    if (opts.note) {
      const note = document.createElement('div');
      note.className = 'mn-note';
      note.textContent = opts.note;
      menuPanel.append(note);
    }
    if (opts.lines && opts.lines.length) {
      const info = document.createElement('div');
      info.className = 'mn-info';
      opts.lines.forEach((line) => {
        const row = document.createElement('div');
        row.textContent = line;
        info.append(row);
      });
      menuPanel.append(info);
    }
    let inputEl = null;
    if (opts.input) {
      inputEl = document.createElement('input');
      inputEl.type = 'text';
      inputEl.className = 'hp-filter';
      inputEl.placeholder = opts.input.placeholder || '';
      inputEl.value = opts.input.value || '';
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          opts.input.onSubmit(inputEl.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeMenu();
        }
      });
      menuPanel.append(inputEl);
    }
    if (menuItems.length) {
      const list = document.createElement('div');
      list.className = 'hp-list';
      menuItems.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'hp-item mn-item' + (i === menuActive ? ' active' : '');
        row.setAttribute('role', 'menuitem');
        const label = document.createElement('div');
        label.className = 'hp-item-title';
        label.textContent = it.label;
        row.append(label);
        if (it.detail) {
          const det = document.createElement('div');
          det.className = 'hp-item-meta';
          det.textContent = it.detail;
          row.append(det);
        }
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pickMenuItem(i);
        });
        row.addEventListener('mousemove', () => setMenuActive(i));
        list.append(row);
        menuRows.push(row);
      });
      menuPanel.append(list);
    }
    menuPanel.style.display = 'flex';
    setTimeout(() => (inputEl ? inputEl.focus() : menuPanel.focus()), 0);
  }
  if (menuPanel) {
    menuPanel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuActive(Math.min(menuActive + 1, menuItems.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuActive(Math.max(menuActive - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pickMenuItem(Math.max(0, menuActive));
      }
    });
    // Click outside closes it. The toolbar buttons toggle via their own handlers,
    // which run on 'click' (after this mousedown already closed the menu) — so an
    // outside mousedown on the same button would reopen it; the toggles below
    // check `menuKind` at mousedown time via `lastClosedKind` to avoid that.
    document.addEventListener('mousedown', (e) => {
      if (menuIsOpen() && !menuPanel.contains(e.target)) {
        lastClosedKind = menuKind;
        closeMenu();
      } else if (!menuIsOpen()) {
        lastClosedKind = '';
      }
    });
  }
  let lastClosedKind = ''; // menu kind closed by the most recent outside mousedown
  function toggleMenu(kind, open) {
    if (lastClosedKind === kind) {
      lastClosedKind = ''; // the mousedown just closed this same menu: treat click as a toggle-off
      return;
    }
    if (menuIsOpen() && menuKind === kind) {
      closeMenu();
    } else {
      open();
    }
  }

  function openCompactMenu() {
    openMenu({
      kind: 'compact',
      title: 'Compact conversation',
      note: 'Compaction is lossy — it replaces history with a summary.',
      items: [
        {
          label: 'Summarize older, keep recent',
          detail: 'Summarize all but the last few messages (kept verbatim)',
          onPick: () => vscode.postMessage({ type: 'compact', keepRecent: 4 })
        },
        {
          label: 'Summarize everything',
          detail: 'Replace the whole conversation with one summary',
          onPick: () => vscode.postMessage({ type: 'compact', keepRecent: 0 })
        }
      ]
    });
  }
  function openExportMenu() {
    const fmts = [
      { label: 'Markdown (.md)', fmt: 'md' },
      { label: 'Plain text (.txt)', fmt: 'txt' },
      { label: 'JSON (.json)', fmt: 'json' }
    ];
    openMenu({
      kind: 'export',
      title: 'Export conversation',
      note: 'Choose a format — you pick where to save it next.',
      items: fmts.map((f) => ({
        label: f.label,
        onPick: () => vscode.postMessage({ type: 'export', fmt: f.fmt })
      }))
    });
  }
  function openUsageMenu() {
    openMenu({ kind: 'usage', title: 'Usage — this month', note: 'Fetching billed usage…' });
    vscode.postMessage({ type: 'openUsage' });
  }
  function openUsageAccountInput(currentId) {
    openMenu({
      kind: 'usage',
      title: 'Usage — account id',
      note: 'Enter your Parley account id (Admin Portal → “My Account”), then press Enter.',
      input: {
        placeholder: 'acc_…',
        value: currentId || '',
        onSubmit: (value) => {
          const v = (value || '').trim();
          if (!v) {
            return;
          }
          openMenu({ kind: 'usage', title: 'Usage — this month', note: 'Fetching billed usage…' });
          vscode.postMessage({ type: 'setUsageAccount', accountId: v });
        }
      }
    });
  }
  function openRewindMenu(tindex) {
    openMenu({
      kind: 'rewind',
      title: 'Rewind to this message',
      note: "Edits are restored from this conversation's checkpoints.",
      items: [
        {
          label: '💬 Rewind conversation (fork)',
          detail: 'Continue from before this message — files keep their changes',
          onPick: () => vscode.postMessage({ type: 'rewind', tindex, what: 'convo' })
        },
        {
          label: '📄 Rewind files',
          detail: 'Restore files edited from this point on — the conversation is unchanged',
          onPick: () => vscode.postMessage({ type: 'rewind', tindex, what: 'files' })
        },
        {
          label: '⏪ Rewind both',
          detail: 'Fork the conversation AND restore the files',
          onPick: () => vscode.postMessage({ type: 'rewind', tindex, what: 'both' })
        }
      ]
    });
  }

  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refreshAgents' }));
  $('newChat').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  $('historyBtn').addEventListener('click', () => toggleHistory());
  $('export').addEventListener('click', () => toggleMenu('export', openExportMenu));
  $('usage').addEventListener('click', () => toggleMenu('usage', openUsageMenu));
  $('compact').addEventListener('click', () => toggleMenu('compact', openCompactMenu));
  attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'attachFiles' }));

  // ---------- Voice input (🎤 → PCM capture → WAV → host transcription) ----------
  // MediaRecorder emits webm/opus, which the gateway's input_audio doesn't accept —
  // so capture raw PCM via WebAudio, downsample to 16 kHz mono, and encode WAV here.
  const micBtn = $('mic');
  const voiceModeBtn = $('voiceMode');
  let micState = 'idle'; // idle | recording | busy
  let voiceMode = false; // hands-free: transcription auto-sends, replies auto-read
  let pendingVoiceSend = false; // the next insertText comes from voice-mode transcription
  let liveText = ''; // raw markdown of the streaming reply (for read-aloud at streamEnd)
  let micStream = null;
  let micCtx = null;
  let micNode = null;
  let micChunks = [];
  let micRate = 48000;
  let micTimer = null;
  const MIC_MAX_MS = 60000;

  function setMicState(state) {
    micState = state;
    if (!micBtn) {
      return;
    }
    micBtn.classList.toggle('recording', state === 'recording');
    micBtn.disabled = state === 'busy';
    micBtn.textContent = state === 'recording' ? '⏺' : state === 'busy' ? '…' : '🎤';
    micBtn.title =
      state === 'recording'
        ? 'Recording — click to stop and transcribe (max 60s)'
        : state === 'busy'
          ? 'Transcribing…'
          : 'Voice input (click to record, click again to transcribe)';
  }
  function encodeWavBase64(chunks, inRate) {
    let total = 0;
    for (const c of chunks) {
      total += c.length;
    }
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    // Linear-interpolation resample to 16 kHz mono.
    const outRate = 16000;
    const outLen = Math.max(1, Math.floor((merged.length * outRate) / inRate));
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = (i * inRate) / outRate;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, merged.length - 1);
      const s = merged[i0] + (merged[i1] - merged[i0]) * (pos - i0);
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    }
    const bytes = new Uint8Array(44 + pcm.length * 2);
    const dv = new DataView(bytes.buffer);
    const writeStr = (o, s) => {
      for (let i = 0; i < s.length; i++) {
        bytes[o + i] = s.charCodeAt(i);
      }
    };
    writeStr(0, 'RIFF');
    dv.setUint32(4, 36 + pcm.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, 1, true); // mono
    dv.setUint32(24, outRate, true);
    dv.setUint32(28, outRate * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    writeStr(36, 'data');
    dv.setUint32(40, pcm.length * 2, true);
    bytes.set(new Uint8Array(pcm.buffer), 44);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  function stopMicCapture() {
    if (micTimer) {
      clearTimeout(micTimer);
      micTimer = null;
    }
    if (micNode) {
      try {
        micNode.disconnect();
      } catch (e) {
        /* already gone */
      }
      micNode = null;
    }
    if (micCtx) {
      try {
        micCtx.close();
      } catch (e) {
        /* already gone */
      }
      micCtx = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
  }
  async function startRecording() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      vscode.postMessage({ type: 'voiceUnavailable' });
      return;
    }
    micChunks = [];
    micCtx = new AudioContext();
    micRate = micCtx.sampleRate;
    const source = micCtx.createMediaStreamSource(micStream);
    micNode = micCtx.createScriptProcessor(4096, 1, 1);
    micNode.onaudioprocess = (e) => {
      if (micState === 'recording') {
        micChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      }
    };
    source.connect(micNode);
    micNode.connect(micCtx.destination);
    setMicState('recording');
    micTimer = setTimeout(() => finishRecording(), MIC_MAX_MS);
  }
  function finishRecording() {
    stopMicCapture();
    if (micChunks.length === 0) {
      setMicState('idle');
      return;
    }
    setMicState('busy');
    const base64 = encodeWavBase64(micChunks, micRate);
    micChunks = [];
    pendingVoiceSend = voiceMode; // hands-free: send as soon as the transcription lands
    vscode.postMessage({ type: 'voiceAudio', base64 });
  }
  if (micBtn) {
    micBtn.addEventListener('click', () => {
      if (micState === 'idle') {
        void startRecording();
      } else if (micState === 'recording') {
        finishRecording();
      }
    });
  }
  // ---------- Screen capture (📷 one frame, 🎥 frames + mic narration) ----------
  // getDisplayMedia lets the user pick any window/screen; a single frame becomes an
  // image attachment, a recording becomes sampled frames (vision) + a WAV narration
  // (both through the existing pasteFile attachment path — no new host plumbing).
  const shotBtn = $('shot');
  const recBtn = $('rec');
  const REC_MAX_MS = 60000;
  const REC_FRAME_EVERY_MS = 4000;
  const REC_MAX_FRAMES = 12;
  let recState = 'idle'; // idle | recording
  let recStream = null;
  let recVideo = null;
  let recFrames = [];
  let recFrameTimer = null;
  let recStopTimer = null;
  let recMicStream = null;
  let recMicCtx = null;
  let recMicNode = null;
  let recMicChunks = [];
  let recMicRate = 48000;

  function frameFrom(video) {
    const maxW = 1280;
    const w = video.videoWidth || maxW;
    const h = video.videoHeight || Math.round((maxW * 9) / 16);
    const scale = Math.min(1, maxW / w);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.75);
  }
  function videoElementFor(stream) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.srcObject = stream;
      v.muted = true;
      v.onloadedmetadata = () => {
        const p = v.play();
        if (p && p.then) {
          p.then(() => resolve(v)).catch(() => resolve(v));
        } else {
          resolve(v);
        }
      };
    });
  }
  async function takeScreenshot() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (e) {
      return; // picker cancelled or capture unavailable
    }
    try {
      const v = await videoElementFor(stream);
      await new Promise((r) => setTimeout(r, 300)); // let the first frame paint
      vscode.postMessage({ type: 'pasteFile', dataUri: frameFrom(v), name: 'screenshot.jpg' });
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }
  async function startScreenRecording() {
    try {
      recStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (e) {
      return; // picker cancelled
    }
    try {
      recMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      recMicStream = null; // no mic permission — record video-only
    }
    recFrames = [];
    recMicChunks = [];
    recVideo = await videoElementFor(recStream);
    const snap = () => {
      if (recState === 'recording' && recFrames.length < REC_MAX_FRAMES) {
        try {
          recFrames.push(frameFrom(recVideo));
        } catch (e) {
          /* frame not ready */
        }
      }
    };
    recState = 'recording';
    setTimeout(snap, 350);
    recFrameTimer = setInterval(snap, REC_FRAME_EVERY_MS);
    if (recMicStream) {
      recMicCtx = new AudioContext();
      recMicRate = recMicCtx.sampleRate;
      const src = recMicCtx.createMediaStreamSource(recMicStream);
      recMicNode = recMicCtx.createScriptProcessor(4096, 1, 1);
      recMicNode.onaudioprocess = (e) => {
        if (recState === 'recording') {
          recMicChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        }
      };
      src.connect(recMicNode);
      recMicNode.connect(recMicCtx.destination);
    }
    if (recBtn) {
      recBtn.classList.add('recording');
      recBtn.textContent = '⏹';
      recBtn.title = 'Stop recording and attach frames + narration';
    }
    recStopTimer = setTimeout(() => stopScreenRecording(), REC_MAX_MS);
    const track = recStream.getVideoTracks()[0];
    if (track) {
      track.onended = () => stopScreenRecording(); // user ended sharing via the OS/browser bar
    }
  }
  function stopScreenRecording() {
    if (recState !== 'recording') {
      return;
    }
    recState = 'idle';
    clearInterval(recFrameTimer);
    clearTimeout(recStopTimer);
    try {
      if (recVideo && recFrames.length < REC_MAX_FRAMES) {
        recFrames.push(frameFrom(recVideo)); // closing frame
      }
    } catch (e) {
      /* stream already gone */
    }
    if (recMicNode) {
      try {
        recMicNode.disconnect();
      } catch (e) {
        /* already gone */
      }
      recMicNode = null;
    }
    if (recMicCtx) {
      try {
        recMicCtx.close();
      } catch (e) {
        /* already gone */
      }
      recMicCtx = null;
    }
    if (recMicStream) {
      recMicStream.getTracks().forEach((t) => t.stop());
      recMicStream = null;
    }
    if (recStream) {
      recStream.getTracks().forEach((t) => t.stop());
      recStream = null;
    }
    recVideo = null;
    if (recBtn) {
      recBtn.classList.remove('recording');
      recBtn.textContent = '🎥';
      recBtn.title = 'Record your screen (frames + mic narration; click again to stop, max 60s)';
    }
    recFrames.forEach((dataUri, i) => {
      vscode.postMessage({ type: 'pasteFile', dataUri, name: 'screencap-' + (i + 1) + '.jpg' });
    });
    if (recMicChunks.length) {
      const base64 = encodeWavBase64(recMicChunks, recMicRate);
      vscode.postMessage({ type: 'pasteFile', dataUri: 'data:audio/wav;base64,' + base64, name: 'narration.wav' });
    }
    recFrames = [];
    recMicChunks = [];
  }
  if (shotBtn) {
    shotBtn.addEventListener('click', () => void takeScreenshot());
  }
  // Computer control: if the composer already has a task, run it now; otherwise
  // prefill "/computer " and focus so the user types the task and presses Enter.
  const computerBtn = $('computer');
  if (computerBtn) {
    computerBtn.addEventListener('click', () => {
      const text = prompt.value.trim();
      if (text && !text.startsWith('/')) {
        prompt.value = '/computer ' + text;
        sendPrompt();
        return;
      }
      if (!prompt.value.trim()) {
        prompt.value = '/computer ';
      }
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      hideSlash();
    });
  }
  if (recBtn) {
    recBtn.addEventListener('click', () => {
      if (recState === 'idle') {
        void startScreenRecording();
      } else {
        stopScreenRecording();
      }
    });
  }

  if (voiceModeBtn) {
    voiceModeBtn.addEventListener('click', () => {
      voiceMode = !voiceMode;
      voiceModeBtn.classList.toggle('active', voiceMode);
      voiceModeBtn.title = voiceMode
        ? 'Voice mode ON — 🎤 auto-sends, replies are read aloud. Click to turn off.'
        : 'Voice mode: hands-free conversation (🎤 auto-sends, replies read aloud)';
      if (!voiceMode) {
        stopSpeaking();
        pendingVoiceSend = false;
      }
    });
  }
  // The header session-cost readout is also a shortcut to the full usage view.
  if (sessionTokEl) {
    sessionTokEl.style.cursor = 'pointer';
    sessionTokEl.title = 'View usage';
    sessionTokEl.addEventListener('click', () => toggleMenu('usage', openUsageMenu));
  }
  // Clicking the context-window meter offers to compact the conversation.
  if (ctxEl) {
    ctxEl.style.cursor = 'pointer';
    ctxEl.addEventListener('click', () => toggleMenu('compact', openCompactMenu));
  }

  // ---------- In-panel conversation history ----------
  const historyPanel = $('historyPanel');
  const historyListEl = $('historyList');
  const historyFilter = $('historyFilter');
  const historyArchivedBtn = $('historyArchived');
  let historyScope = 'repo';
  let showArchived = false;
  let historyAllItems = []; // full list from the host for the current scope
  let historyActive = -1; // keyboard-highlighted index within the filtered view
  let historyFiltered = [];
  let renamingId = null; // conversation id being renamed inline (row shows an input)
  let confirmDeleteId = null; // conversation id whose 🗑 is armed ("Delete?" confirm)
  // Content search (3+ chars): the host greps transcript text and returns ranked
  // hits with snippets; null = plain client-side title filtering.
  let historySearchHits = null;
  let historySearchSeq = 0;
  let historySearchTimer = null;

  function historyOpen() {
    return historyPanel && historyPanel.style.display !== 'none';
  }
  function requestHistory() {
    vscode.postMessage({ type: 'historyList', scope: historyScope });
  }
  function openHistory() {
    if (!historyPanel) {
      return;
    }
    closeMenu();
    historyPanel.style.display = 'flex';
    renamingId = null;
    confirmDeleteId = null;
    historySearchHits = null;
    historyFilter.value = '';
    historyListEl.innerHTML = '<div class="hp-empty">Loading…</div>';
    requestHistory();
    setTimeout(() => historyFilter.focus(), 0);
  }
  function closeHistory() {
    if (historyPanel) {
      historyPanel.style.display = 'none';
      historyActive = -1;
    }
  }
  function toggleHistory() {
    if (historyOpen()) {
      closeHistory();
    } else {
      openHistory();
    }
  }
  function fmtWhen(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  }
  function actionButton(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hp-act';
    b.textContent = label;
    b.title = title;
    // mousedown + preventDefault so the row's own select handler doesn't also fire,
    // and focus stays put; stopPropagation keeps the click-away closer from firing.
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  }
  function renderHistory() {
    const q = (historyFilter.value || '').trim().toLowerCase();
    const source = q.length >= 3 && historySearchHits ? historySearchHits : null;
    historyFiltered = (source || historyAllItems).filter((it) => {
      if (!showArchived && it.archived) {
        return false;
      }
      if (source || !q) {
        return true; // host-ranked content hits are already query-matched
      }
      return `${it.title} ${it.model} ${it.repo}`.toLowerCase().includes(q);
    });
    if (historyActive >= historyFiltered.length) {
      historyActive = historyFiltered.length - 1;
    }
    if (historyFiltered.length === 0) {
      historyListEl.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'hp-empty';
      empty.textContent =
        historyAllItems.length === 0 ? 'No saved conversations yet.' : 'No conversations match your filter.';
      historyListEl.append(empty);
      return;
    }
    historyListEl.replaceChildren(
      ...historyFiltered.map((it, i) => {
        const row = document.createElement('div');
        row.className = 'hp-item' + (i === historyActive ? ' active' : '') + (it.archived ? ' archived' : '');

        const main = document.createElement('div');
        main.className = 'hp-item-main';

        if (renamingId === it.id) {
          // Inline rename: the title becomes an input; Enter saves, Escape cancels.
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'hp-rename';
          input.value = it.title || '';
          input.setAttribute('aria-label', 'New title');
          input.addEventListener('mousedown', (e) => e.stopPropagation());
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const title = input.value.trim();
              if (title) {
                renamingId = null;
                historyAction('renameConversation', it, { title });
              }
            } else if (e.key === 'Escape') {
              e.preventDefault();
              renamingId = null;
              renderHistory();
            }
          });
          input.addEventListener('blur', () => {
            if (renamingId === it.id) {
              renamingId = null;
              renderHistory();
            }
          });
          main.append(input);
          row.append(main);
          setTimeout(() => {
            input.focus();
            input.select();
          }, 0);
          return row;
        }

        const title = document.createElement('div');
        title.className = 'hp-item-title';
        title.textContent = it.title || 'Conversation';
        const meta = document.createElement('div');
        meta.className = 'hp-item-meta';
        if (historyScope === 'all' && it.repo) {
          const badge = document.createElement('span');
          badge.className = 'hp-repo';
          badge.textContent = it.repo;
          meta.append(badge);
        }
        meta.append(
          document.createTextNode(
            `${it.archived ? '🗄 ' : ''}${fmtWhen(it.savedAt)} · ${it.events} events${it.model ? ' · ' + it.model : ''}`
          )
        );
        main.append(title, meta);
        if (it.snippet) {
          const snip = document.createElement('div');
          snip.className = 'hp-snippet';
          snip.textContent = it.snippet;
          main.append(snip);
        }
        main.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectHistory(it);
        });

        const actions = document.createElement('div');
        actions.className = 'hp-actions';
        const del =
          confirmDeleteId === it.id
            ? actionButton('Delete?', 'Click again to permanently delete', () => {
                confirmDeleteId = null;
                historyAction('deleteConversation', it, { confirmed: true });
              })
            : actionButton('🗑', 'Delete', () => {
                confirmDeleteId = it.id;
                renderHistory();
              });
        if (confirmDeleteId === it.id) {
          del.classList.add('arm');
        }
        actions.append(
          actionButton('✎', 'Rename', () => {
            renamingId = it.id;
            confirmDeleteId = null;
            renderHistory();
          }),
          actionButton(it.archived ? '⇪' : '🗄', it.archived ? 'Unarchive' : 'Archive', () =>
            historyAction('archiveConversation', it, { value: !it.archived })
          ),
          del
        );
        if (confirmDeleteId === it.id) {
          row.classList.add('active'); // keep the actions visible while the confirm is armed
        }

        row.append(main, actions);
        return row;
      })
    );
  }
  function historyAction(type, it, extra) {
    vscode.postMessage(Object.assign({ type, id: it.id, base: it.base, scope: historyScope }, extra || {}));
    // Rename/delete prompt on the host; the list refreshes via a fresh historyResults.
  }
  function selectHistory(it) {
    if (!it) {
      return;
    }
    vscode.postMessage({ type: 'openConversation', id: it.id, base: it.base });
    closeHistory();
  }
  if (historyPanel) {
    historyPanel.querySelectorAll('.hp-scopebtn').forEach((btn) => {
      btn.addEventListener('click', () => {
        historyScope = btn.dataset.scope === 'all' ? 'all' : 'repo';
        historyPanel.querySelectorAll('.hp-scopebtn').forEach((b) => b.classList.toggle('active', b === btn));
        historyListEl.innerHTML = '<div class="hp-empty">Loading…</div>';
        historySearchHits = null;
        requestHistory();
        const q = historyFilter.value.trim();
        if (q.length >= 3) {
          vscode.postMessage({ type: 'historySearch', query: q, scope: historyScope, seq: ++historySearchSeq });
        }
      });
    });
    $('historyClose').addEventListener('click', () => closeHistory());
    if (historyArchivedBtn) {
      historyArchivedBtn.addEventListener('click', () => {
        showArchived = !showArchived;
        historyArchivedBtn.setAttribute('aria-pressed', showArchived ? 'true' : 'false');
        historyActive = -1;
        renderHistory();
      });
    }
    historyFilter.addEventListener('input', () => {
      historyActive = -1;
      const q = historyFilter.value.trim();
      if (historySearchTimer) {
        clearTimeout(historySearchTimer);
        historySearchTimer = null;
      }
      if (q.length >= 3) {
        // Debounced host-side content search; title filtering renders immediately.
        historySearchTimer = setTimeout(() => {
          vscode.postMessage({ type: 'historySearch', query: q, scope: historyScope, seq: ++historySearchSeq });
        }, 300);
      } else {
        historySearchHits = null;
      }
      renderHistory();
    });
    historyFilter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeHistory();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        historyActive = Math.min(historyActive + 1, historyFiltered.length - 1);
        renderHistory();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        historyActive = Math.max(historyActive - 1, 0);
        renderHistory();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        selectHistory(historyFiltered[Math.max(0, historyActive)]);
      }
    });
    // Click outside the panel closes it (but not clicks on the toggle button).
    document.addEventListener('mousedown', (e) => {
      if (historyOpen() && !historyPanel.contains(e.target) && e.target !== $('historyBtn')) {
        closeHistory();
      }
    });
  }

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
        const types = (e.dataTransfer && e.dataTransfer.types) || [];
        if (Array.prototype.some.call(types, (t) => t === 'Files' || t === 'text/uri-list')) {
          e.preventDefault();
          inputbox.classList.add('dragover');
        }
      })
    );
    ['dragleave', 'drop'].forEach((ev) => inputbox.addEventListener(ev, () => inputbox.classList.remove('dragover')));
    inputbox.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (!dt) {
        return;
      }
      // VS Code Explorer drags carry URIs: workspace files become @-mentions host-side.
      const uriList = dt.getData('text/uri-list') || '';
      const uris = uriList
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && s[0] !== '#');
      if (uris.length) {
        e.preventDefault();
        vscode.postMessage({ type: 'dropPaths', uris });
        return;
      }
      // OS-shell drops: media attaches as-is; code/text files attach as text context.
      const files = Array.prototype.slice.call(dt.files || []);
      if (!files.length) {
        return;
      }
      e.preventDefault();
      const tooBig = [];
      for (const file of files) {
        if (isAttachable(file.type)) {
          sendFiles([file]);
        } else if (file.size <= 4 * 1024 * 1024) {
          const reader = new FileReader();
          reader.onload = () =>
            vscode.postMessage({ type: 'dropText', name: file.name || '', text: String(reader.result || '') });
          reader.readAsText(file);
        } else {
          tooBig.push(file.name || 'file');
        }
      }
      if (tooBig.length) {
        vscode.postMessage({ type: 'dropUnsupported', names: tooBig });
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
      renderSelInfo(); // the pill mirrors the "Selection" checkbox
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

  // ---------- selection-context pill ----------
  // Shows which editor selection rides along with the next prompt (the
  // "Selection" checkbox is on by default but hidden in the Context disclosure).
  const selinfoEl = $('selinfo');
  let selInfo = null;
  function renderSelInfo() {
    if (!selInfo) {
      selinfoEl.style.display = 'none';
      selinfoEl.replaceChildren();
      return;
    }
    const on = boxes.includeSelection.checked;
    selinfoEl.replaceChildren();
    selinfoEl.classList.toggle('off', !on);
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'seleye';
    eye.textContent = on ? '👁' : '🚫';
    eye.title = on
      ? 'This selection is sent as context with your next message — click to exclude it'
      : 'Selection is NOT sent as context — click to include it';
    eye.addEventListener('click', () => {
      boxes.includeSelection.checked = !boxes.includeSelection.checked;
      boxes.includeSelection.dispatchEvent(new Event('change'));
    });
    const text = document.createElement('span');
    const range =
      selInfo.endLine > selInfo.startLine ? selInfo.startLine + '-' + selInfo.endLine : String(selInfo.startLine);
    text.textContent = selInfo.file + ':' + range + ' selected' + (on ? '' : ' (not sent)');
    selinfoEl.append(eye, text);
    selinfoEl.style.display = 'flex';
  }

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
      if (msg.seq !== undefined && msg.seq !== mentionSeq) {
        return; // out-of-order response for an older query
      }
      mentionItems = msg.items || [];
      mentionIndex = 0;
      renderMentions();
      return;
    }
    if (msg.type === 'historyResults') {
      // Ignore results for a scope the user has since switched away from.
      if (msg.scope && msg.scope !== historyScope) {
        return;
      }
      historyAllItems = msg.items || [];
      historyActive = -1;
      if (historyOpen()) {
        renderHistory();
      }
      return;
    }
    if (msg.type === 'historySearchResults') {
      // Content-search hits for the history filter; drop stale/superseded responses.
      if (msg.scope !== historyScope || msg.seq !== historySearchSeq) {
        return;
      }
      if (historyFilter.value.trim().length < 3) {
        return; // query since cleared
      }
      historySearchHits = msg.items || [];
      if (historyOpen()) {
        renderHistory();
      }
      return;
    }
    if (msg.type === 'openCompactMenu') {
      // The host asks us to show the compact options (e.g. the /compact slash command).
      openCompactMenu();
      return;
    }
    if (msg.type === 'openCompareMenu') {
      // /compare — pick the model to run the prompt against (alongside the current one).
      openMenu({
        kind: 'compare',
        title: 'Compare against…',
        note:
          'Runs the prompt on your current model (' +
          (msg.current || '') +
          ') and the one you pick — chat-only, no tools.',
        items: (msg.models || []).map((m) => ({
          label: m.label,
          detail: m.id,
          onPick: () => vscode.postMessage({ type: 'compareRun', otherId: m.id, prompt: msg.prompt })
        }))
      });
      return;
    }
    if (msg.type === 'usageInfo') {
      // Billed-usage response for the in-panel usage popover. Ignore if the user
      // has since closed it or opened a different menu.
      if (menuKind !== 'usage') {
        return;
      }
      if (msg.needsAccount) {
        openUsageAccountInput(msg.accountId || '');
      } else if (msg.error) {
        openMenu({
          kind: 'usage',
          title: 'Usage — this month',
          note: '⚠ ' + msg.error,
          items: [{ label: 'Change account id…', onPick: () => openUsageAccountInput(msg.accountId || '') }]
        });
      } else {
        openMenu({
          kind: 'usage',
          title: 'Usage — this month',
          lines: msg.lines || [],
          items: [{ label: 'Change account id…', onPick: () => openUsageAccountInput(msg.accountId || '') }]
        });
      }
      return;
    }
    if (msg.type === 'voiceStatus') {
      // Transcription finished (the text arrives via a separate insertText) or failed.
      setMicState('idle');
      if (msg.state !== 'done') {
        pendingVoiceSend = false;
      }
      return;
    }
    if (msg.type === 'insertText') {
      // Splice text (an @-mention from Alt+K / right-click / drop) in at the caret.
      const start = prompt.selectionStart != null ? prompt.selectionStart : prompt.value.length;
      const end = prompt.selectionEnd != null ? prompt.selectionEnd : start;
      const before = prompt.value.slice(0, start);
      const after = prompt.value.slice(end);
      const pad = before && !/\s$/.test(before) ? ' ' : '';
      prompt.value = before + pad + (msg.text || '') + after;
      const caret = (before + pad + (msg.text || '')).length;
      prompt.setSelectionRange(caret, caret);
      prompt.focus();
      if (pendingVoiceSend) {
        // Voice mode: the transcription just landed — send it hands-free.
        pendingVoiceSend = false;
        sendPrompt();
      }
      return;
    }
    if (msg.type === 'restoreDraft') {
      // The host refused the turn before it started (token limit, cancelled
      // large-context confirm) — the prompt was already cleared on send, so put
      // it back. Only if the composer is still empty: don't clobber new typing.
      if (!prompt.value.trim()) {
        prompt.value = msg.text || '';
        prompt.focus();
      }
      return;
    }
    if (msg.type === 'selectionInfo') {
      selInfo = msg.info || null;
      renderSelInfo();
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
      liveText = '';
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
      liveText = '';
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
      liveText += msg.delta;
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
      if (streamContent && liveText.trim()) {
        const btn = addSpeakButton(streamContent.parentNode, liveText);
        if (voiceMode || voicePrefs.autoRead) {
          speak(liveText, btn);
        }
      }
      if (voicePrefs.chime && !document.hasFocus()) {
        playChime();
      }
      liveText = '';
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
    if (msg.selectionInfo !== undefined) {
      selInfo = msg.selectionInfo;
    }
    renderSelInfo();
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
    if (msg.voice) {
      voicePrefs = msg.voice;
    }
    if (msg.promptHistory && recallIndex === -1) {
      sentPrompts = msg.promptHistory; // don't yank entries mid-navigation
    }
    renderAttachments(msg.attachments);

    stopBtn.style.display = msg.busy ? '' : 'none';
    // Send stays enabled while busy — messages typed now are queued as steering.
    // Model/mode switches would only apply from the NEXT turn, so lock them during a run.
    busy = !!msg.busy;
    agent.disabled = busy;
    modeBtn.disabled = busy;
    modeBtn.title = busy ? 'Locked while the agent is running (applies from the next turn)' : 'Mode & thinking';
    const refreshBtn = $('refresh');
    if (refreshBtn) {
      refreshBtn.disabled = busy; // a mid-turn refresh would re-render over the live reply
    }
    prompt.placeholder = busy
      ? 'Type to steer the agent — sent at its next step…'
      : 'Ask Parley…  (@file to attach · paste or drop files · Enter to send · Shift+Enter for newline)';
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

    // A reply is still streaming: the in-progress text isn't in the transcript
    // yet, so the full re-render below would wipe it from view. Keep the
    // non-destructive updates above and skip the rebuild until streamEnd.
    if (msg.busy && streamContent) {
      maybeScroll();
      return;
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
        if (item.role === 'assistant') {
          addSpeakButton(content.parentNode, item.content);
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

  // Tell the extension the page is live — messages posted before the script loads
  // (e.g. an insertText right after the first reveal) would otherwise be dropped.
  vscode.postMessage({ type: 'webviewReady' });
})();
