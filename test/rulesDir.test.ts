import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globMatches, parseRuleFile, ruleApplies } from '../src/context/rulesDir';

test('parseRuleFile without frontmatter is an always-on rule', () => {
  const rule = parseRuleFile('Use tabs.\nNever use eval.');
  assert.deepEqual(rule.globs, []);
  assert.equal(rule.alwaysApply, false);
  assert.equal(rule.body, 'Use tabs.\nNever use eval.');
  assert.ok(ruleApplies(rule, 'any/file.ts'));
  assert.ok(ruleApplies(rule, undefined));
});

test('parseRuleFile reads description, globs, and alwaysApply', () => {
  const rule = parseRuleFile(
    '---\ndescription: React rules\nglobs: src/components/**, *.tsx\nalwaysApply: false\n---\nUse function components.'
  );
  assert.equal(rule.description, 'React rules');
  assert.deepEqual(rule.globs, ['src/components/**', '*.tsx']);
  assert.equal(rule.alwaysApply, false);
  assert.equal(rule.body, 'Use function components.');
});

test('parseRuleFile handles bracketed/quoted glob lists and CRLF', () => {
  const rule = parseRuleFile('---\r\nglobs: ["src/**/*.py", \'tests/**\']\r\n---\r\nPython rules.');
  assert.deepEqual(rule.globs, ['src/**/*.py', 'tests/**']);
});

test('globMatches: ** crosses directories, * does not', () => {
  assert.ok(globMatches('src/**/*.ts', 'src/a/b/c.ts'));
  assert.ok(globMatches('src/**/*.ts', 'src/c.ts'));
  assert.ok(!globMatches('src/*.ts', 'src/a/c.ts'));
  assert.ok(globMatches('src/*.ts', 'src/c.ts'));
  assert.ok(!globMatches('src/**/*.ts', 'lib/c.ts'));
});

test('globMatches: bare-name patterns match at any depth; backslashes normalize', () => {
  assert.ok(globMatches('*.tsx', 'src/components/App.tsx'));
  assert.ok(globMatches('*.tsx', 'App.tsx'));
  assert.ok(globMatches('src/**', 'src\\deep\\file.py'));
});

test('ruleApplies: glob rules need a matching active file; alwaysApply overrides', () => {
  const globbed = parseRuleFile('---\nglobs: docs/**\n---\nDocs style.');
  assert.ok(ruleApplies(globbed, 'docs/guide.md'));
  assert.ok(!ruleApplies(globbed, 'src/app.ts'));
  assert.ok(!ruleApplies(globbed, undefined));
  const always = parseRuleFile('---\nglobs: docs/**\nalwaysApply: true\n---\nAlways.');
  assert.ok(ruleApplies(always, 'src/app.ts'));
});
