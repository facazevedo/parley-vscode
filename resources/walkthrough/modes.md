# Modes

Click the mode button (bottom of the composer):

- **Chat** — answers only; no file access.
- **Ask before edits** — the agent proposes edits; you approve each one (per-hunk review supported).
- **Edit automatically** — edits apply immediately (revertible).
- **Plan** — read-only exploration, then a plan you can edit before building.
- **Auto** — the agent decides and applies edits.
- **Full access ⚠** — also runs shell commands without asking.

Every agent edit goes through **checkpoints**: `Parley: Revert Last Edit` / `Revert All Edits`, and the ⏪ button on any message rewinds conversation, files, or both. The same panel sets **extended thinking** (Claude & Gemini).
