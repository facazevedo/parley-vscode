import { spawn } from 'child_process';
import type { CuAction } from './actions';

/**
 * Windows screen capture + mouse/keyboard injection via PowerShell + .NET —
 * no third-party dependency. Untrusted data (typed text) is passed through
 * environment variables, never interpolated into the script source, so a typed
 * string can't inject PowerShell. Everything else is validated numbers/enums.
 * Windows-only; callers gate on process.platform.
 */

export interface Screenshot {
  /** Virtual-screen origin (real pixels) — real = origin + shown / scale. */
  readonly left: number;
  readonly top: number;
  readonly realW: number;
  readonly realH: number;
  /** Dimensions of the downscaled image the model sees (coordinate space). */
  readonly shownW: number;
  readonly shownH: number;
  readonly base64: string; // PNG
}

const MAX_SHOWN_WIDTH = 1280;

function runPowerShell(script: string, env: Record<string, string>, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: timeoutMs }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(err.trim() || `PowerShell exited with code ${code}`));
      }
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

const CAPTURE_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$full = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($vs.Location, [System.Drawing.Point]::Empty, $vs.Size)
$maxW = ${MAX_SHOWN_WIDTH}
$scale = [Math]::Min(1.0, $maxW / $vs.Width)
$sw = [int]($vs.Width * $scale)
$sh = [int]($vs.Height * $scale)
$shown = New-Object System.Drawing.Bitmap $sw, $sh
$sg = [System.Drawing.Graphics]::FromImage($shown)
$sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$sg.DrawImage($full, 0, 0, $sw, $sh)
$ms = New-Object System.IO.MemoryStream
$shown.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$($vs.Left) $($vs.Top) $($vs.Width) $($vs.Height) $sw $sh"
Write-Output ([Convert]::ToBase64String($ms.ToArray()))
`;

/** Capture the whole virtual screen, downscaled to <=1280px wide. */
export async function captureScreen(): Promise<Screenshot> {
  const out = await runPowerShell(CAPTURE_SCRIPT, {});
  const nl = out.indexOf('\n');
  const dims = out.slice(0, nl).trim().split(/\s+/).map(Number);
  const base64 = out.slice(nl + 1).trim();
  const [left, top, realW, realH, shownW, shownH] = dims;
  return { left, top, realW, realH, shownW, shownH, base64 };
}

/** SendKeys is the simplest reliable typer; escape its metacharacters. */
function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, '{$&}');
}

/** Map a key/combo spec ("ctrl+s", "enter") to SendKeys syntax. */
function toSendKeys(spec: string): string {
  const parts = spec.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const named: Record<string, string> = {
    enter: '{ENTER}',
    return: '{ENTER}',
    tab: '{TAB}',
    esc: '{ESC}',
    escape: '{ESC}',
    backspace: '{BACKSPACE}',
    delete: '{DELETE}',
    del: '{DELETE}',
    home: '{HOME}',
    end: '{END}',
    pageup: '{PGUP}',
    pagedown: '{PGDN}',
    up: '{UP}',
    down: '{DOWN}',
    left: '{LEFT}',
    right: '{RIGHT}',
    space: ' ',
    f1: '{F1}',
    f2: '{F2}',
    f3: '{F3}',
    f4: '{F4}',
    f5: '{F5}',
    f6: '{F6}',
    f7: '{F7}',
    f8: '{F8}',
    f9: '{F9}',
    f10: '{F10}',
    f11: '{F11}',
    f12: '{F12}'
  };
  const base = named[key] ?? (key.length === 1 ? escapeSendKeys(key) : '');
  const prefix =
    (mods.includes('ctrl') || mods.includes('control') ? '^' : '') +
    (mods.includes('alt') ? '%' : '') +
    (mods.includes('shift') ? '+' : '');
  return prefix + base;
}

const INPUT_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class PInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public const uint LD=0x02, LU=0x04, RD=0x08, RU=0x10, WHEEL=0x0800;
}
'@
Add-Type -TypeDefinition $sig
$act = $env:PARLEY_CU_ACTION
$x = [int]$env:PARLEY_CU_X
$y = [int]$env:PARLEY_CU_Y
switch ($act) {
  'move' { [PInput]::SetCursorPos($x, $y) }
  'left' { [PInput]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 30; [PInput]::mouse_event([PInput]::LD,0,0,0,[IntPtr]::Zero); [PInput]::mouse_event([PInput]::LU,0,0,0,[IntPtr]::Zero) }
  'right' { [PInput]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 30; [PInput]::mouse_event([PInput]::RD,0,0,0,[IntPtr]::Zero); [PInput]::mouse_event([PInput]::RU,0,0,0,[IntPtr]::Zero) }
  'double' { [PInput]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 30; [PInput]::mouse_event([PInput]::LD,0,0,0,[IntPtr]::Zero); [PInput]::mouse_event([PInput]::LU,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 60; [PInput]::mouse_event([PInput]::LD,0,0,0,[IntPtr]::Zero); [PInput]::mouse_event([PInput]::LU,0,0,0,[IntPtr]::Zero) }
  'scroll' { [PInput]::SetCursorPos($x, $y); [PInput]::mouse_event([PInput]::WHEEL,0,0,[uint32]([int]$env:PARLEY_CU_AMOUNT),[IntPtr]::Zero) }
  'type' { [System.Windows.Forms.SendKeys]::SendWait($env:PARLEY_CU_TEXT) }
  'key' { [System.Windows.Forms.SendKeys]::SendWait($env:PARLEY_CU_KEYS) }
}
`;

/**
 * Execute one action. `map` converts shown-image coordinates to real screen pixels.
 * Returns after the injection completes (the caller waits before the next capture).
 */
export async function runAction(
  action: CuAction,
  map: (x: number, y: number) => { x: number; y: number }
): Promise<void> {
  const env: Record<string, string> = { PARLEY_CU_X: '0', PARLEY_CU_Y: '0' };
  switch (action.type) {
    case 'move': {
      const p = map(action.x, action.y);
      env.PARLEY_CU_ACTION = 'move';
      env.PARLEY_CU_X = String(p.x);
      env.PARLEY_CU_Y = String(p.y);
      break;
    }
    case 'click': {
      const p = map(action.x, action.y);
      env.PARLEY_CU_ACTION = action.button;
      env.PARLEY_CU_X = String(p.x);
      env.PARLEY_CU_Y = String(p.y);
      break;
    }
    case 'scroll': {
      const p = map(action.x, action.y);
      env.PARLEY_CU_ACTION = 'scroll';
      env.PARLEY_CU_X = String(p.x);
      env.PARLEY_CU_Y = String(p.y);
      // Wheel delta: 120 per notch, negative = down (screen scrolls down on negative).
      env.PARLEY_CU_AMOUNT = String(-action.amount * 120);
      break;
    }
    case 'type':
      env.PARLEY_CU_ACTION = 'type';
      env.PARLEY_CU_TEXT = escapeSendKeys(action.text);
      break;
    case 'key':
      env.PARLEY_CU_ACTION = 'key';
      env.PARLEY_CU_KEYS = toSendKeys(action.keys);
      break;
    default:
      return; // wait/done/abort handled by the caller
  }
  await runPowerShell(INPUT_SCRIPT, env, 10000);
}
