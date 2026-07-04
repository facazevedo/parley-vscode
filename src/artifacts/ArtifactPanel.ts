import * as vscode from 'vscode';
import * as fs from 'fs';
import { Artifact, RuntimeCode, buildArtifactDocument, needsTailwind } from './artifacts';

/**
 * "Parley Preview" — a live design canvas beside the chat (Artifacts-style). Renders the
 * model's HTML/SVG/React artifacts in a sandboxed <iframe> loaded from a `data:` document,
 * so the artifact's own scripts/styles run in an isolated origin without inheriting the
 * panel's CSP. Keeps a version history (each re-emit is a new version) and lets you
 * open the source or export it. Model-agnostic — it renders whatever code was produced.
 */
export class ArtifactPanel {
  private static current: ArtifactPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private versions: Artifact[] = [];
  private activeIndex = -1;
  private readonly disposables: vscode.Disposable[] = [];

  public static show(extensionUri: vscode.Uri, artifacts: Artifact[]): void {
    if (artifacts.length === 0) {
      return;
    }
    if (!ArtifactPanel.current) {
      ArtifactPanel.current = new ArtifactPanel(extensionUri);
    }
    ArtifactPanel.current.add(artifacts);
    ArtifactPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  private constructor(private readonly extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      'parleyArtifact',
      'Parley Preview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
    );
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
    this.render();
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

  /** Runtime to inline for this artifact: React+Babel for react, Tailwind when the code uses it. */
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

  private render(): void {
    const a = this.versions[this.activeIndex];
    if (!a) {
      return;
    }
    this.panel.title = `Preview · ${a.title}`;
    this.panel.webview.html = this.shell(buildArtifactDocument(a, this.runtimeFor(a)));
  }

  private shell(doc: string): string {
    const w = this.panel.webview;
    const nonce = `${Date.now()}${Math.random().toString(36).slice(2)}`;
    const b64 = Buffer.from(doc, 'utf8').toString('base64');
    const csp =
      `default-src 'none'; frame-src data:; img-src ${w.cspSource} data: https:; ` +
      `style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${w.cspSource};`;
    const options = this.versions
      .map(
        (v, i) =>
          `<option value="${i}"${i === this.activeIndex ? ' selected' : ''}>${esc(v.title)} · v${i + 1}</option>`
      )
      .join('');
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html,body{margin:0;height:100%;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:12px system-ui,-apple-system,Segoe UI,sans-serif}
  body{display:flex;flex-direction:column}
  .bar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.3))}
  .bar .grow{flex:1}
  .bar select,.bar button{font:inherit;color:var(--vscode-foreground);background:var(--vscode-button-secondaryBackground,transparent);border:1px solid var(--vscode-input-border,rgba(127,127,127,.35));border-radius:5px;padding:3px 8px;cursor:pointer}
  .bar button:hover{background:var(--vscode-toolbar-hoverBackground,rgba(127,127,127,.2))}
  .bar .icon{padding:3px 7px}
  iframe{flex:1;border:0;width:100%;background:#fff}
</style></head><body>
  <div class="bar">
    <button class="icon" id="prev" title="Previous version">◀</button>
    <button class="icon" id="next" title="Next version">▶</button>
    <select id="ver" title="Version history">${options}</select>
    <span class="grow"></span>
    <button class="icon" id="refresh" title="Reload preview">⟳</button>
    <button id="code" title="Open the source in an editor">Open code</button>
    <button id="export" title="Save the artifact to a file">Export</button>
  </div>
  <iframe sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock"
          src="data:text/html;charset=utf-8;base64,${b64}"></iframe>
  <script nonce="${nonce}">
    const vs = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    $('ver').addEventListener('change', (e) => vs.postMessage({ type: 'nav', index: +e.target.value }));
    $('prev').addEventListener('click', () => vs.postMessage({ type: 'step', delta: -1 }));
    $('next').addEventListener('click', () => vs.postMessage({ type: 'step', delta: 1 }));
    $('refresh').addEventListener('click', () => vs.postMessage({ type: 'refresh' }));
    $('code').addEventListener('click', () => vs.postMessage({ type: 'code' }));
    $('export').addEventListener('click', () => vs.postMessage({ type: 'export' }));
  </script>
</body></html>`;
  }

  private async onMessage(m: { type?: string; index?: number; delta?: number }): Promise<void> {
    if (m.type === 'nav' && typeof m.index === 'number') {
      this.activeIndex = clamp(m.index, 0, this.versions.length - 1);
      this.render();
    } else if (m.type === 'step') {
      this.activeIndex = clamp(this.activeIndex + (m.delta ?? 0), 0, this.versions.length - 1);
      this.render();
    } else if (m.type === 'refresh') {
      this.render();
    } else if (m.type === 'code') {
      await this.openCode();
    } else if (m.type === 'export') {
      await this.exportArtifact();
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

  private dispose(): void {
    ArtifactPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c);
}
