# Parley — Manual Test Checklist

Everything implemented this session (v1.43 → v1.73). Work through the table; when you've
verified a row, tell me its **number** (e.g. "3 and 7 pass", or "12 is broken: …") and I'll
tick the **Tested** column or fix the issue.

Legend: ☐ = not tested yet · ✅ = tested & works · ❌ = tested, has a problem.

| #  | Feature | Tested |
| -- | ------- | ------ |
| 1  | Image attachment thumbnails + full image viewer | ☐ |
| 2  | `@problems` mention | ☐ |
| 3  | Generate PR Description | ☐ |
| 4  | Add Docs | ☐ |
| 5  | Explain honors the selection | ☐ |
| 6  | `Ctrl+.` Parley refactor menu | ☐ |
| 7  | `run_tests` tool + Fix Failing Tests | ☐ |
| 8  | MCP Server Status | ☐ |
| 9  | `@codebase` matched-region attachment (local index) | ☐ |
| 10 | Multi-file diff review (native multi-diff editor) | ☐ |
| 11 | Inline completion polish (per-language / cache / suffix trim) | ☐ |
| 12 | `/verify` (test-command unification) | ☐ |
| 13 | Ask-mode Stop no longer deadlocks | ☐ |
| 14 | `parley.allowedFetchHosts` egress allowlist | ☐ |
| 15 | Untrusted-workspace / Full-mode trust gating | ☐ |
| 16 | `@blame` mention | ☐ |
| 17 | `@issue <n>` mention | ☐ |
| 18 | `@pr [n]` mention | ☐ |
| 19 | Diagram This (inline Mermaid) | ☐ |
| 20 | Triage TODOs | ☐ |
| 21 | Audit Dependencies | ☐ |
| 22 | Generate Tests for Uncovered Code | ☐ |
| 23 | Predict Next Edit — Diff Review | ☐ |
| 24 | Predict Next Edit — ghost-Tab (`Ctrl+Alt+N`) | ☐ |
| 25 | Hover to explain / Explain Symbol | ☐ |
| 26 | CodeLens actions (Explain · Test · Doc) | ☐ |
| 27 | Create Pull Request | ☐ |
| 28 | Generate Release Notes | ☐ |
| 29 | Explain Stack Trace | ☐ |
| 30 | Port / Translate Code | ☐ |
| 31 | Split Into Logical Commits | ☐ |
| 32 | Onboard Me to This Repo | ☐ |
| 33 | Explain Commit / Compare Refs | ☐ |
| 34 | Screenshot to UI | ☐ |
| 35 | Fix / Explain Test (Test Explorer) | ☐ |
| 36 | Ask About Notebook Cell | ☐ |

---

## Test details

### 1. Image attachment thumbnails + full image viewer
- Attach an image (paste, drag-drop, `@file`, or 📷 screenshot) → the composer shows a **thumbnail chip** (image + filename + ×), not a plain text chip.
- Click the thumbnail → the **full image viewer** opens (zoom, pan, ⬇ download, ‹ ›/thumbnail-strip navigation, ✕/Esc close).
- The **×** on the chip removes only that attachment. Non-image attachments (audio/doc) still show the labeled chip.

### 2. `@problems` mention
- Open a file with a red error + a warning. Type `@problems` in the composer → it appears in the `@` autocomplete.
- Send "summarize @problems" → the reply reflects the **actual current** errors/warnings (errors listed first, with `file line:col` and the rule/source).
- With **no** problems open, `@problems` reports "no problems".

### 3. Generate PR Description
- On a feature branch with commits beyond `main`, run **Parley: Generate PR Description** (palette or Source Control ⋯ menu).
- A markdown doc opens with **# title / ## Summary / ## Changes / ## Test plan**, and it's **copied to the clipboard**.
- On `main` with no diverging commits → it says there's nothing to describe.

### 4. Add Docs
- Select a function → right-click **Parley → Add Docs** (and via `Ctrl+.`). Reply proposes doc comments (JSDoc/docstring) as a **reviewable edit**, no behavior change.
- With no selection → documents the whole file.

### 5. Explain honors the selection
- Select a single function → **Explain** → the reply is about the **selection**, not the whole file.
- With no selection → explains the whole file.

