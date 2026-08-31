import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import PostalMime from 'postal-mime';
import { buildPayload, type ParsedEmail } from '../../src/model/buildPayload.ts';
import type { RenderPayload } from '../../src/shared/types.ts';

/**
 * Parses every fixture through the real pipeline. This is the cheapest broad regression
 * net available: one loop that would catch a change in parser behaviour, classification,
 * or payload shape across the whole corpus.
 */

const DIR = path.join(import.meta.dirname, '..', 'fixtures');

async function load(name: string): Promise<RenderPayload> {
  const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, name)));
  const email = (await PostalMime.parse(bytes, {
    attachmentEncoding: 'arraybuffer',
    rfc822Attachments: true,
    maxHeadersSize: 256 * 1024,
    maxNestingDepth: 32,
    maxRfc822NestingDepth: 5,
  })) as unknown as ParsedEmail;

  return buildPayload(email, {
    fileName: name,
    fileSize: bytes.byteLength,
    defaultView: 'html',
    inlineBudgetBytes: 16 * 1024 * 1024,
    collapseQuotedText: true,
    formatFlowed: 'auto',
    view: { remoteImagesAllowed: false, headersExpanded: false, restoreScrollY: 0 },
  }).payload;
}

const kinds = (p: RenderPayload) => p.notices.map((n) => n.kind).sort();

// ------------------------------------------------------------------ charset

test('latin-1 body and subject decode without mojibake', async () => {
  const p = await load('charset-latin1.eml');
  // The whole reason this is a CustomReadonlyEditorProvider reading raw bytes.
  assert.ok(p.subject.includes('Café'), `subject: ${p.subject}`);
  assert.ok(p.subject.includes('München'), `subject: ${p.subject}`);
  assert.ok(p.body.text?.includes('café'), p.body.text ?? '(no text)');
  assert.ok(p.body.text?.includes('Grüße'), 'German umlauts lost');
  assert.ok(!p.subject.includes('Ã'), `UTF-8 double-decode artifact: ${p.subject}`);
  assert.ok(!(p.body.text ?? '').includes('Ã'), 'body double-decoded');
});

test('gb2312 decodes', async () => {
  const p = await load('charset-gb2312.eml');
  assert.ok(p.subject.includes('中文'), `subject: ${p.subject}`);
  assert.ok(p.body.text?.includes('你好'), `body: ${p.body.text}`);
});

test('shift_jis decodes', async () => {
  const p = await load('charset-shiftjis.eml');
  assert.ok(p.subject.includes('テスト'), `subject: ${p.subject}`);
  assert.ok(p.body.text?.includes('こんにちは'), `body: ${p.body.text}`);
});

// ------------------------------------------------------------------ basics

test('plain text message', async () => {
  const p = await load('text-plain.eml');
  assert.equal(p.subject, 'Quarterly numbers');
  assert.equal(p.from[0].address, 'jane@acme.example');
  assert.equal(p.from[0].name, 'Jane Doe');
  assert.equal(p.body.available.text, true);
  assert.equal(p.body.available.html, false);
  assert.equal(p.body.mode, 'text'); // falls back despite defaultView 'html'
  assert.deepEqual(kinds(p), []);
});

test('multipart/alternative exposes both parts and prefers html', async () => {
  const p = await load('alternative.eml');
  assert.equal(p.body.available.html, true);
  assert.equal(p.body.available.text, true);
  assert.equal(p.body.mode, 'html');
  assert.deepEqual(kinds(p), []);
});

test('quoted-printable decodes', async () => {
  const p = await load('qp-body.eml');
  assert.ok(p.body.text?.includes('12,50 €'), p.body.text ?? '(no text)');
  assert.ok(p.subject.includes('Résumé'), p.subject);
});

// ------------------------------------------------------------------ addresses

test('group syntax never renders undefined', async () => {
  const p = await load('groups.eml');
  const all = [...p.to, ...p.cc];
  assert.ok(all.length > 0, 'no addresses parsed');
  for (const a of all) {
    assert.ok(!a.name.includes('undefined'), `name: ${a.name}`);
    assert.ok(!a.raw.includes('undefined'), `raw: ${a.raw}`);
  }
  const group = p.cc.find((a) => a.isGroup);
  assert.ok(group, 'named Cc group not detected');
  assert.equal(group.members?.length, 3);
});

test('duplicated single-value headers resolve to the first', async () => {
  const p = await load('duplicate-headers.eml');
  assert.equal(p.subject, 'First subject');
  assert.equal(p.from[0].address, 'first@example.com');
});

test('unparseable date degrades to raw text', async () => {
  const p = await load('bad-date.eml');
  assert.ok(p.date, 'date dropped entirely');
  assert.equal(p.date.iso, null);
  assert.ok(p.date.raw.length > 0, 'raw date lost');
});

test('250 recipients all parse', async () => {
  const p = await load('many-recipients.eml');
  assert.equal(p.to.length, 200);
  assert.equal(p.cc.length, 50);
});

// ------------------------------------------------------------------ inline images

test('cid resolves across brackets, percent-encoding and case', async () => {
  const p = await load('cid-related.eml');
  const uris = Object.values(p.inline.byCid);
  assert.equal(uris.length > 0, true, 'no cid mapped');
  assert.ok(p.inline.byCid['logo@acme.example'], `keys: ${Object.keys(p.inline.byCid)}`);
  assert.ok(uris[0].startsWith('data:image/png;base64,'), uris[0].slice(0, 40));
  // Referenced by the body, so it belongs under the embedded-images disclosure.
  assert.equal(p.attachments[0].isInline, true);
});

