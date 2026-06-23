# Changelog

## 0.15.0

### Added
- **Audio input.** Attach a `.wav` or `.mp3` (via 📎, paste, or drag-and-drop) and it's sent as a multimodal `input_audio` block. Audio works only on OpenAI and Google models, so Parley warns if you attach audio to a Bedrock/Anthropic model. Completes multimodal support (image + PDF + audio). New pure, tested `src/parley/audio.ts`.
- **Image-generation quality.** `Parley: Generate Image` now asks for a quality (`auto` / `low` / `medium` / `high`) and passes it to `gpt-image-1`.
- **Friendlier errors** for HTTP **402** (insufficient credits/budget) and **502** (upstream provider error), per the Error Handling docs.

### Engineering
- 3 new unit tests for audio classification/gating (now 34 unit tests).

## 0.14.0

### Added
- **Exact token counting for auto-compaction.** When `parley.autoCompactTokens` is set, the conversation size is now measured with Parley's `/v1/messages/count_tokens` endpoint (exact) instead of a character heuristic, falling back to the heuristic if the endpoint is unavailable.
- **PDF attachments.** Attach a `.pdf` (via 📎, paste, or drag-and-drop) and Parley routes it correctly per provider: OpenAI/Google models **upload it to `/v1/files`** and reference it by id; Bedrock/Anthropic models receive it **inline** as a base64 `document` block. (OpenAI/Google file limits: 20 files/account, 48-hour expiry.)
- **Structured JSON output.** A new **`/json`** slash command makes the next reply a JSON object (`response_format: { type: "json_object" }`). OpenAI and Gemini use native constrained decoding; Bedrock/Anthropic are best-effort.

### Engineering
- New pure `src/parley/files.ts` (document provider routing) with tests; new `ParleyProvider.countTokens`; 31 unit tests.

## 0.13.0

### Added
- **Estimated cost.** The session counter in the chat header now shows an estimated USD cost (e.g. `· 12,345 tok · ~$0.04`) alongside tokens, accumulated per turn from the published Parley per-model rates and persisted with the conversation. Llama 4 Maverick shows `$0.00` (free); unknown models show tokens only. New pure, unit-tested `src/parley/pricing.ts`.
- **Paste & drop images.** Paste a screenshot (Ctrl/Cmd+V) or drag-and-drop an image file directly onto the composer to attach it to the next turn — no file dialog needed. The drop target highlights while dragging; oversized images (>~12 MB) are rejected with a warning.

### Engineering
- 5 new unit tests for the pricing/rate table (now 29 unit tests).

## 0.12.0

### Added
- **Extended thinking (reasoning).** Replaces the old no-op "reasoning effort" control with real support for Parley's `thinking` parameter. Choose **Off / Adaptive / Low / Med / High** from the composer's **Mode** popover (or `parley.thinking`). Enabled levels send a fixed reasoning budget (4,096 / 8,192 / 16,000 tokens) and automatically raise `max_tokens` to leave room for the answer; **Adaptive** lets the model decide. The reasoning streams live into a collapsible **💭 Thinking** panel above each reply and persists with the conversation. Supported on Claude, OpenAI reasoning models, and Gemini.
- Bedrock **Claude Opus 4.7** only supports adaptive thinking, so an "enabled" budget request to that model is transparently coerced to adaptive.
- Thinking blocks (and their signatures) are now preserved across tool-call rounds so providers that require them (Bedrock Claude) accept follow-up requests.

### Removed
- The `parley.reasoningEffort` setting and the `reasoning_effort` request parameter, which the Parley gateway does not honor. Use `parley.thinking` instead.

### Fixed
- **CI** now runs on Node 22 so `node --test`'s glob pattern expands (it was failing on Node 20, which lacks glob support in the test runner).

### Engineering
- New pure, unit-tested `src/parley/thinking.ts` (level → wire config + provider quirks); 24 unit tests.

## 0.11.0

