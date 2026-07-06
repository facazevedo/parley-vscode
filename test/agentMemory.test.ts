import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'path';
import {
  collectAgentMemory,
  expandTilde,
  extractImports,
  GEMINI_MEMORY,
  type FileReader
} from '../src/context/agentMemory';

test('extractImports finds imports, dedupes, preserves order', () => {
  assert.deepEqual(extractImports('See @docs/a.md and @docs/b.md, and @docs/a.md again.'), ['docs/a.md', 'docs/b.md']);
});

test('extractImports skips fenced code blocks and inline code spans', () => {
  const md = ['Use @real.md here.', '```', '@fenced.md ignored', '```', 'Inline `@span.md` ignored too.'].join('\n');
  assert.deepEqual(extractImports(md), ['real.md']);
});

test('extractImports ignores escaped \\@ and email-like tokens (no leading space)', () => {
  assert.deepEqual(extractImports('email me@example.com, not \\@escaped.md, but @keep.md'), ['keep.md']);
});

test('expandTilde expands ~ and ~/... only', () => {
  const home = path.join(path.resolve('/'), 'home', 'me');
  assert.equal(expandTilde('~', home), home);
  assert.equal(expandTilde('~/foo/bar.md', home), path.join(home, 'foo', 'bar.md'));
  assert.equal(expandTilde('foo/bar.md', home), 'foo/bar.md');
});

// ---- collectAgentMemory (reader-injected, no real fs) ----

const BASE = path.join(path.resolve('/'), 'pvsc-fake');
const HOME = path.join(BASE, 'home', 'me');
const ROOT = path.join(HOME, 'proj');

function key(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

function makeReader(files: Record<string, string>): FileReader {
  const map = new Map<string, string>();
  for (const [p, c] of Object.entries(files)) {
    map.set(key(p), c);
  }
  return async (absPath) => map.get(key(absPath));
}

test('collectAgentMemory orders global -> hierarchy -> subtree', async () => {
  const read = makeReader({
    [path.join(HOME, '.claude', 'CLAUDE.md')]: 'GLOBAL',
    [path.join(HOME, 'CLAUDE.md')]: 'HOME',
    [path.join(ROOT, 'CLAUDE.md')]: 'ROOT',
    [path.join(ROOT, 'pkg', 'CLAUDE.md')]: 'PKG',
    [path.join(ROOT, 'pkg', 'app', 'CLAUDE.md')]: 'APP'
  });
  const out =
    (await collectAgentMemory({
      workspaceFolders: [ROOT],
      activeFile: path.join(ROOT, 'pkg', 'app', 'index.ts'),
      home: HOME,
      read
    })) ?? '';
  const order = ['GLOBAL', 'HOME', 'ROOT', 'PKG', 'APP'].map((m) => out.indexOf(m));
  assert.ok(
    order.every((i) => i >= 0),
    `all sections present: ${JSON.stringify(order)}`
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    'sections in general->specific order'
  );
});

test('collectAgentMemory inlines @imports relative to the importing file', async () => {
  const read = makeReader({
    [path.join(ROOT, 'CLAUDE.md')]: 'ROOT rules\n@./docs/extra.md',
    [path.join(ROOT, 'docs', 'extra.md')]: 'EXTRA CONTENT'
  });
  const out = (await collectAgentMemory({ workspaceFolders: [ROOT], home: HOME, read })) ?? '';
  assert.ok(out.includes('ROOT rules'));
  assert.ok(out.includes('EXTRA CONTENT'), 'imported file inlined');
});

test('collectAgentMemory is cycle-safe', async () => {
  const read = makeReader({
    [path.join(ROOT, 'CLAUDE.md')]: 'A start @./b.md',
    [path.join(ROOT, 'b.md')]: 'B start @./CLAUDE.md'
  });
  const out = (await collectAgentMemory({ workspaceFolders: [ROOT], home: HOME, read })) ?? '';
  assert.ok(out.includes('A start'));
  assert.ok(out.includes('B start'));
  // 'A start' inlined once (the cycle back to CLAUDE.md is not re-expanded).
  assert.equal(out.split('A start').length - 1, 1);
});

test('collectAgentMemory stops import recursion past the depth limit', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i <= 7; i += 1) {
    files[path.join(ROOT, `f${i}.md`)] = `MARK${i} @./f${i + 1}.md`;
  }
  files[path.join(ROOT, 'CLAUDE.md')] = 'TOP @./f0.md';
  const read = makeReader(files);
  const out = (await collectAgentMemory({ workspaceFolders: [ROOT], home: HOME, read })) ?? '';
  assert.ok(out.includes('MARK4'), 'files within depth are inlined');
  assert.ok(!out.includes('MARK6'), 'files past the depth limit are not inlined');
});

test('collectAgentMemory returns undefined when nothing is found', async () => {
  const out = await collectAgentMemory({ workspaceFolders: [ROOT], home: HOME, read: async () => undefined });
  assert.equal(out, undefined);
});

test('collectAgentMemory loads GEMINI.md (Gemini CLI) alongside CLAUDE.md by default', async () => {
  const read = makeReader({
    [path.join(HOME, '.claude', 'CLAUDE.md')]: 'CLAUDE GLOBAL',
    [path.join(ROOT, 'CLAUDE.md')]: 'CLAUDE ROOT',
    [path.join(HOME, '.gemini', 'GEMINI.md')]: 'GEMINI GLOBAL',
    [path.join(ROOT, 'GEMINI.md')]: 'GEMINI ROOT'
  });
  const out = (await collectAgentMemory({ workspaceFolders: [ROOT], home: HOME, read })) ?? '';
  for (const marker of ['CLAUDE GLOBAL', 'CLAUDE ROOT', 'GEMINI GLOBAL', 'GEMINI ROOT']) {
    assert.ok(out.includes(marker), `${marker} present`);
  }
});

test('collectAgentMemory honors a single spec (GEMINI.md only)', async () => {
  const read = makeReader({
    [path.join(ROOT, 'CLAUDE.md')]: 'CLAUDE ROOT',
    [path.join(HOME, '.gemini', 'GEMINI.md')]: 'GEMINI GLOBAL',
    [path.join(ROOT, 'GEMINI.md')]: 'GEMINI ROOT'
  });
  const out = (await collectAgentMemory({ workspaceFolders: [ROOT], home: HOME, read }, [GEMINI_MEMORY])) ?? '';
  assert.ok(out.includes('GEMINI GLOBAL') && out.includes('GEMINI ROOT'));
  assert.ok(!out.includes('CLAUDE ROOT'), 'CLAUDE.md not read when only the Gemini spec is requested');
});
