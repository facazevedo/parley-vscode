# Parley for VS Code — Feature Guide

A complete catalog of what Parley does. The [README](README.md) is the getting-started
guide and quick reference (with the full [command](README.md#command-reference) and
[settings](README.md#settings-reference) tables); this document is the exhaustive tour.

Parley is a VS Code extension over MIT's OpenAI-compatible **Parley** gateway: a streaming
chat sidebar, an agent that reads and edits your workspace, deep multimodal context, and
every change diff-reviewed before it touches your files.

---

## Contents

- [Chat & conversations](#chat--conversations)
- [Models, reasoning & speed](#models-reasoning--speed)
- [Agent modes](#agent-modes)
- [The agent & its tools](#the-agent--its-tools)
- [Context: @-mentions & more](#context--mentions--more)
- [Codebase search](#codebase-search)
- [Editing & review](#editing--review)
- [Inline completion & next-edit prediction](#inline-completion--next-edit-prediction)
- [Editor code actions](#editor-code-actions)
- [Testing & quality](#testing--quality)
- [Git & GitHub](#git--github)
- [Diagrams](#diagrams)
- [Multimodal: images, audio, video, voice](#multimodal-images-audio-video-voice)
- [Design canvas (artifacts)](#design-canvas-artifacts)
- [Web: search, browser, fetch](#web-search-browser-fetch)
- [MCP servers](#mcp-servers)
- [Computer use](#computer-use)
- [Project memory, rules, skills & custom commands](#project-memory-rules-skills--custom-commands)
- [Cost, context & usage](#cost-context--usage)
- [Maintenance commands](#maintenance-commands)
- [Safety & privacy](#safety--privacy)
- [Keyboard shortcuts](#keyboard-shortcuts)

---

## Chat & conversations

- **Streaming chat sidebar** with a Claude-Code-style **agent timeline** — a vertical rail
  with state-colored dots (message / tool-done / error / running), a "Thought for _N_s"
  reasoning label, and a "Switched to _model_" divider when the model changes mid-turn.
- **Tool-step inspector** — click any tool step (⏺) to expand the exact arguments and the
  full raw result.
- **Conversation switcher** — click the title to search past conversations. Search is
  **full-text across transcripts** (not just titles), with matching snippets, scoped to
  this repo or all repos.
- **Parallel conversations** — open independent chats as editor tabs or floating windows
  (`New Conversation in Tab` / `in New Window`).
- **Full transcripts on disk** — every conversation is saved as JSONL under `.parley/`, and
  can be **exported** to Markdown / plain text / JSON with a metadata header.
- **Compaction** — summarize a long conversation (keep-recent or everything) to free
  context; the saved transcript keeps the full record.
- **Regenerate** the last response; **rewind** the conversation (and optionally the files)
  to any earlier message.
- Image attachments show as **clickable thumbnails**; click to open the full **image viewer**
  (zoom / pan / download / next-prev / thumbnails).

## Models, reasoning & speed

- **Any model on the gateway** — Claude, GPT, Gemini, Llama and more, switchable per
  conversation (`/model`).
- **`/compare`** runs one prompt on a **second model side by side**; adopt either reply.
- **Extended thinking** — `off` / `adaptive` / `low` / `medium` / `high` (effective on
  models that support it, e.g. Claude & Gemini); the "Thought for _N_s" label shows when
  reasoning ran.
- Per-conversation **token budget** (`Set Token Limit`) and **auto-compaction** thresholds.

## Agent modes

Six modes, chosen from the composer's mode picker:

| Mode | What it does |
|---|---|
| **Chat** | Answer only — no agent, no file access. |
| **Ask before edits** | Agent proposes edits; you approve each on an in-chat card. Reads, search, web, and screen tools still run automatically. |
| **Edit automatically** | Agent applies edits without asking (checkpointed / revertible). |
| **Plan** | Agent explores **read-only** and presents a plan that opens as an editable doc; click **Build** to implement your edited version. |
| **Auto** | Agent decides and applies edits automatically. |
| **Full access** ⚠ | Auto-applies edits **and runs shell commands without asking** (only in a trusted workspace). |

Shell commands require confirmation in every mode except Full access (and even Full access
asks in an untrusted workspace). **Auto-continue** keeps the agent working until the task is
done, bounded by configurable tool-round and step limits.

## The agent & its tools

In an agent mode the model can call these tools (results are secret-scanned before it sees
them; untrusted content is fenced with an injection-defense boundary):

- **Read / explore** — `read_file` (with line ranges), `list_directory`, `find_files`
  (glob), `search_text` (substring), `grep` (regex, ripgrep), plus language-server symbol
  lookup.
- **Edit** — `write_file`, `edit_file` (precise snippet replace), `multi_edit` (several
  atomic edits to one file). Every edit is diff-reviewed and checkpointed.
- **Execute** — `run_command` (approved per command, with a per-workspace allowlist),
  `run_tests` (auto-detected test runner, PASS/FAIL + output).
- **Web** — `web_search`, `fetch_url`, and a headless-browser suite (`browser_navigate`,
  `browser_read`, `browser_click`, `browser_type`, `browser_console`, `browser_screenshot`).
- **Media** — `generate_image` (gpt-image-1), `capture_screen`.
- **Meta** — `remember` (project memory), `update_plan`, `load_skill`.

**Parallel subagents** can be fanned out for scoped read-only investigations. Text-protocol
models (that lack native tool-calling) are supported via a text-tool-call adapter that parses
`<tool_call>` tags, runs them, and feeds results back.

## Context: @-mentions & more

Type **`@`** in the composer for a fuzzy autocomplete. Mentions:

| Mention | Effect |
|---|---|
| `@path/to/file` | Attach a file (optionally `#12-40` for a line range) |
| `@path/to/folder/` | Attach a folder listing |
| `@sym:<name>` | Find a function/class/symbol via the language server |
| `@codebase` | Retrieve the most relevant files for your question |
| `@problems` | Current errors & warnings from the Problems panel |
| `@git` | Uncommitted diff vs HEAD |
| `@blame` | `git blame` for the selection/file — "why does this exist" |
| `@issue <n>` | A GitHub issue (title/body/comments) via `gh` |
| `@pr [n]` | A GitHub PR (current branch, or a number) via `gh` |
| `@terminal` | Recent integrated-terminal commands + output |
| `@browser <url>` | Open a URL in a real browser and attach rendered text + console errors |
| `@https://…` | Fetch a page and attach its text |

Also: **`Alt+K`** drops an `@file#start-end` mention of the current selection into chat;
right-click a file → **Add File to Chat Context**.

## Codebase search

`@codebase` pulls the most relevant workspace files into context. Controlled by
`parley.codebaseSearch.provider`:

- **`lexical`** (default) — keyword ranking; keyless, private, instant.
- **`local`** — a true **on-device semantic index** (MiniLM via transformers.js/ONNX);
  keyless and fully private. Build with **`Rebuild Codebase Index`** (installs the runtime
  once). With this provider, `@codebase` attaches the **matched chunk's region** (labeled
  `@codebase path:from-to`), not just the file head. Falls back to lexical if unavailable.

## Editing & review

- **Diff-reviewed edits** — agent edits appear as inline **Apply / Choose hunks… / Reject**
  cards with the full diff opened beside; per-hunk accept/reject is supported.
- **Checkpoints** — every applied edit is checkpointed; **Revert Last Edit** / **Revert All
  Edits**, per-message **rewind**, and **File Edit History** (every Parley edit to a file,
  each openable as a before/after diff).
- **Multi-file review** — the end-of-turn "N files changed" card's **Review** button opens
  every changed file in VS Code's native multi-file diff editor.
- **Format-preserving** — a CRLF file stays CRLF; BOM/encoding are preserved.

## Inline completion & next-edit prediction

- **Ghost-text completion** — as you type, Parley suggests a fill-in-the-middle completion
  at the cursor. It's **diff-aware** (fed your recent edits, Cursor-Tab style), has an LRU
  cache for instant cursor-bounce/re-type, and trims a duplicated trailing closer. Toggle
  with **`Toggle Inline Completion`**; configure model, debounce, prefix/suffix window, and
  `disabledLanguages`.
- **Predict Next Edit** (`Ctrl+Alt+N`) — predicts your likely next change elsewhere in the
  file, marks it with a decoration + status-bar hint; **Tab** jumps there and shows a native
  ghost, a second **Tab** accepts, **Escape** dismisses. Optional **`nextEdit.autoTrigger`**
  for hands-free prediction. Modal-diff variant: **Predict Next Edit (Diff Review)**.

## Editor code actions

Right-click **Parley** submenu and the **`Ctrl+.`** lightbulb (on a selection):

- **Ask About Selection**, **Explain** (selection or file), **Refactor Selection**,
  **Generate Tests**, **Add Docs**, **Diagram This**, **Fix Diagnostics**.
- **Fix with Parley** — any diagnostic squiggle offers a Quick Fix that sends the specific
  problem + code to chat.
- **Hover to explain** — hovering a symbol shows an **"Explain with Parley"** link (no model
  call until clicked); **Explain Symbol** explains the symbol under the cursor.
- **CodeLens** (opt-in, `parley.codeLens.enabled`) — **Explain · Test · Doc** actions above
  each function/method/class.
- **Port / Translate Code** — translate the selection/file to another language into a new doc.
- **Explain Stack Trace** — paste a trace (selection/clipboard/input); Parley opens the top
  workspace frame and explains the failure + fix.

## Testing & quality

- **`run_tests` tool** — runs the auto-detected suite (npm / pytest / cargo / go / maven /
  gradle, or `parley.testCommand`) and reports PASS/FAIL + output.
- **Fix Failing Tests** — runs tests, then has the agent fix and re-run until green.
- **`/verify`** — in-chat fix-until-green loop.
- **Generate Tests for Uncovered Code** — runs coverage and writes tests for the current
  file's uncovered lines.
- **Review Current Branch** / **Review Staged Changes** — severity-grouped code review of
  branch or staged changes.
- **Run Diagnostics** — probes the live gateway API and reports what works.

## Git & GitHub

- **Generate Commit Message** — Conventional Commits message from the staged diff, dropped
  into the Source Control box.
- **Generate PR Description** — paste-ready PR title/summary/changes/test-plan from the
  branch diff (opens in a doc + copied to clipboard).
- **Create Pull Request** — generate the description, confirm, push the branch, and open the
  PR via the GitHub CLI (`gh`), returning the URL.
- **Generate Release Notes** — grouped release notes / CHANGELOG entries (+ a suggested
  version bump) from the commits since the last tag.
- **Split Into Logical Commits** — propose grouping the uncommitted diff into clean,
  self-contained commits with messages (advisory).
- **Review Current Branch** bundles a review + PR description.
- Context mentions **`@git`**, **`@blame`**, **`@issue`**, **`@pr`**.

## Diagrams

- **Diagram This** — pick Structure (flowchart), Class diagram, Call/sequence flow, or
  Dependencies, and Parley renders a **Mermaid** diagram of the current file/selection
  **inline in the chat**.

## Multimodal: images, audio, video, voice

- **Attach** images, PDFs, audio, and **video** (frames sampled via ffmpeg; audio extracted).
- **Screen capture** — 📷 screenshot (auto on one monitor; per-monitor picker with a
  countdown on multiple) and 🎥 screen recording (sampled frames), with real-pixel
  coordinates so the model can answer position questions.
- **Voice** — 🎤 voice input (transcribed), 🔊 read-aloud, and hands-free voice mode.
- **Image generation** — `Generate Image` (gpt-image-1); the agent's `generate_image` tool
  drops images inline. Generated/attached images open in the full image viewer.

## Design canvas (artifacts)

- **Parley Design** — a live preview panel (opens in the editor area) that renders the
  model's **HTML / SVG / React (JSX + Tailwind)** artifacts in a sandboxed iframe, with a
  **version history**, open-in-editor, and export.
- **Its own design chat** — iterate the artifact with messages kept separate from the main
  chat; each reply becomes a new version. Auto-opens when a design is ready.

## Web: search, browser, fetch

- **`web_search`** — DuckDuckGo (no key), Google Programmable Search, or Tavily.
- **`fetch_url`** — fetch a page's text (https only), with SSRF protection.
- **Headless browser** — drive a real Chromium (navigate/read/click/type/console/screenshot).
- **Egress allowlist** — `parley.allowedFetchHosts` optionally restricts `fetch_url` /
  `browser_navigate` to specific hosts.

## MCP servers

- Connect **stdio**, **streamable-HTTP**, and **legacy-SSE** Model Context Protocol servers
  via `parley.mcpServers`. Tools are exposed to the agent as `mcp__<server>__<tool>`.
- **MCP Server Status** — see connected servers, their tools, and any startup errors.
- **Reconnect MCP Servers** — restart after a config change.

## Computer use ⚠

- With explicit opt-in, **`/computer`** drives your real mouse & keyboard for a desktop task
  (built-in Windows backend or optional cross-platform nut.js), with a corner-slam kill
  switch, a step limit, and per-action confirmation. Off by default.

## Project memory, rules, skills & custom commands

- **Project memory** — the agent saves durable, non-obvious facts to `.parley/memory.md`
  (via the `remember` tool); every future conversation starts with them injected. Review
  with **Open Project Memory**.
- **Project rules** — `.parleyrules` / `AGENTS.md` / `.cursorrules` (and per-rule files under
  `.parley/rules` / `.cursor/rules`). **Init Project Rules** analyzes the repo → a tailored
  `AGENTS.md`.
- **Skills** — reusable capabilities the agent loads on demand (`load_skill`); **Create Skill**.
- **Custom slash commands** — drop `name.md` in `.parley/commands/` (or `.claude/commands/`,
  or the global variants) → `/name`, with `$ARGS` and `$SELECTION` substitution.
- **Output styles** — Default / Concise / Explanatory / Learning + custom (**Select Output
  Style**).
- **Hooks** — `parley.hooks` runs your shell commands at lifecycle points (PreToolUse /
  PostToolUse / UserPromptSubmit / Stop), Claude-Code-compatible; exit 2 intervenes.

## Cost, context & usage

- Live **cost** (`~$`) and **context-window** gauges in the header, plus a status-bar ticker.
- **`/context`** (Show Context Breakdown) — per-component estimate of what fills the window.
- **Show Usage** — this month's real billed spend from the gateway; **Usage History** — an
  estimated by-day chart + by-model table from saved transcripts.

## Maintenance commands

- **Triage TODOs** — scan the workspace for TODO/FIXME/HACK/XXX markers, pick one, tackle it.
- **Audit Dependencies** — run npm/pnpm/yarn audit and get a plain-English remediation plan.

## Safety & privacy

- **API key** stored in VS Code SecretStorage — only ever sent as the `Authorization`
  header; never logged, transcribed, or exported.
- **Sensitive-file filtering** — `.env`, keys/PEM/PFX, `.ssh`/`.aws`/`.gnupg`, credentials
  files, etc. are never read by the agent.
- **Outbound secret redaction** — high-signal credential formats are redacted from tool
  output before the model sees them.
- **Prompt-injection defenses** — web/file/terminal/MCP content is fenced as untrusted.
- **Workspace Trust** — settings that execute code, redirect traffic, or change where data is
  written are ignored from an untrusted workspace (they fall back to your user settings). The
  test command and Full-access auto-run are gated on trust.
- **SSRF protection** — `fetch_url` refuses private/loopback/link-local addresses and vets
  the connection address at connect time (closing DNS-rebinding), re-vetting every redirect.
- **Per-segment command allowlist** — approved commands are remembered per workspace, honored
  only when trusted.
- No telemetry.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+K` / `Cmd+Alt+K` | Inline edit (edit selection) |
| `Ctrl+Alt+N` / `Cmd+Alt+N` | Predict Next Edit |
| `Alt+K` | Insert an `@`-mention of the selection into chat |
| `Tab` | (when a next-edit is predicted) jump to / accept it |
| `Esc` | (when a next-edit is predicted) dismiss it |
| `Ctrl+.` | Parley code actions on a selection (lightbulb) |

See the [README command reference](README.md#command-reference) for the full command list and
the [settings reference](README.md#settings-reference) for every setting.