### Added
- **Per-hunk accept/reject.** Reviewing a multi-change edit (Ask mode or `Ctrl+Alt+K` inline edit) now offers **Apply All / Choose… / Reject** — "Choose…" is a multi-select of the individual hunks, applying only the ones you pick. Built on a new pure line-diff engine (`src/diff/lineDiff.ts`).

### Engineering
- Unit tests for the line-diff/hunk engine (now 17 unit tests).
- **VS Code integration tests** (`@vscode/test-electron` + Mocha) that launch a real VS Code, activate the extension, and assert every command is registered — run in CI under `xvfb`.

## 0.10.0

### Added
- **Changed-files summary** after an agent turn ("✏️ Changed N files: …") and **`Parley: Revert All Edits`** to undo a whole turn's changes.
- **Slash commands** in the composer — `/clear`, `/compact`, `/help` — and **`Parley: Regenerate Last Response`**.
- **Auto-compaction** (`parley.autoCompactTokens`, opt-in) — summarize the conversation before a turn once it exceeds the configured token estimate, to control cost and avoid context-window errors.
- **Marketplace / Open VSX publishing** wired into the release workflow (gated on `VSCE_PAT` / `OVSX_PAT` repo secrets; no-ops until set).

### Changed / fixed
- **Stop now kills a running shell command** (the child process is aborted), not just the API request.
- **The agent loop trims stale tool outputs** automatically, so long multi-step turns stop re-sending old file dumps — cheaper and less likely to overflow context.
- **`edit_file` is whitespace-tolerant** — if an exact snippet match fails, it falls back to matching by trimmed lines (handles indentation/trailing-space differences).
- **Warns** when you attach an image to a model that likely lacks vision (Claude/Gemini/GPT-5 are vision-capable).

### Deferred
- Per-hunk accept/reject inline diff (needs a custom diff UI) and full VS Code integration tests in CI (headless-Electron infra) — noted as future work.

## 0.9.8

### Added
- **Persistent session token total** in the header (tokens used in the current conversation), updated live and reset on New/Open.
- **Token limit** per conversation — `parley.tokenLimit` and a `Parley: Set Token Limit` command. **Default `0` = unlimited.** When reached, Parley stops auto-continuing and asks you to raise it or start fresh.
- Configurable caps: `parley.maxToolRounds` (default 25) and `parley.maxAutoContinue` (default 25; `0` disables auto-continue).

## 0.9.7

### Added
- **Live elapsed timer** in the status line (e.g. `Working… (0:42) · 1,240 tokens`), ticking every second, so you always know it's alive without asking.
- **Live token counter** — the status line shows a running token count while the agent works: a real-time estimate as text streams, corrected to the exact API count (and accumulated across rounds) as each round completes.
- **Auto-continue** (agent modes): the agent now keeps working on its own until the task is complete instead of stopping for you to type "continue". It's instructed to run autonomously and signal completion with a `<DONE>` marker; the extension auto-continues up to a safety cap (and the **Stop** button always interrupts). Toggle with `parley.autoContinue` (default on).
- **"Working…" status indicator** — a pulsing status line shows while the agent is thinking or a tool is running (e.g. "Running: npm test…"), so you can tell it's busy and not stuck.
- **`edit_file` tool** — precise find-and-replace edits to existing files (reviewed/checkpointed like `write_file`), so the agent can patch large files without rewriting them.
- **Ranged `read_file`** — `start_line`/`end_line` with line-numbered output and total-line count, so the agent can page through large files.

### Changed
- Raised the per-turn tool-call limit (6 → 25) and the auto-continue cap (12 → 25); when the cap is reached the agent now posts a visible "Paused — type continue" note instead of stopping silently.
- Live activity is easier to read: blank-line spacing between narration blocks and accented action lines.
- Clarified the **Chat** mode label: "Answer only — no agent, no file access".

## 0.9.2

### Changed
- **Token-streamed agent activity** (Claude-Code style): the agent's tool rounds now stream, so the model's narration appears **token-by-token** interleaved with the action lines (`▸ Reading…`, `▸ Running…`), instead of arriving per step. Tool calls are reassembled from the streamed deltas.

## 0.9.1

