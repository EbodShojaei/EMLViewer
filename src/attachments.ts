import * as vscode from 'vscode';
import type { AttachmentVm } from './shared/types.ts';
import { extFromMime, safeFileName } from './model/safeName.ts';

/** Remembered between saves so a second Save As starts where the first one landed. */
let lastSaveDir: vscode.Uri | undefined;

/**
 * `Uri.joinPath` NORMALIZES `..` rather than rejecting it, so a name that slipped past
 * safeFileName would silently produce a path outside the target directory. This check
 * after the join is the load-bearing guard; the sanitizer is the first line, not the only one.
 *
 * Not needed for a user-chosen Save As path, but this is the primitive any future
 * Save All must go through.
 */
export function assertContained(dir: vscode.Uri, target: vscode.Uri): void {
  const base = dir.path.replace(/\/+$/, '') + '/';
  if (target.scheme !== dir.scheme || !target.path.startsWith(base)) {
    throw new Error('Refusing to write outside the selected folder');
  }
}

function filtersFor(mimeType: string): Record<string, string[]> | undefined {
  const ext = extFromMime(mimeType);
  if (ext === 'bin') return undefined;
  const label = ext.toUpperCase();
  return { [label]: [ext], 'All Files': ['*'] };
}

function defaultDir(): vscode.Uri {
  if (lastSaveDir) return lastSaveDir;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folder) return folder;
  return vscode.Uri.file(process.env.HOME ?? '/');
}

export async function saveAttachment(meta: AttachmentVm, bytes: Uint8Array): Promise<void> {
  // meta.filename is already sanitized in buildPayload; re-running is cheap and means this
  // function is safe to call with a name from any source.
  const name = safeFileName(meta.filename, extFromMime(meta.mimeType), meta.index);

  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(defaultDir(), name),
    saveLabel: 'Save Attachment',
    filters: filtersFor(meta.mimeType),
  });
  if (!target) return;

  await vscode.workspace.fs.writeFile(target, bytes);
  lastSaveDir = vscode.Uri.joinPath(target, '..');

  const reveal = await vscode.window.showInformationMessage(
    `Saved ${target.path.split('/').pop()}`,
    'Reveal in Finder',
  );
  if (reveal) await vscode.commands.executeCommand('revealFileInOS', target);
}