test('outlook byname fallback maps the filename', async () => {
  const p = await load('cid-outlook-byname.eml');
  assert.ok(p.inline.byName['image001.png'], `keys: ${Object.keys(p.inline.byName)}`);
  assert.equal(p.attachments[0].isInline, true);
});

test('SECURITY: a colliding Content-ID on a mixed attachment does not resolve', async () => {
  const p = await load('cid-collision-mixed.eml');
  // The part is disposition=attachment inside multipart/mixed, so related is not set.
  // It must never enter the inline map, or the body would render attacker-chosen bytes.
  assert.deepEqual(p.inline.byCid, {}, 'collision resolved — injection vector open');
  assert.deepEqual(p.inline.byName, {}, 'collision resolved by filename');
  // And it must remain visible as a real attachment rather than silently disappearing.
  const att = p.attachments.find((a) => a.filename === 'payload.png');
  assert.ok(att, 'attachment vanished');
  assert.equal(att.isInline, false);
});

test('dangling cid maps nothing', async () => {
  const p = await load('cid-unresolved.eml');
  assert.deepEqual(p.inline.byCid, {});
});

// ------------------------------------------------------------------ attachments

test('hostile filenames are all neutralized', async () => {
  const p = await load('evil-filenames.eml');
  assert.ok(p.attachments.length >= 7, `only ${p.attachments.length} attachments`);
  for (const a of p.attachments) {
    assert.ok(!a.filename.includes('/'), `slash: ${a.filename}`);
    assert.ok(!a.filename.includes('\\'), `backslash: ${a.filename}`);
    assert.notEqual(a.filename, '.');
    assert.notEqual(a.filename, '..');
    assert.ok(!a.filename.startsWith('.'), `dotfile: ${a.filename}`);
    assert.ok(a.filename.length <= 120, `length ${a.filename.length}`);
    assert.ok(!/[‪-‮⁦-⁩]/.test(a.filename), `bidi: ${a.filename}`);
  }
  assert.ok(
    p.attachments.some((a) => a.filename === '_CON.txt'),
    `reserved name not escaped: ${p.attachments.map((a) => a.filename).join(', ')}`,
  );
});

test('RFC 2231 filenames decode', async () => {
  const p = await load('rfc2231-filename.eml');
  const names = p.attachments.map((a) => a.filename);
  assert.ok(names.includes('Rechnung März.pdf'), names.join(', '));
  assert.ok(names.includes('年次報告書.pdf'), names.join(', '));
  assert.ok(names.includes('Rechnung.pdf'), names.join(', '));
});

// ------------------------------------------------------------------ notices

test('signed is not reported as encrypted, and the body still renders', async () => {
  const p = await load('smime-signed.eml');
  assert.ok(kinds(p).includes('smime-signed'));
  assert.ok(!kinds(p).includes('smime-encrypted'), 'signed misreported as encrypted');
  assert.equal(p.body.available.text, true, 'signed body did not render');
  const notice = p.notices.find((n) => n.kind === 'smime-signed');
  assert.ok(notice, 'signed notice missing');
  assert.ok(/not verify/i.test(notice.detail ?? ''), 'must not imply a verified signature');
  assert.ok(!notice.blocking);
});

test('encrypted message is blocking with no body', async () => {
  const p = await load('smime-encrypted.eml');
  assert.ok(kinds(p).includes('smime-encrypted'));
  const n = p.notices.find((x) => x.kind === 'smime-encrypted');
  assert.ok(n, 'encrypted notice missing');
  assert.equal(n.blocking, true);
  assert.equal(p.body.available.html || p.body.available.text, false);
});

test('TNEF is detected and explained', async () => {
  const p = await load('winmail.eml');
  assert.ok(kinds(p).includes('tnef'));
  // The plain part still renders, so this is a banner, not a full-pane takeover.
  assert.equal(p.notices.find((n) => n.kind === 'tnef')?.blocking, false);
});

test('multipart with no boundary is diagnosed rather than shown blank', async () => {
  const p = await load('no-boundary.eml');
  assert.ok(kinds(p).includes('missing-boundary'), `notices: ${kinds(p)}`);
});

test('header-only message reports an empty body', async () => {
  const p = await load('empty-body.eml');
  assert.ok(kinds(p).includes('empty-body'));
});

test('nested rfc822 stays a discrete attachment, not merged into the parent', async () => {
  const p = await load('nested-rfc822.eml');
  const nested = p.attachments.filter((a) => a.kind === 'message');
  assert.ok(nested.length >= 1, 'forwarded message was not surfaced as an attachment');
  // rfc822Attachments:true is what keeps the inner body out of the parent's text.
  assert.ok(
    !(p.body.text ?? '').includes('innermost message'),
    'forwarded body leaked into the parent body',
  );
});

// ------------------------------------------------------------------ robustness

test('every fixture parses or degrades without throwing', async () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.eml'));
  assert.ok(files.length >= 25, `only ${files.length} fixtures`);

  for (const f of files) {
    try {
      const p = await load(f);
      assert.equal(typeof p.subject, 'string', `${f}: subject`);
      assert.ok(Array.isArray(p.attachments), `${f}: attachments`);
      assert.ok(Array.isArray(p.notices), `${f}: notices`);
      for (const a of p.attachments) {
        assert.ok(!a.filename.includes('/'), `${f}: unsanitized name ${a.filename}`);
      }
    } catch (err) {
      // garbage.eml is random bytes; a throw here is acceptable ONLY because
      // EmlDocument catches it and converts it to a parse-failed notice.
      assert.equal(f, 'garbage.eml', `${f} threw: ${(err as Error).message}`);
    }
  }
});
