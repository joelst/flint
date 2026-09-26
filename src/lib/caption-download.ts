import type { CaptionDownload } from './transcript-format';

export function downloadCaptionFiles(files: readonly CaptionDownload[]): void {
  for (const file of files) {
    const blob = new Blob([file.body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}
