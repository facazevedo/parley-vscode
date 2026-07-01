# Parley for VS Code

`parley-vscode` is a Visual Studio Code extension that turns **MIT Parley** into a
full Cursor / Claude‑Code / Codex‑class coding assistant inside the editor:
a streaming chat sidebar, an agent that reads and edits your workspace, inline
(ghost‑text) completions, multimodal attachments (image / PDF / audio / video),
web search, an optional on‑device semantic codebase index, MCP servers, image
generation, and diff‑reviewed edits — all on top of the MIT Parley gateway.

It is built around a `ParleyProvider` abstraction, so the UI, context collection,
diff review, and safety controls stay independent of the transport.

---

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [The chat window, at a glance](#the-chat-window-at-a-glance)
- [Modes (chat → full agent)](#modes-chat--full-agent)
- [The agent: tools, activity, plan, edits](#the-agent-tools-activity-plan-edits)
- [Reasoning & speed (important nuances)](#reasoning--speed-important-nuances)
- [@-mentions](#-mentions)
- [`@codebase` search (lexical + optional local semantic)](#codebase-search-lexical--optional-local-semantic)
- [Slash commands (built-in + your own)](#slash-commands-built-in--your-own)
- [Attachments: image, PDF, audio, video](#attachments-image-pdf-audio-video)
- [Web search](#web-search)
- [MCP servers](#mcp-servers)
- [Inline completion & inline edit](#inline-completion--inline-edit)
- [Cost, context & limits](#cost-context--limits)
- [Conversations: full transcripts in `.parley`](#conversations-full-transcripts-in-parley)
- [Git, images & editor commands](#git-images--editor-commands)
- [Project rules](#project-rules)
- [Diagnostics & debugging](#diagnostics--debugging)
- [Safety & privacy](#safety--privacy)
- [Command reference](#command-reference)
- [Settings reference](#settings-reference)
- [Models](#models)
- [What Parley can and can't do (gateway limits)](#what-parley-can-and-cant-do-gateway-limits)
- [Troubleshooting](#troubleshooting)
- [Development & packaging](#development--packaging)
- [Architecture](#architecture)

---

## Requirements

- **VS Code** ≥ 1.92.
- A **Parley API key** (`sk-parley-v1-…`) from MIT IS&T or the Parley Admin Portal.
- Optional, only for specific features:
  - **ffmpeg / ffprobe** on your PATH — for **video** attachments.
  - **`npm`** on your PATH — only for the opt‑in local semantic `@codebase` index (one‑time runtime install).
  - A **Google Programmable Search** key + `cx`, or a **Tavily** key — only if you switch web search off DuckDuckGo.

The extension talks to Parley's **OpenAI‑compatible API** at
`https://parley.api.mit.edu/v1` directly — **no browser/Touchstone step is needed
for the API itself**. Touchstone only gates the Parley web app where you create the key.

---

## Install

**From a packaged VSIX:**

```bash
code --install-extension parley-vscode-<version>.vsix
```

Then reload the window (Command Palette → **Developer: Reload Window**). VS Code does
not hot‑swap an extension; the reload is required after every (re)install.

**From source:** see [Development & packaging](#development--packaging).

---

## Quick start

1. Create an API key in the **Parley Admin Portal** (Production:
   `https://parley-admin.atlas-apps.mit.edu` → *My Account*) or get one from your
   IS&T admin.
2. In VS Code, run **`Parley: Set API Key`** (Command Palette) and paste it. The key
   is stored in VS Code **SecretStorage** — never in settings, files, or logs — and
   is verified against the API immediately.
3. Click the **Parley feather icon** in the Activity Bar to open the chat.
4. Pick a model from the dropdown in the composer, type a message, press **Enter**.

> **Tip:** run **`Parley: Run Diagnostics`** any time to confirm, against your own
> key, exactly which features the gateway supports (chat, token counting, whether
> extended thinking is honored on your models, etc.).

---

## The chat window, at a glance

**Header (top):** the title, a live **session counter** (`· 12,345 tok · ~$0.04`),
an **always‑visible circular context gauge** that fills green → amber → red as the
conversation approaches the model's context window (shows `–` when the window size is
unknown for a model), and buttons: **＋** new conversation, **🕘**
past conversations, **⊟** compact, **⤓** export, **↻** refresh model list.

**Composer (bottom):**
- A **Context** disclosure with checkboxes (Selection, File, Open editors,
  Diagnostics, Pick files) controlling what's attached to commands.
- The **prompt box**. `Enter` sends, `Shift+Enter` is a newline. Type **`@`** for
  file/`@codebase`/`@git` mentions, **`/`** for the command menu, and **paste or
  drop** an image / PDF / audio file directly.
- The **model dropdown**, a **`Mode ▾`** popover (mode + thinking + speed), and a
  **📎** attach button.

**While the agent works** a pulsing **status line** shows what it's doing, the
elapsed time, and a live token count. **Scrolling up pauses autoscroll** so you can
read earlier messages while output streams; a floating **↓** pill jumps back to the
latest. Replies render as full Markdown with **syntax-highlighted code blocks**
(colors follow your VS Code theme).

---

## Modes (chat → full agent)

Open the **`Mode ▾`** popover (or set `parley.defaultMode`):

| Mode | Behavior |
| --- | --- |
| **Chat** | Answer only; no file tools (default). |
| **Ask before edits** | Agent proposes edits; you approve each one in a diff. |
| **Edit automatically** | Agent applies edits without asking (checkpointed/revertible). |
| **Plan** | Agent explores **read‑only** and presents a numbered plan; makes no changes. |
| **Auto** | Agent decides and applies edits automatically. |
| **Full access** ⚠ | **CAUTION** — auto‑applies edits **and runs shell commands without asking**. |

Shell commands require confirmation in **every mode except Full access**. Edits are
always checkpointed (`Parley: Revert Last Edit` / `Revert All Edits`).

**Auto‑continue.** In agent modes the agent keeps working on its own until the task
is complete (`parley.autoContinue`, on by default), up to a safety cap
(`parley.maxAutoContinue`). It signals completion with a `<DONE>` marker; you can
**Stop** at any point. If a step makes no progress (empty reply, no tool calls) it
stops cleanly instead of looping.

---

## The agent: tools, activity, plan, edits

In any tool mode the model runs an OpenAI tool‑calling loop. Built‑in tools:

| Tool | What it does |
| --- | --- |
| `read_file` | Read a file (optional `start_line`/`end_line` for big files) |
| `list_directory`, `find_files` | Explore the tree / glob for files |
| `grep` | **Regex** search of file contents (VS Code's bundled ripgrep; case flag, context lines, glob filter) |
| `search_text` | Simple substring search of file **contents** |
| `edit_file` | Precise find‑and‑replace edit (reviewed/checkpointed) |
| `write_file` | Create/overwrite a file (reviewed/checkpointed) |
| `run_command` | Run a shell command (confirmation required except Full access) |
| `fetch_url` | Fetch a public `https://` page as text |
| `web_search` | Search the web (see [Web search](#web-search)) |
| `update_plan` | Maintain the live task checklist |
| `mcp__<server>__<tool>` | Any tools from your configured [MCP servers](#mcp-servers) |

**Activity output (Claude‑Code style).** As the agent works you see an **`⏺ action`**
line followed by a muted **`⎿ result`** line — e.g. `⏺ Reading App.tsx` → `⎿ Read
120 lines`. Shell commands are also mirrored, with full output, to a **"Parley
Agent"** output channel.

**Live task checklist.** For multi‑step work the agent calls `update_plan`; the
steps render as an in‑place checklist (☐ pending · ▸ in‑progress · ☑ done).

**Inline diff cards.** When the agent edits/creates a file, the change is shown right
in the chat as a unified diff card — file path, `+added −removed` counts, red/green
lines with a line‑number gutter, far‑apart unchanged regions collapsed.

**Apply button (Chat mode).** In plain **Chat** mode the model doesn't touch files;
instead, any complete‑file change it proposes is rendered as an inline diff card with
an **Apply** (or **Create file**) and **Dismiss** button — click **Apply** to write it
(checkpointed/revertible). This is the Cursor‑style "suggest in chat, apply on click"
flow; the heavier agent modes apply through tools instead.

After a turn, a **"✏️ Changed N files"** summary lists what was edited. **Stop**
aborts in‑flight work *and kills a running command*.

**Resilience.** Transient failures — rate limits (429), upstream/server errors (5xx),
network blips, mid‑stream errors — are **retried automatically** (up to 3 times, with
backoff and `Retry-After` support) instead of killing the task; the status line shows
e.g. `Rate-limited — retrying in 2s (attempt 2/4)…`. Retries only happen while nothing
has streamed yet, so output is never duplicated. Long tool output is truncated
**honestly**: head + tail are kept around an explicit `[… N characters omitted …]`
marker, so the model sees the end of a command's output (where the error lives) and
knows exactly what was cut.

**Self‑correction.** After each applied edit, Parley reads the editor's **live
diagnostics** and reports any *new* errors/warnings back to the agent (`⚠ This edit
introduced 2 new problem(s)…`), so it fixes its own breakage before declaring victory.
A failed `edit_file` match returns the **closest real region of the file** (numbered
lines + similarity) so the model repairs its snippet in one round; matching itself is
tiered (exact → indentation‑tolerant → whitespace‑tolerant). And Parley hashes every
file the agent reads: overwriting an existing file **requires a fresh read**, so a
change you made mid‑conversation can never be silently clobbered.

**Command allowlist.** On the run‑command confirmation, **Always Allow** stores the
command as a workspace prefix rule (`npm test` also approves `npm test -- --grep foo`);
matching commands then run without asking. Review rules with
**`Parley: Manage Allowed Commands`**.

---

## Reasoning & speed (important nuances)

Open **`Mode ▾`** → **Extended thinking** and **Speed**. These behave differently
per provider — verified live against the gateway:

| Control | Claude (Bedrock) | Google / Gemini | OpenAI / GPT‑5.x |
| --- | --- | --- | --- |
| **Extended thinking** (Off/Adaptive/Low/Med/High) | ✅ works (real reasoning) | ✅ affects output | ⚠️ **accepted but not applied** by Parley today |
| **Speed** (Standard / ⚡ Fast) | n/a | n/a | ✅ Fast sends `service_tier: priority` |

- Each provider is called its native way: **Claude/Gemini** get a `thinking` block,
  **OpenAI** gets `reasoning_effort`. Because Parley doesn't currently apply
  `reasoning_effort` on its OpenAI route, **choosing a reasoning level for a GPT‑5
  model has no effect** — Parley shows a one‑time hint and suggests Claude/Gemini for
  deeper reasoning. (The level is still sent for forward‑compatibility.)
- **Speed → Fast** requests OpenAI's priority tier (~1.5× speed, higher usage). It's
  accepted by the gateway; the actual speed‑up depends on your account's tier.
- Reasoning streams into a collapsible **💭 Thinking** panel, then collapses to
  **💭 Thought**. It increases output‑token usage (and cost), so it's **off by default**.

---

## @-mentions

Type **`@`** in the composer:

| Mention | Effect |
| --- | --- |
| `@path/to/file` | Attach that file's contents (autocomplete as you type) |
| `@path/to/folder` | Attach a listing of the folder |
| `@codebase` | Retrieve the most relevant files for your question (see below) |
| `@git` | Attach the uncommitted diff (vs HEAD) |
| `@https://…` | Fetch the page and attach its text |

---

## `@codebase` search (lexical + optional local semantic)

`@codebase` pulls the most relevant workspace files into context for your question.
Controlled by `parley.codebaseSearch.provider`:

- **`lexical`** (default) — keyword ranking (term frequency + filename‑match boost).
  **Keyless, private, instant**, no setup. Great for known identifiers/strings; ~80%
  of the value of semantic search.
- **`local`** — a **true semantic index** using an **on‑device MiniLM embedding
  model** (transformers.js / ONNX). **Keyless and fully private** (nothing leaves
  your machine); finds files by *meaning*, not just keywords. To use it:
  1. Set `parley.codebaseSearch.provider` to `local`.
  2. Run **`Parley: Rebuild Codebase Index`**. The first build installs the embedding
     runtime into the extension's global storage (one‑time, needs **`npm` on your
     PATH**, a few minutes), then downloads the MiniLM model (~25 MB) once. Both are
     cached and work offline afterward. Re‑run after big changes.
  - If the runtime/index isn't ready or the model can't load, `@codebase` **falls back
    to lexical** automatically — it never breaks.

> **Why semantic is opt‑in (and installed on demand):** the embedding runtime is large
> and platform‑specific (native `onnxruntime`/`sharp` binaries). Rather than bloat the
> VSIX, the extension ships tiny (~100 KB) and installs the runtime locally — fetching
> the binaries that match *your* machine — only when you opt in. The default (`lexical`)
> needs nothing.

`parley.codebaseSearch.maxFiles` (default 4) controls how many files are included.

---

## Slash commands (built-in + your own)

Type **`/`** in the composer for an autocomplete menu.

| Command | Effect |
| --- | --- |
| `/clear` (or `/new`) | Start a new conversation |
| `/compact` | Summarize to free context (choose keep‑recent or all) |
| `/cost` | Show this conversation's token/cost usage |
| `/model` | Switch the model |
| `/init` | Create a project‑rules file (`AGENTS.md`) |
| `/json` | Make the **next** reply a JSON object (`response_format`) |
| `/help` | List commands |

**Custom commands:** drop a `name.md` file in **`.parley/commands/`** (or
`.claude/commands/`) and it becomes **`/name`**. The file body is used as the prompt,
with **`$ARGS`** replaced by anything you type after the command. Custom commands
appear in the `/` menu.

---

## Attachments: image, PDF, audio, video

Use the **📎** button, or **paste** (Ctrl/Cmd+V) / **drag‑and‑drop** onto the composer:

| Type | Handling |
| --- | --- |
| **Text / code** (txt, md, csv, json, xml, html, source…) | Added as context. If larger than `parley.context.maxCharacters`, it's **uploaded via `/v1/files`** on OpenAI/Google so the full file reaches the model; inline (truncated) on Bedrock/Anthropic. |
| **Images** (png, jpg, gif, webp, bmp) | Sent inline as `image_url` to vision models (Claude, Gemini, GPT‑5). |
| **PDFs** | OpenAI/Google: **uploaded** to `/v1/files`; Bedrock/Anthropic: inline base64 `document` block. |
| **Audio** (wav, mp3) | Sent as an `input_audio` block (OpenAI/Google only; warns otherwise). |
| **Video** (mp4, mov, mkv, webm, avi…) | Via **ffmpeg** (Parley has no video type): choose **sample frames** (→ images), **extract audio** (→ `input_audio`), or **both**. Needs `ffmpeg`/`ffprobe` on PATH or `parley.video.ffmpegPath`. Tune with `parley.video.maxFrames` / `frameWidth` / `maxAudioSeconds`. Use the 📎 button (ffmpeg reads from disk). |

Attachments show as removable chips and are cleared after sending.

---

## Web search

The agent's `web_search` tool, controlled by `parley.webSearch.provider`:

- **`duckduckgo`** (default) — **no API key**.
- **`google`** — Google Programmable Search; set `parley.webSearch.apiKey` **and**
  `parley.webSearch.googleCx` (your search‑engine id).
- **`tavily`** — set `parley.webSearch.apiKey`.
- **`off`** — disable the tool.

The agent searches, then `fetch_url`s the most relevant results for detail.

---

## MCP servers

Configure **Model Context Protocol** servers in `parley.mcpServers` (stdio transport):

```jsonc
"parley.mcpServers": {
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"]
  }
}
```

Parley launches each server, runs the handshake, lists its tools, and exposes them to
the agent as **`mcp__<server>__<tool>`** (available in every agent mode except Plan).
Run **`Parley: Reconnect MCP Servers`** after editing the config; it also restarts
automatically when the setting changes. A server that fails to start is skipped — chat
keeps working.

---

## Inline completion & inline edit

- **Ghost‑text completion:** as you type, Parley suggests a completion at the cursor
  (fill‑in‑the‑middle). Toggle with **`Parley: Toggle Inline Completion`**; configure
  with `parley.inlineCompletion.*` (use a fast model like `openai/gpt-5-nano`).
- **Inline edit (`Ctrl+Alt+K` / `Cmd+Alt+K`):** select code, describe the change,
  review the diff before applying. Multi‑change edits offer **Apply All / Choose… /
  Reject** — "Choose…" accepts/rejects **individual hunks**. Edits are checkpointed.

---

## Cost, context & limits

- **Estimated cost** (`~$`) accumulates in the header from Parley's published
  per‑model rates (unknown models show tokens only; Llama is free).
- **`Parley: Show Usage`** reports your account's **real billed spend** for the month
  (cost, requests, tokens). Needs `parley.accountId` (Admin Portal → *My Account*;
  you're prompted on first use).
- **Context gauge** (always visible in the header) shows how full the model's context window is.
- **Automatic compaction** is **on by default at 80%** of the context window
  (`parley.autoCompactPercent`; `0` disables). The conversation is summarized,
  keeping the most recent messages. `parley.autoCompactTokens` is an absolute
  alternative.
- **Token limit:** `Parley: Set Token Limit` (or `parley.tokenLimit`; `0` = unlimited)
  pauses the agent when a conversation hits a budget.
- **Exact token counting** (via `/v1/messages/count_tokens`) drives auto‑compaction
  when available, falling back to an estimate.

---

## Conversations: full transcripts in `.parley`

Parley records a **complete, ordered transcript of everything shown** — your messages,
the model's replies, tool activity (`⏺`/`⎿`), file‑edit diffs, plans, and system notes —
not just the message text. The canonical copy is saved **as it happens** to a `.parley/`
folder in your workspace, so it never depends on what's in memory:

```
.parley/
  conversations/<id>.jsonl   append-as-it-happens event log (the source of truth)
  conversations/<id>.md      human-readable copy, rewritten each turn
  index.json                 list shown by "Open Past Conversation"
  state.json                 Parley params (model / mode / thinking / speed)
  .gitignore                 created once (ignore-all) so logs aren't committed by accident
```

- **New:** the **＋** button, `/clear`, or **`Parley: New Conversation`** (the prior
  one is saved first).
- **Auto‑save:** on by default (`parley.autoSaveConversations`). Change the location with
  `parley.conversationsDir`; open it with **`Parley: Open Conversations Folder`**. With no
  workspace open it falls back to the extension's global storage.
- **Past conversations:** **🕘** or `Parley: Open Past Conversation` reloads the **full
  transcript** from disk (diffs, tool calls and all) and keeps appending to the same file.
- **Export:** **⤓** or `Parley: Export Conversation` first **completes and saves the
  canonical transcript**, then writes a **copy** in your chosen format — **Markdown, plain
  text, or JSON** — to wherever you pick. The copy contains the entire transcript with a
  metadata header (model(s), mode, thinking level, speed, message count, tokens, cost).
- **Compact:** **⊟**, `/compact`, or `Parley: Compact Conversation` — summarize the
  conversation (choose *keep recent* or *everything*) to continue with fewer tokens. (This
  trims the model's context; the saved transcript keeps the full record.)

---

## Git, images & editor commands

- **`Parley: Generate Commit Message`** — summarizes the staged diff (or working
  tree) into a Conventional Commits message and drops it into the Source Control box.
- **`Parley: Generate Image`** — `gpt-image-1`; choose size + quality; saves the PNG
  to `parley-images/`.
- Selection/file commands stream their reply into the chat:
  **`Ask About Selection`**, **`Explain Current File`**, **`Refactor Selection`**,
  **`Generate Tests`**, **`Fix Diagnostics`**, **`Suggest Terminal Command`** (inserts
  into a terminal; never auto‑runs).

---

## Project rules

A **`.parleyrules`**, **`AGENTS.md`**, or **`.cursorrules`** file in the workspace
root is auto‑injected into the system prompt as project rules. Scaffold one with
**`Parley: Init Project Rules`** (or `/init`).

---

## Diagnostics & debugging

- **`Parley: Run Diagnostics`** probes the live API (models, chat, token counting,
  whether thinking is honored on your models) and opens a pass/fail report.
- **Debug logging** is gated by a single `DEBUG` switch in `src/debug/debug.ts`.
  When on, verbose traces (request shapes, response provider/model headers, finish
  reasons, token usage, tool rounds, turn flow) stream to the **"Parley Debug"** output
  channel, and are written to `debug/parley-debug.log` **only once you actually use Parley
  in the workspace** (the first chat/agent turn) — so repos where you never use Parley
  don't get a stray `debug/` folder. **`Parley: Open Debug Log`** opens it. The API key is
  never logged.

---

## Safety & privacy

- **Your API key** stays in VS Code **SecretStorage** — never in settings, the repo,
  or logs.
- **Sensitive‑file filtering** refuses `.env*`, `.npmrc`, `.pypirc`, private keys
  (`*.pem`/`*.key`/`*.p12`/`*.pfx`), `secrets.*`, `id_rsa`/`id_ed25519`, `known_hosts`,
  `credentials`, and anything under `.ssh`/`.aws`/`.azure`/`.gnupg`. Hidden files are
  excluded by default. The same filter guards agent file reads.
- **`.parleyignore`** is honored; `.gitignore` optionally (`parley.context.respectGitignore`).
- **Edits never apply silently** outside auto modes — they're diff‑reviewed and
  checkpointed; **Full access** is the only mode that runs commands without asking.
- **Large‑context preview** asks for confirmation before sending big context.
- **Where data goes:** chat/agent requests go to Parley. `@https://…`/`fetch_url`,
  `web_search` (DuckDuckGo/Google/Tavily), and MCP servers reach those third parties
  directly. The local semantic index and lexical `@codebase` run **entirely on your
  machine**. No telemetry is emitted.

---

## Command reference

| Command | What it does |
| --- | --- |
| `Parley: Set API Key` | Store/verify your `sk-parley-…` key in SecretStorage |
| `Parley: Open Chat Window` | Focus the Parley chat view |
| `Parley: New Conversation` | Save the current chat and start a fresh one |
| `Parley: Open Past Conversation` | Reopen an archived conversation |
| `Parley: Open Conversations Folder` | Reveal the auto‑saved transcripts |
| `Parley: Export Conversation` | Export to Markdown / plain text / JSON |
| `Parley: Compact Conversation` | Summarize history to free context |
| `Parley: Regenerate Last Response` | Re‑run the last user message |
| `Parley: Ask About Selection` | Ask about the current selection |
| `Parley: Explain Current File` | Explain the active file |
| `Parley: Refactor Selection` | Refactor the selection (diff‑reviewed) |
| `Parley: Generate Tests` | Generate tests for the current file |
| `Parley: Fix Diagnostics` | Fix reported problems minimally |
| `Parley: Suggest Terminal Command` | Suggest a shell command (manual confirm) |
| `Parley: Edit Selection (Inline)` | Inline edit (`Ctrl+Alt+K` / `Cmd+Alt+K`) |
| `Parley: Revert Last Edit` / `Revert All Edits` | Undo checkpointed edits |
| `Parley: Generate Image` | Generate an image with `gpt-image-1` |
| `Parley: Generate Commit Message` | Commit message from the diff → Source Control |
| `Parley: Rebuild Codebase Index` | Build the local semantic `@codebase` index |
| `Parley: Manage Allowed Commands` | Review/remove commands approved via "Always Allow" |
| `Parley: Reconnect MCP Servers` | Restart MCP servers and show status |
| `Parley: Show Usage` | Real billed spend for the current month |
| `Parley: Set Token Limit` | Per‑conversation token budget |
| `Parley: Toggle Inline Completion` | Enable/disable ghost‑text completions |
| `Parley: Init Project Rules` | Scaffold an `AGENTS.md` rules file |
| `Parley: Run Diagnostics` | Probe the live API and report what works |
| `Parley: Open Debug Log` | Open the verbose debug log |
| `Parley: Sign Out` | Clear the stored API key |

---

## Settings reference

| Setting | Default | Description |
| --- | --- | --- |
| `parley.endpoint` | `https://parley.api.mit.edu/v1` | OpenAI‑compatible API base URL |
| `parley.accountId` | `""` | Account id (`acc_…`) for `Show Usage` |
| `parley.defaultAgent` | `bedrock/claude-sonnet-4-6` | Default model id |
| `parley.stream` | `true` | Stream replies token‑by‑token |
| `parley.thinking` | `off` | Extended thinking: `off`/`adaptive`/`low`/`medium`/`high` |
| `parley.defaultMode` | `chat` | `chat`/`ask`/`edit`/`plan`/`auto`/`full` |
| `parley.autoContinue` | `true` | Keep working until done in agent modes |
| `parley.maxToolRounds` | `50` | Max tool‑call rounds per turn before it auto‑continues (keeps its tools) |
| `parley.maxAutoContinue` | `25` | Max auto‑continue steps (`0` disables) |
| `parley.tokenLimit` | `0` | Per‑conversation token budget (`0` = unlimited) |
| `parley.autoCompactPercent` | `80` | Auto‑compact at this % of the context window (`0` off) |
| `parley.autoCompactTokens` | `0` | Absolute auto‑compact threshold (`0` off) |
| `parley.autoSaveConversations` | `true` | Auto‑save each conversation to disk |
| `parley.conversationsDir` | `""` | Folder for saved conversations (empty = global storage) |
| `parley.mcpServers` | `{}` | MCP servers `{ name: { command, args?, env? } }` |
| `parley.webSearch.provider` | `duckduckgo` | `off`/`duckduckgo`/`google`/`tavily` |
| `parley.webSearch.apiKey` | `""` | Key for Google/Tavily |
| `parley.webSearch.googleCx` | `""` | Google Programmable Search engine id |
| `parley.codebaseSearch.enabled` | `true` | Enable `@codebase` |
| `parley.codebaseSearch.provider` | `lexical` | `lexical` or `local` (on‑device semantic) |
| `parley.codebaseSearch.maxFiles` | `4` | Files `@codebase` includes |
| `parley.commandTimeoutSeconds` | `300` | Timeout for agent shell commands |
| `parley.inlineCompletion.enabled` | `true` | Ghost‑text completions |
| `parley.inlineCompletion.model` | `openai/gpt-5-nano` | Completion model |
| `parley.inlineCompletion.debounceMs` | `350` | Idle delay before a completion |
| `parley.video.maxFrames` | `12` | Max sampled video frames |
| `parley.video.frameWidth` | `768` | Downscale width for frames |
| `parley.video.maxAudioSeconds` | `600` | Max seconds of extracted audio |
| `parley.video.ffmpegPath` | `""` | Path to `ffmpeg` (else PATH) |
| `parley.context.maxCharacters` | `12000` | Max context characters per request |
| `parley.context.includeDiagnostics` | `true` | Include diagnostics on request |
| `parley.context.respectGitignore` | `true` | Respect `.gitignore` for context |
| `parley.confirmBeforeSendingLargeContext` | `true` | Preview/confirm large context |
| `parley.telemetry.enabled` | `false` | No telemetry is emitted |
| `parley.logLevel` | `info` | `error`/`warn`/`info`/`debug` |

---

## Models

Model ids are provider‑prefixed; the dropdown lists whatever `GET /v1/models`
returns (it updates automatically as MIT adds models). Observed families:

- **Anthropic (Bedrock):** `bedrock/claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-7`
- **OpenAI:** `openai/gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5.1`, `gpt-5.2`, `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.5`, `gpt-image-1`
- **Google:** `google/gemini-2.5-pro`, `gemini-3.0-flash`, `gemini-3.1-pro`
- **Meta:** `bedrock/llama-4-maverick-17b`

---

## What Parley can and can't do (gateway limits)

Verified live against the API:

- **Extended thinking** is honored on **Claude** and **Gemini**; on **OpenAI/GPT‑5**
  it's accepted but **not applied** by Parley today (see [Reasoning & speed](#reasoning--speed-important-nuances)).
- **No embeddings endpoint** — that's why the semantic `@codebase` index runs a local
  model instead of calling Parley.
- **No client‑controlled prompt caching** — Anthropic `cache_control` breakpoints are
  accepted but **not propagated** to Bedrock (verified live: no cache writes/reads from
  explicit markers), so the extension doesn't send them. Bedrock still applies *automatic*
  prompt caching to repeated prefixes transparently, at no cost or effort to you.
- **No web‑search endpoint** — `web_search` calls DuckDuckGo/Google/Tavily directly.
- **No video content type** — video is approximated with ffmpeg (frames/audio).
- **Stateless** — there's no server‑side conversation history; full context is sent
  each turn (hence compaction/limits matter).
- **File uploads** (`/v1/files`, used for PDFs and large text) are OpenAI/Google only,
  cap at 20 files/account, and expire after 48h.

---

## Troubleshooting

- **"No data provider registered" / empty view** — reload the window after install.
- **"Parley rejected the API key"** — run `Parley: Set API Key` again.
- **Reasoning seems to do nothing on GPT‑5** — expected; use Claude/Gemini for
  reasoning (gateway limitation).
- **`@codebase` (local) returns nothing** — run `Parley: Rebuild Codebase Index`; if
  the model can't download/load it falls back to lexical (check `Parley: Open Debug Log`).
- **Video attach says ffmpeg missing** — install ffmpeg or set `parley.video.ffmpegPath`.
- **A command "timed out"** — raise `parley.commandTimeoutSeconds` (default 300s).
- **Anything streaming‑related looks wrong** — run `Parley: Run Diagnostics` and/or
  open the debug log; both surface the real provider/model and any error.

---

## Development & packaging

```bash
npm install
npm run compile           # tsc typecheck -> out/  +  esbuild bundle -> dist/extension.js
npm test                  # compile + node --test (unit)
npm run lint              # eslint
npm run format            # prettier --write
npm run watch             # esbuild --watch (rebuilds dist/ on save for F5)
npm run test:integration  # launches VS Code (needs a display; CI uses xvfb)
npm run package           # @vscode/vsce -> parley-vscode-<version>.vsix
```

The extension is **bundled with esbuild** into two files: `dist/extension.js` (the
extension host code) and `dist/webview.js` (the chat UI — `media/chat.js` plus
`markdown-it` and `highlight.js`), so the VSIX stays small (~350 KB) and
platform‑agnostic — no `node_modules` is shipped. The one optional runtime dependency
(`@xenova/transformers`, for the local semantic `@codebase` index) is **not** in the
package; it's installed on demand into global storage the first time you build the
index. Press **F5** for an Extension Development Host (run `npm run watch` alongside
to keep `dist/` fresh).

CI (GitHub Actions) typechecks, unit‑tests, bundles/packages, and runs VS Code
integration tests on every push to `main` (Node 22); a `vX.Y.Z` tag publishes a GitHub
Release with the `.vsix` (and, if the `VSCE_PAT` / `OVSX_PAT` secrets are set, to the
Marketplace / Open VSX).

---

## Architecture

- `src/parley/ParleyClient.ts` — the client (chat + streaming + tool loop,
  `/models`, `/chat/completions`, `/images/generations`, `/files`,
  `/messages/count_tokens`, `/accounts/{id}/usage`) behind the `ParleyProvider` interface.
- `src/parley/retry.ts` / `src/parley/clampText.ts` — transient-failure retry policy
  and honest head+tail truncation of tool results.
- `src/parley/tools.ts` — agent tool definitions.
- `src/webview/ChatPanel.ts` + `media/` — the chat UI, agent loop, attachments,
  mentions (`media/chat.js` is bundled with markdown-it + highlight.js into `dist/webview.js`).
- `src/mcp/` — MCP stdio client + tool‑name mapping.
- `src/codebase/` — lexical ranking + the optional local embedding index.
- `src/web/webSearch.ts` — web‑search providers.
- `src/video/ffmpeg.ts` — frame/audio extraction.
- `src/diff/` — line diff, unified‑diff cards, diff‑review‑before‑apply, checkpoints,
  and `editMatch.ts` (tiered snippet matching + closest‑match repair hints).
- `src/transcript/` — the full conversation transcript model, pure md/txt renderers, and
  the `.parley` on‑disk store (append‑only JSONL + index + state).
- `src/completion/` — inline completion provider.
- `src/context/` — context collection, ignore rules, sensitive‑file filtering.
- `src/debug/debug.ts` — gated tracing.

Authentication material uses `SecretStorage`; credentials and request headers are
never logged.
