/**
 * Stop Foundry's native listener, including a start that opened a listener but failed before
 * the SDK decoded and published its URL list.
 */
export function stopNativeWebService({ manager, startAttempted }) {
  if (!manager) return false;

  if (startAttempted && !manager.urls?.length) {
    const interop = manager.coreInterop;
    if (typeof interop?.executeCommand !== 'function') {
      throw new Error('Cannot stop a native service whose startup did not publish an address.');
    }
    interop.executeCommand('stop_service');
  } else {
    manager.stopWebService?.();
  }
  return true;
}
