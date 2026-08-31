import * as vscode from 'vscode';
import PostalMime from 'postal-mime';
import { Disposable } from './util/dispose.ts';
import { buildPayload, type ParsedEmail } from './model/buildPayload.ts';
import { oversizeNotice, parseFailedNotice } from './model/notices.ts';
import type { BodyMode, Notice, RenderPayload } from './shared/types.ts';

/**
 * One per resource. VS Code calls openCustomDocument once per file and reuses the
 * document for every editor showing it, so parsing happens here exactly once.
 *
 * All MUTABLE VIEW STATE belongs on EmlPreview, not here.
 */

export interface DocumentConfig {
  defaultView: BodyMode;
  inlineBudgetBytes: number;
  collapseQuotedText: boolean;
  formatFlowed: 'auto' | 'on' | 'off';
  maxFileSizeBytes: number;
}

export class EmlDocument extends Disposable implements vscode.CustomDocument {
  private _payload: RenderPayload;
  private _bytes: Uint8Array[] = [];
  /** Set by the "Render Anyway" action so the size gate is bypassed on reload. */
  private _sizeOverride = false;

  private readonly _onDidChangeContent = this._register(new vscode.EventEmitter<void>());
  public readonly onDidChangeContent = this._onDidChangeContent.event;

  private readonly _onDidDeleteFile = this._register(new vscode.EventEmitter<void>());
  public readonly onDidDeleteFile = this._onDidDeleteFile.event;

  static async create(
    uri: vscode.Uri,
    config: DocumentConfig,
    watch: boolean,
  ): Promise<EmlDocument> {
    const doc = new EmlDocument(uri, config);
    await doc.reload();
    if (watch) doc.startWatching();
    return doc;
  }

  // Fields are declared and assigned explicitly rather than via TypeScript parameter
  // properties, so every file in src/ loads under `node --test` type stripping.
  public readonly uri: vscode.Uri;
  private config: DocumentConfig;

  private constructor(uri: vscode.Uri, config: DocumentConfig) {
    super();
    this.uri = uri;
    this.config = config;
    this._payload = emptyPayload(basename(uri));
  }

  public get payload(): RenderPayload {
    return this._payload;
  }