### Added
- **Full access mode** (⚠ CAUTION) — auto-applies edits *and* runs shell commands **without confirmation**. Clearly badged in the Mode popover and shown with a red caution style on the Mode button when active. All other modes still confirm shell commands.
- **Live agent activity** — while the agent works it now shows what it's doing in real time: friendly action lines (`▸ Reading src/app.ts`, `▸ Running: npm test`, `▸ Editing …`) and the model's intermediate narration between steps, Claude-Code-style.

## 0.9.0

### Added
- **Modes popover** (Cursor/Claude-style) in the composer, replacing the Agent checkbox: **Chat**, **Ask before edits**, **Edit automatically**, **Plan**, **Auto**. The reasoning-effort control moved into the same popover.
  - *Ask* shows a diff to approve each edit; *Edit*/*Auto* apply edits automatically (still checkpointed/revertible); *Plan* gives the agent read-only tools and asks for a plan; *Chat* uses no tools.
  - Shell commands (`run_command`) always require confirmation, in every mode.
- `parley.defaultMode` setting (replaces `parley.agentMode`).

## 0.8.1

### Changed
- The reasoning-effort dropdown is now explicitly labeled "not honored by Parley yet" (tooltip + dropdown header), and the setting description says the same — verified across GPT-5, Claude, and Gemini that the gateway accepts but ignores `reasoning_effort`. The parameter is still sent for forward-compatibility.

## 0.8.0

### Added
- **`search_text` agent tool** — grep file contents across the workspace (practical stand-in for semantic codebase search).
- **`@`-mention autocomplete** — typing `@` shows a file picker (↑/↓/Enter) that attaches the file as context.
- **Past conversations** — conversations are archived on "New"; reopen with 🕘 or `Parley: Open Past Conversation`.
- **Richer Markdown** — headings, lists, external links, and fenced code blocks with a hover **Copy** button.
- **Context-limit handling** — token-limit errors now suggest running Compact instead of showing a raw error.

### Engineering
- Unit tests for the new pure parsing logic (`src/parley/parsing.ts`).
- **GitHub Actions**: CI (compile + test + package on push/PR) and a Release workflow that attaches the `.vsix` to a GitHub Release on `vX.Y.Z` tags.
- ESLint + Prettier configs and `lint`/`format` scripts; removed a stale empty directory.

## 0.7.1

### Changed
- Reorganized the chat UI to be cleaner (Claude Code-like): slim header with just session actions (new/compact/export/refresh); the model and reasoning-effort pickers now live in a unified input box at the bottom alongside attach/send; context toggles tucked into a collapsible "Context" disclosure.

## 0.7.0

### Added
- **Agentic editing.** Agent mode gains `write_file` (diff-reviewed + checkpointed), `run_command` (per-command confirmation, returns output), and `fetch_url` (read a web page) on top of the existing read tools.
- **Inline edit (Ctrl+Alt+K / Cmd+Alt+K)** — `Parley: Edit Selection (Inline)`: select code, describe a change, review the diff, apply.
- **Checkpoints** — `Parley: Revert Last Edit` undoes the most recent agent/inline edit.
- **@file mentions** in the composer attach referenced files as context.
- **Project rules** — `.parleyrules` / `AGENTS.md` / `.cursorrules` in the workspace root is injected into the system prompt.
- **Persistent sessions** — the conversation and your model/effort/agent-mode choices survive reloads (per workspace).
- **Token-usage readout** under each reply (model + total tokens) when the API reports it; streaming requests now set `stream_options.include_usage`.

### Notes
- Semantic `@codebase` search is not offered: the Parley API has no `/v1/embeddings` endpoint.

## 0.6.0

### Added
- Compact the conversation: a ⊟ toolbar button and `Parley: Compact Conversation` command summarize the chat (via the selected model) and replace the history with that summary, freeing up context. Client-side feature using the normal chat endpoint — works with any model.

### Docs
- Comprehensive README covering every feature, command, and setting.
- Made the reasoning-effort caveat explicit (live testing was inconclusive; it may not currently take effect on Parley).

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
