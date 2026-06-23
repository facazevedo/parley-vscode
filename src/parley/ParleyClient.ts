import type { Logger } from '../logging/logger';
import { renderPromptWithContext } from '../context/renderPromptWithContext';
import { extractProposedChanges } from '../diff/extractChanges';
import { cleanCompletion, isContextLengthError, parseUsage } from './parsing';
import { buildThinkingRequest, type ThinkingConfig } from './thinking';
import { documentProviderFor } from './files';
import { ParleyAuthStore } from './auth';
import type { ParleyProvider, SendMessageOptions } from './ParleyProvider';
import {
  ParleyApiError,
  ParleyAuthRequiredError,
  type AgentInfo,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type CompletionRequest,
  type DocumentAttachment,
  type ImageRequest,
  type ImageResult,
  type TokenUsage
} from './types';

const SYSTEM_PROMPT = [
  'You are Parley, an MIT coding assistant embedded in Visual Studio Code.',
  'Be concise and accurate. Use Markdown. Reference files as `path:line` when helpful.',
  '',
  'When you propose changes to a file, output the COMPLETE updated file contents in a fenced',
  'code block immediately preceded by a line of the form:',
  '',
  'File: relative/path/from/workspace/root.ext',
  '',
  'Use one such block per changed or newly created file. Do not abbreviate file contents with',
  'comments like "// ... unchanged ...". Only emit a File: block when you actually intend to',
  'edit or create that file; otherwise answer normally. The user reviews every change in a diff',
  'before it is applied, so never claim a change has already been made.'
].join('\n');

const COMPLETION_SYSTEM =
  'You are a code completion engine. Output ONLY the raw code that should be inserted at the ' +
  '<CURSOR> marker so it continues naturally and stays syntactically valid. No explanations, no ' +
  'Markdown fences, no repetition of the surrounding code.';

const MAX_TOOL_RESULT_CHARS = 8000;
const DEFAULT_MAX_TOOL_ROUNDS = 25;

interface OpenAiMessage {
  role: string;
  content?: string | unknown[] | null;
  tool_calls?: ReadonlyArray<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  /** Preserved across tool rounds so providers (Bedrock Claude) accept thinking + tool use. */
  thinking?: string;
  thinking_signature?: string;
}

interface OpenAiModelList {
  readonly data?: ReadonlyArray<{ readonly id?: string; readonly name?: string; readonly owned_by?: string }>;
}

interface ChatCompletionMessage {
  readonly content?: string | null;
  readonly tool_calls?: ReadonlyArray<{ id: string; type: string; function: { name: string; arguments: string } }>;
  readonly thinking?: string;
  readonly thinking_signature?: string;
}

interface CompletionResult {
  readonly content: string;
  readonly usage?: TokenUsage;
  readonly thinking?: string;
  readonly thinkingSignature?: string;
}

const TOOL_OMITTED = '[earlier tool output omitted to save context]';

/** Replace all but the most recent `keepLast` tool-result messages with a short placeholder. */
function trimOldToolMessages(convo: OpenAiMessage[], keepLast: number): void {
  const toolIndexes: number[] = [];
  for (let i = 0; i < convo.length; i += 1) {
    if (convo[i].role === 'tool') {
      toolIndexes.push(i);
    }
  }
  const cutoff = toolIndexes.length - keepLast;
  for (let k = 0; k < cutoff; k += 1) {
    const i = toolIndexes[k];
    if (convo[i].content !== TOOL_OMITTED) {
      convo[i] = { ...convo[i], content: TOOL_OMITTED };
    }
  }
}

/**
 * Official Parley provider. Parley exposes an OpenAI-compatible gateway at
 * `https://parley.api.mit.edu/v1`, authenticated with a `sk-parley-…` bearer
 * key. This client speaks `/models`, `/chat/completions` (streaming, tool
 * calling, and vision), and `/images/generations`, behind the
 * {@link ParleyProvider} interface so the rest of the extension is transport-agnostic.
 */
export class ParleyClient implements ParleyProvider {
  public readonly id = 'official-api';
  private readonly baseUrl: string;

  public constructor(
    endpoint: string,
    private readonly auth: ParleyAuthStore,
    private readonly logger: Logger,
    private readonly defaultModel: string
  ) {
    this.baseUrl = endpoint.replace(/\/+$/, '');
  }

