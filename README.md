<div align="center">

<h1>Parley for VS Code</h1>

<p><strong>A VS Code AI coding assistant powered by MIT's Parley gateway</strong><br/>
A streaming chat sidebar, an agent that reads and edits your workspace, multimodal context,<br/>
and every change diff-reviewed before it touches your files — all inside VS Code.</p>

<p>
  <a href="CHANGELOG.md"><img alt="Version" src="https://img.shields.io/badge/version-1.51.0-A31F34"></a>
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.92-1F6FEB">
  <a href="https://opensource.org/licenses/MIT"><img alt="License" src="https://img.shields.io/badge/license-MIT-3FB950"></a>
  <img alt="Tests" src="https://img.shields.io/badge/tests-388%20passing-2EA043">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6">
</p>

</div>

---

## Highlights

- **Agentic editing, safely** — six modes from plain chat to full autonomy; every edit is diff-reviewed, checkpointed, and **rewindable** per message. **Review multiple changed files in one native multi-diff editor.**
- **Test-runner loop** — **`/verify`** (in-chat) or **`Fix Failing Tests`** (command), backed by the `run_tests` tool, run your suite (auto-detected: npm / pytest / cargo / go / maven / gradle), read the failures, fix, and re-run until green.
- **Any model on the gateway** — Claude, GPT, Gemini and more, switchable per conversation; `/compare` runs one prompt on two models side by side.
- **Deep context** — `@file` / `@codebase` (lexical or on-device semantic, attaching the matched region) / `@problems` / `@terminal` / `@git` / `@browser` mentions, project rules, and **agent-maintained project memory** that compounds across conversations.
- **Editor code actions** — right-click "Parley" submenu and the `Ctrl+.` lightbulb: Explain, Refactor, Generate tests, **Add docs**, Fix. Plus one-click **commit-message** and **PR-description** generation.
- **Multimodal in & out** — attach images, PDFs, audio, **video**; **🎤 voice input**, **🔊 read-aloud + hands-free voice mode**, and **📷/🎥 screen capture** (screenshot or recording with narration).
- **Computer use** ⚠ — with your explicit opt-in, `/computer` drives your real mouse & keyboard to do desktop tasks (built-in Windows backend or optional cross-platform nut.js), with a corner-slam kill switch and per-action confirm.
- **Local browser & parallel subagents** — drive a real headless Chromium, or fan out several scoped read-only investigations at once.
- **MCP** — connect stdio, streamable-HTTP, and legacy-SSE Model Context Protocol servers, with a **status view** for connected servers, their tools, and any failures.
- **Safety & privacy first** — sensitive-file filtering, **outbound secret redaction**, **prompt-injection defenses** on untrusted content, a per-segment command allowlist, and honest documentation of gateway limits.
- **Transparent by design** — full on-disk JSONL transcripts, live cost/context gauges + status-bar ticker, a `/context` breakdown, and 388 automated tests. CI packages a GitHub Release on every version tag.

Built around a `ParleyProvider` abstraction, so the UI, context collection, diff review, and safety controls stay independent of the transport.

> 📖 **Want the full tour?** See **[FEATURES.md](FEATURES.md)** — a complete, organized catalog of every feature.

---

<details>
<summary><strong>Contents</strong></summary>