  public attachmentBytes(index: number): Uint8Array | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this._bytes.length) return undefined;
    return this._bytes[index];
  }

  public async renderAnyway(): Promise<void> {
    this._sizeOverride = true;
    await this.reload();
    this._onDidChangeContent.fire();
  }

  public updateConfig(config: DocumentConfig): void {
    this.config = config;
  }

  /**
   * Read bytes and parse.
   *
   * The critical line is `workspace.fs.readFile` -> Uint8Array -> parse(bytes). Going
   * through TextDocument.getText() would decode the file as UTF-8 before the parser can
   * read the charset parameter, mojibaking every ISO-8859-1 / GB2312 / Shift_JIS message.
   * That bug is the reason this is a CustomReadonlyEditorProvider.
   */
  public async reload(): Promise<void> {
    const fileName = basename(this.uri);
    const extraNotices: Notice[] = [];
    let size = 0;

    try {
      const stat = await vscode.workspace.fs.stat(this.uri);
      size = stat.size;
    } catch {
      // A missing file is reported by the watcher; fall through with size 0.
    }

    // Gate BEFORE reading. Reading a 2 GB file to then refuse it helps no one.
    if (!this._sizeOverride && size > this.config.maxFileSizeBytes) {
      this._bytes = [];
      this._payload = {
        ...emptyPayload(fileName),
        fileSize: size,
        notices: [oversizeNotice(size, Math.round(this.config.maxFileSizeBytes / (1024 * 1024)))],
      };
      return;
    }

    let raw: Uint8Array;
    try {
      raw = await vscode.workspace.fs.readFile(this.uri);
    } catch (err) {
      this._bytes = [];
      this._payload = {
        ...emptyPayload(fileName),
        fileSize: size,
        notices: [parseFailedNotice(errorText(err))],
      };
      return;
    }

    let email: ParsedEmail;
    try {
      email = (await PostalMime.parse(raw, {
        attachmentEncoding: 'arraybuffer',
        // Default false INLINES a forwarded message's body into the parent with no visual
        // boundary. For a viewer that is silent corruption, not a convenience.
        rfc822Attachments: true,
        // The library defaults (2 MB / 256 / 10) are far too generous for attacker-controlled input.
        maxHeadersSize: 256 * 1024,
        maxNestingDepth: 32,
        maxRfc822NestingDepth: 5,
      })) as unknown as ParsedEmail;
    } catch (err) {
      // Never let this throw out of openCustomDocument — VS Code would show its own
      // generic error and the recovery affordance would be lost. Salvage the headers.
      this._bytes = [];
      this._payload = {
        ...emptyPayload(fileName),
        fileSize: size,
        ...salvageHeaders(raw),
        notices: [parseFailedNotice(errorText(err)), ...extraNotices],
      };
      return;
    }

    const { payload, bytes } = buildPayload(email, {
      fileName,
      fileSize: size,
      defaultView: this.config.defaultView,
      inlineBudgetBytes: this.config.inlineBudgetBytes,
      collapseQuotedText: this.config.collapseQuotedText,
      formatFlowed: this.config.formatFlowed,
      view: { remoteImagesAllowed: false, headersExpanded: false, restoreScrollY: 0 },
      extraNotices,
    });

    this._payload = payload;
    this._bytes = bytes;
  }

  private startWatching(): void {
    // A pattern-based watcher on the containing directory; the file itself may not exist yet
    // when the pattern is registered, and RelativePattern handles files outside the workspace.
    const dir = vscode.Uri.joinPath(this.uri, '..');
    const watcher = this._register(
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(dir, basename(this.uri)),
      ),
    );

    let timer: NodeJS.Timeout | undefined;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      // Editors write in two steps often enough that an immediate re-read catches a
      // truncated file. 150 ms is comfortably past that without feeling laggy.
      timer = setTimeout(async () => {
        if (this.isDisposed) return;
        await this.reload();
        this._onDidChangeContent.fire();
      }, 150);
    };

    this._register(watcher.onDidChange(debounced));
    this._register(watcher.onDidCreate(debounced));
    this._register(watcher.onDidDelete(() => this._onDidDeleteFile.fire()));
    this._register(new vscode.Disposable(() => timer && clearTimeout(timer)));
  }

  public override dispose(): void {
    // Release attachment buffers explicitly: retainContextWhenHidden keeps panels alive,
    // and these are the only large allocations the extension holds.
    this._bytes = [];
    super.dispose();
  }
}

function basename(uri: vscode.Uri): string {
  return uri.path.split('/').pop() || uri.path;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function emptyPayload(fileName: string): RenderPayload {
  return {
    fileName,
    fileSize: 0,
    subject: '',
    from: [],
    sender: [],
    replyTo: [],
    to: [],
    cc: [],
    bcc: [],
    date: null,
    body: { available: { html: false, text: false }, mode: 'text' },
    attachments: [],
    inline: { byCid: {}, byName: {}, droppedForBudget: 0 },
    notices: [],
    view: {
      remoteImagesAllowed: false,
      headersExpanded: false,
      collapseQuotedText: true,
      restoreScrollY: 0,
    },
  };
}

/**
 * When the MIME parser gives up, a dumb header scan still produces something useful.
 * Partial output beats a red box.
 */
function salvageHeaders(raw: Uint8Array): Partial<RenderPayload> {
  try {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(raw.subarray(0, 16 * 1024));
    const block = head.split(/\r?\n\r?\n/)[0] ?? '';
    const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
    const get = (name: string): string => {
      const re = new RegExp('^' + name + ':[ \\t]*(.*)$', 'im');
      return re.exec(unfolded)?.[1]?.trim() ?? '';
    };
    const addr = (v: string) =>
      v
        ? [{ name: v, address: '', raw: v }]
        : [];

    return {
      subject: get('subject'),
      from: addr(get('from')),
      to: addr(get('to')),
      date: get('date') ? { iso: null, raw: get('date') } : null,
    };
  } catch {
    return {};
  }
}
