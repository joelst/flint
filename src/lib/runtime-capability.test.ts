import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('runtime process capability', () => {
  it('allows the main window to terminate its owned sidecar after graceful shutdown times out', () => {
    const capability = JSON.parse(
      readFileSync(join(process.cwd(), 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
    );

    expect(capability.windows).toContain('main');
    expect(capability.permissions).toContain('shell:allow-kill');
  });
});
