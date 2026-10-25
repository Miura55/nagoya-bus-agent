/** Sort sessions by their most recent message without mutating API data. */
export function sortSessionsByRecent(sessions) {
  return [...sessions].sort((left, right) =>
    (right.lastMessageAt ?? '').localeCompare(left.lastMessageAt ?? ''),
  )
}

/** De-duplicate retried writes and restore the user/assistant display order. */
export function normalizeStoredMessages(messages) {
  const messagesById = new Map()
  for (const message of messages) messagesById.set(message.id, message)

  return [...messagesById.values()]
    .sort((left, right) => left.orderKey.localeCompare(right.orderKey))
    .map((message) => ({ id: message.id, role: message.role, text: message.content }))
}

export function createSessionTitle(prompt) {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  return normalized.length > 40 ? `${normalized.slice(0, 40)}…` : normalized
}
