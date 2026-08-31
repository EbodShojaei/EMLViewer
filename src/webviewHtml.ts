import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { FRAME_SHIM } from './shared/frameShim.ts';

/**
 * The sha256 of the frame shim, computed once from the exact bytes that will be injected.
 * The iframe's CSP names this hash as the only permitted inline script source.
 *
 * Exported so the webview bundle receives it through the shell rather than recomputing it —
 * one source of truth, and any drift becomes a visible "shim did not run" failure rather
 * than a silent security regression.
 */
export const SHIM_HASH = crypto.createHash('sha256').update(FRAME_SHIM, 'utf8').digest('base64');

/** Crypto-strength nonce. The official VS Code sample uses Math.random(); do not copy it. */
export function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export interface ShellOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  /** Must be the same value the sanitizer will be told, in the same round trip. */
  allowRemote: boolean;
}

/**
 * The outer webview document.
 *
 * VS Code injects NO default CSP — an absent policy means no restrictions at all, and only
 * fires a telemetry ping. This meta tag is the whole enforcement boundary.
 *
 * `img-src` deliberately omits `https:` unless the user has opted in. That single omission
 * is what stops a tracking pixel from firing even if the sanitizer is bypassed, and it is
 * why toggling remote images requires regenerating this document rather than patching the DOM.
 *
 * `style-src` needs 'unsafe-inline' because real email HTML is wall-to-wall style="".
 * Inline styles are not script; `script-src` never gets it.
 */
export function buildShellHtml(opts: ShellOptions): string {
  const { webview, extensionUri, allowRemote } = opts;
  const nonce = getNonce();
  // Both schemes once the user has opted in. Restricting to https: would leave older
  // mail showing broken images with no explanation, which reads as a bug rather than a
  // policy. Chromium's own mixed-content rules still apply on top of this.
  const remote = allowRemote ? ' http: https:' : '';

  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
  // Shipped by this extension, not provided by the host — see copyCodicons() in esbuild.mjs.
  // The font itself is covered by `font-src ${webview.cspSource}` below.
  const codiconUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'codicon.css'),
  );

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:${remote}`,
    `media-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    // The shim hash MUST appear here, in the shell policy, not only in the iframe's own.
    // A srcdoc document inherits this policy, and CSP composes by intersection — an inner
    // policy can only tighten, never re-permit. Verified empirically: with the hash only
    // on the inner policy the shim is refused, the frame never reports its height, and
    // the body silently collapses to the fallback. Safe to grant: the shell document is
    // built entirely by this extension and email HTML never enters it, only the srcdoc.
    `script-src 'nonce-${nonce}' 'sha256-${SHIM_HASH}'`,
    `frame-src 'self' data:`,
    `form-action 'none'`,
    `connect-src 'none'`,
  ].join('; ');

  const bootstrap = JSON.stringify({ shimHash: SHIM_HASH, allowRemote });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${codiconUri}" rel="stylesheet">
<link href="${styleUri}" rel="stylesheet">
<title>Email Preview</title>
</head>
<body>
<a class="eml-skip" href="#eml-body">Skip to message body</a>
<div id="eml-root" class="eml-root"></div>
<div id="eml-live" class="eml-vh" role="status" aria-live="polite"></div>
<script nonce="${nonce}">window.__EML_BOOTSTRAP__ = ${bootstrap};</script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
