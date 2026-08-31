/**
 * The only script permitted to run inside the email body iframe.
 *
 * The iframe's CSP is `script-src 'sha256-<hash of this exact string>'`. Any other inline
 * script in the email has different bytes and is refused; `<script src>` is refused because
 * no host is allowed; `onerror=`/`onclick=` handlers are refused because hash and nonce
 * sources explicitly do not whitelist inline event handlers.
 *
 * This file is imported by BOTH bundles so the hashed bytes and the injected bytes are
 * provably the same string. Do not reformat it, do not let a build step touch it, and do
 * not trim it at the injection site — the hash is over the script element's exact text
 * content, whitespace included.
 *
 * Two jobs:
 *   1. Report document height so the frame can size itself. Without this the body would
 *      need a fixed-height pane with its own scrollbar.
 *   2. Intercept link clicks and forward them to the parent. The frame has an opaque
 *      origin, so this is the only way a click can reach the extension host, where the
 *      single link policy lives.
 *
 * Contains no `<` or `>` so it can never terminate its own script element early; the
 * invariant is asserted at module load below.
 */
export const FRAME_SHIM =
  '(function(){' +
  'var P=window.parent,post=P.postMessage.bind(P),last=-1,MAXH=200000;' +
  'function report(){' +
  'var d=document.documentElement,b=document.body;' +
  'var h=Math.max(d.scrollHeight||0,b?b.scrollHeight||0:0,d.offsetHeight||0);' +
  'if(h!==last){last=h;post({__eml:1,type:"height",height:Math.min(h,MAXH)},"*");}' +
  '}' +
  'document.addEventListener("click",function(e){' +
  'var n=e.target;' +
  'while(n&&n.nodeType===1&&n.tagName!=="A"&&n.tagName!=="AREA"){n=n.parentNode;}' +
  'if(!n||n.nodeType!==1){return;}' +
  'e.preventDefault();e.stopPropagation();' +
  'var h=n.getAttribute("href");' +
  'if(h){post({__eml:1,type:"link",href:String(h).slice(0,4096),' +
  'text:String(n.textContent||"").trim().slice(0,200)},"*");}' +
  '},true);' +
  'document.addEventListener("load",report,true);' +
  'document.addEventListener("DOMContentLoaded",report);' +
  'window.addEventListener("load",report);' +
  'window.addEventListener("resize",report);' +
  'if(window.ResizeObserver){new ResizeObserver(report).observe(document.documentElement);}' +
  'setTimeout(report,0);setTimeout(report,120);setTimeout(report,600);' +
  '})();';

// Build-time invariant. If this ever fires, the shim could break out of its own
// <script> element and the CSP hash would be the least of the problems.
if (/[<>]/.test(FRAME_SHIM)) {
  throw new Error('FRAME_SHIM must not contain angle brackets');
}

/** Base CSS for the email frame, injected after the shim and before the email's own styles. */
export const FRAME_RESET_CSS = [
  // Emails are authored against an implicit white canvas. Without `only light`, a machine
  // in OS dark mode renders this frame's scrollbars and form controls dark on white, and
  // any email carrying @media (prefers-color-scheme: dark) fires those rules onto white.
  ':root{color-scheme:only light}',
  'html,body{margin:0;padding:0;background:#fff;color:#1a1a1a}',
  'body{padding:16px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
  'overflow-wrap:break-word;-webkit-text-size-adjust:100%}',
  // Images are clamped; tables deliberately are NOT. Clamping a 1200px table does not make
  // it fit, it mangles the cells. Honest horizontal scroll is the better failure.
  'img{max-width:100%;height:auto;border:0}',
  'pre{white-space:pre-wrap;overflow-wrap:anywhere}',
  'blockquote{margin:0 0 0 12px;padding-left:12px;border-left:2px solid #ddd}',
  'a{color:#0b57d0}',
  // A blocked remote image that renders as a transparent 1x1 makes the blocking invisible
  // and the email just looks broken. Real images get a visible placeholder...
  '[data-eml-blocked="visible"],[data-eml-blocked="missing"]{display:inline-block;',
  'min-width:32px;min-height:32px;box-sizing:border-box;border:1px dashed #c4c4c4;',
  'border-radius:4px;background:#f4f4f4}',
  // ...while declared 1x1 trackers are simply removed, so the page is not littered with dots.
  '[data-eml-blocked="pixel"]{display:none!important}',
  '[data-eml-oversize]{display:inline-block;min-width:120px;min-height:60px;box-sizing:border-box;',
  'border:1px solid #d0d0d0;border-radius:3px;background:#fafafa}',
].join('');
