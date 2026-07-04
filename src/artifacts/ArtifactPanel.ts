import * as vscode from 'vscode';
import * as fs from 'fs';
import { Artifact, RuntimeCode, buildArtifactDocument, needsTailwind, detectArtifacts } from './artifacts';
import type { ChatMessage, ChatResponse } from '../parley/types';

/** Runs one tool-less streamed completion for the design chat (provided by ChatPanel). */
export type DesignTurn = (
  messages: readonly ChatMessage[],
  systemExtra: string,
  opts: { onToken?: (delta: string) => void; signal?: AbortSignal }
) => Promise<ChatResponse>;

/**
 * "Parley Design" — a live design canvas in the editor area (where code opens). It renders
 * the model's HTML/SVG/React artifacts in a sandboxed data: iframe, keeps a version history,
 * and hosts its OWN chat (separate from the main Parley chat): messages typed here iterate
 * the current artifact via a tool-less streamed turn, and each result becomes a new version.
 *
 * The webview HTML is set once and then driven by postMessage (setDoc / design* events), so
 * a new version updates the preview without wiping the design-chat log.
 */
export class ArtifactPanel {
  private static current: ArtifactPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private versions: Artifact[] = [];
  private activeIndex = -1;
  private readonly disposables: vscode.Disposable[] = [];
  private designHistory: ChatMessage[] = [];
  private designTurn?: DesignTurn;
  private abort?: AbortController;

  public static show(extensionUri: vscode.Uri, artifacts: Artifact[], designTurn?: DesignTurn): void {
    if (artifacts.length === 0) {
      return;
    }
    if (!ArtifactPanel.current) {
      ArtifactPanel.current = new ArtifactPanel(extensionUri);
    }
    if (designTurn) {
      ArtifactPanel.current.designTurn = designTurn; // refresh each open (captures latest model)
    }
    ArtifactPanel.current.add(artifacts);
    ArtifactPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  private constructor(private readonly extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      'parleyArtifact',
      'Parley Design',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
    );
    this.panel.webview.html = this.shell(); // set ONCE; updates go via postMessage
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
  }

  private add(artifacts: Artifact[]): void {
    for (const a of artifacts) {
      const last = this.versions[this.versions.length - 1];
      if (!last || last.id !== a.id) {
        this.versions.push(a);
      }
    }
    this.activeIndex = this.versions.length - 1;
    this.pushDoc();
  }

  // Vendored runtime files (media/artifacts/*.js), read once and cached across renders.
  private static runtimeCache: Record<string, string> = {};
  private readRuntime(name: string): string {
    if (ArtifactPanel.runtimeCache[name] === undefined) {
      try {
        ArtifactPanel.runtimeCache[name] = fs.readFileSync(
          vscode.Uri.joinPath(this.extensionUri, 'media', 'artifacts', name).fsPath,
          'utf8'
        );
      } catch {
        ArtifactPanel.runtimeCache[name] = '';
      }
    }
    return ArtifactPanel.runtimeCache[name];
  }

  private runtimeFor(a: Artifact): RuntimeCode {
    const rt: RuntimeCode = {};
    const wantTailwind = needsTailwind(a.code);
    if (a.kind === 'react') {
      rt.react = this.readRuntime('react.js');
      rt.reactDom = this.readRuntime('react-dom.js');
      rt.babel = this.readRuntime('babel.js');
      if (wantTailwind) {
        rt.tailwind = this.readRuntime('tailwind.js');
      }
    } else if (a.kind === 'html' && wantTailwind) {
      rt.tailwind = this.readRuntime('tailwind.js');
    }
    return rt;
  }

  /** Push the current artifact's rendered doc + version list to the webview (no HTML reset). */
  private pushDoc(): void {
    const a = this.versions[this.activeIndex];
    if (!a) {
      return;
    }
    this.panel.title = `Parley Design · ${a.title}`;
    const doc = buildArtifactDocument(a, this.runtimeFor(a));
    void this.panel.webview.postMessage({
      type: 'setDoc',
      b64: Buffer.from(doc, 'utf8').toString('base64'),
      versions: this.versions.map((v, i) => ({ title: v.title, i })),
      active: this.activeIndex
    });
  }

