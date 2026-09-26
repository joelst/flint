import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadCaptionFiles } from './caption-download';

describe('downloadCaptionFiles', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: 'SRT captions and timing note',
      files: [
        { fileName: 'captions.srt', body: '1\n00:00:00,000 --> 00:00:01,000\nhello' },
        { fileName: 'captions.timing.txt', body: 'approximate timings' },
      ],
    },
    {
      name: 'timing note only',
      files: [{ fileName: 'captions.timing.txt', body: 'no captions were recognized' }],
    },
    {
      name: 'VTT captions',
      files: [{ fileName: 'captions.vtt', body: 'WEBVTT\n\nhello' }],
    },
  ])('revokes each $name URL only after the download delay', ({ files }) => {
    vi.useFakeTimers();
    const urls = files.map((_, index) => `blob:caption-${index}`);
    let nextUrl = 0;
    const createObjectURL = vi.fn(() => urls[nextUrl++]);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadCaptionFiles(files);

    expect(click).toHaveBeenCalledTimes(files.length);
    expect(createObjectURL).toHaveBeenCalledTimes(files.length);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(9999);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL.mock.calls).toEqual(urls.map((url) => [url]));
  });
});
