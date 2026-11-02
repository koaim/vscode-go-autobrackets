import * as vscode from 'vscode';
import { transform } from './transform';

export interface DocumentChangeState {
  snapshots: Map<string, string>;
  pending: Map<string, { timer: ReturnType<typeof setTimeout>; apply: () => void }>;
  applying: Set<string>;
  cancelPending: (key: string) => void;
  remember: (document: vscode.TextDocument) => void;
}

export function onDidChangeTextDocument(
  event: vscode.TextDocumentChangeEvent,
  state: DocumentChangeState
): void {
  const { snapshots, pending, applying, cancelPending, remember } = state;

  const document = event.document;

  if (document.languageId !== 'go') {
    return;
  }

  const key = document.uri.toString();
  const before = snapshots.get(key);
  remember(document);

  if (!event.contentChanges.length) {
    return;
  }

  cancelPending(key);

  const editor = vscode.window.activeTextEditor;

  if (applying.has(key) || before === undefined || event.reason !== undefined ||
    event.contentChanges.length !== 1 || editor?.document !== document || editor.selections.length !== 1 ||
    !vscode.workspace.getConfiguration('goAutobrackets', document.uri).get<boolean>('enabled', true)) {
    return;
  }

  const change = event.contentChanges[0];
  const edit = transform(before, change);

  if (!edit) {
    return;
  }

  const version = document.version;

  // Document changes can arrive before selection changes. A timer alone does
  // not guarantee the caret is current; retry when VS Code delivers it.
  const apply = () => {
    if (document.isClosed || document.version !== version || vscode.window.activeTextEditor !== editor) {
      cancelPending(key);
      return;
    }

    if (editor.selections.length !== 1 || !editor.selection.isEmpty ||
      document.offsetAt(editor.selection.active) !== change.rangeOffset + change.text.length) {
      return;
    }

    cancelPending(key);
    applying.add(key);

    void editor.edit(builder => {
      builder.replace(new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.text);
    }, { undoStopBefore: false, undoStopAfter: true }).then(applied => {
      if (applied && document.version === version + 1 && vscode.window.activeTextEditor === editor) {
        const caret = document.positionAt(edit.cursor);
        editor.selection = new vscode.Selection(caret, caret);
      }

      applying.delete(key);
    }, error => {
      applying.delete(key);
      console.error('Go Auto Brackets: could not apply edit', error);
    });
  };

  pending.set(key, { timer: setTimeout(apply, 0), apply });
}
