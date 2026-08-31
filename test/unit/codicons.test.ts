import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every codicon name the webview references must exist in the shipped font.
 *
 * A wrong name fails silently — the glyph simply does not render, leaving a blank gap
 * that is easy to miss in review. `codicon-paperclip` shipped that way; the real name
 * is `codicon-attach`.
 *
 * This also guards the font itself being present: VS Code does NOT provide codicons to
 * webviews, the extension has to bundle them (see copyCodicons() in esbuild.mjs).
 */

const ROOT = path.join(import.meta.dirname, '..', '..');
const CODICON_CSS = path.join(ROOT, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');

function shippedGlyphs(): Set<string> {
  const css = fs.readFileSync(CODICON_CSS, 'utf8');
  const names = new Set<string>();
  for (const m of css.matchAll(/^\.codicon-([a-z0-9-]+):before/gm)) names.add(m[1]);
  return names;
}

/** Names appear both as `codicon-x` in class strings and as bare values in the icon map. */
function referencedGlyphs(): Set<string> {
  const dir = path.join(ROOT, 'src', 'webview');
  const out = new Set<string>();

  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/codicon-([a-z0-9-]+)/g)) out.add(m[1]);
    // `codicon-${iconFor(a)}` style interpolation: pick the map/return literals up too.
    for (const m of src.matchAll(/^\s*(?:[a-z]+|'[a-z-]+'):\s*'([a-z][a-z0-9-]*)',/gm)) {
      if (/^(file|mail|calendar|shield|package|lock|info|warning|error)/.test(m[1])) out.add(m[1]);
    }
    for (const m of src.matchAll(/return '([a-z][a-z0-9-]*)';/g)) {
      if (/^file|^mail|^shield|^package|^lock/.test(m[1])) out.add(m[1]);
    }
  }
  out.delete('css'); // from the codicon.css filename reference
  return out;
}

test('the codicon font is bundled, not assumed to come from the host', () => {
  assert.ok(fs.existsSync(CODICON_CSS), '@vscode/codicons is not installed');
  // Both files must reach media/, which is what actually ships inside the vsix.
  for (const f of ['codicon.css', 'codicon.ttf']) {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'media', f)),
      `media/${f} missing — run the build; VS Code does not supply codicons to webviews`,
    );
  }
});

test('the shell HTML links the codicon stylesheet', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'src', 'webviewHtml.ts'), 'utf8');
  assert.match(shell, /codicon\.css/, 'shell does not load codicon.css — no glyph will render');
  assert.match(shell, /font-src \$\{webview\.cspSource\}/, 'CSP does not permit the font');
});

test('every referenced glyph name exists in the shipped font', () => {
  const shipped = shippedGlyphs();
  assert.ok(shipped.size > 100, `only parsed ${shipped.size} glyphs from codicon.css`);

  const missing = [...referencedGlyphs()].filter((n) => !shipped.has(n)).sort();
  assert.deepEqual(
    missing,
    [],
    `unknown codicon name(s): ${missing.join(', ')} — these render as an invisible gap`,
  );
});
