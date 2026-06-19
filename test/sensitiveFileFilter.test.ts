import assert from 'node:assert/strict';
import test from 'node:test';
import { isSensitiveFile, shouldSendFile } from '../src/context/sensitiveFileFilter';

test('sensitive file filter blocks common credential files', () => {
  assert.equal(isSensitiveFile('/workspace/.env'), true);
  assert.equal(isSensitiveFile('/workspace/.env.local'), true);
  assert.equal(isSensitiveFile('/workspace/.npmrc'), true);
  assert.equal(isSensitiveFile('/workspace/id_rsa'), true);
  assert.equal(isSensitiveFile('/workspace/cert.pem'), true);
  assert.equal(isSensitiveFile('/workspace/private.key'), true);
  assert.equal(isSensitiveFile('/workspace/secrets.production'), true);
});

test('shouldSendFile excludes hidden files and allows normal source files', () => {
  assert.equal(shouldSendFile('/workspace/.hidden'), false);
  assert.equal(shouldSendFile('/workspace/.parleyignore'), true);
  assert.equal(shouldSendFile('/workspace/src/index.ts'), true);
});
