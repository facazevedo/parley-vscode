import * as vscode from 'vscode';
import { normalizeThinkingLevel, type ThinkingLevel } from '../parley/thinking';

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
  readonly autoContinue: boolean;
  readonly maxToolRounds: number;
  readonly maxAutoContinue: number;
  readonly tokenLimit: number;
  readonly autoCompactTokens: number;
  readonly autoCompactPercent: number;
  readonly autoSaveConversations: boolean;
  readonly conversationsDir: string;
  readonly inlineCompletionEnabled: boolean;
  readonly inlineCompletionModel: string;
  readonly inlineCompletionDebounceMs: number;
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
    autoContinue: config.get<boolean>('autoContinue', true),
    maxToolRounds: clampInt(config.get<number>('maxToolRounds', 25), 1, 200),
    maxAutoContinue: clampInt(config.get<number>('maxAutoContinue', 25), 0, 200),
    tokenLimit: Math.max(0, Math.floor(config.get<number>('tokenLimit', 0))),
    autoCompactTokens: Math.max(0, Math.floor(config.get<number>('autoCompactTokens', 0))),
    autoCompactPercent: clampInt(config.get<number>('autoCompactPercent', 80), 0, 100),
    autoSaveConversations: config.get<boolean>('autoSaveConversations', true),
    conversationsDir: config.get<string>('conversationsDir', '').trim(),
    inlineCompletionEnabled: inline.get<boolean>('enabled', true),
    inlineCompletionModel: inline.get<string>('model', DEFAULT_COMPLETION_MODEL).trim() || DEFAULT_COMPLETION_MODEL,
    inlineCompletionDebounceMs: inline.get<number>('debounceMs', 350),
    videoMaxFrames: clampInt(video.get<number>('maxFrames', 12), 1, 60),
    videoFrameWidth: clampInt(video.get<number>('frameWidth', 768), 128, 2048),
    videoMaxAudioSeconds: clampInt(video.get<number>('maxAudioSeconds', 600), 5, 7200),
    videoFfmpegPath: video.get<string>('ffmpegPath', '').trim(),
    contextMaxCharacters: context.get<number>('maxCharacters', 12000),
    includeDiagnostics: context.get<boolean>('includeDiagnostics', true),
    respectGitignore: context.get<boolean>('respectGitignore', true),
    confirmBeforeSendingLargeContext: config.get<boolean>('confirmBeforeSendingLargeContext', true),
    telemetryEnabled: telemetry.get<boolean>('enabled', false),
    logLevel: config.get<LogLevel>('logLevel', 'info')
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number.isFinite(value) ? value : min)));
}

function normalizeMode(value: string): ChatMode {
  return value === 'ask' || value === 'edit' || value === 'plan' || value === 'auto' || value === 'full' ? value : 'chat';
}
