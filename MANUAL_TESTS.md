# Parley — Manual Test Checklist (exhaustive)

Every feature in the extension. Work the table; tell me a row **number** (e.g. "12 passes",
"48 is broken: …") and I'll tick **Tested** or fix it.

Legend: ☐ not tested · ✅ works · ❌ has a problem.

| #  | Feature | Tested |
| -- | ------- | ------ |
| | **— Setup & account —** | |
| 1  | Set API Key (stored in SecretStorage) | ☐ |
| 2  | Sign Out | ☐ |
| 3  | Report an Issue / Open Debug Log | ☐ |
| | **— Chat & conversations —** | |
| 4  | Streaming chat + agent timeline (dots, "Thought for Ns", model-switch divider) | ☐ |
| 5  | Tool-step inspector (expand args + raw result) | ☐ |
| 6  | Stop a running turn | ☐ |
| 7  | Regenerate last response | ☐ |
| 8  | New conversation / in Tab / in New Window | ☐ |
| 9  | Conversation switcher + full-text search | ☐ |
| 10 | Open Conversations Folder / Open Past Conversation | ☐ |
| 11 | Export conversation (md / txt / json) | ☐ |
| 12 | Compact conversation (`/compact`) | ☐ |
| 13 | Rewind conversation & files (per-message) | ☐ |
| | **— Models & reasoning —** | |
| 14 | Model switcher (`/model`) | ☐ |
| 15 | `/compare` (two models side by side) | ☐ |
| 16 | Extended thinking levels (off/adaptive/low/med/high) | ☐ |
| 17 | Set Token Limit + auto-compaction thresholds | ☐ |
| | **— Agent modes —** | |
| 18 | Chat mode (answer only) | ☐ |
| 19 | Ask before edits (approve each) | ☐ |
| 20 | Edit automatically | ☐ |
| 21 | Plan mode → editable plan → Build | ☐ |
| 22 | Auto mode | ☐ |
| 23 | Full access (+ auto-continue) | ☐ |
| | **— Agent tools —** | |
| 24 | Read/search tools (read_file, list_directory, find_files, search_text, grep) | ☐ |
| 25 | Code navigation (document_symbols, find_symbol, find_definition, find_references) | ☐ |
| 26 | Edit tools (write_file, edit_file, multi_edit) | ☐ |
| 27 | run_command (approval + workspace allowlist) | ☐ |
| 28 | run_tests | ☐ |
| 29 | Subagents (run_subagent / run_subagents) | ☐ |
| 30 | update_plan / remember / load_skill | ☐ |
| 31 | Text-tool-call adapter (models without native tool-calling) | ☐ |
| | **— Context & @-mentions —** | |
| 32 | `@file` / `@file#12-40` / `@folder` | ☐ |
| 33 | `@sym:` (symbol via language server) | ☐ |
| 34 | `@codebase` (lexical + local semantic matched-region) | ☐ |
| 35 | `@problems` | ☐ |
| 36 | `@git` | ☐ |
| 37 | `@blame` | ☐ |
| 38 | `@issue <n>` / `@pr [n]` | ☐ |
| 39 | `@terminal` | ☐ |
| 40 | `@browser <url>` / `@https://url` | ☐ |
| 41 | Add Selection to Chat (`Alt+K`) / Add File to Chat Context | ☐ |
| | **— Editing & review —** | |
| 42 | Inline diff cards (Apply / Choose hunks / Reject) | ☐ |
| 43 | Multi-file diff review (native multi-diff editor) | ☐ |
| 44 | Checkpoints: Revert Last Edit / Revert All Edits | ☐ |
| 45 | File Edit History | ☐ |
| 46 | Inline edit (`Ctrl+Alt+K`) | ☐ |
| 47 | Predict Next Edit — Diff Review | ☐ |
| 48 | Predict Next Edit — ghost-Tab (`Ctrl+Alt+N`) ⭐ | ☐ |
| 49 | Format-preserving edits (CRLF / BOM) | ☐ |
| | **— Completion & code actions —** | |
| 50 | Ghost-text inline completion (toggle, per-language, cache, suffix-trim) | ☐ |
| 51 | Hover to explain / Explain Symbol | ☐ |
| 52 | CodeLens (Explain · Test · Doc) | ☐ |
| 53 | Right-click Parley submenu + `Ctrl+.` menu | ☐ |
| 54 | Ask About Selection | ☐ |
| 55 | Explain Current File (selection-aware) | ☐ |
| 56 | Refactor Selection | ☐ |
| 57 | Generate Tests | ☐ |
| 58 | Add Docs | ☐ |
| 59 | Fix Diagnostics (+ "Fix with Parley" lightbulb) | ☐ |
| 60 | Diagram This (inline Mermaid) | ☐ |
| 61 | Port / Translate Code | ☐ |
| | **— Testing & quality —** | |
| 62 | run_tests + Fix Failing Tests | ☐ |
| 63 | `/verify` | ☐ |
| 64 | Generate Tests for Uncovered Code | ☐ |
| 65 | Review Current Branch | ☐ |
| 66 | Review Staged Changes | ☐ |
| 67 | Fix / Explain Test (Test Explorer) | ☐ |
| 68 | Run Diagnostics (gateway health) | ☐ |
| | **— Git & GitHub —** | |
| 69 | Generate Commit Message | ☐ |
| 70 | Generate PR Description | ☐ |
| 71 | Create Pull Request ⭐ | ☐ |
| 72 | Generate Release Notes | ☐ |
| 73 | Split Into Logical Commits | ☐ |
| 74 | Explain Commit / Compare Refs | ☐ |
| | **— Terminal —** | |
| 75 | Suggest Terminal Command | ☐ |
| 76 | Fix Last Terminal Command (+ transient hint) | ☐ |
| | **— Multimodal —** | |
| 77 | Attach image / PDF / audio / video | ☐ |
| 78 | Image attachment thumbnails + full viewer | ☐ |
| 79 | 📷 Screenshot (monitor picker + countdown) | ☐ |
| 80 | 🎥 Screen recording (+ mic narration) | ☐ |
| 81 | Screenshot to UI | ☐ |
| 82 | Generate Image (gpt-image-1) | ☐ |
| 83 | Voice input (🎤) + read-aloud / voice mode | ☐ |
| | **— Design canvas —** | |
| 84 | Parley Design (HTML/SVG/React render + versions + export) | ☐ |
| 85 | Design chat (iterate the artifact) | ☐ |
| | **— Web & browser —** | |
| 86 | web_search (DuckDuckGo / Google / Tavily) | ☐ |
| 87 | fetch_url (SSRF + allowlist) | ☐ |
| 88 | Headless browser + Close Browser | ☐ |
| | **— MCP —** | |
| 89 | MCP servers (stdio / http / sse) | ☐ |
| 90 | MCP Server Status + Reconnect MCP Servers | ☐ |
| | **— Computer use —** | |
| 91 | `/computer` (mouse/keyboard, kill switch, confirm) ⚠ | ☐ |
| | **— Memory, rules, skills, commands, styles, hooks —** | |
| 92 | Project memory (`remember` + Open Project Memory) | ☐ |
| 93 | Project rules + Init Project Rules | ☐ |
| 94 | Skills + Create Skill | ☐ |
| 95 | Custom slash commands + `/json` + `/help` | ☐ |
| 96 | Output styles (Select Output Style) | ☐ |
| 97 | Hooks (`parley.hooks`) | ☐ |
| | **— Repo understanding & maintenance —** | |
| 98 | Onboard Me to This Repo | ☐ |
| 99 | Triage TODOs | ☐ |
| 100 | Audit Dependencies | ☐ |
| | **— Cost, usage & context —** | |
| 101 | Cost + context-window gauges + status-bar ticker | ☐ |
| 102 | Show Context Breakdown (`/context`) | ☐ |
| 103 | Show Usage + Usage History + usage warning | ☐ |
| | **— Safety & privacy —** | |
| 104 | Sensitive-file filtering | ☐ |
| 105 | Outbound secret redaction | ☐ |
| 106 | Prompt-injection defenses (untrusted content) | ☐ |
| 107 | Workspace Trust gating + Manage Allowed Commands | ☐ |
| 108 | SSRF protection + `parley.allowedFetchHosts` | ☐ |
| | **— Added in v1.76–1.77 —** | |
| 109 | Review a Pull Request (by number, via `gh`) | ☐ |
| 110 | Generate / Update README (reviewable edit) | ☐ |
| 111 | Batch approval — Apply all / Reject all (Ask mode) | ☐ |

