import * as vscode from 'vscode';
import { EmlDocument, type DocumentConfig } from './emlDocument.ts';
import { EmlPreview } from './emlPreview.ts';
import type { BodyMode } from './shared/types.ts';

export function readConfig(scope?: vscode.Uri): DocumentConfig & { remoteAllowed: boolean } {
  const c = vscode.workspace.getConfiguration('emlView', scope ?? null);
  return {
    defaultView: c.get<BodyMode>('body.defaultView', 'html'),
    inlineBudgetBytes: Math.max(0, c.get<number>('images.maxInlineTotalMB', 16)) * 1024 * 1024,
    collapseQuotedText: c.get<boolean>('body.collapseQuotedText', true),
    formatFlowed: c.get<'auto' | 'on' | 'off'>('body.formatFlowed', 'auto'),
    maxFileSizeBytes: Math.max(1, c.get<number>('maxFileSizeMB', 25)) * 1024 * 1024,
    remoteAllowed: c.get<string>('images.remotePolicy', 'block') === 'allow',
  };
}

export class EmlEditorProvider implements vscode.CustomReadonlyEditorProvider<EmlDocument> {
  public static readonly viewType = 'emlView.preview';

  private readonly previews = new Set<EmlPreview>();
  private activePreview: EmlPreview | undefined;

  public static register(context: vscode.ExtensionContext): {
    provider: EmlEditorProvider;
    disposable: vscode.Disposable;
  } {
    const provider = new EmlEditorProvider(context);
    const disposable = vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(EmlEditorProvider.viewType, provider, {
        webviewOptions: {
          // Required, not merely nice: the body iframe's scroll position is unreadable from
          // the parent (opaque origin), so it cannot be restored after a teardown. Emails
          // are small; retaining is the cheaper trade.
          retainContextWhenHidden: true,
          enableFindWidget: false,
        },
        supportsMultipleEditorsPerDocument: false,
      }),
      provider,
    );
    return { provider, disposable };
  }

  private readonly context: vscode.ExtensionContext;

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  public get active(): EmlPreview | undefined {
    return this.activePreview;
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<EmlDocument> {
    const cfg = readConfig(uri);
    const watch = vscode.workspace.getConfiguration('emlView', uri).get<boolean>(
      'reloadOnChange',
      true,
    );
    // EmlDocument.create never throws for a bad file — it converts failures into notices so
    // the recovery UI survives. Letting an exception escape here shows VS Code's own error
    // page instead, with no way back.
    return EmlDocument.create(uri, cfg, watch);
  }

  async resolveCustomEditor(
    document: EmlDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const cfg = readConfig(document.uri);
    const preview = new EmlPreview(document, panel, this.context.extensionUri, cfg.remoteAllowed);
    this.previews.add(preview);

    const sync = () => {
      if (panel.active) {
        this.activePreview = preview;
        void this.syncContextKeys(preview);
      }
    };
    sync();

    panel.onDidChangeViewState(sync);
    preview.onDidChangeState(() => {
      if (this.activePreview === preview) void this.syncContextKeys(preview);
    });

    panel.onDidDispose(() => {
      this.previews.delete(preview);
      if (this.activePreview === preview) {
        this.activePreview = undefined;
        void this.clearContextKeys();
      }
      preview.dispose();
    });
  }

  /** Drives which title-bar icons appear, so they are absent for emails that don't need them. */
  private async syncContextKeys(p: EmlPreview): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand('setContext', 'emlView.hasBlockedImages', p.hasBlockedImages),
      vscode.commands.executeCommand('setContext', 'emlView.hasAttachments', p.hasAttachments),
      vscode.commands.executeCommand('setContext', 'emlView.canToggleBody', p.canToggleBody),
      vscode.commands.executeCommand('setContext', 'emlView.bodyMode', p.bodyMode),
    ]);
  }

  private async clearContextKeys(): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand('setContext', 'emlView.hasBlockedImages', false),
      vscode.commands.executeCommand('setContext', 'emlView.hasAttachments', false),
      vscode.commands.executeCommand('setContext', 'emlView.canToggleBody', false),
      vscode.commands.executeCommand('setContext', 'emlView.bodyMode', undefined),
    ]);
  }

  public dispose(): void {
    for (const p of this.previews) p.dispose();
    this.previews.clear();
  }
}
