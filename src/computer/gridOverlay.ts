import { createRequire } from 'module';
import * as path from 'path';
import { nutInstallDir } from './nutControl';

/**
 * Overlay a coordinate grid on a screenshot, labeled in the screen's REAL pixels,
 * so a vision model can read off approximate pixel locations ("the button sits
 * just right of the x=1200 line, near y=640"). Uses jimp (a nut.js dependency
 * already on disk); returns null on any failure so the caller falls back to the
 * plain screenshot. Best-effort — vision grounding is approximate at best.
 */

const STEP_PX = 100; // gridline spacing in the shown image
const LINE = 0xffcc00b0; // amber, semi-transparent (RGBA int)

export interface GriddedShot {
  readonly base64: string;
  readonly realW: number;
  readonly realH: number;
}

export async function annotateWithGrid(
  base64: string,
  realW: number,
  realH: number,
  globalStorageDir: string
): Promise<GriddedShot | null> {
  try {
    const req = createRequire(path.join(nutInstallDir(globalStorageDir), 'package.json'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jimp has no types here
    const mod: any = req('jimp');
    const Jimp = mod.Jimp ?? (typeof mod.read === 'function' ? mod : (mod.default ?? mod));
    const img = await Jimp.read(Buffer.from(base64, 'base64'));
    const w: number = img.bitmap.width;
    const h: number = img.bitmap.height;
    if (!w || !h) {
      return null;
    }
    const sx = realW / w;
    const sy = realH / h;

    // Draw gridlines directly into the bitmap (setPixelColor — jimp has no line primitive).
    for (let x = STEP_PX; x < w; x += STEP_PX) {
      for (let y = 0; y < h; y += 1) {
        img.setPixelColor(LINE, x, y);
      }
    }
    for (let y = STEP_PX; y < h; y += STEP_PX) {
      for (let x = 0; x < w; x += 1) {
        img.setPixelColor(LINE, x, y);
      }
    }

    // Label each line with its REAL screen coordinate (best-effort — skip if no font).
    try {
      const fontName = Jimp.FONT_SANS_16_WHITE ?? 'FONT_SANS_16_WHITE';
      const font = await Jimp.loadFont(fontName);
      for (let x = STEP_PX; x < w; x += STEP_PX) {
        img.print(font, x + 2, 1, String(Math.round(x * sx)));
      }
      for (let y = STEP_PX; y < h; y += STEP_PX) {
        img.print(font, 1, y + 1, String(Math.round(y * sy)));
      }
    } catch {
      // No font available — the lines alone still give a usable reference.
    }

    const out =
      typeof img.getBufferAsync === 'function'
        ? await img.getBufferAsync('image/png')
        : await img.getBuffer('image/png');
    const buf: Buffer = Buffer.isBuffer(out) ? out : Buffer.from(out);
    return { base64: buf.toString('base64'), realW, realH };
  } catch {
    return null;
  }
}