---

## Test details

## Setup & account

### 1. Set API Key
- Run **Parley: Set API Key**, paste an `sk-parley-…` key → it verifies and the model list loads.
- The key is stored in SecretStorage (not in settings.json); reload → still authenticated.

### 2. Sign Out
- Run **Parley: Sign Out** → the stored key is cleared; the next request prompts to set a key again.

### 3. Report an Issue / Open Debug Log
- **Report an Issue** opens a prefilled GitHub issue.
- **Open Debug Log** opens the verbose log (present after enabling debug / using the extension).

## Chat & conversations

### 4. Streaming chat + agent timeline
- Send a prompt → the reply streams token-by-token; the left rail shows dots (message/tool/error/running).
- A reasoning model shows **"Thought for Ns"**; switching model mid-turn shows a **"Switched to …"** divider.

### 5. Tool-step inspector
- In an agent turn, click a tool step (⏺) → it expands to the exact **arguments** and the full **raw result**.

### 6. Stop a running turn
- Start a long turn, click **Stop** → generation halts promptly and the status returns to idle.

### 7. Regenerate last response
- Click **Regenerate** (or the palette command) → the last user message is re-run and the reply replaced.

### 8. New conversation / in Tab / in New Window
- **New Conversation** saves the current chat and clears it.
- **New Conversation in Tab** / **in New Window** opens an independent chat (its own history) as an editor tab / floating window.

