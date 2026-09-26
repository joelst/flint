import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import TranscriptViewToggle from './TranscriptViewToggle.svelte';

describe('TranscriptViewToggle', () => {
  it('exposes exactly one selected native button and updates it on activation', async () => {
    render(TranscriptViewToggle, {
      showTimestampedTranscript: true,
      segmentCount: 3,
    });

    const plainText = screen.getByRole('button', { name: 'Plain text' });
    const estimatedTimes = screen.getByRole('button', { name: 'Estimated times (3)' });

    expect(plainText.tagName).toBe('BUTTON');
    expect(estimatedTimes.tagName).toBe('BUTTON');
    expect(plainText.getAttribute('type')).toBe('button');
    expect(estimatedTimes.getAttribute('type')).toBe('button');
    expect(plainText.getAttribute('aria-pressed')).toBe('false');
    expect(estimatedTimes.getAttribute('aria-pressed')).toBe('true');

    plainText.focus();
    await fireEvent.click(plainText);
    expect(document.activeElement).toBe(plainText);
    expect(plainText.getAttribute('aria-pressed')).toBe('true');
    expect(estimatedTimes.getAttribute('aria-pressed')).toBe('false');

    estimatedTimes.focus();
    await fireEvent.click(estimatedTimes);
    expect(document.activeElement).toBe(estimatedTimes);
    expect(plainText.getAttribute('aria-pressed')).toBe('false');
    expect(estimatedTimes.getAttribute('aria-pressed')).toBe('true');
  });
});
