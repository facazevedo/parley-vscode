import * as vscode from 'vscode';
import type { LogLevel } from '../config/settings';

const rank: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

export class Logger implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('Parley');
  private level: LogLevel = 'info';

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  public error(message: string, error?: unknown): void {
    this.write('error', message, error);
  }

  public warn(message: string): void {
    this.write('warn', message);
  }

  public info(message: string): void {
    this.write('info', message);
  }

  public debug(message: string): void {
    this.write('debug', message);
  }

  public dispose(): void {
    this.channel.dispose();
  }

  private write(level: LogLevel, message: string, error?: unknown): void {
    if (rank[level] > rank[this.level]) {
      return;
    }

    const suffix = error instanceof Error ? `: ${error.name}: ${error.message}` : '';
    this.channel.appendLine(`[${new Date().toISOString()}] [${level}] ${message}${suffix}`);
  }
}
