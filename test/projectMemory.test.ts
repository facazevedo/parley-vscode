import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';

// projectMemory.ts imports vscode (fs/uri); stub it so the pure append logic can
// be imported and tested (same trick as outputStyles.test.ts).
function makeVscodeStub(): unknown {
  const handler: ProxyHandler<() => unknown> = {
    get: (_t, prop) => (prop === Symbol.toPrimitive || prop === 'then' ? undefined : stub),
    apply: () => stub,
    construct: () => ({})
  };
  const stub: unknown = new Proxy(function noop() {}, handler);
  return stub;
}
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]): unknown {
  return request === 'vscode' ? makeVscodeStub() : originalLoad.apply(this, [request, ...rest] as never);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the vscode stub is installed
const mem = require('../src/context/projectMemory') as typeof import('../src/context/projectMemory');
const { appendFact, MEMORY_HEADER, MAX_MEMORY_ENTRIES } = mem;

test('first fact creates the file with the header', () => {
  const out = appendFact('', 'tests need FOO=1');
  assert.ok(out);
  assert.ok(out.startsWith('# Parley project memory'));
  assert.match(out, /\n- tests need FOO=1\n$/);
});

test('facts append below existing entries', () => {
  const first = appendFact('', 'fact one');
  assert.ok(first);
  const second = appendFact(first, 'fact two');
  assert.ok(second);
  const idx1 = second.indexOf('- fact one');
  const idx2 = second.indexOf('- fact two');
  assert.ok(idx1 >= 0 && idx2 > idx1, 'second fact goes after the first');
});

test('exact duplicates (case-insensitive) are rejected', () => {
  const first = appendFact('', 'Tests need Docker running');
  assert.ok(first);
  assert.equal(appendFact(first, 'tests need docker running'), undefined);
});

test('blank facts are rejected; whitespace is collapsed', () => {
  assert.equal(appendFact('', '   '), undefined);
  const out = appendFact('', 'a\n  multi   line\tfact');
  assert.ok(out);
  assert.match(out, /- a multi line fact/);
});

test('entry cap drops the oldest facts', () => {
  let content = MEMORY_HEADER;
  for (let i = 0; i < MAX_MEMORY_ENTRIES + 5; i += 1) {
    const next = appendFact(content, `fact number ${i}`);
    assert.ok(next);
    content = next;
  }
  const entries = content.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(entries.length, MAX_MEMORY_ENTRIES);
  assert.doesNotMatch(content, /- fact number 0\n/);
  assert.match(content, new RegExp(`- fact number ${MAX_MEMORY_ENTRIES + 4}`));
});

test('user prose lines in the file are preserved as header content', () => {
  const custom = '# Parley project memory\n\nMy own notes here.\n\n- existing fact\n';
  const out = appendFact(custom, 'new fact');
  assert.ok(out);
  assert.match(out, /My own notes here\./);
  assert.match(out, /- existing fact\n- new fact/);
});
