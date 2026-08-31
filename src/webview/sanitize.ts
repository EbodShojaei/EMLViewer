import DOMPurify from 'dompurify';
import type { InlineResources } from '../shared/types.ts';
import { normalizeCid, basename } from '../model/inline.ts';

/**
 * Sanitize email HTML. Runs in the webview, so DOMPurify gets a real Chromium DOM —
 * no jsdom, and mutation-XSS resistance comes free from parse-then-reserialize.
 *
 * This is defence in depth. The CSP is the actual enforcement boundary: even a total
 * bypass here cannot load a remote image, because `img-src` omits `https:`.
 */

/**
 * DOMPurify's defaults are more permissive than people expect. `form`, `input`, `button`,
 * `select` and `textarea` are all allowed out of the box. The rest are already denied by
 * default but are listed anyway so the policy is explicit rather than inherited.
 */
const FORBID_TAGS = [
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'optgroup',
  'fieldset',
  'label',
  'base',
  'meta',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'script',
  'link',
  'template',
  'slot',
  'portal',
  'marquee',
  'blink',
  'svg',
  'math',
  'audio',
  'video',
  'source',
  'track',
];

const FORBID_ATTR = ['ping', 'formaction', 'autofocus', 'srcdoc', 'usemap', 'action', 'background'];

const CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  FORBID_TAGS,
  FORBID_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: true,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  SANITIZE_DOM: true,
  SANITIZE_NAMED_PROPS: true,
  // FORBID_TAGS drops the element but keeps its text, so a stripped <button> still reads.
  KEEP_CONTENT: true,
  WHOLE_DOCUMENT: false,
  RETURN_DOM_FRAGMENT: false,
};

export interface SanitizeResult {
  html: string;
  /** Author CSS lifted out of <style> blocks, already rewritten. Injected separately. */
  css: string;
  blockedRemote: number;
  blockedPixels: number;
  resolvedCid: number;
  unresolvedCid: number;
}

/** Hook context. Only the counters are shared with the result; css/html are assembled after. */
interface Ctx {
  inline: InlineResources;
  allowRemote: boolean;
  blockedRemote: number;
  blockedPixels: number;
  resolvedCid: number;
  unresolvedCid: number;
}

// Module-scoped because DOMPurify hooks take no user data. Set immediately before sanitize().
let CTX: Ctx;

const REMOTE = /^(?:https?:|\/\/)/i;

/**
 * Transparent 1x1 GIF.
 *
 * Blocked and unresolved images keep a valid `src` pointing here rather than having the
 * attribute removed. Removing it makes the browser fall back to the alt text and a broken
 * image glyph, which reads as a rendering failure; with this the element stays an empty
 * box that the `data-eml-blocked` styling turns into a deliberate placeholder at the
 * sender's declared dimensions.
 */
const BLANK =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Rewrite url() references inside a style attribute or <style> body. */
function rewriteCssUrls(css: string): string {
  return css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (whole, _q, url: string) => {
    const v = String(url).trim();
    if (/^cid:/i.test(v)) {
      const hit = lookupCid(v);
      return hit ? `url("${hit}")` : 'none';
    }
    if (/^data:image\//i.test(v)) return whole;
    if (REMOTE.test(v)) {
      if (CTX.allowRemote) return whole;
      CTX.blockedRemote++;
      return 'none';
    }
    const named = CTX.inline.byName[basename(v)];
    return named ? `url("${named}")` : 'none';
  });
}

function lookupCid(value: string): string | undefined {
  const key = normalizeCid(value.replace(/^cid:/i, ''));
  const hit = CTX.inline.byCid[key] ?? CTX.inline.byName[basename(key)];
  if (hit) CTX.resolvedCid++;
  else CTX.unresolvedCid++;
  return hit;
}

/**
 * Resolve a src/poster value.
 * Returns a replacement string, or null meaning "remove the attribute entirely".
 */
