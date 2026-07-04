import * as vscode from 'vscode';
import { normalizeThinkingLevel, type ThinkingLevel } from '../parley/thinking';
import type { HooksConfig } from '../hooks/hooks';
import type { McpServerConfig } from '../mcp/McpManager';
import type { WebSearchProvider } from '../web/webSearch';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export const DEFAULT_ENDPOINT = 'https://parley.api.mit.edu/v1';
export const DEFAULT_MODEL = 'bedrock/claude-sonnet-4-6';
export const DEFAULT_COMPLETION_MODEL = 'openai/gpt-5-nano';

/**
 * Chat interaction mode (Cursor/Claude-style):
 * - `chat`  — answer only; no file tools
 * - `ask`   — agent tools; approve each edit
 * - `edit`  — agent tools; apply edits automatically (revertible)
 * - `plan`  — agent reads the repo read-only and proposes a plan; no changes
 * - `auto`  — agent decides and applies edits automatically
 * - `full`  — CAUTION: auto-applies edits AND runs shell commands without asking
 */
export type ChatMode = 'chat' | 'ask' | 'edit' | 'plan' | 'auto' | 'full';

export interface ParleySettings {
  readonly endpoint: string;
  readonly defaultAgent: string;
  readonly stream: boolean;
  readonly thinking: ThinkingLevel;
  readonly defaultMode: ChatMode;
  /** Output-style id prepended to the system prompt (built-in or custom); '' / 'default' = none. */
  readonly outputStyle: string;
  /** Scan outbound context + tool results for secrets: redact (default), warn, or off. */
  readonly secretScanning: 'redact' | 'warn' | 'off';
  readonly autoContinue: boolean;
  readonly maxToolRounds: number;
  readonly maxAutoContinue: number;
  readonly tokenLimit: number;
  /** Warn once per conversation when the estimated session spend crosses this USD amount (0 = off). */
  readonly usageWarnUsd: number;
  /** Status-bar ticker with the sidebar conversation's tokens/cost. */
  readonly statusBarEnabled: boolean;
  /** The shell command `/verify` runs ('' = auto-detect). */
  readonly verifyCommand: string;
  /** Transient "Fix with Parley" status-bar hint when a terminal command fails. */
  readonly terminalFixHintEnabled: boolean;
  /** Model used to transcribe voice input ('' = the current chat model). */
  readonly voiceModel: string;
  /** Read replies aloud automatically when a turn finishes. */
  readonly voiceAutoRead: boolean;
  /** Play a soft chime when a turn finishes while the window is unfocused. */
  readonly chimeOnDone: boolean;
  /** Allow `/computer` to control the real mouse and keyboard (off by default). */
  readonly computerUseEnabled: boolean;
  /** Max steps in one `/computer` run. */
  readonly computerUseMaxSteps: number;
  /** Which control backend `/computer` uses: 'auto' | 'nutjs' | 'powershell'. */
  readonly computerUseBackend: string;
  /** Confirm each computer-use action before it runs (training wheels). */
  readonly computerUseConfirmEach: boolean;
  readonly autoCompactTokens: number;
  readonly autoCompactPercent: number;
  readonly autoSaveConversations: boolean;
  readonly conversationsDir: string;
  readonly commandTimeoutSeconds: number;
  /** Explicit test command for run_tests / Fix Failing Tests. Empty = auto-detect. */
  readonly testCommand: string;
  readonly mcpServers: Record<string, McpServerConfig>;
  readonly hooks: HooksConfig;
  readonly webSearchProvider: WebSearchProvider;
  readonly webSearchApiKey: string;
  readonly webSearchGoogleCx: string;
  readonly codebaseSearchEnabled: boolean;
  readonly codebaseSearchProvider: 'lexical' | 'local';
  readonly codebaseMaxFiles: number;
  readonly inlineCompletionEnabled: boolean;
  readonly inlineCompletionModel: string;
  readonly inlineCompletionDebounceMs: number;
  /** Language IDs where inline completion is suppressed (e.g. ["markdown", "plaintext"]). */
  readonly inlineCompletionDisabledLanguages: string[];
  readonly inlineCompletionMaxPrefixChars: number;
  readonly inlineCompletionMaxSuffixChars: number;
  readonly videoMaxFrames: number;
  readonly videoFrameWidth: number;
  readonly videoMaxAudioSeconds: number;
  readonly videoFfmpegPath: string;
  readonly contextMaxCharacters: number;
  readonly includeDiagnostics: boolean;
  readonly respectGitignore: boolean;
  readonly confirmBeforeSendingLargeContext: boolean;
  readonly telemetryEnabled: boolean;
  readonly logLevel: LogLevel;
}

