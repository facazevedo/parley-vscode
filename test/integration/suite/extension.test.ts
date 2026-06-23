import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'mit-parley-community.parley-vscode';

const EXPECTED_COMMANDS = [
  'parley.setApiKey',
  'parley.openChatWindow',
  'parley.askSelection',
  'parley.exportConversation',
  'parley.compactConversation',
  'parley.openPastConversation',
  'parley.regenerate',
  'parley.inlineEdit',
  'parley.revertLastEdit',
  'parley.revertAll',
  'parley.generateImage',
  'parley.toggleInlineCompletion',
  'parley.setTokenLimit',
  'parley.showUsage',
  'parley.runDiagnostics',
  'parley.initProjectRules',
  'parley.signOut'
];

describe('Parley extension', () => {
  it('is present and activates', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be installed`);
    await ext.activate();
    assert.strictEqual(ext.isActive, true, 'extension should activate');
  });

  it('registers all contributed commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of EXPECTED_COMMANDS) {
      assert.ok(commands.includes(command), `command ${command} should be registered`);
    }
  });

  it('exposes the chat webview view container', () => {
    // The view is contributed in package.json; activation registers its provider.
    assert.ok(vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON.contributes.views.parley);
  });
});
