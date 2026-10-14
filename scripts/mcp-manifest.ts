// What the MCP server says about itself — initialize, tools/list, prompts/list, resources/list —
// recorded from the TypeScript server (mcp/server.ts) for the native one to serve as is:
// engine-rs/src/cli/mcp/manifest.json. npx tsx scripts/mcp-manifest.ts [--write]
import { readFileSync, writeFileSync } from 'node:fs';
import { handshake, session } from './mcp-session';

const FILE = 'engine-rs/src/cli/mcp/manifest.json';

export async function mcpManifest(): Promise<string> {
  const r = await session('npx', ['tsx', 'mcp/server.ts'], [...handshake, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'prompts/list' }, { jsonrpc: '2.0', id: 4, method: 'resources/list' }, { jsonrpc: '2.0', id: 5, method: 'resources/templates/list' }]);
  const by = (id: number) => (r.find((m) => m.id === id) as { result: Record<string, unknown> }).result;
  const { protocolVersion: _v, ...init } = by(1);
  return JSON.stringify({ initialize: init, tools: by(2).tools, prompts: by(3).prompts, resources: by(4).resources, resourceTemplates: by(5).resourceTemplates }, null, 1) + '\n';
}

if (process.argv[1]?.endsWith('mcp-manifest.ts')) {
  const m = await mcpManifest();
  if (process.argv.includes('--write')) writeFileSync(FILE, m);
  else process.exitCode = readFileSync(FILE, 'utf8') === m ? 0 : 1;
}
