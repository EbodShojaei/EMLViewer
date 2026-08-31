/**
 * Everything that crosses the extension-host <-> webview boundary.
 *
 * Imported by both bundles. Must not import `vscode` (the webview bundle would break)
 * and must not import anything Node-only.
 *
 * Design rule: no binary crosses the boundary. Attachments stay host-side and are
 * addressed by index; inline images are converted to `data:` URI strings before
 * the payload is sent. That keeps postMessage carrying plain JSON.
 */

export type BodyMode = 'html' | 'text';

/**
 * A single rendered address. RFC 5322 group syntax (`To: Team: a@x, b@y;`) collapses
 * into `isGroup` + `members` rather than being flattened, because the grouping is
 * information the sender chose to include.
 */
export interface AddressVm {
  /** Display name, or the bare address when there is no display name. */
  name: string;
  /** The address itself. Empty string for a group header. */
  address: string;
  /** `Name <addr@host>` — what a "copy" action should yield. */
  raw: string;
  isGroup?: boolean;
  members?: AddressVm[];
}

export interface DateVm {
  /** ISO 8601 when the Date header parsed, otherwise null. */
  iso: string | null;
  /** The original Date header text, always shown on hover. */
  raw: string;
}

export type AttachmentKind =
  | 'file'
  | 'image'
  | 'message'
  | 'calendar'
  | 'signature'
  | 'tnef'
  | 'encrypted';

export interface AttachmentVm {
  /** Stable index into the host-side attachment array. The only handle the webview gets. */
  index: number;
  /** Already run through safeFileName(). Never display the raw name — U+202E spoofs extensions. */
  filename: string;
  mimeType: string;
  size: number;
  disposition: 'attachment' | 'inline' | null;
  kind: AttachmentKind;
  /** True when this part is rendered inside the body, so it belongs under a disclosure. */
  isInline: boolean;
}

export type NoticeKind =
  | 'parse-failed'
  | 'empty-body'
  | 'missing-boundary'
  | 'oversize'
  | 'smime-encrypted'
  | 'smime-signed'
  | 'pgp-encrypted'
  | 'tnef'
  | 'nesting-truncated'
  | 'inline-budget-exceeded'
  | 'file-changed'
  | 'file-deleted';

export type NoticeActionId = 'reopenAsText' | 'openAnyway' | 'reload' | 'showText';

export interface Notice {
  kind: NoticeKind;
  severity: 'info' | 'warning' | 'error';
  title: string;
  detail?: string;
  /** Rendered as a full-pane empty state rather than a banner strip. */
  blocking?: boolean;
  actions?: { id: NoticeActionId; label: string }[];
}

export interface InlineResources {
  /** normalized cid (lowercased, no angle brackets, percent-decoded) -> data: URI */
  byCid: Record<string, string>;
  /** lowercased basename -> data: URI. Outlook emits <img src="image001.png"> with no cid:. */
  byName: Record<string, string>;
  /** Parts skipped because the total data: URI budget was exhausted. */
  droppedForBudget: number;
}

export interface BodyVm {
  available: { html: boolean; text: boolean };
  mode: BodyMode;
  /** RAW, UNSANITIZED email HTML. The webview sanitizes it. Never innerHTML this in the parent. */
  html?: string;
  text?: string;
  flowed?: { enabled: boolean; delSp: boolean };
}

export interface ViewState {
  /** Must match the CSP baked into the currently-loaded shell. */
  remoteImagesAllowed: boolean;
  headersExpanded: boolean;
  collapseQuotedText: boolean;
  restoreScrollY: number;
}

export interface RenderPayload {
  fileName: string;
  fileSize: number;
  subject: string;
  from: AddressVm[];
  sender: AddressVm[];
  replyTo: AddressVm[];
  to: AddressVm[];
  cc: AddressVm[];
  bcc: AddressVm[];
  date: DateVm | null;
  messageId?: string;
  body: BodyVm;
  attachments: AttachmentVm[];
  inline: InlineResources;
  notices: Notice[];
  view: ViewState;
}

// ---------------------------------------------------------------- host -> webview

export type ToWebview =
  | { type: 'render'; payload: RenderPayload }
  | { type: 'patchBody'; body: BodyVm }
  | { type: 'notice'; notice: Notice }
  | { type: 'setHeadersExpanded'; expanded: boolean };

// ---------------------------------------------------------------- webview -> host

export type FromWebview =
  | { type: 'ready' }
  | { type: 'openLink'; href: string; text?: string }
  | { type: 'setBodyMode'; mode: BodyMode }
  | { type: 'setRemoteImages'; value: boolean; scrollY: number }
  | { type: 'setHeadersExpanded'; expanded: boolean }
  | { type: 'saveAttachment'; index: number }
  | { type: 'copyText'; text: string; label?: string }
  | { type: 'noticeAction'; id: NoticeActionId }
  | { type: 'blockedImages'; count: number };
