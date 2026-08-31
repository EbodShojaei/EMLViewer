import * as vscode from 'vscode';
import { EmlEditorProvider } from './emlEditorProvider.ts';

export function activate(context: vscode.ExtensionContext): void {
  // No activationEvents entry is needed: VS Code synthesizes onCustomEditor:<viewType>
  // from the customEditors contribution (since 1.74).
  const { provider, disposable } = EmlEditorProvider.register(context);

  context.subscriptions.push(
    disposable,

    vscode.commands.registerCommand('emlView.loadRemoteImages', () => {
      provider.active?.loadRemoteImages();
    }),

    vscode.commands.registerCommand('emlView.showHtml', () => {
      provider.active?.setBodyMode('html');
    }),

    vscode.commands.registerCommand('emlView.showPlainText', () => {
      provider.active?.setBodyMode('text');
    }),

    vscode.commands.registerCommand('emlView.reopenAsText', async () => {
      const p = provider.active;
      if (!p) return;
      // 'default' is the magic view type for the built-in text editor.
      await vscode.commands.executeCommand('vscode.openWith', p.uri, 'default', p.viewColumn);
    }),

    vscode.commands.registerCommand('emlView.openWithPreview', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) return;
      await vscode.commands.executeCommand('vscode.openWith', target, EmlEditorProvider.viewType);
    }),
  );
}

export function deactivate(): void {
  /* everything is registered through context.subscriptions */
}
