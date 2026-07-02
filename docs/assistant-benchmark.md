# Assistant Benchmark: Parley vs Codex vs Claude Code

This benchmark is a repeatable way to evaluate Parley against Codex- and Claude Code-style VS Code coding assistants. It avoids vague claims like "better" by scoring observable behavior on the same repository, same model where possible, and same tasks.

## What this repo already demonstrates

Parley has a broad autonomous-agent surface:

- Workspace file tools: `read_file`, `list_directory`, `find_files`, `write_file`, `edit_file`, and `multi_edit`.
- Search and code intelligence tools: `search_text`, `grep`, `find_symbol`, `document_symbols`, `find_definition`, and `find_references`.
- Execution tools: `run_command` with approvals/allowlists outside full-access mode.
- Browser/web tools: HTTPS fetch, browser navigation/read/console/click/type/screenshot, and web search.
- Delegation and process tools: read-only `run_subagent` and `update_plan`.
- Safety mechanisms: chat/ask/edit/plan/auto/full modes, checkpointed edits, revert commands, secret scanning, sensitive file filtering, command safety rules, `.gitignore` awareness, and large-context confirmation.
- Quality coverage: the current repository test suite covers file edits, checkpoints, command safety, browser error handling, MCP, subagents, secret scanning, transcript export, and agent loop behavior.

## Evaluation principles

1. **Use the same tasks.** Each assistant gets the same initial repo state and prompt.
2. **Use a clean branch per run.** Reset between tools so no assistant benefits from another assistant's edits.
3. **Record raw evidence.** Save prompts, final diffs, command output, test results, and time-to-fix.
4. **Prefer objective pass/fail.** A task passes only when tests/build/lint pass and the requested behavior is present.
5. **Score autonomy separately from correctness.** A correct patch after many manual nudges is not equivalent to a correct autonomous patch.

## Scoring rubric

Score each category from 0 to 5.

| Category | 0 | 3 | 5 |
| --- | --- | --- | --- |
| Correctness | Does not solve the task | Partially solves or leaves edge cases | Fully solves and passes verification |
| Minimality | Large unrelated rewrite | Some unnecessary churn | Small targeted diff |
| Repo understanding | Misses relevant files/APIs | Finds most relevant code | Accurately traces architecture/usages |
| Tool use | Does not inspect/run enough | Uses basic tools adequately | Uses search/read/edit/test iteratively and efficiently |
| Error recovery | Repeats failing attempts | Fixes obvious failures | Diagnoses logs and converges without handholding |
| Safety | Risky clobbering/destructive actions | Mostly safe but misses some checks | Reviewable diffs, checkpoints, no unsafe assumptions |
| UX | Noisy or unclear | Understandable | Concise progress, clear summary, useful citations |

Recommended final score: average the seven category scores, then record pass/fail separately.

## Benchmark task suite

Run at least these tasks against Parley, Codex, and Claude Code.

### Task 1: Localized bug fix

Prompt:

```text
A test around command safety is failing because compound commands can be incorrectly remembered as always allowed. Fix the bug without weakening valid simple-command allowlisting. Run the relevant tests.
```

Pass criteria:

- Compound commands with `&&`, `||`, `;`, `|`, background `&`, command substitution, or process substitution are not auto-remembered.
- Existing simple allowlisted commands still work.
- Relevant command-safety tests pass.

### Task 2: Multi-file feature

Prompt:

```text
Add a setting that limits captured terminal output returned to the model, document it in README, and add tests for truncation behavior.
```

Pass criteria:

- Setting is defined, read, and applied where command output is returned to the model.
- User-visible docs mention the setting.
- Tests cover short output, long output, and omitted-output marker behavior.

### Task 3: Edit safety regression

Prompt:

```text
Ensure write_file never overwrites an existing non-empty file unless the assistant has already read the current contents during this conversation. Add or update tests.
```

Pass criteria:

- Existing unseen file is protected.
- Re-issuing after the tool auto-reads current content can succeed.
- New files and empty existing files still work as intended.

### Task 4: Architecture explanation

Prompt:

```text
Explain how a user request becomes tool calls and file edits in this extension. Cite the key files and functions.
```

Pass criteria:

- Mentions chat/webview entry point, agent turn runner, tool schema, tool executor, checkpoint store, and settings/modes.
- Uses accurate path:line citations.
- Distinguishes ask/edit/auto/full behavior.

### Task 5: Browser-assisted debugging

Prompt:

```text
Start the extension/webview build or test harness if available, inspect browser/console output for UI errors, and fix one real issue you find. If no UI harness exists, clearly report that after checking package scripts and source layout.
```

Pass criteria:

- Does not invent a local URL or UI harness.
- Uses actual scripts/source evidence.
- Fixes a real issue if one is discoverable, or reports a well-supported limitation.

### Task 6: Broad repo reconnaissance

Prompt:

```text
Find all places where outbound context may include user files. Check whether secret scanning or sensitive-file filtering applies consistently. Report gaps and patch one high-impact gap.
```

Pass criteria:

- Finds context attachment, tool result, file read/search, transcript/export, and browser/web pathways as applicable.
- Separates outbound-to-model from local-only storage.
- Adds a focused test-backed fix if a gap exists.

## Suggested evidence log

Create one row per assistant per task.

| Assistant | Task | Pass/fail | Score | Commands run | Files changed | Notes |
| --- | --- | --- | ---: | --- | --- | --- |
| Parley | 1 |  |  |  |  |  |
| Codex | 1 |  |  |  |  |  |
| Claude Code | 1 |  |  |  |  |  |

## Current qualitative self-assessment

Based on this repository's implemented tools and passing tests, Parley appears competitive with Codex/Claude Code on **autonomous repository editing**, **terminal execution**, **reviewable/checkpointed edits**, **browser inspection**, and **safety controls**.

Areas where Codex or Claude Code may still have an advantage until measured:

- Vendor model quality and hosted inference optimizations.
- Polished account/auth, cloud sync, and onboarding flows.
- Mature telemetry-backed UX iteration.
- Deep proprietary IDE integrations not visible from open source code.
- Large-scale real-world benchmark history.

Areas where Parley is especially strong in this codebase:

- Explicit mode model from chat-only through full-access autonomy.
- Checkpointed reversible edits with tests for byte-faithful restore.
- Broad built-in tool surface, including browser tools, MCP, web search, subagents, and language-server symbol tools.
- Safety-focused tests around command allowlisting, sensitive files, and secret redaction.

## Minimal release gate for claims

Before making public claims such as "as good as Codex" or "as good as Claude Code", run the full benchmark above and publish:

- Exact extension versions.
- Exact model/provider used.
- Hardware/OS.
- Full prompts.
- Final diffs.
- Test/build output.
- Human scoring notes.

A credible claim should be framed as:

> On this benchmark suite, Parley passed N/M tasks with an average rubric score of X.Y, compared with Codex A.B and Claude Code C.D.

Avoid unqualified claims that one assistant is globally better than another.
