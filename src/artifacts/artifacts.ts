/**
 * Artifact detection + preview-document assembly for Parley's design canvas ("Artifacts").
 * Pure and dependency-free (no vscode) so it's unit-tested and reused by the preview panel.
 *
 * An artifact is a previewable block the model emitted — a fenced ```html / ```svg /
 * ```jsx|tsx|react block (or a bare <svg>/<!doctype html> document). The preview panel
 * renders `buildArtifactDocument()` inside a sandboxed <iframe srcdoc>. React/Tailwind
 * runtimes are injected by the panel (which has the webview URIs); this module just marks
 * where they go. Model-agnostic: it scans output text, so any model's code previews.
 */

export type ArtifactKind = 'html' | 'svg' | 'react';

export interface Artifact {
  /** Stable-ish id: kind + a short content hash, so re-emitting identical code de-dupes. */
  id: string;
  title: string;
  kind: ArtifactKind;
  code: string;
  lang: string;
}

const LANG_KIND: Record<string, ArtifactKind> = {
  html: 'html',
  htm: 'html',
  svg: 'svg',
  jsx: 'react',
  tsx: 'react',
  react: 'react'
};

/** Small, stable string hash (djb2) for artifact ids — not cryptographic. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function titleFrom(meta: string, kind: ArtifactKind, index: number): string {
  const m = meta.match(/(?:title|name)\s*=\s*"([^"]+)"/i) || meta.match(/(?:title|name)\s*=\s*'([^']+)'/i);
  if (m) {
    return m[1].trim();
  }
  const bare = meta
    .trim()
    .replace(/^[.\w-]*\s*/, '')
    .trim(); // allow ```html My Title
  if (bare) {
    return bare;
  }
  const label = kind === 'react' ? 'Component' : kind === 'svg' ? 'Graphic' : 'Page';
  return index === 0 ? label : `${label} ${index + 1}`;
}

/**
 * Find previewable artifacts in assistant `text`. Fenced blocks whose language maps to a
 * previewable kind become artifacts; a fenced xml/text block that is actually an <svg> is
 * treated as SVG. Plain html/js/css that isn't a standalone document is ignored.
 */
export function detectArtifacts(text: string): Artifact[] {
  if (!text || text.indexOf('```') === -1) {
    return [];
  }
  const out: Artifact[] = [];
  const fence = /```([A-Za-z][\w-]*)?([^\n]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = fence.exec(text)) !== null) {
    const lang = (m[1] || '').toLowerCase();
    const meta = m[2] || '';
    const code = m[3].replace(/\s+$/, '');
    if (!code.trim()) {
      continue;
    }
    let kind = LANG_KIND[lang];
    // A bare <svg> in an xml/markup/unlabelled fence is still an SVG artifact.
    if (!kind && /^\s*<svg[\s>]/i.test(code) && (lang === '' || lang === 'xml' || lang === 'markup')) {
      kind = 'svg';
    }
    // An unlabelled fence that is clearly a full HTML document.
    if (!kind && lang === '' && /^\s*(<!doctype html|<html[\s>])/i.test(code)) {
      kind = 'html';
    }
    if (!kind) {
      continue;
    }
    out.push({ id: `${kind}_${hash(code)}`, title: titleFrom(meta, kind, index), kind, code, lang: lang || kind });
    index += 1;
  }
  return out;
}

/** True when the HTML already declares a full document (so we shouldn't wrap it). */
function isFullDoc(code: string): boolean {
  return /^\s*(<!doctype html|<html[\s>])/i.test(code);
}

/** Runtime library CODE (JS source) inlined into the preview — React kind and Tailwind. */
export interface RuntimeCode {
  react?: string;
  reactDom?: string;
  babel?: string;
  tailwind?: string;
}

/** Inline JS as a <script>, escaping any literal </script> so it can't close the tag early. */
function inlineScript(code?: string): string {
  return code ? `<script>${code.replace(/<\/(script)/gi, '<\\/$1')}</script>` : '';
}

/**
 * Heuristic: does the code use Tailwind utility classes? We only inject Tailwind (and its
 * Preflight reset, which would otherwise restyle plain markup) when it's actually wanted.
 */
export function needsTailwind(code: string): boolean {
  return /\bclass(?:Name)?\s*=\s*["'][^"']*\b(?:flex|grid|hidden|container|(?:m|p)[trblxy]?-\d|gap-\d|(?:w|h|min-w|min-h|max-w|max-h)-|text-(?:xs|sm|base|lg|xl|\d|left|center|right|white|black|gray|slate|zinc)|bg-|border(?:-|\b)|rounded|shadow|items-|justify-|font-(?:bold|semibold|medium|light)|space-[xy]-)/.test(
    code
  );
}

/**
 * Build the full HTML document rendered inside the preview's sandboxed <iframe>. html/svg are
 * self-contained; react artifacts get React + Babel inlined (so JSX/TSX runs in-browser), and
 * Tailwind is inlined for react/html when `runtime.tailwind` is provided.
 */
export function buildArtifactDocument(artifact: Artifact, runtime: RuntimeCode = {}): string {
  const tw = inlineScript(runtime.tailwind);
  const base = '<style>html,body{margin:0}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif}</style>';

  if (artifact.kind === 'svg') {
    return (
      `<!doctype html><html><head><meta charset="utf-8">${base}` +
      `<style>body{display:grid;place-items:center;min-height:100vh;background:#fff}svg{max-width:100vw;max-height:100vh}</style>` +
      `</head><body>${artifact.code}</body></html>`
    );
  }

  if (artifact.kind === 'react') {
    const libs = inlineScript(runtime.react) + inlineScript(runtime.reactDom) + inlineScript(runtime.babel);
    // The component renders into #root; if it didn't render itself, mount a top-level `App`.
    return (
      `<!doctype html><html><head><meta charset="utf-8">${base}${tw}${libs}</head><body>` +
      `<div id="root"></div>` +
      `<script type="text/babel" data-presets="react,typescript">\n${artifact.code}\n` +
      `\n;(function(){try{var el=document.getElementById('root');` +
      `if(el&&!el.childNodes.length&&typeof App!=='undefined'){` +
      `(ReactDOM.createRoot?ReactDOM.createRoot(el).render(React.createElement(App)):ReactDOM.render(React.createElement(App),el));}}catch(e){` +
      `document.body.insertAdjacentHTML('beforeend','<pre style=\\'color:#b00;white-space:pre-wrap;padding:12px\\'>'+ (e&&e.message||e) +'</pre>');}})();` +
      `</script></body></html>`
    );
  }

  // html
  if (isFullDoc(artifact.code)) {
    // Inject Tailwind into an existing document's <head> if requested.
    return tw ? artifact.code.replace(/<head(\s[^>]*)?>/i, (h) => h + tw) : artifact.code;
  }
  return `<!doctype html><html><head><meta charset="utf-8">${base}${tw}</head><body>${artifact.code}</body></html>`;
}
