# Changelog

## 0.43.0

### Added — the agent survives transient failures (auto-retry)
- Chat/agent requests now **retry automatically** on rate limits (429), upstream/server errors (5xx), network blips, and mid-stream error events — up to 3 retries with exponential backoff + jitter, honoring the server's `Retry-After`. A status-line notice shows what's happening (e.g. `Rate-limited — retrying in 2s (attempt 2/4)…`). Retries only happen while **nothing has streamed to the chat yet**, so output is never duplicated. Previously a single 429/502 killed the whole agent task mid-flight.

### Added — syntax highlighting + real Markdown in the chat
- Chat messages are now rendered with **markdown-it + highlight.js** (bundled into `dist/webview.js`, ~250 KB minified): fenced code blocks get **theme-aware syntax highlighting** (colors follow your VS Code theme via the terminal ANSI palette), plus proper nested lists, links (auto-linkified), tables, and blockquotes — replacing the hand-rolled parser. Raw HTML from the model is never rendered.

### Added — scroll lock while streaming
- The chat no longer yanks you to the bottom on every token. Scrolling up **pauses autoscroll** so you can read earlier messages while the agent works; a floating **↓ jump-to-latest** pill appears and one click (or sending a message) re-pins the view.

### Fixed — thinking-only steps no longer stop the agent
- With extended thinking enabled, a step where the model only reasoned (no text, no tool calls) was treated as "empty response" and **halted the whole task**. Reasoning now counts as progress, thinking-only steps keep their 💭 panel after the turn re-renders, and a truly empty step gets **one automatic "continue" nudge** before the loop gives up.

### Fixed — tool output is truncated honestly (head + tail)
- Long tool results were silently cut at 8,000 chars from the **top** — for command output that dropped the actual error at the end, and the model reasoned over the amputated text as if complete. Results are now clamped keeping **head + tail** around an explicit `[… N of M characters omitted from the middle …]` marker, with bigger budgets where they matter (`run_command` 16k, `read_file` 24k so its own pagination footer survives, `fetch_url`/`search_text` 12–13k). The same head+tail treatment applies to shell output capture.

### Fixed
- **Privacy: local `.parley/` transcripts no longer ship inside the VSIX.** `vsce` was packaging this workspace's own `.parley/conversations/*.jsonl` conversation logs into the extension archive (the in-repo `.gitignore` kept them out of git, but not out of the package). `.parley/**` is now excluded in `.vscodeignore`. If you packaged earlier VSIXes from a workspace where you had used Parley, rebuild them.
- **Apply/Dismiss race:** clicking either button on a proposed-change card now disables **both** immediately, and an Apply for a change the extension no longer tracks (e.g. after a reload) resolves the card instead of leaving a dead button.
- **Stop during connection:** pressing Stop while the request was still connecting no longer surfaces a spurious "Could not reach Parley" error.
- **MCP:** late/unmatched JSON-RPC responses (typically after the 30s timeout) are now logged instead of dropped silently, so slow servers are diagnosable.

### Internal
- New pure modules `src/parley/retry.ts` (backoff policy, Retry-After parsing, abort-aware sleep) and `src/parley/clampText.ts` (head+tail clamping), each fully unit-tested (82 tests total). The webview script is now a second esbuild bundle (`media/chat.js` → `dist/webview.js`); `media/chat.js` no longer ships in the VSIX. Verified during review: `write_file` and `edit_file` both checkpoint through the same `applyProposedEdit` path (no asymmetry).

## 0.42.0

### Fixed — `debug/` folder no longer created unless you use Parley
- The extension activates on startup for every window, and debug logging eagerly wrote a line on init — creating a `debug/` folder in repos where Parley was never used. The debug **file** (and its folder) is now created **only on your first chat/agent turn**; until then, debug traces stream to the **"Parley Debug"** output channel only. (Existing stray `debug/` folders can be deleted safely.)

## 0.41.0

### Changed — agents always end with a bold **SUMMARY**
- When an agent task finishes, the final message now always ends with a **SUMMARY** section (bold heading + Markdown bullet points) covering what was done, files changed, commands run / whether checks passed, and any known limitations — followed by `<DONE>`. Applies to all agent modes (ask/edit/auto/full).

## 0.40.0

