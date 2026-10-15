// End-to-end in a real extension host: the VS Code already installed (VSCODE_EXECUTABLE, or the
// macOS default), a throwaway profile and workspace, nothing downloaded. `npm run test:host`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, '../..');
const code = process.env.VSCODE_EXECUTABLE ?? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron', '/Applications/Visual Studio Code.app/Contents/MacOS/Code', '/usr/share/code/code'].find((p) => existsSync(p));
if (!code) {
  console.error('no VS Code found: set VSCODE_EXECUTABLE');
  process.exit(1);
}
const tmp = mkdtempSync(join(tmpdir(), 'hindcast-vscode-'));
const ws = join(tmp, 'ws');
mkdirSync(ws, { recursive: true });
// a quiet profile: no update checks, no telemetry, no experiments
mkdirSync(join(tmp, 'user/User'), { recursive: true });
writeFileSync(join(tmp, 'user/User/settings.json'), JSON.stringify({ 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'workbench.enableExperiments': false, 'chat.disableAIFeatures': true }));
copyFileSync(join(ext, '../examples/shop.yaml'), join(ws, 'shop.yaml'));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(
  code,
  [ws, `--extensionDevelopmentPath=${ext}`, `--extensionTestsPath=${join(here, 'suite.cjs')}`, `--user-data-dir=${join(tmp, 'user')}`, `--extensions-dir=${join(tmp, 'extensions')}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--new-window'],
  { stdio: 'inherit', env, timeout: 300_000 },
);
rmSync(tmp, { recursive: true, force: true });
process.exit(r.status ?? 1);