### 6. `Ctrl+.` Parley refactor menu
- Select some code → press **`Ctrl+.`** → the lightbulb menu shows **Refactor / Edit / Generate tests / Add docs / Explain with Parley**.
- Picking one runs the matching action on the selection. With no selection, they don't appear.

### 7. `run_tests` tool + Fix Failing Tests
- In an Agent/Full mode, ask "run the tests" → the agent calls `run_tests`; it auto-detects the command (npm/pytest/…) and reports **PASS/FAIL + output**.
- Break a test, run **Parley: Fix Failing Tests** → it runs, and on failure the agent fixes and re-runs until green.
- Verify PASS is not mislabeled, and huge output says "too much output" (not "timeout").

### 8. MCP Server Status
- With `parley.mcpServers` configured, run **Parley: MCP Server Status** → a QuickPick lists each server (connected ✓ / failed, transport, tool count).
- Pick a connected server → its tools are listed. Point one at a bad command → it shows **failed + the error**.

### 9. `@codebase` matched-region attachment (local index)
- Set `parley.codebaseSearch.provider` = `local`, run **Rebuild Codebase Index**.
- Ask a question with `@codebase` → attached context is labeled `@codebase path:from-to` and contains the **relevant region** of large files (not just the top).
- Lexical provider (default) still attaches the file head; both never error.

### 10. Multi-file diff review (native multi-diff editor)
- Have the agent edit several files in one turn. On the end-of-turn "N files changed" card, click **Review**.
- All changed files open in **one** VS Code multi-file diff editor (before/after), not many separate tabs.

### 11. Inline completion polish
- Ghost completions appear as you type. Add `"markdown"` to `parley.inlineCompletion.disabledLanguages` → no ghost text in markdown.
- Move the cursor away and back to a spot just completed → the suggestion returns **instantly** (cache).
- A completion doesn't **double** a closing `}`/`)`/`;` the line already has.

### 12. `/verify` (test-command unification)
- In an agent mode, run `/verify` → it uses the same detected/`parley.testCommand` command as `run_tests`, drives the run via the tool, and iterates to green.
- Setting only `parley.verifyCommand` still works (back-compat); if both are set, `testCommand` wins consistently across `/verify`, `run_tests`, and Fix Failing Tests.

### 13. Ask-mode Stop no longer deadlocks
- In **Ask before edits** mode, have the agent propose several edits. While an approval card is pending (or mid multi-edit), press **Stop**.
- The turn ends cleanly (status returns to idle) — it does **not** stay stuck "busy" needing a reload.

### 14. `parley.allowedFetchHosts` egress allowlist
- Leave it empty → the agent can `fetch_url` any public site (default behavior).
- Set it to `["example.com"]` → `fetch_url` / `browser_navigate` to `example.com` (and subdomains) works; to any other host it's **refused** with an allowlist message.