  private async onMessage(m: { type?: string; index?: number; delta?: number; text?: string }): Promise<void> {
    switch (m.type) {
      case 'designReady':
        this.pushDoc();
        break;
      case 'nav':
        this.activeIndex = clamp(m.index ?? this.activeIndex, 0, this.versions.length - 1);
        this.pushDoc();
        break;
      case 'step':
        this.activeIndex = clamp(this.activeIndex + (m.delta ?? 0), 0, this.versions.length - 1);
        this.pushDoc();
        break;
      case 'refresh':
        this.pushDoc();
        break;
      case 'code':
        await this.openCode();
        break;
      case 'export':
        await this.exportArtifact();
        break;
      case 'designSend':
        await this.runDesign(m.text ?? '');
        break;
      case 'designStop':
        this.abort?.abort();
        break;
    }
  }

  /** One design-chat turn: iterate the active artifact, stream to the webview, add a version. */
  private async runDesign(text: string): Promise<void> {
    const a = this.versions[this.activeIndex];
    if (!text.trim() || !a) {
      return;
    }
    const post = (msg: Record<string, unknown>): void => void this.panel.webview.postMessage(msg);
    if (!this.designTurn) {
      post({ type: 'designUser', text });
      post({ type: 'designDelta', delta: '' });
      post({ type: 'designDone', error: 'Design chat is unavailable — reopen from the chat.' });
      return;
    }
    this.abort = new AbortController();
    post({ type: 'designUser', text });
    post({ type: 'designBusy', busy: true });
    const system =
      `You are iterating on a single ${a.kind} UI artifact shown in a live preview. The current code is:\n\n` +
      '```' +
      `${a.lang}\n${a.code}\n` +
      '```\n\n' +
      `Apply the user's request and reply with the COMPLETE updated artifact in ONE fenced \`\`\`${a.lang} code block ` +
      `— self-contained, no partial diffs, and no prose outside the code block.`;
    const messages: ChatMessage[] = [
      ...this.designHistory,
      { role: 'user', content: text, createdAt: new Date().toISOString() }
    ];
    let streamed = '';
    try {
      const res = await this.designTurn(messages, system, {
        onToken: (d) => {
          streamed += d;
          post({ type: 'designDelta', delta: d });
        },
        signal: this.abort.signal
      });
      const full = res?.message?.content ?? streamed;
      this.designHistory = [
        ...messages,
        { role: 'assistant', content: full, createdAt: new Date().toISOString(), model: res?.message?.model }
      ];
      const found = detectArtifacts(full);
      if (found.length > 0) {
        this.add([found[found.length - 1]]); // new version → pushDoc re-renders the preview
      }
      post({ type: 'designDone', updated: found.length > 0 });
    } catch (error) {
      post({ type: 'designDone', error: error instanceof Error ? error.message : 'design turn failed' });
    } finally {
      this.abort = undefined;
      post({ type: 'designBusy', busy: false });
    }
  }

  private async openCode(): Promise<void> {
    const a = this.versions[this.activeIndex];
    if (!a) {
      return;
    }
    const language = a.kind === 'svg' ? 'xml' : a.kind === 'react' ? 'typescriptreact' : 'html';
    const doc = await vscode.workspace.openTextDocument({ content: a.code, language });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
  }

  private async exportArtifact(): Promise<void> {
    const a = this.versions[this.activeIndex];
    if (!a) {
      return;
    }
    const ext = a.kind === 'svg' ? 'svg' : a.kind === 'react' ? 'jsx' : 'html';
    const safe = a.title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact';
    const uri = await vscode.window.showSaveDialog({
      saveLabel: 'Export artifact',
      defaultUri: vscode.Uri.joinPath(this.extensionUri, `${safe}.${ext}`)
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(a.code, 'utf8'));
    }
  }

  private shell(): string {
    const w = this.panel.webview;
    const nonce = `${Date.now()}${Math.random().toString(36).slice(2)}`;
    const csp =
      `default-src 'none'; frame-src data:; img-src ${w.cspSource} data: https:; ` +
      `style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${w.cspSource} data:;`;
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html,body{margin:0;height:100%;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:12px system-ui,-apple-system,Segoe UI,sans-serif}
  body{display:flex;flex-direction:column}
  .bar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.3));flex:none}
  .bar .grow{flex:1}
  .bar select,.bar button{font:inherit;color:var(--vscode-foreground);background:var(--vscode-button-secondaryBackground,transparent);border:1px solid var(--vscode-input-border,rgba(127,127,127,.35));border-radius:5px;padding:3px 8px;cursor:pointer}
  .bar button:hover{background:var(--vscode-toolbar-hoverBackground,rgba(127,127,127,.2))}
  .bar .icon{padding:3px 7px}
  #frame{flex:1;border:0;width:100%;background:#fff;min-height:0}
  .dc{flex:none;display:flex;flex-direction:column;height:38%;min-height:120px;max-height:60%;border-top:1px solid var(--vscode-panel-border,rgba(127,127,127,.3))}
  .dc-head{font-size:.72em;text-transform:uppercase;letter-spacing:.08em;opacity:.6;padding:6px 10px 2px}
  #dclog{flex:1;overflow:auto;padding:4px 10px;display:flex;flex-direction:column;gap:6px}
  .dc-msg{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.92em;line-height:1.45;max-width:100%}
  .dc-msg.user{align-self:flex-end;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,rgba(127,127,127,.35));border-radius:10px;padding:5px 9px}
  .dc-msg.assistant{align-self:flex-start;color:var(--vscode-descriptionForeground)}
  .dc-in{display:flex;gap:6px;padding:6px 8px;border-top:1px solid var(--vscode-panel-border,rgba(127,127,127,.25))}
  #dcinput{flex:1;resize:none;min-height:34px;max-height:120px;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(127,127,127,.4));border-radius:6px;padding:7px 9px;font:inherit;outline:none}
  #dcsend,#dcstop{font:inherit;border:0;border-radius:6px;padding:0 14px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  #dcsend:hover,#dcstop:hover{background:var(--vscode-button-hoverBackground,var(--vscode-button-background))}
