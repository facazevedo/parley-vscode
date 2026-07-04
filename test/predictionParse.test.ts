import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePrediction } from '../src/commands/predictionParse';

test('parsePrediction reads a fenced json block', () => {
  const reply =
    'Here it is:\n```json\n{"find":"case A:","replace":"case A: return 1;","why":"sibling case"}\n```\ndone';
  const p = parsePrediction(reply);
  assert.equal(p?.find, 'case A:');
  assert.equal(p?.replace, 'case A: return 1;');
  assert.equal(p?.why, 'sibling case');
});

test('parsePrediction reads a bare object without a fence', () => {
  const p = parsePrediction('{"none":true}');
  assert.equal(p?.none, true);
});

test('parsePrediction returns undefined for non-JSON', () => {
  assert.equal(parsePrediction('no prediction here'), undefined);
  assert.equal(parsePrediction('```json\nnot json\n```'), undefined);
});
