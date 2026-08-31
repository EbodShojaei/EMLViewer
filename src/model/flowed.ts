/**
 * RFC 3676 format=flowed handling, plus quote-depth structure for plain-text bodies.
 *
 * Pure. Unit-tested directly.
 *
 * Known limitation: postal-mime does not expose per-part headers, so for any multipart
 * message the text/plain part's format/delsp parameters are simply unavailable. We read
 * them from the top-level header when the message is not multipart, and otherwise fall
 * back to a conservative heuristic. Not unfolding is a mild cosmetic defect (ragged
 * 72-column wrapping) because pre-wrap handles the rest, so erring conservative is right.
 */

export interface FlowedInfo {
  enabled: boolean;
  delSp: boolean;
  how: 'header' | 'heuristic' | 'none';
}

export function detectFlowed(
  contentTypeLine: string,
  isMultipart: boolean,
  body: string,
  mode: 'auto' | 'on' | 'off',
): FlowedInfo {
  if (mode === 'off') return { enabled: false, delSp: false, how: 'none' };

  if (!isMultipart && /format\s*=\s*"?flowed/i.test(contentTypeLine)) {
    return { enabled: true, delSp: /delsp\s*=\s*"?yes/i.test(contentTypeLine), how: 'header' };
  }
  if (mode === 'on') return { enabled: true, delSp: false, how: 'header' };

  return heuristicFlowed(body);
}

/**
 * Flowed text ends soft-wrapped lines with a single space. Require a decent sample and a
 * plausible wrap width before believing it, so a message that merely has trailing
 * whitespace does not get its line structure rewritten.
 */
function heuristicFlowed(body: string): FlowedInfo {
  const lines = body.split('\n');
  let flowedLines = 0;
  let nonBlank = 0;
  let lenSum = 0;

  for (const line of lines) {
    if (line === '-- ') continue; // signature separator is never flowed
    if (!line.trim()) continue;
    nonBlank++;
    if (/[^ ] $/.test(line)) {
      flowedLines++;
      lenSum += line.length;
    }
  }

  if (flowedLines < 8 || nonBlank === 0) return { enabled: false, delSp: false, how: 'none' };
  if (flowedLines / nonBlank < 0.25) return { enabled: false, delSp: false, how: 'none' };
  const mean = lenSum / flowedLines;
  if (mean < 55 || mean > 82) return { enabled: false, delSp: false, how: 'none' };

  return { enabled: true, delSp: false, how: 'heuristic' };
}

export interface TextLine {
  depth: number;
  text: string;
}

const QUOTE = /^(>+) ?/;

/**
 * Split into quote-depth-tagged lines, unfolding flowed continuations when asked.
 * Joining only ever happens between lines at equal quote depth.
 */
export function toLines(body: string, flowed: FlowedInfo): TextLine[] {
  const raw = body.replace(/\r\n?/g, '\n').split('\n');
  const out: TextLine[] = [];

  for (const line of raw) {
    const m = QUOTE.exec(line);
    const depth = m ? m[1].length : 0;
    let text = m ? line.slice(m[0].length) : line;

    // RFC 3676 space-stuffing: a leading space is added to lines starting with
    // space, '>' or "From ", and must be removed before anything else looks at them.
    if (flowed.enabled && text.startsWith(' ')) text = text.slice(1);

    const prev = out[out.length - 1];
    const canJoin =
      flowed.enabled &&
      prev !== undefined &&
      prev.depth === depth &&
      prev.text !== '-- ' &&
      /[^ ] $/.test(prev.text);

    if (canJoin) {
      prev.text = flowed.delSp ? prev.text.slice(0, -1) + text : prev.text + text;
    } else {
      out.push({ depth, text });
    }
  }
  return out;
}

export interface TextBlock {
  depth: number;
  lines: string[];
}

/** Group consecutive equal-depth lines so each becomes one blockquote nesting level. */
export function toBlocks(lines: TextLine[]): TextBlock[] {
  const blocks: TextBlock[] = [];
  for (const l of lines) {
    const last = blocks[blocks.length - 1];
    if (last && last.depth === l.depth) last.lines.push(l.text);
    else blocks.push({ depth: l.depth, lines: [l.text] });
  }
  return blocks;
}

/**
 * Which trailing block starts the quoted reply history.
 *
 * Only the TRAILING run is collapsible, and only past a threshold. Collapsing an
 * interleaved quote destroys the argument structure of a threaded reply, which is
 * exactly the content the reader came for.
 */
export function trailingQuoteStart(blocks: TextBlock[], minLines = 6): number {
  let i = blocks.length;
  let counted = 0;

  while (i > 0) {
    const b = blocks[i - 1];
    const isQuote = b.depth > 0;
    const isBlank = b.depth === 0 && b.lines.every((l) => !l.trim());
    if (!isQuote && !isBlank) break;
    if (isQuote) counted += b.lines.length;
    i--;
  }

  if (i >= blocks.length || counted < minLines) return -1;
  return i;
}

/** Outlook and several clients emit an explicit separator instead of '>' prefixes. */
export const IMPLICIT_QUOTE_SEPARATOR =
  /^\s*(-{5,}\s*Original Message\s*-{5,}|_{20,}|-{5,}\s*Forwarded message\s*-{5,})\s*$/i;

/** Trailing signature per RFC 3676 section 4.3. Dimmed rather than hidden. */
export function splitSignature(blocks: TextBlock[]): { body: TextBlock[]; sig: string[] | null } {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.depth !== 0) continue;
    const idx = b.lines.findIndex((l) => l === '-- ' || l === '--');
    if (idx === -1) continue;

    const sig = b.lines.slice(idx + 1);
    if (!sig.length || sig.join('').trim() === '') return { body: blocks, sig: null };

    const head = blocks.slice(0, i);
    if (idx > 0) head.push({ depth: 0, lines: b.lines.slice(0, idx) });
    return { body: head, sig };
  }
  return { body: blocks, sig: null };
}
