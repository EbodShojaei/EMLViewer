/**
 * Attachment filename sanitization.
 *
 * A MIME filename is entirely attacker-controlled. It reaches two dangerous places:
 * the filesystem (path traversal) and the screen (extension spoofing). This handles both.
 *
 * Pure — no `vscode`, no Node. Unit-tested directly.
 *
 * Every character class below is written with \u escapes on purpose. Raw control and bidi
 * bytes in source survive round-trips through editors and diffs badly, and a silently
 * mangled character class here fails open.
 */

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** C0 controls + DEL. A NUL truncates the path in some syscalls; the rest corrupt display. */
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * Bidi overrides. `photo<U+202E>gnp.exe` renders to the eye as `photoexe.png`.
 * LRM/RLM, the LRE..RLO embedding block, and the isolate block.
 */
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/rtf': 'rtf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/ms-tnef': 'dat',
  'application/vnd.ms-tnef': 'dat',
  'application/pkcs7-signature': 'p7s',
  'application/pkcs7-mime': 'p7m',
  'application/x-pkcs7-mime': 'p7m',
  'application/pgp-encrypted': 'asc',
  'message/rfc822': 'eml',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/csv': 'csv',
  'text/calendar': 'ics',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
};

export function extFromMime(mimeType: string): string {
  const key = (mimeType || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[key] ?? 'bin';
}

/**
 * Produce a filename that is safe to join onto a directory and safe to show to a user.
 *
 * Traversal defence is layered: this strips separators and leading dots, and the caller
 * still runs assertContained() after joining. `Uri.joinPath` NORMALIZES `..` rather than
 * rejecting it, so anything that slipped past here would silently escape — the post-join
 * check is the load-bearing guard and this is the first line, not the only one.
 */
export function safeFileName(
  raw: string | null | undefined,
  fallbackExt = 'bin',
  index = 0,
): string {
  let n = (raw ?? '').normalize('NFC');

  n = n.replace(CONTROL, '');
  n = n.replace(BIDI, '');
  n = n.replace(/[\\/]/g, '_'); // BOTH separators, on every platform
  n = n.replace(/[<>:"|?*]/g, '_'); // Windows-illegal
  n = n.replace(/^[.\s]+/, ''); // no dotfiles; also kills bare "." and ".."
  n = n.replace(/[.\s]+$/, ''); // Windows rejects trailing dot/space

  if (WIN_RESERVED.test(n)) n = '_' + n;

  // Fall back whenever nothing informative survived. Sanitizing "./" down to a bare "_"
  // is safe but useless to the user, and a name made only of punctuation is a smell.
  if (!n || !/[\p{L}\p{N}]/u.test(n)) n = `attachment-${index + 1}.${fallbackExt}`;

  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 ? n.slice(dot, dot + 16) : '';
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

/**
 * Shorten for display while keeping both ends. Never head- or tail-truncate a filename:
 * the extension and the disambiguating tail are the informative parts.
 */
export function middleEllipsis(name: string, max = 32): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
  const stem = ext ? name.slice(0, dot) : name;
  const budget = max - ext.length - 1;
  if (budget < 8) return name.slice(0, Math.max(1, max - 1)) + '…';
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  return stem.slice(0, head) + '…' + stem.slice(stem.length - tail) + ext;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
