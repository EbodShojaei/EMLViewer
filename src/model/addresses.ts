import type { AddressVm, DateVm } from '../shared/types.ts';

/**
 * postal-mime's Address is a union:
 *   { name, address }                    a mailbox
 *   { name, group: Mailbox[] }           RFC 5322 group syntax
 *
 * `To: undisclosed-recipients:;` and `To: Team: a@x, b@y;` both arrive as the second
 * shape. Formatting without narrowing the union renders `undefined <undefined>`, which
 * is exactly the bug this module exists to prevent.
 */
interface RawMailbox {
  name?: string;
  address?: string;
}
interface RawAddress extends RawMailbox {
  group?: RawMailbox[];
}

function mailboxToVm(m: RawMailbox): AddressVm {
  const address = (m.address ?? '').trim();
  const name = (m.name ?? '').trim();
  return {
    name: name || address,
    address,
    raw: name && address ? `${name} <${address}>` : address || name,
  };
}

export function toVm(input: RawAddress | RawAddress[] | undefined | null): AddressVm[] {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  const out: AddressVm[] = [];

  for (const a of list) {
    if (!a) continue;

    if (Array.isArray(a.group)) {
      const members = a.group.map(mailboxToVm);
      const label = (a.name ?? '').trim() || 'undisclosed recipients';
      out.push({
        name: label,
        address: '',
        raw: `${label}: ${members.map((m) => m.raw).join(', ')};`,
        isGroup: true,
        members,
      });
      continue;
    }

    // Skip entries that carry neither a name nor an address rather than emitting a blank chip.
    if (!a.address && !a.name) continue;
    out.push(mailboxToVm(a));
  }
  return out;
}

/** Flattened count, so a group of 12 reads as 12 recipients rather than 1. */
export function countRecipients(list: AddressVm[]): number {
  return list.reduce((n, a) => n + (a.isGroup ? (a.members?.length ?? 0) : 1), 0);
}

export function joinRaw(list: AddressVm[]): string {
  return list.map((a) => a.raw).join(', ');
}

/**
 * postal-mime returns `date` as an ISO string when it parsed, or the raw header text
 * when it did not. Keep both: the ISO drives formatting, the raw is what a forensic
 * reader actually wants on hover (it carries the sender's timezone).
 */
export function toDateVm(date: string | undefined, rawHeader?: string): DateVm | null {
  if (!date && !rawHeader) return null;
  const raw = rawHeader ?? date ?? '';
  if (!date) return { iso: null, raw };
  const t = Date.parse(date);
  return Number.isNaN(t) ? { iso: null, raw } : { iso: new Date(t).toISOString(), raw };
}

/** Two initials for the avatar. Falls back to the address when there is no display name. */
export function initials(a: AddressVm | undefined): string {
  if (!a) return '?';
  const source = a.name || a.address;
  const words = source
    .replace(/["']/g, '')
    .split(/[\s._@-]+/)
    .filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Stable hue from the address, so the same sender always gets the same avatar colour. */
export function hueFor(a: AddressVm | undefined): number {
  const s = (a?.address || a?.name || '').toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
