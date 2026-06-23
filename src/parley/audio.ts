/**
 * Audio input support.
 *
 * Parley accepts audio as a multimodal `input_audio` content block (wav/mp3).
 * Per the docs, audio is supported only on OpenAI and Google models — Bedrock
 * and Anthropic reject it. These pure helpers classify files and gate models.
 */
export type AudioFormat = 'wav' | 'mp3';

const EXT_FORMAT: Record<string, AudioFormat> = { '.wav': 'wav', '.mp3': 'mp3' };

/** File extensions (with leading dot) recognized as audio input. */
export const AUDIO_EXTENSIONS = Object.keys(EXT_FORMAT);

/** Map a file extension (e.g. `.mp3`) to an audio format, or `undefined`. */
export function audioFormatFromExt(ext: string): AudioFormat | undefined {
  return EXT_FORMAT[ext.toLowerCase()];
}

/** Map a MIME type (e.g. `audio/mpeg`) to an audio format, or `undefined`. */
export function audioFormatFromMime(mime: string): AudioFormat | undefined {
  const m = mime.toLowerCase();
  if (m === 'audio/wav' || m === 'audio/x-wav' || m === 'audio/wave') {
    return 'wav';
  }
  if (m === 'audio/mpeg' || m === 'audio/mp3') {
    return 'mp3';
  }
  return undefined;
}

/** Audio input is only supported on OpenAI and Google models. */
export function modelSupportsAudio(model: string): boolean {
  return model.startsWith('openai/') || model.startsWith('google/');
}
