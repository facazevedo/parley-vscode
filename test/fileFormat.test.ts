import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeText, detectEol, encodeText, inferEol, type FileFormat } from '../src/diff/fileFormat';
import { parseCheckpointLines, serializeCheckpoint, type CheckpointRecord } from '../src/diff/checkpointCodec';

function u8(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

test('decodeText reads plain UTF-8 and reports LF', () => {
  const { text, format } = decodeText(u8('line1\nline2\n'));
  assert.equal(text, 'line1\nline2\n');
  assert.deepEqual(format, { encoding: 'utf8', bom: false, eol: '\n' });
});

test('decodeText detects CRLF as the dominant EOL', () => {
  const { text, format } = decodeText(u8('a\r\nb\r\nc\r\n'));
  assert.equal(text, 'a\r\nb\r\nc\r\n');
  assert.equal(format.eol, '\r\n');
});

test('decodeText strips a UTF-8 BOM and remembers it', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), u8('hi\n')]);
  const { text, format } = decodeText(bytes);
  assert.equal(text, 'hi\n');
  assert.deepEqual(format, { encoding: 'utf8', bom: true, eol: '\n' });
});

test('decodeText reads UTF-16LE with BOM and CRLF', () => {
  const body = Buffer.from('x\r\ny\r\n', 'utf16le');
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  const { text, format } = decodeText(bytes);
  assert.equal(text, 'x\r\ny\r\n');
  assert.deepEqual(format, { encoding: 'utf16le', bom: true, eol: '\r\n' });
});

test('THE BUG: a CRLF file rewritten from LF model output stays CRLF', () => {
  // Model emits LF; the file was CRLF. encodeText must restore CRLF.
  const format: FileFormat = { encoding: 'utf8', bom: false, eol: '\r\n' };
  const out = encodeText('a\nb\nc\n', format);
  assert.equal(out.toString('utf8'), 'a\r\nb\r\nc\r\n');
});

test('encode/decode round-trips every format byte-faithfully', () => {
  const cases: Array<{ bytes: Buffer; name: string }> = [
    { name: 'utf8-lf', bytes: u8('a\nb\n') },
    { name: 'utf8-crlf', bytes: u8('a\r\nb\r\n') },
    { name: 'utf8-bom', bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), u8('a\nb\n')]) },
    {
      name: 'utf16le-bom-crlf',
      bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\r\nb\r\n', 'utf16le')])
    }
  ];
  for (const { bytes, name } of cases) {
    const { text, format } = decodeText(bytes);
    assert.deepEqual(encodeText(text, format), bytes, `round-trip ${name}`);
  }
});

test('encodeText normalizes a lone CR (old-Mac EOL) instead of leaving a stray \\r', () => {
  // Mixed input with a bare \r; CRLF target must not produce \r\r\n or a stray \r.
  assert.equal(
    encodeText('a\rb\r\nc\n', { encoding: 'utf8', bom: false, eol: '\r\n' }).toString('utf8'),
    'a\r\nb\r\nc\r\n'
  );
  assert.equal(encodeText('a\rb', { encoding: 'utf8', bom: false, eol: '\n' }).toString('utf8'), 'a\nb');
});

test('encodeText writes a UTF-16LE BOM file from an edited LF string', () => {
  const format: FileFormat = { encoding: 'utf16le', bom: true, eol: '\r\n' };
  const out = encodeText('changed\n', format);
  assert.equal(out[0], 0xff);
  assert.equal(out[1], 0xfe);
  assert.equal(out.subarray(2).toString('utf16le'), 'changed\r\n');
});

test('detectEol / inferEol pick the right ending', () => {
  assert.equal(detectEol('a\r\nb\r\nc\n'), '\r\n'); // CRLF dominant
  assert.equal(detectEol('a\nb\r\n'), '\n'); // tie → LF
  assert.equal(detectEol('no newlines'), '\n');
  assert.equal(inferEol('has\r\ncrlf'), '\r\n');
  assert.equal(inferEol('just\nlf'), '\n');
});

test('checkpoint records round-trip the file format (compact code) and stay backward-compatible', () => {
  const rec: CheckpointRecord = {
    fsPath: 'C:\\repo\\a.ts',
    previous: 'old\r\n',
    label: 'edit a.ts',
    marker: 3,
    at: '2026-07-02T00:00:00.000Z',
    format: { encoding: 'utf16le', bom: true, eol: '\r\n' }
  };
  const [parsed] = parseCheckpointLines(serializeCheckpoint(rec));
  assert.deepEqual(parsed.format, { encoding: 'utf16le', bom: true, eol: '\r\n' });
  assert.equal(parsed.previous, 'old\r\n');

  // A legacy record with no `f` field parses with format === undefined (restores as UTF-8, as before).
  const legacy = JSON.stringify({ p: 'C:\\repo\\b.ts', v: 'x', l: 'edit', m: 0, at: '' });
  assert.equal(parseCheckpointLines(legacy)[0].format, undefined);
});
