import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Workspace } from './workspace';

/**
 * While the MCP server runs, the workspace's backtest bundles are served on 127.0.0.1 so the app
 * can open them (`#backtest=<url>`): a human sees the agent's evidence on the backtest screen.
 * Read-only, loopback only, bundles only, and only to the app's origin.
 */

const APP_URL = process.env.HINDCAST_APP_URL ?? process.env.BOTTLENECK_APP_URL ?? 'http://localhost:5173';
let server: Server | null = null;
let base = '';
const roots = new Set<string>();

async function ensureServer(): Promise<string> {
  if (server) return base;
  const origin = new URL(APP_URL).origin;
  server = createServer((req, res) => {
    const name = basename(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method !== 'GET' || !(name.endsWith('.hindcast.json') || name.endsWith('.bottleneck.json'))) return res.writeHead(404).end();
    for (const r of roots) {
      const f = join(r, name);
      if (existsSync(f)) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(readFileSync(f));
      }
    }
    res.writeHead(404).end();
  });
  const port = Number(process.env.HINDCAST_SERVE_PORT ?? process.env.BOTTLENECK_SERVE_PORT ?? 0);
  await new Promise<void>((ok, fail) => server!.once('error', fail).listen(port, '127.0.0.1', () => ok()));
  server.unref();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return base;
}

/** a link that opens a bundle written by verify_change in the app */
export async function appLink(ws: Workspace, bundle: string): Promise<string> {
  roots.add(ws.path('reports'));
  const b = await ensureServer();
  return `${APP_URL}/#backtest=${encodeURIComponent(`${b}/${basename(bundle)}`)}`;
}
