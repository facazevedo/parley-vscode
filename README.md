# Parley for VS Code

`parley-vscode` is a Visual Studio Code extension for chatting with MIT Parley
coding models from inside the editor — a Cursor-like sidebar with streaming
replies, workspace context attachment, and diff-reviewed edits. It is built
around a provider abstraction so the UI, context collection, diff review, and
safety controls stay independent of transport.

## Current Integration Status

Parley exposes an **OpenAI-compatible API** at `https://parley.api.mit.edu/v1`,
authenticated with a personal `sk-parley-…` key. The extension talks to it
directly — no browser/Touchstone step is needed for the API itself. Touchstone
only gates the Parley web app at `parley.mit.edu`, which is where you create your
API key (**Settings → API Keys**).

See [API_DISCOVERY.md](API_DISCOVERY.md) for the full API reference (endpoints,
model IDs, streaming format).

## Getting Started

1. Create an API key at [parley.mit.edu](https://parley.mit.edu) → Settings → API Keys.
2. In VS Code run **`Parley: Set API Key`** and paste it (stored in `SecretStorage`).
3. Open the Parley sidebar, pick a model from the dropdown, and start chatting.

## Features

- **Streaming chat sidebar** with a model picker, Markdown + code rendering, **Stop**, and **+ New** conversation.
- **Inline (ghost-text) completions** as you type, powered by a fast model. Toggle with `Parley: Toggle Inline Completion`.
- **Agent mode** (chat **Agent** toggle): the model uses read-only tools — `read_file`, `list_directory`, `find_files` — to gather its own context. Edits still go through diff review; nothing is written or executed automatically.
- **File & image attachments**: the 📎 button attaches text files (as context) or images (sent as multimodal input to vision-capable models).
- **Image generation** via `gpt-image-1` (`Parley: Generate Image`) — saved into `parley-images/` and opened.
- **Diff-reviewed edits**: proposed file changes open in a VS Code diff and require explicit acceptance before applying.
- Editor commands route into the chat panel and stream their reply:
  - `Parley: Ask About Selection`
  - `Parley: Explain Current File`
  - `Parley: Refactor Selection`
  - `Parley: Generate Tests`
  - `Parley: Fix Diagnostics`
  - `Parley: Suggest Terminal Command`
- Plus `Parley: Generate Image`, `Parley: Toggle Inline Completion`, `Parley: Set API Key`, `Parley: Open Chat Window`, and `Parley: Sign Out`.
- Minimal context sharing by default, with preview before sending large context.
- Sensitive file filtering for `.env`, `.npmrc`, `.pypirc`, private keys, PEM files, `secrets.*`, and hidden files (also enforced on agent-mode file reads).
- `.parleyignore` support, plus optional `.gitignore` respect.
- Terminal suggestions are shown for confirmation and inserted into a terminal without automatic execution.

## Development

Install Node.js supported by the current VS Code extension tooling, then run:

```bash
npm install
npm run compile
npm test
```

Open the folder in VS Code and press `F5` to start an Extension Development Host.

## Settings

- `parley.endpoint`: Parley API base URL. Defaults to `https://parley.api.mit.edu/v1`.
- `parley.defaultAgent`: Default model identifier, e.g. `bedrock/claude-sonnet-4-6`.
- `parley.stream`: Stream replies token-by-token in the chat view (default `true`).
- `parley.agentMode`: Default state of the chat **Agent** toggle (default `false`).
- `parley.inlineCompletion.enabled`: Show inline ghost-text completions (default `true`).
- `parley.inlineCompletion.model`: Model for completions (default `openai/gpt-5-nano`; prefer a fast one).
- `parley.inlineCompletion.debounceMs`: Idle delay before requesting a completion (default `350`).
- `parley.context.maxCharacters`: Maximum context size.
- `parley.context.includeDiagnostics`: Include diagnostics when requested.
- `parley.context.respectGitignore`: Respect `.gitignore` while collecting file context.
- `parley.confirmBeforeSendingLargeContext`: Preview context before sending.
- `parley.telemetry.enabled`: Defaults to `false`; no telemetry is currently emitted.
- `parley.logLevel`: `error`, `warn`, `info`, or `debug`.

## Packaging

The project uses the current VS Code packaging tool, `@vscode/vsce`:

```bash
npm install
npm run compile
npm run package
```

This creates a `.vsix` file that can be installed with:

```bash
code --install-extension parley-vscode-0.3.0.vsix
```

## Architecture

The official client lives in `src/parley/ParleyClient.ts` behind the
`ParleyProvider` interface; the command, context, webview, and diff layers are
transport-agnostic. The API key is stored in VS Code `SecretStorage`;
credentials and request headers are never logged.

## Docking Like Codex

VS Code does not let third-party extensions contribute directly to the Secondary Side Bar by default. To place Parley there:

1. Run `Parley: Open Chat Window`.
2. Run `View: Toggle Secondary Side Bar Visibility` if the secondary bar is hidden.
3. Drag the `Chat` view header from the Parley sidebar into the Secondary Side Bar.

VS Code remembers that layout after you move it.
