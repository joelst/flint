import { describe, expect, it } from 'vitest';
import { mergeAcceleratorDevices } from './accelerator-merge.js';

const U1 = 'GPU-11111111-aaaa';
const U2 = 'GPU-22222222-bbbb';

describe('mergeAcceleratorDevices', () => {
  it('keeps identical nvidia-smi cards separate by uuid', () => {
    const nvidia = [
      { kind: 'gpu', name: 'RTX 4090', vendor: 'nvidia', deviceId: U1, source: 'nvidia-smi' },
      { kind: 'gpu', name: 'RTX 4090', vendor: 'nvidia', deviceId: U2, source: 'nvidia-smi' },
    ];
    expect(mergeAcceleratorDevices(nvidia, [])).toHaveLength(2);
  });

  it.each(['dxgi', 'wmi'])('drops a covered %s NVIDIA duplicate', (source) => {
    const nvidia = [{ kind: 'gpu', name: 'NVIDIA GeForce RTX 4090', vendor: 'nvidia', deviceId: U1, source: 'nvidia-smi' }];
    const others = [{ kind: 'gpu', name: 'NVIDIA GeForce RTX 4090', vendor: 'nvidia', source }];
    expect(mergeAcceleratorDevices(nvidia, others).map((d) => d.source)).toEqual(['nvidia-smi']);
  });

  it('keeps non-NVIDIA wmi rows', () => {
    const nvidia = [{ kind: 'gpu', name: 'RTX 4090', vendor: 'nvidia', deviceId: U1, source: 'nvidia-smi' }];
    const others = [{ kind: 'gpu', name: 'Intel Arc', vendor: 'intel', source: 'wmi' }];
    expect(mergeAcceleratorDevices(nvidia, others)).toHaveLength(2);
  });
});
