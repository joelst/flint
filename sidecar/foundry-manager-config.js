/**
 * FoundryLocalManager.create config. The manager is process-global, so
 * useSharedHost has to be chosen here. The field is omitted when off, which
 * keeps the SDK default. Hosted mode does not fall back to an in-process manager.
 */

const SHARED_HOST_ENDPOINT_ERROR =
  'Shared host cannot be combined with serviceEndpoint. Flint will not fall back to an in-process manager.';

function hasServiceEndpoint(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * @param {{
 *   appName: string,
 *   logLevel: string,
 *   libraryPath: string,
 *   useSharedHost?: boolean,
 *   serviceEndpoint?: string,
 * }} options
 */
export function foundryManagerCreateConfig(options) {
  if (options?.useSharedHost === true && hasServiceEndpoint(options.serviceEndpoint)) {
    throw new Error(SHARED_HOST_ENDPOINT_ERROR);
  }
  const config = {
    appName: options.appName,
    logLevel: options.logLevel,
    libraryPath: options.libraryPath,
  };
  if (hasServiceEndpoint(options.serviceEndpoint)) {
    config.serviceEndpoint = options.serviceEndpoint;
  }
  if (options?.useSharedHost === true) config.useSharedHost = true;
  return config;
}

/**
 * Create the manager. A shared-host failure is not retried in-process.
 *
 * @param {{ create: (config: object) => unknown }} FoundryLocalManager
 * @param {object} config
 */
export function createFoundryManager(FoundryLocalManager, config) {
  if (typeof FoundryLocalManager?.create !== 'function') {
    throw new TypeError('FoundryLocalManager.create is unavailable');
  }
  try {
    return FoundryLocalManager.create(config);
  } catch (error) {
    if (config?.useSharedHost === true) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Shared host did not start, and Flint will not fall back to an in-process manager. ${detail}`,
        { cause: error },
      );
    }
    throw error;
  }
}