export function getSettings(): ParleySettings {
  const config = vscode.workspace.getConfiguration('parley');
  const context = vscode.workspace.getConfiguration('parley.context');
  const telemetry = vscode.workspace.getConfiguration('parley.telemetry');
  const inline = vscode.workspace.getConfiguration('parley.inlineCompletion');
  const video = vscode.workspace.getConfiguration('parley.video');

  return {
    endpoint: config.get<string>('endpoint', DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT,
    defaultAgent: config.get<string>('defaultAgent', DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    stream: config.get<boolean>('stream', true),
    thinking: normalizeThinkingLevel(config.get<string>('thinking', 'off')),
    defaultMode: normalizeMode(config.get<string>('defaultMode', 'chat')),
    outputStyle: config.get<string>('outputStyle', 'default').trim() || 'default',
    secretScanning: normalizeSecretScanning(config.get<string>('secretScanning', 'redact')),
    autoContinue: config.get<boolean>('autoContinue', true),
    maxToolRounds: clampInt(config.get<number>('maxToolRounds', 50), 1, 400),
    maxAutoContinue: clampInt(config.get<number>('maxAutoContinue', 25), 0, 200),
    tokenLimit: Math.max(0, Math.floor(config.get<number>('tokenLimit', 0))),
    usageWarnUsd: Math.max(0, config.get<number>('usageWarnUsd', 0) || 0),
    statusBarEnabled: config.get<boolean>('statusBar.enabled', true),
    verifyCommand: config.get<string>('verifyCommand', '').trim(),
    terminalFixHintEnabled: config.get<boolean>('terminalFixHint.enabled', true),
    voiceModel: config.get<string>('voice.model', '').trim(),
    voiceAutoRead: config.get<boolean>('voice.autoRead', false),
    chimeOnDone: config.get<boolean>('sound.chimeOnDone', false),
    computerUseEnabled: config.get<boolean>('computerUse.enabled', false),
    computerUseMaxSteps: Math.max(1, Math.min(100, config.get<number>('computerUse.maxSteps', 25))),
    computerUseBackend: config.get<string>('computerUse.backend', 'auto'),
    computerUseConfirmEach: config.get<boolean>('computerUse.confirmEachAction', false),
    autoCompactTokens: Math.max(0, Math.floor(config.get<number>('autoCompactTokens', 0))),
    autoCompactPercent: clampInt(config.get<number>('autoCompactPercent', 80), 0, 100),
    autoSaveConversations: config.get<boolean>('autoSaveConversations', true),
    conversationsDir: config.get<string>('conversationsDir', '').trim(),
    commandTimeoutSeconds: clampInt(config.get<number>('commandTimeoutSeconds', 300), 5, 3600),
    testCommand: config.get<string>('testCommand', '').trim(),
    mcpServers: config.get<Record<string, McpServerConfig>>('mcpServers', {}) ?? {},
    hooks: config.get<HooksConfig>('hooks', {}) ?? {},
    webSearchProvider: normalizeWebSearchProvider(config.get<string>('webSearch.provider', 'duckduckgo')),
    webSearchApiKey: config.get<string>('webSearch.apiKey', '').trim(),
    webSearchGoogleCx: config.get<string>('webSearch.googleCx', '').trim(),
    codebaseSearchEnabled: config.get<boolean>('codebaseSearch.enabled', true),
    codebaseSearchProvider: config.get<string>('codebaseSearch.provider', 'lexical') === 'local' ? 'local' : 'lexical',
    codebaseMaxFiles: clampInt(config.get<number>('codebaseSearch.maxFiles', 4), 1, 20),
    inlineCompletionEnabled: inline.get<boolean>('enabled', true),
    inlineCompletionModel: inline.get<string>('model', DEFAULT_COMPLETION_MODEL).trim() || DEFAULT_COMPLETION_MODEL,
    inlineCompletionDebounceMs: clampInt(inline.get<number>('debounceMs', 350), 0, 60000),
    inlineCompletionDisabledLanguages: (inline.get<string[]>('disabledLanguages', []) ?? [])
      .filter((l) => typeof l === 'string' && l.trim().length > 0)
      .map((l) => l.trim()),
    inlineCompletionMaxPrefixChars: clampInt(inline.get<number>('maxPrefixChars', 2000), 200, 8000),
    inlineCompletionMaxSuffixChars: clampInt(inline.get<number>('maxSuffixChars', 1000), 100, 4000),
    videoMaxFrames: clampInt(video.get<number>('maxFrames', 12), 1, 60),
    videoFrameWidth: clampInt(video.get<number>('frameWidth', 768), 128, 2048),
    videoMaxAudioSeconds: clampInt(video.get<number>('maxAudioSeconds', 600), 5, 7200),
    videoFfmpegPath: video.get<string>('ffmpegPath', '').trim(),
    contextMaxCharacters: clampInt(context.get<number>('maxCharacters', 12000), 500, 500000),
    includeDiagnostics: context.get<boolean>('includeDiagnostics', true),
    respectGitignore: context.get<boolean>('respectGitignore', true),
    confirmBeforeSendingLargeContext: config.get<boolean>('confirmBeforeSendingLargeContext', true),
    telemetryEnabled: telemetry.get<boolean>('enabled', false),
    logLevel: config.get<LogLevel>('logLevel', 'info')
  };
}

function normalizeWebSearchProvider(value: string): WebSearchProvider {
  return value === 'off' || value === 'google' || value === 'tavily' ? value : 'duckduckgo';
}

function normalizeSecretScanning(value: string): 'redact' | 'warn' | 'off' {
  return value === 'warn' || value === 'off' ? value : 'redact';
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number.isFinite(value) ? value : min)));
}

function normalizeMode(value: string): ChatMode {
  return value === 'ask' || value === 'edit' || value === 'plan' || value === 'auto' || value === 'full'
    ? value
    : 'chat';
}
