import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quoteForCmd } from '../src/util/childProcess';

test('quoteForCmd leaves metacharacter-free tokens bare', () => {
  assert.equal(quoteForCmd('install'), 'install');
  assert.equal(quoteForCmd('@xenova/transformers@2.17.2'), '@xenova/transformers@2.17.2');
  assert.equal(quoteForCmd('--loglevel=error'), '--loglevel=error');
});

test('quoteForCmd wraps tokens containing spaces or cmd metacharacters', () => {
  assert.equal(quoteForCmd('a b'), '"a b"');
  assert.equal(quoteForCmd('x&y'), '"x&y"');
  assert.equal(quoteForCmd('a|b'), '"a|b"');
  assert.equal(quoteForCmd('a>b'), '"a>b"');
  assert.equal(quoteForCmd(''), '""');
});

test('quoteForCmd escapes embedded double quotes', () => {
  // A quote inside the token becomes \" inside the wrapping quotes.
  assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""');
});

test('quoteForCmd doubles trailing backslashes before the closing quote', () => {
  // Trailing backslashes must be doubled so they don't escape the closing quote.
  assert.equal(quoteForCmd('C:\\path with space\\'), '"C:\\path with space\\\\"');
});
