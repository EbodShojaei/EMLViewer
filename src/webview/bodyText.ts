import { el, frag } from './dom.ts';
import {
  IMPLICIT_QUOTE_SEPARATOR,
  splitSignature,
  toBlocks,
  toLines,
  trailingQuoteStart,
  type FlowedInfo,
  type TextBlock,
} from '../model/flowed.ts';

/**
 * Plain-text bodies render in the PARENT document, not the iframe.
 *
 * This is built entirely from createTextNode/createElement, so there is no injection
 * surface for the iframe to protect against — and in exchange the text inherits VS Code
 * theming, native selection, working find, and the parent's link handler. A plain-text
 * email in a dark theme should be dark, not a blazing white iframe.
 */

const URL_RE =
  /\b(?:https?:\/\/|www\.)[^\s<>()[\]{}"'`]+|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const TRAILING_PUNCT = /[.,;:!?'"]+$/;

/** Trim trailing punctuation, but keep a closing paren when the parens actually balance. */
function trimUrl(s: string): string {
  let out = s.replace(TRAILING_PUNCT, '');
  while (out.endsWith(')')) {
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    out = out.slice(0, -1).replace(TRAILING_PUNCT, '');
  }
  return out;
}

function linkify(text: string): DocumentFragment {
  const f = document.createDocumentFragment();
  let last = 0;

  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const matched = trimUrl(m[0]);
    if (!matched) continue;

    if (start > last) f.append(document.createTextNode(text.slice(last, start)));

    const isMail = matched.includes('@') && !/^https?:/i.test(matched);
    const href = isMail
      ? `mailto:${matched}`
      : /^www\./i.test(matched)
        ? `https://${matched}`
        : matched;

    // Built as a real element with a text child — never innerHTML.
    const a = el('a', { href, title: href, class: 'eml-link' }, matched);
    f.append(a);
    last = start + matched.length;
  }

  if (last < text.length) f.append(document.createTextNode(text.slice(last)));
  return f;
}

function renderLines(lines: string[]): DocumentFragment {
  return frag(linkify(lines.join('\n')));
}

/** Nest a run of blocks into blockquotes matching their quote depth. */
function renderBlock(b: TextBlock): Node {
  if (b.depth === 0) return el('div', { class: 'eml-t' }, renderLines(b.lines));

  let node: Node = el('div', { class: 'eml-t' }, renderLines(b.lines));
  for (let d = b.depth; d > 0; d--) {
    node = el('blockquote', { class: `eml-q eml-q${((d - 1) % 4) + 1}` }, node);
  }
  return node;
}

export function renderTextBody(
  text: string,
  flowed: FlowedInfo,
  collapseQuotes: boolean,
): HTMLElement {
  const lines = toLines(text, flowed);
  let blocks = toBlocks(lines);

  // Outlook and several clients mark the reply history with a separator instead of '>'.
  // Promote everything after one to depth 1 so it gets the same treatment.
  const sepIndex = blocks.findIndex(
    (b) => b.depth === 0 && b.lines.some((l) => IMPLICIT_QUOTE_SEPARATOR.test(l)),
  );
  if (sepIndex >= 0) {
    blocks = blocks.map((b, i) => (i > sepIndex && b.depth === 0 ? { ...b, depth: 1 } : b));
  }

  const { body, sig } = splitSignature(blocks);
  const container = el('div', { class: 'eml-text' });

  // Only the TRAILING quote run collapses. Collapsing an interleaved quote destroys the
  // argument structure of a threaded reply, which is the content the reader came for.
  const quoteStart = collapseQuotes ? trailingQuoteStart(body) : -1;
  const head = quoteStart >= 0 ? body.slice(0, quoteStart) : body;
  const tail = quoteStart >= 0 ? body.slice(quoteStart) : [];

  for (const b of head) container.append(renderBlock(b));

  if (tail.length) {
    const count = tail.reduce((n, b) => n + (b.depth > 0 ? b.lines.length : 0), 0);
    const inner = el('div', { class: 'eml-quoted' });
    for (const b of tail) inner.append(renderBlock(b));
    container.append(
      el(
        'details',
        { class: 'eml-quote-toggle' },
        el('summary', {}, `Show quoted text (${count} ${count === 1 ? 'line' : 'lines'})`),
        inner,
      ),
    );
  }

  if (sig) {
    container.append(el('div', { class: 'eml-sig' }, renderLines(['-- ', ...sig])));
  }

  return container;
}
