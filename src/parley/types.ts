export type MessageRole = 'user' | 'assistant' | 'system';

export interface TokenUsage {
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
}

export interface ChatMessage {
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: string;
  /** Model that produced an assistant message (for export/labeling). */
  readonly model?: string;
  /** Token usage reported for an assistant message, if available. */
  readonly usage?: TokenUsage;
}

export interface ContextAttachment {
  readonly id: string;
  readonly kind: 'selection' | 'file' | 'diagnostics' | 'open-editor' | 'user-file';
  readonly label: string;
  readonly filePath?: string;
  readonly languageId?: string;
  readonly content: string;
  readonly characterCount: number;
  readonly truncated?: boolean;
}

/** An image attached to a chat turn, sent as a multimodal `image_url` block. */
export interface ImageAttachment {
  readonly label: string;
  /** A `data:<mime>;base64,…` URI. */
  readonly dataUri: string;
}

/** Reasoning effort level. Empty string means "don't send the parameter". */
export type ReasoningEffort = '' | 'minimal' | 'low' | 'medium' | 'high';

export interface ChatRequest {
  readonly prompt: string;
  readonly agentId?: string;
  readonly messages: readonly ChatMessage[];
  readonly context: readonly ContextAttachment[];
  readonly images?: readonly ImageAttachment[];
  readonly reasoningEffort?: ReasoningEffort;
  /** Extra system-prompt text (e.g. project rules from .parleyrules / AGENTS.md). */
  readonly systemExtra?: string;
}

/** OpenAI-style function tool definition. */
export interface ToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON arguments string as returned by the model. */
  readonly arguments: string;
}

/** Fill-in-the-middle request for inline (ghost-text) completion. */
export interface CompletionRequest {
  readonly prefix: string;
  readonly suffix: string;
  readonly languageId: string;
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort;
}

/** Image generation request for `gpt-image-1`. */
export interface ImageRequest {
  readonly prompt: string;
  readonly size: string;
  readonly model: string;
}

export interface ImageResult {
  /** Base64-encoded image bytes (no data-URI prefix). */
  readonly base64: string;
  readonly mimeType: string;
}

export interface ProposedFileChange {
  readonly filePath: string;
  readonly originalText: string;
  readonly proposedText: string;
  readonly title?: string;
}

export interface TerminalSuggestion {
  readonly command: string;
  readonly explanation: string;
}

export interface ChatResponse {
  readonly message: ChatMessage;
  readonly proposedChanges?: readonly ProposedFileChange[];
  readonly terminalSuggestions?: readonly TerminalSuggestion[];
  readonly usage?: TokenUsage;
}

export interface AgentInfo {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/** Raised when no API key is stored, so the UI can offer the sign-in flow. */
export class ParleyAuthRequiredError extends Error {
  public constructor(message = 'No Parley API key is configured. Run "Parley: Set API Key" to add one.') {
    super(message);
    this.name = 'ParleyAuthRequiredError';
  }
}

/** Raised for non-2xx API responses, carrying the HTTP status for handling. */
export class ParleyApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ParleyApiError';
  }
}
