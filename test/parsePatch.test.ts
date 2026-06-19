import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePatch } from '../src/diff/parsePatch';

test('parsePatch parses unified diff files and hunks', () => {
  const patches = parsePatch(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 const a = 1;
-console.log(a);
+console.info(a);
+export { a };
`);

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.oldPath, 'src/app.ts');
  assert.equal(patches[0]?.newPath, 'src/app.ts');
  assert.equal(patches[0]?.hunks.length, 1);
  assert.equal(patches[0]?.hunks[0]?.oldStart, 1);
  assert.equal(patches[0]?.hunks[0]?.newLines, 3);
});
