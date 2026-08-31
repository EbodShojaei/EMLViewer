import { el } from './dom.ts';
import type { Notice, NoticeActionId } from '../shared/types.ts';

const ICON: Record<Notice['severity'], string> = {
  info: 'info',
  warning: 'warning',
  error: 'error',
};

/** Compact banner strip. Non-blocking notices stack above the body. */
export function renderNoticeBanner(
  n: Notice,
  onAction: (id: NoticeActionId) => void,
): HTMLElement {
  const box = el('div', { class: `eml-banner eml-banner--${n.severity}`, role: 'status' });
  box.append(el('span', { class: `codicon codicon-${ICON[n.severity]}`, 'aria-hidden': 'true' }));

  const text = el('div', { class: 'eml-banner-text' }, el('strong', {}, n.title));
  if (n.detail) text.append(el('span', { class: 'eml-banner-detail' }, ` ${n.detail}`));
  box.append(text);

  for (const a of n.actions ?? []) {
    const b = el('button', { class: 'eml-btn eml-btn--ghost', type: 'button' }, a.label);
    b.addEventListener('click', () => onAction(a.id));
    box.append(b);
  }
  return box;
}

/**
 * Full-pane state for the cases where there is no body to show.
 *
 * Headers and attachments still render above this whenever they parsed — that is the
 * difference between a message that is degraded and one that looks broken.
 */
export function renderEmptyState(
  n: Notice,
  onAction: (id: NoticeActionId) => void,
): HTMLElement {
  const box = el('div', { class: 'eml-empty' });
  box.append(
    el('span', { class: `codicon codicon-${ICON[n.severity]} eml-empty-icon`, 'aria-hidden': 'true' }),
    el('h2', { class: 'eml-empty-title' }, n.title),
  );
  if (n.detail) box.append(el('p', { class: 'eml-empty-detail' }, n.detail));

  if (n.actions?.length) {
    const row = el('div', { class: 'eml-empty-actions' });
    n.actions.forEach((a, i) => {
      const b = el(
        'button',
        { class: i === 0 ? 'eml-btn' : 'eml-btn eml-btn--ghost', type: 'button' },
        a.label,
      );
      b.addEventListener('click', () => onAction(a.id));
      row.append(b);
    });
    box.append(row);
  }
  return box;
}

/**
 * The blocked-remote-content banner.
 *
 * Counts images and declared tracking pixels separately: "9 images and 3 tracking pixels"
 * is a legible privacy statement, where a single number reads as a rendering failure.
 */
export function renderBlockedBanner(
  blockedRemote: number,
  blockedPixels: number,
  onLoad: () => void,
): HTMLElement | null {
  const images = blockedRemote - blockedPixels;
  if (blockedRemote <= 0) return null;

  const parts: string[] = [];
  if (images > 0) parts.push(`${images} remote ${images === 1 ? 'image' : 'images'}`);
  if (blockedPixels > 0) {
    parts.push(`${blockedPixels} tracking ${blockedPixels === 1 ? 'pixel' : 'pixels'}`);
  }

  const box = el('div', { class: 'eml-banner eml-banner--blocked', role: 'status' });
  box.append(el('span', { class: 'codicon codicon-shield', 'aria-hidden': 'true' }));
  box.append(
    el('div', { class: 'eml-banner-text' }, `${parts.join(' and ')} blocked.`),
  );

  const btn = el('button', { class: 'eml-btn', type: 'button' }, 'Load images');
  btn.addEventListener('click', onLoad);
  box.append(btn);
  return box;
}

/** Shown after the user opts in. There is no un-toggle: the pixel has already fired. */
export function renderLoadedBanner(): HTMLElement {
  const box = el('div', { class: 'eml-banner eml-banner--loaded', role: 'status' });
  box.append(el('span', { class: 'codicon codicon-eye', 'aria-hidden': 'true' }));
  box.append(el('div', { class: 'eml-banner-text' }, 'Remote images loaded for this message.'));
  return box;
}
