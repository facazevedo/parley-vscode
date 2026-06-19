import type { ContextAttachment } from '../parley/types';

/**
 * Combine a user prompt with collected workspace context into a single message
 * body suitable for an LLM turn. Each attachment is rendered as a labeled,
 * fenced code block so the model can tell files and selections apart.
 */
export function renderPromptWithContext(prompt: string, attachments: readonly ContextAttachment[]): string {
  const contextBlocks = attachments.map((attachment) => {
    const header = [
      `### ${attachment.label}`,
      attachment.filePath ? `File: ${attachment.filePath}` : undefined,
      attachment.languageId ? `Language: ${attachment.languageId}` : undefined,
      attachment.truncated ? 'Note: This attachment was truncated before sending.' : undefined
    ]
      .filter(Boolean)
      .join('\n');

    return `${header}\n\n\`\`\`${attachment.languageId ?? ''}\n${attachment.content}\n\`\`\``;
  });

  if (contextBlocks.length === 0) {
    return prompt;
  }

  return `${prompt}\n\nUse the following VS Code context. Do not assume files outside this context unless you ask for them.\n\n${contextBlocks.join('\n\n')}`;
}
