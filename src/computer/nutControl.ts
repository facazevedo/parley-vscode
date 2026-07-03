import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runNpmInstall } from '../util/runtimeInstall';
import type { CuAction } from './actions';
import type { ControlBackend, CoordMap, Screenshot } from './backend';

/**
 * Optional nut.js control backend (cross-platform). nut.js is NOT bundled: it is
 * a native module under a GPL-3.0 / paid-commercial license, so it's installed on
 * demand into the extension's global storage only after the user accepts its terms
 * (see the first-run consent flow in ChatPanel.startComputerUse). Loaded lazily via
 * createRequire so esbuild never tries to bundle it.
 */

/** Package name Parley installs (the maintained community fork; also the classic scope). */
export const NUT_PACKAGES = ['@nut-tree-fork/nut-js', '@nut-tree/nut-js', 'nut-js'] as const;
const NUT_INSTALL_TARGET = '@nut-tree-fork/nut-js';

/** Where on-demand-installed nut.js lives (a private folder in global storage). */
export function nutInstallDir(globalStorageDir: string): string {
  return path.join(globalStorageDir, 'computer-use');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- nut.js has no bundled types here
type Nut = any;

/** Try to require nut.js from the global-storage install, then from the ambient node_modules. */
function requireNut(globalStorageDir: string): Nut | null {
  const candidates: Array<{ from: string }> = [
    { from: path.join(nutInstallDir(globalStorageDir), 'package.json') },
    { from: __filename }
  ];
  for (const c of candidates) {
    let req: NodeJS.Require;
    try {
      req = createRequire(c.from);
    } catch {
      continue;
    }
    for (const name of NUT_PACKAGES) {
      try {
        return req(name) as Nut;
      } catch {
        // not installed at this location — keep trying
      }
    }
  }
  return null;
}

/** True if nut.js can be loaded right now (already installed). */
export function isNutInstalled(globalStorageDir: string): boolean {
  return requireNut(globalStorageDir) !== null;
}

/** Install nut.js into global storage (after the user accepts its terms). Throws on failure. */
export async function installNutJs(globalStorageDir: string): Promise<void> {
  const dir = nutInstallDir(globalStorageDir);
  await fs.promises.mkdir(dir, { recursive: true });
  const pkgJson = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    await fs.promises.writeFile(pkgJson, JSON.stringify({ name: 'parley-computer-use', private: true }), 'utf8');
  }
  await runNpmInstall({
    dir,
    args: ['install', NUT_INSTALL_TARGET, '--no-audit', '--no-fund', '--loglevel=error'],
    what: 'nut.js computer-control backend',
    timeoutMs: 6 * 60_000
  });
}

