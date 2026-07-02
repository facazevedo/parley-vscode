import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpretHookRun, runHookEvent, selectHooks, type HooksConfig } from '../src/hooks/hooks';

const config: HooksConfig = {
  PreToolUse: [
    { matcher: 'run_command|write_file', command: 'guard' },
    { command: 'always' },
    { matcher: '[broken', command: 'never' },
    { command: '   ' } as never
  ],
  Stop: [{ command: 'notify' }]
};

test('selectHooks matches by regex, matcher-less hooks fire for every tool', () => {
  const forWrite = selectHooks(config, 'PreToolUse', 'write_file').map((h) => h.command);
  assert.deepEqual(forWrite, ['guard', 'always']);
  const forRead = selectHooks(config, 'PreToolUse', 'read_file').map((h) => h.command);
  assert.deepEqual(forRead, ['always']);
  assert.deepEqual(selectHooks(config, 'PostToolUse', 'write_file'), []);
  assert.deepEqual(selectHooks(undefined, 'PreToolUse', 'x'), []);
});

test('exit 2 blocks PreToolUse/UserPromptSubmit with the stderr as the reason', () => {
  const base = { blocked: false } as const;
  const blocked = interpretHookRun('PreToolUse', { exitCode: 2, stdout: '', stderr: 'no writes on Fridays' }, base);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.feedback, 'no writes on Fridays');
  const prompt = interpretHookRun('UserPromptSubmit', { exitCode: 2, stdout: 'via stdout', stderr: '' }, base);
  assert.equal(prompt.blocked, true);
  assert.equal(prompt.feedback, 'via stdout');
});

test('exit 2 on PostToolUse becomes model feedback, never a block', () => {
  const out = interpretHookRun(
    'PostToolUse',
    { exitCode: 2, stdout: '', stderr: 'lint failed: 3 errors' },
    { blocked: false }
  );
  assert.equal(out.blocked, false);
  assert.equal(out.feedback, 'lint failed: 3 errors');
});

test('UserPromptSubmit zero-exit stdout accumulates as extra context', () => {
  let out = interpretHookRun(
    'UserPromptSubmit',
    { exitCode: 0, stdout: 'branch: main', stderr: '' },
    { blocked: false }
  );
  out = interpretHookRun('UserPromptSubmit', { exitCode: 0, stdout: 'ticket: PAR-7', stderr: '' }, out);
  assert.equal(out.extraContext, 'branch: main\nticket: PAR-7');
  assert.equal(out.blocked, false);
});

test('Stop hooks and plain failures never intervene', () => {
  const stop = interpretHookRun('Stop', { exitCode: 2, stdout: '', stderr: 'x' }, { blocked: false });
  assert.deepEqual(stop, { blocked: false });
  const fail = interpretHookRun('PreToolUse', { exitCode: 1, stdout: '', stderr: 'crashed' }, { blocked: false });
  assert.deepEqual(fail, { blocked: false });
});

test('runHookEvent end-to-end: a real exit-2 process blocks with its stderr', async () => {
  const cfg: HooksConfig = {
    PreToolUse: [{ matcher: 'run_command', command: 'node -e "process.stderr.write(\'nope\'); process.exit(2)"' }]
  };
  const outcome = await runHookEvent(cfg, 'PreToolUse', { tool: 'run_command', arguments: { command: 'rm -rf' } });
  assert.equal(outcome.blocked, true);
  assert.equal(outcome.feedback, 'nope');
  const clean = await runHookEvent(cfg, 'PreToolUse', { tool: 'read_file' });
  assert.equal(clean.blocked, false);
});

test('runHookEvent end-to-end: stdin carries the event JSON', async () => {
  const cfg: HooksConfig = {
    UserPromptSubmit: [
      // Echo the prompt field from stdin back on stdout (exit 0 → extra context).
      {
        command:
          "node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write(JSON.parse(d).prompt)})\""
      }
    ]
  };
  const outcome = await runHookEvent(cfg, 'UserPromptSubmit', { prompt: 'hello hooks' });
  assert.equal(outcome.extraContext, 'hello hooks');
});
