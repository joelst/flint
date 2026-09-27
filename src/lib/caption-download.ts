import type { CaptionArtifact } from './transcript-format';

/**
 * Hand one file to the browser's download flow.
 *
 * Deliberately takes a single artifact rather than a list: clicking a second generated
 * anchor can trip the host WebView's multiple-automatic-download permission, and the
 * page is never told whether a download was accepted, so a dropped file is
 * indistinguishable from a saved one. Callers that need to deliver several files
 * together must archive them first.
 */
export function downloadCaptionArtifact(artifact: CaptionArtifact): void {
  const blob = new Blob([artifact.body], { type: artifact.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = artifact.fileName;
  anchor.click();
  // The download reads the blob asynchronously, so revoking immediately can truncate it.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
