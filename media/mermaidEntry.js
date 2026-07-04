// Separate webview chunk (dist/mermaid.js), loaded on demand the first time a
// ```mermaid diagram appears — so the diagram library (~2.5 MB) never weighs on
// the main chat bundle's load. chat.js injects this with the page nonce and then
// reads window.__parleyMermaid.
import mermaid from 'mermaid';

window.__parleyMermaid = mermaid;
