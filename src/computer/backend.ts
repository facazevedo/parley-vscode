import type { CuAction } from './actions';

/**
 * A computer-use control backend: screen capture + input injection. Two
 * implementations exist behind this interface — the built-in Windows PowerShell
 * backend (no dependency) and an optional nut.js backend (cross-platform, used
 * when the package is installed). `control.ts` picks one.
 */

export interface Screenshot {
  /** Virtual-screen origin (real pixels) — real = origin + shown / scale. */
  readonly left: number;
  readonly top: number;
  readonly realW: number;
  readonly realH: number;
  /** Dimensions of the (possibly downscaled) image the model sees — its coordinate space. */
  readonly shownW: number;
  readonly shownH: number;
  readonly base64: string; // PNG
}

/** Maps a coordinate in the shown image to a real screen pixel. */
export type CoordMap = (x: number, y: number) => { x: number; y: number };

export interface ControlBackend {
  /** Short label for the confirm dialog / action log (e.g. "PowerShell", "nut.js"). */
  readonly name: string;
  captureScreen(): Promise<Screenshot>;
  runAction(action: CuAction, map: CoordMap): Promise<void>;
  /** Current cursor position in real screen pixels — powers the corner-slam kill switch. */
  getCursor?(): Promise<{ x: number; y: number }>;
}
