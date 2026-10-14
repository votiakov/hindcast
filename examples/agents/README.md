# Agent setup files

| file | for |
|---|---|
| [`mcp.json`](mcp.json) | any MCP host (Claude Desktop, Cursor, Windsurf, VS Code): point it at the built server |
| [`skills/verify-infra-change/SKILL.md`](skills/verify-infra-change/SKILL.md) | Claude Code: copy to `.claude/skills/verify-infra-change/` in your project |
| [`AGENTS.md`](AGENTS.md) | agents without MCP (shell, CI, Codex, Aider): paste into your project's agent instructions |

Build the binary once: `npm run cli:build` writes `engine-rs/target/release/hindcast`, which is
the CLI, the agent tools (`hindcast agent …`) and the MCP server (`hindcast mcp`) in one file.

The full guide is in [docs/agents.md](../../docs/agents.md).
