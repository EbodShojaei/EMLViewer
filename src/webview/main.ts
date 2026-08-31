import { announce, clear, el } from './dom.ts';
import { renderHeader } from './headers.ts';
import { renderAttachments } from './attachments.ts';
import { renderHtmlBody, attachFrameProtocol } from './bodyHtml.ts';
import { renderTextBody } from './bodyText.ts';
import {
  renderBlockedBanner,
  renderEmptyState,
  renderLoadedBanner,
  renderNoticeBanner,
} from './notices.ts';
import type { FromWebview, Notice, RenderPayload, ToWebview } from '../shared/types.ts';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};

const vscode = acquireVsCodeApi();
const bootstrap = (window as unknown as {
  __EML_BOOTSTRAP__?: { shimHash: string; allowRemote: boolean };
}).__EML_BOOTSTRAP__ ?? { shimHash: '', allowRemote: false };

const post = (m: FromWebview) => vscode.postMessage(m);

let payload: RenderPayload | undefined;
let detachFrame: (() => void) | undefined;
const runtimeNotices: Notice[] = [];

const root = document.getElementById('eml-root');

function onLink(href: string): void {
  // Every link — iframe body and plain text alike — goes through the host, which is the
  // single place the scheme policy lives.
  if (href) post({ type: 'openLink', href });
}

function render(): void {
  if (!root || !payload) return;
  const p = payload;

  detachFrame?.();
  detachFrame = undefined;
  clear(root);

  const chrome = el('div', { class: 'eml-chrome' });
  chrome.append(
    renderHeader(p, {
      onToggle: (expanded) => post({ type: 'setHeadersExpanded', expanded }),
      onCopy: (text, label) => {
        post({ type: 'copyText', text, label });
        announce(`Copied ${label}`);
      },
    }),
  );

  const blocking = p.notices.find((n) => n.blocking);
  for (const n of [...p.notices, ...runtimeNotices]) {
    if (n.blocking) continue;
    chrome.append(renderNoticeBanner(n, (id) => post({ type: 'noticeAction', id })));
  }

  const useHtml = p.body.mode === 'html' && p.body.available.html;

  // Build the body first: sanitizing produces the blocked-image counts the banner needs.
  let bodyNode: HTMLElement | null = null;
  let blockedBanner: HTMLElement | null = null;

  if (blocking) {
    bodyNode = renderEmptyState(blocking, (id) => post({ type: 'noticeAction', id }));
  } else if (useHtml) {
    const { frame, page, stats } = renderHtmlBody(
      p.body.html ?? '',
      p.inline,
      p.view.remoteImagesAllowed,
      bootstrap.shimHash,
    );
    bodyNode = page;

    post({ type: 'blockedImages', count: stats.blockedRemote });

    if (p.view.remoteImagesAllowed) {
      blockedBanner = renderLoadedBanner();
    } else {
      blockedBanner = renderBlockedBanner(stats.blockedRemote, stats.blockedPixels, () => {
        // The CSP is baked into the shell, so opting in requires a full document reload.
        // Send the scroll position so the host can restore it afterwards.
        announce('Loading remote images. The message will reload.');
        post({ type: 'setRemoteImages', value: true, scrollY: window.scrollY });
      });
    }

    detachFrame = attachFrameProtocol(frame, onLink, () => {
      if (p.view.restoreScrollY > 0) window.scrollTo(0, p.view.restoreScrollY);
    });
  } else if (p.body.available.text) {
    bodyNode = renderTextBody(
      p.body.text ?? '',
      { enabled: p.body.flowed?.enabled ?? false, delSp: p.body.flowed?.delSp ?? false, how: 'none' },
      p.view.collapseQuotedText,
    );
  } else {
    bodyNode = el('div', { class: 'eml-text' }, '');
  }

  if (blockedBanner) chrome.append(blockedBanner);

  const attachments = renderAttachments(p.attachments, useHtml, (index) =>
    post({ type: 'saveAttachment', index }),
  );
  if (attachments) chrome.append(attachments);

  root.append(chrome);

  // The tinted canvas exists to frame the white HTML page, the way a PDF viewer does.
  // Plain text renders natively in the editor's own colours with no page behind it, so
  // the canvas would be a large empty tint — and centring it leaves the text misaligned
  // with the header directly above. Each mode gets its own treatment.
  const bodySection = el('main', {
    class: `eml-body ${useHtml ? 'eml-body--html' : 'eml-body--text'}`,
    id: 'eml-body',
    'aria-labelledby': 'eml-body-h',
  });
  bodySection.append(el('h2', { class: 'eml-vh', id: 'eml-body-h' }, 'Message body'));
  if (bodyNode) bodySection.append(bodyNode);
  root.append(bodySection);

  // Plain-text links live in this document, so they need the same routing the shim gives
  // the iframe. One handler, delegated, rather than a listener per anchor.
  bodySection.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a');
    if (!a) return;
    e.preventDefault();
    onLink(a.getAttribute('href') ?? '');
  });
}

window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data as ToWebview & { __eml?: number };
  // Frame protocol messages are handled by attachFrameProtocol; ignore them here.
  if (!d || typeof d !== 'object' || (d as { __eml?: number }).__eml === 1) return;

  switch (d.type) {
    case 'render':
      payload = d.payload;
      runtimeNotices.length = 0;
      render();
      break;
    case 'patchBody':
      if (payload) {
        payload = { ...payload, body: d.body };
        render();
      }
      break;
    case 'notice':
      runtimeNotices.push(d.notice);
      render();
      break;
    case 'setHeadersExpanded':
      if (payload) {
        payload = { ...payload, view: { ...payload.view, headersExpanded: d.expanded } };
        render();
      }
      break;
    default:
      break;
  }
});

post({ type: 'ready' });
