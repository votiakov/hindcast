// Runs inside a real VS Code extension host (test/host/run.mjs): the built extension, end to end.
const assert = require('node:assert/strict');
const vscode = require('vscode');

const until = async (what, fn, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

const BAD = `version: 1
name: Bad
components:
  - { id: users, kind: client }
  - id: api
    kind: servr
connections:
  - users -> api
`;

exports.run = async function run() {
  const ws = vscode.workspace.workspaceFolders[0].uri;
  const results = [];
  const step = async (name, fn) => {
    const t = Date.now();
    await fn();
    results.push(`ok  ${name} (${Date.now() - t} ms)`);
    console.log(`[host] ok  ${name}`);
  };

  await step('diagnostics land on the line of the bad value', async () => {
    const uri = vscode.Uri.joinPath(ws, 'bad.hindcast.yaml');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(BAD));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const diags = await until('diagnostics', () => vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'hindcast').length && vscode.languages.getDiagnostics(uri));
    const kind = diags.find((d) => d.message.includes('servr'));
    assert.ok(kind, JSON.stringify(diags.map((d) => d.message)));
    assert.equal(kind.range.start.line, 5);
    assert.equal(doc.getText(kind.range), 'servr');
    assert.equal(kind.severity, vscode.DiagnosticSeverity.Error);
  });

  await step('fixing the file clears them, as you type', async () => {
    const uri = vscode.Uri.joinPath(ws, 'bad.hindcast.yaml');
    const editor = vscode.window.activeTextEditor;
    const doc = editor.document;
    const at = doc.getText().indexOf('servr');
    await editor.edit((e) => e.replace(new vscode.Range(doc.positionAt(at), doc.positionAt(at + 5)), 'server'));
    await until('no errors', () => !vscode.languages.getDiagnostics(uri).some((d) => d.severity === vscode.DiagnosticSeverity.Error));
  });

  const shop = vscode.Uri.joinPath(ws, 'shop.yaml');
  await step('a plain .yaml with components and connections is a spec: status bar run', async () => {
    const doc = await vscode.workspace.openTextDocument(shop);
    await vscode.window.showTextDocument(doc);
    const s = await until('summary', () => vscode.commands.executeCommand('hindcast.summary', shop));
    assert.ok(!(s instanceof Error), String(s && s.message));
    assert.equal(s.p99Ms, 93);
    assert.equal(s.errorRate, 0);
    assert.equal(Math.round(s.monthly), 971);
  });

  await step('Open design: the board loads the engine and shows the spec', async () => {
    await vscode.commands.executeCommand('hindcast.open', shop);
    const b = await until('board', async () => {
      const x = await vscode.commands.executeCommand('hindcast.board', shop);
      if (x && x.errors.length) throw new Error(`board: ${x.errors.join(' | ')}`);
      return x && x.title !== undefined && x;
    }, 60000);
    assert.equal(b.title, 'Web shop');
    assert.deepEqual(b.components, ['users', 'lb', 'api', 'db']);
    assert.equal(b.stale, false);
  });

  await step('an edit reaches the board (debounced)', async () => {
    const doc = await vscode.workspace.openTextDocument(shop);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const end = doc.positionAt(doc.getText().indexOf('connections:'));
    await editor.edit((e) => e.insert(end, '  - { id: cache, kind: cache }\n'));
    const b = await until('board with cache', async () => {
      const x = await vscode.commands.executeCommand('hindcast.board', shop);
      return x && x.components.includes('cache') && x;
    });
    assert.equal(b.stale, false);
    // a broken edit keeps the last good board and says so
    await editor.edit((e) => e.insert(end, '  - { id: 7 }\n'));
    await until('stale board', async () => {
      const x = await vscode.commands.executeCommand('hindcast.board', shop);
      return x && x.stale;
    });
    await vscode.commands.executeCommand('undo');
    await vscode.commands.executeCommand('undo');
  });

  await step('Audit design: the report as Markdown', async () => {
    const r = await vscode.commands.executeCommand('hindcast.audit', shop);
    assert.ok(r && r.markdown.startsWith('# Failure audit — Web shop'), r && r.markdown.slice(0, 80));
    assert.equal(typeof r.score, 'number');
  });

  console.log(results.join('\n'));
};
