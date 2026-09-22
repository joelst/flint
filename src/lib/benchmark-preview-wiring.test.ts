import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src', 'lib', 'BenchmarkPreview.svelte'),
  'utf8',
);

describe('benchmark editor wiring', () => {
  it('preserves raw generation-setting text until suite validation', () => {
    const setterStart = source.indexOf('function setDraftNumber(');
    const setterEnd = source.indexOf('async function importCasesFile', setterStart);
    expect(setterStart).toBeGreaterThan(-1);
    expect(setterEnd).toBeGreaterThan(setterStart);
    const setter = source.slice(setterStart, setterEnd);
    expect(setter).toContain('[field]: raw');
    expect(setter).not.toContain('optionalDraftNumber');

    const temperatureStart = source.indexOf('Temperature');
    const maxTokensStart = source.indexOf('Max tokens', temperatureStart);
    expect(temperatureStart).toBeGreaterThan(-1);
    expect(maxTokensStart).toBeGreaterThan(temperatureStart);
    expect(source.slice(temperatureStart, maxTokensStart)).toContain('type="text"');
    expect(source.slice(temperatureStart, maxTokensStart)).toContain('inputmode="decimal"');
  });

  it('uses runtime-selected consistently for alias-only benchmark targets', () => {
    expect(source).toContain('<option value="">Runtime-selected variant</option>');
  });
});
