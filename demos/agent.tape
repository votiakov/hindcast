# Claude Code, with the backtester's MCP server, asked a real question about a real cluster.
# Before recording: the Kubernetes reference running (reference/k8s/README.md), the MCP server built
# (npm run build:mcp-server) and demos/mcp.json written by `npm run sim -- agent setup` or by hand:
#   { "mcpServers": { "hindcast": { "command": "node", "args": ["<repo>/dist-cli/hindcast-mcp.mjs"],
#                                      "env": { "HINDCAST_WORKSPACE": "<repo>/demos/ws" } } } }
#   vhs demos/agent.tape
Output demos/out/agent-k8s.mp4
Output demos/out/agent-k8s.gif

Require claude

Set Shell zsh
Set FontFamily "Menlo"
Set FontSize 17
Set Width 1440
Set Height 900
Set Padding 28
Set LineHeight 1.25
Set Theme "Builtin Dark"
Set TypingSpeed 18ms
Set WindowBar Colorful

Hide
Type "rm -rf demos/ws && unset CLAUDE_CODE_CHILD_SESSION CLAUDECODE && clear"
Enter
Show

Type "claude --model sonnet --mcp-config demos/mcp.json --strict-mcp-config --allowedTools mcp__hindcast"
Sleep 400ms
Enter
Sleep 10s

Type "Our shop runs on the local Kubernetes cluster — Prometheus at http://localhost:8088/prometheus, Jaeger at http://localhost:8088/jaeger. "
Type "Our history is the ordinary day recorded 16:43-17:23 UTC today. "
Type "This PR cuts the frontend from 3 to 2 replicas: reference/k8s/shop/variants/frontend-2.yaml (base: reference/k8s/shop/shop.yaml). "
Type "Is it safe on a normal day, and on launch day, when we expect 2.2x the traffic? Use hindcast."
Sleep 600ms
Enter
Sleep 60s
Screenshot demos/out/agent-60s.png

Wait+Screen@14m /(?i)(load[- ]?test)/
Sleep 45s
Ctrl+C
Sleep 300ms
Ctrl+C
Sleep 1s
