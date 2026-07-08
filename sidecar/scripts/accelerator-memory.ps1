# Enumerate GPU dedicated memory (DXGI + perf counters) and detectable NPUs.
# Output: JSON array of { kind, name, vendor, totalMb, usedMb, freeMb, source }
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$code = @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class FlintDxgiMem {
  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DXGI_ADAPTER_DESC {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Description;
    public uint VendorId, DeviceId, SubSysId, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public LUID AdapterLuid;
  }
  [ComImport, Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIFactory {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    [PreserveSig] int EnumAdapters(uint index, out IntPtr adapter);
  }
  [ComImport, Guid("2411e7e1-12ac-4ccf-bd14-9798e8534dc0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIAdapter {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    void EnumOutputs();
    [PreserveSig] int GetDesc(out DXGI_ADAPTER_DESC desc);
  }
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory(ref Guid riid, out IntPtr ppFactory);
  public class AdapterInfo {
    public string Name;
    public uint VendorId;
    public long DedicatedMb;
    public string LuidKey;
  }
  public static List<AdapterInfo> List() {
    var list = new List<AdapterInfo>();
    Guid iid = new Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369");
    IntPtr pFactory;
    if (CreateDXGIFactory(ref iid, out pFactory) != 0) return list;
    var factory = (IDXGIFactory)Marshal.GetObjectForIUnknown(pFactory);
    for (uint i = 0; ; i++) {
      IntPtr pAdapter;
      if (factory.EnumAdapters(i, out pAdapter) != 0) break;
      var adapter = (IDXGIAdapter)Marshal.GetObjectForIUnknown(pAdapter);
      DXGI_ADAPTER_DESC desc;
      if (adapter.GetDesc(out desc) == 0) {
        long ded = (long)desc.DedicatedVideoMemory.ToUInt64() / 1024L / 1024L;
        string luid = string.Format("luid_0x{0:x8}_0x{1:x8}_phys_0",
          unchecked((uint)desc.AdapterLuid.HighPart), desc.AdapterLuid.LowPart);
        list.Add(new AdapterInfo {
          Name = desc.Description,
          VendorId = desc.VendorId,
          DedicatedMb = ded,
          LuidKey = luid
        });
      }
      Marshal.ReleaseComObject(adapter);
    }
    Marshal.ReleaseComObject(factory);
    return list;
  }
}
'@

try { Add-Type -TypeDefinition $code -ErrorAction Stop } catch {}

$usage = @{}
try {
  Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | ForEach-Object {
    if ($_.Name) { $usage[$_.Name.ToLowerInvariant()] = [int64]$_.DedicatedUsage }
  }
} catch {}

$out = New-Object System.Collections.Generic.List[object]

try {
  foreach ($a in [FlintDxgiMem]::List()) {
    if ($a.VendorId -eq 0x1414) { continue }
    if ($a.Name -match 'Microsoft Basic Render') { continue }

    $usedBytes = $usage[$a.LuidKey.ToLowerInvariant()]
    $usedMb = if ($null -ne $usedBytes) { [int][math]::Round($usedBytes / 1MB) } else { $null }
    $totalMb = [int]$a.DedicatedMb
    $vendor = switch ($a.VendorId) {
      0x10DE { 'nvidia' }
      0x1002 { 'amd' }
      0x8086 { 'intel' }
      default { ('0x{0:X4}' -f $a.VendorId) }
    }

    $out.Add([pscustomobject]@{
      kind    = 'gpu'
      name    = $a.Name
      vendor  = $vendor
      totalMb = $totalMb
      usedMb  = $usedMb
      freeMb  = if ($null -ne $usedMb) { [Math]::Max(0, $totalMb - $usedMb) } else { $null }
      source  = 'dxgi'
    }) | Out-Null
  }
} catch {}

# Fallback if DXGI failed: Win32_VideoController (AdapterRAM often capped at 4GB)
if ($out.Count -eq 0) {
  try {
    Get-CimInstance Win32_VideoController | Where-Object {
      $_.Name -and $_.Name -notmatch 'Microsoft Basic Render|Remote Display'
    } | ForEach-Object {
      $totalMb = $null
      if ($_.AdapterRAM -and $_.AdapterRAM -gt 0) {
        $totalMb = [int][math]::Round([uint64]$_.AdapterRAM / 1MB)
      }
      $name = [string]$_.Name
      $vendor = if ($name -match 'NVIDIA|GeForce|RTX|Quadro') { 'nvidia' }
        elseif ($name -match 'AMD|Radeon') { 'amd' }
        elseif ($name -match 'Intel') { 'intel' }
        else { $null }
      $out.Add([pscustomobject]@{
        kind    = 'gpu'
        name    = $name
        vendor  = $vendor
        totalMb = $totalMb
        usedMb  = $null
        freeMb  = $null
        source  = 'wmi'
      }) | Out-Null
    }
  } catch {}
}

# NPUs (often no discrete pool to report).
# Use word boundaries so "Input" does not match the substring "npu".
try {
  Get-PnpDevice -Status OK -ErrorAction SilentlyContinue |
    Where-Object {
      $_.FriendlyName -match '(?i)(\bNPU\b|Neural Processing|AI Boost|Hexagon\s+NPU|Intel\(R\)\s+AI\s+Boost)'
    } |
    ForEach-Object {
      $out.Add([pscustomobject]@{
        kind    = 'npu'
        name    = $_.FriendlyName
        vendor  = $null
        totalMb = $null
        usedMb  = $null
        freeMb  = $null
        source  = 'pnp'
      }) | Out-Null
    }
} catch {}

if ($out.Count -eq 0) {
  '[]'
} else {
  $out | ConvertTo-Json -Compress
}
