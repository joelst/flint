import { afterEach } from 'vitest';

const hasDom =
  typeof window !== 'undefined' &&
  typeof document !== 'undefined';

if (hasDom) {
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/svelte');
    cleanup();
  });
}
