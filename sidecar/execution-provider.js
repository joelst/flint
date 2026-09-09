/**
 * Apply a requested execution-provider preference when the runtime exposes a compatible setter.
 *
 * An absent setter means the runtime does not support preferences; a throwing setter means this
 * requested preference could not be applied and must not be reported as a successful start.
 */
export async function applyPreferredExecutionProvider({
  preferredEp,
  manager,
  model,
  log,
}) {
  const value = String(preferredEp || '').trim();
  if (!value || !manager) {
    return { requested: value || null, applied: null, method: null };
  }

  const candidateMethods = [
    'setPreferredExecutionProvider',
    'setPreferredEp',
    'setExecutionProviderPreference',
    'setEpPreference',
  ];
  const errors = [];
  let foundSetter = false;

  for (const target of [manager, model].filter(Boolean)) {
    for (const methodName of candidateMethods) {
      const method = target?.[methodName];
      if (typeof method !== 'function') continue;

      foundSetter = true;
      try {
        await method.call(target, value);
        log('info', `Applied preferred execution provider "${value}" via ${methodName}`);
        return { requested: value, applied: value, method: methodName };
      } catch (error) {
        errors.push(error?.message || String(error));
        log('warn', `Failed applying preferred EP via ${methodName}: ${error?.message || error}`);
      }
    }
  }

  if (foundSetter) {
    throw new Error(
      `Could not apply preferred execution provider "${value}": ${errors.join('; ')}`,
    );
  }

  log('warn', `Preferred execution provider "${value}" is not supported by this runtime API`);
  return { requested: value, applied: null, method: null };
}
