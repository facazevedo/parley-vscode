import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCompletion, extractMentionPaths, isContextLengthError, parseUsage } from '../src/parley/parsing';

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

test('isContextLengthError matches token-limit messages only on relevant statuses', () => {
  assert.equal(isContextLengthError(400, 'This model\'s maximum context length is 8192 tokens'), true);
  assert.equal(isContextLengthError(400, 'please reduce the length of the messages'), true);
  assert.equal(isContextLengthError(400, 'invalid model'), false);
  assert.equal(isContextLengthError(500, 'maximum context length'), false);
});