- [How Parley compares](#how-parley-compares)
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
- [Voice & sound](#voice--sound)
- [Screen capture](#screen-capture)
- [Computer use ⚠](#computer-use-)
- [Reviewing code (branch · staged · diagnostics)](#reviewing-code-branch--staged--diagnostics)
- [Project memory](#project-memory-agent-maintained)
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

</details>

---

## How Parley compares

Parley is a VS Code **extension** over MIT's OpenAI‑compatible **Parley** gateway. The other
three are a standalone editor (**Cursor**), OpenAI's coding agent (**Codex**), and Anthropic's
(**Claude Code**). At a glance:

| Capability                              | Parley                                              | Cursor            | Codex             | Claude Code          |
| --------------------------------------- | --------------------------------------------------- | ----------------- | ----------------- | -------------------- |
| **Form & backend**                      |                                                     |                   |                   |                      |
| Delivery                                | VS Code extension                                   | Standalone editor | CLI + IDE + cloud | CLI + IDE + web      |
| Models                                  | Any on the Parley gateway (Claude · GPT · Gemini …) | Multiple (hosted) | OpenAI            | Anthropic Claude     |
| Source                                  | Open (MIT)                                          | Proprietary       | CLI open‑source   | Proprietary          |
| **Agent**                               |                                                     |                   |                   |                      |
| Agentic edit loop + modes               | ✅ (6 modes)                                        | ✅                | ✅                | ✅                   |
| Diff‑review + checkpoints / rewind      | ✅                                                  | ✅                | ◐                 | ✅                   |
| Command execution                       | ✅ allowlist                                        | ✅                | ✅ OS sandbox     | ✅ allowlist/sandbox |
| Editable plan mode                      | ✅                                                  | ✅                | ◐                 | ✅                   |
| In‑session subagents                    | ✅ local (+ parallel)                               | ✅                | ✅                | ✅                   |
| Computer use (mouse/keyboard)           | ✅ opt‑in (Win / nut.js)                            | ✗                 | ◐ cloud           | ◐ (beta)             |
| Background / cloud agents               | ✗ (out of scope)                                    | ✅                | ✅                | ✅                   |
| **Context & retrieval**                 |                                                     |                   |                   |                      |
| @‑mentions + codebase retrieval         | ✅                                                  | ✅                | ✅                | ✅                   |
| Semantic index                          | ✅ on‑device                                        | ✅ server‑side    | ◐ agentic grep    | ◐ agentic grep       |
| Rules files                             | ✅ (+ globs)                                        | ✅ (+ memories)   | ✅ (AGENTS.md)    | ✅ (CLAUDE.md)       |
| MCP                                     | ✅ stdio · HTTP · SSE                               | ✅                | ✅                | ✅ (+ OAuth)         |
| **Editor UX**                           |                                                     |                   |                   |                      |
| Inline "Tab" completion (trained model) | ◐ ghost‑text                                        | ✅                | ✗                 | ✗                    |
| Multimodal in / out                     | ✅ image·PDF·audio·**video**·**voice·screen**       | ◐ image           | ◐ image           | ◐ image · PDF        |
| **Ecosystem & safety**                  |                                                     |                   |                   |                      |
| Hooks                                   | ✅ (4 events)                                       | ✗                 | ◐                 | ✅                   |
| Browser control                         | ✅ local Chromium                                   | ◐                 | ◐                 | ✅ (companion)       |
| Outbound secret scanning                | ✅ redact                                           | ◐ file‑level      | ◐ file‑level      | ◐ file‑level         |
| Full on‑disk event transcripts          | ✅ (JSONL + export)                                 | ◐                 | ◐                 | ◐                    |

**✅ supported · ◐ partial or different approach · ✗ not available.** Parley's column reflects
the current code (v1.5.0). Competitor columns reflect publicly documented capabilities as of
early 2026 and are **best‑effort** — these tools move fast, so check their own docs for the
latest. Parley's deliberate non‑goals (a trained Tab/next‑edit model, background/cloud agents,
server‑side embeddings) follow from running on a shared gateway rather than dedicated
infrastructure; see [What Parley can and can't do](#what-parley-can-and-cant-do-gateway-limits).

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

> **Note on on‑demand installs.** To keep the VSIX tiny, two **opt‑in** features fetch
> their heavy native runtime the first time you use them — nothing is installed unless
> you turn them on:
>
> - the **local semantic `@codebase` index** installs an on‑device embedding runtime
>   (`@xenova/transformers`, needs `npm` on PATH) into the extension's global storage;
> - the **browser tools** (`@browser`, `browser_navigate`) install **Playwright** + a
>   headless Chromium the same way;
> - the optional **nut.js** computer-use backend installs the same way, only after you
>   accept its license in the first-run consent dialog.
>
> These download from the public npm registry into the extension's private global storage
> (never your project), run fully on your machine, and are off by default. If your
> environment disallows runtime installs, simply leave these features off — everything
> else works without them.

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
   `https://parley-admin.atlas-apps.mit.edu` → _My Account_) or get one from your
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
unknown for a model), and buttons: **＋** new conversation, **🕘** past conversations,
and a **⋯** overflow (Usage, Refresh model list, Settings). A **🎨** design‑preview
button appears when the last turn produced an artifact. The **conversation title bar**
below shows **‹ back**, the title (**double‑click to rename**), and its own **⋯** menu
(Rename · Export · Compact · Archive · Delete, with Delete separated).

**Composer (bottom):**

- A **Context** disclosure with pill toggles (**Selection**, **File**, **Open editors**,
  **Diagnostics**) controlling what's auto‑attached; when collapsed it summarizes what's
  on (e.g. *"Context — Selection, Diagnostics"*). Choices persist across reloads.
- A **selection pill** — when you have text selected in an editor, the composer
  shows `file.ts:12-40 selected` with a **👁 toggle**, so you always know whether
  the selection will ride along with your next message.
- The **prompt box**. `Enter` sends, `Shift+Enter` is a newline. Type **`@`** for
  fuzzy file/`@codebase`/`@git` mentions, **`/`** for the command menu, and
  **paste or drop** any file directly.
- A **＋ Add** menu (add context, attach files, browse the web, screenshot, screen
  recording, computer control, and prompt snippets), a **🎤** mic (its **▾** caret
  toggles hands‑free voice mode), a **`/`** slash button, and a **🎨** design‑canvas
  button. On the right: the **model dropdown**, a **`Mode ▾`** popover (mode + thinking
  + speed), and **Send**.

**While the agent works** a pulsing **status line** shows what it's doing, the
elapsed time, and a live token count. **Scrolling up pauses autoscroll** so you can
read earlier messages while output streams; a floating **↓** pill jumps back to the
latest. Replies render as full Markdown with **syntax-highlighted code blocks**
(colors follow your VS Code theme).

---

## Modes (chat → full agent)

Open the **`Mode ▾`** popover (or set `parley.defaultMode`):

| Mode                   | Behavior                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chat**               | Answer only; no file tools (default).                                                                                                                                             |
| **Ask before edits**   | Agent proposes edits; approve each on an in‑chat card (Apply / Choose hunks… / Reject) with the full diff opened beside.                                                          |
| **Edit automatically** | Agent applies edits without asking (checkpointed/revertible).                                                                                                                     |
| **Plan**               | Agent explores **read‑only** and presents a plan, which then **opens as an editable markdown doc** — edit it, then click **Build**: your edited version is what gets implemented. |
| **Auto**               | Agent decides and applies edits automatically.                                                                                                                                    |
| **Full access** ⚠      | **CAUTION** — auto‑applies edits **and runs shell commands without asking**.                                                                                                      |

Shell commands require confirmation in **every mode except Full access** (and in an
**untrusted workspace**, even Full access asks). Edits are always checkpointed
(`Parley: Revert Last Edit` / `Revert All Edits`). Note that the **read/search,
`fetch_url`, `web_search`, `browser`, and `capture_screen` tools run automatically in
every agent mode** — "Ask before edits" gates *edits*, not those. Restrict network egress
with `parley.allowedFetchHosts` if you want an allowlist for `fetch_url`/`browser`.

Edits **preserve each file's on-disk format** — a CRLF file stays CRLF (not flipped
to LF), and a UTF-16/BOM file keeps its encoding instead of being corrupted to UTF-8 —
on both write and revert.

**Auto‑continue.** In agent modes the agent keeps working on its own until the task
is complete (`parley.autoContinue`, on by default), up to a safety cap
(`parley.maxAutoContinue`). It signals completion with a `<DONE>` marker; you can
**Stop** at any point. If a step makes no progress (empty reply, no tool calls) it
stops cleanly instead of looping.

---

## The agent: tools, activity, plan, edits

In any tool mode the model runs an OpenAI tool‑calling loop. Built‑in tools:

| Tool                                                 | What it does                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `read_file`                                          | Read a file (optional `start_line`/`end_line` for big files)                                                     |
| `list_directory`, `find_files`                       | Explore the tree / glob for files                                                                                |
| `grep`                                               | **Regex** search of file contents (VS Code's bundled ripgrep; case flag, context lines, glob filter)             |
| `search_text`                                        | Simple substring search of file **contents**                                                                     |
| `find_symbol`, `document_symbols`, `find_references` | **Language-server** navigation: where is X defined, a file's outline, all usages of a symbol                     |
| `edit_file`                                          | Precise find‑and‑replace edit (reviewed/checkpointed)                                                            |
| `multi_edit`                                         | Several edits to one file, applied atomically (all‑or‑nothing; one review/checkpoint)                            |
| `write_file`                                         | Create/overwrite a file (reviewed/checkpointed)                                                                  |
| `run_command`                                        | Run a shell command (confirmation required except Full access)                                                   |
| `fetch_url`                                          | Fetch a public `https://` page as text (raw HTML, no JS)                                                         |
| `browser_*`                                          | Drive a local Chromium: `navigate`/`read`/`console`/`click`/`type`/`screenshot` (runs JS; installs on first use) |
| `web_search`                                         | Search the web (see [Web search](#web-search))                                                                   |
| `generate_image`                                     | Generate an image/figure/illustration from a description and show it inline (via the gateway's image model)      |

Replies can also include **rendered figures**: a ` ```mermaid ` code block renders inline as a diagram (flowcharts, sequence, ER, …; lazy-loaded, theme-aware), and `generate_image` produces illustrations/pictures.
| `run_subagent`                                       | Delegate a scoped read-only investigation to a subagent (fresh context; returns only its report)                 |
| `run_subagents`                                      | Run several **independent** read-only investigations **concurrently** (up to 5); reports come back aggregated    |
| `remember`                                           | Save a durable project fact to `.parley/memory.md` (injected into future conversations)                          |
| `update_plan`                                        | Maintain the live task checklist                                                                                 |
| `mcp__<server>__<tool>`                              | Any tools from your configured [MCP servers](#mcp-servers)                                                       |

Custom **subagent types** live in `.parley/agents/*.md` (frontmatter `description:` + optional `model:`; body = the subagent's system prompt); the agent can target one via `run_subagent`/`run_subagents`' `agent` parameter.

**Skills** (Claude-style progressive disclosure): a `.parley/skills/<name>/SKILL.md` (frontmatter `description:`; body = full instructions; bundle any helper scripts/files in the folder) defines a skill. Only each skill's name + description sits in the prompt always; the agent calls the `load_skill` tool to pull the full instructions **on demand** when a task matches — so you can keep many skills at almost no context cost. Scaffold one with **`Parley: Create Skill`**. Code blocks in **Chat**-mode replies also get an **Apply** button, and diagnostics offer **Fix with Parley** in the `Ctrl+.` lightbulb.

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
aborts in‑flight work _and kills a running command_.

**Resilience.** Transient failures — rate limits (429), upstream/server errors (5xx),
network blips, mid‑stream errors — are **retried automatically** (up to 3 times, with
backoff and `Retry-After` support) instead of killing the task; the status line shows
e.g. `Rate-limited — retrying in 2s (attempt 2/4)…`. Retries only happen while nothing
has streamed yet, so output is never duplicated. Long tool output is truncated
**honestly**: head + tail are kept around an explicit `[… N characters omitted …]`
marker, so the model sees the end of a command's output (where the error lives) and
knows exactly what was cut.

**Self‑correction.** After each applied edit, Parley reads the editor's **live
diagnostics** and reports any _new_ errors/warnings back to the agent (`⚠ This edit
introduced 2 new problem(s)…`), so it fixes its own breakage before declaring victory.
A failed `edit_file` match returns the **closest real region of the file** (numbered
lines + similarity) so the model repairs its snippet in one round; matching itself is
tiered (exact → indentation‑tolerant → whitespace‑tolerant). And Parley hashes every
file the agent reads: overwriting an existing file **requires a fresh read**, so a
change you made mid‑conversation can never be silently clobbered.

**Command allowlist.** On the run‑command confirmation, **Always Allow** stores the
command as a workspace prefix rule (`npm test` also approves `npm test -- --grep foo`);
matching commands then run without asking. A compound command is checked **per
segment** — `npm test && rm -rf /` is _not_ auto‑approved just because `npm test` is
allowed — and any command using substitution (`$(…)`, backticks, `<(…)`) always
prompts and can never be stored as a rule. Review rules with
**`Parley: Manage Allowed Commands`**.

**Steering.** The composer stays live while the agent works. A **`⏳ Queue`/`⏩ Steer`
toggle** by the composer decides how a mid‑task message is handled: **Steer** injects it
into the current answer at the agent's **next step** (redirect without stopping) — and it
appears in the conversation **immediately** (tagged *"steering"*, with a removable chip to
cancel); **Queue** runs it as its own turn after this one finishes.

**Rewind & fork (⏪ / ✏️).** Hover any of your messages: **⏪** offers **Rewind
conversation (fork)** — continue from before that message while the original stays
saved in full — **Rewind files** (restore everything edited from that point, from the
conversation's persisted checkpoints), or **both**. **✏️ Edit & resend** loads the
message into the composer and forks on send. Checkpoints are stored per conversation
in `.parley/checkpoints/`, so `Parley: Revert Last/All Edits` **survives window
reloads** and works in reopened conversations.

---

## Reasoning & speed (important nuances)

Open **`Mode ▾`** → **Extended thinking** and **Speed**. These behave differently
per provider — verified live against the gateway:

| Control                                           | Claude (Bedrock)          | Google / Gemini   | OpenAI / GPT‑5.x                                |
| ------------------------------------------------- | ------------------------- | ----------------- | ----------------------------------------------- |
| **Extended thinking** (Off/Adaptive/Low/Med/High) | ✅ works (real reasoning) | ✅ affects output | ⚠️ **accepted but not applied** by Parley today |
| **Speed** (Standard / ⚡ Fast)                    | n/a                       | n/a               | ✅ Fast sends `service_tier: priority`          |

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

Type **`@`** in the composer — the autocomplete is **fuzzy** (`@chpanel` finds
`ChatPanel.ts`), ranks files you have open first, and also offers folders and the
special mentions below:

| Mention            | Effect                                                                              |
| ------------------ | ----------------------------------------------------------------------------------- |
| `@path/to/file`    | Attach that file's contents (fuzzy autocomplete as you type)                        |
| `@file.ts#12-40`   | Attach only lines 12–40 of the file (also `#12` or `#L12-L40`)                      |
| `@path/to/folder/` | Attach a listing of the folder                                                      |
| `@sym:<name>`      | Find a function/class/symbol by name via the language server; attaches its source   |
| `@codebase`        | Retrieve the most relevant files for your question (see below)                      |
| `@problems`        | Attach the current errors & warnings from the Problems panel (errors first)         |
| `@git`             | Attach the uncommitted diff (vs HEAD)                                               |
| `@blame`           | Attach `git blame` for the active selection/file — "why does this code exist"        |
| `@issue <n>`       | Attach a GitHub issue (title/body/comments) via the `gh` CLI                         |
| `@pr [n]`          | Attach a GitHub PR (current branch, or a number) via the `gh` CLI                    |
| `@terminal`        | Attach recent integrated-terminal commands + output (shell integration)             |
| `@browser <url>`   | Open the URL in a local browser (runs JS) and attach rendered text + console errors |
| `@https://…`       | Fetch the page and attach its text                                                  |

**From the editor:** press **`Alt+K`** to drop an `@file#start-end` mention of the
current selection into the chat, or right-click a file (Explorer, editor, or editor
tab) → **Parley: Add File to Chat Context**.

---

## `@codebase` search (lexical + optional local semantic)

`@codebase` pulls the most relevant workspace files into context for your question.
Controlled by `parley.codebaseSearch.provider`:

- **`lexical`** (default) — keyword ranking (term frequency + filename‑match boost).
  **Keyless, private, instant**, no setup. Great for known identifiers/strings; ~80%
  of the value of semantic search.
- **`local`** — a **true semantic index** using an **on‑device MiniLM embedding
  model** (transformers.js / ONNX). **Keyless and fully private** (nothing leaves
  your machine); finds files by _meaning_, not just keywords. To use it:
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
> the binaries that match _your_ machine — only when you opt in. The default (`lexical`)
> needs nothing.

`parley.codebaseSearch.maxFiles` (default 4) controls how many files are included.
With the **`local`** provider, each hit attaches the **region around the matched chunk**
(a little context + one window, labeled `@codebase path:from-to`) rather than the top of
the file — so large files contribute the code that actually matched your question. The
lexical provider (and small files) still attach the file head.

---

## Slash commands (built-in + your own)

Type **`/`** in the composer for an autocomplete menu.

| Command              | Effect                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `/clear` (or `/new`) | Start a new conversation                                                                                  |
| `/compact`           | Summarize to free context (choose keep‑recent or all)                                                     |
| `/cost`              | Show this conversation's token/cost usage                                                                 |
| `/model`             | Switch the model                                                                                          |
| `/compare [prompt]`  | Run a prompt on a **second model side by side**; adopt either reply (reuses your last message if omitted) |
| `/verify [command]`  | **Fix until green** — run the project's tests, fix failures, repeat (agent modes)                         |
| `/computer <task>`   | **Computer use** ⚠ — drive your mouse & keyboard for a desktop task (opt-in; see below)                   |
| `/init`              | **Analyze the repo** and write a tailored `AGENTS.md` (static template in Chat/Plan mode)                 |
| `/memory`            | Show exactly what's injected as project rules + memory, labeled by source (precedence: specific wins)     |
| `/json`              | Make the **next** reply a JSON object (`response_format`)                                                 |
| `/help`              | List commands                                                                                             |

**Custom commands:** drop a `name.md` file in **`.parley/commands/`** or
`.claude/commands/`, or the global **`~/.parley/commands/`** / `~/.claude/commands/`
(workspace wins on a name clash), and it becomes **`/name`**. The body is the prompt,
with **`$ARGS`** replaced by anything typed after the command and **`$SELECTION`** by
the active editor selection. Optional `description:` frontmatter shows in the `/` menu.

---

## Attachments: image, PDF, audio, video

Use the **📎** button, or **paste** (Ctrl/Cmd+V) / **drag‑and‑drop** onto the
composer. Dropping works for **any** file: files dragged from the VS Code Explorer
become `@path` mentions; code/text files dragged from the OS shell attach as text
context; media attaches as below. Files that look like credentials (`.env`, keys,
etc.) are refused everywhere — 📎, drops, and right‑click alike:

| Type                                                     | Handling                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Text / code** (txt, md, csv, json, xml, html, source…) | Added as context. If larger than `parley.context.maxCharacters`, it's **uploaded via `/v1/files`** on OpenAI/Google so the full file reaches the model; inline (truncated) on Bedrock/Anthropic.                                                                                                                    |
| **Images** (png, jpg, gif, webp, bmp)                    | Sent inline as `image_url` to vision models (Claude, Gemini, GPT‑5).                                                                                                                                                                                                                                                |
| **PDFs**                                                 | OpenAI/Google: **uploaded** to `/v1/files`; Bedrock/Anthropic: inline base64 `document` block.                                                                                                                                                                                                                      |
| **Audio** (wav, mp3)                                     | Sent as an `input_audio` block (OpenAI/Google only; warns otherwise).                                                                                                                                                                                                                                               |
| **Video** (mp4, mov, mkv, webm, avi…)                    | Via **ffmpeg** (Parley has no video type): choose **sample frames** (→ images), **extract audio** (→ `input_audio`), or **both**. Needs `ffmpeg`/`ffprobe` on PATH or `parley.video.ffmpegPath`. Tune with `parley.video.maxFrames` / `frameWidth` / `maxAudioSeconds`. Use the 📎 button (ffmpeg reads from disk). |

Attachments show as removable chips and are cleared after sending.

---

## Voice & sound

- **🎤 Voice input** — click the mic to record, click again to transcribe; the text lands at your cursor. Audio is captured and encoded to WAV locally, then transcribed by an audio-capable model (`parley.voice.model`, or the current one).
- **🔊 Read aloud** — every assistant reply has a speak button (uses your OS text-to-speech voices — free, offline; code blocks are skipped). `parley.voice.autoRead` reads every reply automatically.
- **🗣 Voice mode** — hands-free: recordings auto-send and replies are read aloud, so you can talk through a problem while reading code.
- **Completion chime** — `parley.sound.chimeOnDone` plays a soft chime when a turn finishes while the window is unfocused (audio twin of the activity-bar unread badge).

---

## Screen capture

- **📷 Screenshot** — pick any window or screen; one frame attaches as an image for a vision model. "Look at this error dialog / design / graph" without saving a file.
- **🎥 Screen recording** — records your screen (60s max), sampling frames every few seconds **plus optional mic narration**; on stop, the frames and a `narration.wav` attach to the composer. Narrate a bug while reproducing it, then ask what went wrong. Video-only if the mic is unavailable.

Both use the browser's capture APIs feeding the normal attachment pipeline — no ffmpeg, no files on disk.

**Screenshot → UI:** **`Parley: Screenshot to UI`** takes it further — pick an image of a UI and Parley reproduces it as a self-contained HTML artifact rendered live in the **design canvas** (vision + artifact detection).

---

## Computer use ⚠

`/computer <task>` (or the 🖱️ composer button) lets Parley **control your real mouse and keyboard** to perform a desktop task: it screenshots the screen, decides one action at a time (click / type / key / scroll), executes it, and re-checks until done. This is the most powerful — and most dangerous — capability Parley ships, so it's wrapped in gates:

- **Off by default** — enable `parley.computerUse.enabled`. A **first-run consent** dialog explains the feature and lets you pick a backend.
- **Backends** (`parley.computerUse.backend`): **built-in** (Windows-only, PowerShell + .NET, no install) or **nut.js** (cross-platform; a native module under its own GPL-3.0 / paid-commercial license, installed on demand into global storage only after you accept its terms).
- **Escape hatches:** a **corner-slam kill switch** (fling the mouse into any screen corner — works even when VS Code isn't focused), the **Stop** button, a per-run confirm, a step cap (`parley.computerUse.maxSteps`), an in-chat log of every action, and an optional **confirm-each-action** mode (`parley.computerUse.confirmEachAction`). The system prompt refuses destructive/irreversible actions and stops on unexpected screens or on-screen instructions.

> Accuracy depends on the model's visual grounding — Claude models are trained for computer use and do best; others may misclick.

---

## Reviewing code (branch · staged · diagnostics)

- **`Parley: Review Current Branch`** — diffs your branch against its merge-base with `main`/`master` and streams a severity-grouped review **plus a ready-to-paste PR title & description**.
- **`Parley: Generate PR Description`** (also in the Source Control ⋯ menu) — writes _only_ a clean, paste-ready PR description (title · Summary · Changes · Test plan) from the branch diff; opens in a markdown doc and copies to the clipboard. Use this when you want the description without the code review.
- **`Parley: Generate Commit Message`** (Source Control ⋯ menu) — summarizes the staged diff (or working tree) into a Conventional Commits message and drops it into the commit box.
- **`Parley: Review Staged Changes`** (also in the Source Control ⋯ menu) — reviews exactly what you're about to commit, ending with a suggested commit message.
- **`@git`** / **`@problems`** mentions — the uncommitted diff, or the current errors & warnings, in-chat for a quick look or a "fix these" turn.
- **Fix with Parley** — any diagnostic squiggle offers a Quick Fix (`Ctrl+.`) that sends the specific problems + code excerpt to the chat.
- **`Parley: Fix Failing Tests`** (command) / **`/verify`** (in-chat) — run your test suite (auto-detected: npm / pytest / cargo / go / maven / gradle, or set `parley.testCommand` / `parley.verifyCommand`); on failure the agent fixes and re-runs via the `run_tests` tool until green. Needs an agent mode that can run commands (Ask/Edit/Auto/Full).
- **Fix Last Terminal Command** — when a terminal command fails, a transient status-bar hint (and `Parley: Fix Last Terminal Command`) sends the command + output to the chat for a fix.
- **Multi-file review** — the end-of-turn "N files changed" card's **Review** button opens every changed file in VS Code's native multi-diff editor (one scrollable before/after view).

---

## Project memory (agent-maintained)

When the agent learns a durable, non-obvious fact ("integration tests need Docker", "deploys run from `scripts/ship.ps1`", a preference you stated), it saves one line to **`.parley/memory.md`** via the `remember` tool — and every future conversation starts with that memory injected into the system prompt (like project rules). Review or prune it with **`Parley: Open Project Memory`**; it's plain markdown you own. Secrets and task-local trivia are excluded by design.

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

**Remote servers** work too — streamable HTTP (default for `url`) or legacy SSE:

```jsonc
"parley.mcpServers": {
  "github": { "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer <PAT>" } },
  "legacy": { "url": "https://example.com/sse", "type": "sse" }
}
```

Parley launches/connects each server, runs the handshake, lists its tools, and exposes
them to the agent as **`mcp__<server>__<tool>`** (available in every agent mode except Plan).
Run **`Parley: Reconnect MCP Servers`** after editing the config; it also restarts
automatically when the setting changes. A server that fails to start is skipped — chat
keeps working. **`Parley: MCP Server Status`** shows each server (connected vs failed,
transport, tool count) in a QuickPick; drill into one to list its tools, or read the
exact error for a server that didn't connect.

---

## Inline completion & inline edit

- **Ghost‑text completion:** as you type, Parley suggests a completion at the cursor
  (fill‑in‑the‑middle). It's **diff‑aware** — the model is fed your recent edits as
  before→after deltas (`was X → now Y`), Cursor‑Tab style, so completions track what
  you're actually changing. A small **LRU cache** serves a cursor bounce or
  backspace‑and‑retype instantly, and a duplicated trailing closer (`}`, `)`, `;`) the
  text after the cursor already has is trimmed so completions don't double it. Toggle with
  **`Parley: Toggle Inline Completion`**; configure with `parley.inlineCompletion.*` —
  a fast `model` (default `openai/gpt-5-nano`), `debounceMs`, `maxPrefixChars`/
  `maxSuffixChars` (context window), and `disabledLanguages` (turn it off per language,
  e.g. markdown/plaintext).
- **Inline edit (`Ctrl+Alt+K` / `Cmd+Alt+K`):** select code, describe the change,
  review the diff before applying. Multi‑change edits offer **Apply All / Choose… /
  Reject** — "Choose…" accepts/rejects **individual hunks**. Edits are checkpointed.
- **Predict Next Edit (`Ctrl+Alt+N`, Cursor‑Tab style):** from your recent edits + the
  current file, Parley predicts the single most likely next change (a sibling case, a
  related call site, a type, a matching test) and marks its location with a decoration +
  a status‑bar hint. **Tab** jumps the caret there — showing the change as native ghost
  text — and a second **Tab** accepts it; **Escape** dismisses. The Tab binding is gated
  by a `parley.hasNextEdit` context key, so it never interferes with normal Tab. Enable
  **`parley.nextEdit.autoTrigger`** for a hands‑free feel (predicts after edits settle;
  off by default — it's a model call per prediction). A modal‑diff variant is available
  as **Predict Next Edit (Diff Review)**.

---

## Cost, context & limits

- **Estimated cost** (`~$`) accumulates in the header from Parley's published
  per‑model rates (unknown models show tokens only; Llama is free).
- **`Parley: Show Usage`** reports your account's **real billed spend** for the month
  (cost, requests, tokens). Needs `parley.accountId` (Admin Portal → _My Account_;
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
  Typing **3+ characters** in the picker also **searches the transcript text** on disk and
  shows a snippet of each match — find conversations by what was said, not just the title.
- **Export:** **⤓** or `Parley: Export Conversation` first **completes and saves the
  canonical transcript**, then writes a **copy** in your chosen format — **Markdown, plain
  text, or JSON** — to wherever you pick. The copy contains the entire transcript with a
  metadata header (model(s), mode, thinking level, speed, message count, tokens, cost).
- **Compact:** **⊟**, `/compact`, or `Parley: Compact Conversation` — summarize the
  conversation (choose _keep recent_ or _everything_) to continue with fewer tokens. (This
  trims the model's context; the saved transcript keeps the full record.)

---

## Git, images & editor commands

- **`Parley: Generate Commit Message`** — summarizes the staged diff (or working
  tree) into a Conventional Commits message and drops it into the Source Control box.
- **`Parley: Generate Image`** — `gpt-image-1`; choose size + quality; saves the PNG
  to `parley-images/`.
- Selection/file commands stream their reply into the chat:
  **`Ask About Selection`**, **`Explain Current File`** (explains your selection when
  you have one), **`Refactor Selection`**, **`Generate Tests`**, **`Add Docs`**,
  **`Fix Diagnostics`**, **`Suggest Terminal Command`** (inserts into a terminal; never
  auto‑runs). These live in the editor right‑click **Parley** submenu, and the
  selection ones (Refactor / Edit / Generate tests / Add docs / Explain) also appear in
  the **`Ctrl+.`** lightbulb (Refactor) menu.

---

## Hooks

**`parley.hooks`** runs your shell commands at fixed points (event JSON on stdin;
**exit 2 intervenes**, Claude‑Code‑compatible):

```jsonc
"parley.hooks": {
  "PreToolUse":  [{ "matcher": "run_command|write_file", "command": "node guard.js" }], // exit 2 blocks the tool
  "PostToolUse": [{ "matcher": "edit_file", "command": "npm run lint --silent" }],      // exit 2 → feedback to the model
  "UserPromptSubmit": [{ "command": "git branch --show-current" }],                     // stdout attaches as context
  "Stop": [{ "command": "msg * Parley finished" }]                                      // notification only
}
```

## Project rules

A **`.parleyrules`**, **`AGENTS.md`**, or **`.cursorrules`** file in the workspace
root is auto‑injected into the system prompt as project rules (first match wins).
Scaffold one with **`Parley: Init Project Rules`** (or `/init`). Reading
`AGENTS.md` (Codex) and `.cursorrules` (Cursor) means repos set up for those
agents work in Parley with zero migration.

**`CLAUDE.md` & `GEMINI.md` (Claude Code / Gemini CLI semantics).** These are
treated as always‑on memory — not one of the mutually‑exclusive files above — and
Parley loads them exactly the way those tools do:

- **Global** (`~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`), then the **project
  hierarchy** (the file from each workspace root up to your home directory), then
  **subtree** files (in the folders of files opened/edited this conversation —
  handy in monorepos). More‑general files come first; more‑specific ones win.
- **`@path` imports** — a memory file can pull in others with `@relative`,
  `@/absolute`, or `@~/home` paths, resolved recursively (up to 5 hops,
  cycle‑safe). Imports inside code fences / inline `code` and escaped `\@` are
  ignored.

So a repo already set up for Claude Code or Gemini CLI works in Parley with zero
migration.

**Rules directory (glob‑scoped).** Files in **`.parley/rules/`** or
**`.cursor/rules/`** (`.md`/`.mdc`) are each one rule, with optional frontmatter:

```md
---
description: React component conventions
globs: src/components/**, *.tsx
alwaysApply: false
---

Use function components with hooks; never class components.
```

Rules with `globs` attach only when the **active editor file** matches;
frontmatter‑less (or `alwaysApply: true`) rules always apply.

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
- **Outbound secret scanning** (`parley.secretScanning`, default **redact**) catches
  credentials embedded _inside_ otherwise-ordinary content — a file the agent read, or
  command output — before it reaches the gateway. It matches high-confidence prefixes
  (AWS `AKIA…`, GitHub `ghp_…`, OpenAI/Parley `sk-…`, Anthropic `sk-ant-…`, Slack, Stripe,
  Google, npm tokens, PEM private-key blocks) and replaces each with a marker, noting what
  was redacted. Set it to `warn` (notify but send as-is) or `off`.
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

| Command                                         | What it does                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Parley: Set API Key`                           | Store/verify your `sk-parley-…` key in SecretStorage                               |
| `Parley: Open Chat Window`                      | Focus the Parley chat view                                                         |
| `Parley: New Conversation in Tab`               | Open a parallel, independent conversation as an editor tab                         |
| `Parley: New Conversation in New Window`        | Same, floated into a separate OS window                                            |
| `Parley: New Conversation`                      | Save the current chat and start a fresh one                                        |
| `Parley: Open Past Conversation`                | Reopen an archived conversation                                                    |
| `Parley: Open Conversations Folder`             | Reveal the auto‑saved transcripts                                                  |
| `Parley: Export Conversation`                   | Export to Markdown / plain text / JSON                                             |
| `Parley: Compact Conversation`                  | Summarize history to free context                                                  |
| `Parley: Regenerate Last Response`              | Re‑run the last user message                                                       |
| `Parley: Ask About Selection`                   | Ask about the current selection                                                    |
| `Parley: Explain Current File`                  | Explain the active file                                                            |
| `Parley: Explain Symbol`                        | Explain the symbol under the cursor (also the hover "Explain with Parley" link)    |
| `Parley: Onboard Me to This Repo`               | New-contributor briefing: architecture, key files, how to run + a diagram          |
| `Parley: Screenshot to UI`                      | Pick a UI image → rebuild it as an HTML artifact in the design canvas              |
| `Parley: Ask About Notebook Cell`               | Explain / act on the selected Jupyter notebook cell(s)                            |
| `Parley: Fix / Explain Test`                    | From the Test Explorer item menu: run, diagnose, and fix a test                    |
| `Parley: Explain Commit / Compare Refs`         | Explain a commit, or summarize the diff between two branches/refs                  |
| `Parley: Refactor Selection`                    | Refactor the selection (diff‑reviewed)                                             |
| `Parley: Port / Translate Code`                 | Translate the selection/file to another language into a new document               |
| `Parley: Explain Stack Trace`                   | Parse a trace (selection/clipboard/input), open the top frame, explain + fix       |
| `Parley: Generate Tests`                        | Generate tests for the current file                                                |
| `Parley: Generate Tests for Uncovered Code`     | Run coverage, then write tests for the current file's uncovered lines (trusted ws) |
| `Parley: Add Docs`                              | Add idiomatic doc comments to the selection/file (also in the `Ctrl+.` menu)       |
| `Parley: Diagram This`                          | Render a Mermaid diagram (structure/class/sequence/deps) of the file inline        |
| `Parley: Predict Next Edit`                     | Cursor-Tab-style ghost prediction of your next edit — Tab to jump/accept (`Ctrl+Alt+N`) |
| `Parley: Predict Next Edit (Diff Review)`       | Same prediction, shown as a modal diff to review                                   |
| `Parley: Triage TODOs`                          | Scan for TODO/FIXME/HACK/XXX markers and tackle one                                |
| `Parley: Audit Dependencies`                    | Run npm/pnpm/yarn audit and explain the findings + remediation                     |
| `Parley: Fix Diagnostics`                       | Fix reported problems minimally (also "Fix with Parley" in the `Ctrl+.` lightbulb) |
| `Parley: Fix Failing Tests`                     | Run the test suite; on failure, fix and re-run via `run_tests` until green          |
| `Parley: Fix Last Terminal Command`             | Send the last failed terminal command + output to the chat for a fix               |
| `Parley: Suggest Terminal Command`              | Suggest a shell command (manual confirm)                                           |
| `Parley: Review Current Branch`                 | Review the branch vs its merge-base + draft a PR description                       |
| `Parley: Generate PR Description`               | Paste-ready PR title/summary/changes/test-plan from the branch diff (also SCM ⋯)   |
| `Parley: Create Pull Request`                   | Generate the description, confirm, push, and open the PR via `gh` (also SCM ⋯)     |
| `Parley: Generate Release Notes`                | Draft grouped release notes from commits since the last tag                        |
| `Parley: Split Into Logical Commits`            | Propose grouping the uncommitted diff into clean, self-contained commits           |
| `Parley: Review Staged Changes`                 | Review the staged diff before committing (also in the SCM ⋯ menu)                  |
| `Parley: File Edit History`                     | Every Parley edit to the current file, each openable as a before/after diff        |
| `Parley: Open Project Memory`                   | Open `.parley/memory.md` to review/prune what the agent has remembered             |
| `Parley: Show Memory & Rules`                   | View exactly what's injected as rules + memory, labeled by source (also `/memory`) |
| `Parley: Manage Prompt Snippets`                | Delete saved prompt snippets (save/insert them from the composer's ＋ menu)         |
| `Parley: Edit Selection (Inline)`               | Inline edit (`Ctrl+Alt+K` / `Cmd+Alt+K`)                                           |
| `Parley: Revert Last Edit` / `Revert All Edits` | Undo checkpointed edits                                                            |
| `Parley: Generate Image`                        | Generate an image with `gpt-image-1`                                               |
| `Parley: Generate Commit Message`               | Commit message from the diff → Source Control                                      |
| `Parley: Rebuild Codebase Index`                | Build the local semantic `@codebase` index                                         |
| `Parley: Manage Allowed Commands`               | Review/remove commands approved via "Always Allow"                                 |
| `Parley: Select Output Style`                   | Choose how Parley communicates (Default/Concise/Explanatory/Learning + custom)     |
| `Parley: Show Context Breakdown`                | Per-component estimate of what fills the context window (also `/context`)          |
| `Parley: Reconnect MCP Servers`                 | Restart MCP servers and show status                                                |
| `Parley: MCP Server Status`                     | See connected servers, their tools, and any startup failures                       |
| `Parley: Show Usage`                            | Real billed spend for the current month (from the gateway)                         |
| `Parley: Usage History`                         | Estimated spend over time — by-day chart + by-model table from saved transcripts   |
| `Parley: Set Token Limit`                       | Per‑conversation token budget                                                      |
| `Parley: Toggle Inline Completion`              | Enable/disable ghost‑text completions                                              |
| `Parley: Init Project Rules`                    | Analyze the repo → tailored `AGENTS.md` (static template in Chat/Plan mode)        |
| `Parley: Run Diagnostics`                       | Probe the live API and report what works                                           |
| `Parley: Open Debug Log`                        | Open the verbose debug log                                                         |
| `Parley: Sign Out`                              | Clear the stored API key                                                           |

---

## Settings reference

| Setting                                   | Default                         | Description                                                              |
| ----------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| `parley.endpoint`                         | `https://parley.api.mit.edu/v1` | OpenAI‑compatible API base URL                                           |
| `parley.accountId`                        | `""`                            | Account id (`acc_…`) for `Show Usage`                                    |
| `parley.defaultAgent`                     | `bedrock/claude-sonnet-4-6`     | Default model id                                                         |
| `parley.stream`                           | `true`                          | Stream replies token‑by‑token                                            |
| `parley.thinking`                         | `off`                           | Extended thinking: `off`/`adaptive`/`low`/`medium`/`high`                |
| `parley.defaultMode`                      | `chat`                          | `chat`/`ask`/`edit`/`plan`/`auto`/`full`                                 |
| `parley.autoContinue`                     | `true`                          | Keep working until done in agent modes                                   |
| `parley.maxToolRounds`                    | `50`                            | Max tool‑call rounds per turn before it auto‑continues (keeps its tools) |
| `parley.maxAutoContinue`                  | `25`                            | Max auto‑continue steps (`0` disables)                                   |
| `parley.tokenLimit`                       | `0`                             | Per‑conversation token budget (`0` = unlimited)                          |
| `parley.autoCompactPercent`               | `80`                            | Auto‑compact at this % of the context window (`0` off)                   |
| `parley.autoCompactTokens`                | `0`                             | Absolute auto‑compact threshold (`0` off)                                |
| `parley.autoSaveConversations`            | `true`                          | Auto‑save each conversation to disk                                      |
| `parley.conversationsDir`                 | `""`                            | Folder for saved conversations (empty = global storage)                  |
| `parley.mcpServers`                       | `{}`                            | MCP servers `{ name: { command, args?, env? } }`                         |
| `parley.webSearch.provider`               | `duckduckgo`                    | `off`/`duckduckgo`/`google`/`tavily`                                     |
| `parley.webSearch.apiKey`                 | `""`                            | Key for Google/Tavily                                                    |
| `parley.webSearch.googleCx`               | `""`                            | Google Programmable Search engine id                                     |
| `parley.allowedFetchHosts`                | `[]`                            | Egress allowlist for `fetch_url`/`browser_navigate` (empty = any public host) |
| `parley.codebaseSearch.enabled`           | `true`                          | Enable `@codebase`                                                       |
| `parley.codebaseSearch.provider`          | `lexical`                       | `lexical` or `local` (on‑device semantic)                                |
| `parley.codebaseSearch.maxFiles`          | `4`                             | Files `@codebase` includes                                               |
| `parley.commandTimeoutSeconds`            | `300`                           | Timeout for agent shell commands                                         |
| `parley.verifyCommand`                    | `""`                            | Command `/verify` runs (empty = auto-detect)                             |
| `parley.testCommand`                      | `""`                            | Command for `run_tests` / `Fix Failing Tests` (empty = auto-detect)      |
| `parley.coverageCommand`                  | `""`                            | Command for `Generate Tests for Uncovered Code` (empty = auto-derive)    |
| `parley.statusBar.enabled`                | `true`                          | Status-bar ticker: sidebar tokens/cost + working spinner                 |
| `parley.terminalFixHint.enabled`          | `true`                          | Transient "Fix with Parley" hint when a terminal command fails           |
| `parley.voice.model`                      | `""`                            | Model for 🎤 transcription (empty = current; needs audio support)        |
| `parley.voice.autoRead`                   | `false`                         | Read every reply aloud (OS text-to-speech)                               |
| `parley.sound.chimeOnDone`                | `false`                         | Chime when a turn finishes while unfocused                               |
| `parley.computerUse.enabled`              | `false`                         | ⚠ Allow `/computer` to control the mouse & keyboard                      |
| `parley.computerUse.backend`              | `auto`                          | `auto` / `nutjs` / `powershell`                                          |
| `parley.computerUse.maxSteps`             | `25`                            | Max actions per `/computer` run                                          |
| `parley.computerUse.confirmEachAction`    | `false`                         | Confirm before every computer-use action                                 |
| `parley.inlineCompletion.enabled`         | `true`                          | Ghost‑text completions                                                   |
| `parley.inlineCompletion.model`           | `openai/gpt-5-nano`             | Completion model                                                         |
| `parley.inlineCompletion.debounceMs`      | `350`                           | Idle delay before a completion                                           |
| `parley.inlineCompletion.disabledLanguages` | `[]`                          | Language IDs where completion is off (e.g. `["markdown"]`)               |
| `parley.inlineCompletion.maxPrefixChars`  | `2000`                          | Chars of code before the cursor sent as context                         |
| `parley.inlineCompletion.maxSuffixChars`  | `1000`                          | Chars of code after the cursor sent as context                          |
| `parley.nextEdit.autoTrigger`             | `false`                         | Auto-predict the next edit after edits settle (Cursor-Tab style)         |
| `parley.video.maxFrames`                  | `12`                            | Max sampled video frames                                                 |
| `parley.video.frameWidth`                 | `768`                           | Downscale width for frames                                               |
| `parley.video.maxAudioSeconds`            | `600`                           | Max seconds of extracted audio                                           |
| `parley.video.ffmpegPath`                 | `""`                            | Path to `ffmpeg` (else PATH)                                             |
| `parley.context.maxCharacters`            | `12000`                         | Max context characters per request                                       |
| `parley.context.includeDiagnostics`       | `true`                          | Include diagnostics on request                                           |
| `parley.context.respectGitignore`         | `true`                          | Respect `.gitignore` for context                                         |
| `parley.confirmBeforeSendingLargeContext` | `true`                          | Preview/confirm large context                                            |
| `parley.secretScanning`                   | `redact`                        | Scan outbound context + tool results for secrets: `redact`/`warn`/`off`  |
| `parley.telemetry.enabled`                | `false`                         | No telemetry is emitted                                                  |
| `parley.logLevel`                         | `info`                          | `error`/`warn`/`info`/`debug`                                            |

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
  explicit markers), so the extension doesn't send them. Bedrock still applies _automatic_
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
`markdown-it` and `highlight.js`), so the VSIX stays small (~310 KB) and
platform‑agnostic — no `node_modules` is shipped. The optional runtime dependencies
(`@xenova/transformers` for the local semantic `@codebase` index, `playwright` for the
browser tools, and `@nut-tree-fork/nut-js` for cross-platform computer use) are **not**
in the package; each is installed on demand into global storage the first time you use
that feature. Press **F5** for an Extension Development Host (run `npm run watch`
alongside to keep `dist/` fresh).

Tests are `node --test` over `out/test/*.test.js`: pure-logic unit tests plus a
**jsdom webview harness** (`test/webviewHarness.test.ts`) that loads the real bundled
`dist/webview.js` into the actual `buildChatHtml()` DOM and drives interactions
(menus, chips, steer bubbles, snippet flow, diff-review shortcuts) with
`acquireVsCodeApi` stubbed.

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
- `src/context/` — context collection, ignore rules, sensitive‑file filtering, project memory.
- `src/computer/` — computer use: the JSON action protocol + parser, the swappable
  control backends (PowerShell / nut.js), and the dispatcher.
- `src/parley/untrusted.ts` — prompt-injection framing for untrusted tool/web/screen content.
- `src/debug/debug.ts` — gated tracing.

Authentication material uses `SecretStorage`; credentials and request headers are
never logged.
