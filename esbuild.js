// Bundles the extension into a single CommonJS file for distribution.
//
// Why: VS Code loads `main` (dist/extension.js) at runtime. Bundling collapses the
// ~60 source modules into one minified file and lets us ship a tiny, platform-agnostic
// VSIX with no node_modules. The only optional runtime dependency (@xenova/transformers,
// used by the opt-in local semantic @codebase index) is marked external and lazily
// installed into global storage on first use — see src/codebase/embeddingIndex.ts.
//
// A second bundle builds the chat webview (media/chat.js + markdown-it + highlight.js
// → dist/webview.js), which the webview loads with a nonce.
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    // `vscode` is provided by the host; transformers.js is installed on demand at runtime.
    external: ['vscode', '@xenova/transformers'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info'
  });

  const webviewCtx = await esbuild.context({
    entryPoints: ['media/chat.js'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outfile: 'dist/webview.js',
    sourcemap: !production,
    minify: production,
    logLevel: 'info'
  });

  if (watch) {
    await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  } else {
    await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
    await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
