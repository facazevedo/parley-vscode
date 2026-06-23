import type {
  AgentInfo,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  CompletionRequest,
  ImageRequest,
  ImageResult,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  UsageSummary
} from './types';

/**
 * Optional per-request controls for {@link ParleyProvider.sendMessage}.
 *
 * When `onToken` is supplied the provider streams the assistant reply and
 * invokes the callback for each incremental delta. When `tools`/`runTool` are
 * supplied the provider runs an agentic loop, executing requested tools and
 * feeding results back until the model produces a final answer.
 */
export interface SendMessageOptions {
  readonly onToken?: (delta: string) => void;
  /** Called for each extended-thinking (reasoning) delta when thinking is enabled. */
  readonly onThinking?: (delta: string) => void;
  readonly signal?: AbortSignal;
  readonly tools?: readonly ToolDefinition[];
  readonly runTool?: (call: ToolCall) => Promise<string>;
  readonly onToolEvent?: (event: { readonly name: string; readonly args: string }) => void;
  /** Called when token usage for a round becomes known (for live token counters). */
  readonly onUsage?: (usage: TokenUsage) => void;
  readonly maxToolRounds?: number;
}

export interface ParleyProvider {
  readonly id: string;
  listAgents(): Promise<readonly AgentInfo[]>;
  sendMessage(request: ChatRequest, options?: SendMessageOptions): Promise<ChatResponse>;
  complete(request: CompletionRequest, signal?: AbortSignal): Promise<string>;
  generateImage(request: ImageRequest, signal?: AbortSignal): Promise<ImageResult>;
  /** Exact prompt-token count via the gateway; `undefined` if the endpoint is unavailable. */
  countTokens(model: string, messages: readonly ChatMessage[], system?: string): Promise<number | undefined>;
  /** Billed usage summary for an account (current month). */
  getUsage(accountId: string): Promise<UsageSummary>;
  signOut(): Promise<void>;
}