### 15. Untrusted-workspace / Full-mode trust gating
- Open a folder as **untrusted** (Restricted Mode). **Fix Failing Tests** refuses ("trust the workspace first").
- In Full mode + untrusted, the agent still **asks** before running a shell command (doesn't auto-run). A malicious `.vscode/settings.json` `parley.testCommand` is ignored while untrusted.

### 16. `@blame` mention
- Select a few lines in a committed file → send "why does @blame exist" → the reply reflects the **git blame** (authors/commits) for that selection/file.

### 17. `@issue <n>` mention
- With `gh` installed + authed, `@issue 1` (a real issue number) → the issue's title/body/comments are pulled into context.
- Without `gh`, it degrades to a clear error rather than hanging.

### 18. `@pr [n]` mention
- `@pr` (on a branch with a PR) or `@pr 123` → the PR's details are pulled in via `gh`. Confirm `@pr` does **not** trigger on `@problems`.

### 19. Diagram This (inline Mermaid)
- Right-click **Parley → Diagram This** → pick **Structure / Class / Sequence / Dependencies**.
- The reply renders a **Mermaid diagram inline** in the chat (not just a code block) and reflects the current file/selection.

### 20. Triage TODOs
- Run **Parley: Triage TODOs** → a picker lists TODO/FIXME/HACK/XXX markers (with `file:line`).
- Pick one → the file opens at that line and the agent proposes to implement/justify it.

### 21. Audit Dependencies
- In an npm/pnpm/yarn project, run **Parley: Audit Dependencies** → it runs the right audit and streams a **plain-English** grouped explanation + remediation commands.

### 22. Generate Tests for Uncovered Code
- Open a source file, run **Parley: Generate Tests for Uncovered Code** (trusted workspace) → it runs coverage and proposes tests **targeting the uncovered lines**.
- If it can't detect a coverage command it prompts for one; refuses in an untrusted workspace.

### 23. Predict Next Edit — Diff Review
- Make an edit, run **Parley: Predict Next Edit (Diff Review)** → it predicts a related next change, **jumps to the location**, and shows a diff to Apply/Reject (checkpointed).
- If nothing confident/ambiguous, it says so (no bogus edit).

### 24. Predict Next Edit — ghost-Tab (`Ctrl+Alt+N`) ⭐ needs careful testing
- After an edit, press **`Ctrl+Alt+N`** → a decoration + status-bar hint mark the predicted location.
- **Tab** jumps the caret there and shows the change as **native ghost text**; a second **Tab** accepts it; **Esc** dismisses.
- **Critically:** normal **Tab** (indent, snippet nav, accepting a normal completion) still works everywhere when there's no pending prediction.
- Optional: enable `parley.nextEdit.autoTrigger` and confirm predictions appear after edits settle.

### 25. Hover to explain / Explain Symbol
- Hover a symbol → an **"$(sparkle) Explain … with Parley"** link appears in the tooltip (no request until clicked).
- Click it (or run **Explain Symbol** with the cursor on a symbol) → the chat explains that symbol using the file as context. Toggle off via `parley.hover.explain`.

### 26. CodeLens actions (Explain · Test · Doc)
- Set `parley.codeLens.enabled` = true → **Explain · Test · Doc** lenses appear above functions/methods/classes.
- Clicking a lens focuses that symbol and runs the action. Turning the setting off removes the lenses.

### 27. Create Pull Request ⭐ outward-facing
- On a feature branch (with `gh` authed), run **Parley: Create Pull Request** → it drafts a description, then **confirms with a modal** (title + base).
- On confirm: it pushes the branch and opens the PR via `gh`, returning a **clickable URL**. On `main`, or without `gh`, it declines cleanly.

### 28. Generate Release Notes
- Run **Parley: Generate Release Notes** → grouped notes (Features/Fixes/Docs/Chore) + a suggested version bump from commits **since the last tag**, opened in a doc + copied.

### 29. Explain Stack Trace
- Copy a real stack trace (JS/TS or Python). Run **Parley: Explain Stack Trace** (it reads selection → clipboard → input box).
- It **opens the top frame that's in your workspace** and explains the failure + a fix.

### 30. Port / Translate Code
- Select code, run **Parley: Port / Translate Code** → pick a target language → the ported code opens in a **new document** with that language's syntax highlighting.

### 31. Split Into Logical Commits
- With uncommitted changes, run **Parley: Split Into Logical Commits** → it proposes several commits (message + files/hunks each) without touching git.

### 32. Onboard Me to This Repo
- Run **Parley: Onboard Me to This Repo** → a briefing covering what the project is, architecture, key files, how to build/test/run, and a **Mermaid diagram**, grounded in the README/manifest/file tree.

### 33. Explain Commit / Compare Refs
- Run **Parley: Explain Commit / Compare Refs** → **Explain a commit** (enter `HEAD` or a hash) explains what it changed and why.
- **Compare two refs** (e.g. `main` vs `HEAD`) summarizes the diff. A bogus/injection-y ref is rejected.

### 34. Screenshot to UI
- Run **Parley: Screenshot to UI** → pick a screenshot of a UI. It attaches the image and prefills a "build this UI" prompt.
- Send → the model returns an HTML artifact and the **design canvas opens** rendering a UI that resembles the screenshot.

### 35. Fix / Explain Test (Test Explorer)
- Open the Test Explorer (needs a test extension, e.g. Jest/pytest). **Right-click a test item** → **Parley: Fix / Explain Test**.
- The test's file opens and the agent runs/diagnoses/fixes it (or explains what it verifies).

### 36. Ask About Notebook Cell
- Open a Jupyter notebook (`.ipynb`), select a cell, run **Parley: Ask About Notebook Cell** → optionally type a question (blank = explain).
- The reply is about the **selected cell(s)'** source.
