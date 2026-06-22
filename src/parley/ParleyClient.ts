import type { Logger } from '../logging/logger';
import { renderPromptWithContext } from '../context/renderPromptWithContext';
import { extractProposedChanges } from '../diff/extractChanges';
import { cleanCompletion, isContextLengthError, parseUsage } from './parsing';
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
const DEFAULT_MAX_TOOL_ROUNDS = 6;

interface OpenAiMessage {
  role: string;
  content?: string | unknown[] | null;
  tool_calls?: ReadonlyArray<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface OpenAiModelList {
  readonly data?: ReadonlyArray<{ readonly id?: string; readonly name?: string; readonly owned_by?: string }>;
}

interface ChatCompletionMessage {
  readonly content?: string | null;
  readonly tool_calls?: ReadonlyArray<{ id: string; type: string; function: { name: string; arguments: string } }>;
}

interface CompletionResult {
  readonly content: string;
  readonly usage?: TokenUsage;
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
    const messages = this.buildMessages(request);
    const effort = request.reasoningEffort || undefined;

    const useTools = Boolean(options?.tools && options.tools.length > 0 && options.runTool);
    const result = useTools
      ? await this.runToolLoop(messages, model, options as SendMessageOptions, effort)
      : await this.singleCompletion(messages, model, options, effort);

    const proposedChanges = await extractProposedChanges(result.content);

    return {
      message: { role: 'assistant', content: result.content, createdAt: new Date().toISOString(), usage: result.usage },
      proposedChanges: proposedChanges.length > 0 ? proposedChanges : undefined,
      usage: result.usage
    };
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
    if (request.reasoningEffort) {
      payload.reasoning_effort = request.reasoningEffort;
    }

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
      body: JSON.stringify({ model: request.model, prompt: request.prompt, n: 1, size: request.size }),
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
    effort?: string
  ): Promise<CompletionResult> {
    const stream = Boolean(options?.onToken);
    const payload: Record<string, unknown> = { model, messages, stream };
    if (effort) {
      payload.reasoning_effort = effort;
    }
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
      return this.readStream(response, options?.onToken);
    }
    const json = await response.json();
    return { content: this.extractContent(json), usage: parseUsage(json) };
  }

  /** Run the OpenAI tool-calling loop until the model answers or rounds run out. */
  private async runToolLoop(
    messages: OpenAiMessage[],
    model: string,
    options: SendMessageOptions,
    effort?: string
  ): Promise<CompletionResult> {
    const convo = [...messages];
    const maxRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;

    let lastUsage: TokenUsage | undefined;
    for (let round = 0; round < maxRounds; round += 1) {
      const roundPayload: Record<string, unknown> = {
        model,
        messages: convo,
        tools: options.tools,
        stream: true,
        stream_options: { include_usage: true }
      };
      if (effort) {
        roundPayload.reasoning_effort = effort;
      }
      const response = await this.request('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(roundPayload),
        signal: options.signal
      });

      // Stream this round live: narration tokens go to onToken; tool calls are
      // reassembled from the streamed deltas. This is what makes the agent's
      // activity appear token-by-token (Claude-Code style).
      const result = await this.streamRound(response, options.onToken);
      if (result.usage) {
        lastUsage = result.usage;
      }

      if (result.toolCalls.length === 0) {
        return { content: result.content, usage: lastUsage };
      }

      convo.push({
        role: 'assistant',
        content: result.content,
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
    const final = await this.singleCompletion(convo, model, { onToken: options.onToken, signal: options.signal }, effort);
    return { content: final.content, usage: final.usage ?? lastUsage };
  }

  /** Stream one chat-completions round, surfacing text via onToken and reassembling tool calls from deltas. */
  private async streamRound(
    response: Response,
    onToken?: (delta: string) => void
  ): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; usage?: TokenUsage }> {
    if (!response.body) {
      const json = (await response.json()) as { choices?: Array<{ message?: ChatCompletionMessage }> };
      const message = json.choices?.[0]?.message;
      const text = typeof message?.content === 'string' ? message.content : '';
      if (text) {
        onToken?.(text);
      }
      const toolCalls = (message?.tool_calls ?? []).map((t) => ({
        id: t.id,
        name: t.function?.name ?? '',
        arguments: t.function?.arguments ?? ''
      }));
      return { content: text, toolCalls, usage: parseUsage(json) };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolMap = new Map<number, { id: string; name: string; arguments: string }>();
    let buffer = '';
    let content = '';
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
            choices?: Array<{ delta?: { content?: string; tool_calls?: Array<Record<string, unknown>> } }>;
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
          }
          const delta = parsed.choices?.[0]?.delta;
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
    return { content, toolCalls, usage };
  }

  private buildMessages(request: ChatRequest): OpenAiMessage[] {
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
        const images = request.images ?? [];
        if (images.length > 0) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text },
              ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUri } }))
            ]
          });
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

  private async readStream(response: Response, onToken?: (delta: string) => void): Promise<CompletionResult> {
    if (!response.body) {
      const json = await response.json();
      return { content: this.extractContent(json), usage: parseUsage(json) };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
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
            return { content: full, usage };
          }
          const parsed = this.parseChunk(data);
          if (parsed.usage) {
            usage = parsed.usage;
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

    return { content: full, usage };
  }

  private parseChunk(data: string): { delta: string; usage?: TokenUsage } {
    try {
      const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }>; usage?: unknown };
      const delta = parsed.choices?.[0]?.delta?.content;
      return { delta: typeof delta === 'string' ? delta : '', usage: parseUsage(parsed) };
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
    if (response.status === 429) {
      return 'Parley rate limit reached (HTTP 429). Please wait a moment and retry.';
    }
    if (isContextLengthError(response.status, detail)) {
      return 'This conversation is too long for the model\'s context window. Run "Parley: Compact Conversation" (⊟) or start a new chat, then retry.';
    }
    return `Parley request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}.`;
  }
}

