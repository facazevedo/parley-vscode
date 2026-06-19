import * as vscode from 'vscode';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export const DEFAULT_ENDPOINT = 'https://parley.api.mit.edu/v1';
export const DEFAULT_MODEL = 'bedrock/claude-sonnet-4-6';
export const DEFAULT_COMPLETION_MODEL = 'openai/gpt-5-nano';

export interface ParleySettings {
  readonly endpoint: string;
  readonly defaultAgent: string;
  readonly stream: boolean;
  readonly agentMode: boolean;
  readonly inlineCompletionEnabled: boolean;
  readonly inlineCompletionModel: string;
  readonly inlineCompletionDebounceMs: number;
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

  return {
    endpoint: config.get<string>('endpoint', DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT,
    defaultAgent: config.get<string>('defaultAgent', DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    stream: config.get<boolean>('stream', true),
    agentMode: config.get<boolean>('agentMode', false),
    inlineCompletionEnabled: inline.get<boolean>('enabled', true),
    inlineCompletionModel: inline.get<string>('model', DEFAULT_COMPLETION_MODEL).trim() || DEFAULT_COMPLETION_MODEL,
    inlineCompletionDebounceMs: inline.get<number>('debounceMs', 350),
    contextMaxCharacters: context.get<number>('maxCharacters', 12000),
    includeDiagnostics: context.get<boolean>('includeDiagnostics', true),
    respectGitignore: context.get<boolean>('respectGitignore', true),
    confirmBeforeSendingLargeContext: config.get<boolean>('confirmBeforeSendingLargeContext', true),
    telemetryEnabled: telemetry.get<boolean>('enabled', false),
    logLevel: config.get<LogLevel>('logLevel', 'info')
  };
}
