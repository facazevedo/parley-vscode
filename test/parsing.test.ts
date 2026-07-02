import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanCompletion,
  extractMentionPaths,
  isContextLengthError,
  parseMentionRange,
  parseUsage
} from '../src/parley/parsing';

test('parseUsage reads OpenAI-style usage and computes total when missing', () => {
  assert.deepEqual(parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), {
    prompt: 10,
    completion: 5,
    total: 15
  });
  assert.deepEqual(parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
    prompt: 10,
    completion: 5,
    total: 15
  });
  assert.equal(parseUsage({}), undefined);
  assert.equal(parseUsage({ usage: {} }), undefined);
  assert.equal(parseUsage(null), undefined);
});

test('cleanCompletion strips a single wrapping code fence and trailing whitespace', () => {
  assert.equal(cleanCompletion('```js\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(cleanCompletion('```\nplain\n```\n'), 'plain');
  assert.equal(cleanCompletion('no fences here  \n'), 'no fences here');
  // A fenced block in the middle is not a wrapper, so it is left intact.
  assert.ok(cleanCompletion('before\n```\nx\n```\nafter').includes('```'));
});

test('extractMentionPaths finds unique @paths and trims trailing punctuation', () => {
  assert.deepEqual(extractMentionPaths('look at @src/app.ts and @README.md.'), ['src/app.ts', 'README.md']);
  assert.deepEqual(extractMentionPaths('dedupe @a.ts @a.ts'), ['a.ts']);
  assert.deepEqual(extractMentionPaths('no mentions here'), []);
  // An email like a@b.com has no whitespace before '@', so it is NOT treated as a mention.
  assert.deepEqual(extractMentionPaths('email a@b.com should not over-match'), []);
});

test('extractMentionPaths keeps #line-range suffixes intact', () => {
  assert.deepEqual(extractMentionPaths('see @src/app.ts#5-10 please'), ['src/app.ts#5-10']);
  assert.deepEqual(extractMentionPaths('and @a.ts#12,'), ['a.ts#12']);
});

test('parseMentionRange splits path and 1-based inclusive line ranges', () => {
  assert.deepEqual(parseMentionRange('src/app.ts'), { path: 'src/app.ts' });
  assert.deepEqual(parseMentionRange('src/app.ts#5-10'), { path: 'src/app.ts', startLine: 5, endLine: 10 });
  assert.deepEqual(parseMentionRange('src/app.ts#12'), { path: 'src/app.ts', startLine: 12, endLine: 12 });
  assert.deepEqual(parseMentionRange('src/app.ts#L3-L7'), { path: 'src/app.ts', startLine: 3, endLine: 7 });
  // A reversed range is normalized instead of producing an empty slice.
  assert.deepEqual(parseMentionRange('a.ts#9-2'), { path: 'a.ts', startLine: 9, endLine: 9 });
  // Zero clamps to line 1.
  assert.deepEqual(parseMentionRange('a.ts#0-3'), { path: 'a.ts', startLine: 1, endLine: 3 });
  // No numeric suffix — including '#' inside names — stays a plain path.
  assert.deepEqual(parseMentionRange('notes#draft.md'), { path: 'notes#draft.md' });
});

test('isContextLengthError matches token-limit messages only on relevant statuses', () => {
  assert.equal(isContextLengthError(400, "This model's maximum context length is 8192 tokens"), true);
  assert.equal(isContextLengthError(400, 'please reduce the length of the messages'), true);
  assert.equal(isContextLengthError(400, 'invalid model'), false);
  assert.equal(isContextLengthError(500, 'maximum context length'), false);
});
