/**
 * Detect and preserve a text file's on-disk *format* — character encoding, byte-
 * order mark, and dominant line ending — so edits and full rewrites round-trip
 * faithfully instead of silently flipping a CRLF file to LF or corrupting a
 * UTF-16 file to UTF-8. Pure (only Node's Buffer) so it is unit-testable.
 *
 * Scope: UTF-8 (with or without BOM) and UTF-16LE (with BOM — the common Windows
 * form). UTF-16BE is not re-encodable via Buffer and is left as UTF-8 (unchanged
 * from prior behavior); it is vanishingly rare in source trees.
 */

export interface FileFormat {
  readonly encoding: 'utf8' | 'utf16le';
  readonly bom: boolean;
  readonly eol: '\n' | '\r\n';
}

export const DEFAULT_FORMAT: FileFormat = { encoding: 'utf8', bom: false, eol: '\n' };

function detectEncoding(bytes: Uint8Array): { encoding: 'utf8' | 'utf16le'; bom: boolean } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf16le', bom: true };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf8', bom: true };
  }
  return { encoding: 'utf8', bom: false };
}

/** Dominant line ending of already-decoded text (ties → LF). */
export function detectEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf; // bare \n only
  return crlf > lf ? '\r\n' : '\n';
}

/** EOL a brand-new file should use, inferred from the content being written. */
export function inferEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Decode raw file bytes to a JS string, returning the detected format for later re-encoding. */
export function decodeText(bytes: Uint8Array): { text: string; format: FileFormat } {
  const { encoding, bom } = detectEncoding(bytes);
  const buf = Buffer.from(bytes);
  const body = encoding === 'utf16le' ? buf.subarray(bom ? 2 : 0) : buf.subarray(bom ? 3 : 0);
  const text = body.toString(encoding);
  return { text, format: { encoding, bom, eol: detectEol(text) } };
}

/**
 * Encode a JS string back to bytes in the given format: normalize all line
 * endings to the target EOL, then apply the encoding and (optional) BOM. Input
 * EOLs are normalized first, so it is safe to pass model output that uses LF.
 */
export function encodeText(text: string, format: FileFormat): Buffer {
  // Collapse CRLF and any lone CR (old-Mac) to LF, then apply the target EOL.
  const normalized = text.replace(/\r\n?/g, '\n');
  const withEol = format.eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
  if (format.encoding === 'utf16le') {
    const body = Buffer.from(withEol, 'utf16le');
    return format.bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
  }
  const body = Buffer.from(withEol, 'utf8');
  return format.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}
