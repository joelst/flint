import { describe, expect, it } from 'vitest';
import {
  RUNTIME_GPU_KEY,
  cudaVisibleAccelerators,
  isCudaVariant,
  planVramAdmission,
  normalizeRuntimeGpu,
  readRuntimeGpu,
  runtimeGpuChoices,
  runtimeGpuPanelVisible,
  runtimeGpuRestartRequired,
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

describe('runtimeGpuRestartRequired', () => {
  it('does not report a pending change for an empty picker with inherited visibility', () => {
    expect(runtimeGpuRestartRequired('', UUID, 'inherited')).toBe(false);
  });

  it('still reports a saved selection change from inherited visibility', () => {
    expect(runtimeGpuRestartRequired('GPU-aaaaaaaa-1111-2222-3333-444455556666', UUID, 'inherited')).toBe(true);
  });

  it('compares configured selections to the running selector', () => {
    expect(runtimeGpuRestartRequired('', UUID, 'configured')).toBe(true);
    expect(runtimeGpuRestartRequired(UUID, UUID, 'configured')).toBe(false);
  });
});

describe('planVramAdmission', () => {
  const view = (free: number, total = free) => ({
    count: 1,
    maxFreeMb: free,
    freeMb: free,
    totalMb: total,
    telemetryKnown: true,
  });
  const none = { count: 0, maxFreeMb: 0, freeMb: 0, totalMb: 0, telemetryKnown: false };

  it('checks CUDA against the CUDA view and others against the full inventory', () => {
    // 4 GB visible to CUDA, 24 GB overall
    const r = planVramAdmission([8000], [], view(4000), view(24000));
    expect(r.okOne).toBe(false);
    expect(planVramAdmission([], [8000], view(4000), view(24000)).okOne).toBe(true);
  });

  it('reports the failing provider budget in a mixed run', () => {
    const r = planVramAdmission([8000], [10000], view(4000), view(24000));
    expect(r.oneFailures).toEqual([{ view: 'cuda', provider: 'cuda', needMb: 8000, budgetMb: 3680 }]);
    expect(r.allFailures).toEqual(r.oneFailures);
  });

  it('does not treat missing CUDA telemetry as zero in a mixed run', () => {
    const r = planVramAdmission([2000], [2000], none, view(24000));
    expect(r.unknown).toBe(true);
    expect(r.okAll).toBe(true);
    expect(r.okOne).toBe(true);
  });

  it('still enforces the known class when the other is unknown', () => {
    const r = planVramAdmission([2000], [30000], none, view(24000));
    expect(r.unknown).toBe(true);
    expect(r.okOne).toBe(false);
  });

  it('checks the combined total only when every needed class is known', () => {
    const known = planVramAdmission([10000], [10000], view(20000), view(15000));
    expect(known.okAll).toBe(false);
    expect(known.allFailures).toContainEqual({
      view: 'all',
      provider: 'combined',
      needMb: 20000,
      budgetMb: 14488,
    });
    expect(planVramAdmission([10000], [10000], none, view(15000)).okAll).toBe(true);
  });

  it('is unknown, not failing, with no telemetry at all', () => {
    const r = planVramAdmission([5000], [], none, none);
    expect(r).toMatchObject({ okAll: true, okOne: true, unknown: true, displayView: 'cuda' });
  });

  it('rejects a known zero-free budget instead of treating it as missing telemetry', () => {
    const exhausted = view(0, 8192);
    expect(planVramAdmission([1], [], exhausted, exhausted)).toMatchObject({
      okAll: false,
      okOne: false,
      unknown: false,
    });
  });
});

describe('isCudaVariant', () => {
  it('uses the provider when known, else the variant id', () => {
    expect(isCudaVariant('CUDAExecutionProvider', 'x')).toBe(true);
    expect(isCudaVariant('DmlExecutionProvider', 'm-cuda-gpu:1')).toBe(false);
    expect(isCudaVariant('', 'qwen3-0.6b-cuda-gpu:4')).toBe(true);
    expect(isCudaVariant('', 'qwen3-0.6b-generic-gpu:4')).toBe(false);
    expect(isCudaVariant(undefined, undefined)).toBe(false);
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
  it('filters inherited visibility lists containing multiple GPU UUIDs', () => {
    const third = 'GPU-bbbbbbbb-1111-2222-3333-444455556666';
    const devices = [
      ...list,
      { kind: 'gpu', name: 'C', vendor: 'nvidia', deviceId: third },
    ];
    expect(cudaVisibleAccelerators(devices, `${UUID},${other}`).map((a) => a.name)).toEqual([
      'A',
      'B',
      'Intel',
      'NPU',
    ]);
  });
  it('drops an NVIDIA row without identity', () => {
    expect(cudaVisibleAccelerators([{ kind: 'gpu', name: 'X', vendor: 'nvidia' }], UUID)).toEqual([]);
  });
});
