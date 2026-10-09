# Agent setup files

| file | for |
|---|---|
| [`mcp.json`](mcp.json) | any MCP host (Claude Desktop, Cursor, Windsurf, VS Code): point it at the built server |
| [`skills/verify-infra-change/SKILL.md`](skills/verify-infra-change/SKILL.md) | Claude Code: copy to `.claude/skills/verify-infra-change/` in your project |
| [`AGENTS.md`](AGENTS.md) | agents without MCP (shell, CI, Codex, Aider): paste into your project's agent instructions |

Build the server and the CLI once: `npm run build:mcp-server && npm run build:cli`, which writes
`dist-cli/bottleneck-mcp.mjs` and `dist-cli/bottleneck.mjs` (Node 20, no install).

The full guide is in [docs/agents.md](../../docs/agents.md).
