export function truncateConversationTitle(title: string, maxLen = 40): string {
  if (title.length <= maxLen) return title;
  if (maxLen <= 1) return '…';
  return `${title.substring(0, maxLen - 1)}…`;
}
