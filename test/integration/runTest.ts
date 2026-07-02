import * as path from 'path';
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    // The folder containing package.json (extension root): out/test/integration -> ../../../
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const downloadedPath = await downloadAndUnzipVSCode({ extensionDevelopmentPath });
    const vscodeExecutablePath =
      process.platform === 'win32' ? resolveCliPathFromVSCodeExecutablePath(downloadedPath) : downloadedPath;
    await runTests({ extensionDevelopmentPath, extensionTestsPath, vscodeExecutablePath });
  } catch (err) {
    console.error('Failed to run integration tests:', err);
    process.exit(1);
  }
}

void main();