</style></head><body>
  <div class="bar">
    <button class="icon" id="prev" title="Previous version">◀</button>
    <button class="icon" id="next" title="Next version">▶</button>
    <select id="ver" title="Version history"></select>
    <span class="grow"></span>
    <button class="icon" id="refresh" title="Reload preview">⟳</button>
    <button id="code" title="Open the source in an editor">Open code</button>
    <button id="export" title="Save the artifact to a file">Export</button>
  </div>
  <iframe id="frame" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock"></iframe>
  <div class="dc">
    <div class="dc-head">Design chat — iterate this design (separate from the main chat)</div>
    <div id="dclog"></div>
    <div class="dc-in">
      <textarea id="dcinput" rows="1" placeholder="Describe a change… (e.g. make the header bigger, use a dark theme)"></textarea>
      <button id="dcsend">Send</button>
      <button id="dcstop" style="display:none">Stop</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vs = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const frame = $('frame'), ver = $('ver'), log = $('dclog'), input = $('dcinput'), send = $('dcsend'), stop = $('dcstop');
    let cur = null;
    function addMsg(role, text){ const d = document.createElement('div'); d.className = 'dc-msg ' + role; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
    window.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'setDoc'){
        frame.src = 'data:text/html;charset=utf-8;base64,' + m.b64;
        ver.innerHTML = '';
        (m.versions || []).forEach((v) => { const o = document.createElement('option'); o.value = v.i; o.textContent = v.title + ' \\u00b7 v' + (v.i + 1); if (v.i === m.active) o.selected = true; ver.appendChild(o); });
      } else if (m.type === 'designUser'){ addMsg('user', m.text); cur = addMsg('assistant', ''); }
      else if (m.type === 'designDelta'){ if (!cur) cur = addMsg('assistant', ''); cur.textContent += m.delta; log.scrollTop = log.scrollHeight; }
      else if (m.type === 'designDone'){ if (cur){ if (m.error) cur.textContent = '\\u26a0 ' + m.error; else if (m.updated) cur.textContent = '\\u2713 Updated the design'; else if (!cur.textContent) cur.textContent = '(no change)'; cur = null; } }
      else if (m.type === 'designBusy'){ send.style.display = m.busy ? 'none' : ''; stop.style.display = m.busy ? '' : 'none'; }
    });
    function doSend(){ const t = input.value.trim(); if (!t) return; input.value = ''; vs.postMessage({ type: 'designSend', text: t }); }
    send.addEventListener('click', doSend);
    stop.addEventListener('click', () => vs.postMessage({ type: 'designStop' }));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); doSend(); } });
    $('prev').addEventListener('click', () => vs.postMessage({ type: 'step', delta: -1 }));
    $('next').addEventListener('click', () => vs.postMessage({ type: 'step', delta: 1 }));
    ver.addEventListener('change', (e) => vs.postMessage({ type: 'nav', index: +e.target.value }));
    $('refresh').addEventListener('click', () => vs.postMessage({ type: 'refresh' }));
    $('code').addEventListener('click', () => vs.postMessage({ type: 'code' }));
    $('export').addEventListener('click', () => vs.postMessage({ type: 'export' }));
    vs.postMessage({ type: 'designReady' });
  </script>
</body></html>`;
  }

  private dispose(): void {
    ArtifactPanel.current = undefined;
    this.abort?.abort();
    this.disposables.forEach((d) => d.dispose());
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
