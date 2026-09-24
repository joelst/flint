export type EndpointModelKind = 'embed' | 'speech' | 'chat';
export type EndpointModelClassifier = (
  id: string,
  parent: string | null,
) => EndpointModelKind | null;

export interface EndpointCatalogModel {
  alias?: unknown;
  task?: unknown;
  capabilities?: unknown;
  info?: {
    task?: unknown;
    capabilities?: unknown;
  } | null;
  variants?: Array<{ id?: unknown }> | null;
}

function looksLikeEmbedding(name: string): boolean {
  return name.includes('embed');
}

function looksLikeSpeech(name: string): boolean {
  return /(whisper|parakeet|nemotron-speech|-stt(?:-|$)|(?:^|-)stt-)/.test(name);
}

/**
 * What a catalog model serves, from its metadata and its names, or null when nothing says.
 *
 * Null matters: the self-test falls back to heuristics on the id the endpoint listed, and a
 * default of 'chat' here would hide them. A model whose alias is opaque but whose variant is
 * `whisper-tiny-generic-cpu` is speech, and one with no marker anywhere is unknown, not chat.
 */
export function endpointModelKind(model: EndpointCatalogModel): EndpointModelKind | null {
  const names = [model.alias, ...(model.variants || []).map((variant) => variant?.id)]
    .map((name) => String(name || '').trim().toLowerCase())
    .filter(Boolean);
  const task = String(model.task || model.info?.task || '').toLowerCase();
  const capabilities = String(
    model.capabilities || model.info?.capabilities || '',
  ).toLowerCase();

  if (task.includes('embedding') || capabilities.includes('embedding') || names.some(looksLikeEmbedding)) {
    return 'embed';
  }
  if (
    task.includes('automatic-speech-recognition')
    || task.includes('stt')
    || capabilities.includes('automatic-speech-recognition')
    || names.some(looksLikeSpeech)
  ) {
    return 'speech';
  }
  if (
    task.includes('chat')
    || task.includes('text-generation')
    || capabilities.includes('chat')
    || capabilities.includes('text-generation')
  ) {
    return 'chat';
  }
  return null;
}

export function buildEndpointModelClassifier(
  models: EndpointCatalogModel[],
): EndpointModelClassifier {
  const kinds = new Map<string, EndpointModelKind>();
  for (const model of models) {
    const alias = String(model.alias || '').trim().toLowerCase();
    if (!alias) continue;
    const kind = endpointModelKind(model);
    // An unknown model gets no entry, so the lookup below returns null and the caller's
    // heuristics on the listed id can decide.
    if (!kind) continue;
    kinds.set(alias, kind);
    for (const variant of model.variants || []) {
      const id = String(variant.id || '').trim().toLowerCase();
      if (!id) continue;
      kinds.set(id, kind);
      kinds.set(id.split(':')[0], kind);
    }
  }

  return (id, parent) => {
    const normalizedParent = String(parent || '').trim().toLowerCase();
    if (normalizedParent) {
      const parentKind = kinds.get(normalizedParent);
      if (parentKind) return parentKind;
    }
    return kinds.get(id.trim().toLowerCase()) || null;
  };
}
