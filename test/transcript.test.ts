import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  diffRowsToText,
  transcriptToMarkdown,
  transcriptToPlainText,
  type TranscriptEntry,
  type TranscriptMeta
} from '../src/transcript/transcript';

const meta: TranscriptMeta = {
  id: 'parley-1',
  title: 'Improve walk',
  createdAt: '2026-06-23T21:00:00.000Z',
  models: ['openai/gpt-5.5'],
  mode: 'full',
  thinking: 'high',
  speed: 'fast',
  messages: 2,
  sessionTokens: 1234,
  estimatedCostUsd: 0.42
};

const entries: TranscriptEntry[] = [
  { kind: 'user', text: 'improve the walk', at: '2026-06-23T21:00:01.000Z' },
  { kind: 'tool', action: 'Read scripts.py', result: 'Read 120 lines', at: '2026-06-23T21:00:02.000Z' },
  {
    kind: 'fileEdit',
    path: 'src/app.py',
    added: 1,
    removed: 1,
    status: 'applied',
    rows: [
      { kind: 'del', oldNo: 1, text: 'old line' },
      { kind: 'add', newNo: 1, text: 'new line' }
    ],
    at: '2026-06-23T21:00:03.000Z'
  },
  {
    kind: 'plan',
    steps: [
      { text: 'edit', status: 'done' },
      { text: 'test', status: 'pending' }
    ],
    at: '2026-06-23T21:00:04.000Z'
  },
  { kind: 'assistant', text: 'Done improving the gait.', model: 'openai/gpt-5.5', at: '2026-06-23T21:00:05.000Z' },
  { kind: 'note', text: '✏️ Changed 1 file: app.py', at: '2026-06-23T21:00:06.000Z' }
];

test('diffRowsToText renders +/-/context/gap markers', () => {
  const text = diffRowsToText([
    { kind: 'del', oldNo: 1, text: 'a' },
    { kind: 'add', newNo: 1, text: 'b' },
    { kind: 'ctx', oldNo: 2, newNo: 2, text: 'c' },
    { kind: 'gap', text: '' }
  ]);
  assert.match(text, /- a/);
  assert.match(text, /\+ b/);
  assert.match(text, / {2}c/);
  assert.match(text, /⋯/);
});

test('transcriptToMarkdown includes messages, tool activity, diffs, plan, and notes', () => {
  const md = transcriptToMarkdown(meta, entries);
  assert.match(md, /# Parley conversation/);
  assert.match(md, /improve the walk/); // user
  assert.match(md, /⏺ Read scripts\.py/); // tool action
  assert.match(md, /⎿ Read 120 lines/); // tool result
  assert.match(md, /Applied: `src\/app\.py`/); // file edit label
  assert.match(md, /```diff/); // diff block
  assert.match(md, /- old line/);
  assert.match(md, /\+ new line/);
  assert.match(md, /\[x\] edit/); // plan done
  assert.match(md, /\[ \] test/); // plan pending
  assert.match(md, /Done improving the gait\./); // assistant
  assert.match(md, /Changed 1 file/); // note
});

test('transcriptToPlainText includes the same content without markdown fences', () => {
  const txt = transcriptToPlainText(meta, entries);
  assert.match(txt, /Parley conversation/);
  assert.match(txt, /### You/);
  assert.match(txt, /> Read scripts\.py/);
  assert.match(txt, /\[Applied\] src\/app\.py/);
  assert.match(txt, /Done improving the gait\./);
  assert.doesNotMatch(txt, /```/);
});

test('export metadata fields are present in the header', () => {
  const md = transcriptToMarkdown(meta, entries);
  assert.match(md, /Model\(s\):\*\* openai\/gpt-5\.5/);
  assert.match(md, /Mode:\*\* full/);
  assert.match(md, /Estimated cost:\*\* ~\$0\.42/);
});

test('compare entries export to markdown with adopted marker and error flag', () => {
  const compare: TranscriptEntry[] = [
    {
      kind: 'compare',
      id: 'cmp-1',
      prompt: 'explain the tool loop',
      a: { model: 'openai/gpt-5.5', text: 'Answer A' },
      b: { model: 'claude-fable-5', text: 'Answer B' },
      chosen: 'b',
      at: '2026-07-03T10:00:00.000Z'
    },
    {
      kind: 'compare',
      id: 'cmp-2',
      prompt: 'second try',
      a: { model: 'm1', text: 'fine' },
      b: { model: 'm2', text: 'model not found', error: true },
      at: '2026-07-03T10:05:00.000Z'
    }
  ];
  const md = transcriptToMarkdown(meta, compare);
  assert.match(md, /\*\*Model comparison\*\* — _explain the tool loop_/);
  assert.match(md, /### openai\/gpt-5\.5\n/);
  assert.match(md, /### claude-fable-5 ✓ adopted/);
  assert.match(md, /Answer A/);
  assert.match(md, /Answer B/);
  assert.match(md, /⚠ model not found/);
  assert.doesNotMatch(md, /### m1 ✓ adopted/);

  const txt = transcriptToPlainText(meta, compare);
  assert.match(txt, /\[Comparison\] explain the tool loop/);
  assert.match(txt, /--- claude-fable-5 \(adopted\) ---/);
  assert.match(txt, /\(error\) model not found/);
});
