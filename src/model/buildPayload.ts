import type {
  AttachmentKind,
  AttachmentVm,
  BodyMode,
  Notice,
  RenderPayload,
  ViewState,
} from '../shared/types.ts';
import { toVm, toDateVm } from './addresses.ts';
import { buildInlineResources, isReferencedInHtml, type InlineCandidate } from './inline.ts';
import { detectNotices, inlineBudgetNotice } from './notices.ts';
import { detectFlowed } from './flowed.ts';
import { extFromMime, safeFileName } from './safeName.ts';

/**
 * Email -> RenderPayload. Pure: no `vscode`, no filesystem, no binaries in the output.
 *
 * Attachment bytes stay with the caller and are addressed by index. Only inline images
 * are converted (to data: URIs), so what crosses the webview boundary is plain JSON.
 */

/** The shape we consume from postal-mime. Declared structurally so the model stays pure. */
export interface ParsedAttachment {
  filename?: string | null;
  mimeType: string;
  disposition: 'attachment' | 'inline' | null;
  related?: boolean;
  contentId?: string;
  method?: string;
  rfc822DepthExceeded?: boolean;
  content: ArrayBuffer | Uint8Array | string;
}

export interface ParsedEmail {
  headers?: { key: string; value: string }[];
  headerLines?: { key: string; line: string }[];
  from?: unknown;
  sender?: unknown;
  replyTo?: unknown;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: string;
  messageId?: string;
  date?: string;
  html?: string;
  text?: string;
  attachments: ParsedAttachment[];
}

export interface BuildOptions {
  fileName: string;
  fileSize: number;
  defaultView: BodyMode;
  inlineBudgetBytes: number;
  collapseQuotedText: boolean;
  formatFlowed: 'auto' | 'on' | 'off';
  view: Omit<ViewState, 'collapseQuotedText'>;
  /** Notices produced before parsing (oversize, file-changed) that should survive. */
  extraNotices?: Notice[];
}

export interface BuildResult {
  payload: RenderPayload;
  /** Decoded attachment bytes, index-aligned with payload.attachments. */
  bytes: Uint8Array[];
}

function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  // attachmentEncoding is 'arraybuffer', so a string here means text/calendar or similar.
  return new TextEncoder().encode(String(content));
}

function classify(mimeType: string, filename: string | null | undefined): AttachmentKind {
  const m = (mimeType || '').toLowerCase();
  if (m === 'message/rfc822') return 'message';
  if (m === 'text/calendar') return 'calendar';
  if (m.startsWith('image/')) return 'image';
  if (m.includes('pkcs7-signature') || m.includes('pgp-signature')) return 'signature';
  if (m.includes('pkcs7-mime') || m === 'application/pgp-encrypted') return 'encrypted';
  if (m === 'application/ms-tnef' || m === 'application/vnd.ms-tnef') return 'tnef';
  if ((filename ?? '').toLowerCase() === 'winmail.dat') return 'tnef';
  return 'file';
}

function headerLine(email: ParsedEmail, key: string): string {
  const hit = email.headerLines?.find((h) => h.key === key);
  if (hit) return hit.line;
  const h = email.headers?.find((x) => x.key === key);
  return h ? `${key}: ${h.value}` : '';
}

export function buildPayload(email: ParsedEmail, opts: BuildOptions): BuildResult {
  const attachments = email.attachments ?? [];
  const bytes = attachments.map((a) => toBytes(a.content));

  const candidates: InlineCandidate[] = attachments.map((a, i) => ({
    contentId: a.contentId,
    filename: a.filename,
    mimeType: a.mimeType,
    disposition: a.disposition,
    related: a.related,
    content: bytes[i],
  }));

  const { resources, oversizeIndices } = buildInlineResources(candidates, opts.inlineBudgetBytes);

  const html = email.html ?? '';
  const text = email.text ?? '';
  const hasHtml = html.trim().length > 0;
  const hasText = text.trim().length > 0;

  const attachmentVms: AttachmentVm[] = attachments.map((a, i) => {
    const kind = classify(a.mimeType, a.filename);
    // Two separate questions. Eligibility (security) was decided in buildInlineResources;
    // this is only "is it already visible in the body, so should it be tucked away".
    const eligible = a.related === true || a.disposition === 'inline';
    const isInline =
      hasHtml &&
      eligible &&
      !oversizeIndices.has(i) &&
      isReferencedInHtml(html, a.contentId, a.filename);

    return {
      index: i,
      filename: safeFileName(a.filename, extFromMime(a.mimeType), i),
      mimeType: a.mimeType,
      size: bytes[i].byteLength,
      disposition: a.disposition,
      kind,
      isInline,
    };
  });

  const contentTypeLine = headerLine(email, 'content-type');
  const isMultipart = /^\s*content-type:\s*multipart\//i.test(contentTypeLine);

  const notices: Notice[] = [
    ...(opts.extraNotices ?? []),
    ...detectNotices({
      hasHtml,
      hasText,
      attachments: attachments.map((a) => ({
        mimeType: a.mimeType,
        filename: a.filename,
        rfc822DepthExceeded: a.rfc822DepthExceeded,
      })),
      contentTypeLine,
      textHead: text.slice(0, 400),
    }),
  ];
  if (resources.droppedForBudget > 0) {
    notices.push(inlineBudgetNotice(resources.droppedForBudget));
  }

  const flowed = hasText
    ? detectFlowed(contentTypeLine, isMultipart, text, opts.formatFlowed)
    : { enabled: false, delSp: false, how: 'none' as const };

  // Honour the preference, but never show an empty pane because the preferred part is absent.
  const mode: BodyMode =
    opts.defaultView === 'text' ? (hasText ? 'text' : 'html') : hasHtml ? 'html' : 'text';

  const dateRaw = headerLine(email, 'date').replace(/^date:\s*/i, '');

  const payload: RenderPayload = {
    fileName: opts.fileName,
    fileSize: opts.fileSize,
    subject: (email.subject ?? '').trim(),
    from: toVm(email.from as never),
    sender: toVm(email.sender as never),
    replyTo: toVm(email.replyTo as never),
    to: toVm(email.to as never),
    cc: toVm(email.cc as never),
    bcc: toVm(email.bcc as never),
    date: toDateVm(email.date, dateRaw || undefined),
    messageId: email.messageId,
    body: {
      available: { html: hasHtml, text: hasText },
      mode,
      html: hasHtml ? html : undefined,
      text: hasText ? text : undefined,
      flowed: { enabled: flowed.enabled, delSp: flowed.delSp },
    },
    attachments: attachmentVms,
    inline: resources,
    notices,
    view: { ...opts.view, collapseQuotedText: opts.collapseQuotedText },
  };

  return { payload, bytes };
}
