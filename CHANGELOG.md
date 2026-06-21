# Changelog

## 0.5.0

### Added
- Export the conversation: a ⤓ toolbar button and `Parley: Export Conversation` command save the whole chat as Markdown or JSON. Each assistant reply is tagged with the model that produced it (works across any/mixed models).

## 0.4.0

### Added
- Reasoning-effort control: `parley.reasoningEffort` setting plus an **Effort** dropdown in the chat toolbar (Default/Minimal/Low/Medium/High). Sent to the API as `reasoning_effort` for chat, agent-mode, and inline completions. Note: the Parley proxy accepts the parameter, but observable effect varies by model.

## 0.3.2

### Changed
- Redesigned the chat UI to match modern assistants (Claude/Codex): removed the uppercase USER/ASSISTANT role labels; your message is now a subtle rounded card and the reply is plain flowing text. Inline `code` renders as chips, with roomier spacing and code-block styling.

## 0.3.1

### Fixed
- Chat view showed "There is no data provider registered that can provide view data." The `parley.chatView` contribution was missing `"type": "webview"`, so VS Code treated it as a tree view and ignored the registered `WebviewViewProvider`. (Bug inherited from the original scaffold.)
- Added explicit `onView:parley.chatView` activation event.

## 0.3.0

### Added
- **Inline (ghost-text) completions** via a `vscode.InlineCompletionItemProvider` using a fast model (`parley.inlineCompletion.*` settings) and `Parley: Toggle Inline Completion`.
- **Agent mode**: an opt-in chat toggle that gives the model read-only workspace tools (`read_file`, `list_directory`, `find_files`) through an OpenAI tool-calling loop, so it can gather its own context. Edits still go through diff review; no writes or command execution.
- **File & image attachments** in the chat (📎): text files become context; images are sent as multimodal `image_url` content to vision-capable models.
- **Image generation** with `gpt-image-1` (`Parley: Generate Image`), saved to `parley-images/` and opened.
- `ParleyProvider.complete()` and `generateImage()`; `parley.agentMode` setting.
- Official Parley feather branding: a full-color extension logo (`resources/icon.png`) shown in the Extensions list/Marketplace, and a matching monochrome feather glyph for the Activity Bar.

## 0.2.0

### Added
- Implemented the real `ParleyClient` against the OpenAI-compatible MIT Parley API (`https://parley.api.mit.edu/v1`), replacing the disabled stub.
- `Parley: Set API Key` with `SecretStorage` storage and live key verification.
- Live token streaming in the chat view with Stop and New-conversation controls, Markdown/code rendering, model picker (`GET /v1/models`), and conversation history.
- Proposed edits parsed from API responses (whole-file `File:` blocks and unified diffs) flow into the existing diff-review-before-apply step; shared parser in `src/diff/extractChanges.ts`.
- `parley.stream` setting; updated `parley.endpoint`/`parley.defaultAgent` defaults to the live API and a real model.

### Changed
- The official API is now the only provider; editor commands (ask, explain, refactor, generate tests, fix diagnostics) stream their replies into the chat panel instead of a truncated popup.
- Replaced API discovery notes with a real API reference.

### Removed
- Removed the legacy "no API" workaround layer: the clipboard/website handoff commands (`Copy Prompt for Website`, `Copy Repository Context for Website`, `Import Website Response`), the `Manual Login Workflow`, the `Open MIT Parley Website` command, the `parley.websiteUrl` setting, and the offline mock provider.

## 0.1.0

- Initial VS Code extension scaffold.
- Added Parley activity-bar chat view.
- Added `Parley: Open Chat Window` command to focus the Parley chat view for docking into the Secondary Side Bar.
- Added `Parley: Open MIT Parley Website` command and sidebar button for safe browser-based Touchstone login.
- Registered on VS Code startup so docked Parley views get a webview provider more reliably.
- Added `Parley: Copy Prompt for Website` for a safe browser handoff while no official API is available.
- Added `Parley: Copy Repository Context for Website` for explicit repo snapshot handoff with ignore and secret filters.
- Added `Parley: Import Website Response` to turn copied Parley answers into reviewable VS Code diffs.
- Added command palette commands for selection, file explanation, refactoring, test generation, diagnostics fixing, terminal command suggestions, and sign-out.
- Added mock Parley provider and disabled official provider boundary.
- Added context preview, sensitive file filtering, `.parleyignore`, and optional `.gitignore` support.
- Added diff review and explicit apply workflow for proposed file changes.
- Added API discovery, security, privacy, and packaging documentation.
- Added unit tests for sensitive file filtering, ignore matching, selection context creation, and patch parsing.
