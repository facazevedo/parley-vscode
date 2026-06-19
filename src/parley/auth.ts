import * as vscode from 'vscode';

const TOKEN_KEY = 'parley.apiToken';

export class ParleyAuthStore {
  public constructor(private readonly secrets: vscode.SecretStorage) {}

  public getToken(): Thenable<string | undefined> {
    return this.secrets.get(TOKEN_KEY);
  }

  public async setToken(token: string): Promise<void> {
    await this.secrets.store(TOKEN_KEY, token);
  }

  public async clear(): Promise<void> {
    await this.secrets.delete(TOKEN_KEY);
  }
}
