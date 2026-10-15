import { describe, expect, it } from 'vitest';
import {
  RUNTIME_GPU_KEY,
  cudaVisibleAccelerators,
  normalizeRuntimeGpu,
  readRuntimeGpu,
  runtimeGpuChoices,
  runtimeGpuPanelVisible,
  writeRuntimeGpu,
} from './runtime-gpu';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const UUID = 'GPU-3f2a9c1e-1111-2222-3333-444455556666';

describe('normalizeRuntimeGpu', () => {
  it('accepts a GPU uuid and an index list', () => {
    expect(normalizeRuntimeGpu(UUID)).toBe(UUID);
    expect(normalizeRuntimeGpu(' 0,1 ')).toBe('0,1');
  });

  it.each(['', 'auto', 'GPU-', 'GPU-zz', '0;calc', '-1', '1,', '123', 'MIG-abc12345', null, 3, undefined])(
    'treats %j as automatic',
    (value) => {
      expect(normalizeRuntimeGpu(value)).toBe('');
    },
  );
});

describe('read/write', () => {
  it('round-trips and clears', () => {
    const s = memoryStorage();
    expect(writeRuntimeGpu(s, UUID)).toBe(true);
    expect(readRuntimeGpu(s)).toBe(UUID);
    expect(writeRuntimeGpu(s, '')).toBe(true);
    expect(s.data.has(RUNTIME_GPU_KEY)).toBe(false);
  });

  it('ignores an invalid stored value', () => {
    expect(readRuntimeGpu(memoryStorage({ [RUNTIME_GPU_KEY]: '0;x' }))).toBe('');
  });

  it('reports a failed write and survives a throwing read', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {},
    };
    expect(writeRuntimeGpu(throwing, UUID)).toBe(false);
    expect(readRuntimeGpu(throwing)).toBe('');
    expect(writeRuntimeGpu(null, UUID)).toBe(false);
    expect(readRuntimeGpu(null)).toBe('');
  });
});

describe('runtimeGpuChoices', () => {
  it('lists only GPUs with a stable uuid', () => {
    expect(
      runtimeGpuChoices([
        { kind: 'gpu', name: 'RTX 5090', deviceId: UUID },
        { kind: 'gpu', name: 'No identity' },
        { kind: 'npu', name: 'NPU', deviceId: UUID },
        { kind: 'gpu', name: 'Bad', deviceId: '0' },
      ]),
    ).toEqual([{ deviceId: UUID, label: 'RTX 5090' }]);
    expect(runtimeGpuChoices(undefined)).toEqual([]);
  });

  it('adds the uuid to labels when names repeat', () => {
    const other = 'GPU-aaaaaaaa-1111-2222-3333-444455556666';
    expect(
      runtimeGpuChoices([
        { kind: 'gpu', name: 'RTX 4090', deviceId: UUID },
        { kind: 'gpu', name: 'RTX 4090', deviceId: other },
        { kind: 'gpu', name: 'RTX 3060', deviceId: 'GPU-bbbbbbbb' },
      ]).map((c) => c.label),
    ).toEqual([`RTX 4090 (${UUID})`, `RTX 4090 (${other})`, 'RTX 3060']);
  });
});

describe('runtimeGpuPanelVisible', () => {
  const base = { choiceCount: 0, current: '', appliedAtLaunch: '', saveFailed: false };
  it('hides when there is nothing to choose or say', () => {
    expect(runtimeGpuPanelVisible(base)).toBe(false);
    expect(runtimeGpuPanelVisible({ ...base, choiceCount: 1 })).toBe(false);
  });
  it.each([
    { choiceCount: 2 },
    { current: UUID },
    { appliedAtLaunch: UUID },
    { saveFailed: true },
  ])('shows for %j', (patch) => {
    expect(runtimeGpuPanelVisible({ ...base, ...patch })).toBe(true);
  });
});

describe('cudaVisibleAccelerators', () => {
  const other = 'GPU-aaaaaaaa-1111-2222-3333-444455556666';
  const list = [
    { kind: 'gpu', name: 'A', vendor: 'nvidia', deviceId: UUID },
    { kind: 'gpu', name: 'B', vendor: 'nvidia', deviceId: other },
    { kind: 'gpu', name: 'Intel', vendor: 'intel' },
    { kind: 'npu', name: 'NPU' },
  ];
  it('keeps everything with no selector or an index selector', () => {
    expect(cudaVisibleAccelerators(list, '')).toHaveLength(4);
    expect(cudaVisibleAccelerators(list, '0')).toHaveLength(4);
    expect(cudaVisibleAccelerators(undefined, UUID)).toEqual([]);
  });
  it('drops other NVIDIA GPUs but keeps non-NVIDIA devices', () => {
    expect(cudaVisibleAccelerators(list, UUID).map((a) => a.name)).toEqual(['A', 'Intel', 'NPU']);
  });
  it('drops an NVIDIA row without identity', () => {
    expect(cudaVisibleAccelerators([{ kind: 'gpu', name: 'X', vendor: 'nvidia' }], UUID)).toEqual([]);
  });
});
