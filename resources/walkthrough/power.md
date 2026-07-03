# Power tools

- **Slash commands**: `/compact` (summarize to free context), `/compare` (same prompt on two models, side by side), `/model`, `/cost`, `/help`.
- **Custom commands**: drop `name.md` in `.parley/commands/` (or `~/.parley/commands/`) — frontmatter `description:` shows in the menu; `$ARGS` and `$SELECTION` expand.
- **Custom subagents**: `.parley/agents/*.md` defines read-only investigator roles the agent can delegate to (optional `model:` override).
- **Code blocks** in replies have **Copy** and **Apply** buttons; diagnostics offer **Fix with Parley** in the lightbulb (`Ctrl+.`).
- **MCP servers** (`parley.mcpServers`), lifecycle **hooks**, output **styles**, and a local **@codebase index** round it out — see the README.
