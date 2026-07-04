import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';

// skills.ts and tools.ts import vscode; stub it so the pure parts can be imported
// (same trick as outputStyles.test.ts).
function makeVscodeStub(): unknown {
  const handler: ProxyHandler<() => unknown> = {
    get: (_t, prop) => (prop === Symbol.toPrimitive || prop === 'then' ? undefined : stub),
    apply: () => stub,
    construct: () => ({})
  };
  const stub: unknown = new Proxy(function noop() {}, handler);
  return stub;
}
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]): unknown {
  return request === 'vscode' ? makeVscodeStub() : originalLoad.apply(this, [request, ...rest] as never);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the vscode stub is installed
const skills = require('../src/config/skills') as typeof import('../src/config/skills');
// eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the vscode stub is installed
const tools = require('../src/parley/tools') as typeof import('../src/parley/tools');
const { skillFromFile } = skills;
const { withSkills, AGENT_TOOLS } = tools;

test('skillFromFile parses description and body; empty body → undefined', () => {
  const s = skillFromFile(
    'pdf-fill',
    '.parley/skills/pdf-fill',
    '---\ndescription: Fill PDF forms\n---\nStep 1. Do X.'
  );
  assert.ok(s);
  assert.equal(s.id, 'pdf-fill');
  assert.equal(s.description, 'Fill PDF forms');
  assert.match(s.instructions, /Step 1\. Do X\./);
  assert.equal(s.dir, '.parley/skills/pdf-fill');
  assert.equal(skillFromFile('x', 'd', '---\ndescription: only frontmatter\n---\n\n'), undefined);
});

test('missing description falls back to a default', () => {
  const s = skillFromFile('brand', 'd', 'Do the brand thing.');
  assert.ok(s);
  assert.match(s.description, /brand/);
});

test('withSkills enumerates skills in load_skill and keeps other tools', () => {
  const out = withSkills(AGENT_TOOLS, [
    { id: 'pdf-fill', description: 'Fill PDF forms' },
    { id: 'brand', description: 'Apply brand style' }
  ]);
  const loadSkill = out.find((t) => t.function.name === 'load_skill');
  assert.ok(loadSkill, 'load_skill present when skills exist');
  assert.match(loadSkill.function.description, /"pdf-fill" — Fill PDF forms/);
  assert.match(loadSkill.function.description, /"brand" — Apply brand style/);
  assert.ok(
    out.some((t) => t.function.name === 'read_file'),
    'other tools untouched'
  );
});

test('withSkills drops load_skill entirely when there are no skills', () => {
  const out = withSkills(AGENT_TOOLS, []);
  assert.equal(
    out.find((t) => t.function.name === 'load_skill'),
    undefined
  );
  // The original array is unchanged.
  assert.ok(AGENT_TOOLS.some((t) => t.function.name === 'load_skill'));
});
