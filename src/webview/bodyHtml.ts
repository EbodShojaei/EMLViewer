import { FRAME_SHIM, FRAME_RESET_CSS } from '../shared/frameShim.ts';
import type { InlineResources } from '../shared/types.ts';
import { sanitizeEmailHtml, type SanitizeResult } from './sanitize.ts';
import { el } from './dom.ts';

/**
 * The email body, isolated in a sandboxed iframe.
 *
 * sandbox="allow-scripts" WITHOUT allow-same-origin gives the frame an opaque origin: it
 * cannot reach this document, acquireVsCodeApi, or storage. The dangerous pairing is
 * allow-scripts + allow-same-origin together, which lets a frame remove its own sandbox.
 * Neither half of that is granted here.
 *
 * With allow-scripts on, it is the CSP that stops email script — the only inline script
 * whose bytes hash to SHIM_HASH may run. Everything else (injected <script>, remote src,
 * on* handlers, javascript: URLs, eval) is refused.
 */

export interface HtmlBodyResult {
  frame: HTMLIFrameElement;
  page: HTMLElement;
  stats: SanitizeResult;
}

/**
 * The srcdoc's own CSP.
 *
 * A srcdoc document inherits the parent policy per spec, and CSP composes by intersection
 * so a second policy can only tighten. This is deliberate redundancy: the entire
 * tracking-pixel guarantee rests on the inheritance behaviour, and that is worth not
 * betting on a single mechanism. 'self' and cspSource are omitted because they are
 * meaningless in an opaque origin.
 */
function innerCsp(allowRemote: boolean, shimHash: string): string {
  return [
    `default-src 'none'`,
    // Must stay in lockstep with the shell's img-src in webviewHtml.ts. These two are
    // the same policy expressed twice; if they disagree the toggle either shows broken
    // images or silently permits tracking while the UI claims otherwise.
    `img-src data:${allowRemote ? ' http: https:' : ''}`,
    `media-src 'none'`,
    `font-src data:`,
    `style-src 'unsafe-inline'`,
    `script-src 'sha256-${shimHash}'`,
    `frame-src 'none'`,
    `form-action 'none'`,
    `connect-src 'none'`,
  ].join('; ');
}

export function renderHtmlBody(
  rawHtml: string,
  inline: InlineResources,
  allowRemote: boolean,
  shimHash: string,
): HtmlBodyResult {
  const stats = sanitizeEmailHtml(rawHtml, inline, allowRemote);

  const srcdoc =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${innerCsp(allowRemote, shimHash)}">` +
    // The shim goes first so it captures window.parent.postMessage and installs the click
    // handler before any email markup is parsed. No trimming: the CSP hash covers this
    // element's exact text content.
    `<script>${FRAME_SHIM}</script>` +
    `<style>${FRAME_RESET_CSS}</style>` +
    // Author CSS goes after the reset so the sender's own layout wins, which is the whole
    // point of rendering their HTML. It is escaped and url()-rewritten in sanitize.ts.
    (stats.css ? `<style>${stats.css}</style>` : '') +
    '</head><body>' +
    stats.html +
    '</body></html>';

  const frame = el('iframe', {
    class: 'eml-frame',
    title: 'Message body',
    sandbox: 'allow-scripts',
    referrerpolicy: 'no-referrer',
    loading: 'eager',
  });
  // Assign as a property, not an attribute — no HTML escaping needed, and no size limit
  // beyond memory.
  frame.srcdoc = srcdoc;

  const page = el('div', { class: 'eml-page' }, frame);
  return { frame, page, stats };
}

/**
 * Height and link reporting from inside the frame.
 *
 * `e.source === frame.contentWindow` is the strong check — contentWindow stays readable
 * across an opaque origin even though contentDocument does not, and e.origin is literally
 * the string "null" for a sandboxed frame, so it discriminates nothing.
 */
export function attachFrameProtocol(
  frame: HTMLIFrameElement,
  onLink: (href: string, text: string) => void,
  onFirstHeight?: () => void,
): () => void {
  const MAX_H = 200000;
  let sawHeight = false;

  // If the shim never runs — a CSP hash mismatch would do it — the frame would collapse to
  // nothing and the body would appear empty. Fall back to a usable fixed height instead,
  // which degrades to "scrolls internally" rather than "blank".
  const fallback = window.setTimeout(() => {
    if (!sawHeight) {
      frame.classList.add('eml-frame--fallback');
      onFirstHeight?.();
    }
  }, 1200);

  const handler = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data as { __eml?: number; type?: string; height?: number; href?: string; text?: string };
    if (!d || d.__eml !== 1) return;

    if (d.type === 'height') {
      const h = Math.max(80, Math.min(Number(d.height) || 0, MAX_H));
      frame.style.height = `${h}px`;
      // At the clamp the frame keeps its own scrollbar rather than growing without bound.
      frame.style.overflow = h >= MAX_H ? 'auto' : 'hidden';
      if (!sawHeight) {
        sawHeight = true;
        window.clearTimeout(fallback);
        onFirstHeight?.();
      }
    } else if (d.type === 'link') {
      onLink(String(d.href ?? ''), String(d.text ?? ''));
    }
  };

  window.addEventListener('message', handler);
  return () => {
    window.clearTimeout(fallback);
    window.removeEventListener('message', handler);
  };
}
