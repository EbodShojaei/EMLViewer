import { el } from './dom.ts';
import { countRecipients, hueFor, initials, joinRaw } from '../model/addresses.ts';
import type { AddressVm, RenderPayload } from '../shared/types.ts';

/**
 * The header block: collapsed shows subject, sender, a recipient summary and the date.
 * Expanding reveals the full From/Reply-To/To/Cc/Bcc detail.
 */

export interface HeaderCallbacks {
  onToggle(expanded: boolean): void;
  onCopy(text: string, label: string): void;
}

function formatDate(iso: string | null, raw: string): { text: string; title: string } {
  if (!iso) return { text: raw ? raw : 'Date unknown', title: raw };
  const d = new Date(iso);
  const now = Date.now();
  const ageMs = now - d.getTime();
  const sameDay = new Date(now).toDateString() === d.toDateString();

  const text = sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });

  // Opening a .eml from disk is an archival act — "3 months ago" is useless, the actual
  // date is the point. A relative hint only earns its place while it is still recent.
  const relative = ageMs >= 0 && ageMs < 7 * 24 * 3600 * 1000 ? ` (${relativeTime(ageMs)})` : '';
  // The untouched header keeps the sender's timezone, which is what forensic reading wants.
  return { text: text + relative, title: raw || d.toISOString() };
}

function relativeTime(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function summarize(list: AddressVm[], max = 2): string {
  if (!list.length) return '';
  const total = countRecipients(list);
  const shown = list.slice(0, max).map((a) => a.name || a.address);
  // A fixed "2 then a count" rule rather than measure-and-fit: deterministic, and no
  // layout thrash when the pane is resized.
  return total > shown.length ? `${shown.join(', ')}, +${total - shown.length}` : shown.join(', ');
}

function chips(list: AddressVm[]): HTMLElement {
  const box = el('div', { class: 'eml-rcpts' });
  const CAP = 500;
  let n = 0;

  for (const a of list) {
    if (a.isGroup) {
      // Groups are information the sender chose to encode; don't flatten them away.
      const label = `${a.name}${a.members?.length ? ` (${a.members.length})` : ''}`;
      box.append(el('span', { class: 'eml-rcpt eml-rcpt--group', title: a.raw }, label));
      n++;
      for (const m of a.members ?? []) {
        if (n++ > CAP) break;
        box.append(el('span', { class: 'eml-rcpt', title: m.raw }, m.name || m.address));
      }
    } else {
      if (n++ > CAP) break;
      box.append(el('span', { class: 'eml-rcpt', title: a.raw }, a.name || a.address));
    }
  }

  const total = countRecipients(list);
  if (total > CAP) {
    box.append(el('span', { class: 'eml-rcpt eml-rcpt--more' }, `…and ${total - CAP} more`));
  }
  return box;
}

function row(label: string, list: AddressVm[], cb: HeaderCallbacks): HTMLElement | null {
  if (!list.length) return null;
  const copy = el('button', {
    class: 'eml-iconbtn',
    type: 'button',
    'aria-label': `Copy ${label} addresses`,
    title: `Copy ${label} addresses`,
  });
  copy.append(el('span', { class: 'codicon codicon-copy', 'aria-hidden': 'true' }));
  copy.addEventListener('click', () => cb.onCopy(joinRaw(list), `${label} addresses`));

  return el(
    'div',
    { class: 'eml-kv-row' },
    el('div', { class: 'eml-kv-key' }, label),
    el('div', { class: 'eml-kv-val' }, chips(list)),
    copy,
  );
}

export function renderHeader(p: RenderPayload, cb: HeaderCallbacks): HTMLElement {
  const from = p.from[0];
  const date = p.date ? formatDate(p.date.iso, p.date.raw) : null;

  const subject = p.subject
    ? el('h1', { class: 'eml-subject', title: p.subject }, p.subject)
    : el('h1', { class: 'eml-subject eml-subject--empty' }, '(no subject)');

  const avatar = el(
    'div',
    { class: 'eml-avatar', 'aria-hidden': 'true', style: `--h:${hueFor(from)}` },
    initials(from),
  );

  // The address is always visible next to the name. Display-name spoofing is the primary
  // phishing vector, so hiding the real address behind a hover would defeat the point.
  const line1 = el(
    'div',
    { class: 'eml-line1' },
    el('span', { class: 'eml-from-name' }, from ? from.name : '(unknown sender)'),
    from && from.address && from.name !== from.address
      ? el('span', { class: 'eml-from-addr' }, from.address)
      : null,
  );

  const recipientSummary = summarize(p.to);
  const line2 = el(
    'div',
    { class: 'eml-line2' },
    recipientSummary ? el('span', { class: 'eml-label' }, 'to ') : null,
    recipientSummary ? el('span', {}, recipientSummary) : null,
  );

  const toggle = el('button', {
    class: 'eml-disclose',
    type: 'button',
    'aria-expanded': String(p.view.headersExpanded),
    'aria-controls': 'eml-details',
    'aria-label': 'Show message details',
    title: 'Message details',
  });
  toggle.append(el('span', { class: 'codicon codicon-chevron-down', 'aria-hidden': 'true' }));

  const details = el('div', {
    class: 'eml-details',
    id: 'eml-details',
    hidden: !p.view.headersExpanded,
  });
  const kv = el('div', { class: 'eml-kv' });
  for (const [label, list] of [
    ['From', p.from],
    ['Reply-To', p.replyTo],
    ['To', p.to],
    ['Cc', p.cc],
    ['Bcc', p.bcc],
  ] as const) {
    const r = row(label, list, cb);
    if (r) kv.append(r);
  }
  if (date) {
    kv.append(
      el(
        'div',
        { class: 'eml-kv-row' },
        el('div', { class: 'eml-kv-key' }, 'Date'),
        el('div', { class: 'eml-kv-val', title: date.title }, date.text),
      ),
    );
  }
  details.append(kv);

  // A Reply-To pointing somewhere other than the sender is worth flagging quietly.
  const replyToDiffers =
    p.replyTo.length > 0 &&
    from?.address &&
    !p.replyTo.some((r) => r.address.toLowerCase() === from.address.toLowerCase());

  toggle.addEventListener('click', () => {
    const next = details.hidden;
    details.hidden = !next;
    toggle.setAttribute('aria-expanded', String(next));
    cb.onToggle(next);
  });

  return el(
    'header',
    { class: 'eml-head' },
    subject,
    el(
      'div',
      { class: 'eml-identity' },
      avatar,
      el(
        'div',
        { class: 'eml-idmain' },
        line1,
        line2,
        replyToDiffers
          ? el(
              'div',
              { class: 'eml-line2' },
              el('span', { class: 'eml-badge eml-badge--warn' }, 'replies go elsewhere'),
              el('span', {}, ` ${p.replyTo[0].address}`),
            )
          : null,
      ),
      el(
        'div',
        { class: 'eml-idside' },
        date ? el('span', { class: 'eml-date', title: date.title }, date.text) : null,
        toggle,
      ),
    ),
    details,
  );
}
