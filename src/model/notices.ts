import type { Notice } from '../shared/types.ts';

/**
 * Classification of degraded messages.
 *
 * Copy rule throughout: say what happened, say why, offer a door out. Never "Error:" or
 * "Failed to". "Doesn't unpack TNEF" reads as a scoped tool; "Failed to parse attachment"
 * reads as a bug.
 */

export interface NoticeInput {
  hasHtml: boolean;
  hasText: boolean;
  attachments: {
    mimeType: string;
    filename?: string | null;
    rfc822DepthExceeded?: boolean;
  }[];
  /** Raw top-level Content-Type header line, for the missing-boundary check. */
  contentTypeLine: string;
  /** First ~200 chars of the text body, for the PGP armour check. */
  textHead: string;
}

const REOPEN = { id: 'reopenAsText' as const, label: 'Reopen in Text Editor' };

export function detectNotices(input: NoticeInput): Notice[] {
  const out: Notice[] = [];
  const { hasHtml, hasText, attachments, contentTypeLine, textHead } = input;
  const hasBody = hasHtml || hasText;
  const mimes = attachments.map((a) => (a.mimeType || '').toLowerCase());

  const isMultipart = /^\s*content-type:\s*multipart\//i.test(contentTypeLine);
  const hasBoundary = /boundary\s*=/i.test(contentTypeLine);

  // ---- encryption ---------------------------------------------------------------
  // Signed is NOT encrypted. Conflating them is the most common mistake in mail readers
  // and it teaches users to distrust a working render.
  const smimeEncrypted = mimes.some(
    (m) => m === 'application/pkcs7-mime' || m === 'application/x-pkcs7-mime',
  );
  const smimeSigned = mimes.some(
    (m) => m === 'application/pkcs7-signature' || m === 'application/x-pkcs7-signature',
  );
  const pgpEncrypted =
    mimes.includes('application/pgp-encrypted') ||
    /^-{5}BEGIN PGP MESSAGE-{5}/m.test(textHead);

  if (smimeEncrypted && !hasBody) {
    out.push({
      kind: 'smime-encrypted',
      severity: 'error',
      title: 'This message is encrypted',
      detail:
        'It was sent using S/MIME. This viewer can read the headers but cannot decrypt the contents.',
      blocking: true,
      actions: [REOPEN],
    });
  } else if (pgpEncrypted && !hasBody) {
    out.push({
      kind: 'pgp-encrypted',
      severity: 'error',
      title: 'This message is encrypted (PGP)',
      detail: 'This viewer can read the headers but cannot decrypt the contents.',
      blocking: true,
      actions: [REOPEN],
    });
  }

  if (smimeSigned) {
    out.push({
      kind: 'smime-signed',
      severity: 'info',
      title: 'Digitally signed',
      // Do not show a checkmark you have not earned. Nothing here verifies anything.
      detail: 'A signature is present. This viewer does not verify it.',
    });
  }

  // ---- TNEF ---------------------------------------------------------------------
  if (
    mimes.some((m) => m === 'application/ms-tnef' || m === 'application/vnd.ms-tnef') ||
    attachments.some((a) => (a.filename ?? '').toLowerCase() === 'winmail.dat')
  ) {
    out.push({
      kind: 'tnef',
      severity: 'warning',
      title: 'Outlook sent this in TNEF format',
      detail:
        'The body and attachments are packed inside winmail.dat, which this viewer does not unpack.',
      blocking: !hasBody,
      actions: hasBody ? undefined : [REOPEN],
    });
  }

  // ---- structural ---------------------------------------------------------------
  if (!hasBody) {
    if (isMultipart && !hasBoundary) {
      // postal-mime registers a boundary only when the param is present, so walk() finds
      // no children and the body silently vanishes. Say so rather than showing blank.
      out.push({
        kind: 'missing-boundary',
        severity: 'warning',
        title: 'This message declares a multipart body but omits the MIME boundary',
        detail: 'Without it the parts cannot be separated. The raw file is still readable.',
        blocking: true,
        actions: [REOPEN],
      });
    } else if (!smimeEncrypted && !pgpEncrypted) {
      out.push({
        kind: 'empty-body',
        severity: 'info',
        title: 'This message has no body',
        detail: 'It may contain only headers and attachments.',
        blocking: true,
      });
    }
  }

  if (attachments.some((a) => a.rfc822DepthExceeded)) {
    out.push({
      kind: 'nesting-truncated',
      severity: 'warning',
      title: 'Forwarded message nesting was truncated',
      detail: 'The innermost forwarded message exceeded the depth limit and was not parsed.',
    });
  }

  return out;
}

export function oversizeNotice(bytes: number, limitMB: number): Notice {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return {
    kind: 'oversize',
    severity: 'warning',
    title: `This file is ${mb} MB`,
    detail: `Files over ${limitMB} MB are not parsed automatically, because rendering one can make the editor unresponsive.`,
    blocking: true,
    actions: [{ id: 'openAnyway', label: 'Render Anyway' }, REOPEN],
  };
}

export function parseFailedNotice(message: string): Notice {
  return {
    kind: 'parse-failed',
    severity: 'error',
    title: "This file couldn't be read as an email",
    detail: message,
    blocking: true,
    actions: [REOPEN],
  };
}

export function inlineBudgetNotice(count: number): Notice {
  return {
    kind: 'inline-budget-exceeded',
    severity: 'info',
    title: `${count} embedded ${count === 1 ? 'image is' : 'images are'} too large to display inline`,
    detail: 'They are still listed as attachments.',
  };
}
