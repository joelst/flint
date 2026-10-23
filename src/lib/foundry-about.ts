export interface FoundryRuntimeReport {
  sdkVersion: string | null;
  coreVersion: string | null;
  sdkPin: string | null;
  corePin: string | null;
}

export interface FoundryAboutLine {
  label: string;
  /** True when the loaded SDK and core match Flint's pin. Null while the version is unknown. */
  ok: boolean | null;
}

function cleanVersion(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * About row for the Foundry SDK the running sidecar loaded.
 * A missing report stays "Checking…". A report with no SDK version is "Unknown".
 */
export function foundrySdkAboutLine(report: FoundryRuntimeReport | null): FoundryAboutLine {
  if (!report) return { label: "Checking…", ok: null };
  const sdk = cleanVersion(report.sdkVersion);
  const core = cleanVersion(report.coreVersion);
  const sdkPin = cleanVersion(report.sdkPin);
  const corePin = cleanVersion(report.corePin);
  if (!sdk) return { label: "Unknown", ok: null };

  const coreNote = core && core !== sdk ? ` · core ${core}` : "";
  const sdkMismatch = Boolean(sdkPin) && sdk !== sdkPin;
  const coreMismatch = Boolean(core) && Boolean(corePin) && core !== corePin;
  if (sdkMismatch || coreMismatch) {
    const expectedPin = sdkPin ?? corePin;
    return { label: `${sdk}${coreNote} (tested on ${expectedPin})`, ok: false };
  }
  return { label: `${sdk}${coreNote}`, ok: true };
}
