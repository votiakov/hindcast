import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `bottleneck agent setup [host] [--write]`: register the MCP server with an agent host without
 * hand-editing paths. Finds (or builds) the single-file server, prints the host's config with
 * absolute paths filled in, merges it into the host's file when asked, and proves the server starts
 * by completing an MCP handshake with it.
 */

export type Host = 'claude' | 'cursor' | 'vscode' | 'desktop' | 'windsurf';
export const HOSTS: Host[] = ['claude', 'cursor', 'vscode', 'desktop', 'windsurf'];

interface Launch {
  command: string;
  args: string[];
}

/** where the server is: next to this CLI when it is the standalone build, else built from the repository */
export function findServer(): { launch: Launch; note?: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = join(here, 'bottleneck-mcp.mjs');
  if (existsSync(sibling)) return { launch: { command: process.execPath, args: [sibling] } };
  // running from the repository (tsx cli/bottleneck.ts): the bundle lives in dist-cli/
  const repo = resolve(here, '..');
  const bundle = join(repo, 'dist-cli', 'bottleneck-mcp.mjs');
  if (!existsSync(bundle) && existsSync(join(repo, 'mcp', 'server.ts'))) {
    const r = spawnSync('npm', ['run', '-s', 'build:mcp-server'], { cwd: repo, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('could not build the MCP server: run `npm run build:mcp-server` in the repository and look at its output');
    return { launch: { command: process.execPath, args: [bundle] }, note: `built ${bundle}` };
  }
  if (!existsSync(bundle)) throw new Error('no MCP server found next to this CLI or in a Bottleneck repository');
  return { launch: { command: process.execPath, args: [bundle] } };
}

/** the config file a host reads, and whether it is per project or per user */
export function configPath(host: Host, project: string): { path: string; scope: 'project' | 'user' } {
  const home = homedir();
  switch (host) {
    case 'claude':
      return { path: join(project, '.mcp.json'), scope: 'project' };
    case 'cursor':
      return { path: join(project, '.cursor', 'mcp.json'), scope: 'project' };
    case 'vscode':
      return { path: join(project, '.vscode', 'mcp.json'), scope: 'project' };
    case 'windsurf':
      return { path: join(home, '.codeium', 'windsurf', 'mcp_config.json'), scope: 'user' };
    case 'desktop':
      return {
        path:
          platform() === 'darwin'
            ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
            : platform() === 'win32'
              ? join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
              : join(home, '.config', 'Claude', 'claude_desktop_config.json'),
        scope: 'user',
      };
  }
}

/** the host's file with the bottleneck server merged in; every other server is kept */
export function mergedConfig(host: Host, existing: Record<string, unknown>, launch: Launch, env: Record<string, string>): Record<string, unknown> {
  const entry = { command: launch.command, args: launch.args, ...(Object.keys(env).length ? { env } : {}) };
  // VS Code keeps servers under "servers" and wants a type; the others use "mcpServers"
  if (host === 'vscode') return { ...existing, servers: { ...((existing.servers as object) ?? {}), bottleneck: { type: 'stdio', ...entry } } };
  return { ...existing, mcpServers: { ...((existing.mcpServers as object) ?? {}), bottleneck: entry } };
}

/** start the server, initialize, list its tools: the same first steps every host takes */
export function handshake(launch: Launch, env: Record<string, string>, timeoutMs = 20_000): Promise<{ tools: string[]; version: string }> {
  return new Promise((resolveP, reject) => {
    const p = spawn(launch.command, launch.args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    let version = '';
    const timer = setTimeout(() => finish(new Error(`the server did not answer within ${timeoutMs / 1000} s${err ? `: ${err.trim().split('\n').pop()}` : ''}`)), timeoutMs);
    const finish = (e: Error | null, v?: { tools: string[]; version: string }) => {
      clearTimeout(timer);
      p.kill();
      if (e) reject(e);
      else resolveP(v!);
    };
    const send = (m: object) => p.stdin.write(JSON.stringify(m) + '\n');
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('error', (e) => finish(e));
    p.on('exit', (code) => code !== null && code !== 0 && finish(new Error(`the server exited with code ${code}${err ? `: ${err.trim().split('\n').pop()}` : ''}`)));
    p.stdout.on('data', (d) => {
      buf += String(d);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { serverInfo?: { version?: string }; tools?: { name: string }[] }; error?: { message: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.error) return finish(new Error(msg.error.message));
        if (msg.id === 1) {
          version = msg.result?.serverInfo?.version ?? '';
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) finish(null, { tools: (msg.result?.tools ?? []).map((t) => t.name), version });
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bottleneck-setup', version: '1' } } });
  });
}

export interface SetupOptions {
  host?: Host;
  write?: boolean;
  project?: string;
  workspace?: string;
}

export async function setup(o: SetupOptions, log: (s: string) => void = console.log): Promise<void> {
  const project = resolve(o.project ?? process.cwd());
  const { launch, note } = findServer();
  if (note) log(note);
  const env: Record<string, string> = { BOTTLENECK_WORKSPACE: resolve(o.workspace ?? join(project, '.bottleneck')) };

  log(`MCP server: ${launch.command} ${launch.args.join(' ')}`);
  const hs = await handshake(launch, { BOTTLENECK_WORKSPACE: env.BOTTLENECK_WORKSPACE });
  log(`✓ it starts and answers: ${hs.tools.length} tools (${hs.tools.slice(0, 6).join(', ')}${hs.tools.length > 6 ? ', …' : ''})`);

  const hosts = o.host ? [o.host] : HOSTS;
  for (const host of hosts) {
    const { path, scope } = configPath(host, project);
    if (host === 'claude' && !o.write) {
      const envFlags = Object.entries(env).map(([k, v]) => `-e ${k}=${JSON.stringify(v)}`).join(' ');
      log(`\nClaude Code (${scope === 'project' ? 'this project' : 'you'}):\n  claude mcp add bottleneck ${envFlags} -- ${[launch.command, ...launch.args].map((a) => JSON.stringify(a)).join(' ')}`);
      continue;
    }
    const existing = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8') || '{}') as Record<string, unknown>) : {};
    const next = mergedConfig(host, existing, launch, env);
    if (o.write) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
      log(`✓ ${host}: wrote ${path}${Object.keys(existing).length ? ' (other servers kept)' : ''}`);
    } else {
      const key = host === 'vscode' ? 'servers' : 'mcpServers';
      log(`\n${label(host)} — ${path}:\n${indent(JSON.stringify({ [key]: { bottleneck: (next[key] as Record<string, unknown>).bottleneck } }, null, 2))}`);
    }
  }
  if (!o.write) log(`\nAdd --write (with one host: cursor, vscode, desktop, windsurf or claude) to merge it into that file.`);
  log(`Credentials (a Prometheus token, say) go in the server's "env" in that file; tools name the variable (tokenEnv), never the value.`);
  log(`Then ask your agent: "use bottleneck to check whether <change> is safe".`);
}

const label = (h: Host) => ({ claude: 'Claude Code', cursor: 'Cursor', vscode: 'VS Code', desktop: 'Claude Desktop', windsurf: 'Windsurf' })[h];
const indent = (s: string) => s.replace(/^/gm, '  ');
