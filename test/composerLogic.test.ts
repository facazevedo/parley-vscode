import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextSummary, mapReviewKey } from '../src/webview/composerLogic';

test('contextSummary lists the active toggles in order', () => {
  assert.equal(contextSummary({ includeSelection: true, includeDiagnostics: true }), ' — Selection, Diagnostics');
  assert.equal(
    contextSummary({
      includeSelection: true,
      includeCurrentFile: true,
      includeOpenEditors: true,
      includeDiagnostics: true
    }),
    ' — Selection, File, Open editors, Diagnostics'
  );
});

test('contextSummary says "none" when nothing is on', () => {
  assert.equal(contextSummary({}), ' — none');
  assert.equal(contextSummary({ includeSelection: false }), ' — none');
});

test('mapReviewKey: Ctrl/Cmd+Enter applies, +Shift applies all', () => {
  assert.deepEqual(mapReviewKey({ key: 'Enter', ctrlKey: true }), { applying: true, all: false });
  assert.deepEqual(mapReviewKey({ key: 'Enter', metaKey: true }), { applying: true, all: false });
  assert.deepEqual(mapReviewKey({ key: 'Enter', ctrlKey: true, shiftKey: true }), { applying: true, all: true });
});

test('mapReviewKey: Ctrl/Cmd+Backspace rejects, +Shift rejects all', () => {
  assert.deepEqual(mapReviewKey({ key: 'Backspace', metaKey: true }), { applying: false, all: false });
  assert.deepEqual(mapReviewKey({ key: 'Backspace', ctrlKey: true, shiftKey: true }), { applying: false, all: true });
});

test('mapReviewKey: ignores non-shortcut keys (incl. plain Enter, which sends)', () => {
  assert.equal(mapReviewKey({ key: 'Enter' }), null); // plain Enter = send, not review
  assert.equal(mapReviewKey({ key: 'Backspace' }), null);
  assert.equal(mapReviewKey({ key: 'a', ctrlKey: true }), null);
  assert.equal(mapReviewKey({ key: 'Escape', ctrlKey: true }), null);
});
