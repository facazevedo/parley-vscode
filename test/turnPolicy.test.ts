import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTINUE_PROMPT, decideTurnStep, type TurnStepInput } from '../src/parley/turnPolicy';

const base: TurnStepInput = {
  content: 'Working on it.',
  thinkingChars: 0,
  toolActions: 0,
  canAutoContinue: true,
  nudged: false,
  aborted: false,
  sessionTokens: 1000,
  tokenLimit: 0,
  autoSteps: 0,
  maxAutoContinue: 25
};

test('normal narration continues the loop', () => {
  const d = decideTurnStep(base);
  assert.equal(d.kind, 'proceed');
  assert.ok(d.kind === 'proceed' && d.next.kind === 'continue' && d.next.continuation === CONTINUE_PROMPT);
});

test('<DONE> stops and is stripped from the rendered text', () => {
  const d = decideTurnStep({ ...base, content: 'All finished.\n<DONE>' });
  assert.ok(d.kind === 'proceed' && d.next.kind === 'stop');
  assert.ok(d.kind === 'proceed' && d.cleaned === 'All finished.');
});

test('thinking-only steps are progress, not stalls (the v0.42 bug)', () => {
  const d = decideTurnStep({ ...base, content: '', thinkingChars: 500 });
  assert.equal(d.kind, 'proceed');
  assert.ok(d.kind === 'proceed' && d.thinkingOnly && !d.hadNarration);
  assert.ok(d.kind === 'proceed' && d.next.kind === 'continue');
});

test('tool-only steps are progress with no narration', () => {
  const d = decideTurnStep({ ...base, content: '', toolActions: 3 });
  assert.ok(d.kind === 'proceed' && !d.hadNarration && !d.thinkingOnly);
});

test('a truly empty step nudges exactly once, then stalls', () => {
  const first = decideTurnStep({ ...base, content: '' });
  assert.equal(first.kind, 'nudge');
  const second = decideTurnStep({ ...base, content: '', nudged: true });
  assert.equal(second.kind, 'stall');
  assert.ok(second.kind === 'stall' && second.note.includes('empty response'));
});

test('empty step without auto-continue stalls quietly (no nudge)', () => {
  const d = decideTurnStep({ ...base, content: '', canAutoContinue: false });
  assert.equal(d.kind, 'stall');
  assert.ok(d.kind === 'stall' && d.note.startsWith('_('));
});

test('abort stops the loop even mid-progress', () => {
  const d = decideTurnStep({ ...base, aborted: true });
  assert.ok(d.kind === 'proceed' && d.next.kind === 'stop');
});

test('token limit pauses with an explanatory note', () => {
  const d = decideTurnStep({ ...base, sessionTokens: 50000, tokenLimit: 40000 });
  assert.ok(d.kind === 'proceed' && d.next.kind === 'stop-token-limit');
  assert.ok(d.kind === 'proceed' && d.next.kind === 'stop-token-limit' && d.next.note.includes('50,000'));
});

test('max auto-continue pauses instead of running away', () => {
  const d = decideTurnStep({ ...base, autoSteps: 25, maxAutoContinue: 25 });
  assert.ok(d.kind === 'proceed' && d.next.kind === 'stop-max-auto');
});

test('done wins over limits (a finished task never shows a limit note)', () => {
  const d = decideTurnStep({ ...base, content: 'Done. <DONE>', sessionTokens: 99999, tokenLimit: 1 });
  assert.ok(d.kind === 'proceed' && d.next.kind === 'stop');
});
