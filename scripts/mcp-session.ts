// Talk to an MCP server over stdio (newline-delimited JSON-RPC): send each message, collect every
// line it writes back (responses and notifications), for the native server's parity checks.
import { spawn } from 'node:child_process';

export async function session(cmd: string, args: string[], messages: Record<string, unknown>[], env: Record<string, string> = {}, timeoutMs = 600_000): Promise<Record<string, unknown>[]> {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } });
  const out: Record<string, unknown>[] = [];
  let buf = '';
  const waiting = new Map<unknown, () => void>();
  p.stdout.on('data', (b: Buffer) => {
    buf += b.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line) as Record<string, unknown>;
      out.push(m);
      if ('id' in m && waiting.has(m.id)) waiting.get(m.id)!(), waiting.delete(m.id);
    }
  });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  for (const m of messages) {
    const done = 'id' in m ? new Promise<void>((r) => waiting.set(m.id, r)) : Promise.resolve();
    p.stdin.write(JSON.stringify(m) + '\n');
    await done;
  }
  clearTimeout(timer);
  p.stdin.end();
  p.kill();
  return out;
}

export const handshake = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
];
