import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * VS Code does NOT supply the codicon font to webviews — an extension has to ship it.
 * Without this every `class="codicon codicon-*"` span renders as nothing, which is easy
 * to miss because it fails silently rather than showing tofu.
 */
function copyCodicons() {
  const from = path.join('node_modules', '@vscode', 'codicons', 'dist');
  fs.mkdirSync('media', { recursive: true });
  for (const f of ['codicon.css', 'codicon.ttf']) {
    fs.copyFileSync(path.join(from, f), path.join('media', f));
  }
}
copyCodicons();

/** Reports build start/end in a form the VS Code problem matcher understands. */
const problemMatcher = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
      }
      console.log('[watch] build finished');
    });
  },
};

/** Extension host bundle. `vscode` is injected at runtime and must stay external. */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'warning',
  plugins: [problemMatcher],
};

/** Webview bundle. Runs in Chromium, so no Node builtins and no module wrapper. */
const webviewConfig = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome110',
  outfile: 'media/main.js',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'warning',
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
}
