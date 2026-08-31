import { el } from './dom.ts';
import { formatBytes, middleEllipsis } from '../model/safeName.ts';
import type { AttachmentKind, AttachmentVm } from '../shared/types.ts';

const ICON: Record<AttachmentKind, string> = {
  file: 'file',
  image: 'file-media',
  message: 'mail',
  calendar: 'calendar',
  signature: 'shield',
  tnef: 'package',
  encrypted: 'lock',
};

function iconFor(a: AttachmentVm): string {
  const m = a.mimeType.toLowerCase();
  if (m === 'application/pdf') return 'file-pdf';
  if (m.includes('zip') || m.includes('gzip') || m.includes('tar')) return 'file-zip';
  if (m.startsWith('text/') || m.includes('json') || m.includes('xml')) return 'file-code';
  return ICON[a.kind] ?? 'file';
}

function chip(a: AttachmentVm, onSave: (index: number) => void): HTMLElement {
  const item = el('li', { class: 'eml-att-item' });

  const body = el(
    'div',
    { class: 'eml-chip' },
    el('span', { class: `codicon codicon-${iconFor(a)} eml-chip-icon`, 'aria-hidden': 'true' }),
    // The filename shown is already sanitized. Rendering the raw MIME name would let a
    // U+202E override make `photo<RLO>gnp.exe` read as `photoexe.png`.
    el('span', { class: 'eml-chip-name', title: a.filename }, middleEllipsis(a.filename)),
    el('span', { class: 'eml-chip-size' }, formatBytes(a.size)),
  );

  const save = el('button', {
    class: 'eml-chip-save',
    type: 'button',
    'aria-label': `Save ${a.filename}`,
    title: `Save ${a.filename}`,
  });
  save.append(el('span', { class: 'codicon codicon-desktop-download', 'aria-hidden': 'true' }));
  save.addEventListener('click', () => onSave(a.index));

  item.append(body, save);
  return item;
}

export function renderAttachments(
  all: AttachmentVm[],
  bodyIsHtml: boolean,
  onSave: (index: number) => void,
): HTMLElement | null {
  // In plain-text mode nothing is rendered in the body, so nothing counts as inline.
  const listed = all.filter((a) => !(bodyIsHtml && a.isInline));
  const embedded = all.filter((a) => bodyIsHtml && a.isInline);

  if (!listed.length && !embedded.length) return null;

  const section = el('section', { class: 'eml-attachments', 'aria-labelledby': 'eml-att-h' });
  section.append(el('h2', { class: 'eml-vh', id: 'eml-att-h' }, 'Attachments'));

  if (listed.length) {
    const total = listed.reduce((n, a) => n + a.size, 0);
    section.append(
      el(
        'div',
        { class: 'eml-att-meta' },
        el('span', { class: 'codicon codicon-attach', 'aria-hidden': 'true' }),
        el(
          'span',
          {},
          `${listed.length} ${listed.length === 1 ? 'attachment' : 'attachments'} · ${formatBytes(total)}`,
        ),
      ),
    );
    const ul = el('ul', { class: 'eml-att-list' });
    for (const a of listed) ul.append(chip(a, onSave));
    section.append(ul);
  }

  // Nothing is ever truly hidden — inline images stay reachable behind a disclosure so a
  // part that was wrongly classified as embedded is still recoverable.
  if (embedded.length) {
    const ul = el('ul', { class: 'eml-att-list' });
    for (const a of embedded) ul.append(chip(a, onSave));
    section.append(
      el(
        'details',
        { class: 'eml-att-inline' },
        el(
          'summary',
          {},
          `${embedded.length} embedded ${embedded.length === 1 ? 'image' : 'images'}`,
        ),
        ul,
      ),
    );
  }

  return section;
}