### 9. Conversation switcher + full-text search
- Click the conversation title → the switcher lists past conversations with relative dates.
- Type ≥3 chars → results include **content matches** (with snippets), not just titles; scope toggle This-repo / All works.

### 10. Open Conversations Folder / Open Past Conversation
- **Open Conversations Folder** reveals the `.parley` transcripts on disk.
- **Open Past Conversation** reopens a saved/archived one with its full transcript.

### 11. Export conversation
- **Export Conversation** → choose Markdown / plain text / JSON → the file has the full transcript + a metadata header (models, mode, tokens, cost).

### 12. Compact conversation
- **Compact** (⊟ / `/compact`) → keep-recent or everything → context shrinks; the saved transcript keeps the full record.

### 13. Rewind conversation & files
- Use the per-message ⏪ rewind → fork conversation / restore files / both → state (and optionally files) returns to that point.

## Models & reasoning

### 14. Model switcher
- `/model` (or the dropdown) lists gateway models; switching changes the model for subsequent turns.

### 15. `/compare`
- `/compare <prompt>` runs the prompt on a **second** model side by side; you can adopt either reply.

### 16. Extended thinking
- Set `parley.thinking` to low/medium/high (or adaptive) on a supporting model → the reply shows thinking ran; `off` disables it.

### 17. Token limit + auto-compaction
- **Set Token Limit** caps a conversation. With `autoCompactPercent`/`autoCompactTokens` set, a long conversation auto-compacts at the threshold.

## Agent modes

### 18. Chat mode
- In **Chat** mode the model answers only — no file reads/edits or tools.

### 19. Ask before edits
- Agent proposes edits as **inline cards**; nothing is written until you Apply. (See 42.)

### 20. Edit automatically
- Agent applies edits without asking; each is checkpointed/revertible.

### 21. Plan mode → Build
- **Plan** explores read-only and produces a plan that opens as an **editable doc**; **Build** implements your edited plan (Ask or Auto).

### 22. Auto mode
- Agent decides and applies edits automatically without per-edit approval.

### 23. Full access (+ auto-continue)
- **Full access** runs shell commands without asking (trusted workspace only — see 107).
- Auto-continue: the agent keeps working across steps until done, bounded by `maxAutoContinue`/`maxToolRounds`.

## Agent tools

### 24. Read/search tools
- Ask the agent to find/read something → it uses read_file / find_files / search_text / grep / list_directory and cites real paths.

### 25. Code navigation
- Ask "where is X defined / used" → it uses find_definition / find_references / document_symbols (language-server backed).

### 26. Edit tools
- Agent edits produce write_file / edit_file / multi_edit changes, each diff-reviewed + checkpointed.

