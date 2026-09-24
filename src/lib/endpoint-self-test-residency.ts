export interface SelfTestCatalogModel {
  alias: string;
  variants?: Array<{ id?: string | null }> | null;
}

export interface SelfTestPoolEntry {
  alias: string;
  variantId: string;
  inFlight?: number | null;
}

function normalized(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}

export function preferredResidentChatAlias(
  initialPool: SelfTestPoolEntry[],
  classifyModel: (id: string, parent: string | null) => 'embed' | 'speech' | 'chat' | null,
): string | null {
  return initialPool.find((entry) => (classifyModel(entry.alias, null) ?? 'chat') === 'chat')?.alias ?? null;
}

/**
 * Puts the pool back the way the self-test found it, one alias group at a time.
 *
 * The self-test only owns what its own probes loaded. `observe` records what was resident
 * just before a group's first probe, so a model the user loaded after the run started is
 * treated like one that was there all along: `restore` reloads that exact variant instead of
 * unloading it. Without an observation for the alias, the run-start snapshot decides.
 */
export function createSelfTestResidencyController(options: {
  models: SelfTestCatalogModel[];
  initialPool: SelfTestPoolEntry[];
  currentPool: () => Promise<SelfTestPoolEntry[]>;
  load: (model: SelfTestCatalogModel, variantId: string) => Promise<void>;
  unload: (alias: string) => Promise<void>;
}): {
  observe: (modelId: string) => Promise<void>;
  restore: (modelId: string) => Promise<void>;
} {
  const modelById = new Map<string, SelfTestCatalogModel>();
  for (const model of options.models) {
    modelById.set(normalized(model.alias), model);
    for (const variant of model.variants || []) {
      const id = normalized(variant.id);
      if (!id) continue;
      modelById.set(id, model);
      modelById.set(id.split(':')[0], model);
    }
  }
  const initialByAlias = new Map(
    options.initialPool.map((entry) => [normalized(entry.alias), entry]),
  );
  /** Pool entry (or null for not resident) seen just before an alias's probes. */
  const observedByAlias = new Map<string, SelfTestPoolEntry | null>();

  const modelFor = (modelId: string, purpose: string): SelfTestCatalogModel => {
    const model = modelById.get(normalized(modelId));
    if (!model) {
      throw new Error(`Cached model ${modelId} is unavailable for ${purpose}.`);
    }
    return model;
  };

  return {
    async observe(modelId) {
      const model = modelFor(modelId, 'residency tracking');
      const alias = normalized(model.alias);
      const current = await options.currentPool();
      observedByAlias.set(alias, current.find((item) => normalized(item.alias) === alias) ?? null);
    },

    async restore(modelId) {
      const model = modelFor(modelId, 'residency cleanup');
      const alias = normalized(model.alias);
      const before = observedByAlias.has(alias)
        ? observedByAlias.get(alias)
        : initialByAlias.get(alias) ?? null;
      if (before) {
        await options.load(model, before.variantId);
        return;
      }

      const current = await options.currentPool();
      const entry = current.find((item) => normalized(item.alias) === alias);
      if ((entry?.inFlight ?? 0) > 0) {
        throw new Error(`Cannot restore residency for ${model.alias} while requests are in flight.`);
      }
      await options.unload(model.alias);
    },
  };
}
