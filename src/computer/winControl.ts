import { spawn } from 'child_process';
import type { CuAction } from './actions';
import type { ControlBackend, CoordMap, Screenshot } from './backend';

/**
 * Windows screen capture + mouse/keyboard injection via PowerShell + .NET —
 * no third-party dependency. Untrusted data (typed text) is passed through
 * environment variables, never interpolated into the script source, so a typed
 * string can't inject PowerShell. Everything else is validated numbers/enums.
 * Windows-only; callers gate on process.platform.
 */

const MAX_SHOWN_WIDTH = 1280;

function runPowerShell(
  script: string,
  env: Record<string, string>,
  timeoutMs = 15000,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: timeoutMs }
    );
    let out = '';
    let err = '';
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      child.kill();
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      // Abort (Stop button / Esc-in-chat) is a normal cancel, not an error: resolve empty so
      // callers treat it like a picker cancel rather than surfacing a failure.
      if (aborted) {
        resolve('');
      } else if (code === 0) {
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

/** A physical display, real pixels. `index` matches Screen::AllScreens order. */
export interface Monitor {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  primary: boolean;
}

const ENUMERATE_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$out = @()
for ($i = 0; $i -lt $screens.Count; $i++) {
  $b = $screens[$i].Bounds
  $out += [pscustomobject]@{ index = $i; x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height; primary = $screens[$i].Primary }
}
ConvertTo-Json -InputObject @($out) -Compress
`;

/**
 * Parse the enumerate script's JSON into monitors. Pure + defensive:
 * ConvertTo-Json emits a bare object (not an array) for a single element, and
 * anything unexpected/malformed collapses to []. Kept separate so it's unit-tested
 * without spawning PowerShell.
 */
export function parseMonitors(stdout: string): Monitor[] {
  const text = (stdout || '').trim();
  if (!text) {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(data) ? data : [data];
  const monitors: Monitor[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    const r = row as Record<string, unknown>;
    const nums = [r.index, r.x, r.y, r.w, r.h].map((v) => Number(v));
    if (nums.some((n) => !Number.isFinite(n)) || Number(r.w) <= 0 || Number(r.h) <= 0) {
      continue;
    }
    monitors.push({
      index: Number(r.index),
      x: Number(r.x),
      y: Number(r.y),
      w: Number(r.w),
      h: Number(r.h),
      primary: Boolean(r.primary)
    });
  }
  return monitors;
}

/** Enumerate physical monitors (Windows only). */
export async function listMonitors(): Promise<Monitor[]> {
  return parseMonitors(await runPowerShell(ENUMERATE_SCRIPT, {}, 8000));
}

const CAPTURE_REGION_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$x = [int]$env:PARLEY_CAP_X
$y = [int]$env:PARLEY_CAP_Y
$w = [int]$env:PARLEY_CAP_W
$h = [int]$env:PARLEY_CAP_H
$full = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen((New-Object System.Drawing.Point $x, $y), [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size $w, $h))
$maxW = ${MAX_SHOWN_WIDTH}
$scale = [Math]::Min(1.0, $maxW / $w)
$sw = [int]($w * $scale)
$sh = [int]($h * $scale)
$shown = New-Object System.Drawing.Bitmap $sw, $sh
$sg = [System.Drawing.Graphics]::FromImage($shown)
$sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$sg.DrawImage($full, 0, 0, $sw, $sh)
$ms = New-Object System.IO.MemoryStream
$shown.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$x $y $w $h $sw $sh"
Write-Output ([Convert]::ToBase64String($ms.ToArray()))
`;

/** Capture exactly one monitor's bounds, downscaled to <=1280px wide. */
export async function captureMonitor(m: Monitor): Promise<Screenshot> {
  const out = await runPowerShell(CAPTURE_REGION_SCRIPT, {
    PARLEY_CAP_X: String(m.x),
    PARLEY_CAP_Y: String(m.y),
    PARLEY_CAP_W: String(m.w),
    PARLEY_CAP_H: String(m.h)
  });
  const nl = out.indexOf('\n');
  const dims = out.slice(0, nl).trim().split(/\s+/).map(Number);
  const base64 = out.slice(nl + 1).trim();
  const [left, top, realW, realH, shownW, shownH] = dims;
  return { left, top, realW, realH, shownW, shownH, base64 };
}

const PICKER_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$secs = [int]$env:PARLEY_PICK_SECONDS
if ($secs -le 0) { $secs = 5 }
$screens = [System.Windows.Forms.Screen]::AllScreens
$script:chosen = $null
$forms = New-Object System.Collections.ArrayList
$labels = New-Object System.Collections.ArrayList
$bigFont = New-Object System.Drawing.Font('Segoe UI', 34, [System.Drawing.FontStyle]::Bold)
for ($i = 0; $i -lt $screens.Count; $i++) {
  $s = $screens[$i]
  $f = New-Object System.Windows.Forms.Form
  $f.FormBorderStyle = 'None'
  $f.StartPosition = 'Manual'
  $f.Bounds = $s.Bounds
  $f.TopMost = $true
  $f.BackColor = 'Black'
  $f.Opacity = 0.45
  $f.ShowInTaskbar = $false
  $f.KeyPreview = $true
  $f.Cursor = [System.Windows.Forms.Cursors]::Hand
  $f.Tag = $i
  $lbl = New-Object System.Windows.Forms.Label
  $lbl.Dock = 'Fill'
  $lbl.TextAlign = 'MiddleCenter'
  $lbl.ForeColor = 'White'
  $lbl.Font = $bigFont
  $lbl.Cursor = [System.Windows.Forms.Cursors]::Hand
  $lbl.Text = "Screen $($i + 1)  —  $($s.Bounds.Width) x $($s.Bounds.Height)\`n\`nClick to capture   ·   Esc to cancel\`n\`n$secs"
  $lbl.Tag = $i
  $f.Controls.Add($lbl)
  # Bake the (validated) integer index into each handler so it doesn't rely on \$this/\$_ binding.
  $onClick = [scriptblock]::Create("\`$script:chosen = $i")
  $f.Add_Click($onClick)
  $lbl.Add_Click($onClick)
  $f.Add_KeyDown({ if ($args[1].KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $script:chosen = -1 } })
  [void]$forms.Add($f)
  [void]$labels.Add($lbl)
}
foreach ($f in $forms) { $f.Show() }
if ($forms.Count -gt 0) { $forms[0].Activate() }
$deadline = (Get-Date).AddSeconds($secs)
while ($null -eq $script:chosen -and (Get-Date) -lt $deadline) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 40
  $remaining = [int][Math]::Ceiling(($deadline - (Get-Date)).TotalSeconds)
  if ($remaining -lt 0) { $remaining = 0 }
  for ($j = 0; $j -lt $labels.Count; $j++) {
    $labels[$j].Text = "Screen $($j + 1)  —  $($screens[$j].Bounds.Width) x $($screens[$j].Bounds.Height)\`n\`nClick to capture   ·   Esc to cancel\`n\`n$remaining"
  }
}
foreach ($f in $forms) { $f.Close(); $f.Dispose() }
if ($null -eq $script:chosen) { $script:chosen = -1 }
Write-Output $script:chosen
`;

/**
 * Show a full-screen click target on every monitor for `seconds`; resolve the chosen
 * monitor index, or -1 on Esc / timeout / abort. Windows only.
 */
export async function pickMonitor(seconds: number, signal?: AbortSignal): Promise<number> {
  const out = await runPowerShell(
    PICKER_SCRIPT,
    { PARLEY_PICK_SECONDS: String(Math.max(1, Math.round(seconds))) },
    Math.max(20000, (seconds + 5) * 1000),
    signal
  );
  const n = Number(out.trim());
  return Number.isInteger(n) ? n : -1;
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
export async function runAction(action: CuAction, map: CoordMap): Promise<void> {
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

const CURSOR_SCRIPT = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class PCur {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
}
'@
Add-Type -TypeDefinition $sig
$p = New-Object PCur+P
[void][PCur]::GetCursorPos([ref]$p)
Write-Output "$($p.X) $($p.Y)"
`;

/** Current cursor position (real pixels) for the corner-slam kill switch. */
async function getCursor(): Promise<{ x: number; y: number }> {
  const out = (await runPowerShell(CURSOR_SCRIPT, {}, 5000)).trim().split(/\s+/).map(Number);
  return { x: out[0] || 0, y: out[1] || 0 };
}

/** Built-in Windows backend (no dependency). */
export const powershellBackend: ControlBackend = { name: 'PowerShell', captureScreen, runAction, getCursor };
