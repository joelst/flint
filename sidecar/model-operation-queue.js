export function createModelOperationQueue() {
  const tails = new Map();

  function resourceKeys(key, scopes) {
    if (typeof key !== 'string' || !key.trim()) {
      throw new TypeError('model operation key must be a non-empty string');
    }
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some(
      (scope) => typeof scope !== 'string' || !scope.trim(),
    )) {
      throw new TypeError('model operation scopes must be non-empty strings');
    }
    return [...new Set(scopes)].map((scope) => `${key}\0${scope}`);
  }

  function publish(resources, run) {
    for (const resource of resources) tails.set(resource, run);
    const release = () => {
      for (const resource of resources) {
        if (tails.get(resource) === run) tails.delete(resource);
      }
    };
    void run.then(release, release);
    return run;
  }

  return {
    run(key, scopes, operation) {
      if (typeof operation !== 'function') {
        return Promise.reject(new TypeError('model operation must be a function'));
      }

      let resources;
      try {
        resources = resourceKeys(key, scopes);
      } catch (error) {
        return Promise.reject(error);
      }
      const uniqueScopes = [...new Set(scopes)];
      const priorByScope = new Map(
        resources.map((resource, index) => [uniqueScopes[index], tails.get(resource)]),
      );
      const priors = [...new Set([...priorByScope.values()].filter(Boolean))];
      const run = Promise.all(priors.map((prior) => prior.catch(() => undefined))).then(() => {
        const previous = uniqueScopes.length === 1 ? priorByScope.get(uniqueScopes[0]) : null;
        return previous
          ? previous.catch(() => undefined).then((previousResult) => operation({
              waited: true,
              previousResult,
            }))
          : operation({ waited: priors.length > 0, previousResult: undefined });
      });
      return publish(resources, run);
    },
    tryRun(key, scopes, operation) {
      if (typeof operation !== 'function') {
        return Promise.reject(new TypeError('model operation must be a function'));
      }
      let resources;
      try {
        resources = resourceKeys(key, scopes);
      } catch (error) {
        return Promise.reject(error);
      }
      if (resources.some((resource) => tails.has(resource))) return null;
      const run = Promise.resolve().then(() => operation({
        waited: false,
        previousResult: undefined,
      }));
      return publish(resources, run);
    },
  };
}
