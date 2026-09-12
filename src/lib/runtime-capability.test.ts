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

  it('keeps the frontend and native runtime frame limits synchronized', () => {
    const sdk = readFileSync(join(process.cwd(), 'src', 'lib', 'sdk.ts'), 'utf8');
    const rust = readFileSync(
      join(process.cwd(), 'src-tauri', 'src', 'runtime_manager.rs'),
      'utf8',
    );
    expect(sdk).toContain('NATIVE_RUNTIME_MAX_FRAME_BYTES = 80 * 1024 * 1024');
    expect(rust).toContain('MAX_RUNTIME_FRAME_BYTES: usize = 80 * 1024 * 1024');
  });
});
