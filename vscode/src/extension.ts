import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CliEngine, WasmEngine, type Engine } from './engine';
import { componentSpan, looksLikeSpec, parseSpecDoc, placeIssues, type Span, type SpecDoc } from './lineMap';
import type { Summary } from './protocol';

/**
 * Hindcast for VS Code: the live board beside a spec, the engine's validation as squiggles, a quick
 * run in the status bar, and the failure audit as a report. A thin shell: every number comes from
 * the engine (the bundled WebAssembly, or the `hindcast` CLI).
 */

const DEBOUNCE_MS = 300;
let engine: Engine | null = null;
let diagnostics: vscode.DiagnosticCollection;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;
const panels = new Map<string, vscode.WebviewPanel>();
/** what each board last said it shows */
const boards = new Map<string, { title: string; components: string[]; stale: boolean }>();
const boardErrors = new Map<string, string[]>();
const parsed = new Map<string, { version: number; doc: SpecDoc }>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const summaries = new Map<string, { version: number; summary: Summary | Error }>();

const cfg = () => vscode.workspace.getConfiguration('hindcast');
const rps = () => cfg().get<number>('rps') || undefined;

function makeEngine(ctx: vscode.ExtensionContext): Engine | null {
  const bin = cfg().get<string>('path')?.trim();
  const dist = ctx.asAbsolutePath('dist');
  if (cfg().get<string>('engine') === 'cli' && bin) return new CliEngine(bin);
  if (WasmEngine.available(dist)) return new WasmEngine(dist);
  return bin ? new CliEngine(bin) : null;
}

function specDoc(d: vscode.TextDocument): SpecDoc {
  const key = d.uri.toString();
  const hit = parsed.get(key);
  if (hit && hit.version === d.version) return hit.doc;
  const doc = parseSpecDoc(d.getText());
  parsed.set(key, { version: d.version, doc });
  return doc;
}

function isSpec(d: vscode.TextDocument): boolean {
  if (!['yaml', 'json', 'jsonc'].includes(d.languageId) && !/\.ya?ml$/i.test(d.fileName)) return false;
  return looksLikeSpec(d.fileName, specDoc(d).value);
}

const range = (s: Span) => new vscode.Range(s.line, s.character, s.endLine, Math.max(s.endCharacter, s.line === s.endLine ? s.character + 1 : s.endCharacter));

