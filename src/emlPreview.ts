import * as vscode from 'vscode';
import { Disposable } from './util/dispose.ts';
import { EmlDocument } from './emlDocument.ts';
import { buildShellHtml } from './webviewHtml.ts';
import { saveAttachment } from './attachments.ts';
import type { BodyMode, FromWebview, ToWebview } from './shared/types.ts';

/**
 * One per webview panel. Owns all mutable view state.
 *
 * The remote-images flag lives here rather than in the webview because it must agree with
 * the CSP baked into the currently-loaded shell. Out of sync one way you get broken image
 * icons; out of sync the other way the CSP silently permits tracking while the UI claims
 * it is blocked. Shipping the flag inside the render payload guarantees they match.
 */
export class EmlPreview extends Disposable {
  private state: {
    remoteImages: boolean;
    bodyMode: BodyMode;
    headersExpanded: boolean;
    restoreScrollY: number;
  };

  private ready = false;
  private blockedImages = 0;

  private readonly _onDidChangeState = this._register(new vscode.EventEmitter<void>());
  public readonly onDidChangeState = this._onDidChangeState.event;

  private readonly document: EmlDocument;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;

  constructor(
    document: EmlDocument,
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    initialRemoteImages: boolean,
  ) {
    super();
    this.document = document;
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.state = {
      remoteImages: initialRemoteImages,
      bodyMode: document.payload.body.mode,
      headersExpanded: false,
      restoreScrollY: 0,
    };

    this.panel.webview.options = {
      enableScripts: true,
      enableForms: false,
      // The default is EVERY workspace folder, which is a documented exfiltration vector.
      // The webview needs nothing but its own bundle.
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    // Wire the listener BEFORE assigning .html, or the webview's first 'ready' can race it.
    this._register(this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m)));

    this._register(
      this.document.onDidChangeContent(() => {
        this.state.bodyMode = this.pickMode(this.state.bodyMode);
        this.post({ type: 'render', payload: this.renderPayload() });
        this._onDidChangeState.fire();
      }),
    );

    this._register(
      this.document.onDidDeleteFile(() => {
        // Keep the tab and its rendered content. Closing an editor out from under someone
        // because a file moved is worse than showing a stale render with a banner.
        this.post({
          type: 'notice',
          notice: {
            kind: 'file-deleted',
            severity: 'warning',
            title: 'This file no longer exists on disk',
            detail: 'The message shown here is the last version that was read.',
          },
        });
      }),
    );