  public async listAgents(): Promise<readonly AgentInfo[]> {
    const response = await this.request('/models', { method: 'GET' });
    const payload = (await response.json()) as OpenAiModelList;

    const agents: AgentInfo[] = (payload.data ?? [])
      .filter((model): model is { id: string; name?: string; owned_by?: string } =>
        typeof model.id === 'string' && model.id.length > 0)
      .map((model) => ({
        id: model.id,
        label: model.name ?? model.id,
        description: model.owned_by ? `Provider: ${model.owned_by}` : undefined
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return agents.length > 0 ? agents : [{ id: this.defaultModel, label: this.defaultModel }];
  }

  public async sendMessage(request: ChatRequest, options?: SendMessageOptions): Promise<ChatResponse> {
    const model = request.agentId?.trim() || this.defaultModel;
    const documentParts = await this.prepareDocumentParts(model, request.documents ?? [], options?.signal);
    const messages = this.buildMessages(request, documentParts);
    const thinking = request.thinking;
    const responseFormat = request.responseFormat;

    const useTools = Boolean(options?.tools && options.tools.length > 0 && options.runTool);
    const result = useTools
      ? await this.runToolLoop(messages, model, options as SendMessageOptions, thinking, responseFormat)
      : await this.singleCompletion(messages, model, options, thinking, responseFormat);

    const proposedChanges = await extractProposedChanges(result.content);

    return {
      message: {
        role: 'assistant',
        content: result.content,
        createdAt: new Date().toISOString(),
        usage: result.usage,
        thinking: result.thinking || undefined
      },
      proposedChanges: proposedChanges.length > 0 ? proposedChanges : undefined,
      usage: result.usage
    };
  }

  /** Apply per-request extras (extended thinking, structured output) to a chat payload. */
  private applyExtras(
    payload: Record<string, unknown>,
    model: string,
    thinking?: ThinkingConfig,
    responseFormat?: Record<string, unknown>
  ): void {
    const t = buildThinkingRequest(model, thinking);
    if (t) {
      payload.thinking = t.thinking;
      payload.max_tokens = t.max_tokens;
    }
    if (responseFormat) {
      payload.response_format = responseFormat;
    }
  }

  /**
   * Exact prompt-token count via the Anthropic-style `/v1/messages/count_tokens`
   * endpoint. System messages are folded into the top-level `system` field.
   * Returns `undefined` if the endpoint errors so callers can fall back.
   */
  public async countTokens(
    model: string,
    messages: readonly ChatMessage[],
    system?: string
  ): Promise<number | undefined> {
    const systemParts: string[] = system ? [system] : [];
    const turns: Array<{ role: string; content: string }> = [];
    for (const m of messages) {
      if (m.role === 'system') {
        systemParts.push(m.content);
      } else {
        turns.push({ role: m.role, content: m.content });
      }
    }
    if (turns.length === 0) {
      return undefined;
    }
    try {
      const body: Record<string, unknown> = { model, messages: turns };
      if (systemParts.length > 0) {
        body.system = systemParts.join('\n\n');
      }
      const response = await this.request('/messages/count_tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const json = (await response.json()) as { input_tokens?: number };
      return typeof json.input_tokens === 'number' ? json.input_tokens : undefined;
    } catch (error) {
      this.logger.debug(`count_tokens unavailable: ${error instanceof Error ? error.message : 'error'}`);
      return undefined;
    }
  }

  /**
   * Turn document attachments into multimodal content parts. OpenAI/Google models
   * upload via `/v1/files` and reference the file by id; Bedrock/Anthropic (and any
   * upload failure) fall back to an inline base64 `document` block.
   */
  private async prepareDocumentParts(
    model: string,
    documents: readonly DocumentAttachment[],
    signal?: AbortSignal
  ): Promise<unknown[]> {
    if (documents.length === 0) {
      return [];
    }
    const provider = documentProviderFor(model);
    const parts: unknown[] = [];
    for (const doc of documents) {
      if (provider) {
        try {
          const fileId = await this.uploadFile(doc, provider, signal);
          parts.push({ type: 'file', file_id: fileId });
          continue;
        } catch (error) {
          this.logger.warn(`File upload failed for ${doc.filename}: ${error instanceof Error ? error.message : 'error'}`);
        }
      }
      parts.push({ type: 'document', source: { type: 'base64', media_type: doc.mimeType, data: doc.base64 } });
    }
    return parts;
  }

  /** Upload a document to `/v1/files` for the given provider and return its Parley file id. */
  private async uploadFile(doc: DocumentAttachment, provider: 'openai' | 'google', signal?: AbortSignal): Promise<string> {
    const bytes = Buffer.from(doc.base64, 'base64');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: doc.mimeType }), doc.filename);
    form.append('provider', provider);
    // Note: no Content-Type header — fetch sets the multipart boundary for FormData.
    const response = await this.request('/files', { method: 'POST', body: form, signal });
    const json = (await response.json()) as { fileId?: string; providerFileId?: string };
    const id = json.fileId ?? json.providerFileId;
    if (!id) {
      throw new ParleyApiError(0, 'Parley returned no file id for the upload.');
    }
    return id;
  }

  public async complete(request: CompletionRequest, signal?: AbortSignal): Promise<string> {
    const userPrompt =
      `Language: ${request.languageId}\n` +
      `Insert code at <CURSOR>. Reply with only the text to insert.\n\n` +
      `${request.prefix}<CURSOR>${request.suffix}`;

    const payload: Record<string, unknown> = {
      model: request.model,
      messages: [
        { role: 'system', content: COMPLETION_SYSTEM },
        { role: 'user', content: userPrompt }
      ],
      stream: false
    };

    const response = await this.request('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });

    return cleanCompletion(this.extractContent(await response.json()));
  }

  public async generateImage(request: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
    const response = await this.request('/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        n: 1,
        size: request.size,
        ...(request.quality ? { quality: request.quality } : {})
      }),
      signal
    });

