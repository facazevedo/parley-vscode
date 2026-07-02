import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fuzzyScore, rankMentionPaths } from '../src/context/fuzzyScore';

test('fuzzyScore matches subsequences case-insensitively and rejects non-matches', () => {
  assert.ok(fuzzyScore('chpanel', 'src/webview/ChatPanel.ts') !== undefined);
  assert.ok(fuzzyScore('CHAT', 'media/chat.js') !== undefined);
  assert.equal(fuzzyScore('zzz', 'media/chat.js'), undefined);
  assert.equal(fuzzyScore('chatx', 'media/chat.js'), undefined); // 'x' breaks the subsequence
  assert.equal(fuzzyScore('longerthanpath', 'a.ts'), undefined);
  assert.equal(fuzzyScore('', 'anything.ts'), 0); // empty query matches everything
});

test('fuzzyScore prefers basename hits and boundary-aligned matches', () => {
  // Whole query inside the basename beats a match spread across directories.
  const inBase = fuzzyScore('chat.js', 'media/chat.js')!;
  const spread = fuzzyScore('chat.js', 'src/chatty/util/pj.se.ts');
  assert.ok(spread === undefined || inBase > spread);
  // Boundary-aligned initials beat interior matches.
  const initials = fuzzyScore('cp', 'src/ChatPanel.ts')!;
  const interior = fuzzyScore('cp', 'src/scripts.ts')!;
  assert.ok(initials > interior);
});

test('fuzzyScore breaks ties toward shorter paths', () => {
  const short = fuzzyScore('app', 'src/app.ts')!;
  const long = fuzzyScore('app', 'src/nested/deeper/app.ts')!;
  assert.ok(short > long);
});

test('rankMentionPaths ranks fuzzy matches best-first and respects the limit', () => {
  const paths = ['src/webview/ChatPanel.ts', 'media/chat.js', 'src/parley/parsing.ts', 'README.md'];
  const ranked = rankMentionPaths('chpanel', paths);
  assert.deepEqual(ranked, ['src/webview/ChatPanel.ts']);
  const capped = rankMentionPaths('s', paths, { limit: 2 });
  assert.equal(capped.length, 2);
});

test('rankMentionPaths with an empty query lists boosted (open) paths first, then shortest', () => {
  const paths = ['deep/nested/very/long/file.ts', 'a.ts', 'src/open.ts'];
  const ranked = rankMentionPaths('', paths, { boost: new Set(['src/open.ts']) });
  assert.deepEqual(ranked, ['src/open.ts', 'a.ts', 'deep/nested/very/long/file.ts']);
});

test('rankMentionPaths boosts open files on close scores', () => {
  const paths = ['src/util/config.ts', 'src/util/confib.ts'];
  const ranked = rankMentionPaths('confi', paths, { boost: new Set(['src/util/confib.ts']) });
  assert.equal(ranked[0], 'src/util/confib.ts');
});
