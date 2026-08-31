/**
 * Minimal DOM construction. No framework, and deliberately no innerHTML path —
 * everything this module builds is text-node safe by construction, which matters
 * because a lot of it is built from attacker-controlled header values.
 */

type Attrs = Record<string, string | number | boolean | undefined | null>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = String(v);
      else if (k === 'text') node.textContent = String(v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }

  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function frag(...children: (Node | string | null | undefined | false)[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    f.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return f;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** A codicon glyph. The font ships with VS Code, so nothing is fetched. */
export function icon(name: string): HTMLElement {
  return el('span', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' });
}

export function announce(message: string): void {
  const live = document.getElementById('eml-live');
  if (live) live.textContent = message;
}
