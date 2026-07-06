import { randomBytes } from 'crypto';
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
  // Mermaid is a separate on-demand chunk (loaded by chat.js when a diagram appears).
  const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'mermaid.js'));
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
<body data-mermaid-src="${mermaidUri}">
  <div class="shell">
    <div class="toolbar">
      <span class="title">Parley</span>
      <span id="sessionTok" class="sessiontok" title="Tokens used in this conversation (and estimated cost)"></span>
      <span id="ctx" class="ctx-meter" title="Context window used"><span class="ctxring"></span><span class="ctxnum">–</span></span>
      <span class="grow"></span>
      <button id="newChat" title="New conversation" aria-label="New conversation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
      <button id="historyBtn" title="Past conversations" aria-label="Past conversations"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg></button>
      <button id="usage" title="View usage (this month's billed spend)" aria-label="View usage"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></button>
      <button id="artifactBtn" title="Open the latest design preview" aria-label="Open design preview" style="display:none"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20"/></svg></button>
      <button id="refresh" title="Refresh model list" aria-label="Refresh model list"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>
      <button id="convSettings" title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    </div>
    <div id="convTitleBar" class="convtitlebar">
      <button id="convBack" class="ct-icon" title="Back to past conversations" aria-label="Back to conversations"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg></button>
      <span id="convTitleText" class="convtitle-text" title="Past conversations"></span>
      <input id="convTitleInput" class="convtitle-input" type="text" maxlength="120" style="display:none" aria-label="Conversation title" />
      <span class="ct-grow"></span>
      <button id="compact" class="ct-icon" title="Compact conversation (summarize to free up context)" aria-label="Compact conversation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>
      <button id="export" class="ct-icon" title="Export conversation" aria-label="Export conversation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
      <button id="archiveCurrent" class="ct-icon" title="Archive this conversation" aria-label="Archive this conversation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg></button>
      <button id="deleteCurrent" class="ct-icon" title="Delete this conversation" aria-label="Delete this conversation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>
      <button id="convNew" class="ct-icon" title="New conversation" aria-label="New conversation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg></button>
      <button id="convRename" class="ct-icon" title="Rename this conversation" aria-label="Rename conversation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
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
          <button type="button" id="historyClose" class="hp-close" title="Close" aria-label="Close history"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <input type="text" id="historyFilter" class="hp-filter" placeholder="Search past conversations…" aria-label="Search past conversations">
        <div id="historyList" class="hp-list"></div>
      </div>
      <div id="menuPanel" class="historypanel menupanel" style="display:none" tabindex="-1" role="menu"></div>
      <button id="jump" type="button" title="Jump to latest" aria-label="Jump to latest"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg></button>
    </div>
    <div id="status" class="status" style="display:none"><span class="feather" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/></svg></span><span id="statusText"></span></div>
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
          <button type="button" class="mp-item" data-mode="ask"><span class="mp-name">Ask before edits</span><span class="mp-desc">You approve each file edit; reads, search, web &amp; screen tools still run automatically</span></button>
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
        <div id="addMenu" class="modepanel addmenu" style="display:none" role="menu">
          <div class="mp-head">Add</div>
          <button type="button" class="add-item" data-add="context" role="menuitem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><span>Add context <span class="add-hint">@ file or symbol</span></span></button>
          <button type="button" class="add-item" data-add="attach" role="menuitem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg><span>Attach files or images</span></button>
          <button type="button" class="add-item" data-add="web" role="menuitem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg><span>Browse the web</span></button>
          <div class="mp-sep"></div>
          <div class="mp-head">Capture</div>
          <button type="button" class="add-item" data-add="shot" role="menuitem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg><span>Screenshot</span></button>
          <button type="button" class="add-item" data-add="rec" role="menuitem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg><span class="add-reclabel">Screen recording</span></button>
          <button type="button" class="add-item" data-add="computer" role="menuitem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 4 7.07 17 2.51-7.39L21 11.07z"/></svg><span>Computer control</span></button>
        </div>
        <textarea id="prompt" placeholder="Ask Parley…  (@file to attach · paste or drop files · Enter to send · Shift+Enter for newline)"></textarea>
        <div class="actions">
          <button type="button" id="addMenuBtn" class="addmenubtn" title="Add — context, files, web, screen…" aria-label="Add" aria-haspopup="true" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
          <span class="micwrap">
            <button type="button" id="mic" title="Voice input (click to record, click again to transcribe)" aria-label="Voice input"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></button>
            <button type="button" id="voiceMode" class="miccaret" title="Voice mode: hands-free conversation (🎤 auto-sends, replies read aloud)" aria-label="Toggle voice mode">▾</button>
          </span>
          <button type="button" id="slashBtn" title="Slash commands" aria-label="Slash commands"><span class="slashkey">/</span></button>
          <button type="button" id="designBtn" title="Design canvas — preview the latest HTML/SVG the model built" aria-label="Design canvas"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg></button>
          <span class="grow"></span>
          <select id="agent" class="model" aria-label="Parley model"></select>
          <button type="button" id="modeBtn" class="modebtn" title="Mode &amp; thinking" aria-label="Mode">Chat ▾</button>
          <button type="button" id="queueMode" class="queuemode" style="display:none" title="How a message sent while Parley is working is handled">⏳ Queue</button>
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
  // Cryptographically random so the CSP nonce can't be predicted.
  return randomBytes(24)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '');
}