async function validate(d: vscode.TextDocument) {
  if (!isSpec(d)) return diagnostics.delete(d.uri);
  const doc = specDoc(d);
  const version = d.version;
  const toDiag = (l: { level: 'error' | 'warning'; message: string; span: Span }) => {
    const x = new vscode.Diagnostic(range(l.span), l.message, l.level === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
    x.source = 'hindcast';
    return x;
  };
  if (doc.value === undefined) return diagnostics.set(d.uri, doc.syntax.map(toDiag));
  if (!engine) return diagnostics.set(d.uri, doc.syntax.map(toDiag));
  try {
    const v = await engine.validate(doc.value, d.getText());
    if (d.version !== version) return;
    diagnostics.set(d.uri, [...doc.syntax, ...placeIssues(doc, v.issues)].map(toDiag));
  } catch (e) {
    output.appendLine(`validate ${d.fileName}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---- status bar: a quick headless run at the design's traffic ----

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const fmtPct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.001 ? 2 : 1)}%`;
const fmtMoney = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;

export function statusText(s: Summary): { text: string; breach: boolean } {
  const breach = s.p99Ms > s.slo.maxP99Ms || s.errorRate > s.slo.maxErrorRate;
  return { text: `${breach ? '$(warning)' : '$(pulse)'} p99 ${fmtMs(s.p99Ms)} · ${fmtPct(s.errorRate)} err · ${fmtMoney(s.monthly)}/mo`, breach };
}

function showStatus(d: vscode.TextDocument | undefined) {
  if (!cfg().get<boolean>('statusBar', true) || !d || !isSpec(d)) return status.hide();
  const hit = summaries.get(d.uri.toString());
  if (!hit) {
    status.text = '$(sync~spin) hindcast';
    status.tooltip = 'Running the design…';
    status.backgroundColor = undefined;
    return status.show();
  }
  if (hit.summary instanceof Error) {
    status.text = '$(error) hindcast';
    status.tooltip = hit.summary.message;
    status.backgroundColor = undefined;
    return status.show();
  }
  const s = hit.summary;
  const { text, breach } = statusText(s);
  status.text = text;
  status.backgroundColor = breach ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const md = new vscode.MarkdownString(
    [
      `**Hindcast** · ${s.scenario}${engine ? ` · ${engine.kind === 'wasm' ? 'engine (WebAssembly)' : 'hindcast CLI'}` : ''}`,
      '',
      `peak p99 **${fmtMs(s.p99Ms)}** (SLO ${fmtMs(s.slo.maxP99Ms)}) · errors **${fmtPct(s.errorRate)}** (SLO ${fmtPct(s.slo.maxErrorRate)}) · **${fmtMoney(s.monthly)}** a month`,
      '',
      `within SLO ${fmtPct(s.sloCompliance)} of the minute${s.bottleneck ? ` · busiest: \`${s.bottleneck.id}\`${s.bottleneck.note ? ` — ${s.bottleneck.note}` : ''}` : ''}`,
      '',
      'Click to open the board.',
    ].join('\n'),
  );
  status.tooltip = md;
  status.show();
}

async function summarize(d: vscode.TextDocument) {
  if (!engine || !cfg().get<boolean>('statusBar', true) || !isSpec(d)) return showStatus(vscode.window.activeTextEditor?.document);
  const doc = specDoc(d);
  const key = d.uri.toString();
  if (doc.value === undefined || summaries.get(key)?.version === d.version) return showStatus(vscode.window.activeTextEditor?.document);
  const version = d.version;
  let summary: Summary | Error;
  try {
    summary = await engine.summary(doc.value, d.getText(), rps());
  } catch (e) {
    summary = new Error(e instanceof Error ? e.message : String(e));
  }
  summaries.set(key, { version, summary });
  if (vscode.window.activeTextEditor?.document === d) showStatus(d);
}

// ---- the board ----

function boardHtml(ctx: vscode.ExtensionContext, panel: vscode.WebviewPanel): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
    `img-src ${panel.webview.cspSource} data: blob:`,
    'font-src data:',
    'connect-src data:',
  ].join('; ');
  const html = readFileSync(ctx.asAbsolutePath('dist/webview/index.html'), 'utf8');
  // the host API, and errors reported to the extension's output before the app has loaded (zod
  // probes for eval and falls back without it: not an error)
  const boot = `<script nonce="${nonce}">window.hindcastHost = acquireVsCodeApi();
const report = (m) => window.hindcastHost.postMessage({ type: 'error', message: String(m) });
addEventListener('error', (e) => report(e.message));
addEventListener('unhandledrejection', (e) => report(e.reason && e.reason.message || e.reason));
addEventListener('securitypolicyviolation', (e) => e.blockedURI !== 'eval' && report('CSP: ' + e.violatedDirective + ' ' + e.blockedURI));</script>`;
  // the app's one module script (vite-plugin-singlefile); the bundle's own "<script>" strings stay as they are
  return html
    .replace('<head>', () => `<head><meta http-equiv="Content-Security-Policy" content="${csp}">${boot}`)
    .replace('<script type="module" crossorigin>', () => `<script type="module" nonce="${nonce}">`);
}

function postSpec(d: vscode.TextDocument) {
  const panel = panels.get(d.uri.toString());
  const doc = specDoc(d);
  if (panel && doc.value !== undefined) void panel.webview.postMessage({ type: 'spec', value: doc.value, rps: rps() });
}

function revealComponent(d: vscode.TextDocument, id: string) {
  const span = componentSpan(specDoc(d), id);
  if (!span) return;
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === d);
  const r = range(span);
  if (editor) {
    editor.selection = new vscode.Selection(r.start, r.end);
    editor.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } else void vscode.window.showTextDocument(d, { viewColumn: vscode.ViewColumn.One, selection: r });
}

function openBoard(ctx: vscode.ExtensionContext, d: vscode.TextDocument) {
  const key = d.uri.toString();
  const open = panels.get(key);
  if (open) return open.reveal(vscode.ViewColumn.Beside, true);
  const panel = vscode.window.createWebviewPanel('hindcast.board', `Hindcast · ${basename(d.fileName)}`, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'webview')],
  });
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.svg');
  panel.webview.html = boardHtml(ctx, panel);
  panel.webview.onDidReceiveMessage((m: { type: string; id?: string; title?: string; components?: string[]; stale?: boolean; message?: string }) => {
    if (m.type === 'ready') postSpec(d);
    else if (m.type === 'error') {
      output.appendLine(`board ${basename(d.fileName)}: ${m.message}`);
      boardErrors.set(key, [...(boardErrors.get(key) ?? []), m.message ?? '']);
    } else if (m.type === 'board') boards.set(key, { title: m.title ?? '', components: m.components ?? [], stale: !!m.stale });
    else if (m.type === 'select' && m.id) revealComponent(d, m.id);
    else if (m.type === 'audit') void runAudit(ctx, d);
  });
  panel.onDidDispose(() => (panels.delete(key), boards.delete(key), boardErrors.delete(key)));
  panels.set(key, panel);
}

// ---- the audit ----

async function runAudit(ctx: vscode.ExtensionContext, d: vscode.TextDocument) {
  const doc = specDoc(d);
  if (!isSpec(d) || doc.value === undefined) return void vscode.window.showWarningMessage('Hindcast: this file is not a design spec (components and connections).');
  if (!engine) return void vscode.window.showErrorMessage('Hindcast: no engine. The extension is missing its WebAssembly build; set hindcast.path to the hindcast CLI.');
  const v = await engine.validate(doc.value, d.getText());
  if (!v.ok) {
    await validate(d);
    return void vscode.window.showErrorMessage('Hindcast: fix the errors in the spec first (see Problems).');
  }
  const eng = engine;
  try {
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Hindcast: auditing', cancellable: true }, (progress, token) => {
      token.onCancellationRequested(() => eng.dispose());
      let last = 0;
      return eng.audit(doc.value, d.getText(), { rps: rps(), costPerMinute: cfg().get<number>('costPerMinute') || undefined }, (p) => {
        const pct = (p.done / Math.max(1, p.total)) * 100;
        progress.report({ increment: pct - last, message: `${p.done}/${p.total} ${p.label}` });
        last = pct;
      });
    });
    const dir = vscode.Uri.joinPath(ctx.globalStorageUri, 'audits');
    await vscode.workspace.fs.createDirectory(dir);
    const file = vscode.Uri.joinPath(dir, `${basename(d.fileName).replace(/\.(ya?ml|json)$/i, '')}.audit.md`);
    await vscode.workspace.fs.writeFile(file, Buffer.from(r.markdown, 'utf8'));
    await vscode.commands.executeCommand('markdown.showPreviewToSide', file);
    output.appendLine(`audit ${d.fileName}: score ${r.score}, ${r.critical} critical → ${file.fsPath}`);
    return r;
  } catch (e) {
    vscode.window.showErrorMessage(`Hindcast audit: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function target(uri?: vscode.Uri): Thenable<vscode.TextDocument | undefined> {
  if (uri) return vscode.workspace.openTextDocument(uri);
  return Promise.resolve(vscode.window.activeTextEditor?.document);
}

// ---- wiring ----

function schedule(d: vscode.TextDocument, fn: () => void) {
  const key = d.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => (timers.delete(key), fn()), DEBOUNCE_MS));
}

function setContext(e: vscode.TextEditor | undefined) {
  void vscode.commands.executeCommand('setContext', 'hindcast.isSpec', !!e && isSpec(e.document));
}

export function activate(ctx: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Hindcast');
  diagnostics = vscode.languages.createDiagnosticCollection('hindcast');
  status = vscode.window.createStatusBarItem('hindcast.summary', vscode.StatusBarAlignment.Left, 50);
  status.name = 'Hindcast';
  status.command = 'hindcast.open';
  engine = makeEngine(ctx);
  output.appendLine(`engine: ${engine ? engine.kind : 'none (no WebAssembly build, hindcast.path not set)'}`);

  ctx.subscriptions.push(
    output,
    diagnostics,
    status,
    { dispose: () => engine?.dispose() },
    vscode.commands.registerCommand('hindcast.open', async (uri?: vscode.Uri) => {
      const d = await target(uri);
      if (!d || !isSpec(d)) return void vscode.window.showWarningMessage('Hindcast: open a design spec first (a *.hindcast.yaml, or YAML with components and connections).');
      openBoard(ctx, d);
    }),
    vscode.commands.registerCommand('hindcast.audit', async (uri?: vscode.Uri) => {
      const d = await target(uri);
      if (!d) return;
      return runAudit(ctx, d);
    }),
    // for tests and scripts: the last status bar summary of a document
    vscode.commands.registerCommand('hindcast.summary', (uri: vscode.Uri) => summaries.get(uri.toString())?.summary),
    vscode.commands.registerCommand('hindcast.board', (uri: vscode.Uri) => {
      const b = boards.get(uri.toString());
      const errors = boardErrors.get(uri.toString()) ?? [];
      return b || errors.length ? { ...b, errors } : undefined;
    }),
    vscode.workspace.onDidOpenTextDocument((d) => {
      void validate(d);
      void summarize(d);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const d = e.document;
      if (!e.contentChanges.length) return;
      schedule(d, () => {
        if (cfg().get<boolean>('validateOnType', true)) void validate(d);
        postSpec(d);
        setContext(vscode.window.activeTextEditor);
      });
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      void validate(d);
      void summarize(d);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      diagnostics.delete(d.uri);
      parsed.delete(d.uri.toString());
      summaries.delete(d.uri.toString());
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      setContext(e);
      showStatus(e?.document);
      if (e) void summarize(e.document);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('hindcast')) return;
      engine?.dispose();
      engine = makeEngine(ctx);
      summaries.clear();
      for (const d of vscode.workspace.textDocuments) void validate(d);
      const a = vscode.window.activeTextEditor?.document;
      if (a) void summarize(a);
      for (const d of vscode.workspace.textDocuments) postSpec(d);
    }),
  );

  for (const d of vscode.workspace.textDocuments) void validate(d);
  setContext(vscode.window.activeTextEditor);
  const a = vscode.window.activeTextEditor?.document;
  if (a) void summarize(a);
}

export function deactivate() {
  engine?.dispose();
}
