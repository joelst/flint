/**
 * Choosing how a chat request reaches the model.
 *
 * Two transports exist and they are not interchangeable. The SDK's direct ChatSession path is
 * preferred because it avoids web-service schema and version mismatches and can carry native
 * image items. The OpenAI-shaped HTTP endpoint accepts multipart JSON but Foundry Local 2.0.1
 * silently ignores those images, so it must never be selected for a vision request.
 *
 * Getting this wrong is silent: the HTTP request succeeds while the model receives only text.
 * This module is pure so the decision can be tested without a running service.
 */

/**
 * True when any message carries an image part.
 *
 * A non-array argument is treated as carrying nothing rather than throwing. This module exists
 * to turn an unroutable request into a reason the user can read, so throwing from the check
 * would defeat its own purpose: `selectChatTransport` would propagate a TypeError instead of
 * reporting what is missing.
 */
export function hasMultipartContent (messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) =>
    Array.isArray(message?.content)
    && message.content.some((part) => part?.type === 'image_url'),
  );
}

/**
 * The deprecated ChatClient accepts string content, while ChatSession and HTTP accept text
 * content-parts arrays. Preserve the text when routing a text-only request to that client.
 */
export function normalizeTextPartsForLegacyClient (messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!Array.isArray(message?.content)
      || !message.content.every((part) => part?.type === 'text' && typeof part.text === 'string')) {
      return message;
    }
    return { ...message, content: message.content.map((part) => part.text).join('') };
  });
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
  const hasMultimodalClient = capabilities?.multimodalClient === 'available';
  const hasEndpoint = capabilities?.serviceEndpoint === 'available';

  if (multipart) {
    if (hasMultimodalClient) return { transport: 'sdk', reason: null };
    return {
      transport: null,
      reason: 'Image input requires Foundry Local native multimodal session support.',
    };
  }
  if (hasChatClient) return { transport: 'sdk', reason: null };
  if (hasEndpoint) return { transport: 'http', reason: null };
  return {
    transport: null,
    reason: 'Service endpoint unavailable and direct chat client is unsupported.',
  };
}
