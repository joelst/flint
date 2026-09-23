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
  return initialPool.find((entry) => classifyModel(entry.alias, null) === 'chat')?.alias ?? null;
}

export function createSelfTestResidencyController(options: {
  models: SelfTestCatalogModel[];
  initialPool: SelfTestPoolEntry[];
  currentPool: () => Promise<SelfTestPoolEntry[]>;
  load: (model: SelfTestCatalogModel, variantId: string) => Promise<void>;
  unload: (alias: string) => Promise<void>;
}): { restore: (modelId: string) => Promise<void> } {
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

  return {
    async restore(modelId) {
      const model = modelById.get(normalized(modelId));
      if (!model) {
        throw new Error(`Cached model ${modelId} is unavailable for residency cleanup.`);
      }
      const original = initialByAlias.get(normalized(model.alias));
      if (original) {
        await options.load(model, original.variantId);
        return;
      }

      const current = await options.currentPool();
      const entry = current.find((item) => normalized(item.alias) === normalized(model.alias));
      if ((entry?.inFlight ?? 0) > 0) {
        throw new Error(`Cannot restore residency for ${model.alias} while requests are in flight.`);
      }
      await options.unload(model.alias);
    },
  };
}
