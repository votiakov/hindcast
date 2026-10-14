import { describe, expect, it } from 'vitest';
import { configPath, handshake, mergedConfig } from '../agent/setup';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultWorkspaceDir } from '../agent/workspace';

describe('agent setup', () => {
  const launch = { command: '/usr/bin/node', args: ['/x/hindcast-mcp.mjs'] };
  it('merges into a host file and keeps the servers already there', () => {
    const out = mergedConfig('cursor', { mcpServers: { other: { command: 'x' } }, theme: 1 }, launch, { HINDCAST_WORKSPACE: '/p/.hindcast' });
    expect(out).toEqual({ theme: 1, mcpServers: { other: { command: 'x' }, hindcast: { command: '/usr/bin/node', args: ['/x/hindcast-mcp.mjs'], env: { HINDCAST_WORKSPACE: '/p/.hindcast' } } } });
  });
  it('replaces the entry registered under the old name', () => {
    const out = mergedConfig('cursor', { mcpServers: { other: { command: 'x' }, bottleneck: { command: 'old' } } }, launch, {}) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(out.mcpServers).sort()).toEqual(['hindcast', 'other']);
    const vs = mergedConfig('vscode', { servers: { bottleneck: { command: 'old' } } }, launch, {}) as { servers: Record<string, unknown> };
    expect(Object.keys(vs.servers)).toEqual(['hindcast']);
  });
  it('keeps a workspace made before the rename, and starts new ones in .hindcast', () => {
    const d = mkdtempSync(join(tmpdir(), 'hc-ws-'));
    expect(defaultWorkspaceDir(d)).toBe(join(d, '.hindcast'));
    mkdirSync(join(d, '.bottleneck'));
    expect(defaultWorkspaceDir(d)).toBe(join(d, '.bottleneck'));
    mkdirSync(join(d, '.hindcast'));
    expect(defaultWorkspaceDir(d)).toBe(join(d, '.hindcast'));
    rmSync(d, { recursive: true, force: true });
  });
  it('writes VS Code its own shape', () => {
    const out = mergedConfig('vscode', {}, launch, {}) as { servers: Record<string, { type: string }> };
    expect(out.servers.hindcast.type).toBe('stdio');
  });
  it('knows where each host keeps its config', () => {
    expect(configPath('claude', '/p').path).toBe('/p/.mcp.json');
    expect(configPath('cursor', '/p').path).toBe('/p/.cursor/mcp.json');
    expect(configPath('vscode', '/p').scope).toBe('project');
    expect(configPath('desktop', '/p').scope).toBe('user');
  });
  it.runIf(existsSync('dist-cli/hindcast-mcp.mjs'))('completes an MCP handshake with the built server', async () => {
    const r = await handshake({ command: process.execPath, args: ['dist-cli/hindcast-mcp.mjs'] }, {});
    expect(r.tools).toContain('verify_change');
  }, 30_000);
});
