# Parley for VS Code

`parley-vscode` is a Visual Studio Code extension for working with **MIT Parley**
coding models inside the editor — a Cursor-like experience with a streaming chat
sidebar, inline (ghost-text) completions, an agent mode that can read your
workspace, multimodal attachments, image generation, and diff-reviewed edits.

It is built around a `ParleyProvider` abstraction, so the UI, context collection,
diff review, and safety controls stay independent of the transport.

---

## Integration status

Parley exposes an **OpenAI-compatible API** at `https://parley.api.mit.edu/v1`,
authenticated with a personal `sk-parley-…` key. The extension talks to it
directly — **no browser/Touchstone step is needed for the API itself**. Touchstone
only gates the Parley web app at `parley.mit.edu`, which is where you create your
API key (**Settings → API Keys**).

See [API_DISCOVERY.md](API_DISCOVERY.md) for the full API reference (endpoints,
model IDs, streaming, tool-calling, vision, and image generation).

---

## Getting started

1. Create an API key at [parley.mit.edu](https://parley.mit.edu) → **Settings → API Keys**.
2. In VS Code, run **`Parley: Set API Key`** (Command Palette) and paste it. The key is stored in VS Code `SecretStorage`, never in settings or logs. The key is verified against the API immediately.
3. Click the **feather icon** in the Activity Bar to open the Parley chat, pick a model from the dropdown, and start chatting.

---

## Features

### 💬 Streaming chat sidebar
A dedicated Parley view with:
- **Model picker** populated live from `GET /v1/models` (Claude, GPT-5, Gemini, Llama families).
- **Token-by-token streaming** with a **Stop** button to cancel mid-reply.
- **Markdown rendering** with inline-code chips and fenced code blocks.
- **+ New** to clear the conversation; **↻** to refresh the model list.
- Modern assistant-style layout (your message as a rounded card, the reply as flowing text — no role labels).
- `Enter` sends, `Shift+Enter` inserts a newline.
- Conversation history is sent with each turn for multi-turn context.

### 🧠 Extended thinking
Pick a **thinking** level from the **Mode** popover in the composer (or the
`parley.thinking` setting) to have the model reason step-by-step before it
answers, via Parley's `thinking` parameter:

- **Off** — no extended thinking (default).
- **Adaptive** — the model decides how much to reason. This is the only mode
  Bedrock supports for **Claude Opus 4.7**, so Parley for VS Code automatically
  uses it when you target that model.
- **Low / Med / High** — a fixed reasoning budget (4,096 / 8,192 / 16,000 tokens).
  The request's `max_tokens` is raised above the budget so there's room for the
  actual answer.

The reasoning streams into a collapsible **💭 Thinking** panel above each reply,
then collapses to **💭 Thought** when the answer begins. Supported on Claude,
OpenAI reasoning models, and Gemini. Extended thinking increases output-token
usage (and cost), so it's off by default.

### ⌨️ Inline (ghost-text) completions
As you type, Parley suggests a completion at the cursor (Cursor-style ghost text),
using a fast model and a fill-in-the-middle prompt around your cursor.
- Toggle on/off with **`Parley: Toggle Inline Completion`**.
- Configure the model and debounce via `parley.inlineCompletion.*`.
- Only runs in real editor documents; cancels in-flight requests as you keep typing.

### 🤖 Modes (agent)
Pick a **Mode** from the popover in the composer (the `Mode ▾` button) — Cursor/Claude-style:

| Mode | Behavior |
| --- | --- |
| **Chat** | Answer only; no file tools (default). |
| **Ask before edits** | Agent proposes edits; you approve each one in a diff. |
| **Edit automatically** | Agent applies edits without asking (checkpointed/revertible). |
| **Plan** | Agent explores **read-only** and presents a numbered plan; makes no changes. |
| **Auto** | Agent decides and applies edits automatically. |
| **Full access** ⚠ | **CAUTION** — auto-applies edits **and runs shell commands without asking**. |

In any tool mode the model works through an OpenAI tool-calling loop. Its narration
**streams token-by-token**, interleaved with live action lines (`▸ Reading src/app.ts`,
`▸ Running: npm test`, `▸ Editing …`) — so you see what it's doing as it happens.
Shell commands require confirmation in every mode
**except Full access**, which runs them automatically — use it only when you trust
the task. Edits are always checkpointed (`Parley: Revert Last Edit`).

**Auto-continue & status.** In agent modes the agent keeps working on its own until
the task is done (no need to type "continue") — it runs up to a safety cap and you
can **Stop** anytime; toggle with `parley.autoContinue`. While it's thinking or a
tool is running, a pulsing **"Working…"** status line shows so you always know it's
busy rather than stuck — with a **live token counter** (estimated as text streams,
corrected to the exact API count per round).

- `read_file` (with optional `start_line`/`end_line` for large files), `list_directory`, `find_files` — gather context (read-only)
- `search_text` — grep file **contents** across the workspace (the practical stand-in for semantic codebase search)
- `edit_file` — precise find-and-replace edit of an existing file (best for large files); reviewed/checkpointed
- `write_file` — create/overwrite a file; reviewed/checkpointed
- `run_command` — run a shell command; **requires per-command confirmation** (except Full access), then returns its output
- `fetch_url` — fetch a public `https://` page as text

Sensitive files are refused, file paths are constrained to the workspace, and no
edit or command happens without your explicit approval. **Stop** aborts in-flight
work *and kills a running command*. After a turn, a **"Changed N files"** summary
lists what was edited (undo with `Parley: Revert All Edits`). The agent loop also
trims stale tool output and auto-compacts to control cost. Type **`/`** in the
composer for a **slash-command menu**: `/clear`, `/compact`, `/cost`, `/model`,
`/init`, `/json` (next reply as JSON), `/help`.

### ✏️ Inline edit (Ctrl+Alt+K)
Select code, press **`Ctrl+Alt+K`** (`Cmd+Alt+K` on macOS) or run
**`Parley: Edit Selection (Inline)`**, describe the change, and review the diff
before it's applied — a Cursor-style Cmd-K edit without leaving the editor.
Applied edits are checkpointed; **`Parley: Revert Last Edit`** undoes the most recent one.
Multi-change edits offer **Apply All / Choose… / Reject** — "Choose…" lets you accept or reject **individual hunks**.

### 🏷️ @-mentions & project rules
- Type **`@`** in the composer to get a **file autocomplete** — pick a file (↑/↓, Enter) to attach it as context.
- A **`.parleyrules`**, **`AGENTS.md`**, or **`.cursorrules`** file in the workspace root is auto-injected into the system prompt as project rules.

> Semantic `@codebase` search isn't offered because the Parley API exposes no
> embeddings endpoint; use `@file` mentions or agent mode's `search_text` / `find_files`.

### 💾 Sessions, history & usage
- The conversation (and your model/thinking/agent-mode choices) **persists across reloads** per workspace.
- **Past conversations** are archived when you start a new one; reopen them with 🕘 or **`Parley: Open Past Conversation`**.
- Each reply shows a subtle footer with the **model** and **token usage**; the header shows a **running token total**, an **estimated cost** (`~$`), and a **circular context gauge** that fills (green → amber → red) as the conversation approaches the model's context window.
- **Automatic compaction** is on by default — at 80% of the model's context window the conversation is summarized (keeping recent messages), so it never overflows. Configure with `parley.autoCompactPercent` (`0` disables) / `parley.autoCompactTokens`.
- **`Parley: Show Usage`** reports your account's **real billed spend** for the current month (cost, request count, tokens) from Parley's usage endpoint. Needs your account id (`parley.accountId`, found in the Admin Portal under *My Account* — you're prompted on first use).
- **Token limit** — set a per-conversation token budget with **`Parley: Set Token Limit`** (or `parley.tokenLimit`); **`0` = unlimited** (default). When reached, the agent stops and asks you to raise it or start fresh.

### 🖋️ Rich replies
Replies render Markdown — headings, lists, **bold**, links (open externally), inline-code chips, and fenced code blocks with a hover **Copy** button. If a request overflows the model's context window, Parley detects it and suggests **Compact**.

### 📎 File & image attachments
The **📎** button attaches files to your next message:
- **Text files** (txt/csv/markdown/html/json/xml/…) are added as context. If a file is larger than `parley.context.maxCharacters`, it's **uploaded via `/v1/files`** on OpenAI/Google so its full contents reach the model (rather than being truncated); on Bedrock/Anthropic it stays inline.
- **Images** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`) are sent as multimodal `image_url` input to vision-capable models (Claude, Gemini, GPT-5).
- **PDFs** (`.pdf`) are routed per provider: OpenAI/Google models **upload** them to Parley's `/v1/files` endpoint and reference them by id; Bedrock/Anthropic models receive them **inline** as a base64 document block.
- **Audio** (`.wav`, `.mp3`) is sent as a multimodal `input_audio` block — supported on OpenAI and Google models (Parley warns otherwise).
- **Video** (`.mp4/.mov/.mkv/.webm/.avi/…`) is handled client-side via **ffmpeg** (Parley has no native video type): you choose to **sample frames** (sent as images to a vision model), **extract the audio track** (sent as `input_audio`), or **both**. Needs `ffmpeg`/`ffprobe` on PATH or `parley.video.ffmpegPath`; if missing, Parley links you to the download. Tune with `parley.video.maxFrames` / `frameWidth` / `maxAudioSeconds`.

You can also **paste a screenshot** (Ctrl/Cmd+V) or **drag-and-drop an image, PDF, or audio file** straight onto the composer — no dialog needed (video uses the 📎 button so ffmpeg can read it from disk). Attachments show as removable chips and are cleared after sending.

### 🎨 Image generation
**`Parley: Generate Image`** prompts for a description and size, calls
`gpt-image-1`, saves the PNG to `parley-images/` in your workspace (or a location
you choose), and opens it.

### ✅ Diff-reviewed edits
When a reply proposes file changes — as whole-file `File: <path>` blocks or unified
diffs — they open in a **VS Code diff** and are applied **only after you accept**.
Nothing is written automatically.

### 💻 Editor commands
These collect the relevant context and stream the reply into the chat panel:
- **`Parley: Ask About Selection`**
- **`Parley: Explain Current File`**
- **`Parley: Refactor Selection`**
- **`Parley: Generate Tests`**
- **`Parley: Fix Diagnostics`**
- **`Parley: Suggest Terminal Command`** — shows a command for confirmation and inserts it into a terminal (never auto-executes).

### 📤 Export the conversation
The **⤓** toolbar button or **`Parley: Export Conversation`** saves the whole chat
to **Markdown** or **JSON**. Each assistant reply is tagged with the model that
produced it, so exports remain accurate across mixed-model conversations.

### 📦 Compact the conversation
The **⊟** toolbar button or **`Parley: Compact Conversation`** asks the current
model to summarize the conversation, then replaces the history with that summary so
the chat can continue using far fewer tokens. This is a **client-side** feature
built on the normal chat endpoint (Parley has no compaction endpoint), so it works
with any model.

### 🔒 Safety
- **Sensitive-file filtering** excludes `.env`/`.env.*`, `.npmrc`, `.pypirc`, private keys, `*.pem`/`*.key`/`*.p12`/`*.pfx`, `secrets.*`, `id_rsa`/`id_ed25519`, `known_hosts`, `credentials`, and files under `.ssh`/`.aws`/`.azure`/`.gnupg`. Hidden files are excluded by default. The same filter applies to agent-mode file reads.
- **`.parleyignore`** support, plus optional `.gitignore` respect.
- **Large-context preview**: when attached context is large, a preview opens and you confirm before sending.
- The API key lives in `SecretStorage`; prompts, code, headers, and tokens are never logged.

---

## Commands

| Command | What it does |
| --- | --- |
| `Parley: Set API Key` | Store/verify your `sk-parley-…` key in SecretStorage |
| `Parley: Open Chat Window` | Focus the Parley chat view |
| `Parley: Ask About Selection` | Ask about the current selection |
| `Parley: Explain Current File` | Explain the active file |
| `Parley: Refactor Selection` | Refactor the selection (diff-reviewed) |
| `Parley: Generate Tests` | Generate tests for the current file |
| `Parley: Fix Diagnostics` | Fix reported problems with the smallest change |
| `Parley: Suggest Terminal Command` | Suggest a shell command (manual confirm) |
| `Parley: Edit Selection (Inline)` | Inline edit of the selection (`Ctrl+Alt+K` / `Cmd+Alt+K`) |
| `Parley: Revert Last Edit` | Undo the most recent agent/inline edit |
| `Parley: Revert All Edits` | Undo all checkpointed edits |
| `Parley: Regenerate Last Response` | Re-run the last user message |
| `Parley: Set Token Limit` | Set the per-conversation token budget |
| `Parley: Generate Image` | Generate an image with `gpt-image-1` |
| `Parley: Show Usage` | Show real billed spend for the current month |
| `Parley: Run Diagnostics` | Probe the live API and report what works |
| `Parley: Init Project Rules` | Scaffold an AGENTS.md rules file |
| `Parley: Toggle Inline Completion` | Enable/disable ghost-text completions |
| `Parley: Export Conversation` | Export the chat to Markdown or JSON |
| `Parley: Compact Conversation` | Summarize the chat and replace history to free context |
| `Parley: Open Past Conversation` | Reopen an archived conversation |
| `Parley: Sign Out` | Clear the stored API key |

---

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `parley.endpoint` | `https://parley.api.mit.edu/v1` | OpenAI-compatible API base URL |
| `parley.defaultAgent` | `bedrock/claude-sonnet-4-6` | Default model id |
| `parley.stream` | `true` | Stream replies token-by-token |
| `parley.thinking` | `off` | Extended thinking: `off` \| `adaptive` \| `low` \| `medium` \| `high` → `thinking` parameter |
| `parley.defaultMode` | `chat` | Default mode: `chat` \| `ask` \| `edit` \| `plan` \| `auto` \| `full` (⚠ runs commands automatically) |
| `parley.autoContinue` | `true` | Keep working until done (agent modes) without manual "continue" |
| `parley.maxToolRounds` | `25` | Max tool-call rounds per turn |
| `parley.maxAutoContinue` | `25` | Max auto-continue steps before pausing (`0` disables) |
| `parley.tokenLimit` | `0` | Per-conversation token budget; `0` = unlimited |
| `parley.autoCompactTokens` | `0` | Auto-summarize the conversation past this size; `0` = off |
| `parley.inlineCompletion.enabled` | `true` | Show inline ghost-text completions |
| `parley.inlineCompletion.model` | `openai/gpt-5-nano` | Model used for completions (prefer a fast one) |
| `parley.inlineCompletion.debounceMs` | `350` | Idle delay before requesting a completion |
| `parley.context.maxCharacters` | `12000` | Max characters of context per request |
| `parley.context.includeDiagnostics` | `true` | Include diagnostics when a command requests them |
| `parley.context.respectGitignore` | `true` | Respect `.gitignore` while collecting context |
| `parley.confirmBeforeSendingLargeContext` | `true` | Preview/confirm before sending large context |
| `parley.telemetry.enabled` | `false` | No telemetry is emitted |
| `parley.logLevel` | `info` | `error` \| `warn` \| `info` \| `debug` |

---

## Models

Model ids are provider-prefixed; the chat dropdown lists whatever `GET /v1/models`
returns. Observed families include:

- **Anthropic (Bedrock):** `bedrock/claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-7`
- **OpenAI:** `openai/gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5.1`, `gpt-5.2`, `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.5`, `gpt-image-1`
- **Google:** `google/gemini-2.5-pro`, `gemini-3.0-flash`, `gemini-3.1-pro`
- **Meta:** `bedrock/llama-4-maverick-17b`

---

## Docking like Codex

VS Code does not let third-party extensions contribute to the Secondary Side Bar
directly. To dock Parley there:

1. Run **`Parley: Open Chat Window`**.
2. Run **`View: Toggle Secondary Side Bar Visibility`** if it's hidden.
3. Drag the **Chat** view header from the Parley sidebar into the Secondary Side Bar.

VS Code remembers the layout afterward.

---

## Development

```bash
npm install
npm run compile      # tsc -> out/
npm test             # compile + node --test
npm run lint         # eslint
npm run format       # prettier --write
npm run test:integration  # launches VS Code (needs a display; CI uses xvfb)
```

Press `F5` to launch an Extension Development Host. CI (GitHub Actions) compiles,
unit-tests, packages, and runs **VS Code integration tests** on every push; pushing
a `vX.Y.Z` tag publishes a GitHub Release with the `.vsix` attached (and, if the
`VSCE_PAT` / `OVSX_PAT` secrets are set, to the Marketplace / Open VSX).

## Packaging

```bash
npm install
npm run compile
npm run package     # @vscode/vsce -> parley-vscode-<version>.vsix
```

Install the result with:

```bash
code --install-extension parley-vscode-0.11.0.vsix
```

## Architecture

- `src/parley/ParleyClient.ts` — the official client (chat + streaming + tool loop, `/models`, `/chat/completions`, `/images/generations`) behind the `ParleyProvider` interface.
- `src/parley/tools.ts` — agent tools (read, web fetch; writes/commands are mediated by the panel with review + confirmation).
- `src/diff/checkpoints.ts` — revertable file-write checkpoints for agent/inline edits.
- `src/commands/inlineEdit.ts` — Ctrl+Alt+K inline edit.
- `src/completion/` — the inline completion provider.
- `src/context/` — selection/file/diagnostics/editor context collection, ignore rules, sensitive-file filtering.
- `src/diff/` — unified-diff / `File:`-block parsing and diff-review-before-apply.
- `src/webview/ChatPanel.ts` + `media/` — the chat UI.

Authentication material uses `SecretStorage`; credentials and request headers are never logged. See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).
