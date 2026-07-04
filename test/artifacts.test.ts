import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectArtifacts, buildArtifactDocument, needsTailwind } from '../src/artifacts/artifacts';

test('detects an html artifact and titles it', () => {
  const a = detectArtifacts('Here you go:\n```html title="Landing"\n<h1>Hi</h1>\n```');
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'html');
  assert.equal(a[0].title, 'Landing');
  assert.match(a[0].code, /<h1>Hi<\/h1>/);
});

test('detects svg from a labelled fence and from a bare <svg> in an xml/blank fence', () => {
  const labelled = detectArtifacts('```svg\n<svg viewBox="0 0 1 1"></svg>\n```');
  assert.equal(labelled[0].kind, 'svg');
  const bare = detectArtifacts('```\n<svg width="10" height="10"><rect/></svg>\n```');
  assert.equal(bare[0].kind, 'svg');
});

test('detects jsx/tsx/react as react artifacts', () => {
  for (const lang of ['jsx', 'tsx', 'react']) {
    const a = detectArtifacts('```' + lang + '\nfunction App(){return <div/>;}\n```');
    assert.equal(a[0].kind, 'react', lang);
  }
});

test('an unlabelled full HTML document is detected', () => {
  const a = detectArtifacts('```\n<!doctype html><html><body>x</body></html>\n```');
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'html');
});

test('plain js/css/text fences are not artifacts', () => {
  assert.equal(detectArtifacts('```js\nconsole.log(1)\n```').length, 0);
  assert.equal(detectArtifacts('```css\n.a{color:red}\n```').length, 0);
  assert.equal(detectArtifacts('```\njust prose in a block\n```').length, 0);
});

test('multiple artifacts in one message are all found, in order', () => {
  const a = detectArtifacts('```html\n<a/>\n```\nand\n```svg\n<svg/>\n```');
  assert.deepEqual(
    a.map((x) => x.kind),
    ['html', 'svg']
  );
});

test('identical code yields a stable id (dedupe across re-emits)', () => {
  const one = detectArtifacts('```html\n<h1>Same</h1>\n```')[0];
  const two = detectArtifacts('```html\n<h1>Same</h1>\n```')[0];
  assert.equal(one.id, two.id);
});

test('buildArtifactDocument wraps a bare HTML fragment into a full document', () => {
  const doc = buildArtifactDocument({ id: 'x', title: 't', kind: 'html', code: '<h1>Hi</h1>', lang: 'html' });
  assert.match(doc, /<!doctype html>/i);
  assert.match(doc, /<h1>Hi<\/h1>/);
});

test('buildArtifactDocument leaves a full HTML document intact (no double-wrap)', () => {
  const full = '<!doctype html><html><head></head><body>x</body></html>';
  const doc = buildArtifactDocument({ id: 'x', title: 't', kind: 'html', code: full, lang: 'html' });
  assert.equal((doc.match(/<!doctype html>/gi) || []).length, 1);
});

test('buildArtifactDocument centers an SVG', () => {
  const doc = buildArtifactDocument({ id: 'x', title: 't', kind: 'svg', code: '<svg/>', lang: 'svg' });
  assert.match(doc, /place-items:\s*center/);
  assert.match(doc, /<svg\/>/);
});

test('buildArtifactDocument inlines the React/Babel runtime for react artifacts', () => {
  const doc = buildArtifactDocument(
    { id: 'x', title: 't', kind: 'react', code: 'function App(){return <div/>;}', lang: 'jsx' },
    { react: 'REACT_LIB', reactDom: 'REACTDOM_LIB', babel: 'BABEL_LIB' }
  );
  assert.match(doc, /<script>REACT_LIB<\/script>/);
  assert.match(doc, /<script>BABEL_LIB<\/script>/);
  assert.match(doc, /text\/babel/);
  assert.match(doc, /id="root"/);
});

test('inlined runtime with a literal </script> is escaped so it cannot close the tag early', () => {
  const doc = buildArtifactDocument({ id: 'x', title: 't', kind: 'react', code: 'x', lang: 'jsx' }, {
    react: 'a</script>b'
  });
  assert.ok(!doc.includes('a</script>b'), 'the raw </script> must not survive');
  assert.match(doc, /a<\\\/script>b/);
});

test('tailwind runtime is inlined into an existing document head when provided', () => {
  const full = '<!doctype html><html><head><title>t</title></head><body>x</body></html>';
  const doc = buildArtifactDocument(
    { id: 'x', title: 't', kind: 'html', code: full, lang: 'html' },
    { tailwind: 'TAILWIND_LIB' }
  );
  assert.match(doc, /<script>TAILWIND_LIB<\/script>/);
});

test('needsTailwind detects utility classes and ignores plain markup', () => {
  assert.equal(needsTailwind('<div class="flex items-center gap-4">'), true);
  assert.equal(needsTailwind('<div className="bg-slate-900 rounded-lg p-6">'), true);
  assert.equal(needsTailwind('<div class="my-custom-thing">plain</div>'), false);
  assert.equal(needsTailwind('<section><h1>Hello</h1></section>'), false);
});
