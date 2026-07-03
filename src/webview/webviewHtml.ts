import * as vscode from 'vscode';

/**
 * The chat webview's HTML shell. The interactive code lives in the bundled
 * dist/webview.js (media/chat.js + markdown-it + highlight.js); this file only
 * builds the static skeleton, CSP, and nonce.
 */
export function buildChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
  // The webview script is bundled (media/chat.js + markdown-it + highlight.js → dist/webview.js).
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.css'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    'img-src data:',
    'font-src data:'
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Parley</title>
</head>
<body>
  <div class="shell">
    <div class="toolbar">
      <span class="title">Parley</span>
      <span id="sessionTok" class="sessiontok" title="Tokens used in this conversation (and estimated cost)"></span>
      <span id="ctx" class="ctx-meter" title="Context window used"><span class="ctxring"></span><span class="ctxnum">–</span></span>
      <span class="grow"></span>
      <button id="newChat" title="New conversation" aria-label="New conversation">＋</button>
      <button id="historyBtn" title="Past conversations" aria-label="Past conversations">🕘</button>
      <button id="usage" title="View usage (this month's billed spend)" aria-label="View usage">💰</button>
      <button id="compact" title="Compact conversation (summarize to free up context)" aria-label="Compact conversation">⊟</button>
      <button id="export" title="Export conversation" aria-label="Export conversation">⤓</button>
      <button id="refresh" title="Refresh model list" aria-label="Refresh model list">↻</button>
    </div>
    <div id="banner" class="banner"></div>
    <div class="histwrap">
      <div id="history" class="history"><div class="empty">Ask Parley about your code.</div></div>
      <div id="historyPanel" class="historypanel" style="display:none">
        <div class="hp-head">
          <div class="hp-scope" role="tablist">
            <button type="button" class="hp-scopebtn active" data-scope="repo" title="Conversations saved in this workspace">This repo</button>
            <button type="button" class="hp-scopebtn" data-scope="all" title="Conversations from every workspace you've used Parley in">All repos</button>
          </div>
          <button type="button" id="historyArchived" class="hp-archbtn" title="Show archived conversations" aria-pressed="false">Archived</button>
          <button type="button" id="historyClose" class="hp-close" title="Close" aria-label="Close history">✕</button>
        </div>
        <input type="text" id="historyFilter" class="hp-filter" placeholder="Filter conversations…" aria-label="Filter conversations">
        <div id="historyList" class="hp-list"></div>
      </div>
      <div id="menuPanel" class="historypanel menupanel" style="display:none" tabindex="-1" role="menu"></div>
      <button id="jump" type="button" title="Jump to latest" aria-label="Jump to latest">↓</button>
    </div>
    <div id="status" class="status" style="display:none"></div>
    <form id="composer" class="composer">
      <details class="ctx-wrap">
        <summary>Context</summary>
        <div class="ctx">
          <label><input id="includeSelection" type="checkbox" checked> Selection</label>
          <label><input id="includeCurrentFile" type="checkbox"> File</label>
          <label><input id="includeOpenEditors" type="checkbox"> Open editors</label>
          <label><input id="includeDiagnostics" type="checkbox"> Diagnostics</label>
          <label><input id="includeUserSelectedFiles" type="checkbox"> Pick files</label>
        </div>
      </details>
      <div id="editing" class="editing" style="display:none"></div>
      <div id="queued" class="queued"></div>
      <div id="attachments" class="attachments"></div>
      <div id="selinfo" class="selinfo" style="display:none"></div>
      <div class="inputbox">
        <div id="mentions" class="mentions" style="display:none"></div>
        <div id="slashMenu" class="mentions" style="display:none"></div>
        <div id="modePanel" class="modepanel" style="display:none">
          <div class="mp-head">Modes</div>
          <button type="button" class="mp-item" data-mode="chat"><span class="mp-name">Chat</span><span class="mp-desc">Answer only — no agent, no file access</span></button>
          <button type="button" class="mp-item" data-mode="ask"><span class="mp-name">Ask before edits</span><span class="mp-desc">Agent proposes edits; you approve each one</span></button>
          <button type="button" class="mp-item" data-mode="edit"><span class="mp-name">Edit automatically</span><span class="mp-desc">Agent applies edits without asking (revertible)</span></button>
          <button type="button" class="mp-item" data-mode="plan"><span class="mp-name">Plan mode</span><span class="mp-desc">Agent explores read-only and presents a plan</span></button>
          <button type="button" class="mp-item" data-mode="auto"><span class="mp-name">Auto mode</span><span class="mp-desc">Agent decides and applies edits automatically</span></button>
          <button type="button" class="mp-item" data-mode="full"><span class="mp-name">Full access <span class="mp-caution">⚠ CAUTION</span></span><span class="mp-desc">Auto-applies edits AND runs shell commands without asking</span></button>
          <div class="mp-sep"></div>
          <div class="mp-head">Extended thinking <span class="mp-note">— effective on Claude &amp; Gemini</span></div>
          <div class="mp-thinking">
            <button type="button" data-thinking="off">Off</button>
            <button type="button" data-thinking="adaptive">Adaptive</button>
            <button type="button" data-thinking="low">Low</button>
            <button type="button" data-thinking="medium">Med</button>
            <button type="button" data-thinking="high">High</button>
          </div>
          <div class="mp-sep"></div>
          <div class="mp-head">Speed <span class="mp-note">— OpenAI / ChatGPT only</span></div>
          <div class="mp-speed">
            <button type="button" data-speed="standard">Standard</button>
            <button type="button" data-speed="fast">⚡ Fast</button>
          </div>
          <div class="mp-foot">Thinking shows the model's reasoning (uses more output tokens). Verified live: it works on <strong>Claude</strong> &amp; <strong>Gemini</strong>; <strong>OpenAI</strong> accepts a reasoning level but Parley doesn't currently apply it. <strong>Fast</strong> requests OpenAI's priority tier (accepted by the gateway; actual ≈1.5× speed depends on your account). Shell commands ask before running — except in <strong>Full access</strong> mode.</div>
        </div>
        <textarea id="prompt" placeholder="Ask Parley…  (@file to attach · paste or drop files · Enter to send · Shift+Enter for newline)"></textarea>
        <div class="actions">
          <select id="agent" class="model" aria-label="Parley model"></select>
          <button type="button" id="modeBtn" class="modebtn" title="Mode &amp; thinking" aria-label="Mode">Chat ▾</button>
          <button type="button" id="attach" title="Attach files or images" aria-label="Attach files or images">📎</button>
          <button type="button" id="mic" title="Voice input (click to record, click again to transcribe)" aria-label="Voice input">🎤</button>
          <button type="button" id="voiceMode" title="Voice mode: hands-free conversation (🎤 auto-sends, replies read aloud)" aria-label="Toggle voice mode">🗣</button>
          <button type="button" id="shot" title="Attach a screenshot (pick any window or screen)" aria-label="Attach a screenshot">📷</button>
          <button type="button" id="rec" title="Record your screen (frames + mic narration; click again to stop, max 60s)" aria-label="Record screen">🎥</button>
          <span class="grow"></span>
          <button type="button" id="stop" style="display:none">Stop</button>
          <button type="submit" id="sendBtn" class="primary">Send</button>
        </div>
      </div>
    </form>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}