### 27. run_command
- Agent asks to run a command → in non-Full modes you get an approval modal; **Always Allow** remembers a safe prefix (workspace-scoped).

### 28. run_tests
- Agent runs the suite via run_tests → PASS/FAIL + output (see 62).

### 29. Subagents
- On a broad question, the agent fans out **parallel read-only** subagents and returns a synthesized answer.

### 30. update_plan / remember / load_skill
- The agent maintains a live plan (update_plan), saves durable facts (remember → `.parley/memory.md`), and pulls skill instructions on demand (load_skill).

### 31. Text-tool-call adapter
- On a model without native tool-calling, agent tool calls still work (`<tool_call>` tags parsed, run, fed back).

## Context & @-mentions

### 32. @file / @lines / @folder
- `@somefile` attaches its contents (fuzzy autocomplete); `@file#12-40` only those lines; `@folder/` a listing.

### 33. @sym:
- `@sym:name` finds a function/class/symbol via the language server and attaches its source.

### 34. @codebase
- Lexical (default): attaches the most relevant files. Local semantic (`provider=local`, after **Rebuild Codebase Index**): attaches the matched **region** (`@codebase path:from-to`).

### 35–41. Other mentions & selection
- **35 @problems** — current errors/warnings. **36 @git** — uncommitted diff. **37 @blame** — git blame of the selection/file. **38 @issue/@pr** — GitHub issue/PR via `gh`. **39 @terminal** — recent terminal output. **40 @browser/@url** — rendered page text. **41** — `Alt+K` inserts an `@file#range` of the selection; right-click → **Add File to Chat Context**.

## Editing & review

### 42. Inline diff cards
- In Ask mode each proposed edit shows a card: **Apply / Choose hunks… / Reject**, diff opened beside. "Choose hunks…" accepts/rejects individual hunks.

### 43. Multi-file diff review
- The end-of-turn "N files changed" card's **Review** opens all changed files in **one** native multi-diff editor.

### 44. Checkpoints
- **Revert Last Edit** undoes the most recent applied edit; **Revert All Edits** restores everything from this conversation.

### 45. File Edit History
- **File Edit History** lists every Parley edit to the current file, each openable as a before/after diff.

### 46. Inline edit
- Select code → **`Ctrl+Alt+K`** → describe a change → review the diff → apply (checkpointed).

### 47. Predict Next Edit — Diff Review
- **Predict Next Edit (Diff Review)** → jumps to a predicted change and shows a diff to Apply/Reject.

### 48. Predict Next Edit — ghost-Tab ⭐
- **`Ctrl+Alt+N`** marks a predicted edit (decoration + status hint). **Tab** jumps there + shows native ghost; a second **Tab** accepts; **Esc** dismisses.
- **Critical:** normal Tab (indent/snippets/accept-completion) still works when there's no pending prediction.

### 49. Format-preserving edits
- Edit a CRLF file → after applying, it stays CRLF (line endings/BOM/encoding preserved).

## Completion & code actions

### 50. Ghost-text inline completion
- Ghost suggestions appear as you type. `disabledLanguages` suppresses per language; a cursor bounce is served instantly (cache); a closer the line already has isn't doubled. **Toggle Inline Completion** flips it.

### 51. Hover to explain / Explain Symbol
- Hover a symbol → "Explain with Parley" link (no request until clicked). **Explain Symbol** explains the symbol under the cursor.

### 52. CodeLens
- Enable `parley.codeLens.enabled` → **Explain · Test · Doc** lenses appear above functions/classes and run the matching action.

### 53. Right-click submenu + Ctrl+. menu
- Editor right-click → **Parley** submenu (Ask/Edit/Refactor/Explain/Tests/Docs/Diagram/Fix). `Ctrl+.` on a selection lists the Refactor-kind Parley actions.

### 54–61. Selection/file actions
- **54 Ask About Selection**, **55 Explain** (selection-aware), **56 Refactor Selection**, **57 Generate Tests**, **58 Add Docs**, **59 Fix Diagnostics** (+ squiggle lightbulb), **60 Diagram This** (inline Mermaid), **61 Port / Translate Code** (→ new doc). Each produces the expected reply/edit.

## Testing & quality

### 62. run_tests + Fix Failing Tests
- **Fix Failing Tests** runs the detected suite; on failure the agent fixes + re-runs to green. PASS not mislabeled; over-large output reported as such (not "timeout").

