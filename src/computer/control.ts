import { powershellBackend } from './winControl';
import { loadNutBackend } from './nutControl';
import type { ControlBackend } from './backend';

export type BackendPref = 'auto' | 'nutjs' | 'powershell';

/**
 * Pick a computer-use control backend. `auto` prefers nut.js when it's installed
 * (cross-platform), else falls back to the built-in Windows PowerShell backend.
 * Returns undefined when nothing usable is available (e.g. macOS/Linux without
 * nut.js installed). Not memoized — the set of installed backends can change
 * within a session (the user may install nut.js on demand).
 */
export function resolveBackend(pref: BackendPref, globalStorageDir: string): ControlBackend | undefined {
  const nut = pref === 'powershell' ? null : loadNutBackend(globalStorageDir);
  if (pref === 'nutjs') {
    return nut ?? undefined;
  }
  if (nut) {
    return nut;
  }
  return process.platform === 'win32' ? powershellBackend : undefined;
}

export type { ControlBackend, Screenshot, CoordMap } from './backend';