### Added — complete conversation transcripts saved to `.parley`
- Parley now records a **full, ordered transcript of everything shown on screen** — your messages, the model's replies, tool activity (`⏺`/`⎿`), file-edit diffs, plans, and system notes — not just the message text.
- The canonical copy is written to a **`.parley/` folder** in your workspace as it happens:
  - `conversations/<id>.jsonl` — append-as-it-happens event log (durable; never depends on in-memory state), plus a human-readable `conversations/<id>.md` per turn.
  - `index.json` (past-conversation list) and `state.json` (Parley params: model/mode/thinking/speed).
  - A `.parley/.gitignore` (ignore-all) is created once so logs aren't committed by accident — delete it to commit them. The location can be overridden with `parley.conversationsDir`.
- **Past conversations** now reload the **full transcript** from disk (diffs, tool calls and all), not just messages — and continue appending to the same file.
- **Export** now **completes and saves the canonical transcript first, then writes a copy** in your chosen format (Markdown / plain text / JSON) to wherever you pick. The exported file contains the entire transcript.

### Fixed
- Inline **Apply** cards (Chat mode) no longer vanish when the turn ends — the chat now renders from the persisted transcript, so cards, diffs, and tool activity survive re-renders and window reloads.

### Changed
- The **context-usage ring is always visible** in the header (shows `–` when the model's context-window size is unknown).

## 0.39.0

### Fixed — agent no longer "loses its tools" and gives up mid-task
- **Root cause:** when an agent turn hit the tool-round limit, the loop made one final model call **with the tools removed** to force a text answer. Mid-task, the model correctly observed it had no tools and replied *"the tool interface became unavailable in this run"* and stopped — then auto-continue restarted, it worked briefly, hit the wall again, and repeated. This is what made it "stop many times before finishing."
- Now, when the round limit is reached, the agent **keeps its tools and auto-continues** into the next step instead of being handed a tool-less request. The misleading "tools unavailable / can't continue in this run" message is gone.
- **`parley.maxToolRounds` default raised 25 → 50** (max 400), so long multi-file tasks cross fewer turn boundaries. Tool outputs retained per turn raised 8 → 12 to cut redundant re-reads.

### Changed — agent installs its own dependencies
- The agent system prompt now tells the agent to **install missing dependencies itself** via `run_command` (`pip install`, `npm install`, …) rather than reporting "pytest/numpy is not installed" as a blocker. It also clarifies that **"install those tools" means install the missing packages/CLIs** (not its function-calling tools, which it previously refused thinking it couldn't "enable tools"). In **Full Access** mode it's told commands run without asking, so it installs/builds/tests freely.
- The prompt also explicitly states the tools are **always available** (never claim otherwise) and that **trimmed older tool outputs are normal** (re-read if needed) — and asks the model not to paste raw reasoning notes-to-self into replies.

## 0.38.0

### Changed — tiny, platform-agnostic VSIX (esbuild bundle)
- The extension is now **bundled with esbuild** into a single `dist/extension.js`. The VSIX dropped from **~80 MB / 4264 files to ~105 KB / 14 files** and is no longer tied to the OS it was packaged on.
- The optional local‑semantic `@codebase` runtime (`@xenova/transformers` + native `onnxruntime`/`sharp`) is **no longer shipped**. The first time you build the index (`Parley: Rebuild Codebase Index`) it's installed on demand into global storage — fetching the binaries that match *your* machine — so the platform‑specific weight only lands if you opt in. Requires `npm` on PATH for that one‑time install; falls back to lexical if unavailable.

### Added — Apply button in Chat mode
- In plain **Chat** mode, complete‑file changes the model proposes now render as an **inline diff card with an Apply / Create file and Dismiss button**, replacing the old modal pop‑ups. Clicking **Apply** writes the file (checkpointed/revertible via `Parley: Revert Last Edit`). Agent modes still apply through tools. This is the Cursor‑style "suggest in chat, apply on click" flow.

### Investigated — prompt caching (not available via Parley)
- Verified live that Anthropic `cache_control` breakpoints are **accepted but not propagated** to Bedrock by the gateway (no cache writes/reads from explicit markers, on system or user messages) — the same situation as OpenAI `reasoning_effort`. The extension therefore does **not** send them. Bedrock still applies *automatic* prefix caching transparently. Documented in the README's gateway‑limits section.

### Internal
- New unit tests: the proposed‑change parser (`fileBlocks`) and a **bundle‑integrity** test that loads the built `dist/extension.js` and asserts it exports `activate`/`deactivate` (59 tests total). Build scripts: `compile` now typechecks (tsc) and bundles (esbuild); `package` builds a minified production bundle via `vscode:prepublish`; `watch` runs esbuild in watch mode for F5.

## 0.37.0

### Changed — complete README guide
- Rewrote `README.md` into a full user manual covering **every** feature and nuance: requirements/install/quick‑start, the chat UI tour, all six modes + the agent loop (activity `⏺`/`⎿`, live task checklist, inline diff cards), the full tool list (incl. `web_search`, `update_plan`, MCP tools), the honest **per‑provider reasoning & speed matrix** (Claude/Gemini thinking works; OpenAI `reasoning_effort` is a no‑op via Parley; Fast = `service_tier`), all `@`‑mentions, **`@codebase`** lexical vs optional on‑device semantic (MiniLM) with setup/fallback, slash + custom commands, every attachment type (image/PDF/audio/video‑via‑ffmpeg), web search, MCP servers, inline completion/edit, cost/context/usage/auto‑compaction, conversations (new/auto‑save/export md‑txt‑json/compact), git/image/editor commands, project rules, diagnostics/debug log, safety & privacy, a **full command + settings reference**, models, gateway limits, troubleshooting, and dev/packaging/architecture.
- Corrected stale notes (semantic `@codebase` is now offered; activity markers are `⏺`/`⎿`).

## 0.36.0

### Added — optional local semantic `@codebase` index (off by default)
- `@codebase` can now use a **true semantic index** powered by an **on-device MiniLM embedding model** (transformers.js / ONNX) — keyless and private, no data leaves your machine. Enable with `parley.codebaseSearch.provider: "local"` and run **`Parley: Rebuild Codebase Index`** (downloads the model ~25 MB once, then works offline). It ranks files by meaning, not just keywords.
- **Default stays `lexical`** (instant, keyless, zero added weight). The local provider is fully opt-in, lazy-loaded, and **falls back to lexical** if the index isn't built or the model can't load — so it never breaks chat.
- Note: enabling the bundle ships the embedding runtime in the VSIX (large, and platform-specific due to a native sub-dependency), which is why it's opt-in.

## 0.35.0

### Added — web search + `@codebase` retrieval (both keyless)
- **`web_search` tool** for the agent. **DuckDuckGo** is the default and needs **no API key**; **Google** (Programmable Search — set `parley.webSearch.apiKey` + `parley.webSearch.googleCx`) and **Tavily** (`parley.webSearch.apiKey`) are opt-in keyed providers. Set `parley.webSearch.provider` to `off` to disable. The agent searches, then `fetch_url`s the best results.
- **`@codebase`** mention — lexically retrieves the most relevant workspace files for your question (ripgrep-style term ranking + a filename-match boost) and adds them as context. Keyless, private, no embeddings. **On by default**, toggle with `parley.codebaseSearch.enabled`; tune count with `parley.codebaseSearch.maxFiles`.

_(A true semantic index via a bundled local embedding model is the planned next step — optional, off by default.)_

## 0.34.0

### Added — visible command execution
- Agent shell commands (`run_command`) now mirror the command and its **full output** to a dedicated **"Parley Agent"** output channel as they run (Claude-Code/Cursor-style transparency), while still capturing the output for the model and showing the `⏺`/`⎿` summary in chat.

### Note
- The Cursor-style **"Apply" button** on arbitrary chat code blocks is intentionally **not** added: it requires a dedicated apply/merge model that Parley doesn't provide, and a naive "replace file with snippet" would be destructive. Full-file edits already route through the diff-review/checkpoint flow via `File:` blocks and the `write_file`/`edit_file` tools.

This completes the Claude-Code / Codex / Cursor parity pass (custom commands, task checklist, richer @-mentions, commit messages, MCP, visible commands).

## 0.33.0

### Added — MCP (Model Context Protocol) servers
- Configure MCP servers in **`parley.mcpServers`** (stdio transport). Parley spawns each one, runs the JSON-RPC `initialize` handshake, lists its tools, and exposes them to the agent as **`mcp__<server>__<tool>`** — so the model can use external/MCP tools in the agent loop alongside the built-ins. New module `src/mcp/` with a defensive client (a server that fails to start is logged and skipped — chat keeps working) and unit-tested name mapping.
- **`Parley: Reconnect MCP Servers`** restarts them and reports status; servers also restart automatically when the config changes. MCP tools are available in every agent mode except read-only Plan mode.

## 0.32.0

### Added — Claude-Code / Codex / Cursor parity (batch 1)
- **Live task checklist.** In agent modes the model can call an `update_plan` tool; the steps render as a checklist in the chat (☐ / ▸ in-progress / ☑ done), updated in place so long runs are legible.
- **Custom slash commands.** Drop a `name.md` file in `.parley/commands/` (or `.claude/commands/`) and it becomes `/name` — the file body is the prompt, with `$ARGS` replaced by anything typed after the command. Custom commands appear in the `/` menu.
- **Richer `@`-mentions.** Besides `@file`: **`@<folder>`** attaches a folder listing, **`@git`** attaches the uncommitted diff (vs HEAD), and **`@https://…`** fetches a page's text.
- **`Parley: Generate Commit Message`.** Summarizes the staged diff (or working tree) into a Conventional Commits message and drops it into the Source Control input box.

_Next: MCP server support, an "Apply" button on chat code blocks, and visible-terminal command execution._

## 0.31.0

### Changed — future-proof Claude 4.x model support
- Investigated Claude **Opus 4.8** on Parley: it is **not available** (not in `/v1/models`; every id form — `bedrock/claude-opus-4-8`, `anthropic/…`, dated Bedrock id, `global.anthropic.*` ARN, bare — returns HTTP 400, while `opus-4-7` works). There is no undocumented id that enables it; the gateway's catalog tops out at Opus 4.7.
- Broadened the context-window, pricing, and reasoning matching to any Claude 4.x (`opus`/`sonnet`/`haiku` `4-N`), so the moment MIT adds Opus 4.8 (or another 4.x) to Parley it's fully handled — context gauge, cost estimate, and extended thinking — instead of being treated as an unknown model. Models are already listed dynamically from `/v1/models`, so it will appear in the picker automatically.

## 0.30.0

### Changed
- The one-time "reasoning isn't applied for OpenAI on Parley" hint now also fires on the **first send** of a turn when a reasoning level + an OpenAI/GPT-5 model are both active — not only when you change the level or model. This catches the common case where the level was carried over from a previous session.

## 0.29.0

### Added
- **One-time hint** when you select a reasoning level while an **OpenAI / GPT-5** model is active: a short chat note explains that Parley accepts the level but doesn't apply it for OpenAI (verified live), and suggests switching to a **Claude** or **Gemini** model for real extended reasoning. Shown once per workspace; also fires if you switch to an OpenAI model while reasoning is on.

## 0.28.0

### Changed — honest reasoning/speed labeling (after live testing)
- Live-tested the reasoning and speed parameters against the Parley API and corrected the in-product labels to match reality:
  - **Claude** extended thinking — **works** (enabling it returns a real `thinking` field and ~2–3× the reasoning tokens).
  - **Gemini** reasoning — **has an effect** (token usage changes substantially with the level).
  - **OpenAI/GPT-5.x** `reasoning_effort` — **accepted but NOT applied by Parley** (reasoning depth/latency identical across minimal→high on gpt-5-nano and gpt-5.5). The level is still sent for forward-compatibility.
  - **Fast** (`service_tier: "priority"`) — **accepted** by the gateway (HTTP 200, no error); the actual ≈1.5× speed-up depends on your account's tier.
- The Mode popover now states this so the control isn't misleading.

## 0.27.0

### Added — Speed (OpenAI service tier), like Codex
- New **Speed** control in the composer's Mode popover: **Standard** (default) or **⚡ Fast**. For OpenAI/ChatGPT models, Fast sends `service_tier: "priority"` (OpenAI's ~1.5× faster, higher-usage tier — the same "Speed" toggle Codex exposes). It's gated to OpenAI models (ignored elsewhere) and persisted per conversation; the choice is included in conversation exports. (Parley's docs don't list this parameter, so if the gateway rejects it you'll now see the stream error — it's an OpenAI-only passthrough.)

## 0.26.0

### Fixed — agent could stall during build/verify
- `run_command`'s timeout was a hard **60s**, so real `npm install` / build / test commands were killed mid-run and the agent gave up ("couldn't complete the build-and-verify cycle"). It's now **300s by default and configurable** (`parley.commandTimeoutSeconds`), with a 16 MB output buffer and a clear "exceeded timeout — re-run or split / raise the setting" message instead of a silent failure.
- The agent prompt now tells the model it is **not limited to one interaction** (it's re-invoked to continue), to treat a timed-out command as recoverable, and to always end with a final summary — so it stops apologizing about "running out of time" and bailing.

### Changed — Claude-style activity output
- Tool activity now reads like Claude Code: an **`⏺ action`** line followed by a muted **`⎿ result`** line (e.g. `⏺ Reading App.tsx` / `⎿ Read 120 lines`, `⏺ Running: npm test` / `⎿ <first output line>`). Edits still render the inline diff card.

## 0.25.0

### Added — inline diff cards for edits
- When the agent edits or writes a file, the chat now shows a **Claude-Code-style diff card** inline: an `Edit <path>` header with `+added −removed` counts, then a unified diff with a line-number gutter and **red/green** removed/added lines (context lines kept, far-apart unchanged regions collapsed). Driven by a new pure, unit-tested `formatUnifiedDiff` in `src/diff/lineDiff.ts`. Large diffs are capped (with a "diff truncated" marker).

## 0.24.0

### Added
- **Copy button on your prompts.** Each message you send now shows a copy (two-squares) icon on hover in its top-right corner — click it to copy that prompt's text back to the clipboard (handy for re-running or tweaking a prompt).

## 0.23.0

### Fixed — extended thinking is now provider-aware (root cause of the GPT-5.5 failure)
- The debug log showed `openai/gpt-5.5` with Thinking = High returning **`400 Unknown parameter: 'thinking'`**, which aborted the stream (and, before v0.21, looked like an empty response). The Anthropic-style `thinking: { type, budget_tokens }` block isn't valid for OpenAI. Each provider's reasoning is now called its own way:
  - **OpenAI** and **Google/Gemini** → `reasoning_effort` (`low`/`medium`/`high`).
  - **Claude** (Bedrock/Anthropic) → the `thinking` block + `max_tokens` (Opus 4.7 forced to adaptive).
  - **Other models** (e.g. Llama) → nothing.
  So selecting a thinking level works on every model instead of breaking OpenAI/Gemini.
- Streamed error events are now also written to the debug log (full text), not just thrown.

## 0.22.0

### Added — debug tracing
- A globally-gated debug logger (single `DEBUG` switch in `src/debug/debug.ts`, **currently on**). When enabled, verbose traces of request shapes, response metadata (`x-parley-provider`/`x-parley-model`/`x-parley-request-id`, `finish_reason`, usage), tool rounds, and turn control-flow are written to the **"Parley Debug"** output channel and to `debug/parley-debug.log` in the open workspace.
- **`Parley: Open Debug Log`** command opens that file. Secrets (API key / `Authorization`) are never logged. See `debug/README.md`.

## 0.21.0

### Fixed — silent failures (the GPT-5.5 "empty response" case)
- **Streamed errors are no longer swallowed.** Parley reports mid-stream provider failures as an SSE `error` event before `[DONE]`; the client ignored it and finished with empty content (which then showed as "empty response and took no actions"). Both streaming paths now surface it as a real error (`Parley stream error: …`), so you see the actual cause.
- **Empty model turns are logged with `finish_reason` and completion-token count** to the Parley output channel, to distinguish "model genuinely returned nothing" from a content filter / length cut-off / parse issue.

### Changed — richer conversation export
- The **export** button (and `Parley: Export Conversation`) now writes a **metadata header** — model(s) used, mode, extended-thinking level, message count, session tokens, and estimated cost.
- New **Plain text (.txt)** export format, alongside Markdown and JSON. JSON export now includes the metadata object too. Auto-saved transcripts get the same header.

## 0.20.0

### Added — conversations on disk
- **Conversations auto-save to a folder.** Every conversation is written as a Markdown file after each turn (and on compaction / starting a new one), so your history is preserved outside VS Code. Location defaults to the extension's global-storage `conversations/` folder; override with `parley.conversationsDir`, or disable with `parley.autoSaveConversations`.
- **`Parley: New Conversation`** command (in addition to the ＋ button and `/clear`) — archives & saves the current chat, then starts a fresh one.
- **`Parley: Open Conversations Folder`** command — reveals the auto-save folder in your OS file manager.

### Engineering
- Each conversation has a stable id → filename, so re-saves overwrite the same file as it grows.

## 0.19.0

### Fixed — agent behavior (closer to Claude Code)
- **No more empty assistant turns.** When the model works through tools but doesn't narrate (common with GPT-5.x), Parley now persists a Claude-Code-style activity log into the message (`⏺ Read App.tsx`, `⏺ Write src/lib/…`, `⏺ Run: npm test`) instead of leaving a blank bubble — so the conversation and exports show what actually happened.
- **No-progress breaker for auto-continue.** A step that returns no text *and* takes no tool actions now stops immediately with a clear message, instead of looping up to the 25-step cap producing empty turns (the failure seen when building a large project with GPT-5.5).
- **Stronger narration instruction** in agent modes: the model is told to explain each action in plain text, never reply with only tool calls or an empty message, and summarize at the end before `<DONE>`.

## 0.18.0

### Added — context management (Claude Code / Codex parity)
- **Automatic compaction is now ON by default.** When a conversation reaches **80%** of the model's context window it's summarized automatically before the next turn (keeping the most recent messages verbatim), so long sessions don't overflow the context. Tune with `parley.autoCompactPercent` (set `0` to disable) or the absolute `parley.autoCompactTokens`.
- **Circular context gauge** in the header — a ring that fills as the conversation grows toward the model's context window (green → amber → red), with the percentage beside it.
- **Slash-command menu**: type `/` in the composer to get an autocomplete list (↑/↓, Enter). New commands: **`/cost`** (token/cost usage), **`/model`** (switch model), **`/init`** (create AGENTS.md), alongside `/clear`, `/compact`, `/json`, `/help`.
- **`/compact` options** — choose "summarize everything" or "summarize older, keep recent" (the ⊟ button and command prompt for this too).
- **`Parley: Init Project Rules`** command to scaffold an `AGENTS.md` rules file.

### Added — confidence & robustness
- **`Parley: Run Diagnostics`** — exercises the live gateway (models, chat, `count_tokens`, and whether **`thinking` is actually honored** on your models) and opens a pass/fail report. Image generation is not exercised (it costs money).
- **Extended-thinking capability gate** — warns when you select a thinking level for a model that doesn't support it (Llama, image models).
- **Uploaded files are cleaned up** after each request (`DELETE /v1/files/{id}`), so the account's 20-file limit isn't exhausted.

### Added — rendering
- Chat Markdown now renders **GitHub-style tables** and **blockquotes**.

### Engineering
- New pure `src/parley/models.ts` (context windows + thinking support) with tests; 38 unit tests. Marketplace publishing remains wired in the release workflow (gated on `VSCE_PAT`/`OVSX_PAT`).

## 0.17.0

### Added
- **Video attachments (via ffmpeg).** Parley has no native video type, so attaching a video (`.mp4/.mov/.mkv/.webm/.avi/…` through 📎) offers to **sample frames** (sent as images to a vision model), **extract the audio track** (sent as an `input_audio` clip on OpenAI/Google), or **both**. Frames are sampled evenly across the clip and downscaled to bound payload size. Requires `ffmpeg`/`ffprobe` on PATH (or `parley.video.ffmpegPath`); if it's missing, Parley says so and links to the download page — no crash. New settings: `parley.video.maxFrames` (12), `parley.video.frameWidth` (768), `parley.video.maxAudioSeconds` (600), `parley.video.ffmpegPath`.

### Engineering
- New `src/video/ffmpeg.ts` (frame/audio extraction) with pure, unit-tested helpers; 36 unit tests.

## 0.16.0

### Added
- **Large text files upload instead of truncate.** When an attached text/CSV/Markdown/HTML/JSON/XML file exceeds the context character cap, it's now **uploaded via `/v1/files`** (OpenAI/Google) and referenced by id so its full contents reach the model — instead of being truncated. Small files stay inline, and on Bedrock/Anthropic (no upload endpoint) files remain inline/truncated as before.
- **`Parley: Show Usage`** — fetches your account's real billed spend for the current month (`GET /v1/accounts/{accountId}/usage`): cost in USD, request count, and input/output tokens. Reads `parley.accountId` (prompted and saved on first use; find it in the Parley Admin Portal under *My Account*). This is the authoritative figure that complements the in-chat estimate.

### Engineering
- New `parley.accountId` setting; `ParleyProvider.getUsage`. 34 unit tests.

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
