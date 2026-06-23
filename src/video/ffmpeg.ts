import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

/**
 * Optional ffmpeg-backed video understanding.
 *
 * Parley has no video content type, so we approximate it client-side: sample
 * frames (sent as images to a vision model) and/or extract the audio track
 * (sent as an `input_audio` clip). This requires ffmpeg/ffprobe on the user's
 * PATH (or a configured path); callers must check {@link hasFfmpeg} first and
 * degrade gracefully when it's missing.
 */
const run = promisify(execFile);

export interface FfmpegBinaries {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

export interface ExtractedFrame {
  readonly base64: string;
  readonly mime: string;
}

/** Derive the ffprobe path that sits beside a given ffmpeg path (pure). */
export function resolveFfprobePath(ffmpegPath: string): string {
  if (!ffmpegPath || ffmpegPath === 'ffmpeg') {
    return 'ffprobe';
  }
  const dir = path.dirname(ffmpegPath);
  const base = path.basename(ffmpegPath).replace(/ffmpeg/i, 'ffprobe');
  return dir === '.' ? base : path.join(dir, base);
}

/** The `fps` filter value that yields ~maxFrames evenly spread across a clip (pure). */
export function framesFps(durationSeconds: number | undefined, maxFrames: number): string {
  if (durationSeconds && durationSeconds > 0 && maxFrames > 0) {
    return (maxFrames / durationSeconds).toFixed(5);
  }
  return '1';
}

/** True if the ffmpeg binary can be invoked. */
export async function hasFfmpeg(bins: FfmpegBinaries): Promise<boolean> {
  try {
    await run(bins.ffmpeg, ['-version'], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** Clip duration in seconds via ffprobe, or `undefined` if it can't be determined. */
export async function probeDurationSeconds(bins: FfmpegBinaries, videoPath: string): Promise<number | undefined> {
  try {
    const { stdout } = await run(
      bins.ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath],
      { timeout: 15000 }
    );
    const seconds = parseFloat(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}

/** Sample up to `maxFrames` JPEG frames (downscaled to `width`), evenly across the video. */
export async function extractFrames(
  bins: FfmpegBinaries,
  videoPath: string,
  opts: { maxFrames: number; width: number }
): Promise<ExtractedFrame[]> {
  const duration = await probeDurationSeconds(bins, videoPath);
  const fps = framesFps(duration, opts.maxFrames);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-vid-'));
  try {
    await run(
      bins.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        videoPath,
        '-vf',
        `fps=${fps},scale=${opts.width}:-2`,
        '-frames:v',
        String(opts.maxFrames),
        '-q:v',
        '3',
        path.join(dir, 'frame_%03d.jpg')
      ],
      { timeout: 180000, maxBuffer: 1 << 20 }
    );
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
    const frames: ExtractedFrame[] = [];
    for (const file of files) {
      const buf = await fs.readFile(path.join(dir, file));
      frames.push({ base64: buf.toString('base64'), mime: 'image/jpeg' });
    }
    return frames;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Extract up to `maxSeconds` of the audio track as base64 MP3. */
export async function extractAudioMp3(
  bins: FfmpegBinaries,
  videoPath: string,
  opts: { maxSeconds: number }
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-aud-'));
  try {
    const out = path.join(dir, 'audio.mp3');
    await run(
      bins.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-i', videoPath, '-vn', '-t', String(opts.maxSeconds), '-acodec', 'libmp3lame', '-q:a', '5', out],
      { timeout: 180000, maxBuffer: 1 << 20 }
    );
    const buf = await fs.readFile(out);
    return buf.toString('base64');
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