/** Read a PNG's pixel dimensions from its IHDR chunk (no image library needed). */
function pngSize(buf: Buffer): { w: number; h: number } {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const MAX_SHOWN_WIDTH = 1280;

/**
 * Downscale a screenshot PNG to <=MAX_SHOWN_WIDTH using jimp (a nut.js dependency
 * already on disk — no new install). Best-effort across jimp v0/v1 APIs; returns
 * the original buffer unchanged on any failure, so capture never breaks. A smaller
 * image dramatically cuts upload + model latency for the computer-use loop.
 */
async function downscalePng(buf: Buffer, globalStorageDir: string): Promise<Buffer> {
  try {
    const req = createRequire(path.join(nutInstallDir(globalStorageDir), 'package.json'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jimp has no types here
    const mod: any = req('jimp');
    // jimp v1 exports { Jimp }; v0 exports the class itself (has static read()).
    const Jimp = mod.Jimp ?? (typeof mod.read === 'function' ? mod : (mod.default ?? mod));
    const img = await Jimp.read(buf);
    const w: number = img.bitmap?.width ?? 0;
    if (!w || w <= MAX_SHOWN_WIDTH) {
      return buf; // already small enough
    }
    try {
      img.resize({ w: MAX_SHOWN_WIDTH }); // jimp v1 (object arg)
    } catch {
      img.resize(MAX_SHOWN_WIDTH, -1); // jimp v0 (width, AUTO=-1)
    }
    // v0 exposes the promise API as getBufferAsync (getBuffer is callback-style);
    // v1 exposes getBuffer as a promise. Prefer getBufferAsync when present.
    const out =
      typeof img.getBufferAsync === 'function'
        ? await img.getBufferAsync('image/png')
        : await img.getBuffer('image/png');
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  } catch {
    return buf; // jimp missing or API mismatch — keep full-res
  }
}

function buildKeyList(nut: Nut, spec: string): unknown[] {
  const Key = nut.Key;
  const map: Record<string, unknown> = {
    ctrl: Key.LeftControl,
    control: Key.LeftControl,
    alt: Key.LeftAlt,
    shift: Key.LeftShift,
    win: Key.LeftSuper,
    cmd: Key.LeftSuper,
    meta: Key.LeftSuper,
    enter: Key.Enter,
    return: Key.Enter,
    tab: Key.Tab,
    esc: Key.Escape,
    escape: Key.Escape,
    backspace: Key.Backspace,
    delete: Key.Delete,
    del: Key.Delete,
    home: Key.Home,
    end: Key.End,
    pageup: Key.PageUp,
    pagedown: Key.PageDown,
    up: Key.Up,
    down: Key.Down,
    left: Key.Left,
    right: Key.Right,
    space: Key.Space
  };
  const out: unknown[] = [];
  for (const tokRaw of spec.toLowerCase().split('+')) {
    const tok = tokRaw.trim();
    if (!tok) {
      continue;
    }
    if (map[tok] !== undefined) {
      out.push(map[tok]);
    } else if (tok.length === 1) {
      const named = tok.toUpperCase();
      if (Key[named] !== undefined) {
        out.push(Key[named]);
      }
    } else if (/^f\d{1,2}$/.test(tok)) {
      const fk = tok.toUpperCase();
      if (Key[fk] !== undefined) {
        out.push(Key[fk]);
      }
    }
  }
  return out;
}

/** Build a ControlBackend from a loaded nut.js module. */
function backendFrom(nut: Nut, globalStorageDir: string): ControlBackend {
  const { screen, mouse, keyboard, Point, Button, FileType } = nut;
  // Snappy but not instant, so on-screen UI keeps up.
  try {
    mouse.config.mouseSpeed = 2000;
    keyboard.config.autoDelayMs = 4;
  } catch {
    // config shape varies across versions — ignore
  }

  const captureScreen = async (): Promise<Screenshot> => {
    const dir = os.tmpdir();
    const name = `parley-cu-${process.pid}-${Math.floor(process.hrtime()[1])}`;
    const file: string = await screen.capture(name, FileType.PNG, dir);
    const fullBuf = await fs.promises.readFile(file);
    fs.promises.unlink(file).catch(() => undefined);
    const fullSize = pngSize(fullBuf);
    let realW = fullSize.w;
    let realH = fullSize.h;
    try {
      realW = await screen.width();
      realH = await screen.height();
    } catch {
      // fall back to the PNG's own pixel size (scale 1)
    }
    // Downscale what the model sees; coordinates map from shown → real via the caller.
    const shownBuf = await downscalePng(fullBuf, globalStorageDir);
    const shown = pngSize(shownBuf);
    return {
      left: 0,
      top: 0,
      realW,
      realH,
      shownW: shown.w,
      shownH: shown.h,
      base64: shownBuf.toString('base64')
    };
  };

  const runAction = async (action: CuAction, mapCoord: CoordMap): Promise<void> => {
    switch (action.type) {
      case 'move': {
        const p = mapCoord(action.x, action.y);
        await mouse.setPosition(new Point(p.x, p.y));
        break;
      }
      case 'click': {
        const p = mapCoord(action.x, action.y);
        await mouse.setPosition(new Point(p.x, p.y));
        if (action.button === 'right') {
          await mouse.rightClick();
        } else if (action.button === 'double') {
          if (typeof mouse.doubleClick === 'function') {
            await mouse.doubleClick(Button.LEFT);
          } else {
            await mouse.leftClick();
            await mouse.leftClick();
          }
        } else {
          await mouse.leftClick();
        }
        break;
      }
      case 'scroll': {
        const p = mapCoord(action.x, action.y);
        await mouse.setPosition(new Point(p.x, p.y));
        if (action.amount > 0) {
          await mouse.scrollDown(action.amount * 100);
        } else {
          await mouse.scrollUp(-action.amount * 100);
        }
        break;
      }
      case 'type':
        await keyboard.type(action.text);
        break;
      case 'key': {
        const keys = buildKeyList(nut, action.keys);
        if (keys.length === 0) {
          break;
        }
        await keyboard.pressKey(...keys);
        await keyboard.releaseKey(...keys.slice().reverse());
        break;
      }
      default:
        break; // wait/done/abort handled by the caller
    }
  };

  const getCursor = async (): Promise<{ x: number; y: number }> => {
    const p = await mouse.getPosition();
    return { x: p.x, y: p.y };
  };

  return { name: 'nut.js', captureScreen, runAction, getCursor };
}

/** Load the nut.js backend if installed; null otherwise. */
export function loadNutBackend(globalStorageDir: string): ControlBackend | null {
  const nut = requireNut(globalStorageDir);
  if (!nut) {
    return null;
  }
  try {
    return backendFrom(nut, globalStorageDir);
  } catch {
    return null;
  }
}
