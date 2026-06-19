import type { Logger } from '../logging/logger';
import { renderPromptWithContext } from '../context/renderPromptWithContext';
import { extractProposedChanges } from '../diff/extractChanges';
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
  type ImageResult
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

    const useTools = Boolean(options?.tools && options.tools.length > 0 && options.runTool);
    const content = useTools
      ? await this.runToolLoop(messages, model, options as SendMessageOptions)
      : await this.singleCompletion(messages, model, options);

    const proposedChanges = await extractProposedChanges(content);

    return {
      message: { role: 'assistant', content, createdAt: new Date().toISOString() },
      proposedChanges: proposedChanges.length > 0 ? proposedChanges : undefined
    };
  }

  public async complete(request: CompletionRequest, signal?: AbortSignal): Promise<string> {
    const userPrompt =
      `Language: ${request.languageId}\n` +
      `Insert code at <CURSOR>. Reply with only the text to insert.\n\n` +
      `${request.prefix}<CURSOR>${request.suffix}`;

    const response = await this.request('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: [
          { role: 'system', content: COMPLETION_SYSTEM },
          { role: 'user', content: userPrompt }
        ],
        stream: false
      }),
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

  private async singleCompletion(messages: OpenAiMessage[], model: string, options?: SendMessageOptions): Promise<string> {
    const stream = Boolean(options?.onToken);
    const response = await this.request('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream }),
      signal: options?.signal
    });

    return stream ? this.readStream(response, options?.onToken) : this.extractContent(await response.json());
  }

  /** Run the OpenAI tool-calling loop until the model answers or rounds run out. */
  private async runToolLoop(messages: OpenAiMessage[], model: string, options: SendMessageOptions): Promise<string> {
    const convo = [...messages];
    const maxRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;

    for (let round = 0; round < maxRounds; round += 1) {
      const response = await this.request('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: convo, tools: options.tools, stream: false }),
        signal: options.signal
      });

      const json = (await response.json()) as { choices?: Array<{ message?: ChatCompletionMessage }> };
      const message = json.choices?.[0]?.message;
      const toolCalls = message?.tool_calls ?? [];

      if (toolCalls.length === 0) {
        const content = typeof message?.content === 'string' ? message.content : '';
        options.onToken?.(content);
        return content;
      }

      convo.push({ role: 'assistant', content: message?.content ?? '', tool_calls: toolCalls });
      for (const call of toolCalls) {
        const args = call.function?.arguments ?? '{}';
        options.onToolEvent?.({ name: call.function?.name ?? 'tool', args });
        let result: string;
        try {
          result = await options.runTool!({ id: call.id, name: call.function?.name ?? '', arguments: args });
        } catch (error) {
          result = `Error: ${error instanceof Error ? error.message : 'tool failed'}`;
        }
        convo.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, MAX_TOOL_RESULT_CHARS) });
      }
    }

    // Out of tool rounds: ask once more without tools so the model commits to an answer.
    this.logger.debug(`Tool loop hit ${maxRounds} rounds; requesting a final answer.`);
    return this.singleCompletion(convo, model, { onToken: options.onToken, signal: options.signal });
  }

  private buildMessages(request: ChatRequest): OpenAiMessage[] {
    const messages: OpenAiMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

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

  private async readStream(response: Response, onToken?: (delta: string) => void): Promise<string> {
    if (!response.body) {
      return this.extractContent(await response.json());
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

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
            return full;
          }
          const delta = this.extractDelta(data);
          if (delta) {
            full += delta;
            onToken?.(delta);
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

    return full;
  }

  private extractDelta(data: string): string {
    try {
      const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      const delta = parsed.choices?.[0]?.delta?.content;
      return typeof delta === 'string' ? delta : '';
    } catch {
      this.logger.debug('Skipped an unparseable streaming chunk.');
      return '';
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
    return `Parley request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}.`;
  }
}

/** Strip code fences and stray commentary a model may wrap around a completion. */
function cleanCompletion(raw: string): string {
  let text = raw;
  const fenceMatch = text.match(/^```[\w.+-]*\n([\s\S]*?)```\s*$/);
  if (fenceMatch) {
    text = fenceMatch[1];
  }
  return text.replace(/\s+$/, '');
}
