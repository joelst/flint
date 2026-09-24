// Which usage key a request should pin.
//
// The pool is one variant per alias. A gateway request for a different cached
// variant has to unload the resident build before it can run. That request is
// not work against the resident build, so charging it to the alias makes the
// switch refuse itself ("requests are in flight") and the client keeps the
// original not-loaded response.
//
// Book that request on the raw name. Once the requested variant is resident,
// inFlightFor attributes the raw key back to the alias, so the generation that
// follows the switch still cannot be evicted. The end phase searches every
// key, because a switch changes which key a later lookup would choose.

/**
 * @param {{
 *   requested?: string|null,
 *   matchedResidentAlias?: string|null,
 *   occupantAlias?: string|null,
 *   occupantVariantId?: string|null,
 *   modelIndexAvailable?: boolean,
 *   resolvedAlias?: string|null,
 *   resolvedVariantId?: string|null,
 * }} input
 * @returns {string[]} candidate usage keys, best first. The start phase charges keys[0].
 */
export function activityCandidateKeys (input) {
  const raw = typeof input?.requested === 'string' ? input.requested.trim() : '';
  const matchedResidentAlias = input?.matchedResidentAlias || null;
  const occupantAlias = input?.occupantAlias || null;
  const occupantVariantId = input?.occupantVariantId || null;
  const modelIndexAvailable = input?.modelIndexAvailable !== false;
  const resolvedAlias = input?.resolvedAlias || null;
  const resolvedVariantId = input?.resolvedVariantId || null;
  const switching = !!(
    resolvedVariantId
    && occupantAlias
    && occupantVariantId
    && resolvedAlias === occupantAlias
    && resolvedVariantId !== occupantVariantId
  );

  const keys = [];
  const push = (key) => {
    if (key && !keys.includes(key)) keys.push(key);
  };

  if (
    !modelIndexAvailable
    && raw
    && matchedResidentAlias
    && raw !== matchedResidentAlias
    && !raw.includes(':')
  ) {
    // A versionless id can spell either the resident variant or a different cached one.
    // Until the lazy index resolves that ambiguity, do not charge the resident alias: a
    // requested switch would otherwise reject itself as in-flight.
    push(raw);
    push(matchedResidentAlias);
  } else if (switching) {
    // The raw name is the only key that must not collapse onto the resident alias.
    push(raw || resolvedVariantId);
    push(resolvedAlias);
    push(matchedResidentAlias);
  } else {
    push(matchedResidentAlias);
    push(occupantAlias);
    push(resolvedAlias);
    push(raw);
  }
  return keys;
}
