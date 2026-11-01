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
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: message.content,
      timestamp: message.orderKey.split('#', 1)[0] || message.createdAt,
      status: message.status ?? 'complete',
      error: message.error ?? '',
    }))
}

export function createSessionTitle(prompt) {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  return normalized.length > 40 ? `${normalized.slice(0, 40)}…` : normalized
}

/** Ignore history responses superseded by a later selection or new session. */
export function createHistoryLoadGuard() {
  let latestId = 0
  return {
    start() {
      latestId += 1
      return latestId
    },
    invalidate() {
      latestId += 1
    },
    isCurrent(loadId) {
      return loadId === latestId
    },
  }
}