    this.renderShell();
  }

  public get uri(): vscode.Uri {
    return this.document.uri;
  }
  public get viewColumn(): vscode.ViewColumn | undefined {
    return this.panel.viewColumn;
  }
  public get bodyMode(): BodyMode {
    return this.state.bodyMode;
  }
  public get canToggleBody(): boolean {
    const a = this.document.payload.body.available;
    return a.html && a.text;
  }
  public get hasBlockedImages(): boolean {
    return this.blockedImages > 0 && !this.state.remoteImages;
  }
  public get hasAttachments(): boolean {
    return this.document.payload.attachments.some((a) => !a.isInline);
  }

  // ------------------------------------------------------------------ commands

  public loadRemoteImages(): void {
    if (this.state.remoteImages) return;
    this.state.remoteImages = true;
    this.renderShell();
    this._onDidChangeState.fire();
  }

  public setBodyMode(mode: BodyMode): void {
    const available = this.document.payload.body.available;
    if (mode === 'html' && !available.html) return;
    if (mode === 'text' && !available.text) return;
    if (this.state.bodyMode === mode) return;

    this.state.bodyMode = mode;
    // No CSP change, so patch the live document rather than reloading it — that keeps
    // scroll position and avoids a visible flash.
    this.post({ type: 'patchBody', body: { ...this.document.payload.body, mode } });
    this._onDidChangeState.fire();
  }

  // ------------------------------------------------------------------ internals

  private pickMode(preferred: BodyMode): BodyMode {
    const a = this.document.payload.body.available;
    if (preferred === 'html' && a.html) return 'html';
    if (preferred === 'text' && a.text) return 'text';
    return a.html ? 'html' : 'text';
  }

  private renderShell(): void {
    this.ready = false;
    this.blockedImages = 0;
    // Assigning .html tears down and reloads the webview document, which is exactly what a
    // CSP change requires. The webview replies 'ready' and we send the payload then.
    this.panel.webview.html = buildShellHtml({
      webview: this.panel.webview,
      extensionUri: this.extensionUri,
      allowRemote: this.state.remoteImages,
    });
  }

  private renderPayload() {
    const base = this.document.payload;
    return {
      ...base,
      body: { ...base.body, mode: this.pickMode(this.state.bodyMode) },
      view: {
        ...base.view,
        remoteImagesAllowed: this.state.remoteImages,
        headersExpanded: this.state.headersExpanded,
        restoreScrollY: this.state.restoreScrollY,
      },
    };
  }

  private post(msg: ToWebview): void {
    if (this.isDisposed) return;
    void this.panel.webview.postMessage(msg);
  }

  /**
   * Every field here is hostile until proven otherwise — the webview just parsed an
   * attacker's HTML, so it is the lower-trust side of this boundary.
   */
  private async onMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as FromWebview;

    switch (msg.type) {
      case 'ready': {
        this.ready = true;
        this.post({ type: 'render', payload: this.renderPayload() });
        return;
      }

      case 'blockedImages': {
        const n = Number(msg.count);
        this.blockedImages = Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 0;
        this._onDidChangeState.fire();
        return;
      }

      case 'setRemoteImages': {
        if (msg.value !== true) return;
        const y = Number(msg.scrollY);
        this.state.restoreScrollY = Number.isFinite(y) && y > 0 ? Math.min(y, 5_000_000) : 0;
        this.loadRemoteImages();
        return;
      }

      case 'setBodyMode': {
        if (msg.mode === 'html' || msg.mode === 'text') this.setBodyMode(msg.mode);
        return;
      }

      case 'setHeadersExpanded': {
        this.state.headersExpanded = msg.expanded === true;
        return;
      }

      case 'openLink': {
        await this.openLink(String(msg.href ?? ''));
        return;
      }

      case 'saveAttachment': {
        const i = Number(msg.index);
        if (!Number.isInteger(i)) return;
        const meta = this.document.payload.attachments.find((a) => a.index === i);
        const bytes = this.document.attachmentBytes(i);
        if (!meta || !bytes) return;
        await saveAttachment(meta, bytes);
        return;
      }

      case 'copyText': {
        const text = String(msg.text ?? '').slice(0, 1_000_000);
        if (!text) return;
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage(
          `Copied ${String(msg.label ?? 'text')}`,
          2000,
        );
        return;
      }

      case 'noticeAction': {
        if (msg.id === 'reopenAsText') {
          await vscode.commands.executeCommand(
            'vscode.openWith',
            this.document.uri,
            'default',
            this.panel.viewColumn,
          );
        } else if (msg.id === 'openAnyway') {
          await this.document.renderAnyway();
        } else if (msg.id === 'reload') {
          await this.document.reload();
          this.post({ type: 'render', payload: this.renderPayload() });
        } else if (msg.id === 'showText') {
          this.setBodyMode('text');
        }
        return;
      }

      default:
        return;
    }
  }

  /** Single link policy for both the iframe body and the plain-text renderer. */
  private async openLink(href: string): Promise<void> {
    if (!href) return;
    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(href, true);
    } catch {
      return;
    }
    const scheme = parsed.scheme.toLowerCase();
    // Anything else — file:, vscode:, javascript:, vbscript: — is refused outright.
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') return;
    await vscode.env.openExternal(parsed);
  }

  public isReady(): boolean {
    return this.ready;
  }
}
