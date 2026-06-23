/**
 * Document attachment routing.
 *
 * Parley's `/v1/files` upload endpoint supports OpenAI and Google only. For
 * those providers a document is uploaded and referenced by id; for Bedrock /
 * Anthropic (and anything else) the document is sent inline as a base64
 * `document` content block. This pure helper decides which path a model takes.
 */
export type FileUploadProvider = 'openai' | 'google';

/** Returns the upload provider for a model id, or `undefined` to send inline instead. */
export function documentProviderFor(model: string): FileUploadProvider | undefined {
  if (model.startsWith('openai/')) {
    return 'openai';
  }
  if (model.startsWith('google/')) {
    return 'google';
  }
  return undefined;
}
