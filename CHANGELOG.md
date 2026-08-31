# Changelog

## 1.0.0

Initial public release.

- Custom read-only editor for `*.eml`, rendering headers, HTML and plain-text bodies.
- Remote images and tracking pixels blocked by Content-Security-Policy, with a one-click
  opt-in. Verified at a socket rather than in developer tools.
- Email HTML isolated in an opaque-origin sandboxed frame; script execution refused by a
  hash-pinned `script-src`.
- Inline `cid:` images resolved from `multipart/related` parts only.
- Attachment list with Save As and filename sanitization.
- Non-UTF-8 mail decoded correctly by reading bytes rather than text.
- Reload on file change.
