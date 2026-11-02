const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transform } = require('../out/transform');

// Exercise the real extension against a small in-memory VS Code API double.
function host(source, languageId = 'go') {
  let content = source;
  let enabled = true;
  const listeners = {};
  const subscribe = name => callback => {
    listeners[name] = callback;
    return { dispose() {} };
  };
  class Selection {
    constructor(anchor, active) { this.anchor = anchor; this.active = active; }
    get isEmpty() { return this.anchor === this.active; }
  }
  const document = {
    languageId, version: 1, isClosed: false,
    uri: { toString: () => 'untitled:test' },
    getText: () => content, positionAt: n => n, offsetAt: n => n,
  };
  const editor = {
    document, selections: [new Selection(0, 0)], edits: [],
    get selection() { return this.selections[0]; },
    set selection(value) { this.selections = [value]; },
    async edit(callback, options) {
      callback({ replace(range, text) {
        editor.edits.push({ range, text, options });
        change(range.start, range.end - range.start, text);
      } });
      return true;
    },
  };
  const vscode = {
    workspace: {
      textDocuments: [document],
      onDidOpenTextDocument: subscribe('open'),
      onDidCloseTextDocument: subscribe('close'),
      onDidChangeTextDocument: subscribe('change'),
      getConfiguration: () => ({ get: () => enabled }),
    },
    window: { activeTextEditor: editor, onDidChangeTextEditorSelection: subscribe('selection') },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    Selection,
  };
  const exports = {};
  const handlerExports = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../out/onDidChangeTextDocument'), 'utf8'), {
    exports: handlerExports, require: name => name === 'vscode' ? vscode : { transform },
    setTimeout, clearTimeout, console,
  });

  vm.runInNewContext(fs.readFileSync(require.resolve('../out/extension'), 'utf8'), {
    exports, require: name => name === 'vscode' ? vscode : handlerExports,
    setTimeout, clearTimeout, console,
  });
  const context = { subscriptions: [] };
  exports.activate(context);
  function change(offset, length, text, reason, deferSelection = false) {
    content = content.slice(0, offset) + text + content.slice(offset + length);
    document.version++;
    listeners.change({ document, reason, contentChanges: [{ rangeOffset: offset, rangeLength: length, text }] });
    if (!deferSelection) editor.selection = new Selection(offset + text.length, offset + text.length);
  }
  return {
    document, editor, vscode, change,
    select(offset) {
      editor.selection = new Selection(offset, offset);
      listeners.selection({ textEditor: editor });
    },
    disable() { enabled = false; },
    dispose() { context.subscriptions.forEach(s => s.dispose()); },
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 15));

test('Go editor inserts brackets, positions caret, groups undo and ignores own edit', async () => {
  const h = host('func foo() int {}');
  h.change(14, 0, ',');
  await settle();
  assert.equal(h.document.getText(), 'func foo() (int, ) {}');
  assert.equal(h.editor.selection.active, 'func foo() (int, '.length);
  assert.equal(h.editor.edits.length, 1);
  assert.equal(h.editor.edits[0].options.undoStopBefore, false);
  // Backspace over the space then the comma; both snapshots must be current.
  h.change(16, 1, '');
  await settle();
  h.change(15, 1, '');
  await settle();
  assert.equal(h.document.getText(), 'func foo() int {}');
  assert.equal(h.editor.selection.active, 'func foo() int'.length);
  h.dispose();
});

for (const scenario of ['typescript', 'disabled', 'undo', 'redo', 'multiple cursors', 'inactive editor']) {
  test(`does not transform: ${scenario}`, async () => {
    const h = host('func foo() int {}', scenario === 'typescript' ? 'typescript' : 'go');
    if (scenario === 'disabled') h.disable();
    if (scenario === 'multiple cursors') h.editor.selections.push(h.editor.selection);
    if (scenario === 'inactive editor') h.vscode.window.activeTextEditor = undefined;
    h.change(14, 0, ',', scenario === 'undo' ? 1 : scenario === 'redo' ? 2 : undefined);
    await settle();
    assert.equal(h.document.getText(), 'func foo() int, {}');
    assert.equal(h.editor.edits.length, 0);
    h.dispose();
  });
}
test('cancels stale edit when typing continues before callback', async () => {
  const h = host('func foo() int {}');
  h.change(14, 0, ',');
  h.change(15, 0, 'x');
  await settle();
  assert.equal(h.document.getText(), 'func foo() int,x {}');
  assert.equal(h.editor.edits.length, 0);
  h.dispose();
});
test('disposal cancels pending callback', async () => {
  const h = host('func foo() int {}');
  h.change(14, 0, ',');
  h.dispose();
  await settle();
  assert.equal(h.editor.edits.length, 0);
});

test('unwraps when Backspace selection event arrives after the timer', async () => {
  const h = host('func foo() (int, ) {}');
  h.select(16);
  h.change(15, 1, '', undefined, true);
  await settle();
  assert.equal(h.editor.edits.length, 0);
  h.select(15);
  await settle();
  assert.equal(h.document.getText(), 'func foo() int {}');
  assert.equal(h.editor.selection.active, 14);
  assert.equal(h.editor.edits.length, 1);
  h.dispose();
});

test('unwraps on Delete without a selection event', async () => {
  const h = host('func foo() (int, ) {}');
  h.select(15);
  h.change(15, 1, '', undefined, true);
  await settle();
  assert.equal(h.document.getText(), 'func foo() int {}');
  assert.equal(h.editor.selection.active, 14);
  h.dispose();
});

test('late selection event cannot apply an edit after another document change', async () => {
  const h = host('func foo() (int, ) {}');
  h.select(16);
  h.change(15, 1, '', undefined, true);
  await settle();
  h.change(15, 0, 'x');
  h.select(15);
  await settle();
  assert.equal(h.document.getText(), 'func foo() (intx ) {}');
  assert.equal(h.editor.edits.length, 0);
  h.dispose();
});
