import type { InlineResources } from '../shared/types.ts';

/**
 * Resolving `cid:` references against multipart/related parts.
 *
 * The security rule lives here and is deliberately separate from the cosmetic
 * "should this show up in the attachment list" question in buildPayload. Conflating
 * the two is how a multipart/mixed attachment carrying a colliding Content-ID gets
 * injected into the rendered body.
 */

export interface InlineCandidate {
  contentId?: string;
  filename?: string | null;
  mimeType: string;
  disposition: 'attachment' | 'inline' | null;
  related?: boolean;
  content: Uint8Array;
}

/**
 * Content-ID headers carry angle brackets (`<logo@x>`); `cid:` URLs do not, and are
 * percent-encoded per RFC 2392 (`cid:logo%40x`). Case is technically significant and
 * real senders are inconsistent about it. Normalize both sides through here.
 */
export function normalizeCid(s: string): string {
  let v = (s ?? '').trim();
  try {
    v = decodeURIComponent(v);
  } catch {
    // A malformed percent sequence is not fatal — fall through with the raw text.
  }
  return v.replace(/^</, '').replace(/>$/, '').trim().toLowerCase();
}

export function basename(p: string): string {
  const s = (p ?? '').split(/[\\/]/).pop() ?? '';
  return s.trim().toLowerCase();
}

/** Only image-ish parts get inlined. An inline text/html part is not a renderable resource. */
const IMAGEY = /^image\//i;

/**
 * THE security rule: a part may resolve a `cid:` only if it genuinely lives inside a
 * multipart/related, or is explicitly marked inline. Nothing else ever enters the map.
 */
export function isInlineEligible(a: InlineCandidate): boolean {
  return a.related === true || a.disposition === 'inline';
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoaShim(s);
}

// The extension host has Buffer; the webview has btoa. This module runs host-side, but
// keep it independent of both so it stays unit-testable under plain node.
function btoaShim(bin: string): string {
  const g = globalThis as { btoa?: (s: string) => string; Buffer?: typeof Buffer };
  if (typeof g.btoa === 'function') return g.btoa(bin);
  return Buffer.from(bin, 'binary').toString('base64');
}

/**
 * Build the cid -> data: URI map.
 *
 * `blob:` URLs cannot be used here: a blob URL is bound to the origin of the context
 * that created it, and the body iframe has an opaque origin, so a cross-origin blob
 * fetch fails. data: is the only option that works inside the sandbox.
 *
 * Budgeted because base64 inflates 33% and the result is embedded in the srcdoc string,
 * which is then retained for the tab's lifetime under retainContextWhenHidden.
 */
export function buildInlineResources(
  parts: InlineCandidate[],
  budgetBytes: number,
): { resources: InlineResources; usedIndices: Set<number>; oversizeIndices: Set<number> } {
  const byCid: Record<string, string> = {};
  const byName: Record<string, string> = {};
  const usedIndices = new Set<number>();
  const oversizeIndices = new Set<number>();
  let spent = 0;
  let droppedForBudget = 0;

  parts.forEach((a, i) => {
    if (!isInlineEligible(a)) return;
    if (!IMAGEY.test(a.mimeType)) return;

    const size = a.content.byteLength;
    if (budgetBytes > 0 && spent + size > budgetBytes) {
      droppedForBudget++;
      oversizeIndices.add(i);
      return;
    }
    spent += size;

    const uri = `data:${a.mimeType};base64,${toBase64(a.content)}`;
    let mapped = false;

    if (a.contentId) {
      const key = normalizeCid(a.contentId);
      if (key) {
        byCid[key] = uri;
        mapped = true;
      }
    }
    // Outlook emits <img src="image001.png"> with a matching part and no cid: at all.
    if (a.filename) {
      const key = basename(a.filename);
      if (key) {
        byName[key] = uri;
        mapped = true;
      }
    }
    if (mapped) usedIndices.add(i);
  });

  return { resources: { byCid, byName, droppedForBudget }, usedIndices, oversizeIndices };
}

/**
 * Is this part actually referenced by the body HTML?
 *
 * Cosmetic only — it decides whether the part is listed as an attachment or tucked under
 * the "embedded images" disclosure. It must never gate the security decision above.
 * Plenty of clients mark genuine attachments `inline`; hiding those would lose the file.
 */
export function isReferencedInHtml(
  html: string,
  contentId?: string,
  filename?: string | null,
): boolean {
  if (!html) return false;
  const hay = html.toLowerCase();
  if (contentId) {
    const cid = normalizeCid(contentId);
    if (cid && (hay.includes(`cid:${cid}`) || hay.includes(`cid:${encodeURIComponent(cid)}`))) {
      return true;
    }
  }
  if (filename) {
    const name = basename(filename);
    if (name && hay.includes(name)) return true;
  }
  return false;
}
