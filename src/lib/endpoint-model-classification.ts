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

export function endpointModelKind(model: EndpointCatalogModel): EndpointModelKind {
  const alias = String(model.alias || '').toLowerCase();
  const task = String(model.task || model.info?.task || '').toLowerCase();
  const capabilities = String(
    model.capabilities || model.info?.capabilities || '',
  ).toLowerCase();

  if (task.includes('embedding') || capabilities.includes('embedding') || alias.includes('embed')) {
    return 'embed';
  }
  if (
    task.includes('automatic-speech-recognition')
    || task.includes('stt')
    || capabilities.includes('automatic-speech-recognition')
    || alias.includes('whisper')
    || alias.includes('-stt')
    || alias.includes('stt-')
  ) {
    return 'speech';
  }
  return 'chat';
}

export function buildEndpointModelClassifier(
  models: EndpointCatalogModel[],
): EndpointModelClassifier {
  const kinds = new Map<string, EndpointModelKind>();
  for (const model of models) {
    const alias = String(model.alias || '').trim().toLowerCase();
    if (!alias) continue;
    const kind = endpointModelKind(model);
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
