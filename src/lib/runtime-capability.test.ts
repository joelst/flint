import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('runtime process capability', () => {
  it('keeps renderer process control limited to Node version probes', () => {
    const capability = JSON.parse(
      readFileSync(join(process.cwd(), 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
    );

    expect(capability.windows).toContain('main');
    expect(capability.permissions).not.toContain('shell:allow-kill');
    expect(
      capability.permissions.some((permission: unknown) =>
        typeof permission === 'object' &&
        permission !== null &&
        (permission as { identifier?: string }).identifier === 'shell:allow-spawn'
      ),
    ).toBe(false);
    expect(
      capability.permissions.some((permission: unknown) =>
        typeof permission === 'object' &&
        permission !== null &&
        (permission as { identifier?: string }).identifier === 'shell:allow-stdin-write'
      ),
    ).toBe(false);
    expect(
      capability.permissions.some((permission: unknown) =>
        typeof permission === 'object' &&
        permission !== null &&
        (permission as { identifier?: string }).identifier === 'shell:allow-execute'
      ),
    ).toBe(true);
  });
});