### 63. `/verify`
- `/verify` (agent mode) runs tests via run_tests and iterates until green; honors `testCommand`/`verifyCommand`.

### 64. Generate Tests for Uncovered Code
- Trusted workspace → runs coverage → proposes tests for the current file's **uncovered** lines.

### 65–66. Review branch / staged
- **Review Current Branch** = severity-grouped review + PR description; **Review Staged Changes** = review of what's about to be committed (SCM ⋯ menu).

### 67. Fix / Explain Test (Test Explorer)
- Right-click a test in the Test Explorer → **Parley: Fix / Explain Test** → opens the file, runs/diagnoses/fixes.

### 68. Run Diagnostics
- **Run Diagnostics** probes the gateway (models/chat/tokens/usage) and writes a health report.

## Git & GitHub

### 69. Generate Commit Message
- SCM ⋯ → **Generate Commit Message** → a Conventional Commits message lands in the commit box.

### 70. Generate PR Description
- **Generate PR Description** → paste-ready title/Summary/Changes/Test-plan in a doc + clipboard.

### 71. Create Pull Request ⭐
- Feature branch with `gh` authed → **Create Pull Request** → drafts, **confirms** (title + base), pushes, opens the PR, returns the URL. Declines on `main` / without `gh`.

### 72. Generate Release Notes
- **Generate Release Notes** → grouped notes + suggested version bump from commits since the last tag.

### 73. Split Into Logical Commits
- **Split Into Logical Commits** → proposes several commits (message + files/hunks) without running git.

### 74. Explain Commit / Compare Refs
- **Explain a commit** (HEAD or hash) explains what/why; **Compare two refs** summarizes the diff; bad/injection refs rejected.

## Terminal

### 75. Suggest Terminal Command
- **Suggest Terminal Command** → describe a task → a command is inserted into a terminal (never auto-run).

### 76. Fix Last Terminal Command
- After a command fails (with shell integration), a transient hint appears; **Fix Last Terminal Command** sends it + output to chat.

## Multimodal

### 77. Attach image / PDF / audio / video
- Attach each type; video samples frames (ffmpeg) and can extract audio; all reach the model appropriately.

### 78. Image thumbnails + viewer
- Image attachments show as thumbnail chips; click → full viewer (zoom/pan/download/next-prev/thumbnails).

### 79. Screenshot (📷)
- Single monitor → auto-captures + attaches. Multiple → a big per-monitor button + 5s countdown; click one → attaches (Esc/timeout cancels).

### 80. Screen recording (🎥)
- Records (≤60s), samples frames + optional mic narration; on stop, frames + `narration.wav` attach.

### 81. Screenshot to UI
- **Screenshot to UI** → pick a UI image → attaches + prefills a build prompt → on send, an HTML artifact renders in the design canvas resembling the shot.

### 82. Generate Image
- **Generate Image** (or the `generate_image` tool) → gpt-image-1 produces an image shown inline / saved.

### 83. Voice
- 🎤 records + transcribes into the composer; `voice.autoRead` reads replies aloud; hands-free voice mode works.

## Design canvas

### 84. Parley Design
- Ask for "a landing page in HTML" (or React) → **Parley Design** opens and renders it; version history + open-code + export work.

### 85. Design chat
- In the canvas's own chat, "make it dark mode" → a new version renders; the main chat is unaffected.

## Web & browser

### 86. web_search
- With a provider set, the agent's web_search returns results it then reads.

### 87. fetch_url
- fetch_url gets a page's text; refuses private/loopback; honors `allowedFetchHosts` (see 108).

### 88. Headless browser + Close Browser
- browser_navigate/read/click/type/console/screenshot drive a real Chromium; **Close Browser** shuts it down.

## MCP

### 89. MCP servers
- Configure `parley.mcpServers` (stdio/http/sse) → tools appear to the agent as `mcp__server__tool` and run.

### 90. MCP Server Status + Reconnect
- **MCP Server Status** shows connected/failed servers + their tools; **Reconnect MCP Servers** restarts them.

## Computer use

### 91. `/computer` ⚠
- After opt-in (`computerUse.enabled`), `/computer <task>` drives the mouse/keyboard one action at a time, with per-action confirm (if set) and a corner-slam kill switch.

