/**
 * Saves CSV text as a file in the browser (D54). Web only: the native app has
 * no export path (exports are a field-laptop function). Returns false when the
 * platform cannot download, so the screen can say so instead of failing silently.
 */
interface DownloadDom {
  document?: {
    createElement(tag: 'a'): { href: string; download: string; rel: string; click(): void; remove(): void };
    body: { appendChild(node: unknown): void };
  };
  URL?: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
  Blob?: typeof Blob;
}

export function downloadCsv(filename: string, csv: string, env: DownloadDom = globalThis as unknown as DownloadDom): boolean {
  const { document, URL, Blob: BlobCtor } = env;
  if (document === undefined || URL === undefined || BlobCtor === undefined) return false;
  // A UTF-8 BOM lets spreadsheet programs detect the encoding; the CSV text itself is unchanged.
  const url = URL.createObjectURL(new BlobCtor(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
