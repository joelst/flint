import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import TranscriptSegmentTime from './TranscriptSegmentTime.svelte';

describe('TranscriptSegmentTime', () => {
  it('renders the time range for every boundary type', () => {
    render(TranscriptSegmentTime, { startSec: 5, endSec: 33, endBoundary: 'pause-snapped' });
    expect(screen.getByText('0:05 – 0:33')).toBeTruthy();
  });

  it('exposes boundary provenance as always-visible text, not just color or hover', () => {
    const cases: Array<[TranscriptSegmentTimeBoundary, string]> = [
      ['pause-snapped', 'End: detected pause'],
      ['recording-edge', 'End: recording edge'],
      ['fixed-window', 'End: fixed cut'],
    ];
    for (const [endBoundary, expectedLabel] of cases) {
      const { unmount } = render(TranscriptSegmentTime, { startSec: 0, endSec: 28, endBoundary });
      const label = screen.getByText(expectedLabel);
      // Visible text, not merely present in the DOM behind aria-hidden/display:none/a hover-only title.
      expect(label.getAttribute('aria-hidden')).not.toBe('true');
      expect(getComputedStyle(label).display).not.toBe('none');
      expect(label.hasAttribute('title')).toBe(false);
      unmount();
    }
  });

  it('renders no boundary label when the boundary is unknown', () => {
    render(TranscriptSegmentTime, { startSec: 0, endSec: 10, endBoundary: undefined });
    expect(screen.queryByText(/^End:/)).toBeNull();
  });
});

type TranscriptSegmentTimeBoundary = 'recording-edge' | 'pause-snapped' | 'fixed-window';
