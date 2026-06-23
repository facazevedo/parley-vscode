import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeDdgUrl } from '../src/web/webSearch';

test('decodeDdgUrl decodes a DuckDuckGo redirect link', () => {
  assert.equal(
    decodeDdgUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fa%3D1&rut=x'),
    'https://example.com/docs?a=1'
  );
});

test('decodeDdgUrl passes through a normal URL and fixes protocol-relative', () => {
  assert.equal(decodeDdgUrl('https://example.com/page'), 'https://example.com/page');
  assert.equal(decodeDdgUrl('//cdn.example.com/x'), 'https://cdn.example.com/x');
});
