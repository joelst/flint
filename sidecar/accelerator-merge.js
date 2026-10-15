/**
 * Accelerator telemetry merge. Import-free so tests can load it without starting the sidecar.
 */

export function vendorFromName(name) {
  const s = String(name || '').toLowerCase();
  if (s.includes('nvidia') || s.includes('geforce') || s.includes('rtx') || s.includes('quadro')) return 'nvidia';
  if (s.includes('amd') || s.includes('radeon')) return 'amd';
  if (s.includes('intel') || s.includes('arc ')) return 'intel';
  if (s.includes('qualcomm') || s.includes('hexagon') || s.includes('npu')) return 'npu-vendor';
  return null;
}

/** Name-only probes: they cannot tell identical cards apart and may cap or misreport memory. */
const NAME_ONLY_SOURCES = new Set(['dxgi', 'wmi']);

/**
 * Prefer nvidia-smi rows for NVIDIA devices; keep other probes for non-NVIDIA devices and NPUs.
 * nvidia-smi rows are keyed by UUID, so identical cards stay separate. A DXGI or WMI row for an
 * NVIDIA card that nvidia-smi already reported is a duplicate and is dropped.
 */
export function mergeAcceleratorDevices(nvidia, others) {
  const byKey = new Map();
  const keyOf = (d) => `${d.kind}:${d.deviceId || d.name.toLowerCase()}`;

  for (const d of others || []) {
    byKey.set(keyOf(d), d);
  }
  for (const d of nvidia || []) {
    byKey.set(keyOf(d), d);
  }

  if ((nvidia || []).length > 0) {
    for (const [k, d] of [...byKey.entries()]) {
      if (NAME_ONLY_SOURCES.has(d.source) && (d.vendor === 'nvidia' || vendorFromName(d.name) === 'nvidia')) {
        const covered = nvidia.some((n) => {
          const a = n.name.toLowerCase();
          const b = d.name.toLowerCase();
          return a === b || a.includes(b) || b.includes(a);
        });
        if (covered) byKey.delete(k);
      }
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'gpu' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