## Memory, rules, skills, commands, styles, hooks

### 92. Project memory
- The agent saves a durable fact via `remember` → it appears in `.parley/memory.md` and is injected in later conversations. **Open Project Memory** shows it.

### 93. Project rules + Init
- `AGENTS.md`/`.parleyrules`/`.cursorrules` are respected (first match wins). **Init Project Rules** analyzes the repo → a tailored `AGENTS.md`.
- **CLAUDE.md (Claude Code semantics):** put a root `CLAUDE.md` with a distinctive rule (e.g. "always answer starting with 🦜") → the agent obeys it. Add `@./docs/extra.md` to it and confirm the imported file's content also takes effect. A `~/.claude/CLAUDE.md` and a package-level `CLAUDE.md` (loaded once a file in that package is opened/edited) are honored too.

### 94. Skills + Create Skill
- **Create Skill** scaffolds a `.parley/skills/<name>/SKILL.md`; the agent loads it on demand for matching tasks.

### 95. Custom slash commands + /json + /help
- A `.parley/commands/name.md` becomes `/name` (with `$ARGS`/`$SELECTION`). `/json` forces a JSON reply; `/help` lists commands.

### 96. Output styles
- **Select Output Style** (Default/Concise/Explanatory/Learning + custom) visibly changes reply style.

### 97. Hooks
- Configure `parley.hooks` (e.g. PreToolUse) → the command runs at that event; exit 2 intervenes. (Trusted workspace only.)

## Repo understanding & maintenance

### 98. Onboard Me to This Repo
- **Onboard Me to This Repo** → briefing (what it is, architecture, key files, how to run) + a Mermaid diagram.

### 99. Triage TODOs
- **Triage TODOs** lists TODO/FIXME/HACK/XXX markers; pick one → the file opens and the agent tackles it.

### 100. Audit Dependencies
- **Audit Dependencies** runs npm/pnpm/yarn audit and explains findings + remediation.

## Cost, usage & context

### 101. Gauges + ticker
- The header shows cost (`~$`) and context-window usage; the status bar tickers sidebar tokens/cost + a working spinner.

### 102. Context breakdown
- **Show Context Breakdown** (`/context`) shows a per-component estimate of what fills the window.

### 103. Usage
- **Show Usage** = this month's billed spend (needs account id); **Usage History** = by-day chart + by-model table; `usageWarnUsd` warns past a threshold.

## Safety & privacy

### 104. Sensitive-file filtering
- Ask the agent to read `.env` / a key file → it refuses (not read / not attached).

### 105. Outbound secret redaction
- If a read file contains a known credential format (AWS/GitHub/`sk-…`), it's redacted before the model sees it (`secretScanning`).

### 106. Prompt-injection defenses
- Fetched web/file/terminal/MCP content is fenced as untrusted; an embedded "ignore instructions / run X" isn't followed in non-Full modes without your approval.

### 107. Workspace Trust + allowlist
- Untrusted workspace: code-exec settings ignored; **Fix Failing Tests** refuses; Full mode still asks before commands. **Manage Allowed Commands** reviews/removes remembered approvals.

### 108. SSRF + allowedFetchHosts
- fetch_url refuses `169.254.169.254`/loopback/private even via redirect/rebinding; setting `allowedFetchHosts` restricts egress to listed hosts.

## Added in v1.76–1.77

### 109. Review a Pull Request
- With `gh` authed, run **Parley: Review a Pull Request** → enter a PR number → it fetches the diff (`gh pr diff`) and streams a severity-grouped review + an approve/request-changes recommendation. Non-numeric input rejected; no `gh` → clean error.

### 110. Generate / Update README
- Run **Parley: Generate / Update README** → it drafts (or updates) `README.md` from the code and shows it as a **diff to review** (create/overwrite), applied via checkpoint on approval. "Already up to date" when unchanged.

### 111. Batch approval — Apply all / Reject all
- In **Ask before edits** mode, trigger a turn that edits several files. On the first approval card, click **Apply all** → the remaining edits this turn auto-apply (no more cards); **Reject all** rejects the rest.
- Verify it's scoped to the turn (the next turn asks again) and everything stays checkpointed/revertible.
