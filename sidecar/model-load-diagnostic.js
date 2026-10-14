/**
 * Recognize the allocator signature, not every CUDA or out-of-memory failure.
 * Keep import-free so the status bar and native load boundary share the advice.
 * @param {string} detail
 * @returns {string | null}
 */
export function cudaAllocatorDiagnostic(detail) {
  if (!/Failed to create allocator for CUDA:\s*No requested allocator available/i.test(detail)) {
    return null;
  }
  return 'CUDA could not initialize a GPU allocator. This can involve GPU visibility, the driver, ' +
    'or the runtime; the error does not establish which. In Models, use Recheck Providers and ' +
    'check your NVIDIA driver. If multiple NVIDIA GPUs are present, choose one under Models → ' +
    'Runtime GPU and restart Flint (or launch with CUDA_VISIBLE_DEVICES=0). Alternatively, explicitly ' +
    'select a downloaded CPU variant. Flint has not retried or switched devices automatically.';
}

/**
 * All pool loads (including gateway autoload and resident reload) use this boundary.
 * @param {{ load: () => Promise<void> }} model
 * @returns {Promise<void>}
 */
export async function loadModelWithDiagnostic(model) {
  try {
    await model.load();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const diagnostic = cudaAllocatorDiagnostic(detail);
    if (!diagnostic) throw error;
    throw new Error(`${diagnostic}\nRuntime detail: ${detail}`, { cause: error });
  }
}
