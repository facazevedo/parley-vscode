import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lexicalRank, tokenize } from '../src/codebase/lexicalSearch';

test('tokenize drops stopwords and short words, dedupes, lowercases', () => {
  assert.deepEqual(tokenize('How do we RATE limit the the api'), ['rate', 'limit', 'api']);
  assert.deepEqual(tokenize('a an in on'), []);
});

test('lexicalRank ranks by term frequency with a path-match boost', () => {
  const docs = [
    { id: 'a.ts', path: 'src/a.ts', text: 'nothing relevant here' },
    { id: 'rateLimiter.ts', path: 'src/rateLimiter.ts', text: 'export function limit() { /* throttle */ }' },
    { id: 'b.ts', path: 'src/b.ts', text: 'rate rate rate limit limit' }
  ];
  const ranked = lexicalRank('rate limit', docs);
  // rateLimiter.ts wins: its path matches both terms (strong boost), beating raw frequency.
  assert.equal(ranked[0].id, 'rateLimiter.ts');
  assert.ok(ranked.some((r) => r.id === 'b.ts')); // also matches on content
  assert.ok(!ranked.some((r) => r.id === 'a.ts')); // no match, excluded
});

test('lexicalRank returns nothing for an all-stopword query', () => {
  assert.deepEqual(lexicalRank('how do we', [{ id: 'x', path: 'x', text: 'how do we' }]), []);
});
