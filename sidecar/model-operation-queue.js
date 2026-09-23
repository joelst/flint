export function createModelOperationQueue() {
  const tails = new Map();

  return {
    run(key, scopes, operation) {
      if (typeof key !== 'string' || !key.trim()) {
        return Promise.reject(new TypeError('model operation key must be a non-empty string'));
      }
      if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some(
        (scope) => typeof scope !== 'string' || !scope.trim(),
      )) {
        return Promise.reject(new TypeError('model operation scopes must be non-empty strings'));
      }
      if (typeof operation !== 'function') {
        return Promise.reject(new TypeError('model operation must be a function'));
      }

      const uniqueScopes = [...new Set(scopes)];
      const resourceKeys = uniqueScopes.map((scope) => `${key}\0${scope}`);
      const priorByScope = new Map(
        resourceKeys.map((resourceKey, index) => [uniqueScopes[index], tails.get(resourceKey)]),
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
      for (const resourceKey of resourceKeys) tails.set(resourceKey, run);
      const release = () => {
        for (const resourceKey of resourceKeys) {
          if (tails.get(resourceKey) === run) tails.delete(resourceKey);
        }
      };
      void run.then(release, release);
      return run;
    },
  };
}
