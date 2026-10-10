import { describe, expect, it } from 'vitest';
import { configPath, handshake, mergedConfig } from '../agent/setup';
import { existsSync } from 'node:fs';

describe('agent setup', () => {
  const launch = { command: '/usr/bin/node', args: ['/x/bottleneck-mcp.mjs'] };
  it('merges into a host file and keeps the servers already there', () => {
    const out = mergedConfig('cursor', { mcpServers: { other: { command: 'x' } }, theme: 1 }, launch, { BOTTLENECK_WORKSPACE: '/p/.bottleneck' });
    expect(out).toEqual({ theme: 1, mcpServers: { other: { command: 'x' }, bottleneck: { command: '/usr/bin/node', args: ['/x/bottleneck-mcp.mjs'], env: { BOTTLENECK_WORKSPACE: '/p/.bottleneck' } } } });
  });
  it('writes VS Code its own shape', () => {
    const out = mergedConfig('vscode', {}, launch, {}) as { servers: Record<string, { type: string }> };
    expect(out.servers.bottleneck.type).toBe('stdio');
  });
  it('knows where each host keeps its config', () => {
    expect(configPath('claude', '/p').path).toBe('/p/.mcp.json');
    expect(configPath('cursor', '/p').path).toBe('/p/.cursor/mcp.json');
    expect(configPath('vscode', '/p').scope).toBe('project');
    expect(configPath('desktop', '/p').scope).toBe('user');
  });
  it.runIf(existsSync('dist-cli/bottleneck-mcp.mjs'))('completes an MCP handshake with the built server', async () => {
    const r = await handshake({ command: process.execPath, args: ['dist-cli/bottleneck-mcp.mjs'] }, {});
    expect(r.tools).toContain('verify_change');
  }, 30_000);
});
