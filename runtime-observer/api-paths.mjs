export function isAnthropicMessagesPath(value) {
  const pathname = String(value || '')
  return pathname === '/v1/messages' || pathname === '/api/anthropic/v1/messages'
}