function resolveUrl(value: string): string | null {
  const s = value.trim();

  if (/^cid:/i.test(s)) return lookupCid(s) ?? null;
  if (/^data:image\//i.test(s)) return s;

  if (REMOTE.test(s)) {
    if (CTX.allowRemote) return s;
    CTX.blockedRemote++;
    return null;
  }
  // Bare relative path — Outlook writes <img src="image001.png"> with a matching part.
  return CTX.inline.byName[basename(s)] ?? null;
}

/**
 * Hold a blocked image's declared footprint.
 *
 * The substitute src is a 1x1 pixel, and the frame's reset sets `height:auto`, so a
 * `width="600"` banner would compute to a 600px SQUARE and swallow the message. Pin the
 * dimensions the sender declared; where they declared none, use a restrained box rather
 * than letting the aspect ratio of a single pixel decide the layout.
 */
function reserveSpace(e: Element, w: number, h: number): void {
  const hasW = Number.isFinite(w) && w > 2;
  const hasH = Number.isFinite(h) && h > 2;
  // Nothing declared: leave it alone. The email's own CSS may size it, and the
  // min-width/min-height in the frame reset keeps it a visible 32px box either way.
  // Forcing a size here would stretch CSS-sized elements like a 34px avatar.
  if (!hasW && !hasH) return;

  const rules: string[] = ['max-width:100%'];
  if (hasW) rules.push(`width:${Math.min(w, 2000)}px`);
  if (hasH) rules.push(`height:${Math.min(h, 2000)}px`);
  // Width but no height would let the 1x1 substitute's 1:1 ratio decide, so a 600px
  // banner becomes a 600px square. A shallow band reads as a banner instead.
  else rules.push(`height:${Math.round(Math.min(w, 2000) / 3)}px`);

  const prev = e.getAttribute('style') ?? '';
  e.setAttribute('style', prev ? `${prev};${rules.join(';')}` : rules.join(';'));
}

function onAttributes(node: Node): void {
  const e = node as Element;
  if (!e.getAttribute || !e.setAttribute) return;

  const tag = e.tagName;

  if (tag === 'A' || tag === 'AREA') {
    const href = e.getAttribute('href') ?? '';
    if (/^(?:https?|mailto|tel):/i.test(href)) {
      e.setAttribute('rel', 'noopener noreferrer nofollow');
      // The shim intercepts every click and routes it to the host, so the href is here
      // for the tooltip and for copy — it is never followed by the browser.
      e.setAttribute('title', href);
    } else {
      e.removeAttribute('href');
    }
    e.removeAttribute('target');
  }

  if (tag === 'IMG' || tag === 'INPUT') {
    const w = Number(e.getAttribute('width'));
    const h = Number(e.getAttribute('height'));
    const src = e.getAttribute('src') ?? '';
    const isRemote = REMOTE.test(src.trim());
    const isPixel = (w > 0 && w <= 2) || (h > 0 && h <= 2);

    if (isRemote && !CTX.allowRemote) {
      // A transparent 1x1 substitution makes blocking invisible and the mail just looks
      // broken. Real images get a visible placeholder; declared trackers are removed, so
      // the page is not littered with dashed dots. Counted separately for honest copy.
      e.setAttribute('data-eml-blocked', isPixel ? 'pixel' : 'visible');
      if (isPixel) CTX.blockedPixels++;
      e.setAttribute('data-eml-src', src.slice(0, 2048));
      if (!isPixel) reserveSpace(e, w, h);
    }
  }

  for (const attr of ['src', 'poster']) {
    const v = e.getAttribute(attr);
    if (v === null) continue;
    const next = resolveUrl(v);
    if (next === null) {
      // Keep a valid src so the browser does not fall back to alt text plus a broken
      // image glyph. On an <img> the blank pixel plus the placeholder styling reads as
      // deliberate; anywhere else, drop the attribute entirely.
      if (tag === 'IMG' && attr === 'src') {
        e.setAttribute('src', BLANK);
        if (!e.hasAttribute('data-eml-blocked')) e.setAttribute('data-eml-blocked', 'missing');
        e.removeAttribute('alt');
      } else {
        e.removeAttribute(attr);
      }
    } else if (next !== v) {
      e.setAttribute(attr, next);
    }
  }

  // No partial rewriting of a candidate list — all or nothing.
  if (e.hasAttribute('srcset')) {
    const val = e.getAttribute('srcset') ?? '';
    if (!CTX.allowRemote && REMOTE.test(val.trim())) CTX.blockedRemote++;
    e.removeAttribute('srcset');
  }

  const style = e.getAttribute('style');
  if (style && /url\s*\(/i.test(style)) {
    e.setAttribute('style', rewriteCssUrls(style));
  }
}

/**
 * Sanitize a block of author CSS.
 *
 * DOMPurify force-removes <style> elements — verified empirically, and neither ADD_TAGS
 * nor a hook brings them back. Since most real HTML email carries its layout in a <head>
 * <style> block, letting them go guts rendering fidelity, so the CSS is lifted out before
 * DOMPurify runs and handled here instead.
 *
 * That is safe because CSS cannot execute script in any browser this runs on, and the
 * genuinely dangerous part of CSS — loading remote resources — is governed by the CSP,
 * which forbids it outright. The rewriting below keeps the blocked-content counter honest
 * and removes the constructs that have no business in a mail body.
 */
function sanitizeCss(css: string): string {
  let out = css;

  // @import fetches a remote stylesheet. The CSP already refuses it; drop it so the
  // rule cannot linger in a form that would activate if the user allows remote content.
  out = out.replace(/@import[^;]*;?/gi, '');
  // Legacy IE script vectors. Inert in Chromium, removed so they cannot be resurrected.
  out = out.replace(/expression\s*\(/gi, 'void(');
  out = out.replace(/-moz-binding\s*:[^;}]*/gi, '');
  out = out.replace(/behavior\s*:[^;}]*/gi, '');
  out = out.replace(/javascript\s*:/gi, 'void:');

  out = rewriteCssUrls(out);

  // The result is interpolated into a <style> element in the srcdoc string. A literal
  // "</style" in the CSS would close that element early and turn the remainder into
  // markup, which is an HTML injection with the sanitizer entirely bypassed. The DOM
  // parser makes this sequence unreachable in practice; escaping it costs nothing and
  // removes the possibility rather than relying on that.
  out = out.replace(/<\/(style)/gi, '<\\/$1');

  return out;
}

/**
 * Split an email document into author CSS and body markup.
 *
 * Real HTML email is usually a full <html><head><style>…</style></head> document, and a
 * default (non-WHOLE_DOCUMENT) DOMPurify pass discards everything in <head>. Pre-split
 * with DOMParser: the resulting document is inert — no browsing context, so no script
 * execution and no subresource fetching — which makes it safe to inspect before
 * DOMPurify runs. Styles are collected from the whole document, not just <head>, because
 * plenty of senders put them in the body.
 */
function splitDocument(rawHtml: string): { css: string; body: string } {
  try {
    const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
    const blocks: string[] = [];
    for (const el of Array.from(doc.querySelectorAll('style'))) {
      if (el.textContent) blocks.push(el.textContent);
      el.remove(); // keep it out of the DOMPurify input, which would discard it anyway
    }
    return { css: blocks.join('\n'), body: doc.body?.innerHTML ?? '' };
  } catch {
    return { css: '', body: rawHtml };
  }
}

export function sanitizeEmailHtml(
  rawHtml: string,
  inline: InlineResources,
  allowRemote: boolean,
): SanitizeResult {
  CTX = {
    inline,
    allowRemote,
    blockedRemote: 0,
    blockedPixels: 0,
    resolvedCid: 0,
    unresolvedCid: 0,
  };

  // Lift the author CSS out first — it is rewritten here rather than by DOMPurify, which
  // discards <style> outright. Both paths share rewriteCssUrls, so cid: resolution and
  // remote-content counting stay consistent between them.
  const split = splitDocument(rawHtml);
  const css = split.css ? sanitizeCss(split.css) : '';

  DOMPurify.addHook('afterSanitizeAttributes', onAttributes);
  try {
    const html = DOMPurify.sanitize(split.body, CONFIG) as unknown as string;
    return {
      html,
      css,
      blockedRemote: CTX.blockedRemote,
      blockedPixels: CTX.blockedPixels,
      resolvedCid: CTX.resolvedCid,
      unresolvedCid: CTX.unresolvedCid,
    };
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
}
