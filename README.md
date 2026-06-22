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

### 🧠 Reasoning effort
An **Effort** dropdown in the chat toolbar (and the `parley.reasoningEffort`
setting) sends the standard `reasoning_effort` parameter — `minimal`, `low`,
`medium`, or `high` — with chat, agent-mode, and inline-completion requests.
`Default` omits the parameter.

> ⚠️ **Not honored by Parley (verified).** Testing across GPT-5, Claude, and Gemini
> models shows the Parley gateway *accepts* `reasoning_effort` but does **not** apply
> it — `high` is no slower or heavier than `minimal`, no `reasoning_tokens` are
> reported, and even an invalid value is accepted. The dropdown is labeled accordingly
> in-product; it sends the standard parameter so it works automatically if Parley
> enables it later.

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

In any tool mode the model works through an OpenAI tool-calling loop, shown inline
(`⚙ read_file src/app.ts`). Shell commands require confirmation in every mode
**except Full access**, which runs them automatically — use it only when you trust
the task. Edits are always checkpointed (`Parley: Revert Last Edit`).

- `read_file`, `list_directory`, `find_files` — gather context (read-only)
- `search_text` — grep file **contents** across the workspace (the practical stand-in for semantic codebase search)
- `write_file` — create/edit a file; **opens a diff and requires your approval** before applying (and is checkpointed for revert)
- `run_command` — run a shell command; **requires per-command confirmation**, then returns its output to the model
- `fetch_url` — fetch a public `https://` page as text

Sensitive files are refused, file paths are constrained to the workspace, and no
edit or command happens without your explicit approval.

### ✏️ Inline edit (Ctrl+Alt+K)
Select code, press **`Ctrl+Alt+K`** (`Cmd+Alt+K` on macOS) or run
**`Parley: Edit Selection (Inline)`**, describe the change, and review the diff
before it's applied — a Cursor-style Cmd-K edit without leaving the editor.
Applied edits are checkpointed; **`Parley: Revert Last Edit`** undoes the most recent one.

### 🏷️ @-mentions & project rules
- Type **`@`** in the composer to get a **file autocomplete** — pick a file (↑/↓, Enter) to attach it as context.
- A **`.parleyrules`**, **`AGENTS.md`**, or **`.cursorrules`** file in the workspace root is auto-injected into the system prompt as project rules.

> Semantic `@codebase` search isn't offered because the Parley API exposes no
> embeddings endpoint; use `@file` mentions or agent mode's `search_text` / `find_files`.

### 💾 Sessions, history & usage
- The conversation (and your model/effort/agent-mode choices) **persists across reloads** per workspace.
- **Past conversations** are archived when you start a new one; reopen them with 🕘 or **`Parley: Open Past Conversation`**.
- Each reply shows a subtle footer with the **model** and **token usage** when the API reports it.

### 🖋️ Rich replies
Replies render Markdown — headings, lists, **bold**, links (open externally), inline-code chips, and fenced code blocks with a hover **Copy** button. If a request overflows the model's context window, Parley detects it and suggests **Compact**.

### 📎 File & image attachments
The **📎** button attaches files to your next message:
- **Text files** are added as context.
- **Images** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`) are sent as multimodal `image_url` input to vision-capable models (Claude, Gemini, GPT-5).

Attachments show as removable chips and are cleared after sending.

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
| `Parley: Generate Image` | Generate an image with `gpt-image-1` |
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
| `parley.reasoningEffort` | `default` | `default` \| `minimal` \| `low` \| `medium` \| `high` → `reasoning_effort` |
| `parley.defaultMode` | `chat` | Default mode: `chat` \| `ask` \| `edit` \| `plan` \| `auto` \| `full` (⚠ runs commands automatically) |
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
```

Press `F5` to launch an Extension Development Host. CI (GitHub Actions) compiles,
tests, and packages on every push; pushing a `vX.Y.Z` tag publishes a GitHub
Release with the `.vsix` attached.

## Packaging

```bash
npm install
npm run compile
npm run package     # @vscode/vsce -> parley-vscode-<version>.vsix
```

Install the result with:

```bash
code --install-extension parley-vscode-0.9.1.vsix
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