    const json = (await response.json()) as { data?: Array<{ b64_json?: string }>; output_format?: string };
    const base64 = json.data?.[0]?.b64_json;
    if (!base64) {
      throw new ParleyApiError(0, 'Parley returned no image data.');
    }
    return { base64, mimeType: `image/${json.output_format ?? 'png'}` };
  }

  public async signOut(): Promise<void> {
    await this.auth.clear();
  }

  private async singleCompletion(
    messages: OpenAiMessage[],
    model: string,
    options?: SendMessageOptions,
    thinking?: ThinkingConfig,
    responseFormat?: Record<string, unknown>
  ): Promise<CompletionResult> {
    const stream = Boolean(options?.onToken);
    const payload: Record<string, unknown> = { model, messages, stream };
    this.applyExtras(payload, model, thinking, responseFormat);
    if (stream) {
      payload.stream_options = { include_usage: true };
    }
    const response = await this.request('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: options?.signal
    });

    if (stream) {
      const streamed = await this.readStream(response, options?.onToken, options?.onThinking);
      if (streamed.usage) {
        options?.onUsage?.(streamed.usage);
      }
      return streamed;
    }
    const json = await response.json();
    const usage = parseUsage(json);
    if (usage) {
      options?.onUsage?.(usage);
    }
    const message = (json as { choices?: Array<{ message?: ChatCompletionMessage }> }).choices?.[0]?.message;
    if (message?.thinking) {
      options?.onThinking?.(message.thinking);
    }
    return {
      content: this.extractContent(json),
      usage,
      thinking: message?.thinking,
      thinkingSignature: message?.thinking_signature
    };
  }

  /** Run the OpenAI tool-calling loop until the model answers or rounds run out. */
  private async runToolLoop(
    messages: OpenAiMessage[],
    model: string,
    options: SendMessageOptions,
    thinking?: ThinkingConfig,
    responseFormat?: Record<string, unknown>
  ): Promise<CompletionResult> {
    const convo = [...messages];
    const maxRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;

    let lastUsage: TokenUsage | undefined;
    for (let round = 0; round < maxRounds; round += 1) {
      trimOldToolMessages(convo, 8); // keep the convo from ballooning across many tool rounds
      const roundPayload: Record<string, unknown> = {
        model,
        messages: convo,
        tools: options.tools,
        stream: true,
        stream_options: { include_usage: true }
      };
      this.applyExtras(roundPayload, model, thinking, responseFormat);
      const response = await this.request('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(roundPayload),
        signal: options.signal
      });

      // Stream this round live: narration tokens go to onToken; tool calls are
      // reassembled from the streamed deltas. This is what makes the agent's
      // activity appear token-by-token (Claude-Code style).
      const result = await this.streamRound(response, options.onToken, options.onUsage, options.onThinking);
      if (result.usage) {
        lastUsage = result.usage;
      }

      if (result.toolCalls.length === 0) {
        return {
          content: result.content,
          usage: lastUsage,
          thinking: result.thinking,
          thinkingSignature: result.thinkingSignature
        };
      }

      convo.push({
        role: 'assistant',
        content: result.content,
        ...(result.thinking ? { thinking: result.thinking } : {}),
        ...(result.thinkingSignature ? { thinking_signature: result.thinkingSignature } : {}),
        tool_calls: result.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments }
        }))
      });
      for (const tc of result.toolCalls) {
        options.onToolEvent?.({ name: tc.name, args: tc.arguments });
        let toolResult: string;
        try {
          toolResult = await options.runTool!({ id: tc.id, name: tc.name, arguments: tc.arguments });
        } catch (error) {
          toolResult = `Error: ${error instanceof Error ? error.message : 'tool failed'}`;
        }
        convo.push({ role: 'tool', tool_call_id: tc.id, content: toolResult.slice(0, MAX_TOOL_RESULT_CHARS) });
      }
    }

    // Out of tool rounds: ask once more without tools so the model commits to an answer.
    this.logger.debug(`Tool loop hit ${maxRounds} rounds; requesting a final answer.`);
    const final = await this.singleCompletion(
      convo,
      model,
      { onToken: options.onToken, onThinking: options.onThinking, signal: options.signal },
      thinking,
      responseFormat
    );
    return { content: final.content, usage: final.usage ?? lastUsage, thinking: final.thinking };
  }

  /** Stream one chat-completions round, surfacing text via onToken and reassembling tool calls from deltas. */
  private async streamRound(
    response: Response,
    onToken?: (delta: string) => void,
    onUsage?: (usage: TokenUsage) => void,
    onThinking?: (delta: string) => void
  ): Promise<{
    content: string;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
    usage?: TokenUsage;
    thinking?: string;
    thinkingSignature?: string;
  }> {
    if (!response.body) {
      const json = (await response.json()) as { choices?: Array<{ message?: ChatCompletionMessage }> };
      const message = json.choices?.[0]?.message;
      const text = typeof message?.content === 'string' ? message.content : '';
      if (message?.thinking) {
        onThinking?.(message.thinking);
      }
      if (text) {
        onToken?.(text);
      }
      const toolCalls = (message?.tool_calls ?? []).map((t) => ({
        id: t.id,
        name: t.function?.name ?? '',
        arguments: t.function?.arguments ?? ''
      }));
      return {
        content: text,
        toolCalls,
        usage: parseUsage(json),
        thinking: message?.thinking,
        thinkingSignature: message?.thinking_signature
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolMap = new Map<number, { id: string; name: string; arguments: string }>();
    let buffer = '';
    let content = '';
    let thinking = '';
    let thinkingSignature: string | undefined;
    let usage: TokenUsage | undefined;
    let done = false;

    try {
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith('data:')) {
            continue;
          }
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            done = true;
            break;
          }
          let parsed: {
            choices?: Array<{
              delta?: {
                content?: string;
                thinking?: string;
                thinking_signature?: string;
                tool_calls?: Array<Record<string, unknown>>;
              };
            }>;
            usage?: unknown;
          };
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          const maybeUsage = parseUsage(parsed);
          if (maybeUsage) {
            usage = maybeUsage;
            onUsage?.(maybeUsage);
          }
          const delta = parsed.choices?.[0]?.delta;
          if (typeof delta?.thinking === 'string' && delta.thinking) {
            thinking += delta.thinking;
            onThinking?.(delta.thinking);
          }
          if (typeof delta?.thinking_signature === 'string' && delta.thinking_signature) {
            thinkingSignature = delta.thinking_signature;
          }
          if (typeof delta?.content === 'string' && delta.content) {
            content += delta.content;
            onToken?.(delta.content);
          }
          if (Array.isArray(delta?.tool_calls)) {
            for (const fragment of delta.tool_calls) {
              const idx = typeof fragment.index === 'number' ? fragment.index : 0;
              const current = toolMap.get(idx) ?? { id: '', name: '', arguments: '' };
              const fn = fragment.function as { name?: string; arguments?: string } | undefined;
              if (typeof fragment.id === 'string') {
                current.id = fragment.id;
              }
              if (fn?.name) {
                current.name = fn.name;
              }
              if (typeof fn?.arguments === 'string') {
                current.arguments += fn.arguments;
              }
              toolMap.set(idx, current);
            }
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Reader may already be released.
      }
    }

    const toolCalls = [...toolMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value)
      .filter((value) => value.name.length > 0);
    return { content, toolCalls, usage, thinking: thinking || undefined, thinkingSignature };
  }

  private buildMessages(request: ChatRequest, documentParts: unknown[] = []): OpenAiMessage[] {
    const system = request.systemExtra
      ? `${SYSTEM_PROMPT}\n\n# Project rules (from the workspace)\n${request.systemExtra}`
      : SYSTEM_PROMPT;
    const messages: OpenAiMessage[] = [{ role: 'system', content: system }];

    const history =
      request.messages.length > 0
        ? request.messages
        : ([{ role: 'user', content: request.prompt, createdAt: new Date().toISOString() }] as ChatMessage[]);

    history.forEach((message, index) => {
      const isLast = index === history.length - 1;
      const role = message.role === 'system' ? 'system' : message.role;

      if (isLast && message.role === 'user') {
        const text = renderPromptWithContext(message.content, request.context);
        const extras: unknown[] = [
          ...(request.images ?? []).map((image) => ({ type: 'image_url', image_url: { url: image.dataUri } })),
          ...(request.audios ?? []).map((audio) => ({
            type: 'input_audio',
            input_audio: { data: audio.base64, format: audio.format }
          })),
          ...documentParts
        ];
        if (extras.length > 0) {
          messages.push({ role: 'user', content: [{ type: 'text', text }, ...extras] });
          return;
        }
        messages.push({ role: 'user', content: text });
        return;
      }

      messages.push({ role, content: message.content });
    });

    return messages;
  }

  private extractContent(payload: unknown): string {
    const choices = (payload as { choices?: Array<{ message?: { content?: string } }> }).choices;
    const content = choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  }

  private async readStream(
    response: Response,
    onToken?: (delta: string) => void,
    onThinking?: (delta: string) => void
  ): Promise<CompletionResult> {
    if (!response.body) {
      const json = await response.json();
      const message = (json as { choices?: Array<{ message?: ChatCompletionMessage }> }).choices?.[0]?.message;
      return {
        content: this.extractContent(json),
        usage: parseUsage(json),
        thinking: message?.thinking,
        thinkingSignature: message?.thinking_signature
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let thinking = '';
    let thinkingSignature: string | undefined;
    let usage: TokenUsage | undefined;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith('data:')) {
            continue;
          }
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            return { content: full, usage, thinking: thinking || undefined, thinkingSignature };
          }
          const parsed = this.parseChunk(data);
          if (parsed.usage) {
            usage = parsed.usage;
          }
          if (parsed.thinking) {
            thinking += parsed.thinking;
            onThinking?.(parsed.thinking);
          }
          if (parsed.thinkingSignature) {
            thinkingSignature = parsed.thinkingSignature;
          }
          if (parsed.delta) {
            full += parsed.delta;
            onToken?.(parsed.delta);
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Reader may already be released after an aborted/errored read.
      }
    }

    return { content: full, usage, thinking: thinking || undefined, thinkingSignature };
  }

  private parseChunk(data: string): {
    delta: string;
    thinking?: string;
    thinkingSignature?: string;
    usage?: TokenUsage;
  } {
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string; thinking?: string; thinking_signature?: string } }>;
        usage?: unknown;
      };
      const delta = parsed.choices?.[0]?.delta;
      return {
        delta: typeof delta?.content === 'string' ? delta.content : '',
        thinking: typeof delta?.thinking === 'string' ? delta.thinking : undefined,
        thinkingSignature: typeof delta?.thinking_signature === 'string' ? delta.thinking_signature : undefined,
        usage: parseUsage(parsed)
      };
    } catch {
      this.logger.debug('Skipped an unparseable streaming chunk.');
      return { delta: '' };
    }
  }

  private async request(pathSuffix: string, init: RequestInit): Promise<Response> {
    const token = await this.auth.getToken();
    if (!token) {
      throw new ParleyAuthRequiredError();
    }

    const url = `${this.baseUrl}${pathSuffix}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init.headers ?? {})
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'network error';
      throw new ParleyApiError(0, `Could not reach Parley at ${this.baseUrl} (${message}). Check your network or VPN.`);
    }

    if (!response.ok) {
      throw new ParleyApiError(response.status, await this.describeError(response));
    }

    return response;
  }

  private async describeError(response: Response): Promise<string> {
    let detail = '';
    try {
      const text = await response.text();
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } | string };
        detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? text;
      } catch {
        detail = text;
      }
    } catch {
      detail = '';
    }

    if (response.status === 401 || response.status === 403) {
      return 'Parley rejected the API key (HTTP ' + response.status + '). Run "Parley: Set API Key" to update it.';
    }
    if (response.status === 402) {
      return 'Parley reports insufficient credits or budget (HTTP 402). Contact your MIT IS&T administrator to add credits.';
    }
    if (response.status === 429) {
      return 'Parley rate limit reached (HTTP 429). Please wait a moment and retry.';
    }
    if (response.status === 502) {
      return `The upstream model provider returned an error (HTTP 502)${detail ? `: ${detail.slice(0, 200)}` : ''}. This is usually transient — retry in a moment.`;
    }
    if (isContextLengthError(response.status, detail)) {
      return 'This conversation is too long for the model\'s context window. Run "Parley: Compact Conversation" (⊟) or start a new chat, then retry.';
    }
    return `Parley request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}.`;
  }
}

