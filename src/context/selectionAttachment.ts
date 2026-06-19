import type { ContextAttachment } from '../parley/types';
import { trimToLimit } from './contextPreview';

export interface SelectionAttachmentInput {
  readonly filePath: string;
  readonly languageId: string;
  readonly selectedText: string;
  readonly surroundingText?: string;
  readonly maxCharacters: number;
}

export function createSelectionAttachment(input: SelectionAttachmentInput): ContextAttachment {
  const content = input.surroundingText
    ? `Selected text:\n${input.selectedText}\n\nSurrounding context:\n${input.surroundingText}`
    : input.selectedText;
  const trimmed = trimToLimit(content, input.maxCharacters);

  return {
    id: `selection:${input.filePath}`,
    kind: 'selection',
    label: 'Current selection',
    filePath: input.filePath,
    languageId: input.languageId,
    content: trimmed.content,
    characterCount: trimmed.content.length,
    truncated: trimmed.truncated
  };
}
