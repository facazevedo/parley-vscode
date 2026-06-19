import type { ContextAttachment } from '../parley/types';

export function totalCharacters(attachments: readonly ContextAttachment[]): number {
  return attachments.reduce((sum, item) => sum + item.characterCount, 0);
}

export function renderContextPreview(attachments: readonly ContextAttachment[]): string {
  const total = totalCharacters(attachments);
  const sections = attachments.map((item) => {
    const metadata = [
      `Kind: ${item.kind}`,
      item.filePath ? `File: ${item.filePath}` : undefined,
      item.languageId ? `Language: ${item.languageId}` : undefined,
      `Characters: ${item.characterCount}${item.truncated ? ' (truncated)' : ''}`
    ]
      .filter(Boolean)
      .join('\n');
    return `## ${item.label}\n\n${metadata}\n\n\`\`\`\n${item.content}\n\`\`\``;
  });

  return `# Parley Context Preview\n\nTotal characters: ${total}\n\n${sections.join('\n\n')}`;
}

export function trimToLimit(content: string, limit: number): { content: string; truncated: boolean } {
  if (content.length <= limit) {
    return { content, truncated: false };
  }

  return {
    content: `${content.slice(0, Math.max(0, limit - 80))}\n\n[Parley: content truncated to fit context limit]`,
    truncated: true
  };
}
