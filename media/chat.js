// Parley chat webview script. Source for the bundled dist/webview.js (esbuild pulls
// in markdown-it + highlight.js), loaded by the webview with a nonce.
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';

(function () {
  const vscode = acquireVsCodeApi();
  // Page nonce (from this script's own tag) — needed to inject the on-demand
  // mermaid chunk past the CSP, which only allows nonce'd scripts.
  const PAGE_NONCE = (document.currentScript && document.currentScript.nonce) || '';
  const $ = (id) => document.getElementById(id);
  const history = $('history');
  const agent = $('agent');
  const banner = $('banner');
  const form = $('composer');
  const prompt = $('prompt');
  const stopBtn = $('stop');
  const sendBtn = $('sendBtn');
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
  const statusTextEl = $('statusText');
  function renderStatus() {
    if (!statusBase) {
      statusEl.style.display = 'none';
      statusTextEl.textContent = '';
      return;
    }
    const total = exactTokens + Math.round(liveChars / 4);
    statusTextEl.textContent =
      statusBase + elapsedText() + (total > 0 ? ' · ' + total.toLocaleString() + ' tokens' : '');
    statusEl.style.display = 'flex';
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
    includeDiagnostics: $('includeDiagnostics')
  };
  // Friendly names for the collapsed-state Context summary ("Context — Selection, …").
  const CTX_LABELS = {
    includeSelection: 'Selection',
    includeCurrentFile: 'File',
    includeOpenEditors: 'Open editors',
    includeDiagnostics: 'Diagnostics'
  };
  const ctxSummaryEl = $('ctxSummary');
  function renderCtxSummary() {
    if (!ctxSummaryEl) {
      return;
    }
    const on = Object.keys(CTX_LABELS)
      .filter((k) => boxes[k] && boxes[k].checked)
      .map((k) => CTX_LABELS[k]);
    ctxSummaryEl.textContent = ' — ' + (on.length ? on.join(', ') : 'none');
  }
  let streamNode = null;
  let streamContent = null;
  let currentSeg = null;
  let thinkingDet = null;
  let thinkingBody = null;
  let planEl = null;
  let lastToolStep = null; // the in-flight tool step row (pulsing dot until its result lands)
  let thinkStartAt = 0; // first/last thinking delta timestamps → "Thought for Ns"
  let thinkLastAt = 0;

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
  // Some models (esp. local/open ones without native tool-calling) emit tool calls as
  // TEXT tags — <tool_call>{…}</tool_call> / <tool_response>…</tool_response> — instead of
  // structured tool-calls. Left as-is they render as a raw wall of JSON. Turn each into a
  // clean labeled, syntax-highlighted (collapsible) block so the transcript stays organized.
  function organizeToolText(src) {
    if (!src || src.indexOf('<tool_') === -1) {
      return src;
    }
    const pretty = (raw) => {
      try {
        return JSON.stringify(JSON.parse(raw.trim()), null, 2);
      } catch {
        return raw.trim();
      }
    };
    const clip = (text, max) => {
      const lines = text.split('\n');
      return lines.length <= max
        ? text
        : lines.slice(0, max).join('\n') + '\n… (' + (lines.length - max) + ' more lines)';
    };
    let out = src.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_m, body) => {
      let name = 'tool';
      let args = body.trim();
      try {
        const o = JSON.parse(body.trim());
        if (o && o.name) {
          name = o.name;
        }
        args = JSON.stringify(o && o.arguments !== undefined ? o.arguments : o, null, 2);
      } catch {
        /* not JSON — show raw */
      }
      return '\n\n**🔧 ' + name + '**\n\n```json\n' + clip(args, 40) + '\n```\n\n';
    });
    out = out.replace(
      /<tool_(?:response|result|output)>\s*([\s\S]*?)\s*<\/tool_(?:response|result|output)>/g,
      (_m, body) => {
        return '\n\n**⎿ result**\n\n```json\n' + clip(pretty(body), 30) + '\n```\n\n';
      }
    );
    return out;
  }
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
      html = md.render(organizeToolText(k));
      mdCache.set(k, html);
    }
    return html;
  }
  // Fence languages where "apply to editor" makes no sense (prose, terminal output, diffs).
  const SKIP_APPLY_LANGS = new Set(['diff', 'text', 'plaintext', 'txt', 'console', 'output', 'markdown', 'md']);

  // ---------- Mermaid diagrams (lazy-loaded chunk) ----------
  let mermaidPromise = null;
  function loadMermaid() {
    if (window.__parleyMermaid) {
      return Promise.resolve(window.__parleyMermaid);
    }
    if (mermaidPromise) {
      return mermaidPromise;
    }
    const src = document.body.dataset.mermaidSrc;
    if (!src) {
      return Promise.reject(new Error('mermaid unavailable'));
    }
    mermaidPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      if (PAGE_NONCE) {
        s.setAttribute('nonce', PAGE_NONCE);
      }
      s.src = src;
      s.onload = () => {
        const m = window.__parleyMermaid;
        if (!m) {
          reject(new Error('mermaid failed to load'));
          return;
        }
        try {
          const dark =
            document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
          m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
        } catch (e) {
          /* initialize best-effort */
        }
        resolve(m);
      };
      s.onerror = () => reject(new Error('mermaid failed to load'));
      document.body.appendChild(s);
    });
    return mermaidPromise;
  }
  let mermaidSeq = 0;
  // Replace a ```mermaid <pre> with the rendered SVG figure (async, best-effort:
  // on any error the original code block is left in place).
  async function renderMermaid(pre) {
    const code = pre.querySelector('code');
    const def = (code ? code.textContent : pre.textContent).trim();
    if (!def) {
      return;
    }
    let m;
    try {
      m = await loadMermaid();
    } catch (e) {
      return; // library unavailable — leave the code block as-is
    }
    const id = 'pmmd-' + ++mermaidSeq;
    try {
      const out = await m.render(id, def);
      const fig = document.createElement('div');
      fig.className = 'mermaid-fig';
      fig.innerHTML = typeof out === 'string' ? out : out.svg;
      pre.replaceWith(fig);
      maybeScroll();
    } catch (e) {
      // Invalid diagram syntax — keep the code block; mermaid may inject an error node, remove it.
      const orphan = document.getElementById('d' + id) || document.getElementById(id);
      if (orphan && orphan.parentNode === document.body) {
        orphan.remove();
      }
    }
  }

  function enhanceContent(contentEl) {
    // Copy (and Apply) buttons on each fenced block. The buttons live outside the
    // scrollable <pre> so they stay pinned while long code lines are scrolled horizontally.
    contentEl.querySelectorAll('pre').forEach((pre) => {
      const codeEl0 = pre.querySelector('code');
      const lang0 = ((/language-([\w#+-]+)/.exec(codeEl0 ? codeEl0.className : '') || [])[1] || '').toLowerCase();
      // Render mermaid diagrams as figures instead of code blocks (no Copy/Apply).
      if (lang0 === 'mermaid') {
        void renderMermaid(pre);
        return;
      }
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
  let lastSteering = []; // steering queue mirror, so pending bubbles survive re-renders
  function renderQueued(steering, followUps) {
    queuedEl.replaceChildren();
    const addChip = (text, i, kind) => {
      const isSteer = kind === 'steer';
      const chip = document.createElement('span');
      chip.className = 'chip queuedchip';
      chip.title = isSteer
        ? 'Steering — injected into the current answer at its next step'
        : 'Queued — runs as its own turn after the current answer finishes';
      chip.textContent = (isSteer ? '⏩ ' : '⏳ ') + (text.length > 60 ? text.slice(0, 60) + '…' : text);
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chipx';
      x.textContent = '×';
      x.addEventListener('click', () => vscode.postMessage({ type: 'unqueue', queueKind: kind, index: i }));
      chip.append(x);
      queuedEl.append(chip);
    };
    (steering || []).forEach((t, i) => addChip(t, i, 'steer'));
    (followUps || []).forEach((t, i) => addChip(t, i, 'followUp'));
  }
  // Steer messages appear in the conversation immediately (like Claude), tagged as
  // pending, until the agent picks them up at its next step. Derived entirely from
  // the server's steering queue (lastSteering) so re-renders and cancels stay in sync;
  // when the queue drains, 'steerInjected' + an empty 'queued' turn them into real
  // user bubbles. Follow-ups (their own later turn) keep just the chip.
  function renderPendingSteers() {
    history.querySelectorAll('.message.user.pendingsteer').forEach((n) => n.remove());
    (lastSteering || []).forEach((text) => {
      const node = document.createElement('div');
      node.className = 'message user pendingsteer';
      const tag = document.createElement('div');
      tag.className = 'steertag';
      tag.textContent = '⏩ Steering — sends at the agent’s next step';
      const c = document.createElement('div');
      c.className = 'content';
      c.innerHTML = renderMd(text);
      enhanceContent(c);
      node.append(tag, c);
      history.append(node);
    });
    maybeScroll();
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

  // ↻ Regenerate — re-run the last user message (optionally after switching model/mode).
  // Shown on the most recent assistant reply only.
  function addRegenerateButton(messageNode) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msgregen';
    btn.title = 'Regenerate this reply (re-runs your last message — switch model/mode first to retry differently)';
    btn.setAttribute('aria-label', 'Regenerate reply');
    btn.textContent = '↻';
    btn.addEventListener('click', () => {
      if (busy) {
        return;
      }
      vscode.postMessage({ type: 'regenerate' });
    });
    messageNode.appendChild(btn);
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
    sum.textContent = 'Thinking…';
    thinkingBody = document.createElement('div');
    thinkingBody.className = 'think-body';
    thinkingDet.append(sum, thinkingBody);
    streamNode.insertBefore(thinkingDet, streamContent);
    thinkStartAt = Date.now();
    thinkLastAt = thinkStartAt;
  }
  function finishThinkingBlock() {
    if (thinkingDet) {
      thinkingDet.open = false;
      const sum = thinkingDet.querySelector('summary');
      if (sum) {
        // Claude Code style: "Thought for 51s" (duration of the reasoning burst).
        const secs = thinkStartAt ? Math.max(0, Math.round((thinkLastAt - thinkStartAt) / 1000)) : null;
        sum.textContent = secs === null ? 'Thought' : 'Thought for ' + secs + 's';
      }
    }
    thinkingDet = null;
    thinkingBody = null;
    thinkStartAt = 0;
    thinkLastAt = 0;
  }
  // Close the live bubble so the next step (tool row / narration) starts a fresh row.
  function closeStreamBubble() {
    finishThinkingBlock();
    if (streamContent) {
      streamContent.classList.remove('cursor');
    }
    streamNode = null;
    streamContent = null;
    currentSeg = null;
  }
  function settleToolStep(cls) {
    if (lastToolStep) {
      lastToolStep.classList.remove('run');
      lastToolStep.classList.add(cls);
      lastToolStep = null;
    }
  }
  // Claude Code style: each tool call is its own step row on the timeline rail,
  // pulsing while it runs; narration that follows opens a fresh bubble below it.
  // Make a tool step click-to-expand, revealing the exact arguments + full raw result.
  function attachToolInspector(row, argsJson, detailText) {
    if (!row || (!argsJson && !detailText)) {
      return;
    }
    const line = row.querySelector('.toolline');
    if (!line || row.classList.contains('expandable')) {
      return;
    }
    row.classList.add('expandable');
    const detail = document.createElement('div');
    detail.className = 'tooldetail';
    detail.style.display = 'none';
    if (argsJson) {
      let pretty = argsJson;
      try {
        pretty = JSON.stringify(JSON.parse(argsJson), null, 2);
      } catch {
        /* keep raw */
      }
      const h = document.createElement('div');
      h.className = 'tooldetail-h';
      h.textContent = 'Arguments';
      const pre = document.createElement('pre');
      pre.textContent = pretty;
      detail.append(h, pre);
    }
    if (detailText) {
      const h = document.createElement('div');
      h.className = 'tooldetail-h';
      h.textContent = 'Result';
      const pre = document.createElement('pre');
      pre.textContent = detailText;
      detail.append(h, pre);
    }
    row.querySelector('.content').append(detail);
    line.addEventListener('click', () => {
      const open = detail.style.display !== 'none';
      detail.style.display = open ? 'none' : 'block';
      row.classList.toggle('open', !open);
    });
  }
  function streamActionLine(text, argsJson) {
    settleToolStep('ok'); // a step that never reported a result counts as done
    closeStreamBubble();
    const wrap = document.createElement('div');
    wrap.className = 'message assistant toolstep run';
    if (argsJson) {
      wrap.dataset.args = argsJson;
    }
    const c = document.createElement('div');
    c.className = 'content';
    const line = document.createElement('div');
    line.className = 'toolline';
    line.textContent = text;
    c.append(line);
    wrap.append(c);
    history.append(wrap);
    lastToolStep = wrap;
    maybeScroll();
  }
  // Claude-style "⎿ result" line under its action; settles the step's dot green/red.
  function streamResultLine(text, detailText) {
    if (!lastToolStep) {
      return;
    }
    const line = document.createElement('div');
    line.className = 'toolresult';
    line.textContent = '⎿ ' + text;
    lastToolStep.querySelector('.content').append(line);
    settleToolStep(/^(error|✗|failed|denied)/i.test(text || '') ? 'err' : 'ok');
    attachToolInspector(lastToolStep, lastToolStep.dataset.args || '', detailText || '');
    maybeScroll();
  }
  // Centered "Switched to <model>" divider with wavy rules on both sides.
  function dividerRow(text) {
    const row = document.createElement('div');
    row.className = 'divider';
    const label = document.createElement('span');
    label.textContent = text;
    row.append(label);
    return row;
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
    settleToolStep('ok'); // the edit card is this step's result
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
    // Each edit is its own step: close any open bubble and append the card standalone,
    // so later narration opens a fresh bubble below it (matching the timeline model).
    closeStreamBubble();
    history.append(card);
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
    settleToolStep('ok'); // settle any preceding tool step (no-op if none)
    closeStreamBubble();
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
    const act = (type, extra) => {
      buttons.forEach((b) => (b.disabled = true));
      vscode.postMessage({ type, id, ...(extra || {}) });
    };
    const applyBtn = document.createElement('button');
    applyBtn.className = 'applybtn';
    applyBtn.textContent = isNew ? 'Create file' : 'Apply';
    applyBtn.addEventListener('click', () => act('applyChange'));
    buttons.push(applyBtn);
    if (approval) {
      const applyAllBtn = document.createElement('button');
      applyAllBtn.className = 'applybtn';
      applyAllBtn.textContent = 'Apply all';
      applyAllBtn.title = "Apply this and the rest of this turn's edits without asking again";
      applyAllBtn.addEventListener('click', () => act('applyChange', { all: true }));
      buttons.push(applyAllBtn);
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
    if (approval) {
      const rejectAllBtn = document.createElement('button');
      rejectAllBtn.className = 'dismissbtn';
      rejectAllBtn.textContent = 'Reject all';
      rejectAllBtn.title = "Reject this and the rest of this turn's edits without asking again";
      rejectAllBtn.addEventListener('click', () => act('dismissChange', { all: true }));
      buttons.push(rejectAllBtn);
    }
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
    lastToolStep = null; // any prior in-flight step reference is now detached
    pendingIds = pendingIds || [];
    let userOrdinal = 0;
    let tindex = -1;
    let lastAssistantNode = null;
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
        lastAssistantNode = c.parentNode;
        if (e.thinking) {
          const det = document.createElement('details');
          det.className = 'thinking';
          const sum = document.createElement('summary');
          sum.textContent = e.thinkingSecs != null ? 'Thought for ' + e.thinkingSecs + 's' : 'Thought';
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
        const isErr = !!e.result && /^(error|✗|failed|denied)/i.test(e.result);
        const wrap = document.createElement('div');
        wrap.className = 'message assistant toolstep ' + (isErr ? 'err' : 'ok');
        const c = document.createElement('div');
        c.className = 'content';
        const a = document.createElement('div');
        a.className = 'toolline';
        a.textContent = e.action;
        c.append(a);
        if (e.result) {
          const r = document.createElement('div');
          r.className = 'toolresult';
          r.textContent = '⎿ ' + e.result;
          c.append(r);
        }
        wrap.append(c);
        history.append(wrap);
        attachToolInspector(wrap, e.args || '', e.detail || '');
      } else if (e.kind === 'divider') {
        history.append(dividerRow(e.text));
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
        // Only actual warnings/heads-ups get the yellow rail dot; plain status notes
        // (e.g. "captured your screen") stay neutral.
        if (
          /⚠|heads-?up|warning|failed|couldn'?t|can'?t|cannot|unavailable|not applied|no measurable effect/i.test(
            e.text || ''
          )
        ) {
          c.parentNode.classList.add('warn');
        }
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
    // Regenerate affordance on the most recent assistant reply (idle only).
    if (lastAssistantNode && !busy) {
      addRegenerateButton(lastAssistantNode);
    }
    renderPendingSteers(); // keep pending steer bubbles across full re-renders
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
    { cmd: '/screenshot', desc: 'Capture your whole screen and attach it (no picker)' },
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
    if (busy) {
      // While the agent works: steer into the current answer, or queue for after.
      msg.steer = steerWhileBusy;
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
    menuItems = []; // built during render so { separator: true } entries can be skipped
    menuRows = [];
    menuActive = 0;

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
    if (opts.items && opts.items.length) {
      const list = document.createElement('div');
      list.className = 'hp-list';
      opts.items.forEach((it) => {
        if (it.separator) {
          const sep = document.createElement('div');
          sep.className = 'mn-sep';
          list.append(sep);
          return;
        }
        const i = menuItems.length;
        menuItems.push(it);
        const row = document.createElement('div');
        row.className = 'hp-item mn-item' + (i === menuActive ? ' active' : '') + (it.danger ? ' mn-danger' : '');
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
    if (!menuItems.length) {
      menuActive = -1;
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

  // App-bar overflow (⋯): the low-frequency global/meta actions live behind one menu,
  // so the bar stays New + History (+ the contextual design-preview button).
  function openAppMoreMenu() {
    openMenu({
      kind: 'appmore',
      title: 'Parley',
      items: [
        {
          label: 'Usage — this month',
          detail: 'Your billed spend this month',
          onPick: () => openUsageMenu()
        },
        {
          label: 'Refresh model list',
          detail: busy ? 'Unavailable while Parley is working' : 'Re-fetch the available models',
          onPick: () => {
            if (!busy) {
              vscode.postMessage({ type: 'refreshAgents' });
            }
          }
        },
        {
          label: 'Settings',
          detail: 'Open Parley settings',
          onPick: () => vscode.postMessage({ type: 'openSettings' })
        }
      ]
    });
  }
  $('newChat').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  $('historyBtn').addEventListener('click', () => toggleHistory());
  const appMoreBtn = $('appMore');
  if (appMoreBtn) {
    appMoreBtn.addEventListener('click', () => toggleMenu('appmore', openAppMoreMenu));
  }
  const artifactBtn = $('artifactBtn');
  if (artifactBtn) {
    artifactBtn.addEventListener('click', () => vscode.postMessage({ type: 'openArtifacts' }));
  }

  // ---------- Current-conversation actions (title line + rename / archive / delete) ----------
  let convId = '';
  let convBase = '';
  let convTitle = '';
  let convArchived = false;
  const convTitleText = $('convTitleText');
  const convTitleInput = $('convTitleInput');
  const editTitleBtn = $('editTitle');
  const archiveCurrentBtn = $('archiveCurrent');
  const deleteCurrentBtn = $('deleteCurrent');
  function editingTitle() {
    return convTitleInput && convTitleInput.style.display !== 'none';
  }
  function startTitleEdit() {
    if (!convId || !convTitleInput) {
      return;
    }
    convTitleInput.value = convTitle || '';
    convTitleInput.style.display = 'block';
    convTitleText.style.display = 'none';
    convTitleInput.focus();
    convTitleInput.select();
  }
  function endTitleEdit(save) {
    if (!editingTitle()) {
      return;
    }
    const val = convTitleInput.value.trim().slice(0, 120);
    convTitleInput.style.display = 'none';
    convTitleText.style.display = 'block';
    if (save && val && val !== convTitle) {
      convTitle = val;
      convTitleText.textContent = val; // optimistic; host echoes it back via state
      vscode.postMessage({ type: 'renameConversation', id: convId, base: convBase, title: val, scope: 'repo' });
    }
  }
  if (editTitleBtn) {
    editTitleBtn.addEventListener('click', () => (editingTitle() ? endTitleEdit(true) : startTitleEdit()));
  }
  if (convTitleText) {
    // Codex-style: clicking the conversation name opens the past-conversations list
    // (search + relative dates); double-click renames it inline (also in the ⋯ menu).
    convTitleText.addEventListener('click', () => toggleHistory());
    convTitleText.addEventListener('dblclick', () => {
      closeHistory();
      startTitleEdit();
    });
  }
  // Codex-style header controls: ‹back› to past conversations, and right-side actions.
  function openConvMoreMenu() {
    openMenu({
      kind: 'convmore',
      title: 'Conversation',
      items: [
        {
          label: 'Rename',
          detail: 'Rename this conversation',
          onPick: () => startTitleEdit()
        },
        {
          label: 'Export…',
          detail: 'Save as Markdown, plain text, or JSON',
          onPick: () => openExportMenu()
        },
        {
          label: 'Compact',
          detail: 'Summarize older messages to free up context',
          onPick: () => vscode.postMessage({ type: 'compact', keepRecent: 4 })
        },
        { separator: true },
        {
          label: convArchived ? 'Unarchive' : 'Archive',
          detail: convArchived ? 'Show in the default list again' : 'Hide from the default list',
          onPick: () => {
            if (convId) {
              vscode.postMessage({
                type: 'archiveConversation',
                id: convId,
                base: convBase,
                value: !convArchived,
                scope: 'repo'
              });
            }
          }
        },
        {
          label: 'Delete…',
          danger: true,
          detail: 'Permanently remove this conversation',
          onPick: () => {
            if (convId) {
              vscode.postMessage({ type: 'deleteConversation', id: convId, base: convBase, scope: 'repo' });
            }
          }
        }
      ]
    });
  }
  const convBackBtn = $('convBack');
  const convMoreBtn = $('convMore');
  const convNewBtn = $('convNew');
  const convSettingsBtn = $('convSettings');
  const convRenameBtn = $('convRename');
  if (convBackBtn) {
    convBackBtn.addEventListener('click', () => toggleHistory());
  }
  if (convMoreBtn) {
    convMoreBtn.addEventListener('click', () => toggleMenu('convmore', openConvMoreMenu));
  }
  if (convNewBtn) {
    convNewBtn.addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  }
  if (convSettingsBtn) {
    convSettingsBtn.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  }
  if (convRenameBtn) {
    convRenameBtn.addEventListener('click', () => startTitleEdit());
  }
  if (convTitleInput) {
    convTitleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        endTitleEdit(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        endTitleEdit(false);
      }
    });
    convTitleInput.addEventListener('blur', () => endTitleEdit(true));
  }
  if (archiveCurrentBtn) {
    archiveCurrentBtn.addEventListener('click', () => {
      if (!convId) {
        return;
      }
      vscode.postMessage({
        type: 'archiveConversation',
        id: convId,
        base: convBase,
        value: !convArchived,
        scope: 'repo'
      });
    });
  }
  if (deleteCurrentBtn) {
    // No inline confirm here — the host shows a modal warning before deleting.
    deleteCurrentBtn.addEventListener('click', () => {
      if (!convId) {
        return;
      }
      vscode.postMessage({ type: 'deleteConversation', id: convId, base: convBase, scope: 'repo' });
    });
  }
  // Append text to the composer and re-fire the input handler so the slash / @-mention
  // menus open for what we just inserted.
  function insertAtPrompt(text) {
    const sep = prompt.value && !/\s$/.test(prompt.value) ? ' ' : '';
    prompt.value = prompt.value + sep + text;
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    prompt.dispatchEvent(new Event('input'));
  }
  // "+ Add" menu — one entry point for the insert/capture actions, so the composer
  // stays a few high-frequency buttons instead of a 13-icon wall. Mirrors the mode
  // popover's show/close pattern. The individual actions reuse the same handlers as
  // before (attach message, @-insert, screenshot, screen-record toggle, computer).
  const addMenuBtn = $('addMenuBtn');
  const addMenu = $('addMenu');
  function toggleAddMenu(show) {
    if (!addMenu || !addMenuBtn) {
      return;
    }
    const open = show === undefined ? addMenu.style.display === 'none' : show;
    addMenu.style.display = open ? 'block' : 'none';
    addMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      const recLabel = addMenu.querySelector('.add-reclabel');
      if (recLabel) {
        recLabel.textContent = recState === 'recording' ? 'Stop recording' : 'Screen recording';
      }
    }
  }
  if (addMenuBtn && addMenu) {
    addMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAddMenu();
    });
    addMenu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => toggleAddMenu(false));
    addMenu.querySelectorAll('.add-item').forEach((item) => {
      item.addEventListener('click', () => {
        toggleAddMenu(false);
        switch (item.dataset.add) {
          case 'context':
            insertAtPrompt('@');
            break;
          case 'attach':
            vscode.postMessage({ type: 'attachFiles' });
            break;
          case 'web':
            insertAtPrompt('@browser ');
            break;
          case 'shot':
            vscode.postMessage({ type: 'screenshotAttach' });
            break;
          case 'rec':
            if (recState === 'idle') {
              void startScreenRecording();
            } else {
              stopScreenRecording();
            }
            break;
          case 'computer': {
            const task = prompt.value.trim();
            if (task && !task.startsWith('/')) {
              prompt.value = '/computer ' + task;
              sendPrompt();
              break;
            }
            if (!prompt.value.trim()) {
              prompt.value = '/computer ';
            }
            prompt.focus();
            prompt.setSelectionRange(prompt.value.length, prompt.value.length);
            hideSlash();
            break;
          }
        }
      });
    });
  }
  let artifactCount = 0; // # of previewable artifacts in the latest turn (from state)
  const designBtn = $('designBtn');
  if (designBtn) {
    designBtn.addEventListener('click', () => {
      if (artifactCount > 0) {
        vscode.postMessage({ type: 'openArtifacts' }); // open the live preview
        return;
      }
      // Nothing to preview yet — kick off a design request instead of a dead-end notice.
      if (!prompt.value.trim()) {
        prompt.value = 'Design a ';
      }
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      prompt.dispatchEvent(new Event('input'));
    });
  }
  const slashBtn = $('slashBtn');
  if (slashBtn) {
    slashBtn.addEventListener('click', () => {
      if (!prompt.value.trim()) {
        prompt.value = '/'; // slash commands apply to an empty composer
      }
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      prompt.dispatchEvent(new Event('input'));
    });
  }

  // ---------- Styled tooltips (replace the OS's native white title box) ----------
  // Any element with a `title` gets a dark, theme-matched tooltip instead. We steal the
  // native title into data-tip on first hover so the OS tooltip never appears; a delegated
  // listener covers dynamically-added elements (history rows, tool steps, links) too.
  const tipEl = document.createElement('div');
  tipEl.className = 'tooltip';
  tipEl.style.display = 'none';
  document.body.appendChild(tipEl);
  let tipTarget = null;
  let tipTimer = null;
  function positionTip(el) {
    const r = el.getBoundingClientRect();
    const tr = tipEl.getBoundingClientRect();
    let top = r.top - tr.height - 6;
    if (top < 4) {
      top = r.bottom + 6; // not enough room above — drop below
    }
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
    tipEl.style.top = top + 'px';
    tipEl.style.left = left + 'px';
  }
  function showTip(el) {
    const text = el.getAttribute('data-tip');
    if (!text) {
      return;
    }
    tipEl.textContent = text;
    tipEl.style.display = 'block';
    positionTip(el);
    tipTarget = el;
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tipEl.style.display = 'none';
    tipTarget = null;
  }
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('[title], [data-tip]');
    if (!el) {
      return;
    }
    if (el.hasAttribute('title')) {
      const t = el.getAttribute('title');
      el.setAttribute('data-tip', t);
      if (!el.getAttribute('aria-label')) {
        el.setAttribute('aria-label', t); // keep an accessible name after dropping title
      }
      el.removeAttribute('title');
    }
    if (el === tipTarget) {
      return;
    }
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(el), 320);
  });
  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el && el === tipTarget) {
      hideTip();
    } else {
      clearTimeout(tipTimer);
    }
  });
  document.addEventListener('mousedown', hideTip);
  window.addEventListener('scroll', hideTip, true);

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
    micBtn.classList.toggle('recording', state === 'recording'); // red pulse via CSS
    micBtn.classList.toggle('busy', state === 'busy');
    micBtn.disabled = state === 'busy';
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
  // Small in-chat countdown shown while the host displays a click target on each monitor.
  let shotCountTimer = null;
  let shotCountLeft = 0;
  function startShotCountdown(seconds, text) {
    stopShotCountdown();
    shotCountLeft = Math.max(1, Math.round(seconds));
    setStatus('🖥 ' + text + ' — ' + shotCountLeft + 's');
    shotCountTimer = setInterval(() => {
      shotCountLeft -= 1;
      if (shotCountLeft <= 0) {
        setStatus('🖥 ' + text);
      } else {
        setStatus('🖥 ' + text + ' — ' + shotCountLeft + 's');
      }
    }, 1000);
  }
  function stopShotCountdown() {
    if (shotCountTimer) {
      clearInterval(shotCountTimer);
      shotCountTimer = null;
    }
    shotCountLeft = 0;
    setStatus('');
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
    if (addMenuBtn) {
      addMenuBtn.classList.add('recording'); // red pulse on the + button while recording
      addMenuBtn.title = 'Recording your screen — open the + menu to stop';
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
    if (addMenuBtn) {
      addMenuBtn.classList.remove('recording');
      addMenuBtn.title = 'Add — context, files, web, screen…';
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
    // Plain click → host-side monitor flow (auto on one screen, click-a-screen on many).
    // Shift+click → OS picker (getDisplayMedia) for capturing a single application window.
    shotBtn.addEventListener('click', (e) => {
      if (e.shiftKey) {
        void takeScreenshot();
      } else {
        vscode.postMessage({ type: 'screenshotAttach' });
      }
    });
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
  // Codex-style compact "time since last chat": 9m, 52m, 2h, 13h, 1d, 2w, 3mo.
  function fmtRelative(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
      return '';
    }
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return Math.floor(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 604800) return Math.floor(s / 86400) + 'd';
    if (s < 2592000) return Math.floor(s / 604800) + 'w';
    return Math.floor(s / 2592000) + 'mo';
  }
  function fmtWhen(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  }
  // Monochrome line icons (Lucide-style) for the history-list row actions.
  function svgIcon(inner) {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      inner +
      '</svg>'
    );
  }
  const ICONS = {
    pencil: svgIcon('<path d="M17 3a2.85 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
    archive: svgIcon(
      '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><line x1="10" y1="12" x2="14" y2="12"/>'
    ),
    unarchive: svgIcon(
      '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h4"/><path d="M15 8v13"/><path d="m19 15-4-4-4 4"/>'
    ),
    trash: svgIcon(
      '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'
    )
  };
  function actionButton(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hp-act';
    b.innerHTML = label; // label may be an SVG icon or plain text ("Delete?")
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
          document.createTextNode(`${it.archived ? '🗄 ' : ''}${it.events} events${it.model ? ' · ' + it.model : ''}`)
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

        // Codex-style relative "last chat" time, right-aligned (hidden on hover so the
        // rename/archive/delete actions can take its place).
        const when = document.createElement('span');
        when.className = 'hp-when';
        when.textContent = fmtRelative(it.savedAt);
        when.title = fmtWhen(it.savedAt);

        const actions = document.createElement('div');
        actions.className = 'hp-actions';
        const del =
          confirmDeleteId === it.id
            ? actionButton('Delete?', 'Click again to permanently delete', () => {
                confirmDeleteId = null;
                historyAction('deleteConversation', it, { confirmed: true });
              })
            : actionButton(ICONS.trash, 'Delete', () => {
                confirmDeleteId = it.id;
                renderHistory();
              });
        if (confirmDeleteId === it.id) {
          del.classList.add('arm');
        }
        actions.append(
          actionButton(ICONS.pencil, 'Rename', () => {
            renamingId = it.id;
            confirmDeleteId = null;
            renderHistory();
          }),
          actionButton(it.archived ? ICONS.unarchive : ICONS.archive, it.archived ? 'Unarchive' : 'Archive', () =>
            historyAction('archiveConversation', it, { value: !it.archived })
          ),
          del
        );
        if (confirmDeleteId === it.id) {
          row.classList.add('active'); // keep the actions visible while the confirm is armed
        }

        row.append(main, when, actions);
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

  // Steer-vs-queue toggle: how a message sent WHILE the agent is working is handled.
  // Queue (default) = runs as its own turn after; Steer = injected into the current answer.
  const queueModeBtn = $('queueMode');
  let steerWhileBusy = false;
  function renderQueueMode() {
    if (!queueModeBtn) {
      return;
    }
    queueModeBtn.textContent = steerWhileBusy ? '⏩ Steer' : '⏳ Queue';
    queueModeBtn.title = steerWhileBusy
      ? 'Messages you send now are STEERED into the current answer at its next step. Click to queue them instead.'
      : 'Messages you send now are QUEUED and answered after the current turn finishes. Click to steer them into the current answer instead.';
    if (busy) {
      prompt.placeholder = steerWhileBusy
        ? 'Type to steer the agent — injected at its next step…'
        : 'Type your next message — it will be answered after this turn…';
    }
  }
  if (queueModeBtn) {
    renderQueueMode();
    queueModeBtn.addEventListener('click', () => {
      steerWhileBusy = !steerWhileBusy;
      renderQueueMode();
    });
  }
  Object.values(boxes).forEach((box) =>
    box.addEventListener('change', () => {
      vscode.postMessage({
        type: 'contextOptionsChanged',
        contextOptions: Object.fromEntries(Object.entries(boxes).map(([k, i]) => [k, i.checked]))
      });
      renderSelInfo(); // the pill mirrors the "Selection" checkbox
      renderCtxSummary();
    })
  );
  renderCtxSummary();

  // Open links from rendered Markdown externally.
  history.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a.lnk');
    if (a && a.dataset.href) {
      e.preventDefault();
      vscode.postMessage({ type: 'openLink', url: a.dataset.href });
      return;
    }
    // Click any inline image to open it full-size in a lightbox.
    const img = e.target.closest && e.target.closest('img.msgimg');
    if (img && img.src) {
      openLightbox(img.src);
    }
  });

  // ---------- image lightbox (zoom / pan / download / next-prev / thumbnails) ----------
  let lightboxEl = null; // the overlay, or null when closed
  let lb = null; // { list, index, zoom, tx, ty, img, pct, strip, apply, show }
  function closeLightbox() {
    if (lightboxEl) {
      lightboxEl.remove();
      lightboxEl = null;
      lb = null;
    }
  }
  function collectImages() {
    return Array.from(history.querySelectorAll('img.msgimg')).map((i) => i.src);
  }
  function lbButton(cls, label, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    return b;
  }
  function downloadImage(src, name) {
    const ext = /^data:image\/(png|jpe?g|gif|webp|svg\+xml)/i.exec(src);
    const suffix = ext ? '.' + ext[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg') : '.png';
    const a = document.createElement('a');
    a.href = src;
    a.download = name + suffix;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function openLightbox(src) {
    closeLightbox();
    const list = collectImages();
    let index = list.indexOf(src);
    if (index < 0) {
      list.unshift(src);
      index = 0;
    }
    const overlay = document.createElement('div');
    overlay.className = 'lightbox';

    const stage = document.createElement('div');
    stage.className = 'lb-stage';
    const img = document.createElement('img');
    img.className = 'lb-img';
    stage.appendChild(img);

    const top = document.createElement('div');
    top.className = 'lb-top';
    const dl = lbButton('lb-btn', '⬇', 'Download');
    const close = lbButton('lb-btn', '✕', 'Close (Esc)');
    top.append(dl, close);

    const prev = lbButton('lb-nav lb-prev', '‹', 'Previous (←)');
    const next = lbButton('lb-nav lb-next', '›', 'Next (→)');

    const zoombar = document.createElement('div');
    zoombar.className = 'lb-zoom';
    const zout = lbButton('lb-btn', '−', 'Zoom out (−)');
    const pct = document.createElement('span');
    pct.className = 'lb-pct';
    const zin = lbButton('lb-btn', '+', 'Zoom in (+)');
    zoombar.append(zout, pct, zin);

    const strip = document.createElement('div');
    strip.className = 'lb-strip';

    overlay.append(stage, top, prev, next, zoombar, strip);
    document.body.appendChild(overlay);
    lightboxEl = overlay;
    lb = { list, index, zoom: 1, tx: 0, ty: 0, img, pct, strip };

    const apply = () => {
      img.style.transform = 'translate(' + lb.tx + 'px,' + lb.ty + 'px) scale(' + lb.zoom + ')';
      pct.textContent = Math.round(lb.zoom * 100) + '%';
      img.style.cursor = lb.zoom > 1 ? 'grab' : 'default';
    };
    const zoom = (delta) => {
      lb.zoom = Math.min(8, Math.max(0.1, +(lb.zoom + delta).toFixed(2)));
      if (lb.zoom <= 1) {
        lb.tx = lb.ty = 0;
      }
      apply();
    };
    const show = (i) => {
      lb.index = (i + lb.list.length) % lb.list.length;
      img.src = lb.list[lb.index];
      lb.zoom = 1;
      lb.tx = lb.ty = 0;
      apply();
      Array.from(strip.children).forEach((t, k) => t.classList.toggle('active', k === lb.index));
      const multi = lb.list.length > 1;
      prev.style.display = next.style.display = strip.style.display = multi ? '' : 'none';
    };
    lb.apply = apply;
    lb.show = show;
    lb.zoom = 1;

    lb.list.forEach((s, k) => {
      const t = document.createElement('img');
      t.className = 'lb-thumb';
      t.src = s;
      t.addEventListener('click', (e) => {
        e.stopPropagation();
        show(k);
      });
      strip.append(t);
    });

    close.addEventListener('click', (e) => (e.stopPropagation(), closeLightbox()));
    dl.addEventListener(
      'click',
      (e) => (e.stopPropagation(), downloadImage(lb.list[lb.index], 'image-' + (lb.index + 1)))
    );
    prev.addEventListener('click', (e) => (e.stopPropagation(), show(lb.index - 1)));
    next.addEventListener('click', (e) => (e.stopPropagation(), show(lb.index + 1)));
    zin.addEventListener('click', (e) => (e.stopPropagation(), zoom(0.25)));
    zout.addEventListener('click', (e) => (e.stopPropagation(), zoom(-0.25)));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target === stage) {
        closeLightbox();
      }
    });
    overlay.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 0.2 : -0.2);
    });
    // Drag-to-pan when zoomed in.
    let dragging = false;
    let sx = 0;
    let sy = 0;
    img.addEventListener('pointerdown', (e) => {
      if (lb.zoom <= 1) {
        return;
      }
      dragging = true;
      sx = e.clientX - lb.tx;
      sy = e.clientY - lb.ty;
      img.style.cursor = 'grabbing';
      img.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    img.addEventListener('pointermove', (e) => {
      if (!dragging) {
        return;
      }
      lb.tx = e.clientX - sx;
      lb.ty = e.clientY - sy;
      apply();
    });
    img.addEventListener('pointerup', () => {
      dragging = false;
      apply();
    });

    show(index);
  }
  document.addEventListener('keydown', (e) => {
    if (lightboxEl && lb) {
      if (e.key === 'Escape') {
        closeLightbox();
        return;
      }
      if (e.key === 'ArrowRight') {
        lb.show(lb.index + 1);
        return;
      }
      if (e.key === 'ArrowLeft') {
        lb.show(lb.index - 1);
        return;
      }
      if (e.key === '+' || e.key === '=') {
        lb.zoom = Math.min(8, +(lb.zoom + 0.25).toFixed(2));
        lb.apply();
        return;
      }
      if (e.key === '-' || e.key === '_') {
        lb.zoom = Math.max(0.1, +(lb.zoom - 0.25).toFixed(2));
        if (lb.zoom <= 1) {
          lb.tx = lb.ty = 0;
        }
        lb.apply();
        return;
      }
    }
    if (e.key === 'Escape' && shotCountTimer) {
      // Overlay Esc is the primary cancel; this also handles the case where the chat kept focus.
      vscode.postMessage({ type: 'cancelScreenshotPick' });
      stopShotCountdown();
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
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chipx';
      x.textContent = '×';
      x.title = 'Remove';
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ type: 'removeAttachment', id: att.id });
      });

      if (att.kind === 'image' && att.preview) {
        // Image attachments show a clickable thumbnail that opens the full viewer.
        const thumb = document.createElement('span');
        thumb.className = 'chip imgchip';
        thumb.title = att.label + ' — click to open';
        const img = document.createElement('img');
        img.className = 'chipthumb';
        img.src = att.preview;
        img.alt = att.label;
        const name = document.createElement('span');
        name.className = 'chipname';
        name.textContent = att.label;
        thumb.append(img, name, x);
        thumb.addEventListener('click', () => openLightbox(att.preview));
        attachmentsEl.append(thumb);
        return;
      }

      const chip = document.createElement('span');
      chip.className = 'chip';
      const icon = att.kind === 'image' ? '🖼 ' : att.kind === 'audio' ? '🎵 ' : '📄 ';
      chip.textContent = icon + att.label;
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
      setStatus('Working…');
      return;
    }
    if (msg.type === 'retry' || msg.type === 'status') {
      // Transient notices from the extension (retry countdowns, waiting-for-review).
      setStatus(msg.text || '');
      return;
    }
    if (msg.type === 'screenshotFallback') {
      // No native monitor picker here (non-Windows, or enumeration failed) — use the OS picker.
      void takeScreenshot();
      return;
    }
    if (msg.type === 'screenshotCountdown') {
      startShotCountdown(msg.seconds || 5, msg.text || 'Pick a monitor to capture');
      return;
    }
    if (msg.type === 'screenshotCountdownEnd') {
      stopShotCountdown();
      return;
    }
    if (msg.type === 'queued') {
      renderQueued(msg.steering || [], msg.followUps || []);
      lastSteering = msg.steering || [];
      renderPendingSteers();
      return;
    }
    if (msg.type === 'steerInjected') {
      // A queued steering message just joined the conversation: close the current
      // assistant bubble so the reply to it starts fresh underneath.
      settleToolStep('ok');
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
      thinkLastAt = Date.now();
      liveChars += msg.delta.length; // thinking tokens tick the live "· N tokens" counter
      setStatus('Thinking…');
      maybeScroll();
      return;
    }
    if (msg.type === 'streamDelta') {
      ensureStreamBubble();
      currentSeg.textContent += msg.delta;
      liveChars += msg.delta.length;
      liveText += msg.delta;
      if (!statusBase || statusBase === 'Thinking…') {
        statusBase = 'Working…';
      }
      renderStatus();
      maybeScroll();
      return;
    }
    if (msg.type === 'toolEvent') {
      streamActionLine(activityLabel(msg.name, msg.args), msg.args);
      setStatus(activityLabel(msg.name, msg.args) + '…');
      return;
    }
    if (msg.type === 'divider') {
      history.append(dividerRow(msg.text || ''));
      maybeScroll();
      return;
    }
    if (msg.type === 'toolResult') {
      streamResultLine(msg.text, msg.detail);
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
      settleToolStep('ok'); // a step with no reported result (e.g. a file edit) is done
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
    renderCtxSummary();
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

    // Current-conversation header: title line + archive toggle.
    if (msg.convId !== undefined) {
      convId = msg.convId || '';
    }
    if (msg.convBase !== undefined) {
      convBase = msg.convBase || '';
    }
    convArchived = !!msg.convArchived;
    if (!editingTitle()) {
      convTitle = msg.convTitle || '';
      if (convTitleText) {
        convTitleText.textContent = convTitle;
      }
    }
    if (archiveCurrentBtn) {
      // Icon is a constant SVG now; only the tooltip reflects the archived state.
      archiveCurrentBtn.title = convArchived ? 'Unarchive this conversation' : 'Archive this conversation';
    }
    artifactCount = (msg.artifacts || []).length;
    if (artifactBtn) {
      artifactBtn.style.display = artifactCount ? '' : 'none';
      artifactBtn.title = artifactCount ? 'Open design preview (' + artifactCount + ')' : 'Open design preview';
    }

    stopBtn.style.display = msg.busy ? '' : 'none';
    if (queueModeBtn) {
      queueModeBtn.style.display = msg.busy ? '' : 'none';
    }
    // Send stays enabled while busy — messages typed now are queued as steering.
    // Model and mode stay changeable mid-run too (the change applies from your NEXT
    // message; a mid-stream state update can't clobber the live reply — see the
    // `busy && streamContent` guard above).
    busy = !!msg.busy;
    agent.disabled = false;
    agent.title = busy ? 'Model — a change applies to your next message' : '';
    modeBtn.disabled = false;
    modeBtn.title = busy ? 'Mode & thinking — a change applies to your next message' : 'Mode & thinking';
    const refreshBtn = $('refresh');
    if (refreshBtn) {
      refreshBtn.disabled = busy; // a mid-turn refresh would re-fetch models and re-render over the live reply
    }
    prompt.placeholder = busy
      ? steerWhileBusy
        ? 'Type to steer the agent — injected at its next step…'
        : 'Type your next message — it will be answered after this turn…'
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
