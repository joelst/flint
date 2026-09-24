// The catalog model and variant the local gateway would load for an id from GET /v1/models.
//
// The self-test loads a speech model itself before sending multipart audio, because the
// gateway cannot autoload from a multipart body. It must load the same build the gateway
// would route the id to, so it uses the gateway's resolver rather than its own match: only
// cached variants count, a versionless id names its highest cached version, and an alias
// pins no variant.

import { buildModelIndex, resolveModelId } from '../../sidecar/model-registry.js';

export interface EndpointLoadModel {
  alias: string;
  variants?: ReadonlyArray<{ id: string; cached?: boolean }> | null;
}

export interface EndpointLoadTarget<M extends EndpointLoadModel> {
  model: M;
  /** Exact variant to load, or null for the alias's default. */
  variantId: string | null;
}

export function endpointLoadTarget<M extends EndpointLoadModel> (
  models: readonly M[],
  modelId: string,
): EndpointLoadTarget<M> | null {
  const index = buildModelIndex(models.map((model) => ({
      alias: model.alias,
      variants: (model.variants ?? []).map((variant) => ({ id: variant.id, cached: !!variant.cached })),
    })));
  const target = resolveModelId(index, modelId);
  if (!target) return null;
  const model = models.find((candidate) => candidate.alias === target.alias);
  return model ? { model, variantId: target.variantId } : null;
}
