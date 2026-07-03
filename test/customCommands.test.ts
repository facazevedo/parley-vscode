import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';

// customCommands.ts imports vscode (for its directory scanner); stub it so the
// pure expansion/parsing helpers can be imported and tested (same trick as
// outputStyles.test.ts).
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
const commands = require('../src/config/customCommands') as typeof import('../src/config/customCommands');
// eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the vscode stub is installed
const styles = require('../src/config/outputStyles') as typeof import('../src/config/outputStyles');
const { expandCommandBody } = commands;
const { parseFrontmatter } = styles;

test('$ARGS is replaced everywhere it appears', () => {
  assert.equal(expandCommandBody('do $ARGS and $ARGS', 'x', ''), 'do x and x');
});

test('without $ARGS, args are appended after a blank line', () => {
  assert.equal(expandCommandBody('fixed body', 'extra', ''), 'fixed body\n\nextra');
});

test('without $ARGS and without args, the body is unchanged', () => {
  assert.equal(expandCommandBody('fixed body', '', ''), 'fixed body');
});

test('$SELECTION is replaced with the selected text', () => {
  assert.equal(expandCommandBody('review:\n$SELECTION', '', 'const a = 1;'), 'review:\nconst a = 1;');
});

test('empty selection expands $SELECTION to nothing', () => {
  assert.equal(expandCommandBody('review: $SELECTION!', '', ''), 'review: !');
});

test('args containing the literal $SELECTION are not double-expanded', () => {
  // $SELECTION expands first; an $ARGS value mentioning it stays literal.
  assert.equal(expandCommandBody('run $ARGS on $SELECTION', 'echo $SELECTION', 'sel'), 'run echo $SELECTION on sel');
});

test('frontmatter description is extracted and stripped from the body', () => {
  const raw = '---\ndescription: Say hi politely\n---\nSay hello to $ARGS.';
  const { description, body } = parseFrontmatter(raw);
  assert.equal(description, 'Say hi politely');
  assert.equal(body, 'Say hello to $ARGS.');
});

test('frontmatter with CRLF line endings parses', () => {
  const raw = '---\r\ndescription: "Quoted desc"\r\n---\r\nBody here.';
  const { description, body } = parseFrontmatter(raw);
  assert.equal(description, 'Quoted desc');
  assert.equal(body, 'Body here.');
});

test('no frontmatter means empty description and full body', () => {
  const { description, body } = parseFrontmatter('Just a prompt.');
  assert.equal(description, '');
  assert.equal(body, 'Just a prompt.');
});
