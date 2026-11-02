import * as vscode from 'vscode';
import { DocumentChangeState, onDidChangeTextDocument } from './onDidChangeTextDocument';

export function activate(context: vscode.ExtensionContext): void {
  const snapshots = new Map<string, string>();
  const pending: DocumentChangeState['pending'] = new Map();
  const cancelPending = (key: string) => {
    clearTimeout(pending.get(key)?.timer);
    pending.delete(key);
  };
  const applying = new Set<string>();
  const remember = (document: vscode.TextDocument) => {
    if (document.languageId === 'go') {
      snapshots.set(document.uri.toString(), document.getText());
    }
  };
  const state: DocumentChangeState = { snapshots, pending, applying, cancelPending, remember };

  vscode.workspace.textDocuments.forEach(remember);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(remember),
    vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString();
      snapshots.delete(key);
      cancelPending(key);
    }),
    vscode.window.onDidChangeTextEditorSelection(event => {
      pending.get(event.textEditor.document.uri.toString())?.apply();
    }),
    vscode.workspace.onDidChangeTextDocument(event => onDidChangeTextDocument(event, state)),
    {
      dispose: () => {
        pending.forEach(entry => clearTimeout(entry.timer));
        pending.clear();
        snapshots.clear();
      }
    }
  );
}
