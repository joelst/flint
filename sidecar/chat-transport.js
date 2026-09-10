/**
 * Choosing how a chat request reaches the model.
 *
 * Two transports exist and they are not interchangeable. The SDK's chat client is preferred
 * because it avoids web-service schema and version mismatches, but it validates
 * `typeof content === 'string'` and throws on anything else — so it cannot carry a vision turn
 * at all. The OpenAI-shaped HTTP endpoint accepts the multipart form but only exists while the
 * local service is running.
 *
 * Getting this wrong is silent in one direction and loud in the other: routing multipart to the
 * SDK fails the request outright, and routing text to HTTP when the endpoint is stale can hit a
 * schema mismatch. This module is pure so the decision can be tested without a running service.
 */

/**
 * True when any message carries multipart (vision) content the SDK client cannot accept.
 *
 * A non-array argument is treated as carrying nothing rather than throwing. This module exists
 * to turn an unroutable request into a reason the user can read, so throwing from the check
 * would defeat its own purpose: `selectChatTransport` would propagate a TypeError instead of
 * reporting what is missing.
 */
export function hasMultipartContent (messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => Array.isArray(m?.content));
}

/**
 * Decide the transport for a request.
 *
 * Returns `{transport, reason}`. `transport` is `'sdk'`, `'http'`, or `null` when the request
 * cannot be served, in which case `reason` explains what is missing in the user's terms rather
 * than as a validator failure from deep inside the SDK.
 */
export function selectChatTransport (messages, capabilities) {
  const multipart = hasMultipartContent(messages);
  const hasChatClient = capabilities?.chatClient === 'available';
  const hasEndpoint = capabilities?.serviceEndpoint === 'available';

  if (multipart) {
    if (hasEndpoint) return { transport: 'http', reason: null };
    return {
      transport: null,
      reason: 'Image input requires the local service endpoint, which is not running.',
    };
  }
  if (hasChatClient) return { transport: 'sdk', reason: null };
  if (hasEndpoint) return { transport: 'http', reason: null };
  return {
    transport: null,
    reason: 'Service endpoint unavailable and direct chat client is unsupported.',
  };
}
